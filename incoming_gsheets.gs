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
4. Skip regeneration if a CSV with the same name already exists in the Source
   folder and its lastUpdated >= the GSheet's lastUpdated.
5. Run quality checks on the EN source column (data rows below the header):
   - ERROR (blocks conversion): bold, italic, non-default foreground color,
     or any hyperlink in the cell (cell-level or rich-text run). CSV cannot
     preserve these.
   - WARNING (char-limit template only, never blocks): EN length >= 90% of
     the value in the Target Character Limit column on the same row.
6. If there are no errors, export the spreadsheet to CSV via the Sheets
   export endpoint, strip trailing commas from directive rows (lines
   starting with "#"), trash any stale CSV with the same name, and write
   the new file into the Source folder.

Errors processing individual sheets are logged and don't stop the run.

Reporting:
- If SLACK_WEBHOOK_URL is set in config.gs, a summary of CSVs created/updated,
  warnings, and errors is posted to that Slack webhook at the end of each
  run. If empty, posting is skipped.

Shared helpers (locking, reporting, template detection, Drive helpers) live
in utils.gs.

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
  runWithReport('processIncomingSheets', report => {
    const root = DriveApp.getFolderById(INCOMING_FOLDER_ID);
    const visited = new Set();

    reportStrayRootFiles(root, report);

    // Walk each subfolder recursively. The root-level "Templates" folder is
    // reserved for reference templates and never holds real requests.
    const templatesName = TEMPLATES_FOLDER_NAME.toLowerCase();

    for (const subfolder of collectFolders(root)) {
      if (subfolder.getName().trim().toLowerCase() === templatesName) {
        Logger.log(`Skipping root-level "${subfolder.getName()}" folder.`);
        continue;
      }
      processSheetsRecursively(subfolder, visited, report);
    }
  });
}

// Requests and generated CSVs must live inside a requester subfolder, never
// at the INCOMING root. Anything here is almost certainly a misplaced drop
// the user needs to clean up — report each as an error. Other file types
// (Docs, etc.) may be legitimate workspace files and are left alone.
function reportStrayRootFiles(root, report) {
  const strayMimeTypes = [MimeType.GOOGLE_SHEETS, MimeType.CSV];

  for (const mimeType of strayMimeTypes) {
    for (const file of collectFilesByType(root, mimeType)) {
      recordError(
        report,
        `Stray file at INCOMING root: "${file.getName()}" (${file.getUrl()}). ` +
          `Move it into a requester subfolder or delete it.`
      );
    }
  }
}

function processSheetsRecursively(folder, visited, report) {
  if (folder.getName().trim().toLowerCase() === DELIVERY_FOLDER_NAME.toLowerCase()) {
    return;
  }

  // Snapshot files and subfolders before processing so that any new folders
  // we create (Source / Delivery) and any moves we perform don't perturb the
  // iteration we're currently inside.
  const sheets = collectFilesByType(folder, MimeType.GOOGLE_SHEETS);
  const subfolders = collectFolders(folder);

  for (const sheetFile of sheets) {
    if (visited.has(sheetFile.getId())) {
      continue;
    }
    visited.add(sheetFile.getId());

    try {
      processSingleIncomingSheet(sheetFile, folder, report);
    } catch (error) {
      recordError(report, `ERROR processing ${sheetFile.getName()}: ${error}`);
    }
  }

  for (const sub of subfolders) {
    processSheetsRecursively(sub, visited, report);
  }
}

function collectFilesByType(folder, mimeType) {
  const items = [];
  const iter = folder.getFilesByType(mimeType);
  while (iter.hasNext()) {
    items.push(iter.next());
  }
  return items;
}

function collectFolders(folder) {
  const items = [];
  const iter = folder.getFolders();
  while (iter.hasNext()) {
    items.push(iter.next());
  }
  return items;
}

