/*
Shared helpers used by organize.gs and convert.gs:
- runWithReport: wraps an entry point with a script lock and a Slack summary.
- withScriptLock: prevents concurrent runs of an entry point.
- processBatch: iterates files of a given mimeType in a folder, calling a
  per-file function and recording any thrown error as a run report entry.
- splitLocaleFromName: parses a CSV/Doc name into its no-extension form, its
  base (no locale suffix), and its locale.
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
