/*
Shared helpers used by convert.gs, organize.gs, and incoming_gsheets.gs.

All callable helpers live on the `Shared` namespace object so they don't
appear in the Apps Script run/trigger picker. Call as `Shared.recordError(...)`,
`Shared.runWithReport(...)`, etc.

Run management:
- Shared.runWithReport: wraps an entry point with a script lock and a Slack
  summary.
- Shared.withScriptLock: prevents concurrent runs of an entry point.
- Shared.processBatch: iterates files of a given mimeType in a folder, calling
  a per-file function and recording any thrown error as a run report entry.

Name parsing:
- Shared.splitLocaleFromName: parses a CSV/Doc name into its no-extension form,
  its base (no locale suffix), and its locale.

Smartling template:
- Header constants (EN_COPY_HEADER, TARGET_LANGUAGE_HEADER, etc.) stay as
  top-level constants since they are not callable and don't clutter the picker.
- Shared.detectTemplate: strict typing of a header row into charLimit /
  standard / survey (with EN-column position), or null if unrecognized.

Drive helpers:
- Shared.findChildFolderByNameCaseInsensitive: locate a named child folder.
- Shared.getFirstParent: first parent folder of a file or folder.
- Shared.findFileInFolderByName: first file in a folder matching name (and
  optional mimeType).
- Shared.removeExistingFilesWithName: trash files in a folder matching name
  (and optional mimeType filter).
- Shared.applyMozillaAudienceIndicator: idempotently tag a file with the
  Mozilla audience Drive label (no-op if already set).
- Shared.getRequesterIdentity: best-effort identity lookup for the user
  who "requested" a file. Prefers the user behind the earliest revision
  (most reliable signal for "original author"), falling back to the first
  editor returned by Apps Script, then to the file owner. Returns
  { email, name, source, ownerEmail, ownerName } where source is
  'first-revision', 'editor', or 'owner', so the caller can detect and
  log when the picked identity differs from the owner. Returns null if
  no strategy yields a usable email.
- Shared.ensureFolderSharedAsContentManager: idempotently grant a user the
  Content Manager (fileOrganizer) role on a Shared Drive folder; upgrades
  the role if the user already has a lower one.

Reporting:
- Shared.createRunReport / recordEvent / recordError / sendSlackReport: per-run
  collection and Slack posting.
- Shared.markVisited + per-entry dedup keys persist notification state across
  runs in PropertiesService, so a stuck file doesn't re-fire its error every
  15 minutes. When the underlying issue clears, the next run posts a "Resolved"
  line and forgets the state.

If SLACK_WEBHOOK_URL (defined in config.gs) is missing or empty, Slack posting
is skipped silently.
*/

const SCRIPT_LOCK_TIMEOUT_MS = 7 * 1000;

// Cross-run dedup state for Slack notifications. Keyed by entry-point label,
// then by per-error/event dedup key. See Shared.filterReportAgainstState.
const NOTIFICATION_STATE_PROPERTY = 'notification_state_v1';
const NOTIFICATION_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const EN_COPY_HEADER = 'EN Copy';
const TARGET_LANGUAGE_HEADER = 'Target Language';
const TARGET_CHARACTER_LIMIT_HEADER = 'Target Character Limit';
const KEY_HEADER = 'Key';
const DEFAULT_TEXT_HEADER = 'Default Text';
const TRANSLATION_HEADER = 'Translation';

// MOZILLA_AUDIENCE_LABEL_ID, MOZILLA_AUDIENCE_FIELD_ID and
// MOZILLA_AUDIENCE_SPECIFIC_WORKGROUPS_CHOICE_ID are defined in config.gs.

