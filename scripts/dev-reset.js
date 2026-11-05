#!/usr/bin/env node
'use strict';

// FIXED disposable development database reset (P6-DEVEX-A).
//
// `npm run dev:reset` destroys and recreates ONLY the code-owned disposable
// development identity (scripts/dev-environment.js): host 127.0.0.1,
// database ticket_system_dev, schema ticket_system. It accepts NO target
// argument, NO `--database`, NO URL override, and NO mode flag — that is the
// safety property: the destructive authority is bounded to the fixed
// disposable identity, so the command is safe for an agent to invoke.
//
// Every identity-bearing step (compose ownership proof, destruction, creation,
// migration) is owned INTERNALLY by the verified development lifecycle
// (scripts/dev-database.js resetDisposableDevelopmentDatabase): construct
// fixed target → collision guard → prove bundled infrastructure → drop ONLY
// the development database → recreate it → migrate it under the explicit
// code-declared disposable authority only after that proof → report. No
// caller input can redirect the identity, and no store is ever handed back.
// Never touch the operational DATABASE_URL target.

const { resetDisposableDevelopmentDatabase } = require('./dev-database');
const { safeErrorMessage } = require('./dev-environment');
const { postgresHelp } = require('./dev-doctor');

// Only the logger seam is accepted here (non-identity, non-authority): every
// proof mechanism (real compose file/runtime/process-launch/verification/
// client) and the fixed identity are owned internally by the verified
// lifecycle, which is invoked with NO arguments at all.
async function runReset({ output = console } = {}) {
  // The fixed target, collision guard, bundled-infrastructure proof,
  // destruction, creation, and disposable migration are all owned by the
  // verified lifecycle; this CLI surface accepts NO identity and NO proof
  // mechanics — the lifecycle call takes no arguments.
  const result = await resetDisposableDevelopmentDatabase();
  output.log(`Disposable development database ${result.devTarget.database} recreated and migrated ` +
    (result.appliedVersions.length ? `to the source head: ${result.appliedVersions.join(', ')}` : '(already current)') + '.');
  output.log('Development reset complete. `npm run dev` re-provisions the initial admin/agent through `npm run dev:setup` when absent.');
  return { devTarget: result.devTarget, created: result.created === true };
}

function printHelp() {
  console.log(
    'Usage: pnpm dev:reset\n\n' +
    'Destroys and recreates ONLY the fixed repository-owned disposable development database\n' +
    '(ticket_system_dev; scripts/dev-environment.js), then migrates it to the canonical source head\n' +
    'under the code-declared disposable development authority. No arguments, no URL override, and\n' +
    'no operational target are accepted; the operational DATABASE_URL target is never touched.\n' +
    'Rerun `pnpm dev:setup` afterwards to recreate the initial admin and agent.'
  );
}

async function main(argv = process.argv) {
  if (argv.includes('--help')) {
    printHelp();
    return;
  }
  if (argv.length > 2) throw new Error('dev:reset does not accept arguments (the disposable target is code-owned)');
  await runReset();
}

module.exports = { printHelp, runReset, main: main };

if (require.main === module) {
  main().catch(error => {
    console.error('Development reset failed: ' + safeErrorMessage(error));
    if (/A trusted system Docker Compose installation is required/.test(String(error && error.message))) {
      console.error('Install system Docker Compose (/usr/bin, /bin, or /usr/local/bin); the bundled development PostgreSQL infrastructure that owns the disposable target must be startable first.');
    } else if (/Development service port cannot be remapped/.test(String(error && error.message))) {
      console.error('The configured operational target shares the bundled local PostgreSQL service: leave TICKET_SYSTEM_POSTGRES_PORT unset or set it exactly to the operational DATABASE_URL port.');
    } else if (/cannot complete a host-side PostgreSQL query|Development database/.test(String(error && error.message))) {
      console.error(postgresHelp());
    }
    process.exit(1);
  });
}
