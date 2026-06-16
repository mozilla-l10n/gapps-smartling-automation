/*
Process CSV translation files in SOURCE_FOLDER_ID and convert them into
formatted Google Sheets.

For each .csv in the folder:
1. Ensure a Google Sheet of the same base name exists in the same folder.
   Create it (in the same folder) if missing.
2. If the Sheet already has content and was updated after the CSV, skip it
   (but still ensure the Mozilla Audience Drive label is applied).
3. Otherwise, regenerate the Sheet from the CSV:
   - Parse the CSV.
   - Detect the template by the first column header and drop the target
     column:
     * Survey template (first column "Key"): always drop "Translation".
     * Standard template (otherwise): drop "Target Language" only when every
       cell equals "EN Copy".
   - Rename the last column header to the locale extracted from the CSV name
     (e.g. "..._fr.csv" -> "fr"). Smartling always places the target
     column last.
   - Write the values into the first sheet, replacing prior content.
   - Apply header styling, column widths, frozen header row, wrap/top-align,
     and conditional formatting that highlights target cells exceeding the
     "Target Character Limit" in column B.
   - For char-limit templates (column B = "Target Character Limit"), repurpose
     column A into a live count of the localized text: header becomes
     "Locale Character Count" and each data row gets =LEN(<localeCol><row>),
     where the locale column is the last column.
4. Apply the "Specific Workgroups and Individuals = Mozilla Audience" Drive
   label to both the CSV and the resulting Sheet, unless an audience value
   is already set on the file (manual overrides are preserved).

Errors processing individual CSVs are logged and don't stop the run.

Reporting:
- If SLACK_WEBHOOK_URL is set in config.gs, a summary of Sheet creations,
  regenerations, and errors is posted to that Slack webhook at the end of each
  run. If empty, posting is skipped.

`processCsvFiles` is the top-level entry point and is visible in the Apps
Script picker. Internal helpers live on the `Convert` namespace so they don't
clutter the picker. Cross-file helpers come from `Shared` (utils.gs).

Required configuration (defined in config.gs):
  SOURCE_FOLDER_ID - Drive folder containing the CSVs.

Required services:
  Advanced Drive Service (for Drive.Files.listLabels / modifyLabels).
*/

const COLUMN_WIDTH = 220;
const SURVEY_COLUMN_WIDTH = 400;
const HEADER_COLOR = '#f9cb9c';
const LOCALE_CHARACTER_COUNT_HEADER = 'Locale Character Count';

function processCsvFiles() {
  Shared.runWithReport('processCsvFiles', report => {
    const folder = DriveApp.getFolderById(SOURCE_FOLDER_ID);

    Shared.processBatch(folder, MimeType.CSV, report, (csvFile, r) =>
      Convert.processSingleCsvFile(folder, csvFile, r)
    );
  });
}