const Shared = {
  runWithReport(label, fn) {
    const report = Shared.createRunReport();
    let runCompleted = false;

    try {
      Shared.withScriptLock(() => {
        fn(report);
        runCompleted = true;
      });
    } finally {
      if (runCompleted) {
        const state = Shared.loadNotificationState();
        const { filteredReport, resolved } = Shared.filterReportAgainstState(
          report,
          label,
          state
        );
        Shared.reconcileState(state, label, report);
        Shared.pruneExpiredState(state, NOTIFICATION_STATE_MAX_AGE_MS);
        Shared.saveNotificationState(state);
        Shared.sendSlackReport(filteredReport, label, resolved);
      } else {
        // Lock not acquired or fn threw before completion — don't mutate state.
        // Send whatever was collected, unfiltered, so partial failures are visible.
        Shared.sendSlackReport(report, label, []);
      }
    }
  },

  withScriptLock(fn) {
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
  },

  processBatch(folder, mimeType, report, perFileFn) {
    const files = [];
    const iter = folder.getFilesByType(mimeType);
    while (iter.hasNext()) {
      files.push(iter.next());
    }

    for (const file of files) {
      try {
        perFileFn(file, report);
      } catch (error) {
        Shared.recordError(
          report,
          `ERROR processing ${file.getName()}: ${error}`,
          `batch-error:${file.getId()}`
        );
      }
    }
  },

  // Parses names like "foo_bar_v2_fr.csv" into:
  //   { nameWithoutExtension: "foo_bar_v2_fr", base: "foo_bar_v2", locale: "fr" }
  // Strips a trailing .csv extension if present; falls back to base = name and
  // locale = "" if there is no "_xxx" suffix.
  splitLocaleFromName(fileName) {
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
  },

  createRunReport() {
    return { events: [], errors: [], visited: new Set() };
  },

  // `dedupKey`: opt-in stickiness. Events without a key are one-shot (the
  // common case — "Sheet created", "CSV moved") and post every time.
  recordEvent(report, kind, name, url, dedupKey) {
    report.events.push({ kind, name, url, dedupKey: dedupKey || null });
  },

  // `dedupKey`: errors default to hash-based dedup so even un-keyed sites
  // stop spamming. Pass a stable key (e.g. "formatting-error:<fileId>") when
  // you have one — message text can drift between runs without re-firing.
  recordError(report, message, dedupKey) {
    const key = dedupKey || `message-hash:${Shared.hashString(message)}`;
    report.errors.push({ message, dedupKey: key });
    console.error(message);
  },

  // Declare that this run looked at `dedupKey` — required for resolution
  // detection. Without it, a missing key could mean "fixed" or "not examined",
  // and we'd risk posting spurious "Resolved" lines.
  markVisited(report, dedupKey) {
    if (dedupKey) {
      report.visited.add(dedupKey);
    }
  },

  loadNotificationState() {
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
  },

  saveNotificationState(state) {
    try {
      PropertiesService.getScriptProperties().setProperty(
        NOTIFICATION_STATE_PROPERTY,
        JSON.stringify(state)
      );
    } catch (error) {
      console.error(`Failed to save notification state: ${error}`);
    }
  },

  filterReportAgainstState(report, label, state) {
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
  },

  reconcileState(state, label, report) {
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
  },

  pruneExpiredState(state, maxAgeMs) {
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
  },

  hashString(str) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5,
      String(str || '')
    );
    return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  },

  // Strict classifier for a header row. Returns one of:
  //   { type: 'charLimit', enCol, limitCol }
  //   { type: 'standard',  enCol }
  //   { type: 'survey',    enCol }
  //   null
  // charLimit is tested before standard because both have "EN Copy" but in
  // different columns.
  detectTemplate(headerRow) {
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
  },

  findChildFolderByNameCaseInsensitive(parentFolder, targetName) {
    const folders = parentFolder.getFolders();
    const normalizedTargetName = targetName.toLowerCase();

    while (folders.hasNext()) {
      const folder = folders.next();

      if (folder.getName().toLowerCase() === normalizedTargetName) {
        return folder;
      }
    }

    return null;
  },

  getFirstParent(fileOrFolder) {
    const parents = fileOrFolder.getParents();
    return parents.hasNext() ? parents.next() : null;
  },

  // Returns the first file in `folder` whose name equals `name`. If `mimeType`
  // is provided, only files of that type are considered.
  findFileInFolderByName(folder, name, mimeType) {
    const files = folder.getFilesByName(name);

    while (files.hasNext()) {
      const file = files.next();

      if (!mimeType || file.getMimeType() === mimeType) {
        return file;
      }
    }

    return null;
  },

  // Sets the Mozilla audience label on `fileId` if it isn't already set.
  // Existing manual values are preserved.
  applyMozillaAudienceIndicator(fileId) {
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
  },

  // Best-effort identity lookup for the "requester" of a file. Order:
  //   1. lastModifyingUser on the earliest revision (closest signal to
  //      "who created this request"). Apps Script's getEditors() returns
  //      editors in an unstable order unrelated to revision history, so we
  //      consult Drive.Revisions.list instead.
  //   2. First editor with a usable email (fallback if the revisions API
  //      returns nothing — e.g. for non-native files).
  //   3. File owner (last-resort fallback; on Shared Drives owners are
  //      frequently null).
  // Returns { email, name, source, ownerEmail, ownerName } or null if no
  // strategy yields a usable email. `name` may be the empty string.
  getRequesterIdentity(file) {
    const owner = file.getOwner();
    const ownerEmail = owner ? owner.getEmail() : '';
    const ownerName = owner ? (owner.getName() || '') : '';

    try {
      const response = Drive.Revisions.list(file.getId(), {
        fields:
          'revisions(id,modifiedTime,lastModifyingUser(emailAddress,displayName))'
      });
      const revisions = response.revisions || [];

      // Defensive: scan for the chronological minimum rather than trusting
      // list order. Drive typically returns oldest-first, but we don't rely
      // on that.
      let earliest = null;
      for (const r of revisions) {
        if (!earliest || new Date(r.modifiedTime) < new Date(earliest.modifiedTime)) {
          earliest = r;
        }
      }

      const user = earliest ? earliest.lastModifyingUser : null;
      if (user && user.emailAddress) {
        return {
          email: user.emailAddress,
          name: user.displayName || '',
          source: 'first-revision',
          ownerEmail,
          ownerName
        };
      }
    } catch (error) {
      Logger.log(`Revisions lookup failed for "${file.getName()}": ${error}`);
    }

    for (const editor of file.getEditors()) {
      const email = editor.getEmail();
      if (email) {
        return {
          email,
          name: editor.getName() || '',
          source: 'editor',
          ownerEmail,
          ownerName
        };
      }
    }

    if (ownerEmail) {
      return {
        email: ownerEmail,
        name: ownerName,
        source: 'owner',
        ownerEmail,
        ownerName
      };
    }

    return null;
  },

  // Idempotently ensures `email` has Content Manager (fileOrganizer) rights on
  // `folder`. Returns { added, upgraded }: `added` when a brand-new permission
  // was created, `upgraded` when an existing lower-tier permission was raised
  // to fileOrganizer. Both false means the principal already had sufficient
  // direct rights.
  //
  // We match both 'user' and 'group' permission types because Drive will
  // store the principal as a group when the email resolves to a Google Group,
  // even if we send the create request with type 'user'. Without that, the
  // next run wouldn't find the permission and would re-create it, producing
  // a duplicate "Folder shared" event.
  //
  // Inherited permissions are ignored — a permission inherited from a parent
  // folder would not survive moving the folder to another Shared Drive, so we
  // still want a direct permission on this folder.
  //
  // `fileOrganizer` is shared-drive-only — calling this on a My Drive folder
  // will throw via the Drive API.
  ensureFolderSharedAsContentManager(folder, email) {
    const folderId = folder.getId();
    const normalizedEmail = String(email || '').trim().toLowerCase();

    const listed = Drive.Permissions.list(folderId, {
      supportsAllDrives: true,
      fields:
        'permissions(id,type,role,emailAddress,' +
        'permissionDetails(inherited,inheritedFrom,permissionType,role))'
    });

    const existing = (listed.permissions || []).find(p => {
      if (p.type !== 'user' && p.type !== 'group') return false;
      if (String(p.emailAddress || '').trim().toLowerCase() !== normalizedEmail) {
        return false;
      }
      const details = p.permissionDetails;
      if (Array.isArray(details) && details.some(d => d.inherited)) {
        return false;
      }
      return true;
    });

    if (existing) {
      if (existing.role === 'fileOrganizer' || existing.role === 'organizer') {
        return { added: false, upgraded: false };
      }

      Drive.Permissions.update(
        { role: 'fileOrganizer' },
        folderId,
        existing.id,
        { supportsAllDrives: true }
      );
      return { added: false, upgraded: true };
    }

    const created = Drive.Permissions.create(
      {
        type: 'user',
        role: 'fileOrganizer',
        emailAddress: email
      },
      folderId,
      {
        supportsAllDrives: true,
        sendNotificationEmail: false,
        fields: 'id,type,role,emailAddress'
      }
    );
    Logger.log(
      `Created permission on "${folder.getName()}": ` +
        `id=${created.id}, type=${created.type}, role=${created.role}, ` +
        `email=${created.emailAddress}`
    );
    return { added: true, upgraded: false };
  },

  // Trashes every file in `folder` whose name equals `name`. If `mimeType` is
  // provided, only matching files are trashed (others with the same name are
  // left untouched).
  removeExistingFilesWithName(folder, name, mimeType) {
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
  },

  sendSlackReport(report, runLabel, resolved) {
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
};
