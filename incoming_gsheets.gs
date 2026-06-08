/*
Convert requester Google Sheets anywhere under INCOMING_FOLDER_ID into CSVs
that match the formats convert.gs expects, and organize each request into a
Source / Delivery folder pair.

The walk descends recursively from INCOMING_FOLDER_ID, skipping folders named
"Delivery" (case-insensitive) at any depth and a root-level "Templates"
folder (case-insensitive) reserved for reference templates. GSheets and CSVs
at the very root of INCOMING_FOLDER_ID are reported as errors — requests
must live inside a requester subfolder, and generated CSVs always live in
the Source subfolder of a request.

Files written or moved by this script (GSheets and CSVs) are tagged with
the Mozilla Audience Drive label so downstream tooling can identify them.
Existing manual label values are preserved.

For each Google Sheet found:
1. Skip the file silently if the first sheet's tab is not named "Request"
   (case-insensitive) or if no recognized template header row can be found
   within the first 10 rows.
2. Detect the template from the header row:
   - Char-limit: column 2 = "Target Character Limit", column 4 = "EN Copy".
   - Standard:   column 2 = "EN Copy".
   - Survey:     exactly 3 headers, column 1 = "Key", column 2 = "Default Text".
3. Organize the request folder:
   - If the GSheet's parent is a folder named "Source" (case-insensitive),
     ensure a sibling "Delivery" folder exists.
   - Otherwise, the GSheet's parent is treated as the request folder: create
     "Source" and "Delivery" subfolders if missing, and move the GSheet into
     Source.
   The Source folder is always where the CSV is written.
4. Grant the requester (Sheet owner, or first editor when no owner is set)
   Content Manager rights on the request folder, so they keep visibility into
   their own request when it's later moved to another Shared Drive. Direct
   permissions travel with the folder; inherited ones do not. Idempotent:
   reuses or upgrades any existing permission rather than re-adding.
5. Skip regeneration if a CSV with the same name already exists in the Source
   folder and its lastUpdated >= the GSheet's lastUpdated.
6. Run quality checks on the EN source column (data rows below the header):
   - ERROR (blocks conversion): bold, italic, non-default foreground color,
     or any hyperlink in the cell (cell-level or rich-text run). CSV cannot
     preserve these.
   - ERROR (blocks conversion): a fully blank row in the middle of the table
     (a gap between real rows), or a row that has content but leaves the EN
     source cell empty. Cells holding only a formula (e.g. a Target Language
     cell pre-filled with =B9) don't count as content, so a visually empty
     row is treated as empty even when such a formula resolves to a value.
     Directive rows (starting with "#") are exempt.
   - WARNING (char-limit template only, never blocks): EN length >= 90% of
     the value in the Target Character Limit column on the same row.
7. If there are no errors, export the spreadsheet to CSV via the Sheets
   export endpoint, strip trailing commas from directive rows (lines
   starting with "#"), trash any stale CSV with the same name, and write
   the new file into the Source folder.

Errors processing individual sheets are logged and don't stop the run.

Reporting:
- If SLACK_WEBHOOK_URL is set in config.gs, a summary of CSVs created/updated,
  warnings, and errors is posted to that Slack webhook at the end of each
  run. If empty, posting is skipped.

`processIncomingSheets` is the top-level entry point and is visible in the
Apps Script picker. Internal helpers live on the `Incoming` namespace.
Cross-file helpers come from `Shared` (utils.gs).

Required configuration (defined in config.gs):
  INCOMING_FOLDER_ID - Drive folder containing requester subfolders.

Required scopes (granted automatically on first run):
  https://www.googleapis.com/auth/drive (for the Sheets export endpoint).
*/

const REQUEST_TAB_NAME = 'request';
const SOURCE_FOLDER_NAME = 'Source';
const DELIVERY_FOLDER_NAME = 'Delivery';
const TEMPLATES_FOLDER_NAME = 'Templates';
const HEADER_SEARCH_LIMIT = 10;
const DIRECTIVE_PREFIX = '#';
const CHAR_LIMIT_WARN_RATIO = 0.9;
const ERROR_ROW_PREVIEW_LIMIT = 5;

