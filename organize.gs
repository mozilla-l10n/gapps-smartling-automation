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
2. Look up BASE_FILENAME via the Advanced Drive Service (Drive.Files.list with
   all-drives support, since DriveApp.searchFiles does not reliably return
   Shared Drive items), filtered to Google Sheets whose parent folder is named
   "Source" and lives somewhere under DEST_FOLDER_ID. An exact name match is
   tried first; if none is found, a normalized-key fallback (case-insensitive,
   non-alphanumeric runs collapsed to "_") catches Smartling's filename
   sanitization (e.g. "CC58000: Foo" delivered as "CC58000_Foo") and logs a
   warning. Results are memoized in-memory per run so multiple locales of the
   same base name don't re-query.
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

    // Fast path: exact server-side name match. This is the common case when
    // the delivered filename equals the Source reference name byte-for-byte.
    const escapedName = baseFileName
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");

    const exactQuery =
      `name = '${escapedName}' and ` +
      `mimeType = '${mimeType}' and ` +
      `trashed = false`;

    let matches = Organize.collectSourceCandidates(
      exactQuery,
      destRootFolder,
      name => name === baseFileName
    );

    // Fallback: Smartling sanitizes punctuation in delivered filenames (e.g. a
    // request named "CC58000: Foo" comes back as "CC58000_Foo"), so the exact
    // name no longer matches the Source reference and re-running never helps.
    // Retry with a normalized key (case-insensitive, every run of
    // non-alphanumeric characters collapsed to "_"). Candidates are gathered
    // with a `name contains` clause per alphanumeric token to keep the query
    // bounded, then confirmed by exact normalized-key equality. We still warn
    // so the name drift stays visible.
    if (matches.length === 0) {
      const targetKey = Organize.normalizeNameKey(baseFileName);
      const containsClauses = baseFileName
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .map(
          token =>
            `name contains '${token
              .replace(/\\/g, '\\\\')
              .replace(/'/g, "\\'")}'`
        )
        .join(' and ');

      const fuzzyQuery =
        `mimeType = '${mimeType}' and trashed = false` +
        (containsClauses ? ` and ${containsClauses}` : '');

      matches = Organize.collectSourceCandidates(
        fuzzyQuery,
        destRootFolder,
        name => Organize.normalizeNameKey(name) === targetKey
      );

      if (matches.length > 0) {
        console.warn(
          `Matched "${baseFileName}" to Source file "${matches[0].file.getName()}" ` +
            `only after normalizing punctuation (likely Smartling filename sanitization). ` +
            `Rename so the names match exactly to silence this warning.`
        );
      }
    }

    if (matches.length === 0) {
      console.error(
        `Could not find file named "${baseFileName}" (mimeType: ${mimeType}) in any Source folder under destination root.`
      );
      return null;
    }

    if (matches.length > 1) {
      console.warn(
        `Found multiple files matching "${baseFileName}". Using the first one.`
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

  // Runs a Drive query and returns the candidates whose name passes
  // `nameMatches` and that live directly inside a folder named "Source"
  // somewhere under `destRootFolder`.
  //
  // Uses the Advanced Drive Service rather than DriveApp.searchFiles: the
  // latter does not reliably return Shared Drive items, so a stable file is
  // intermittently missed and then found on a later run. The all-drives flags
  // below make the query consistent across Shared Drives. `parents` comes back
  // inline, so the parent lookup no longer needs a getParents() call.
  collectSourceCandidates(query, destRootFolder, nameMatches) {
    const matches = [];
    const descendantCache = new Map();
    let pageToken = null;

    do {
      const response = Drive.Files.list({
        q: query,
        corpora: 'allDrives',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: 'nextPageToken, files(id, name, parents)',
        pageSize: 100,
        pageToken: pageToken
      });

      for (const file of response.files || []) {
        if (!nameMatches(file.name)) {
          continue;
        }

        const parentId = (file.parents || [])[0];

        if (!parentId) {
          continue;
        }

        const parent = DriveApp.getFolderById(parentId);

        if (parent.getName().toLowerCase() !== 'source') {
          continue;
        }

        if (!Organize.isDescendantOf(parent, destRootFolder, descendantCache)) {
          continue;
        }

        matches.push({
          file: DriveApp.getFileById(file.id),
          sourceFolder: parent
        });
      }

      pageToken = response.nextPageToken;
    } while (pageToken);

    return matches;
  },

  // Normalizes a filename for tolerant comparison: lowercased, with every run
  // of non-alphanumeric characters collapsed to a single "_" and leading or
  // trailing "_" trimmed. Makes "CC58000: VPN New tab Promo" and the delivered
  // "CC58000_VPN New tab Promo" compare equal.
  normalizeNameKey(name) {
    return String(name)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '');
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
