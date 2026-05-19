/*
1. Check for .csv files in the Translation folder.
2. For each CSV, determine BASE_FILENAME by removing the locale suffix and .csv extension.
   Example:
   CC58000_win10_spotlight_security_may2026_v2_foo.csv
   becomes:
   CC58000_win10_spotlight_security_may2026_v2
3. Look up BASE_FILENAME via a Drive query for Google Sheets matching the name,
   then filter to those whose parent folder is named "Source" and lives under
   DEST_FOLDER_ID. Results are memoized in-memory for the current run so
   multiple locales of the same base name don't re-query.
4. Once the matching source Google Sheet is found, move one level up from Source,
   find the Delivery folder, and create Original and Delivery to Customer folders if missing.
5. Move the generated Google Sheet to Delivery to Customer. If a file with the
   same name already exists in that folder, trash it first and log a warning.
6. Move the CSV to Original. If a file with the same name already exists in
   that folder, trash it first and log a warning.

The script logs an error and skips the file if:
* The source Google Sheet is not found.
* The source file is not in a Source folder under DEST_FOLDER_ID.
* There is no Delivery folder at the same level as Source.
* The generated Google Sheet matching BASE_FILENAME + locale is not found in the Translation folder.

If SLACK_WEBHOOK_URL is defined (alongside SOURCE_FOLDER_ID / DEST_FOLDER_ID),
a summary of file moves and errors is posted to that Slack webhook at the end
of each run. If the constant is missing or empty, posting is skipped silently.

Make sure to structure the request correctly and keep the same file name between Drive Connector
and Source folder. Rename the original if needed.
*/

// Process both CSVs and Google Docs in one run.
function moveAllDelivered() {
  const report = createRunReport();

  try {
    withScriptLock(() => {
      const sourceFolder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
      const destRootFolder = DriveApp.getFolderById(DEST_FOLDER_ID);

      processCsvBatch(sourceFolder, destRootFolder, report);
      processDocBatch(sourceFolder, destRootFolder, report);
    });
  } finally {
    sendSlackReport(report, 'moveAllDelivered');
  }
}

function moveDeliveredFiles() {
  const report = createRunReport();

  try {
    withScriptLock(() => {
      const sourceFolder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
      const destRootFolder = DriveApp.getFolderById(DEST_FOLDER_ID);

      processCsvBatch(sourceFolder, destRootFolder, report);
    });
  } finally {
    sendSlackReport(report, 'moveDeliveredFiles');
  }
}

function processCsvBatch(sourceFolder, destRootFolder, report) {
  const csvFiles = [];
  const csvIter = sourceFolder.getFilesByType(MimeType.CSV);
  while (csvIter.hasNext()) {
    csvFiles.push(csvIter.next());
  }

  const sourceMatchCache = new Map();

  for (const csvFile of csvFiles) {
    try {
      moveSingleDeliveredFile(
        csvFile,
        sourceFolder,
        destRootFolder,
        sourceMatchCache,
        report
      );
    } catch (error) {
      recordError(report, `ERROR processing ${csvFile.getName()}: ${error}`);
    }
  }
}

function moveSingleDeliveredFile(
  csvFile,
  sourceFolder,
  destRootFolder,
  sourceMatchCache,
  report
) {
  const csvFileName = csvFile.getName();
  const sheetFileName = csvFileName.replace(/\.csv$/i, '');
  const baseFileName = removeLocaleFromFileName(csvFileName);

  Logger.log(`Processing CSV: ${csvFileName}`);
  Logger.log(`Base filename: ${baseFileName}`);

  const sourceMatch = getSourceMatch(
    baseFileName,
    destRootFolder,
    sourceMatchCache,
    MimeType.GOOGLE_SHEETS
  );

  if (!sourceMatch) {
    recordError(
      report,
      `No source Google Sheet match for "${baseFileName}" (CSV: ${csvFileName}).`
    );
    return;
  }

  const sourceReferenceFolder = sourceMatch.sourceFolder;
  const projectFolder = sourceMatch.projectFolder;

  Logger.log(
    `Reference Sheet found in Source folder: ${sourceReferenceFolder.getUrl()}`
  );

  const deliveryFolder = findChildFolderByNameCaseInsensitive(
    projectFolder,
    'Delivery'
  );

  if (!deliveryFolder) {
    recordError(
      report,
      `Could not find Delivery folder under ${projectFolder.getUrl()} (CSV: ${csvFileName}).`
    );
    return;
  }

  let deliveryToCustomerFolder = findChildFolderByNameCaseInsensitive(
    deliveryFolder,
    'Delivery to Customer'
  );

  let originalFolder = findChildFolderByNameCaseInsensitive(
    deliveryFolder,
    'Original'
  );

  if (!deliveryToCustomerFolder) {
    deliveryToCustomerFolder =
      deliveryFolder.createFolder('Delivery to Customer');

    Logger.log(
      `Created folder "Delivery to Customer": ${deliveryToCustomerFolder.getUrl()}`
    );
  }

  if (!originalFolder) {
    originalFolder = deliveryFolder.createFolder('Original');

    Logger.log(`Created folder "Original": ${originalFolder.getUrl()}`);
  }

  const generatedSheet = findGoogleSheetByNameInFolder(
    sourceFolder,
    sheetFileName
  );

  if (!generatedSheet) {
    recordError(
      report,
      `Could not find generated Google Sheet named "${sheetFileName}" in source folder.`
    );
    return;
  }

  removeExistingFilesWithName(
    deliveryToCustomerFolder,
    generatedSheet.getName()
  );
  generatedSheet.moveTo(deliveryToCustomerFolder);
  recordMove(
    report,
    'Sheet',
    generatedSheet.getName(),
    deliveryToCustomerFolder.getUrl()
  );

  Logger.log(
    `Moved Sheet "${generatedSheet.getName()}" to: ${deliveryToCustomerFolder.getUrl()}`
  );

  removeExistingFilesWithName(originalFolder, csvFile.getName());
  csvFile.moveTo(originalFolder);
  recordMove(report, 'CSV', csvFile.getName(), originalFolder.getUrl());

  Logger.log(`Moved CSV "${csvFile.getName()}" to: ${originalFolder.getUrl()}`);
}

