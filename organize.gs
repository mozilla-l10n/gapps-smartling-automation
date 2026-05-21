/*
Organize delivered translations from the Translation folder into per-project
Delivery folders under DEST_FOLDER_ID.

`moveAllDelivered` is the top-level entry point and is visible in the Apps
Script picker (processes both CSV/Sheet pairs and Docs in one run). The
narrower variants (`moveDeliveredFiles` for CSVs only, `moveDeliveredDocs`
for Docs only) and internal helpers live on the `Organize` namespace so they
don't clutter the picker. Cross-file helpers come from `Shared` (utils.gs).

CSV/Sheet flow (per CSV in SOURCE_FOLDER_ID):
1. Determine BASE_FILENAME by stripping the locale suffix and .csv extension.
   Example: CC58000_..._v2_foo.csv  ->  CC58000_..._v2
2. Look up BASE_FILENAME via a Drive query, filtered to Google Sheets whose
   parent folder is named "Source" and lives somewhere under DEST_FOLDER_ID.
   Results are memoized in-memory per run so multiple locales of the same base
   name don't re-query.
3. Walk one level up from Source to the project folder; find Delivery, and
   create Original / Delivery to Customer subfolders if missing.
4. Move the generated Google Sheet (same name as the CSV minus extension) into
   Delivery to Customer.
5. Move the CSV into Original.

Doc flow (per Google Doc in SOURCE_FOLDER_ID):
1. Determine BASE_FILENAME by stripping the locale suffix.
2. Look up BASE_FILENAME via the same Source-folder Drive query (for Docs).
3. Find Delivery at the same level as Source.
4. Move the Doc directly into Delivery (no Original / Delivery to Customer
   subfolders are involved).

Common to both flows:
- If a file with the same name already exists in the destination, it is
  trashed first and a warning is logged.
- A file is skipped (with an error recorded) when the source match cannot be
  found, the Source folder has no sibling Delivery, or the generated Sheet
  cannot be located in the Translation folder.

Reporting:
- If SLACK_WEBHOOK_URL is set in config.gs, a per-run summary of events and
  errors is posted to that Slack webhook. If empty, posting is skipped.

Make sure to structure the request correctly and keep the same file name
between Drive Connector and Source folder. Rename the original if needed.
*/

// Process both CSVs and Google Docs in one run.
function moveAllDelivered() {
  Shared.runWithReport('moveAllDelivered', report => {
    const sourceFolder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
    const destRootFolder = DriveApp.getFolderById(DEST_FOLDER_ID);

    const csvCache = new Map();
    Shared.processBatch(sourceFolder, MimeType.CSV, report, (csvFile, r) =>
      Organize.moveSingleDeliveredFile(csvFile, sourceFolder, destRootFolder, csvCache, r)
    );

    const docCache = new Map();
    Shared.processBatch(sourceFolder, MimeType.GOOGLE_DOCS, report, (doc, r) =>
      Organize.moveSingleDeliveredDoc(doc, destRootFolder, docCache, r)
    );
  });
}