const Convert = {
  // Survey template (first column "Key"): the "Translation" column is always
  // dropped, and columns are rendered wider (SURVEY_COLUMN_WIDTH). Loose check
  // kept here on purpose — Smartling-produced CSVs may include extra columns
  // that the strict Shared.detectTemplate would not classify as survey.
  isSurveyTemplate(values) {
    return values.length > 0 && values[0][0] === KEY_HEADER;
  },

  processSingleCsvFile(folder, csvFile, report) {
    Logger.log(`Processing CSV: ${csvFile.getName()}`);

    Shared.markVisited(report, `batch-error:${csvFile.getId()}`);

    Shared.applyMozillaAudienceIndicator(csvFile.getId());

    const { nameWithoutExtension: csvName, locale } = Shared.splitLocaleFromName(
      csvFile.getName()
    );

    const existingFile = Shared.findFileInFolderByName(
      folder,
      csvName,
      MimeType.GOOGLE_SHEETS
    );
    let spreadsheet = existingFile
      ? SpreadsheetApp.openById(existingFile.getId())
      : null;
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
        Shared.applyMozillaAudienceIndicator(spreadsheet.getId());
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

    const survey = Convert.isSurveyTemplate(values);
    values = Convert.cleanTargetColumns(values, locale);

    const sheet = spreadsheet.getSheets()[0];

    sheet.clear();
    sheet.clearConditionalFormatRules();

    sheet
      .getRange(1, 1, values.length, values[0].length)
      .setValues(values);

    Convert.formatSheet(
      sheet,
      values.length,
      values[0].length,
      survey ? SURVEY_COLUMN_WIDTH : COLUMN_WIDTH
    );

    Shared.applyMozillaAudienceIndicator(spreadsheet.getId());

    Shared.recordEvent(
      report,
      created ? 'Sheet created' : 'Sheet regenerated',
      csvName,
      spreadsheet.getUrl()
    );

    Logger.log(`Finished processing ${csvFile.getName()}`);
  },

  cleanTargetColumns(values, locale) {
    const survey = Convert.isSurveyTemplate(values);

    Logger.log(
      `Template detected: ${survey ? 'survey' : 'standard'} ` +
        `(first column header: ${JSON.stringify(values[0][0])})`
    );

    if (survey) {
      values = Convert.dropColumnByHeader(values, TRANSLATION_HEADER);
    } else {
      values = Convert.dropRedundantTargetColumn(
        values,
        EN_COPY_HEADER,
        TARGET_LANGUAGE_HEADER
      );
    }

    if (locale && values[0].length > 0) {
      values[0][values[0].length - 1] = locale;
    }

    return values;
  },

  // If every row's targetHeader cell equals the corresponding sourceHeader
  // cell, drop the targetHeader column. Returns the original values otherwise.
  dropRedundantTargetColumn(values, sourceHeader, targetHeader) {
    const headers = values[0];
    const sourceIdx = headers.indexOf(sourceHeader);
    const targetIdx = headers.indexOf(targetHeader);

    if (sourceIdx === -1 || targetIdx === -1) {
      return values;
    }

    const targetMatchesSource = values.slice(1).every(
      row => Convert.normalizeCell(row[targetIdx]) === Convert.normalizeCell(row[sourceIdx])
    );

    if (!targetMatchesSource) {
      return values;
    }

    return Convert.dropColumnByHeader(values, targetHeader);
  },

  // Drops the column whose header equals `header`. Returns values unchanged if
  // no such column exists.
  dropColumnByHeader(values, header) {
    const idx = values[0].indexOf(header);

    if (idx === -1) {
      return values;
    }

    return values.map(row => row.filter((_, i) => i !== idx));
  },

  normalizeCell(value) {
    return String(value || '').trim();
  },

  formatSheet(sheet, numRows, numCols, columnWidth) {
    sheet.getRange(1, 1, numRows, numCols)
      .setVerticalAlignment('top')
      .setWrap(true);

    sheet.getRange(1, 1, 1, numCols)
      .setBackground(HEADER_COLOR)
      .setFontWeight('bold');

    sheet.setColumnWidths(1, numCols, columnWidth);
    sheet.setFrozenRows(1);

    Convert.addCharacterLimitConditionalFormatting(sheet, numRows, numCols);
    Convert.addLocaleCharacterCountColumn(sheet, numRows, numCols);
  },

  // Char-limit templates ship column A as a static "EN Character count". Once
  // converted, the source EN copy never changes but the localized text in the
  // last (locale) column does, so repurpose column A into a live count of the
  // localized text: header "Locale Character Count" and =LEN(<localeCol><row>)
  // down each data row. Only runs when column B is the "Target Character Limit"
  // header (same guard as the conditional formatting below).
  addLocaleCharacterCountColumn(sheet, numRows, numCols) {
    if (numCols < 4) {
      return;
    }

    if (sheet.getRange(1, 2).getValue() !== TARGET_CHARACTER_LIMIT_HEADER) {
      return;
    }

    sheet.getRange(1, 1).setValue(LOCALE_CHARACTER_COUNT_HEADER);

    if (numRows < 2) {
      return;
    }

    // The locale (target) column is always the last column after cleanup; for
    // the canonical char-limit layout that is column E.
    const localeCol = Convert.columnToLetter(numCols);
    const formulas = [];
    for (let row = 2; row <= numRows; row++) {
      formulas.push([`=LEN(${localeCol}${row})`]);
    }

    sheet.getRange(2, 1, numRows - 1, 1).setFormulas(formulas);
  },

  // 1-based column number -> A1 column letter(s) (1 -> "A", 27 -> "AA").
  columnToLetter(column) {
    let letter = '';
    while (column > 0) {
      const remainder = (column - 1) % 26;
      letter = String.fromCharCode(65 + remainder) + letter;
      column = Math.floor((column - 1) / 26);
    }
    return letter;
  },

  // Conditional formatting that highlights target cells exceeding the
  // "Target Character Limit" in column B.
  addCharacterLimitConditionalFormatting(sheet, numRows, numCols) {
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
};
