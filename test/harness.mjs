// Test harness for the Apps Script source.
//
// The `.gs` files use global-scope namespace objects (Shared, Convert, ...) and
// never export anything, so they can't be imported directly. This shim reads the
// tracked `.gs` files, concatenates them into one script (mirroring Apps Script's
// single shared global scope), evaluates that in a node:vm context seeded with
// light stubs, and re-exports the namespace objects for the test files.
//
// No `.gs` source is modified. Only pure-logic functions are exercised; nothing
// loaded here calls a Google service at load time, so the stub set stays tiny.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// Order matters: cross-file constants (e.g. EN_COPY_HEADER in utils.gs, used by
// convert.gs) must be declared before the files that reference them share scope.
// config.dist.gs stands in for the gitignored config.gs so the config constants
// are declared (pure functions never read them).
const FILES = [
  'config.dist.gs',
  'utils.gs',
  'convert.gs',
  'organize.gs',
  'incoming_gsheets.gs',
  'slack.gs',
  'main.gs'
];

const source = FILES.map(name =>
  readFileSync(join(scriptsDir, name), 'utf8')
).join('\n\n');

// Minimal Google Apps Script global stubs. Extend only as new pure-logic targets
// require them (currently just Logger, used by Convert.cleanTargetColumns).
const sandbox = {
  console,
  Logger: { log() {} }
};

vm.createContext(sandbox);
vm.runInContext(
  source +
    '\n;this.__ns = { Shared, Convert, Organize, Incoming, SlackCommand };',
  sandbox,
  { filename: 'gas-bundle.js' }
);

export const { Shared, Convert, Organize, Incoming, SlackCommand } =
  sandbox.__ns;