const Organize = {
  moveDeliveredFiles() {
    Shared.runWithReport('moveDeliveredFiles', report => {
      const sourceFolder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
      const destRootFolder = DriveApp.getFolderById(DEST_FOLDER_ID);
      const cache = new Map();

      Shared.processBatch(sourceFolder, MimeType.CSV, report, (csvFile, r) =>
        Organize.moveSingleDeliveredFile(csvFile, sourceFolder, destRootFolder, cache, r)
      );
    });
  },

  moveDeliveredDocs() {
    Shared.runWithReport('moveDeliveredDocs', report => {
      const sourceFolder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
      const destRootFolder = DriveApp.getFolderById(DEST_FOLDER_ID);
      const cache = new Map();

      Shared.processBatch(sourceFolder, MimeType.GOOGLE_DOCS, report, (doc, r) =>
        Organize.moveSingleDeliveredDoc(doc, destRootFolder, cache, r)
      );
    });
  },

  moveSingleDeliveredFile(
    csvFile,
    sourceFolder,
    destRootFolder,
    sourceMatchCache,
    report
  ) {
    const csvFileName = csvFile.getName();
    const csvFileId = csvFile.getId();
    const { nameWithoutExtension: sheetFileName, base: baseFileName } =
      Shared.splitLocaleFromName(csvFileName);

    Logger.log(`Processing CSV: ${csvFileName}`);
    Logger.log(`Base filename: ${baseFileName}`);

    // Claim ownership of dedup keys so prior notifications resolve if the
    // corresponding issue no longer fires this run.
    Shared.markVisited(report, `batch-error:${csvFileId}`);
    Shared.markVisited(report, `no-source-match:${csvFileId}`);
    Shared.markVisited(report, `missing-delivery:${csvFileId}`);
    Shared.markVisited(report, `missing-generated-sheet:${csvFileId}`);

    const sourceMatch = Organize.getSourceMatch(
      baseFileName,
      destRootFolder,
      sourceMatchCache,
      MimeType.GOOGLE_SHEETS
    );

    if (!sourceMatch) {
      Shared.recordError(
        report,
        `No source Google Sheet match for "${baseFileName}" (CSV: ${csvFileName}).`,
        `no-source-match:${csvFileId}`
      );
      return;
    }

    const sourceReferenceFolder = sourceMatch.sourceFolder;
    const projectFolder = sourceMatch.projectFolder;

    Logger.log(
      `Reference Sheet found in Source folder: ${sourceReferenceFolder.getUrl()}`
    );

    const deliveryFolder = Shared.findChildFolderByNameCaseInsensitive(
      projectFolder,
      'Delivery'
    );

    if (!deliveryFolder) {
      Shared.recordError(
        report,
        `Could not find Delivery folder under ${projectFolder.getUrl()} (CSV: ${csvFileName}).`,
        `missing-delivery:${csvFileId}`
      );
      return;
    }

    let deliveryToCustomerFolder = Shared.findChildFolderByNameCaseInsensitive(
      deliveryFolder,
      'Delivery to Customer'
    );

    let originalFolder = Shared.findChildFolderByNameCaseInsensitive(
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

    const generatedSheet = Shared.findFileInFolderByName(
      sourceFolder,
      sheetFileName,
      MimeType.GOOGLE_SHEETS
    );

    if (!generatedSheet) {
      Shared.recordError(
        report,
        `Could not find generated Google Sheet named "${sheetFileName}" in source folder.`,
        `missing-generated-sheet:${csvFileId}`
      );
      return;
    }

    Shared.removeExistingFilesWithName(
      deliveryToCustomerFolder,
      generatedSheet.getName()
    );
    generatedSheet.moveTo(deliveryToCustomerFolder);
    Shared.recordEvent(
      report,
      'Sheet moved',
      generatedSheet.getName(),
      deliveryToCustomerFolder.getUrl()
    );

    Logger.log(
      `Moved Sheet "${generatedSheet.getName()}" to: ${deliveryToCustomerFolder.getUrl()}`
    );

    Shared.removeExistingFilesWithName(originalFolder, csvFile.getName());
    csvFile.moveTo(originalFolder);
    Shared.recordEvent(report, 'CSV moved', csvFile.getName(), originalFolder.getUrl());

    Logger.log(`Moved CSV "${csvFile.getName()}" to: ${originalFolder.getUrl()}`);
  },

  moveSingleDeliveredDoc(doc, destRootFolder, sourceMatchCache, report) {
    const docName = doc.getName();
    const docId = doc.getId();
    const { base: baseFileName } = Shared.splitLocaleFromName(docName);

    Logger.log(`Processing Doc: ${docName}`);
    Logger.log(`Base filename: ${baseFileName}`);

    Shared.markVisited(report, `batch-error:${docId}`);
    Shared.markVisited(report, `no-source-match:${docId}`);
    Shared.markVisited(report, `missing-delivery:${docId}`);

    const sourceMatch = Organize.getSourceMatch(
      baseFileName,
      destRootFolder,
      sourceMatchCache,
      MimeType.GOOGLE_DOCS
    );

    if (!sourceMatch) {
      Shared.recordError(
        report,
        `No source Google Doc match for "${baseFileName}" (Doc: ${docName}).`,
        `no-source-match:${docId}`
      );
      return;
    }

    const projectFolder = sourceMatch.projectFolder;

    Logger.log(
      `Reference Doc found in Source folder: ${sourceMatch.sourceFolder.getUrl()}`
    );

    const deliveryFolder = Shared.findChildFolderByNameCaseInsensitive(
      projectFolder,
      'Delivery'
    );

    if (!deliveryFolder) {
      Shared.recordError(
        report,
        `Could not find Delivery folder under ${projectFolder.getUrl()} (Doc: ${docName}).`,
        `missing-delivery:${docId}`
      );
      return;
    }

    Shared.removeExistingFilesWithName(deliveryFolder, docName);
    doc.moveTo(deliveryFolder);
    Shared.recordEvent(report, 'Doc moved', docName, deliveryFolder.getUrl());

    Logger.log(`Moved Doc "${docName}" to: ${deliveryFolder.getUrl()}`);
  },

  getSourceMatch(
    baseFileName,
    destRootFolder,
    sourceMatchCache,
    mimeType
  ) {
    if (sourceMatchCache.has(baseFileName)) {
      return sourceMatchCache.get(baseFileName);
    }

    const match = Organize.searchSourceMatch(baseFileName, destRootFolder, mimeType);
    sourceMatchCache.set(baseFileName, match);
    return match;
  },

  searchSourceMatch(baseFileName, destRootFolder, mimeType) {
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
    const descendantCache = new Map();

    while (files.hasNext()) {
      const file = files.next();

      if (file.getName() !== baseFileName) {
        continue;
      }

      const parent = Shared.getFirstParent(file);

      if (!parent) {
        continue;
      }

      if (parent.getName().toLowerCase() !== 'source') {
        continue;
      }

      if (!Organize.isDescendantOf(parent, destRootFolder, descendantCache)) {
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
        `Found multiple files named "${baseFileName}". Using the first one.`
      );

      matches.forEach(m => {
        Logger.log(`Match: ${m.file.getName()} - ${m.file.getUrl()}`);
      });
    }

    const referenceFile = matches[0].file;
    const sourceFolder = matches[0].sourceFolder;
    const projectFolder = Shared.getFirstParent(sourceFolder);

    if (!projectFolder) {
      console.error(
        `Could not find parent folder above Source for "${baseFileName}".`
      );
      return null;
    }

    return {
      referenceFile,
      sourceFolder,
      projectFolder
    };
  },

  isDescendantOf(folder, ancestor, cache) {
    const ancestorId = ancestor.getId();
    const startId = folder.getId();

    if (cache && cache.has(startId)) {
      return cache.get(startId);
    }

    let current = folder;
    while (current) {
      if (current.getId() === ancestorId) {
        if (cache) cache.set(startId, true);
        return true;
      }
      const parents = current.getParents();
      current = parents.hasNext() ? parents.next() : null;
    }

    if (cache) cache.set(startId, false);
    return false;
  }
};