function removeExistingFilesWithName(folder, name) {
  const files = folder.getFilesByName(name);

  while (files.hasNext()) {
    const file = files.next();

    console.warn(
      `Removing existing file "${file.getName()}" in ${folder.getUrl()}: ${file.getUrl()}`
    );

    file.setTrashed(true);
  }
}

/*
Move Google Docs from the Translation folder to their matching Delivery folder.

For each Doc in SOURCE_FOLDER_ID:
1. Determine BASE_FILENAME by stripping the locale suffix from the Doc name.
2. Look up a Doc matching BASE_FILENAME in a Source folder under DEST_FOLDER_ID.
3. If found, locate the Delivery folder at the same level as Source.
4. Move the Doc directly into Delivery. If a file with the same name already
   exists there, trash it first and log a warning.

Unlike moveDeliveredFiles, this does not create or use Original / Delivery to
Customer subfolders; the Doc is placed directly in Delivery.
*/
function moveDeliveredDocs() {
  const report = createRunReport();

  try {
    withScriptLock(() => {
      const sourceFolder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
      const destRootFolder = DriveApp.getFolderById(DEST_FOLDER_ID);

      processDocBatch(sourceFolder, destRootFolder, report);
    });
  } finally {
    sendSlackReport(report, 'moveDeliveredDocs');
  }
}

function processDocBatch(sourceFolder, destRootFolder, report) {
  const docs = [];
  const docIter = sourceFolder.getFilesByType(MimeType.GOOGLE_DOCS);
  while (docIter.hasNext()) {
    docs.push(docIter.next());
  }

  const sourceMatchCache = new Map();

  for (const doc of docs) {
    try {
      moveSingleDeliveredDoc(doc, destRootFolder, sourceMatchCache, report);
    } catch (error) {
      recordError(report, `ERROR processing ${doc.getName()}: ${error}`);
    }
  }
}

function moveSingleDeliveredDoc(doc, destRootFolder, sourceMatchCache, report) {
  const docName = doc.getName();
  const baseFileName = removeLocaleFromFileName(docName);

  Logger.log(`Processing Doc: ${docName}`);
  Logger.log(`Base filename: ${baseFileName}`);

  const sourceMatch = getSourceMatch(
    baseFileName,
    destRootFolder,
    sourceMatchCache,
    MimeType.GOOGLE_DOCS
  );

  if (!sourceMatch) {
    recordError(
      report,
      `No source Google Doc match for "${baseFileName}" (Doc: ${docName}).`
    );
    return;
  }

  const projectFolder = sourceMatch.projectFolder;

  Logger.log(
    `Reference Doc found in Source folder: ${sourceMatch.sourceFolder.getUrl()}`
  );

  const deliveryFolder = findChildFolderByNameCaseInsensitive(
    projectFolder,
    'Delivery'
  );

  if (!deliveryFolder) {
    recordError(
      report,
      `Could not find Delivery folder under ${projectFolder.getUrl()} (Doc: ${docName}).`
    );
    return;
  }

  removeExistingFilesWithName(deliveryFolder, docName);
  doc.moveTo(deliveryFolder);
  recordMove(report, 'Doc', docName, deliveryFolder.getUrl());

  Logger.log(`Moved Doc "${docName}" to: ${deliveryFolder.getUrl()}`);
}

