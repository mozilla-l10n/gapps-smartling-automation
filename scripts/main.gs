/*
Single scheduled entry point. Calls the three pipeline steps in order, each
isolated in a try/catch so one failure doesn't skip the others.

Order matches the natural data flow:
  1. processIncomingSheets - requester GSheets -> CSVs in Source subfolders.
  2. processCsvFiles       - CSVs in the Translation folder -> formatted Sheets.
  3. moveAllDelivered      - completed CSV/Sheet pairs -> Delivery folders.

Each step still acquires its own script lock and posts its own Slack summary
via Shared.runWithReport (utils.gs). Manual invocation of the individual
entry points (processIncomingSheets, processCsvFiles, moveAllDelivered)
continues to work for ad-hoc runs or debugging.

To deploy: point a single time-based trigger at `runAll` and remove the
three per-step triggers.
*/

function runAll() {
  const steps = [
    { name: 'processIncomingSheets', fn: processIncomingSheets },
    { name: 'processCsvFiles', fn: processCsvFiles },
    { name: 'moveAllDelivered', fn: moveAllDelivered }
  ];

  for (const step of steps) {
    Logger.log(`runAll: starting ${step.name}`);
    try {
      step.fn();
    } catch (error) {
      console.error(`runAll: ${step.name} threw: ${error}`);
    }
  }
}
