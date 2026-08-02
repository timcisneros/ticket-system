#!/usr/bin/env node
'use strict';
// Operator-driven workspace recovery — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, preserved from the JSON-era original. This suite covers the
// operator recovery API (`/api/operations/:id/recovery-preview` and `/recover`),
// not run resume. Seven guarantees:
//
//   1. preview reports truthfully whether recovery can proceed
//   2. the proposed inverse action is truthful — deletePath for a writeFile,
//      renamePath with source/destination swapped for a renamePath
//   3. an interruption between the external effect and its completion evidence is
//      surfaced (HTTP 400), and the effect is visible as already applied
//   4. retrying that recovery RECONCILES the prepared effect instead of repeating
//      it, and links to the original operation
//   5. repeating a completed recovery is idempotent and returns the original receipt
//   6. workspace.recovery_prepared and workspace.recovery_completed are durable
//   7. diverged workspace state blocks recovery, and deletePath is unrecoverable
//
// Repaired, not rewritten. The provider stub (a NODE_OPTIONS `global.fetch`
// preload) is storage-independent and preserved. Seeding, operation receipts,
// logs, and events now come from the PostgreSQL store.
//
// TEST_INTERRUPT_AFTER_OPERATOR_RECOVERY_EFFECT drives guarantee 3; it is a
// test-only hook already present in the runtime and is not a production flag.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const WRITE_TEST_FILE = `recovery-write-${STAMP}.txt`;
const RENAME_SOURCE_FILE = `recovery-rename-src-${STAMP}.txt`;
const RENAME_DEST_FILE = `recovery-rename-dst-${STAMP}.txt`;
const DELETE_TEST_FILE = `recovery-delete-${STAMP}.txt`;

