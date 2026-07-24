// Configuration template. Copy this file to config.gs (which is gitignored)
// and fill in the values for your deployment. Apps Script shares one global
// scope across all .gs files, so these constants are visible everywhere.

// Smartling shared drive, Translation folder. Drive folder ID (the trailing
// segment of the folder URL, .../folders/<ID>).
const SOURCE_FOLDER_ID = '';

// L10n Service Requests folder. Drive folder ID.
const DEST_FOLDER_ID = '';

// Incoming requests folder (requesters drop GSheets in subfolders here).
// Drive folder ID.
const INCOMING_FOLDER_ID = '';

// Slack webhook used to post run summaries. Leave empty to disable Slack posting.
const SLACK_WEBHOOK_URL = '';

// Only this channel may trigger the pipeline. Use the channel *ID* (e.g.
// C0123456789), not the name: the ID is stable across renames and always
// present in the slash-command payload, whereas channel_name can change or be
// withheld. To find it: open the channel in Slack > channel name > "About" tab,
// the ID is at the bottom; or right-click the channel > "Copy link" and take
// the trailing C... segment.
const SLACK_ALLOWED_CHANNEL_ID = '';

// Human-readable name used only in the wrong-channel rejection message.
const SLACK_ALLOWED_CHANNEL_NAME = '';

// "Specific Workgroups and Individuals" label for Mozilla Audience. Used by
// convert.gs and incoming_gsheets.gs to tag files as Mozilla-audience so
// downstream tooling can identify them. These are Drive label / field /
// choice IDs from the organization's Drive label configuration.
const MOZILLA_AUDIENCE_LABEL_ID = '';
const MOZILLA_AUDIENCE_FIELD_ID = '';
const MOZILLA_AUDIENCE_SPECIFIC_WORKGROUPS_CHOICE_ID = '';