function getSourceMatch(
  baseFileName,
  destRootFolder,
  sourceMatchCache,
  mimeType
) {
  if (sourceMatchCache.has(baseFileName)) {
    const cached = sourceMatchCache.get(baseFileName);

    if (cached) {
      Logger.log(`Using memoized Source match for "${baseFileName}".`);
    } else {
      Logger.log(`Memoized miss for "${baseFileName}". Skipping search.`);
    }

    return cached;
  }

  const match = searchSourceMatch(baseFileName, destRootFolder, mimeType);
  sourceMatchCache.set(baseFileName, match);
  return match;
}

function searchSourceMatch(baseFileName, destRootFolder, mimeType) {
  Logger.log(
    `Searching for file named "${baseFileName}" (mimeType: ${mimeType}).`
  );

  const escapedName = baseFileName
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

  const query =
    `title = '${escapedName}' and ` +
    `mimeType = '${mimeType}' and ` +
    `trashed = false`;

  const files = DriveApp.searchFiles(query);
  const matches = [];

  while (files.hasNext()) {
    const file = files.next();

    if (file.getName() !== baseFileName) {
      continue;
    }

    const parent = getFirstParent(file);

    if (!parent) {
      continue;
    }

    if (parent.getName().toLowerCase() !== 'source') {
      continue;
    }

    if (!isDescendantOf(parent, destRootFolder)) {
      continue;
    }

    matches.push({ file, sourceFolder: parent });
  }

  if (matches.length === 0) {
    console.error(
      `Could not find file named "${baseFileName}" (mimeType: ${mimeType}) in any Source folder under destination root.`
    );
    return null;
  }

  if (matches.length > 1) {
    console.warn(
      `Found multiple Google Sheets named "${baseFileName}". Using the first one.`
    );

    matches.forEach(m => {
      Logger.log(`Match: ${m.file.getName()} - ${m.file.getUrl()}`);
    });
  }

  const referenceSheet = matches[0].file;
  const sourceFolder = matches[0].sourceFolder;
  const projectFolder = getFirstParent(sourceFolder);

  if (!projectFolder) {
    console.error(
      `Could not find parent folder above Source for "${baseFileName}".`
    );
    return null;
  }

  return {
    referenceSheet,
    sourceFolder,
    projectFolder
  };
}

function isDescendantOf(folder, ancestor) {
  const ancestorId = ancestor.getId();
  let current = folder;

  while (current) {
    if (current.getId() === ancestorId) {
      return true;
    }

    const parents = current.getParents();
    current = parents.hasNext() ? parents.next() : null;
  }

  return false;
}

function removeLocaleFromFileName(fileName) {
  const nameWithoutExtension = fileName.replace(/\.csv$/i, '');

  return nameWithoutExtension.replace(/_[^_]+$/, '');
}

function findGoogleSheetByNameInFolder(folder, name) {
  const files = folder.getFilesByName(name);

  while (files.hasNext()) {
    const file = files.next();

    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return file;
    }
  }

  return null;
}

function findChildFolderByNameCaseInsensitive(parentFolder, targetName) {
  const folders = parentFolder.getFolders();
  const normalizedTargetName = targetName.toLowerCase();

  while (folders.hasNext()) {
    const folder = folders.next();

    if (folder.getName().toLowerCase() === normalizedTargetName) {
      return folder;
    }
  }

  return null;
}

function getFirstParent(fileOrFolder) {
  const parents = fileOrFolder.getParents();

  return parents.hasNext() ? parents.next() : null;
}

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Another run is in progress. Exiting.');
    return;
  }

  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

function createRunReport() {
  return { moves: [], errors: [] };
}

function recordMove(report, kind, name, destinationUrl) {
  report.moves.push({ kind, name, destinationUrl });
}

function recordError(report, message) {
  report.errors.push(message);
  console.error(message);
}

function sendSlackReport(report, runLabel) {
  if (typeof SLACK_WEBHOOK_URL === 'undefined' || !SLACK_WEBHOOK_URL) {
    Logger.log('SLACK_WEBHOOK_URL is not configured. Skipping Slack notification.');
    return;
  }

  if (report.moves.length === 0 && report.errors.length === 0) {
    return;
  }

  const lines = [];

  lines.push(
    `*${runLabel}*: ${report.moves.length} move(s), ${report.errors.length} error(s)`
  );

  if (report.moves.length > 0) {
    lines.push('', '*Moves:*');
    report.moves.forEach(m => {
      lines.push(`• [${m.kind}] ${m.name} → ${m.destinationUrl}`);
    });
  }

  if (report.errors.length > 0) {
    lines.push('', '*Errors:*');
    report.errors.forEach(e => {
      lines.push(`• ${e}`);
    });
  }

  try {
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: lines.join('\n') }),
      muteHttpExceptions: true
    });
  } catch (error) {
    console.error(`Failed to send Slack notification: ${error}`);
  }
}
