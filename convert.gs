/*
Process CSV translation files in SOURCE_FOLDER_ID and convert them into
formatted Google Sheets.

For each .csv in the folder:
1. Ensure a Google Sheet of the same base name exists in the same folder.
   Create it (in the folder, not in My Drive) if missing.
2. If the Sheet already has content and was updated after the CSV, skip it
   (but still ensure the Mozilla Audience Drive label is applied).
3. Otherwise, regenerate the Sheet from the CSV:
   - Parse the CSV.
   - If every "Target Language" cell equals the matching "EN Copy" cell
     (translator returned the source unchanged), drop the "Target Language"
     column.
   - Rename the last column header to the locale extracted from the CSV name
     (e.g. "..._fr.csv" -> "fr"). The producer always places the target
     column last, so this renames either Target Language, or EN Copy when it
     was kept because the target duplicated the source.
   - Write the values into the first sheet, replacing prior content.
   - Apply header styling, column widths, frozen header row, wrap/top-align,
     and conditional formatting that highlights target cells exceeding the
     "Target Character Limit" in column B.
4. Apply the "Specific Workgroups and Individuals = Mozilla Audience" Drive
   label to both the CSV and the resulting Sheet, unless an audience value
   is already set on the file (manual overrides are preserved).

Errors processing individual CSVs are logged and don't stop the run.

Reporting:
- If SLACK_WEBHOOK_URL is set in config.gs, a summary of Sheet creations,
  regenerations, and errors is posted to that Slack webhook at the end of each
  run. If empty, posting is skipped.

Shared helpers (locking, reporting, batch iteration, locale parsing) live in
utils.gs.

Required configuration (defined in config.gs):
  SOURCE_FOLDER_ID - Drive folder containing the CSVs.

Required services:
  Advanced Drive Service (for Drive.Files.listLabels / modifyLabels).
*/

const COLUMN_WIDTH = 220;
const HEADER_COLOR = '#f9cb9c';

const EN_COPY_HEADER = 'EN Copy';
const TARGET_LANGUAGE_HEADER = 'Target Language';
const TARGET_CHARACTER_LIMIT_HEADER = 'Target Character Limit';

// This is the Specific Workgroups and Individuals label for Mozilla Audience
const MOZILLA_AUDIENCE_LABEL_ID = 'REDACTED';
const MOZILLA_AUDIENCE_FIELD_ID = 'REDACTED';
const MOZILLA_AUDIENCE_SPECIFIC_WORKGROUPS_CHOICE_ID = 'REDACTED';

function processCsvFiles() {
  runWithReport('processCsvFiles', report => {
    const folder = DriveApp.getFolderById(SOURCE_FOLDER_ID);

    processBatch(folder, MimeType.CSV, report, (csvFile, r) =>
      processSingleCsvFile(folder, csvFile, r)
    );
  });
}

function processSingleCsvFile(folder, csvFile, report) {
  Logger.log(`Processing CSV: ${csvFile.getName()}`);

  applyMozillaAudienceIndicator(csvFile.getId());

  const csvName = csvFile.getName().replace(/\.csv$/i, '');
  const { locale } = splitLocaleFromName(csvFile.getName());

  let spreadsheet = findSpreadsheetByName(folder, csvName);
  const created = !spreadsheet;

  if (!spreadsheet) {
    Logger.log(`No matching Sheet found. Creating: ${csvName}`);

    spreadsheet = SpreadsheetApp.create(csvName);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(folder);
  } else {
    Logger.log(`Matching Sheet found: ${spreadsheet.getName()}`);

    const sheetFile = DriveApp.getFileById(spreadsheet.getId());
    const sheet = spreadsheet.getSheets()[0];

    const sheetHasContent = sheet.getLastRow() > 0 && sheet.getLastColumn() > 0;

    if (
      sheetHasContent &&
      sheetFile.getLastUpdated() >= csvFile.getLastUpdated()
    ) {
      Logger.log(
        `Skipping ${csvFile.getName()} because Sheet is already up to date.`
      );
      applyMozillaAudienceIndicator(spreadsheet.getId());
      return;
    }

    Logger.log(`Regenerating Sheet for ${csvFile.getName()}.`);
  }

  const csvContent = csvFile.getBlob().getDataAsString();
  let values = Utilities.parseCsv(csvContent);

  if (!values.length) {
    Logger.log(`Skipping empty CSV: ${csvFile.getName()}`);
    return;
  }

  values = cleanTargetColumns(values, locale);

  const sheet = spreadsheet.getSheets()[0];

  sheet.clear();
  sheet.clearConditionalFormatRules();

  sheet
    .getRange(1, 1, values.length, values[0].length)
    .setValues(values);

  formatSheet(sheet, values.length, values[0].length);

  applyMozillaAudienceIndicator(spreadsheet.getId());

  recordEvent(
    report,
    created ? 'Sheet created' : 'Sheet regenerated',
    csvName,
    spreadsheet.getUrl()
  );

  Logger.log(`Finished processing ${csvFile.getName()}`);
}

