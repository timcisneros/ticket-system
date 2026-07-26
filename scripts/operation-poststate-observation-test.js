#!/usr/bin/env node
'use strict';
// Observed post-state and batch verification — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A13).
//
// RE-POINTED COVERAGE for three suites A13 retires, all of which read `server.js` as
// text and evaluated extracted helpers:
//
//   observed-poststate-regression-test.js       postState comes from filesystem
//                                               observation, not from the request
//   renamepath-preservation-regression-test.js  renamePath preserves type/contentHash
//   verify-batch-operation-regression-test.js   the remaining verification checks
//
// All three broke on `buildTargetOperationKey is not defined` — a coupling to internal
// structure, not to behavior. The behavior itself is live (`captureWorkspacePostState`,
// `verifyBatchOperation`), so retiring them without replacement would delete real
// coverage. This suite asserts the same property through the running system.
//
// THE PROPERTY: an operation receipt describes what the FILESYSTEM DID, not what the
// model ASKED FOR. A receipt that echoed its request would be worse than no receipt —
// it would testify that a refused mutation had happened.
//
// The discriminating case is therefore a REFUSED operation: the request says "write
// this content here", reality says the file is untouched, and the receipt must side
// with reality. On a successful operation the two agree, so success alone cannot tell
// an observing implementation apart from an echoing one.
//
// KNOWN LIMIT, recorded rather than papered over. `verifyBatchOperation` runs
// immediately after each action inside the per-action loop (server.js), so its
// DIVERGENCE branches — content_mismatch, file_missing, destination_content_mismatch —
// cannot be reached through the runtime's public surface: nothing can change the
// filesystem between an action and its own verification. Forcing them would need a
// new test seam in production code, which is a production change and out of scope for
// a test tranche. What is asserted here is the reachable half: verification runs, and
// stays silent exactly when observed reality matches the request. The unreachable half
// is recorded in A13 as a residual gap.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const assert = createAsserter();

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `poststate-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-poststate']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
  } catch (_) {}
  const m = combined.match(/#ACTIONS=([A-Za-z0-9_-]+=*)/);
  if (!m) return okResponse({ message: 'noop', actions: [], complete: true });
  let plan;
  try { plan = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (_) { plan = { actions: [], complete: true }; }
  return okResponse({ message: plan.message || 'stubbed', actions: plan.actions || [], complete: plan.complete !== false });
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFetchStub();
  try {
    await withHarness('operation post-state observation', async ({ store, workspaceRoot, startServer }) => {
      const agents = [];
      for (let i = 0; i < 2; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `PostState Agent ${i} ${STAMP}`, provider: 'openai', model: `fake-openai-${i}`, apiKey: `fake-key-ps-${i}` },
          groupIds: [], changedBy: 'operation-poststate-observation-test'
        })).agent.id);
      }

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      const cookie = await server.login();

      const objectiveWith = (tag, plan) => `poststate ${tag} ${STAMP} #ACTIONS=${encodeActions(plan)}`;
      const abs = rel => path.join(workspaceRoot, rel);

      async function runTicket(agentId, objective) {
        const created = await server.request('POST', '/tickets', {
          cookie, form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
        });
        if (created.statusCode !== 302) throw new Error(`ticket create returned HTTP ${created.statusCode}`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, 'ticket persistence');
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `run dispatch for ticket ${ticket.id}`);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 90000, `terminal run ${run.id}`);
        return { ticket, run: terminal };
      }

      const opsFor = async runId => {
        const page = await store.listRunOperations(runId, { limit: 200 });
        return page.operations || page;
      };
      const eventsFor = async runId => (await store.listRunEvents(runId, { afterSeq: -1, limit: 500 })) || [];

      // ── 1. writeFile: pre-state and post-state are both observed ───────────
      const created = `ps-write-${STAMP}.txt`;
      const writeRun = await runTicket(agents[0], objectiveWith('write', {
        actions: [{ operation: 'writeFile', args: { path: created, content: 'OBSERVED_CONTENT' } }], complete: true
      }));
      assert(writeRun.run.status === 'completed', `1: the write run completed (${writeRun.run.status})`);

      const writeOps = await opsFor(writeRun.run.id);
      const writeOp = writeOps.find(op => op.operation === 'writeFile');
      assert(Boolean(writeOp), '1: a writeFile receipt was recorded');
      assert(writeOp.preState && writeOp.preState.existed === false,
        '1: pre-state observed that the file did not exist beforehand');
      assert(writeOp.postState && writeOp.postState.existed === true,
        '1: post-state observed that the file exists afterwards');
      assert(writeOp.postState.type === 'file',
        `1: post-state observed the path type from the filesystem (got ${writeOp.postState.type})`);
      assert(typeof writeOp.postState.contentHash === 'string' && writeOp.postState.contentHash.length > 0,
        '1: post-state carries a content hash taken from the bytes on disk');
      assert(fs.readFileSync(abs(created), 'utf8') === 'OBSERVED_CONTENT',
        '1: the observed content is what actually landed on disk');

      // ── 2. Verification is silent when reality matches the request ─────────
      const writeEvents = await eventsFor(writeRun.run.id);
      assert(!writeEvents.some(e => e.type === 'batch:verification_failed'),
        '2: a correct mutation raises no batch verification failure');

      // ── 3. renamePath: the destination is described from observation ───────
      const renameSrc = `ps-rename-src-${STAMP}.txt`;
      const renameDst = `ps-rename-dst-${STAMP}.txt`;
      const renameRun = await runTicket(agents[0], objectiveWith('rename', {
        actions: [
          { operation: 'writeFile', args: { path: renameSrc, content: 'PRESERVE_ME' } },
          { operation: 'renamePath', args: { path: renameSrc, nextPath: renameDst } }
        ], complete: true
      }));
      assert(renameRun.run.status === 'completed', `3: the rename run completed (${renameRun.run.status})`);

      const renameOp = (await opsFor(renameRun.run.id)).find(op => op.operation === 'renamePath');
      assert(Boolean(renameOp), '3: a renamePath receipt was recorded');
      assert(renameOp.preState && renameOp.preState.source,
        '3: the receipt records the source pre-state the preservation check compares against');
      assert(renameOp.postState && renameOp.postState.destination,
        '3: the receipt records the destination post-state');
      assert(renameOp.preState.source.type === renameOp.postState.destination.type,
        '3: the destination preserved the source type');
      assert(renameOp.preState.source.contentHash === renameOp.postState.destination.contentHash,
        '3: the destination preserved the source content hash');
      assert(!fs.existsSync(abs(renameSrc)) && fs.readFileSync(abs(renameDst), 'utf8') === 'PRESERVE_ME',
        '3: the observed preservation matches the actual filesystem outcome');
      assert(!(await eventsFor(renameRun.run.id)).some(e => e.type === 'batch:verification_failed'),
        '3: a faithful rename raises no verification failure');

      // ── 4. THE DISCRIMINATOR — a refused mutation must not be described as done ──
      // Another ticket owns the path, so this write is refused. The request still says
      // "write NEW_CONTENT here". An implementation that echoed its request would
      // record existed:true with the new content's hash; an observing one records what
      // is actually there. This is the only case where the two implementations differ.
      const owned = `ps-owned-${STAMP}.txt`;
      const ownerRun = await runTicket(agents[0], objectiveWith('owner', {
        actions: [{ operation: 'writeFile', args: { path: owned, content: 'ORIGINAL' } }], complete: true
      }));
      assert(ownerRun.run.status === 'completed', `4: the owner run completed (${ownerRun.run.status})`);

      const refusedRun = await runTicket(agents[1], objectiveWith('refused', {
        actions: [{ operation: 'writeFile', args: { path: owned, content: 'NEW_CONTENT' } }], complete: true
      }));
      assert(refusedRun.run.status === 'failed', `4: the contested write failed (${refusedRun.run.status})`);

      assert(fs.readFileSync(abs(owned), 'utf8') === 'ORIGINAL',
        '4: the refused write left the file untouched on disk');

      const refusedOps = await opsFor(refusedRun.run.id);
      const claimsSuccess = refusedOps.some(op =>
        op.operation === 'writeFile'
        && !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
      assert(!claimsSuccess,
        '4: no receipt from the refused run claims a successful write');

      // No receipt may carry the content the request asked for, since those bytes
      // never reached the disk. This is the echo-vs-observe discriminator stated
      // directly, and it holds whether or not a post-state was captured at all.
      const newContentHash = require('crypto').createHash('sha256').update('NEW_CONTENT').digest('hex');
      assert(!refusedOps.some(op => op.postState
        && (op.postState.contentHash === newContentHash
          || (op.postState.destination && op.postState.destination.contentHash === newContentHash))),
        '4: no receipt describes the content the refused write asked for');

      // The strongest form of the same statement: the run committed no mutations.
      const refusedEvents = await eventsFor(refusedRun.run.id);
      assert(!refusedEvents.some(e => e.type === 'workspace.mutation_committed'),
        '4: the refused run records no committed mutation');

      // ── 5. deletePath: absence is observed, not assumed ────────────────────
      const doomed = `ps-delete-${STAMP}.txt`;
      fs.writeFileSync(abs(doomed), 'DELETE_ME');
      const deleteRun = await runTicket(agents[1], objectiveWith('delete', {
        actions: [{ operation: 'deletePath', args: { path: doomed } }], complete: true
      }));
      assert(deleteRun.run.status === 'completed', `5: the delete run completed (${deleteRun.run.status})`);
      const deleteOp = (await opsFor(deleteRun.run.id)).find(op => op.operation === 'deletePath');
      assert(Boolean(deleteOp), '5: a deletePath receipt was recorded');
      assert(deleteOp.preState && deleteOp.preState.existed === true,
        '5: pre-state observed the path existed before the delete');
      assert(deleteOp.postState && deleteOp.postState.existed === false,
        '5: post-state observed the path is gone afterwards');
      assert(!fs.existsSync(abs(doomed)), '5: the observed absence matches the filesystem');
      assert(!(await eventsFor(deleteRun.run.id)).some(e => e.type === 'batch:verification_failed'),
        '5: a faithful delete raises no verification failure');

      console.log(`\nPASS: operation post-state observation — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'poststate_observation' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: operation post-state observation — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
