#!/usr/bin/env node
'use strict';
// Concurrency conflict harness — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Contract under test, preserved from the JSON-era original: when concurrent tickets
// and runs touch overlapping or non-overlapping workspace paths, the outcome is
// DETERMINISTIC and no mutation is silently lost. Overlapping writes produce exactly
// one clean write plus a visible attributed conflict — never last-writer-wins.
// Non-overlapping writes never produce a false conflict. Cross-ticket destructive
// operations are gated on workspace.delete.cross_ticket_artifact, and the gate is
// scoped to cross-ticket artifacts only.
//
// Repaired, not rewritten. The model-free `#ACTIONS=` fetch stub is
// storage-independent and preserved verbatim in shape. What changed is seeding and
// observation: agents and the restricted principal come from the store, and tickets,
// runs, operation receipts, replay evidence and the audit event are read through the
// store instead of from a DATA_DIR the PostgreSQL server no longer reads.
//
// TWO DELIBERATE STRENGTHENINGS, both required before this suite could be registered
// as checkpoint coverage:
//
//   1. NOT_PROVEN IS NOW A HARD FAILURE. The original treated it as a neutral
//      discovery outcome, so every scenario had an escape path ("owner run did not
//      complete") that exited zero having proved nothing — the same green-but-vacuous
//      shape A20 was opened to eliminate. Against a real store driven by a
//      deterministic model-free stub, a prerequisite run that does not reach its
//      expected state means the harness is broken, not that reality is ambiguous.
//
//   2. THE JSON-CORRUPTION ASSERTIONS ARE RETIRED. `jsonParsesOrNull()` guarded
//      against a torn concurrent write to a flat file. PostgreSQL cannot produce that
//      state, so re-asserting it would test nothing. The surviving property — that
//      concurrent writers lose and duplicate no records — is asserted directly
//      through record counts and per-run isolation instead.
//
// OBSERVED_SAFE/OBSERVED_UNSAFE is kept for the two parent/child probes: the guard
// now exists, so OBSERVED_UNSAFE is a hard failure, but the vocabulary still records
// HOW the guard fired rather than only that it did.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const RESTRICTED_PASSWORD = 'restricted-password-concurrency';
const CROSS_TICKET_DELETE_PERMISSION = 'workspace.delete.cross_ticket_artifact';

const results = {};
let hardFailures = 0;

function record(name, verdict, detail) {
  results[name] = { verdict, detail: detail || null };
  // FAIL, OBSERVED_UNSAFE and NOT_PROVEN all fail the harness. See the header: a
  // scenario that cannot reach its own preconditions has not observed anything.
  const isHard = verdict === 'FAIL' || verdict === 'OBSERVED_UNSAFE' || verdict === 'NOT_PROVEN';
  if (isHard) hardFailures += 1;
  console.log(`  ${isHard ? '✗' : '·'} ${name}: ${verdict}${detail ? ' — ' + detail : ''}`);
}