const assert = createAsserter();

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `recovery-regression-openai-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-recovery-request']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  await new Promise(resolve => setTimeout(resolve, 50));

  // Match the current ticket objective exactly. Earlier recovery cases leave
  // filenames in workspace context that share the recovery-* prefix, so loose
  // substring matching would select the wrong plan.
  if (combined.includes('recovery-write ${STAMP}')) {
    return okResponse({
      message: 'Creating test file for recovery.',
      actions: [{ operation: 'writeFile', args: { path: '${WRITE_TEST_FILE}', content: 'recovery-write-content' } }],
      complete: true
    });
  }

  if (combined.includes('recovery-rename ${STAMP}')) {
    return okResponse({
      message: 'Creating and renaming test file for recovery.',
      actions: [
        { operation: 'writeFile', args: { path: '${RENAME_SOURCE_FILE}', content: 'recovery-rename-content' } },
        { operation: 'renamePath', args: { path: '${RENAME_SOURCE_FILE}', nextPath: '${RENAME_DEST_FILE}' } }
      ],
      complete: true
    });
  }

  if (combined.includes('recovery-delete ${STAMP}')) {
    return okResponse({
      message: 'Deleting test file for recovery.',
      actions: [{ operation: 'deletePath', args: { path: '${DELETE_TEST_FILE}' } }],
      complete: true
    });
  }

  return okResponse({ message: 'recovery fallback complete', actions: [], complete: true });
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFakeOpenAIPreload();
  try {
    await withHarness('recovery regression', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `RecoveryRegression-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-recovery' },
        groupIds: [], changedBy: 'recovery-regression-test'
      })).agent;

      fs.writeFileSync(path.join(workspaceRoot, DELETE_TEST_FILE), 'recovery-delete-content');

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        TEST_INTERRUPT_AFTER_OPERATOR_RECOVERY_EFFECT: 'true',
        // Runs here must complete promptly; the lease only matters if a run were
        // to crash, which this suite does not exercise.
        RUN_LEASE_DURATION_MS: '60000',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200'
      } });
      const cookie = await server.login();

      const seen = new Set();
      async function completedRunFor(objective) {
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        if (created.statusCode !== 302) {
          throw new Error(`ticket create returned HTTP ${created.statusCode}`);
        }
        const run = await waitFor(async () => {
          const page = await store.listRuns({ limit: 100 });
          return (page.runs || []).find(r => r.agentId === agent.id && !seen.has(r.id)) || null;
        }, 30000, `run dispatch for "${objective}"`);
        seen.add(run.id);
        return waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && current.status === 'completed' ? current : null;
        }, 60000, `completed run for "${objective}"`);
      }

      const opsFor = async runId => store.listRunOperations(runId, { limit: 200 });
      const exists = rel => fs.existsSync(path.join(workspaceRoot, rel));
      const json = response => JSON.parse(response.body);

      // ── writeFile recovery ─────────────────────────────────────────────────
      const writeRun = await completedRunFor(`recovery-write ${STAMP}`);
      assert(exists(WRITE_TEST_FILE), 'writeFile run created the test file');

      const writeOp = (await opsFor(writeRun.id)).find(op => op.operation === 'writeFile');
      assert(Boolean(writeOp), 'writeFile operation receipt exists');
      assert(writeOp.preState && writeOp.preState.existed === false,
        'writeFile preState records the file did not previously exist');
      assert(writeOp.postState && writeOp.postState.existed === true,
        'writeFile postState records the file now exists');

      const writePreview = json(await server.request('GET', `/api/operations/${writeOp.id}/recovery-preview`, { cookie }));
      assert(writePreview.preview && writePreview.preview.canProceed === true,
        'writeFile recovery preview reports it can proceed');
      assert(writePreview.preview.proposedAction
        && writePreview.preview.proposedAction.operation === 'deletePath',
        'writeFile recovery proposes deletePath as the truthful inverse');

      // Interrupt between the external effect and its completion evidence.
      const interrupted = await server.request('POST', `/api/operations/${writeOp.id}/recover`, {
        cookie, body: { confirmed: true }
      });
      assert(interrupted.statusCode === 400,
        `interrupted recovery surfaces the interruption (HTTP ${interrupted.statusCode})`);
      assert(!exists(WRITE_TEST_FILE),
        'the prepared recovery effect was applied before evidence completion');

      // The retry must reconcile the already-applied effect, not repeat it.
      const writeRecoverResponse = await server.request('POST', `/api/operations/${writeOp.id}/recover`, {
        cookie, body: { confirmed: true }
      });
      assert(writeRecoverResponse.statusCode === 200,
        `retried writeFile recovery succeeded (HTTP ${writeRecoverResponse.statusCode})`);
      const writeRecover = json(writeRecoverResponse);
      assert(writeRecover.recovery && writeRecover.recovery.isRecovery === true,
        'recovery record is marked isRecovery');
      assert(writeRecover.recovery.recoveredHistoryId === writeOp.id,
        'recovery record links to the original operation');
      assert(writeRecover.reconciled === true,
        'retry reconciled the already-applied prepared effect rather than repeating it');
      assert(!exists(WRITE_TEST_FILE), 'writeFile recovery left the file deleted');

      const duplicate = json(await server.request('POST', `/api/operations/${writeOp.id}/recover`, {
        cookie, body: { confirmed: true }
      }));
      assert(duplicate.idempotent === true, 'repeating a completed recovery is labelled idempotent');
      assert(duplicate.recovery.id === writeRecover.recovery.id,
        'repeated recovery returns the original completion receipt');

      const writeEvents = await store.listRunEvents(writeRun.id, { afterSeq: -1, limit: 500 });
      assert((writeEvents || []).some(e => e.type === 'workspace.recovery_prepared'),
        'recovery intent is durably recorded before the target effect');
      assert((writeEvents || []).some(e => e.type === 'workspace.recovery_completed'),
        'reconciled recovery records durable completion evidence');

      // Diverged state must block recovery.
      fs.writeFileSync(path.join(workspaceRoot, WRITE_TEST_FILE), 'modified-content');
      const diverged = json(await server.request('GET', `/api/operations/${writeOp.id}/recovery-preview`, { cookie }));
      assert(diverged.preview && diverged.preview.canProceed === false,
        'diverged workspace state blocks recovery');
      fs.unlinkSync(path.join(workspaceRoot, WRITE_TEST_FILE));

      // ── renamePath recovery ────────────────────────────────────────────────
      const renameRun = await completedRunFor(`recovery-rename ${STAMP}`);
      assert(!exists(RENAME_SOURCE_FILE), 'rename source no longer exists after the run');
      assert(exists(RENAME_DEST_FILE), 'rename destination exists after the run');

      const renameOp = (await opsFor(renameRun.id)).find(op => op.operation === 'renamePath');
      assert(Boolean(renameOp), 'renamePath operation receipt exists');
      assert(renameOp.preState && renameOp.preState.source && renameOp.preState.source.existed === true,
        'renamePath preState records the source existed');
      assert(renameOp.preState.destination && renameOp.preState.destination.existed === false,
        'renamePath preState records the destination did not exist');

      const renamePreview = json(await server.request('GET', `/api/operations/${renameOp.id}/recovery-preview`, { cookie }));
      assert(renamePreview.preview && renamePreview.preview.canProceed === true,
        'renamePath recovery preview reports it can proceed');
      const proposed = renamePreview.preview.proposedAction;
      assert(proposed && proposed.operation === 'renamePath',
        'renamePath recovery proposes renamePath');
      assert(proposed.args.path === RENAME_DEST_FILE,
        'renamePath recovery uses the destination as its source');
      assert(proposed.args.nextPath === RENAME_SOURCE_FILE,
        'renamePath recovery uses the original source as its destination');

      const renameRecover = json(await server.request('POST', `/api/operations/${renameOp.id}/recover`, {
        cookie, body: { confirmed: true }
      }));
      assert(renameRecover.recovery && renameRecover.recovery.isRecovery === true,
        'renamePath recovery record is marked isRecovery');
      assert(renameRecover.recovery.recoveredHistoryId === renameOp.id,
        'renamePath recovery record links to the original operation');
      assert(exists(RENAME_SOURCE_FILE), 'renamePath recovery restored the source file');
      assert(!exists(RENAME_DEST_FILE), 'renamePath recovery removed the destination file');

      // ── Recovery linkage across both runs ──────────────────────────────────
      const allOps = [...(await opsFor(writeRun.id)), ...(await opsFor(renameRun.id))];
      const recoveryRecords = allOps.filter(op => op.isRecovery);
      assert(recoveryRecords.length >= 2, `at least two recovery records exist (${recoveryRecords.length})`);
      assert(recoveryRecords.every(op => op.recoveredHistoryId != null),
        'every recovery record links to what it recovered');
      assert(recoveryRecords.some(op => op.operation === 'deletePath'),
        'recovery records include the deletePath inverse');
      assert(recoveryRecords.some(op => op.operation === 'renamePath'),
        'recovery records include the renamePath inverse');

      const recoveryLogs = await store.listLogs({ types: ['workspace:recovery'], limit: 100 });
      const logRows = recoveryLogs.logs || recoveryLogs;
      assert(logRows.length >= 2, `at least two workspace:recovery logs exist (${logRows.length})`);
      assert(logRows.every(log => log.workspaceAction && log.workspaceAction.operation === 'recovery'),
        'every recovery log carries a recovery workspaceAction');

      const runDetail = await server.request('GET', `/runs/${renameRun.id}`, { cookie });
      assert(runDetail.statusCode === 200, 'run detail page loads');
      assert(/RECOVERY|RECOVERABLE/.test(runDetail.body),
        'run detail surfaces recovery status');

      // ── deletePath is unrecoverable ────────────────────────────────────────
      const deleteRun = await completedRunFor(`recovery-delete ${STAMP}`);
      assert(!exists(DELETE_TEST_FILE), 'deletePath run deleted the file');

      const deleteOp = (await opsFor(deleteRun.id)).find(op => op.operation === 'deletePath' && !op.isRecovery);
      assert(Boolean(deleteOp), 'deletePath operation receipt exists');
      assert(deleteOp.preState && deleteOp.preState.existed === true,
        'deletePath preState records the file existed');

      const deletePreview = json(await server.request('GET', `/api/operations/${deleteOp.id}/recovery-preview`, { cookie }));
      assert(deletePreview.preview && deletePreview.preview.canProceed === false,
        'deletePath recovery cannot proceed');
      assert(deletePreview.preview.status === 'unrecoverable',
        'deletePath is reported as unrecoverable, not merely blocked');

      const ticketDetail = await server.request('GET', `/tickets/${writeRun.ticketId}`, { cookie });
      assert(ticketDetail.statusCode === 200, 'ticket detail page loads');
      assert(ticketDetail.body.includes('Operation History'),
        'ticket detail surfaces operation history');
      assert(/RECOVERABLE|UNRECOVERABLE|RECOVERY/.test(ticketDetail.body),
        'ticket detail surfaces recovery badges');

      console.log(`\nPASS: operator recovery regression — ${assert.count()} assertions (PostgreSQL-native)`);
    });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