function cleanTargetColumns(values, locale) {
  const headers = values[0];

  const enCopyIndex = headers.indexOf(EN_COPY_HEADER);
  const targetLanguageIndex = headers.indexOf(TARGET_LANGUAGE_HEADER);

  if (enCopyIndex !== -1 && targetLanguageIndex !== -1) {
    const targetMatchesEnCopy = values
      .slice(1)
      .every(
        row =>
          normalizeCell(row[targetLanguageIndex]) ===
          normalizeCell(row[enCopyIndex])
      );

    if (targetMatchesEnCopy) {
      values = values.map(row =>
        row.filter((_, index) => index !== targetLanguageIndex)
      );
    }
  }

  if (locale && values[0].length > 0) {
    values[0][values[0].length - 1] = locale;
  }

  return values;
}

function normalizeCell(value) {
  return String(value || '').trim();
}

function findSpreadsheetByName(folder, name) {
  const files = folder.getFilesByName(name);

  while (files.hasNext()) {
    const file = files.next();

    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return SpreadsheetApp.openById(file.getId());
    }
  }

  return null;
}

function formatSheet(sheet, numRows, numCols) {
  sheet.getRange(1, 1, numRows, numCols)
    .setVerticalAlignment('top')
    .setWrap(true);

  sheet.getRange(1, 1, 1, numCols)
    .setBackground(HEADER_COLOR)
    .setFontWeight('bold');

  sheet.setColumnWidths(1, numCols, COLUMN_WIDTH);
  sheet.setFrozenRows(1);

  addCharacterLimitConditionalFormatting(sheet, numRows, numCols);
}

// Add target label to files (Mozilla audience) if not set yet
function applyMozillaAudienceIndicator(fileId) {
  const labelsResponse = Drive.Files.listLabels(fileId, {
    fields: 'labels(id,fields)'
  });

  const existingLabel = labelsResponse.labels?.find(
    label => label.id === MOZILLA_AUDIENCE_LABEL_ID
  );

  const existingFieldValue =
    existingLabel?.fields?.[MOZILLA_AUDIENCE_FIELD_ID]?.selection;

  if (existingFieldValue && existingFieldValue.length > 0) {
    return;
  }

  Drive.Files.modifyLabels({
    labelModifications: [
      {
        labelId: MOZILLA_AUDIENCE_LABEL_ID,
        fieldModifications: [
          {
            fieldId: MOZILLA_AUDIENCE_FIELD_ID,
            setSelectionValues: [
              MOZILLA_AUDIENCE_SPECIFIC_WORKGROUPS_CHOICE_ID
            ]
          }
        ]
      }
    ]
  }, fileId);
}

// Add back conditional formatting on sheets with target limits
function addCharacterLimitConditionalFormatting(sheet, numRows, numCols) {
  if (numRows < 2 || numCols < 4) {
    return;
  }

  if (sheet.getRange(1, 2).getValue() !== TARGET_CHARACTER_LIMIT_HEADER) {
    return;
  }

  const range = sheet.getRange(2, 1, numRows - 1, numCols);

  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=LEN($D2)>$B2')
    .setBackground('#f4cccc')
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules([rule]);
}