function processSingleIncomingSheet(sheetFile, parentFolder, report) {
  const sheetName = sheetFile.getName();
  Logger.log(
    `Processing GSheet: ${sheetName} (folder: ${parentFolder.getName()})`
  );

  const spreadsheet = SpreadsheetApp.openById(sheetFile.getId());
  const sheet = spreadsheet.getSheets()[0];

  if (sheet.getName().trim().toLowerCase() !== REQUEST_TAB_NAME) {
    Logger.log(
      `Skipping ${sheetName}: first tab "${sheet.getName()}" is not "Request".`
    );
    return;
  }

  const detection = detectHeaderRow(sheet);

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

  const layout = ensureRequestStructure(parentFolder);

  if (!layout) {
    recordError(
      report,
      `Cannot organize ${sheetName}: parent folder "${parentFolder.getName()}" has no grandparent (expected a request folder above Source).`
    );
    return;
  }

  if (!layout.parentIsSource) {
    sheetFile.moveTo(layout.sourceFolder);
    Logger.log(`Moved ${sheetName} to ${layout.sourceFolder.getName()}.`);
    recordEvent(report, 'Sheet moved', sheetName, layout.sourceFolder.getUrl());
  }

  applyMozillaAudienceIndicator(sheetFile.getId());

  const outputFolder = layout.sourceFolder;
  const csvName = `${sheetName}.csv`;
  const existingCsv = findFileInFolderByName(
    outputFolder,
    csvName,
    MimeType.CSV
  );

  if (
    existingCsv &&
    existingCsv.getLastUpdated() >= sheetFile.getLastUpdated()
  ) {
    Logger.log(`Skipping ${sheetName}: CSV "${csvName}" is already up to date.`);
    applyMozillaAudienceIndicator(existingCsv.getId());
    return;
  }

  const firstDataRow = headerRowIndex + 1;
  const lastRow = sheet.getLastRow();

  let errors = [];
  let warnings = [];

  if (lastRow >= firstDataRow) {
    errors = checkSourceFormatting(sheet, template.enCol, firstDataRow, lastRow);

    if (template.type === 'charLimit') {
      warnings = checkCharacterLimits(
        sheet,
        template.enCol,
        template.limitCol,
        firstDataRow,
        lastRow
      );
    }
  }

  if (errors.length > 0) {
    recordError(
      report,
      `Cannot convert ${sheetName} (${spreadsheet.getUrl()}): ${summarizeFormattingErrors(errors)}`
    );
    return;
  }

  if (warnings.length > 0) {
    const warningSummary = summarizeCharLimitWarnings(warnings);
    console.warn(`Warnings for ${sheetName}: ${warningSummary}`);
    recordEvent(
      report,
      'CSV warnings',
      `${sheetName} - ${warningSummary}`,
      spreadsheet.getUrl()
    );
  }

  const csvText = cleanDirectiveRows(exportSheetAsCsv(spreadsheet.getId()));

  if (existingCsv) {
    removeExistingFilesWithName(outputFolder, csvName, MimeType.CSV);
  }

  const newFile = outputFolder.createFile(
    Utilities.newBlob(csvText, 'text/csv', csvName)
  );

  applyMozillaAudienceIndicator(newFile.getId());

  recordEvent(
    report,
    existingCsv ? 'CSV updated' : 'CSV created',
    csvName,
    newFile.getUrl()
  );

  Logger.log(`Finished processing ${sheetName} -> ${csvName}`);
}