function softAssert(name, condition, detailIfFail, detailIfPass) {
  record(name, condition ? 'PASS' : 'FAIL', condition ? (detailIfPass || null) : detailIfFail);
  return condition;
}

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `concurrency-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-concurrency']]),
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

async function waitFor(fn, timeoutMs = 45000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  const preloadPath = createFetchStub();
  try {
    await withHarness('concurrency conflict', async ({ store, workspaceRoot, startServer }) => {
      const agents = [];
      for (let i = 0; i < 4; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `Concurrency Agent ${i} ${STAMP}`, provider: 'openai', model: `fake-openai-${i}`, apiKey: `fake-key-${i}` },
          groupIds: [], changedBy: 'concurrency-conflict-test'
        })).agent.id);
      }

      // A real non-admin principal WITHOUT the cross-ticket delete permission.
      // (admin holds the full catalog through the Administrators group.)
      const restrictedGroup = (await store.createGroup({
        value: {
          name: `Restricted Operators ${STAMP}`,
          permissions: ['ticket:create', 'ticket:read', 'ticket:update'],
          canReceiveTickets: false
        },
        changedBy: 'concurrency-conflict-test'
      })).group;
      await store.createUser({
        value: { username: 'restricted', passwordHash: await argon2.hash(RESTRICTED_PASSWORD) },
        groupIds: [restrictedGroup.id],
        changedBy: 'concurrency-conflict-test'
      });

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      const cookie = await server.login();
      const restrictedCookie = await server.login('restricted', RESTRICTED_PASSWORD);

      // ── Store-backed observation helpers ───────────────────────────────────
      const objectiveWith = (tag, plan) => `concurrency ${tag} ${STAMP} #ACTIONS=${encodeActions(plan)}`;
      const abs = rel => path.join(workspaceRoot, rel);
      const exists = rel => fs.existsSync(abs(rel));

      const createTicket = (asCookie, agentId, objective) => server.request('POST', '/tickets', {
        cookie: asCookie,
        form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
      });

      const allTickets = async () => (await store.listTickets({ limit: 500 })).tickets;
      const findTicket = async objective => (await allTickets()).find(t => t.objective === objective) || null;
      const runsForTicket = async ticketId => (await store.listRunsForTicket({ ticketId, limit: 50 })).runs;

      async function waitForTicketRun(objective) {
        return waitFor(async () => {
          const ticket = await findTicket(objective);
          if (!ticket) return null;
          const runs = await runsForTicket(ticket.id);
          return runs.length > 0 ? { ticket, run: runs[0] } : null;
        }, 30000);
      }

      async function waitForTerminalRun(runId) {
        return waitFor(async () => {
          const run = await store.getRun(runId);
          return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
        }, 60000);
      }

      const opsFor = async runId => {
        const page = await store.listRunOperations(runId, { limit: 200 });
        return page.operations || page;
      };
      // A "clean" receipt is a committed mutation: no error, not refused/failed.
      const cleanOps = async (runId, predicate) =>
        (await opsFor(runId)).filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused' && predicate(op));
      const opPath = op => (op.args && op.args.path) || op.artifactPath || null;

      // ── Scenarios ──────────────────────────────────────────────────────────

      // 1. Concurrent ticket creation loses and duplicates nothing.
      {
        const N = 10;
        const objectives = Array.from({ length: N }, (_, i) => objectiveWith(`create-${i}`, { actions: [], complete: true }));
        const before = (await allTickets()).length;
        const responses = await Promise.all(objectives.map((o, i) => createTicket(cookie, agents[i % agents.length], o)));
        await sleep(400);
        const tickets = await allTickets();
        const allAccepted = responses.every(r => r.statusCode === 302 || r.statusCode === 200);
        const persistedCounts = objectives.map(o => tickets.filter(t => t.objective === o).length);
        const eachExactlyOnce = persistedCounts.every(c => c === 1);
        const ids = tickets.map(t => t.id);
        const uniqueIds = new Set(ids).size === ids.length;
        softAssert('concurrent ticket creation',
          allAccepted && eachExactlyOnce && uniqueIds && tickets.length === before + N,
          `accepted=${allAccepted} counts=${JSON.stringify(persistedCounts)} uniqueIds=${uniqueIds} total=${tickets.length} expected=${before + N}`,
          `${N} concurrent creations persisted exactly once each, ids unique, none lost`);
      }

      // 2. Different-path writes: both succeed, one clean receipt each.
      {
        const fA = `diff/a-${STAMP}.txt`;
        const fB = `diff/b-${STAMP}.txt`;
        const oA = objectiveWith('diffA', { actions: [{ operation: 'writeFile', args: { path: fA, content: 'AAA' } }], complete: true });
        const oB = objectiveWith('diffB', { actions: [{ operation: 'writeFile', args: { path: fB, content: 'BBB' } }], complete: true });
        await Promise.all([createTicket(cookie, agents[0], oA), createTicket(cookie, agents[1], oB)]);
        const ra = await waitForTicketRun(oA);
        const rb = await waitForTicketRun(oB);
        const fa = ra && await waitForTerminalRun(ra.run.id);
        const fb = rb && await waitForTerminalRun(rb.run.id);
        const bothCompleted = fa && fb && fa.status === 'completed' && fb.status === 'completed';
        const aOk = exists(fA) && fs.readFileSync(abs(fA), 'utf8') === 'AAA';
        const bOk = exists(fB) && fs.readFileSync(abs(fB), 'utf8') === 'BBB';
        const histA = ra ? (await cleanOps(ra.run.id, op => opPath(op) === fA)).length : 0;
        const histB = rb ? (await cleanOps(rb.run.id, op => opPath(op) === fB)).length : 0;
        softAssert('different-path writes', Boolean(bothCompleted) && aOk && bOk && histA === 1 && histB === 1,
          `completed=${bothCompleted} aOk=${aOk} bOk=${bOk} histA=${histA} histB=${histB}`,
          'both completed, both files correct, exactly one clean receipt each');
      }

      // 3. Same-file conflict: exactly one clean write, the other attributed.
      {
        const target = `same/conflict-${STAMP}.txt`;
        const oA = objectiveWith('sameA', { actions: [{ operation: 'writeFile', args: { path: target, content: 'CONTENT_A' } }], complete: true });
        const oB = objectiveWith('sameB', { actions: [{ operation: 'writeFile', args: { path: target, content: 'CONTENT_B' } }], complete: true });
        await Promise.all([createTicket(cookie, agents[0], oA), createTicket(cookie, agents[1], oB)]);
        const ra = await waitForTicketRun(oA);
        const rb = await waitForTicketRun(oB);
        const fa = ra && await waitForTerminalRun(ra.run.id);
        const fb = rb && await waitForTerminalRun(rb.run.id);
        const statuses = [fa && fa.status, fb && fb.status].sort();
        const oneEachWay = statuses.length === 2 && statuses[0] === 'completed' && statuses[1] === 'failed';
        const failedRun = [fa, fb].find(r => r && r.status === 'failed');
        const conflictSurfaced = Boolean(failedRun)
          && /write conflict|WORKSPACE_WRITE_CONFLICT|previously produced/i.test(String(failedRun.error || ''));
        const cleanWrites = (ra ? (await cleanOps(ra.run.id, op => opPath(op) === target && op.operation === 'writeFile')).length : 0)
          + (rb ? (await cleanOps(rb.run.id, op => opPath(op) === target && op.operation === 'writeFile')).length : 0);
        softAssert('same-file write conflict', oneEachWay && conflictSurfaced && cleanWrites === 1,
          `statuses=${JSON.stringify(statuses)} conflictSurfaced=${conflictSurfaced} cleanWrites=${cleanWrites}`,
          'one completed, one failed with visible conflict, exactly one clean write (no last-writer-wins)');
      }

      // 4. Same-folder create: deterministic terminal states, folder present.
      {
        const folder = `shared-folder-${STAMP}`;
        const plan = { actions: [{ operation: 'createFolder', args: { path: folder } }], complete: true };
        const oA = objectiveWith('folderA', plan);
        const oB = objectiveWith('folderB', plan);
        await Promise.all([createTicket(cookie, agents[0], oA), createTicket(cookie, agents[1], oB)]);
        const ra = await waitForTicketRun(oA);
        const rb = await waitForTicketRun(oB);
        const fa = ra && await waitForTerminalRun(ra.run.id);
        const fb = rb && await waitForTerminalRun(rb.run.id);
        const deterministic = fa && fb
          && ['completed', 'failed'].includes(fa.status) && ['completed', 'failed'].includes(fb.status);
        const folderOk = exists(folder) && fs.statSync(abs(folder)).isDirectory();
        softAssert('same-folder create', Boolean(deterministic) && folderOk,
          `fa=${fa && fa.status} fb=${fb && fb.status} folderExists=${folderOk}`,
          'both reached a terminal state and the folder exists exactly once');
      }

      // 5. Probe — cross-ticket delete of another ticket's parent folder.
      {
        const folder = `del-probe-${STAMP}`;
        const child = `${folder}/child.txt`;
        const oOwner = objectiveWith('delOwner', {
          actions: [
            { operation: 'createFolder', args: { path: folder } },
            { operation: 'writeFile', args: { path: child, content: 'OWNED' } }
          ], complete: true
        });
        await createTicket(cookie, agents[0], oOwner);
        const owner = await waitForTicketRun(oOwner);
        const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
        if (!ownerFinal || ownerFinal.status !== 'completed') {
          record('delete-parent/write-child', 'NOT_PROVEN', `owner run did not complete (${ownerFinal && ownerFinal.status})`);
        } else {
          const oDeleter = objectiveWith('delAttacker', { actions: [{ operation: 'deletePath', args: { path: folder } }], complete: true });
          await createTicket(restrictedCookie, agents[1], oDeleter);
          const del = await waitForTicketRun(oDeleter);
          const delFinal = del && await waitForTerminalRun(del.run.id);
          if (!delFinal) {
            record('delete-parent/write-child', 'NOT_PROVEN', 'deleter run did not reach terminal');
          } else if (delFinal.status === 'failed' && /conflict|previously produced/i.test(String(delFinal.error || ''))) {
            record('delete-parent/write-child', 'OBSERVED_SAFE',
              "cross-ticket delete of another ticket's folder was blocked with a conflict");
          } else if (delFinal.status === 'completed' && !exists(child)) {
            record('delete-parent/write-child', 'OBSERVED_UNSAFE',
              "a different ticket deleted another ticket's produced folder+child with no conflict surfaced");
          } else {
            record('delete-parent/write-child', 'NOT_PROVEN',
              `deleter status=${delFinal.status} childExists=${exists(child)}`);
          }
        }
      }

      // 6. Probe — cross-ticket rename of another ticket's parent folder.
      {
        const folder = `ren-probe-${STAMP}`;
        const child = `${folder}/child.txt`;
        const renamed = `ren-probe-moved-${STAMP}`;
        const oOwner = objectiveWith('renOwner', {
          actions: [
            { operation: 'createFolder', args: { path: folder } },
            { operation: 'writeFile', args: { path: child, content: 'OWNED' } }
          ], complete: true
        });
        await createTicket(cookie, agents[2], oOwner);
        const owner = await waitForTicketRun(oOwner);
        const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
        if (!ownerFinal || ownerFinal.status !== 'completed') {
          record('rename-parent/write-child', 'NOT_PROVEN', `owner run did not complete (${ownerFinal && ownerFinal.status})`);
        } else {
          const oRenamer = objectiveWith('renAttacker', {
            actions: [{ operation: 'renamePath', args: { path: folder, nextPath: renamed } }], complete: true
          });
          await createTicket(cookie, agents[3], oRenamer);
          const ren = await waitForTicketRun(oRenamer);
          const renFinal = ren && await waitForTerminalRun(ren.run.id);
          if (!renFinal) {
            record('rename-parent/write-child', 'NOT_PROVEN', 'renamer run did not reach terminal');
          } else if (renFinal.status === 'failed' && /conflict|previously produced/i.test(String(renFinal.error || ''))) {
            record('rename-parent/write-child', 'OBSERVED_SAFE',
              "cross-ticket rename of another ticket's folder was blocked with a conflict");
          } else if (renFinal.status === 'completed' && !exists(folder) && exists(renamed)) {
            record('rename-parent/write-child', 'OBSERVED_UNSAFE',
              "a different ticket renamed another ticket's produced folder with no conflict surfaced");
          } else {
            record('rename-parent/write-child', 'NOT_PROVEN',
              `renamer status=${renFinal.status} originalGone=${!exists(folder)} movedExists=${exists(renamed)}`);
          }
        }
      }

      // 7. Double rerun: lease-guarded, deterministic, nothing left running.
      {
        const target = `rerun-${STAMP}.txt`;
        const o = objectiveWith('rerunBase', { actions: [{ operation: 'writeFile', args: { path: target, content: 'R' } }], complete: true });
        await createTicket(cookie, agents[0], o);
        const base = await waitForTicketRun(o);
        const baseFinal = base && await waitForTerminalRun(base.run.id);
        if (!baseFinal || baseFinal.status !== 'completed') {
          record('double rerun', 'NOT_PROVEN', `base run did not complete (${baseFinal && baseFinal.status})`);
        } else {
          const ticketId = base.ticket.id;
          const priorRunIds = new Set((await runsForTicket(ticketId)).map(r => r.id));
          const [r1, r2] = await Promise.all([
            server.request('POST', `/api/tickets/${ticketId}/rerun`, { cookie, body: {} }),
            server.request('POST', `/api/tickets/${ticketId}/rerun`, { cookie, body: {} })
          ]);
          await sleep(400);
          await waitFor(async () => {
            const runs = await runsForTicket(ticketId);
            return runs.length > 0 && runs.every(r => ['completed', 'failed', 'interrupted'].includes(r.status)) ? runs : null;
          }, 60000);
          const runs = await runsForTicket(ticketId);
          const newRuns = runs.filter(r => !priorRunIds.has(r.id));
          const stillRunning = runs.filter(r => r.status === 'running').length;
          const deterministicTerminal = newRuns.length >= 1
            && newRuns.every(r => ['completed', 'failed', 'interrupted'].includes(r.status));
          softAssert('double rerun',
            deterministicTerminal && stillRunning === 0 && r1.statusCode < 500 && r2.statusCode < 500,
            `newRuns=${newRuns.length} stillRunning=${stillRunning} r1=${r1.statusCode} r2=${r2.statusCode}`,
            `lease-guarded: ${newRuns.length} new run(s), none left running, all terminal`);
        }
      }

      // 8. Stop vs rerun fired concurrently: no run left stuck running.
      {
        const o = objectiveWith('stopRerun', {
          actions: [{ operation: 'writeFile', args: { path: `stop-${STAMP}.txt`, content: 'S' } }], complete: true
        });
        await createTicket(cookie, agents[1], o);
        const base = await waitForTicketRun(o);
        const baseFinal = base && await waitForTerminalRun(base.run.id);
        if (!baseFinal) {
          record('stop vs rerun', 'NOT_PROVEN', 'base run did not reach terminal');
        } else {
          const ticketId = base.ticket.id;
          const [stopRes, rerunRes] = await Promise.all([
            server.request('POST', `/api/runs/${base.run.id}/stop`, { cookie, body: {} }),
            server.request('POST', `/api/tickets/${ticketId}/rerun`, { cookie, body: {} })
          ]);
          await sleep(400);
          await waitFor(async () => {
            const runs = await runsForTicket(ticketId);
            return runs.length > 0 && runs.every(r => ['completed', 'failed', 'interrupted'].includes(r.status)) ? runs : null;
          }, 45000);
          const stuckRunning = (await runsForTicket(ticketId)).filter(r => r.status === 'running').length;
          softAssert('stop vs rerun',
            stuckRunning === 0 && stopRes.statusCode < 500 && rerunRes.statusCode < 500,
            `stuckRunning=${stuckRunning} stop=${stopRes.statusCode} rerun=${rerunRes.statusCode}`,
            `deterministic: none stuck running (stop=${stopRes.statusCode} rerun=${rerunRes.statusCode})`);
        }
      }

      // 9. Non-overlapping subtrees: no false conflict.
      {
        const a = `scopeA-${STAMP}/out.txt`;
        const b = `scopeB-${STAMP}/out.txt`;
        const oA = objectiveWith('scopeA', { actions: [{ operation: 'writeFile', args: { path: a, content: 'SA' } }], complete: true });
        const oB = objectiveWith('scopeB', { actions: [{ operation: 'writeFile', args: { path: b, content: 'SB' } }], complete: true });
        await Promise.all([createTicket(cookie, agents[2], oA), createTicket(cookie, agents[3], oB)]);
        const ra = await waitForTicketRun(oA);
        const rb = await waitForTicketRun(oB);
        const fa = ra && await waitForTerminalRun(ra.run.id);
        const fb = rb && await waitForTerminalRun(rb.run.id);
        const bothOk = fa && fb && fa.status === 'completed' && fb.status === 'completed';
        const noFalseConflict = !/conflict/i.test(String((fa && fa.error) || ''))
          && !/conflict/i.test(String((fb && fb.error) || ''));
        softAssert('allocated/dynamic non-overlap', Boolean(bothOk) && exists(a) && exists(b) && noFalseConflict,
          `bothOk=${bothOk} filesOk=${exists(a) && exists(b)} noFalseConflict=${noFalseConflict}`,
          'both non-overlapping writes completed, no false conflict');
      }

      // 10. Same agent, two tickets, different paths: evidence isolated per run.
      {
        const agent = agents[0];
        const fA = `sa-diff/a-${STAMP}.txt`;
        const fB = `sa-diff/b-${STAMP}.txt`;
        const oA = objectiveWith('saDiffA', { actions: [{ operation: 'writeFile', args: { path: fA, content: 'SA_A' } }], complete: true });
        const oB = objectiveWith('saDiffB', { actions: [{ operation: 'writeFile', args: { path: fB, content: 'SA_B' } }], complete: true });
        await Promise.all([createTicket(cookie, agent, oA), createTicket(cookie, agent, oB)]);
        const ra = await waitForTicketRun(oA);
        const rb = await waitForTicketRun(oB);
        const fa = ra && await waitForTerminalRun(ra.run.id);
        const fb = rb && await waitForTerminalRun(rb.run.id);
        if (!ra || !rb || !fa || !fb) {
          record('same-agent different-path runs isolated', 'NOT_PROVEN', 'base runs did not reach terminal');
        } else {
          const sameAgent = ra.run.agentId === agent && rb.run.agentId === agent
            && ra.run.id !== rb.run.id && ra.ticket.id !== rb.ticket.id;
          const bothCompleted = fa.status === 'completed' && fb.status === 'completed';
          const aOps = await opsFor(ra.run.id);
          const bOps = await opsFor(rb.run.id);
          const histIsolated = aOps.length > 0 && bOps.length > 0
            && aOps.every(op => opPath(op) === fA) && bOps.every(op => opPath(op) === fB);
          const snapA = await store.readRunReplay(ra.run.id);
          const snapB = await store.readRunReplay(rb.run.id);
          const snapIsolated = Boolean(snapA && snapB)
            && Array.isArray(snapA.snapshot.modelResponses) && snapA.snapshot.modelResponses.length > 0
            && Array.isArray(snapB.snapshot.modelResponses) && snapB.snapshot.modelResponses.length > 0
            && snapA.snapshot.runId === ra.run.id && snapB.snapshot.runId === rb.run.id;
          const noFalseConflict = !/conflict/i.test(String(fa.error || '')) && !/conflict/i.test(String(fb.error || ''));
          softAssert('same-agent different-path runs isolated',
            sameAgent && bothCompleted && exists(fA) && exists(fB) && histIsolated && snapIsolated && noFalseConflict,
            `sameAgent=${sameAgent} bothCompleted=${bothCompleted} histIsolated=${histIsolated} snapIsolated=${snapIsolated} noFalseConflict=${noFalseConflict}`,
            'same agent, two tickets: both complete; receipts and replay evidence isolated per run; no false conflict');
        }
      }

      // 11. Same agent, same file: conflict still blocks one, attributed.
      {
        const agent = agents[1];
        const target = `sa-same/conflict-${STAMP}.txt`;
        const oA = objectiveWith('saSameA', { actions: [{ operation: 'writeFile', args: { path: target, content: 'SA_ONE' } }], complete: true });
        const oB = objectiveWith('saSameB', { actions: [{ operation: 'writeFile', args: { path: target, content: 'SA_TWO' } }], complete: true });
        await Promise.all([createTicket(cookie, agent, oA), createTicket(cookie, agent, oB)]);
        const ra = await waitForTicketRun(oA);
        const rb = await waitForTicketRun(oB);
        const fa = ra && await waitForTerminalRun(ra.run.id);
        const fb = rb && await waitForTerminalRun(rb.run.id);
        const statuses = [fa && fa.status, fb && fb.status].sort();
        const oneEachWay = statuses.length === 2 && statuses[0] === 'completed' && statuses[1] === 'failed';
        const failedRun = [fa, fb].find(r => r && r.status === 'failed');
        const attributed = Boolean(failedRun)
          && /write conflict|previously produced|WORKSPACE_WRITE_CONFLICT/i.test(String(failedRun.error || ''));
        const cleanWrites = (ra ? (await cleanOps(ra.run.id, op => opPath(op) === target && op.operation === 'writeFile')).length : 0)
          + (rb ? (await cleanOps(rb.run.id, op => opPath(op) === target && op.operation === 'writeFile')).length : 0);
        softAssert('same-agent same-file conflict blocked', oneEachWay && attributed && cleanWrites === 1,
          `statuses=${JSON.stringify(statuses)} attributed=${attributed} cleanWrites=${cleanWrites}`,
          'same agent, same file: one completes, one fails with attributed conflict, exactly one clean write');
      }

      // 12. Rerunning one ticket leaves the same agent's other ticket untouched.
      {
        const agent = agents[2];
        const oA = objectiveWith('saRerunA', { actions: [{ operation: 'writeFile', args: { path: `sa-rerun/a-${STAMP}.txt`, content: 'A' } }], complete: true });
        const oB = objectiveWith('saRerunB', { actions: [{ operation: 'writeFile', args: { path: `sa-rerun/b-${STAMP}.txt`, content: 'B' } }], complete: true });
        await Promise.all([createTicket(cookie, agent, oA), createTicket(cookie, agent, oB)]);
        const ra = await waitForTicketRun(oA);
        const rb = await waitForTicketRun(oB);
        const fa = ra && await waitForTerminalRun(ra.run.id);
        const fb = rb && await waitForTerminalRun(rb.run.id);
        if (!ra || !rb || !fa || !fb) {
          record('same-agent rerun isolation', 'NOT_PROVEN', 'base runs did not reach terminal');
        } else {
          const bBefore = (await runsForTicket(rb.ticket.id)).map(r => `${r.id}:${r.status}`).sort();
          const rer = await server.request('POST', `/api/tickets/${ra.ticket.id}/rerun`, { cookie, body: {} });
          await sleep(400);
          await waitFor(async () => {
            const aRuns = await runsForTicket(ra.ticket.id);
            return aRuns.length >= 2 && aRuns.every(r => ['completed', 'failed', 'interrupted'].includes(r.status)) ? aRuns : null;
          }, 60000);
          const bAfter = (await runsForTicket(rb.ticket.id)).map(r => `${r.id}:${r.status}`).sort();
          const aAfter = await runsForTicket(ra.ticket.id);
          const bUnaffected = JSON.stringify(bBefore) === JSON.stringify(bAfter);
          softAssert('same-agent rerun isolation', rer.statusCode === 200 && bUnaffected && aAfter.length >= 2,
            `rerunStatus=${rer.statusCode} bUnaffected=${bUnaffected} aRuns=${aAfter.length}`,
            "rerunning one ticket adds a run only to that ticket; the same agent's other ticket is untouched");
        }
      }

      // 13. Same agent: a failed run keeps its failure to itself.
      {
        const owner = agents[3];
        const worker = agents[0];
        const ownedPath = `sa-fail/owned-${STAMP}.txt`;
        const oS = objectiveWith('saFailOwner', { actions: [{ operation: 'writeFile', args: { path: ownedPath, content: 'OWNER' } }], complete: true });
        await createTicket(cookie, owner, oS);
        const rs = await waitForTicketRun(oS);
        const sFinal = rs && await waitForTerminalRun(rs.run.id);
        if (!sFinal || sFinal.status !== 'completed') {
          record('same-agent failure isolation', 'NOT_PROVEN', `owner setup run did not complete (${sFinal && sFinal.status})`);
        } else {
          const okPath = `sa-fail/ok-${STAMP}.txt`;
          const oOk = objectiveWith('saFailOk', { actions: [{ operation: 'writeFile', args: { path: okPath, content: 'OK' } }], complete: true });
          const oBad = objectiveWith('saFailBad', { actions: [{ operation: 'writeFile', args: { path: ownedPath, content: 'BAD' } }], complete: true });
          await Promise.all([createTicket(cookie, worker, oOk), createTicket(cookie, worker, oBad)]);
          const rOk = await waitForTicketRun(oOk);
          const rBad = await waitForTicketRun(oBad);
          const okF = rOk && await waitForTerminalRun(rOk.run.id);
          const badF = rBad && await waitForTerminalRun(rBad.run.id);
          if (!rOk || !rBad || !okF || !badF) {
            record('same-agent failure isolation', 'NOT_PROVEN', 'worker runs did not reach terminal');
          } else {
            const okGood = okF.status === 'completed' && !okF.error && exists(okPath);
            const badFailed = badF.status === 'failed' && /conflict|previously produced/i.test(String(badF.error || ''));
            const okHist = (await cleanOps(rOk.run.id, () => true)).length;
            const badHist = (await cleanOps(rBad.run.id, () => true)).length;
            let okStateClean = false;
            try {
              const st = JSON.parse((await server.request('GET', `/api/runs/${rOk.run.id}/state`, { cookie })).body);
              okStateClean = Boolean(st) && st.status === 'completed' && !st.error;
            } catch (_) { okStateClean = false; }
            softAssert('same-agent failure isolation',
              okGood && badFailed && okHist === 1 && badHist === 0 && okStateClean,
              `okGood=${okGood} badFailed=${badFailed} okHist=${okHist} badHist=${badHist} okStateClean=${okStateClean}`,
              'same agent: the failed run keeps its failure and evidence to itself; the successful run stays clean');
          }
        }
      }

      // 14. Permitted cross-ticket delete: executes and is audited.
      {
        const cd = `xdel-permitted/CD-${STAMP}.txt`;
        const oOwner = objectiveWith('permOwner', { actions: [{ operation: 'writeFile', args: { path: cd, content: 'CD' } }], complete: true });
        await createTicket(cookie, agents[0], oOwner);
        const owner = await waitForTicketRun(oOwner);
        const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
        if (!ownerFinal || ownerFinal.status !== 'completed') {
          record('permitted cross-ticket delete', 'NOT_PROVEN', `owner run did not complete (${ownerFinal && ownerFinal.status})`);
        } else {
          const oDel = objectiveWith('permDel', { actions: [{ operation: 'deletePath', args: { path: cd } }], complete: true });
          await createTicket(cookie, agents[1], oDel);
          const del = await waitForTicketRun(oDel);
          const delFinal = del && await waitForTerminalRun(del.run.id);
          if (!del || !delFinal) {
            record('permitted cross-ticket delete', 'NOT_PROVEN', 'delete run did not reach terminal');
          } else {
            const completed = delFinal.status === 'completed';
            const cleanDelete = (await cleanOps(del.run.id, op => op.operation === 'deletePath' && opPath(op) === cd)).length === 1;
            const auditEvent = await waitFor(async () => {
              const events = await store.listRunEvents(del.run.id, { afterSeq: -1, limit: 500 });
              return (events || []).find(e => e.type === 'workspace.cross_ticket_delete_authorized') || null;
            }, 15000);
            const payload = auditEvent && (auditEvent.payload || auditEvent);
            const auditOk = Boolean(payload)
              && payload.priorOwnerTicketId === owner.ticket.id
              && payload.priorOwnerRunId === owner.run.id
              && payload.requestingTicketId === del.ticket.id
              && payload.requestingRunId === del.run.id
              && payload.actorUsername === 'admin'
              && payload.permissionUsed === CROSS_TICKET_DELETE_PERMISSION;
            softAssert('permitted cross-ticket delete', completed && !exists(cd) && cleanDelete && auditOk,
              `completed=${completed} fileGone=${!exists(cd)} cleanDelete=${cleanDelete} auditOk=${auditOk}`,
              "permissioned user deletes another ticket's artifact: executed, file removed, clean receipt, audit records prior owner and permission used");
          }
        }
      }

      // 15. Non-permitted cross-ticket delete stays blocked.
      {
        const cd = `xdel-blocked/CD-${STAMP}.txt`;
        const oOwner = objectiveWith('blkOwner', { actions: [{ operation: 'writeFile', args: { path: cd, content: 'CD' } }], complete: true });
        await createTicket(cookie, agents[0], oOwner);
        const owner = await waitForTicketRun(oOwner);
        const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
        if (!ownerFinal || ownerFinal.status !== 'completed') {
          record('non-permitted cross-ticket delete blocked', 'NOT_PROVEN', `owner run did not complete (${ownerFinal && ownerFinal.status})`);
        } else {
          const oDel = objectiveWith('blkDel', { actions: [{ operation: 'deletePath', args: { path: cd } }], complete: true });
          await createTicket(restrictedCookie, agents[1], oDel);
          const del = await waitForTicketRun(oDel);
          const delFinal = del && await waitForTerminalRun(del.run.id);
          if (!del || !delFinal) {
            record('non-permitted cross-ticket delete blocked', 'NOT_PROVEN', 'delete run did not reach terminal');
          } else {
            const blocked = delFinal.status === 'failed' && /conflict|previously produced/i.test(String(delFinal.error || ''));
            const noCleanDelete = (await cleanOps(del.run.id, op => op.operation === 'deletePath')).length === 0;
            softAssert('non-permitted cross-ticket delete blocked', blocked && exists(cd) && noCleanDelete,
              `blocked=${blocked} fileExists=${exists(cd)} noCleanDelete=${noCleanDelete}`,
              'unpermitted cross-ticket delete stays blocked with a conflict; the artifact survives; no clean delete receipt');
          }
        }
      }

      // 16. The gate is scoped: deleting an unowned path needs no permission.
      {
        const f = `xdel-own/cleanup-${STAMP}.txt`;
        fs.mkdirSync(abs(path.dirname(f)), { recursive: true });
        fs.writeFileSync(abs(f), 'PREEXISTING');
        const o = objectiveWith('ownDel', { actions: [{ operation: 'deletePath', args: { path: f } }], complete: true });
        await createTicket(restrictedCookie, agents[3], o);
        const r = await waitForTicketRun(o);
        const rf = r && await waitForTerminalRun(r.run.id);
        if (!r || !rf) {
          record('non-cross-ticket delete allowed without permission', 'NOT_PROVEN', 'run did not reach terminal');
        } else {
          const cleanDelete = (await cleanOps(r.run.id, op => op.operation === 'deletePath')).length === 1;
          softAssert('non-cross-ticket delete allowed without permission',
            rf.status === 'completed' && !exists(f) && cleanDelete,
            `completed=${rf.status === 'completed'} gone=${!exists(f)} cleanDelete=${cleanDelete}`,
            'deleting a path no other ticket owns succeeds without the cross-ticket permission (the gate is scoped)');
        }
      }

      console.log('\nSummary');
      console.log('-'.repeat(60));
      for (const [name, r] of Object.entries(results)) console.log(`  ${name}: ${r.verdict}`);
      const observedUnsafe = Object.values(results).filter(r => r.verdict === 'OBSERVED_UNSAFE').length;
      const notProven = Object.values(results).filter(r => r.verdict === 'NOT_PROVEN').length;
      console.log(
        `\n${hardFailures === 0 ? 'PASS' : 'FAIL'}: concurrency conflict — ` +
        `${Object.keys(results).length} scenarios, ${hardFailures} hard failure(s), ` +
        `${observedUnsafe} observed-unsafe, ${notProven} not-proven (PostgreSQL-native)`
      );
    }, { schemaSlug: 'concurrency_conflict' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }

  if (hardFailures !== 0) process.exit(1);
}

main().catch(error => {
  console.error(`\nFAIL: concurrency conflict — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
