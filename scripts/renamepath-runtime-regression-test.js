#!/usr/bin/env node
'use strict';
// renamePath conflict carve-out — runtime regression, PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Contract under test, unchanged from the JSON-era original: `findConflictingMutation`
// carves renamePath out of the same-path conflict rule for the path it CONSUMES, so a
// run may create a path and then rename it away in the same batch. Every other
// same-path pairing — including a second rename of an already-consumed source — is
// still a committed-mutation conflict that fails the run.
//
// Repaired, not rewritten. The five cases and their assertions are the original ones.
// What changed is seeding and observation: the agent is created through the store, and
// run status/error are read from the store instead of from a DATA_DIR the PostgreSQL
// server no longer reads. Workspace assertions are unchanged — they were always
// filesystem facts, and they are the strongest evidence in this suite.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const CONFLICT_ERROR = 'Conflicting mutation already committed';
const assert = createAsserter();

// Model-free provider stub. Storage-independent, so it is preserved verbatim in
// shape; only the marker strings are bound to this process's stamp.
function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `rename-runtime-openai-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-rename-runtime']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  if (combined.includes('RENAME-RUNTIME-1')) {
    return okResponse({
      message: 'Create source then rename to destination.',
      actions: [
        { operation: 'writeFile', args: { path: 'source-1-${STAMP}.txt', content: 'test1' } },
        { operation: 'renamePath', args: { path: 'source-1-${STAMP}.txt', nextPath: 'dest-1-${STAMP}.txt' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-2')) {
    return okResponse({
      message: 'Create folder then rename to destination.',
      actions: [
        { operation: 'createFolder', args: { path: 'source-2-${STAMP}' } },
        { operation: 'renamePath', args: { path: 'source-2-${STAMP}', nextPath: 'dest-2-${STAMP}' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-3')) {
    return okResponse({
      message: 'Write then delete.',
      actions: [
        { operation: 'writeFile', args: { path: 'conflict-3-${STAMP}.txt', content: 'test3' } },
        { operation: 'deletePath', args: { path: 'conflict-3-${STAMP}.txt' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-4')) {
    return okResponse({
      message: 'Create folder then write file.',
      actions: [
        { operation: 'createFolder', args: { path: 'conflict-4-${STAMP}' } },
        { operation: 'writeFile', args: { path: 'conflict-4-${STAMP}', content: 'test4' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-5')) {
    return okResponse({
      message: 'Double rename.',
      actions: [
        { operation: 'renamePath', args: { path: 'source-5-${STAMP}.txt', nextPath: 'dest-5a-${STAMP}.txt' } },
        { operation: 'renamePath', args: { path: 'source-5-${STAMP}.txt', nextPath: 'dest-5b-${STAMP}.txt' } }
      ],
      complete: true
    });
  }

  return okResponse({ message: 'No matching fixture.', actions: [], complete: true });
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
  const preloadPath = createFakeOpenAIPreload();
  try {
    await withHarness('renamePath runtime regression', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `RenameRuntimeConflict-${STAMP}`,
          description: 'Mocked runtime conflict regression agent',
          provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-rename-runtime'
        },
        groupIds: [], changedBy: 'renamepath-runtime-regression-test'
      })).agent;

      // Case 5 renames a path it did not create, so the source must pre-exist.
      fs.writeFileSync(path.join(workspaceRoot, `source-5-${STAMP}.txt`), 'preseed');

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      const cookie = await server.login();

      async function runCase(marker, expectedStatus, expectedErrorContains = null) {
        const objective = `${marker} RenamePath runtime conflict regression ${STAMP}`;
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        assert(created.statusCode === 302, `${marker}: ticket create redirected (HTTP ${created.statusCode})`);

        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 200 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, `${marker} ticket persistence`);

        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 });
          return runs[0] || null;
        }, 30000, `${marker} run dispatch`);

        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 60000, `${marker} terminal run`);

        assert(terminal.status === expectedStatus,
          `${marker}: run ended as ${expectedStatus} (error: ${terminal.error || 'none'})`);
        if (expectedErrorContains) {
          assert(Boolean(terminal.error) && terminal.error.includes(expectedErrorContains),
            `${marker}: failure names the committed-mutation conflict`);
        }
        return terminal;
      }

      const exists = rel => fs.existsSync(path.join(workspaceRoot, rel));

      // ── Case 1 — writeFile(source) then renamePath(source → dest) ────────────
      // The carve-out: the rename consumes a path this run created, which is not a
      // conflict because the source no longer exists afterwards.
      await runCase('RENAME-RUNTIME-1', 'completed');
      assert(!exists(`source-1-${STAMP}.txt`), '1: the renamed source file is gone');
      assert(exists(`dest-1-${STAMP}.txt`), '1: the rename destination file exists');

      // ── Case 2 — createFolder(source) then renamePath(source → dest) ─────────
      await runCase('RENAME-RUNTIME-2', 'completed');
      assert(!exists(`source-2-${STAMP}`), '2: the renamed source folder is gone');
      assert(exists(`dest-2-${STAMP}`), '2: the rename destination folder exists');

      // ── Case 3 — writeFile(path) then deletePath(path) ───────────────────────
      // deletePath is NOT carved out: the run already committed a mutation at that
      // path, so the second mutation conflicts.
      await runCase('RENAME-RUNTIME-3', 'failed', CONFLICT_ERROR);
      assert(exists(`conflict-3-${STAMP}.txt`),
        '3: the committed write survived — the conflicting delete never executed');

      // ── Case 4 — createFolder(path) then writeFile(path) ─────────────────────
      await runCase('RENAME-RUNTIME-4', 'failed', CONFLICT_ERROR);
      assert(fs.statSync(path.join(workspaceRoot, `conflict-4-${STAMP}`)).isDirectory(),
        '4: the committed folder was not overwritten by the conflicting write');

      // ── Case 5 — renamePath(source → a) then renamePath(source → b) ──────────
      // The carve-out must not extend to renaming an already-consumed source. The
      // first rename must have landed and the second must never have run.
      await runCase('RENAME-RUNTIME-5', 'failed', CONFLICT_ERROR);
      assert(exists(`dest-5a-${STAMP}.txt`), '5: the first rename destination exists');
      assert(!exists(`dest-5b-${STAMP}.txt`), '5: the second rename never produced a destination');
      assert(!exists(`source-5-${STAMP}.txt`), '5: the source was consumed exactly once');

      console.log(`\nPASS: renamePath runtime conflict regression — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'renamepath_runtime' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: renamePath runtime conflict regression — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
