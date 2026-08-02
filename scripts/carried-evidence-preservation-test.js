#!/usr/bin/env node
'use strict';
// Carried-forward evidence preservation — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the JSON-era `tm2-evidence-preservation-test.js`. This is a REPLACEMENT, not
// a retirement: `previousActionResults` and `model:no_progress` are live production
// mechanisms and that orphan was the only file in the repository referencing either.
//
// THE CONTRACT: what a later model turn is told about earlier turns must be TRUE.
//
// A run is a conversation in which the model acts, the runtime executes, and the next
// request must carry an accurate account of what just happened. If that account is
// missing, stale, or belongs to another run, the model re-does completed work, loops
// until a runtime limit kills it, and the replay gives no explanation. The evidence is
// not decoration on the prompt — it is the only thing that lets a bounded run converge.
//
// THE PROVIDER IS DRIVEN BY PROMPT STATE, NOT A CALL COUNTER. Each response is chosen by
// inspecting `previousActionResults` in the request it just received:
//
//   no previousActionResults ............. turn 1: listDirectory MISSING + listDirectory REAL
//   a listDirectory result, no warning ... turn 2: listDirectory REAL again (redundant)
//   a model:no_progress warning .......... turn 3: writeFile, complete
//
// Turn 1 inspects a missing path AND a real one, so a single carried set contains an
// unsuccessful and a successful outcome distinguishable only by their recorded results.
// Turn 2 repeats a path turn 1 already listed, which is what makes the outcome REDUNDANT
// and lets the runtime name the repetition.
//
// Each response stays within one phase. The runtime refuses a response mixing inspection
// and mutation (`execution.phase_violation`) and executes NOTHING — an earlier version of
// this fixture emitted such a batch and the run looped to its step limit having performed
// no operation at all.
//
// That is deliberate and it is the central positive control. A counter-driven stub would
// pass even if the runtime carried nothing forward, because the stub would advance on
// its own. Here the stub CANNOT reach turn 3 unless the runtime actually delivered the
// no-progress warning, and cannot reach turn 2 unless it delivered the listDirectory
// result. The provider changing behaviour IS the evidence being preserved.
//
// So a runtime that carries nothing forward does not merely fail an assertion — it
// cannot finish the run at all, and the suite fails hard rather than passing vacuously.
//
// Assertions are made against the STRUCTURED captured request bodies and the durable
// replay snapshot, never against human-readable prompt prose. Elsewhere in A20 a
// substring check over prompt text was shown to be satisfied by text the runtime emits
// for unrelated reasons.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const OBJECTIVE = `carried evidence preservation ${STAMP}`;
const DECOY_OBJECTIVE = `carried evidence decoy ${STAMP}`;
const LIST_PATH = `carried-${STAMP}`;
const OUTPUT_FILE = `${LIST_PATH}/result-${STAMP}.txt`;
const OUTPUT_CONTENT = `carried-content-${STAMP}`;
const MISSING_PATH = `carried-missing-${STAMP}`;
const DECOY_MARKER = `DECOYMARKER${STAMP}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Captures every provider request body so assertions can be made on exactly what the
// model was told, rather than on what the runtime says it told it.
function createPreload(capturePath) {
  const preloadPath = path.join(os.tmpdir(), `carried-evidence-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const CAPTURE = ${JSON.stringify(capturePath)};
const OBJECTIVE = ${JSON.stringify(OBJECTIVE)};
const DECOY_OBJECTIVE = ${JSON.stringify(DECOY_OBJECTIVE)};
const LIST_PATH = ${JSON.stringify(LIST_PATH)};
const OUTPUT_FILE = ${JSON.stringify(OUTPUT_FILE)};
const OUTPUT_CONTENT = ${JSON.stringify(OUTPUT_CONTENT)};
const MISSING_PATH = ${JSON.stringify(MISSING_PATH)};
const DECOY_MARKER = ${JSON.stringify(DECOY_MARKER)};

