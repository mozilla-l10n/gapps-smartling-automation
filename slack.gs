/*
Inbound Slack slash-command handler.

Exposes the pipeline to Slack: a user types a slash command (e.g.
`/lsp-intake`) in a channel and `runAll` (main.gs) is kicked off.

Flow:
  1. Slack POSTs the command to this Web App's `doPost`.
  2. `doPost` verifies the request really came from Slack, then schedules
     `slackTriggeredRunAll` to fire ~1s later and immediately returns an
     ephemeral ack. The ack is required because Slack abandons a slash command
     that doesn't get an HTTP 200 within 3 seconds, and `runAll` takes far
     longer than that.
  3. `slackTriggeredRunAll` runs asynchronously, cleans up the spent one-off
     trigger, and calls `runAll`. Each pipeline step posts its own Slack
     summary via Shared.runWithReport, so the real results arrive in the
     channel moments after the ack.

Security note — why a Verification Token and not Signing Secret:
  The robust way to authenticate Slack requests is HMAC over the raw body using
  the app's Signing Secret, but Slack sends that signature only in HTTP request
  HEADERS, and Apps Script Web Apps do not expose request headers in doPost(e)
  (Google confirmed in Sept 2023 they never will). So we fall back to Slack's
  legacy Verification Token, which arrives in the POST *body* (e.parameter.token)
  and is therefore readable. It is a static shared secret with no replay
  protection and Slack has deprecated it (no retirement date yet), so it is
  weaker than request signing. Combined with the unguessable /exec deployment
  URL it is the accepted pattern for Slack + Apps Script. If you ever need
  stronger guarantees, front this with a Cloud Function / small proxy that does
  real signature verification and forwards to the script.

Verification helpers live on the `SlackCommand` namespace so they stay out of
the Apps Script run/trigger picker. `doPost` and `slackTriggeredRunAll` must be
top-level: the first is the Web App entry point, the second is a trigger target.
*/

// Script Property holding the Slack app's "Verification Token" (Basic
// Information > App Credentials). Set it via Project Settings > Script
// Properties so it never lands in git. Requests are rejected if it is missing
// (fail closed).
const SLACK_VERIFICATION_TOKEN_PROPERTY = 'SLACK_VERIFICATION_TOKEN';

// Only this channel may trigger the pipeline. Use the channel *ID* (e.g.
// C0123456789), not the name: the ID is stable across renames and always
// present in the slash-command payload, whereas channel_name can change or be
// withheld. To find it: open the channel in Slack > channel name > "About" tab,
// the ID is at the bottom; or right-click the channel > "Copy link" and take
// the trailing C... segment. The constant below is the #l10n-notifications
// channel.
const SLACK_ALLOWED_CHANNEL_ID = 'REDACTED';

// Human-readable name used only in the wrong-channel rejection message.
const SLACK_ALLOWED_CHANNEL_NAME = 'l10n-notifications';

function doPost(e) {
  if (!SlackCommand.verifyRequest(e)) {
    return SlackCommand.reply('ephemeral', 'Unauthorized request.');
  }

  if (!SlackCommand.isAllowedChannel(e)) {
    return SlackCommand.reply(
      'ephemeral',
      `This command can only be run from #${SLACK_ALLOWED_CHANNEL_NAME}.`
    );
  }

  // Schedule the actual work; don't run it inline (3s Slack timeout).
  ScriptApp.newTrigger('slackTriggeredRunAll').timeBased().after(1000).create();

  const user = (e && e.parameter && e.parameter.user_name) || 'someone';
  Logger.log(`Slack command accepted from ${user}; scheduled runAll.`);

  return SlackCommand.reply(
    'in_channel',
    `:hourglass_flowing_sand: Started the translation pipeline (requested by ${user}). Results will post here shortly.`
  );
}

// Trigger target for the one-off trigger created in doPost. Deletes spent
// one-off triggers for itself (they are not auto-removed and count toward the
// project's 20-trigger limit), then runs the pipeline.
function slackTriggeredRunAll() {
  SlackCommand.deleteOwnTriggers();
  runAll();
}

const SlackCommand = {
  verifyRequest(e) {
    const expected = PropertiesService.getScriptProperties().getProperty(
      SLACK_VERIFICATION_TOKEN_PROPERTY
    );
    if (!expected) {
      console.error(
        `${SLACK_VERIFICATION_TOKEN_PROPERTY} is not set. Rejecting Slack request.`
      );
      return false;
    }

    const token = e && e.parameter && e.parameter.token;
    if (!token) {
      Logger.log('Slack request has no token. Rejecting.');
      return false;
    }

    return SlackCommand.constantTimeEquals(token, expected);
  },

  isAllowedChannel(e) {
    if (!SLACK_ALLOWED_CHANNEL_ID) {
      console.error(
        'SLACK_ALLOWED_CHANNEL_ID is not set. Rejecting Slack request.'
      );
      return false;
    }
    const channelId = e && e.parameter && e.parameter.channel_id;
    return channelId === SLACK_ALLOWED_CHANNEL_ID;
  },

  // Length-stable comparison to avoid leaking the token via early-exit timing.
  constantTimeEquals(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  },

  // Removes spent one-off triggers pointing at slackTriggeredRunAll. Leaves the
  // production recurring trigger (handler: runAll) untouched.
  deleteOwnTriggers() {
    ScriptApp.getProjectTriggers().forEach(trigger => {
      if (trigger.getHandlerFunction() === 'slackTriggeredRunAll') {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  },

  reply(responseType, text) {
    return ContentService.createTextOutput(
      JSON.stringify({ response_type: responseType, text })
    ).setMimeType(ContentService.MimeType.JSON);
  }
};