// Foreground colors treated as "no color set" — anything else is flagged.
const DEFAULT_FOREGROUND_COLORS = new Set(['', '#000000', '#000']);

function processIncomingSheets() {
  Shared.runWithReport('processIncomingSheets', report => {
    const root = DriveApp.getFolderById(INCOMING_FOLDER_ID);
    const visited = new Set();

    Incoming.reportStrayRootFiles(root, report);

    // Walk each subfolder recursively. The root-level "Templates" folder is
    // reserved for reference templates and never holds real requests.
    const templatesName = TEMPLATES_FOLDER_NAME.toLowerCase();

    for (const subfolder of Incoming.collectFolders(root)) {
      if (subfolder.getName().trim().toLowerCase() === templatesName) {
        Logger.log(`Skipping root-level "${subfolder.getName()}" folder.`);
        continue;
      }
      Incoming.processSheetsRecursively(subfolder, visited, report);
    }
  });
}

const Incoming = {
  // Requests and generated CSVs must live inside a requester subfolder, never
  // at the INCOMING root. Anything here is almost certainly a misplaced drop
  // the user needs to clean up — report each as an error. Other file types
  // (Docs, etc.) may be legitimate workspace files and are left alone.
  reportStrayRootFiles(root, report) {
    const strayMimeTypes = [MimeType.GOOGLE_SHEETS, MimeType.CSV];

    for (const mimeType of strayMimeTypes) {
      for (const file of Incoming.collectFilesByType(root, mimeType)) {
        const dedupKey = `stray-root:${file.getId()}`;
        Shared.markVisited(report, dedupKey);
        Shared.recordError(
          report,
          `Stray file at INCOMING root: "${file.getName()}" (${file.getUrl()}). ` +
            `Move it into a requester subfolder or delete it.`,
          dedupKey
        );
      }
    }
  },

  processSheetsRecursively(folder, visited, report) {
    if (folder.getName().trim().toLowerCase() === DELIVERY_FOLDER_NAME.toLowerCase()) {
      return;
    }

    // Snapshot files and subfolders before processing so that any new folders
    // we create (Source / Delivery) and any moves we perform don't perturb the
    // iteration we're currently inside.
    const sheets = Incoming.collectFilesByType(folder, MimeType.GOOGLE_SHEETS);
    const subfolders = Incoming.collectFolders(folder);

    for (const sheetFile of sheets) {
      if (visited.has(sheetFile.getId())) {
        continue;
      }
      visited.add(sheetFile.getId());

      try {
        Incoming.processSingleIncomingSheet(sheetFile, folder, report);
      } catch (error) {
        Shared.recordError(
          report,
          `ERROR processing ${sheetFile.getName()}: ${error}`,
          `batch-error:${sheetFile.getId()}`
        );
      }
    }

    for (const sub of subfolders) {
      Incoming.processSheetsRecursively(sub, visited, report);
    }
  },

  collectFilesByType(folder, mimeType) {
    const items = [];
    const iter = folder.getFilesByType(mimeType);
    while (iter.hasNext()) {
      items.push(iter.next());
    }
    return items;
  },

  collectFolders(folder) {
    const items = [];
    const iter = folder.getFolders();
    while (iter.hasNext()) {
      items.push(iter.next());
    }
    return items;
  },

  processSingleIncomingSheet(sheetFile, parentFolder, report) {
    const sheetName = sheetFile.getName();
    const sheetId = sheetFile.getId();
    Logger.log(
      `Processing GSheet: ${sheetName} (folder: ${parentFolder.getName()})`
    );

    // Claim ownership of these dedup keys so prior notifications can resolve
    // if this run doesn't re-record them.
    Shared.markVisited(report, `batch-error:${sheetId}`);
    Shared.markVisited(report, `no-grandparent:${sheetId}`);
    Shared.markVisited(report, `formatting-error:${sheetId}`);
    Shared.markVisited(report, `char-limit-warning:${sheetId}`);
    Shared.markVisited(report, `share-no-recipient:${sheetId}`);
    Shared.markVisited(report, `share-failed:${sheetId}`);

    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const sheet = spreadsheet.getSheets()[0];

    if (sheet.getName().trim().toLowerCase() !== REQUEST_TAB_NAME) {
      Logger.log(
        `Skipping ${sheetName}: first tab "${sheet.getName()}" is not "Request".`
      );
      return;
    }

    const detection = Incoming.detectHeaderRow(sheet);

    if (!detection) {
      Logger.log(
        `Skipping ${sheetName}: no recognized template header in first ${HEADER_SEARCH_LIMIT} rows.`
      );
      return;
    }

    const { headerRowIndex, template } = detection;
    Logger.log(
      `Template detected: ${template.type} (header on row ${headerRowIndex}, EN col ${template.enCol})`
    );

    const layout = Incoming.ensureRequestStructure(parentFolder);

    if (!layout) {
      Shared.recordError(
        report,
        `Cannot organize ${sheetName}: parent folder "${parentFolder.getName()}" has no grandparent (expected a request folder above Source).`,
        `no-grandparent:${sheetId}`
      );
      return;
    }

    if (!layout.parentIsSource) {
      sheetFile.moveTo(layout.sourceFolder);
      Logger.log(`Moved ${sheetName} to ${layout.sourceFolder.getName()}.`);
      Shared.recordEvent(report, 'Sheet moved', sheetName, layout.sourceFolder.getUrl());
    }

    Shared.applyMozillaAudienceIndicator(sheetFile.getId());

    Incoming.shareRequestFolderWithRequester(sheetFile, layout.requestFolder, report);

    const outputFolder = layout.sourceFolder;
    const csvName = `${sheetName}.csv`;
    const existingCsv = Shared.findFileInFolderByName(
      outputFolder,
      csvName,
      MimeType.CSV
    );

    if (
      existingCsv &&
      existingCsv.getLastUpdated() >= sheetFile.getLastUpdated()
    ) {
      Logger.log(`Skipping ${sheetName}: CSV "${csvName}" is already up to date.`);
      Shared.applyMozillaAudienceIndicator(existingCsv.getId());
      return;
    }

    const firstDataRow = headerRowIndex + 1;
    const lastRow = sheet.getLastRow();

    let errors = [];
    let warnings = [];

    if (lastRow >= firstDataRow) {
      errors = Incoming.checkSourceFormatting(sheet, template.enCol, firstDataRow, lastRow);
      errors = errors.concat(
        Incoming.checkRowIntegrity(sheet, template.enCol, firstDataRow, lastRow)
      );
      errors.sort((a, b) => a.row - b.row);

      if (template.type === 'charLimit') {
        warnings = Incoming.checkCharacterLimits(
          sheet,
          template.enCol,
          template.limitCol,
          firstDataRow,
          lastRow
        );
      }
    }

    if (errors.length > 0) {
      Shared.recordError(
        report,
        `Cannot convert ${sheetName} (${spreadsheet.getUrl()}): ${Incoming.summarizeFormattingErrors(errors)}`,
        `formatting-error:${sheetId}`
      );
      return;
    }

    if (warnings.length > 0) {
      const warningSummary = Incoming.summarizeCharLimitWarnings(warnings);
      console.warn(`Warnings for ${sheetName}: ${warningSummary}`);
      Shared.recordEvent(
        report,
        'CSV warnings',
        `${sheetName} - ${warningSummary}`,
        spreadsheet.getUrl(),
        `char-limit-warning:${sheetId}`
      );
    }

    const csvText = Incoming.cleanDirectiveRows(Incoming.exportSheetAsCsv(spreadsheet.getId()));

    if (existingCsv) {
      Shared.removeExistingFilesWithName(outputFolder, csvName, MimeType.CSV);
    }

    const newFile = outputFolder.createFile(
      Utilities.newBlob(csvText, 'text/csv', csvName)
    );

    Shared.applyMozillaAudienceIndicator(newFile.getId());

    Shared.recordEvent(
      report,
      existingCsv ? 'CSV updated' : 'CSV created',
      csvName,
      newFile.getUrl()
    );

    Logger.log(`Finished processing ${sheetName} -> ${csvName}`);
  },

  // Sets up the Source / Delivery layout around the GSheet's parent folder.
  // Returns { sourceFolder, deliveryFolder, parentIsSource } or null when the
  // layout cannot be derived (e.g. parent is Source but has no grandparent).
  ensureRequestStructure(parentFolder) {
    const parentIsSource =
      parentFolder.getName().trim().toLowerCase() ===
      SOURCE_FOLDER_NAME.toLowerCase();

    if (parentIsSource) {
      const requestFolder = Shared.getFirstParent(parentFolder);
      if (!requestFolder) {
        return null;
      }

      const deliveryFolder = Incoming.ensureChildFolder(
        requestFolder,
        DELIVERY_FOLDER_NAME
      );

      return {
        parentIsSource: true,
        requestFolder,
        sourceFolder: parentFolder,
        deliveryFolder
      };
    }

    const sourceFolder = Incoming.ensureChildFolder(parentFolder, SOURCE_FOLDER_NAME);
    const deliveryFolder = Incoming.ensureChildFolder(parentFolder, DELIVERY_FOLDER_NAME);

    return {
      parentIsSource: false,
      requestFolder: parentFolder,
      sourceFolder,
      deliveryFolder
    };
  },

  // Grants the requester (Sheet owner, or first editor when no owner is set)
  // Content Manager rights on the request folder so they retain visibility
  // into their own request after it's moved between Shared Drives. Direct
  // permissions travel with the folder; inherited ones do not.
  shareRequestFolderWithRequester(sheetFile, requestFolder, report) {
    const sheetId = sheetFile.getId();
    const requester = Shared.getRequesterIdentity(sheetFile);

    if (!requester) {
      Logger.log(
        `No requester email available for "${sheetFile.getName()}"; skipping folder share.`
      );
      Shared.recordError(
        report,
        `Cannot share ${requestFolder.getName()} (${requestFolder.getUrl()}): ` +
          `Sheet "${sheetFile.getName()}" has no retrievable requester email.`,
        `share-no-recipient:${sheetId}`
      );
      return;
    }

    Logger.log(
      `Identified requester for "${sheetFile.getName()}": ` +
        `${requester.name || '(no name)'} <${requester.email}> [from ${requester.source}]`
    );

    if (
      requester.ownerEmail &&
      requester.ownerEmail.toLowerCase() !== requester.email.toLowerCase()
    ) {
      Logger.log(
        `Picked identity differs from owner for "${sheetFile.getName()}": ` +
          `owner=${requester.ownerName || '(no name)'} <${requester.ownerEmail}>`
      );
    }

    let result;
    try {
      result = Shared.ensureFolderSharedAsContentManager(requestFolder, requester.email);
    } catch (error) {
      Shared.recordError(
        report,
        `Failed to share ${requestFolder.getName()} (${requestFolder.getUrl()}) ` +
          `with ${requester.email}: ${error}`,
        `share-failed:${sheetId}`
      );
      return;
    }

    if (result.added) {
      Logger.log(
        `Folder shared: ${requestFolder.getName()} → ${requester.email} (${requestFolder.getUrl()})`
      );
    } else if (result.upgraded) {
      Logger.log(
        `Folder share upgraded: ${requestFolder.getName()} → ${requester.email} (${requestFolder.getUrl()})`
      );
    }
  },

  ensureChildFolder(parent, name) {
    const existing = Shared.findChildFolderByNameCaseInsensitive(parent, name);
    if (existing) {
      return existing;
    }

    const created = parent.createFolder(name);
    Logger.log(`Created folder "${name}" in ${parent.getName()}: ${created.getUrl()}`);
    return created;
  },

  detectHeaderRow(sheet) {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    if (lastRow < 1 || lastCol < 1) {
      return null;
    }

    const scanRows = Math.min(HEADER_SEARCH_LIMIT, lastRow);
    const values = sheet.getRange(1, 1, scanRows, lastCol).getValues();

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const firstCell = String(row[0] || '').trim();

      if (firstCell.startsWith(DIRECTIVE_PREFIX)) {
        continue;
      }

      const trimmed = Incoming.trimTrailingEmptyCells(row);
      const template = Shared.detectTemplate(trimmed);

      if (!template) {
        return null;
      }

      return { headerRowIndex: i + 1, template };
    }

    return null;
  },

  trimTrailingEmptyCells(row) {
    let end = row.length;

    while (end > 0 && String(row[end - 1] || '').trim() === '') {
      end--;
    }

    return row.slice(0, end);
  },

  checkSourceFormatting(sheet, enCol, firstDataRow, lastRow) {
    const numRows = lastRow - firstDataRow + 1;

    if (numRows <= 0) {
      return [];
    }

    const range = sheet.getRange(firstDataRow, enCol, numRows, 1);
    const values = range.getValues();
    const richTexts = range.getRichTextValues();

    const errors = [];

    for (let i = 0; i < numRows; i++) {
      const cellValue = String(values[i][0] || '').trim();

      if (cellValue === '') {
        continue;
      }

      const issues = new Set();
      const rich = richTexts[i][0];

      if (rich) {
        Incoming.collectRichTextIssues(rich, issues);
      }

      if (issues.size > 0) {
        errors.push({
          row: firstDataRow + i,
          issues: Array.from(issues)
        });
      }
    }

    return errors;
  },

  // Flags structural gaps in the data region: fully blank rows wedged between
  // real rows, and rows that carry content but leave the EN source cell empty.
  // Both yield CSV rows with no usable source string, so they block conversion.
  // Returns the same { row, issues } shape as checkSourceFormatting so the two
  // result sets merge and summarize uniformly.
  checkRowIntegrity(sheet, enCol, firstDataRow, lastRow) {
    const numRows = lastRow - firstDataRow + 1;

    if (numRows <= 0) {
      return [];
    }

    const lastCol = sheet.getLastColumn();
    const range = sheet.getRange(firstDataRow, 1, numRows, lastCol);
    const values = range.getValues();
    const formulas = range.getFormulas();

    // A cell counts as real content only when it holds a literal, non-blank
    // value. Target-language cells are routinely pre-filled with formulas
    // (e.g. =B9) that mirror the EN source; on a visually empty row such a
    // formula still resolves to a non-blank value via getValues() (a reference
    // to an empty cell can even come back as 0). getFormulas() returns '' for
    // non-formula cells, so we treat any formula cell as empty.
    const hasContent = (i, col) =>
      formulas[i][col] === '' && String(values[i][col] || '').trim() !== '';

    // Directive rows (starting with "#") are passed through to the CSV
    // verbatim and never carry EN copy, so they're exempt from both checks.
    const isDirective = i =>
      String(values[i][0] || '').trim().startsWith(DIRECTIVE_PREFIX);

    const rowHasContent = i => {
      for (let col = 0; col < lastCol; col++) {
        if (hasContent(i, col)) {
          return true;
        }
      }
      return false;
    };

    // getLastRow() counts formula cells, and these templates pre-fill the
    // Target Language column with formulas far below the real data — so the
    // table doesn't actually end at lastRow. Anchor on the last row carrying
    // literal content; everything past it is trailing formula/blank filler and
    // is not a mid-table gap.
    let lastContentIndex = -1;
    for (let i = numRows - 1; i >= 0; i--) {
      if (!isDirective(i) && rowHasContent(i)) {
        lastContentIndex = i;
        break;
      }
    }

    const errors = [];

    for (let i = 0; i <= lastContentIndex; i++) {
      if (isDirective(i)) {
        continue;
      }

      if (!rowHasContent(i)) {
        errors.push({ row: firstDataRow + i, issues: ['empty row'] });
        continue;
      }

      if (!hasContent(i, enCol - 1)) {
        errors.push({ row: firstDataRow + i, issues: ['missing EN copy'] });
      }
    }

    return errors;
  },

  // A cell-level "Insert > Link" hyperlink is exposed as a single RichText run
  // with a non-null getLinkUrl(), so this covers both cell-level and partial
  // hyperlinks without an extra getCell().getLinkUrl() round-trip per row.
  collectRichTextIssues(rich, issues) {
    const runs = rich.getRuns();

    for (const run of runs) {
      const runText = run.getText();

      if (!runText || runText.trim() === '') {
        continue;
      }

      const style = run.getTextStyle();

      if (style.isBold()) issues.add('bold');
      if (style.isItalic()) issues.add('italic');

      if (!Incoming.isDefaultForegroundColor(style.getForegroundColor())) {
        issues.add('non-default color');
      }

      if (run.getLinkUrl()) {
        issues.add('hyperlink');
      }
    }
  },

  checkCharacterLimits(sheet, enCol, limitCol, firstDataRow, lastRow) {
    const numRows = lastRow - firstDataRow + 1;

    if (numRows <= 0) {
      return [];
    }

    const enValues = sheet
      .getRange(firstDataRow, enCol, numRows, 1)
      .getValues();
    const limitValues = sheet
      .getRange(firstDataRow, limitCol, numRows, 1)
      .getValues();

    const warnings = [];

    for (let i = 0; i < numRows; i++) {
      const text = String(enValues[i][0] || '');

      if (text.trim() === '') {
        continue;
      }

      const limitRaw = limitValues[i][0];

      if (typeof limitRaw !== 'number' || limitRaw <= 0) {
        continue;
      }

      const length = text.length;
      let severity = null;

      if (length > limitRaw) {
        severity = 'over';
      } else if (length >= CHAR_LIMIT_WARN_RATIO * limitRaw) {
        severity = 'near';
      }

      if (severity) {
        warnings.push({
          row: firstDataRow + i,
          enLength: length,
          limit: limitRaw,
          severity
        });
      }
    }

    return warnings;
  },

  isDefaultForegroundColor(color) {
    if (color === null || color === undefined) {
      return true;
    }

    return DEFAULT_FOREGROUND_COLORS.has(String(color).trim().toLowerCase());
  },

  // Drive.Files.export in v3 of the Advanced Drive Service returns metadata
  // only — it doesn't deliver the exported bytes. Hit the Sheets export
  // endpoint directly with the script's OAuth token instead.
  exportSheetAsCsv(spreadsheetId) {
    const url =
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;

    const response = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error(
        `Sheet export failed (${code}): ${response.getContentText()}`
      );
    }

    return response.getContentText();
  },

  cleanDirectiveRows(csvText) {
    const lines = csvText.split(/\r?\n/);

    const cleaned = lines.map(line => {
      if (line.startsWith(DIRECTIVE_PREFIX)) {
        return line.replace(/,+$/, '');
      }
      return line;
    });

    return cleaned.join('\n');
  },

  summarizeFormattingErrors(errors) {
    const head = errors
      .slice(0, ERROR_ROW_PREVIEW_LIMIT)
      .map(e => `row ${e.row} [${e.issues.join(', ')}]`)
      .join('; ');

    const extra = errors.length - ERROR_ROW_PREVIEW_LIMIT;
    const suffix = extra > 0 ? `; and ${extra} more` : '';

    return `${errors.length} issue(s) - ${head}${suffix}`;
  },

  summarizeCharLimitWarnings(warnings) {
    const overCount = warnings.filter(w => w.severity === 'over').length;
    const nearCount = warnings.length - overCount;

    const counts = [];
    if (overCount > 0) counts.push(`${overCount} over limit`);
    if (nearCount > 0) counts.push(`${nearCount} near limit`);

    const head = warnings
      .slice(0, ERROR_ROW_PREVIEW_LIMIT)
      .map(w => `row ${w.row} ${w.severity} limit (${w.enLength}/${w.limit})`)
      .join('; ');

    const extra = warnings.length - ERROR_ROW_PREVIEW_LIMIT;
    const suffix = extra > 0 ? ` and ${extra} more` : '';

    return `${counts.join(', ')}: ${head}${suffix}`;
  }
};