function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'carried-evidence']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const raw = options.body || '{}';
  let body = {};
  try { body = JSON.parse(raw); } catch (_) {}
  const input = Array.isArray(body.input) ? body.input : [];

  // Find the structured ticket-context message rather than concatenating prose.
  let context = null;
  for (const item of input) {
    if (!item || typeof item.content !== 'string') continue;
    try {
      const parsed = JSON.parse(item.content);
      if (parsed && typeof parsed === 'object' && parsed.ticketObjective !== undefined) context = parsed;
    } catch (_) { /* non-JSON system prose */ }
  }
  const objective = context ? String(context.ticketObjective || '') : '';
  const prior = context && Array.isArray(context.previousActionResults) ? context.previousActionResults : [];

  fs.appendFileSync(CAPTURE, JSON.stringify({
    objective, previousActionResults: prior, raw
  }) + '\\n');

  // The decoy run: a DIFFERENT ticket whose own turns must never appear in the
  // subject run's evidence. It writes a uniquely marked file and completes at once.
  if (objective === DECOY_OBJECTIVE) {
    return ok({
      message: 'decoy run',
      actions: [{ operation: 'writeFile', args: { path: DECOY_MARKER + '.txt', content: DECOY_MARKER } }],
      complete: true
    });
  }
  if (objective !== OBJECTIVE) {
    return ok({ message: 'unrelated objective', actions: [], complete: true });
  }

  // ── STATE-DRIVEN BRANCHES ────────────────────────────────────────────────
  const sawListing = prior.some(item =>
    item && item.action && item.action.operation === 'listDirectory');
  const sawNoProgress = prior.some(item => item && item.warning === 'model:no_progress');

  if (sawNoProgress) {
    // Turn 3 — reachable ONLY if the no-progress warning was carried forward.
    return ok({
      message: 'Prior evidence shows the inspection is complete; performing the write.',
      actions: [{ operation: 'writeFile', args: { path: OUTPUT_FILE, content: OUTPUT_CONTENT } }],
      complete: true
    });
  }
  if (sawListing) {
    // Turn 2 — reachable ONLY if the failed listDirectory was carried forward.
    // Inspection-only on purpose, so the runtime emits no-progress evidence.
    return ok({
      message: 'Retrying inspection against the real path.',
      actions: [{ operation: 'listDirectory', args: { path: LIST_PATH } }],
      complete: false
    });
  }
  // Turn 1 — TWO inspections in one response. Both are the same phase, so this is a
  // legal batch, and it makes the carried evidence contain an unsuccessful and a
  // successful outcome side by side, distinguishable only by their recorded results.
  return ok({
    message: 'Discovering the workspace.',
    actions: [
      { operation: 'listDirectory', args: { path: MISSING_PATH } },
      { operation: 'listDirectory', args: { path: LIST_PATH } }
    ],
    complete: false
  });
};
`);
  return preloadPath;
}

async function main() {
  const capturePath = path.join(os.tmpdir(), `carried-evidence-capture-${process.pid}-${STAMP}.jsonl`);
  fs.writeFileSync(capturePath, '');
  const preloadPath = createPreload(capturePath);

  try {
    await withHarness('carried evidence preservation', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `CarriedEvidence-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
        groupIds: [], changedBy: 'carried-evidence-preservation-test'
      })).agent;

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000',
        // The default of 4 is one short of this conversation. Turn 1 is a real mutation
        // batch (so it is NOT inspection-only and does not count toward no-progress),
        // which means the warning cannot appear until turn 4 and the write until turn 5.
        // Raising the production-configurable limit keeps turn 1 a genuine workspace
        // mutation rather than reshaping the scenario to fit the default.
        // Production defaults (4) would leave no headroom if a turn is added, and the
        // suite should fail loudly rather than silently truncate the conversation.
        AGENT_MAX_EXECUTION_STEPS: '6',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '6'
      } });
      const cookie = await server.login();

      // The real inspection target, pre-created so turn 2's listDirectory succeeds and
      // turn 1's failure against MISSING_PATH is unambiguous.
      fs.mkdirSync(path.join(workspaceRoot, LIST_PATH), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, LIST_PATH, 'seed.txt'), 'seed');

      const createTicket = objective => server.request('POST', '/tickets', {
        cookie,
        form: {
          objective,
          assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual'
        }
      });

      // A concurrent DECOY run on a different ticket. Its turns are captured too, so
      // cross-run leakage would be visible rather than assumed absent.
      assert((await createTicket(DECOY_OBJECTIVE)).statusCode === 302, 'decoy ticket created');
      assert((await createTicket(OBJECTIVE)).statusCode === 302, 'subject ticket created');

      const runs = await waitFor(async () => {
        const page = await store.listRuns({ limit: 50 });
        const all = page.runs || [];
        const subject = all.find(r => r.ticketId && r.status && true) ? all : null;
        if (!subject || all.length < 2) return null;
        return all.every(r => ['completed', 'failed', 'interrupted'].includes(r.status)) ? all : null;
      }, 90000, 'both runs to reach terminal');

      const tickets = (await store.listTickets({ limit: 50 })).tickets || [];
      const subjectTicket = tickets.find(t => t.objective === OBJECTIVE);
      const decoyTicket = tickets.find(t => t.objective === DECOY_OBJECTIVE);
      assert(subjectTicket && decoyTicket, 'both tickets persisted');
      const subjectRun = runs.find(r => r.ticketId === subjectTicket.id);
      const decoyRun = runs.find(r => r.ticketId === decoyTicket.id);
      assert(subjectRun && decoyRun, 'both runs exist');

      const captured = fs.readFileSync(capturePath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      const subjectPrompts = captured.filter(entry => entry.objective === OBJECTIVE);

      // ── 0. HARD FLOOR — the provider must have reached its intended branches ──
      // Zero captures, a missed turn, or a stub that never advanced is a failure, never
      // a pass. Without this the suite could "succeed" having proved nothing.
      scenariosRun += 1;
      assert(captured.length > 0, '0: provider requests were captured at all');
      assert(subjectPrompts.length >= 3,
        `0: the subject run reached its third turn, so the state-driven branches were all taken (${subjectPrompts.length} turns)`);
      assert(subjectRun.status === 'completed',
        `0: the subject run completed rather than looping to a limit (${subjectRun.status}: ${subjectRun.error || ''})`);

      // ── 1. Turn 1 performed a real operation and carried nothing before it ──
      scenariosRun += 1;
      assert(subjectPrompts[0].previousActionResults.length === 0,
        `1: the first turn carried no prior evidence, as there was none (${subjectPrompts[0].previousActionResults.length})`);
      const firstPlan = JSON.parse(subjectPrompts[0].raw);
      assert(firstPlan && Array.isArray(firstPlan.input),
        '1: the first request was a real provider call');

      // ── 2. Turn 2 received structured evidence of turn 1 ───────────────────
      // Asserted on the STRUCTURE — operation name and returned result — not on prose.
      scenariosRun += 1;
      const secondPrior = subjectPrompts[1].previousActionResults;
      assert(secondPrior.length > 0,
        '2: the second turn received prior action results');
      const listings = secondPrior.filter(item => item && item.action && item.action.operation === 'listDirectory');
      assert(listings.length === 2,
        `2: both inspections from the previous turn are carried (${listings.length})`);
      const missingEntry = listings.find(item => item.action.args.path === MISSING_PATH);
      const foundEntry = listings.find(item => item.action.args.path === LIST_PATH);
      assert(missingEntry && foundEntry,
        `2: each is attached to the path it actually inspected (${listings.map(i => i.action.args.path).join(', ')})`);
      // The two outcomes differ ONLY in their recorded result, which is what makes
      // "represented truthfully" a real property rather than "some record exists".
      // The runtime uses a structured result status, not an error field — asserted as it
      // behaves, not as the JSON-era suite assumed.
      assert(missingEntry.result && missingEntry.result.status === 'not_found',
        `2: the unsuccessful inspection is carried forward as NOT FOUND (${JSON.stringify(missingEntry.result)})`);
      assert(Array.isArray(missingEntry.result.entries) && missingEntry.result.entries.length === 0,
        '2: reporting no entries, so the model cannot mistake it for a successful listing');
      assert(foundEntry.result && foundEntry.result.status !== 'not_found',
        `2: the successful inspection is NOT reported as not_found (${JSON.stringify(foundEntry.result)})`);
      assert(Array.isArray(foundEntry.result.entries) && foundEntry.result.entries.length > 0,
        `2: and carries the entries it actually found (${JSON.stringify(foundEntry.result.entries)})`);

      // ── 3. No-progress evidence explains why another turn occurred ──────────
      scenariosRun += 1;
      const thirdPrior = subjectPrompts[2].previousActionResults;
      const warning = thirdPrior.find(item => item && item.warning === 'model:no_progress');
      assert(warning,
        `3: the third turn was told WHY it was asked again (${thirdPrior.map(i => i && (i.warning || (i.action && i.action.operation))).join(', ')})`);
      assert(typeof warning.message === 'string' && warning.message.length > 0,
        '3: the no-progress evidence explains itself rather than being a bare flag');
      assert(Array.isArray(warning.repeatedListPaths) && warning.repeatedListPaths.includes(LIST_PATH),
        `3: and names the inspection it considered repeated (${JSON.stringify(warning.repeatedListPaths)})`);
      const thirdListings = thirdPrior.filter(item => item && item.action && item.action.operation === 'listDirectory');
      assert(thirdListings.length === 1,
        `3: the previous turn's inspection is carried alongside the warning (${thirdListings.length})`);
      const succeeded = thirdListings[0];
      assert(succeeded.action.args.path === LIST_PATH,
        `3: and it is the inspection that actually preceded this turn (${succeeded.action.args.path})`);
      // The SUCCESSFUL outcome, contrasted with the not_found carried at turn 2. The two
      // differ only in their recorded result, which is what makes "represented truthfully"
      // a real property rather than a restatement that some record exists.
      assert(succeeded.result && Array.isArray(succeeded.result.entries) && succeeded.result.entries.length > 0,
        `3: carrying the entries it found (${JSON.stringify(succeeded.result)})`);

      // `previousActionResults` means the PREVIOUS turn, not a cumulative transcript:
      // `actionResults` is reset per turn (server.js ~19293). Pinned explicitly, because
      // a future change to cumulative history would alter what the model is told and
      // should be a deliberate decision rather than a silent drift.
      assert(!thirdPrior.some(item => item && item.action && item.action.args &&
             item.action.args.path === MISSING_PATH),
        '3: evidence is the previous turn\'s, not an accumulating transcript');

      // ── 4. POSITIVE CONTROL — the model USED the evidence to avoid repeating ─
      // The whole point of carrying evidence: the third turn wrote instead of inspecting
      // a third time. Because the stub branches on the evidence, this is only reachable
      // if the runtime genuinely delivered it.
      scenariosRun += 1;
      assert(fs.existsSync(path.join(workspaceRoot, OUTPUT_FILE)),
        '4: the third turn performed the write it had been unable to justify before');
      assert(fs.readFileSync(path.join(workspaceRoot, OUTPUT_FILE), 'utf8') === OUTPUT_CONTENT,
        '4: with the intended content');
      assert(subjectPrompts.length === 3,
        `4: the run converged in exactly three turns — inspection twice, then the write (${subjectPrompts.length})`);

      // ── 5. NEGATIVE CONTROL — no cross-run or cross-ticket leakage ──────────
      scenariosRun += 1;
      // Scoped to CARRIED EVIDENCE, not the raw prompt. Both runs share one workspace, so
      // the decoy's file legitimately appears in the subject's workspace snapshot — that
      // is the filesystem being described truthfully, not leakage. Leakage would be the
      // decoy's OPERATION RECORDS turning up in the subject's previousActionResults,
      // which is what would make the subject believe it had done that work.
      const leaked = subjectPrompts.filter(entry =>
        JSON.stringify(entry.previousActionResults).includes(DECOY_MARKER));
      assert(leaked.length === 0,
        `5: no action evidence from the concurrent decoy run reached the subject's carried evidence (${leaked.length} leaked)`);
      const decoyLeakedIn = subjectPrompts.filter(entry =>
        entry.previousActionResults.some(item => item && item.action && item.action.args &&
          String(item.action.args.path || '').includes(DECOY_MARKER)));
      assert(decoyLeakedIn.length === 0,
        '5: and no decoy operation appears as one of the subject run\'s own actions');
      assert(subjectPrompts.every(entry => entry.objective === OBJECTIVE),
        '5: every captured subject prompt belongs to the subject ticket');
      const decoyPrompts = captured.filter(entry => entry.objective === DECOY_OBJECTIVE);
      assert(decoyPrompts.length > 0,
        '5: the decoy run really did execute, so its absence above is isolation and not inactivity');
      assert(decoyPrompts.every(entry =>
        !JSON.stringify(entry.previousActionResults).includes(OUTPUT_CONTENT)),
        '5: and the subject run\'s evidence did not leak into the decoy either');

      // ── 6. Replay reconstructs what the model knew at each turn ─────────────
      scenariosRun += 1;
      const replay = await store.readRunReplay(subjectRun.id);
      assert(replay && replay.snapshot, '6: the subject run has a durable replay snapshot');
      const snapshot = replay.snapshot;
      assert(Array.isArray(snapshot.parsedModelPlans) && snapshot.parsedModelPlans.length >= 3,
        `6: replay preserves every model plan, one per turn (${(snapshot.parsedModelPlans || []).length})`);
      const replayOps = (snapshot.workspaceOperations || [])
        .map(item => item && item.operation && (item.operation.operation || item.operation.name))
        .filter(Boolean);
      assert(replayOps.includes('listDirectory'),
        `6: replay records the inspection the model was later told about (${replayOps.join(', ')})`);
      assert(replayOps.filter(op => op === 'writeFile').length === 1,
        `6: and exactly one write, so the carried evidence prevented a repeat (${replayOps.filter(op => op === 'writeFile').length})`);
      assert(snapshot.terminalStatus === 'completed',
        `6: the replay agrees the run completed (${snapshot.terminalStatus})`);

      // ── 7. Prior results stay bound to the right run and step ──────────────
      scenariosRun += 1;
      // `recordRunEvent` writes to the REPLAY SNAPSHOT's events and the run log, not to
      // the ticket journal — so that is where the durable no-progress decision lives.
      const replayEvents = (snapshot.events || []).filter(event => event && event.type === 'model:no_progress');
      assert(replayEvents.length >= 1,
        `7: the no-progress decision is durable evidence, not only prompt text (${replayEvents.length})`);
      assert(Number.isInteger(replayEvents[0].step),
        `7: bound to the step that stalled (${JSON.stringify(replayEvents[0].step)})`);
      assert(Array.isArray(replayEvents[0].repeatedListPaths) &&
             replayEvents[0].repeatedListPaths.includes(LIST_PATH),
        `7: naming the repeated inspection durably, not only in the prompt (${JSON.stringify(replayEvents[0].repeatedListPaths)})`);

      // The decoy never stalled, so its replay must carry no such decision. This is what
      // proves the evidence was attributed to the run that actually produced it.
      const decoyReplay = await store.readRunReplay(decoyRun.id);
      assert(decoyReplay && decoyReplay.snapshot,
        '7: the decoy run also has a replay snapshot, so its emptiness below is meaningful');
      assert(!(decoyReplay.snapshot.events || []).some(event => event && event.type === 'model:no_progress'),
        '7: no-progress evidence was attributed to the run that actually stalled, not the other one');
      assert(decoyReplay.snapshot.runId === decoyRun.id && snapshot.runId === subjectRun.id,
        '7: each replay snapshot identifies its own run');

      const events = (await store.listTicketEvents(subjectTicket.id, { limit: 300 })).events;
      assert(events.every(event => event.runId === null || event.runId === subjectRun.id),
        '7: the subject ticket timeline carries no other run\'s events');

      assertScenariosExecuted({
        label: 'carried evidence preservation',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 40,
        minScenarios: 8
      });
      console.log(`\nPASS: carried evidence preservation — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'carried_evidence' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(capturePath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: carried evidence preservation — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