// Sets up the Source / Delivery layout around the GSheet's parent folder.
// Returns { sourceFolder, deliveryFolder, parentIsSource } or null when the
// layout cannot be derived (e.g. parent is Source but has no grandparent).
function ensureRequestStructure(parentFolder) {
  const parentIsSource =
    parentFolder.getName().trim().toLowerCase() ===
    SOURCE_FOLDER_NAME.toLowerCase();

  if (parentIsSource) {
    const requestFolder = getFirstParent(parentFolder);
    if (!requestFolder) {
      return null;
    }

    const deliveryFolder = ensureChildFolder(
      requestFolder,
      DELIVERY_FOLDER_NAME
    );

    return {
      parentIsSource: true,
      sourceFolder: parentFolder,
      deliveryFolder
    };
  }

  const sourceFolder = ensureChildFolder(parentFolder, SOURCE_FOLDER_NAME);
  const deliveryFolder = ensureChildFolder(parentFolder, DELIVERY_FOLDER_NAME);

  return {
    parentIsSource: false,
    sourceFolder,
    deliveryFolder
  };
}

function ensureChildFolder(parent, name) {
  const existing = findChildFolderByNameCaseInsensitive(parent, name);
  if (existing) {
    return existing;
  }

  const created = parent.createFolder(name);
  Logger.log(`Created folder "${name}" in ${parent.getName()}: ${created.getUrl()}`);
  return created;
}

function detectHeaderRow(sheet) {
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

    const trimmed = trimTrailingEmptyCells(row);
    const template = detectTemplate(trimmed);

    if (!template) {
      return null;
    }

    return { headerRowIndex: i + 1, template };
  }

  return null;
}

function trimTrailingEmptyCells(row) {
  let end = row.length;

  while (end > 0 && String(row[end - 1] || '').trim() === '') {
    end--;
  }

  return row.slice(0, end);
}

function checkSourceFormatting(sheet, enCol, firstDataRow, lastRow) {
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
      collectRichTextIssues(rich, issues);
    }

    if (issues.size > 0) {
      errors.push({
        row: firstDataRow + i,
        issues: Array.from(issues)
      });
    }
  }

  return errors;
}

// A cell-level "Insert > Link" hyperlink is exposed as a single RichText run
// with a non-null getLinkUrl(), so this covers both cell-level and partial
// hyperlinks without an extra getCell().getLinkUrl() round-trip per row.
function collectRichTextIssues(rich, issues) {
  const runs = rich.getRuns();

  for (const run of runs) {
    const runText = run.getText();

    if (!runText || runText.trim() === '') {
      continue;
    }

    const style = run.getTextStyle();

    if (style.isBold()) issues.add('bold');
    if (style.isItalic()) issues.add('italic');

    if (!isDefaultForegroundColor(style.getForegroundColor())) {
      issues.add('non-default color');
    }

    if (run.getLinkUrl()) {
      issues.add('hyperlink');
    }
  }
}

function checkCharacterLimits(sheet, enCol, limitCol, firstDataRow, lastRow) {
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
}

function isDefaultForegroundColor(color) {
  if (color === null || color === undefined) {
    return true;
  }

  return DEFAULT_FOREGROUND_COLORS.has(String(color).trim().toLowerCase());
}

// Drive.Files.export in v3 of the Advanced Drive Service returns metadata
// only — it doesn't deliver the exported bytes. Hit the Sheets export
// endpoint directly with the script's OAuth token instead.
function exportSheetAsCsv(spreadsheetId) {
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
}

function cleanDirectiveRows(csvText) {
  const lines = csvText.split(/\r?\n/);

  const cleaned = lines.map(line => {
    if (line.startsWith(DIRECTIVE_PREFIX)) {
      return line.replace(/,+$/, '');
    }
    return line;
  });

  return cleaned.join('\n');
}

function summarizeFormattingErrors(errors) {
  const head = errors
    .slice(0, ERROR_ROW_PREVIEW_LIMIT)
    .map(e => `row ${e.row} [${e.issues.join(', ')}]`)
    .join('; ');

  const extra = errors.length - ERROR_ROW_PREVIEW_LIMIT;
  const suffix = extra > 0 ? `; and ${extra} more` : '';

  return `${errors.length} error cell(s) - ${head}${suffix}`;
}

function summarizeCharLimitWarnings(warnings) {
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
