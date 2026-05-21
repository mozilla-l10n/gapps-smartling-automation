/*
Shared helpers used by convert.gs, organize.gs, and gsheet_to_csv.gs.

Run management:
- runWithReport: wraps an entry point with a script lock and a Slack summary.
- withScriptLock: prevents concurrent runs of an entry point.
- processBatch: iterates files of a given mimeType in a folder, calling a
  per-file function and recording any thrown error as a run report entry.

Name parsing:
- splitLocaleFromName: parses a CSV/Doc name into its no-extension form, its
  base (no locale suffix), and its locale.

Smartling template:
- Header constants (EN_COPY_HEADER, TARGET_LANGUAGE_HEADER, etc.).
- detectTemplate: strict typing of a header row into charLimit / standard /
  survey (with EN-column position), or null if unrecognized.

Drive helpers:
- findChildFolderByNameCaseInsensitive: locate a named child folder.
- getFirstParent: first parent folder of a file or folder.
- findFileInFolderByName: first file in a folder matching name (and optional
  mimeType).
- removeExistingFilesWithName: trash files in a folder matching name (and
  optional mimeType filter).
- applyMozillaAudienceIndicator: idempotently tag a file with the Mozilla
  audience Drive label (no-op if already set).

Reporting:
- createRunReport / recordEvent / recordError / sendSlackReport: per-run
  collection and Slack posting.

If SLACK_WEBHOOK_URL (defined in config.gs) is missing or empty, Slack posting
is skipped silently.
*/

const SCRIPT_LOCK_TIMEOUT_MS = 30 * 1000;

function runWithReport(label, fn) {
  const report = createRunReport();

  try {
    withScriptLock(() => fn(report));
  } finally {
    sendSlackReport(report, label);
  }
}

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS)) {
    Logger.log('Another run is in progress. Exiting.');
    return;
  }

  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

function processBatch(folder, mimeType, report, perFileFn) {
  const files = [];
  const iter = folder.getFilesByType(mimeType);
  while (iter.hasNext()) {
    files.push(iter.next());
  }

  for (const file of files) {
    try {
      perFileFn(file, report);
    } catch (error) {
      recordError(report, `ERROR processing ${file.getName()}: ${error}`);
    }
  }
}

// Parses names like "foo_bar_v2_fr.csv" into:
//   { nameWithoutExtension: "foo_bar_v2_fr", base: "foo_bar_v2", locale: "fr" }
// Strips a trailing .csv extension if present; falls back to base = name and
// locale = "" if there is no "_xxx" suffix.
function splitLocaleFromName(fileName) {
  const nameWithoutExtension = fileName.replace(/\.csv$/i, '');
  const match = nameWithoutExtension.match(/_([^_]+)$/);

  if (!match) {
    return {
      nameWithoutExtension,
      base: nameWithoutExtension,
      locale: ''
    };
  }

  return {
    nameWithoutExtension,
    base: nameWithoutExtension.slice(0, match.index),
    locale: match[1].trim()
  };
}

function createRunReport() {
  return { events: [], errors: [] };
}

function recordEvent(report, kind, name, url) {
  report.events.push({ kind, name, url });
}

function recordError(report, message) {
  report.errors.push(message);
  console.error(message);
}

const EN_COPY_HEADER = 'EN Copy';
const TARGET_LANGUAGE_HEADER = 'Target Language';
const TARGET_CHARACTER_LIMIT_HEADER = 'Target Character Limit';
const KEY_HEADER = 'Key';
const DEFAULT_TEXT_HEADER = 'Default Text';
const TRANSLATION_HEADER = 'Translation';

// Strict classifier for a header row. Returns one of:
//   { type: 'charLimit', enCol, limitCol }
//   { type: 'standard',  enCol }
//   { type: 'survey',    enCol }
//   null
// charLimit is tested before standard because both have "EN Copy" but in
// different columns.
function detectTemplate(headerRow) {
  if (!headerRow || headerRow.length === 0) {
    return null;
  }

  if (
    headerRow.length >= 4 &&
    headerRow[1] === TARGET_CHARACTER_LIMIT_HEADER &&
    headerRow[3] === EN_COPY_HEADER
  ) {
    return { type: 'charLimit', enCol: 4, limitCol: 2 };
  }

  if (headerRow.length >= 2 && headerRow[1] === EN_COPY_HEADER) {
    return { type: 'standard', enCol: 2 };
  }

  if (
    headerRow.length === 3 &&
    headerRow[0] === KEY_HEADER &&
    headerRow[1] === DEFAULT_TEXT_HEADER
  ) {
    return { type: 'survey', enCol: 2 };
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

// Returns the first file in `folder` whose name equals `name`. If `mimeType`
// is provided, only files of that type are considered.
function findFileInFolderByName(folder, name, mimeType) {
  const files = folder.getFilesByName(name);

  while (files.hasNext()) {
    const file = files.next();

    if (!mimeType || file.getMimeType() === mimeType) {
      return file;
    }
  }

  return null;
}

// "Specific Workgroups and Individuals" label for Mozilla Audience. Used by
// convert.gs and incoming_gsheets.gs to tag files as Mozilla-audience so
// downstream tooling can identify them.
const MOZILLA_AUDIENCE_LABEL_ID = 'REDACTED';
const MOZILLA_AUDIENCE_FIELD_ID = 'REDACTED';
const MOZILLA_AUDIENCE_SPECIFIC_WORKGROUPS_CHOICE_ID = 'REDACTED';

// Sets the Mozilla audience label on `fileId` if it isn't already set.
// Existing manual values are preserved.
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

// Trashes every file in `folder` whose name equals `name`. If `mimeType` is
// provided, only matching files are trashed (others with the same name are
// left untouched).
function removeExistingFilesWithName(folder, name, mimeType) {
  const files = folder.getFilesByName(name);

  while (files.hasNext()) {
    const file = files.next();

    if (mimeType && file.getMimeType() !== mimeType) {
      continue;
    }

    console.warn(
      `Removing existing file "${file.getName()}" in ${folder.getUrl()}: ${file.getUrl()}`
    );
    file.setTrashed(true);
  }
}

function sendSlackReport(report, runLabel) {
  if (typeof SLACK_WEBHOOK_URL === 'undefined' || !SLACK_WEBHOOK_URL) {
    Logger.log('SLACK_WEBHOOK_URL is not configured. Skipping Slack notification.');
    return;
  }

  if (report.events.length === 0 && report.errors.length === 0) {
    return;
  }

  const lines = [];

  lines.push(
    `*${runLabel}*: ${report.events.length} event(s), ${report.errors.length} error(s)`
  );

  if (report.events.length > 0) {
    lines.push('', '*Events:*');
    report.events.forEach(e => {
      lines.push(`• [${e.kind}] ${e.name} → ${e.url}`);
    });
  }

  if (report.errors.length > 0) {
    lines.push('', '*Errors:*');
    report.errors.forEach(e => {
      lines.push(`• ${e}`);
    });
  }

  try {
    const response = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: lines.join('\n') }),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() >= 400) {
      console.error(
        `Slack returned ${response.getResponseCode()}: ${response.getContentText()}`
      );
    }
  } catch (error) {
    console.error(`Failed to send Slack notification: ${error}`);
  }
}
