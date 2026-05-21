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
- markVisited + per-entry dedup keys persist notification state across runs
  in PropertiesService, so a stuck file doesn't re-fire its error every 15
  minutes. When the underlying issue clears, the next run posts a "Resolved"
  line and forgets the state.

If SLACK_WEBHOOK_URL (defined in config.gs) is missing or empty, Slack posting
is skipped silently.
*/

const SCRIPT_LOCK_TIMEOUT_MS = 7 * 1000;

// Cross-run dedup state for Slack notifications. Keyed by entry-point label,
// then by per-error/event dedup key. See filterReportAgainstState.
const NOTIFICATION_STATE_PROPERTY = 'notification_state_v1';
const NOTIFICATION_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function runWithReport(label, fn) {
  const report = createRunReport();
  let runCompleted = false;

  try {
    withScriptLock(() => {
      fn(report);
      runCompleted = true;
    });
  } finally {
    if (runCompleted) {
      const state = loadNotificationState();
      const { filteredReport, resolved } = filterReportAgainstState(
        report,
        label,
        state
      );
      reconcileState(state, label, report);
      pruneExpiredState(state, NOTIFICATION_STATE_MAX_AGE_MS);
      saveNotificationState(state);
      sendSlackReport(filteredReport, label, resolved);
    } else {
      // Lock not acquired or fn threw before completion — don't mutate state.
      // Send whatever was collected, unfiltered, so partial failures are visible.
      sendSlackReport(report, label, []);
    }
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
      recordError(
        report,
        `ERROR processing ${file.getName()}: ${error}`,
        `batch-error:${file.getId()}`
      );
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
  return { events: [], errors: [], visited: new Set() };
}

// `dedupKey`: opt-in stickiness. Events without a key are one-shot (the
// common case — "Sheet created", "CSV moved") and post every time.
function recordEvent(report, kind, name, url, dedupKey) {
  report.events.push({ kind, name, url, dedupKey: dedupKey || null });
}

// `dedupKey`: errors default to hash-based dedup so even un-keyed sites
// stop spamming. Pass a stable key (e.g. "formatting-error:<fileId>") when
// you have one — message text can drift between runs without re-firing.
function recordError(report, message, dedupKey) {
  const key = dedupKey || `message-hash:${hashString(message)}`;
  report.errors.push({ message, dedupKey: key });
  console.error(message);
}

// Declare that this run looked at `dedupKey` — required for resolution
// detection. Without it, a missing key could mean "fixed" or "not examined",
// and we'd risk posting spurious "Resolved" lines.
function markVisited(report, dedupKey) {
  if (dedupKey) {
    report.visited.add(dedupKey);
  }
}

function loadNotificationState() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(
      NOTIFICATION_STATE_PROPERTY
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error(`Failed to parse notification state; resetting: ${error}`);
    return {};
  }
}

function saveNotificationState(state) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      NOTIFICATION_STATE_PROPERTY,
      JSON.stringify(state)
    );
  } catch (error) {
    console.error(`Failed to save notification state: ${error}`);
  }
}

function filterReportAgainstState(report, label, state) {
  const labelState = state[label] || {};

  const currentKeys = new Set();
  const filteredErrors = [];
  const filteredEvents = [];

  for (const error of report.errors) {
    currentKeys.add(error.dedupKey);
    if (!labelState[error.dedupKey]) {
      filteredErrors.push(error);
    }
  }

  for (const event of report.events) {
    if (!event.dedupKey) {
      filteredEvents.push(event);
      continue;
    }
    currentKeys.add(event.dedupKey);
    if (!labelState[event.dedupKey]) {
      filteredEvents.push(event);
    }
  }

  // Resolution: a stored key is "resolved" only if this run examined the
  // thing it refers to (visited) and didn't re-record it. Otherwise the
  // file might simply not have been processed this run.
  const resolved = [];
  for (const key of Object.keys(labelState)) {
    if (!currentKeys.has(key) && report.visited.has(key)) {
      const entry = labelState[key];
      resolved.push({ kind: entry.kind, message: entry.message });
    }
  }

  return {
    filteredReport: { events: filteredEvents, errors: filteredErrors },
    resolved
  };
}

function reconcileState(state, label, report) {
  if (!state[label]) {
    state[label] = {};
  }
  const labelState = state[label];
  const now = new Date().toISOString();

  const currentKeys = new Set();

  for (const error of report.errors) {
    currentKeys.add(error.dedupKey);
    const existing = labelState[error.dedupKey];
    labelState[error.dedupKey] = {
      kind: 'error',
      message: error.message,
      firstNotifiedAt: existing ? existing.firstNotifiedAt : now,
      lastSeenAt: now
    };
  }

  for (const event of report.events) {
    if (!event.dedupKey) continue;
    currentKeys.add(event.dedupKey);
    const existing = labelState[event.dedupKey];
    labelState[event.dedupKey] = {
      kind: event.kind,
      message: `${event.kind}: ${event.name}`,
      firstNotifiedAt: existing ? existing.firstNotifiedAt : now,
      lastSeenAt: now
    };
  }

  for (const key of Object.keys(labelState)) {
    if (!currentKeys.has(key) && report.visited.has(key)) {
      delete labelState[key];
    }
  }
}

function pruneExpiredState(state, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;

  for (const label of Object.keys(state)) {
    const labelState = state[label];
    for (const key of Object.keys(labelState)) {
      const entry = labelState[key];
      if (new Date(entry.lastSeenAt).getTime() < cutoff) {
        delete labelState[key];
      }
    }
    if (Object.keys(labelState).length === 0) {
      delete state[label];
    }
  }
}

function hashString(str) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    String(str || '')
  );
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
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

function sendSlackReport(report, runLabel, resolved) {
  if (typeof SLACK_WEBHOOK_URL === 'undefined' || !SLACK_WEBHOOK_URL) {
    Logger.log('SLACK_WEBHOOK_URL is not configured. Skipping Slack notification.');
    return;
  }

  const resolvedList = resolved || [];

  if (
    report.events.length === 0 &&
    report.errors.length === 0 &&
    resolvedList.length === 0
  ) {
    return;
  }

  const lines = [];

  const headerParts = [
    `${report.events.length} event(s)`,
    `${report.errors.length} error(s)`
  ];
  if (resolvedList.length > 0) {
    headerParts.push(`${resolvedList.length} resolved`);
  }
  lines.push(`*${runLabel}*: ${headerParts.join(', ')}`);

  if (report.events.length > 0) {
    lines.push('', '*Events:*');
    report.events.forEach(e => {
      lines.push(`• [${e.kind}] ${e.name} → ${e.url}`);
    });
  }

  if (report.errors.length > 0) {
    lines.push('', '*Errors:*');
    report.errors.forEach(e => {
      lines.push(`• ${e.message}`);
    });
  }

  if (resolvedList.length > 0) {
    lines.push('', '*Resolved:*');
    resolvedList.forEach(r => {
      lines.push(`• ✓ [${r.kind}] ${r.message}`);
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
