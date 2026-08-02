#!/usr/bin/env node
'use strict';
// Run Detail permissioned cross-ticket delete audit — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Contract under test, unchanged from the JSON-era original: when a run deletes an
// artifact another ticket produced BECAUSE its delegated user held
// workspace.delete.cross_ticket_artifact, the run detail page must show that fact —
// the permission used, the audit event type, the prior owner ticket and run, the
// requesting run, the delegated actor and permission source, and the deleted path.
//
// The negative half is the load-bearing half. The block must appear ONLY for a run
// that actually exercised the permission: not on the owner run that merely created
// the artifact, and not on a delete that was BLOCKED for lacking the permission.
// A block that renders unconditionally would be worse than no block at all, because
// it would attest to an authorization that never happened.
//
// Repaired, not rewritten. The model-free `#ACTIONS=` fetch stub is preserved. Agents
// and the restricted principal now come from the store's access APIs, and tickets and
// runs are read through the store instead of from a DATA_DIR the PostgreSQL server no
// longer reads.
//
// Scope boundary: concurrency-conflict-test.js owns whether the GATE behaves
// correctly and whether the audit EVENT is written. This suite owns only what the run
// detail page DISPLAYS about it.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const RESTRICTED_PASSWORD = 'restricted-password-delete-audit';
const AUDIT_HEADING = '<h2>Permissioned Cross-Ticket Delete</h2>';

const assert = createAsserter();

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `pd-audit-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-pd-audit']]),
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
    await withHarness('run detail permissioned delete audit', async ({ store, workspaceRoot, startServer }) => {
      const agents = [];
      for (let i = 0; i < 2; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `PD Audit Agent ${i} ${STAMP}`, provider: 'openai', model: `fake-openai-${i}`, apiKey: `fake-key-pd-${i}` },
          groupIds: [], changedBy: 'run-detail-permissioned-delete-audit-test'
        })).agent.id);
      }

      const restrictedGroup = (await store.createGroup({
        value: {
          name: `Restricted Operators ${STAMP}`,
          permissions: ['ticket:create', 'ticket:read', 'ticket:update'],
          canReceiveTickets: false
        },
        changedBy: 'run-detail-permissioned-delete-audit-test'
      })).group;
      await store.createUser({
        value: { username: 'restricted', passwordHash: await argon2.hash(RESTRICTED_PASSWORD) },
        groupIds: [restrictedGroup.id],
        changedBy: 'run-detail-permissioned-delete-audit-test'
      });

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const adminCookie = await server.login();
      const restrictedCookie = await server.login('restricted', RESTRICTED_PASSWORD);

      const objectiveWith = (tag, plan) => `pd-audit ${tag} ${STAMP} #ACTIONS=${encodeActions(plan)}`;

      async function runTicket(cookie, agentId, objective) {
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

      // Owner ticket produces the artifact; a DIFFERENT ticket deletes it, which is
      // what makes the delete cross-ticket.
      async function deleteFlow(deleterCookie, target, tag) {
        const owner = await runTicket(adminCookie, agents[0], objectiveWith(`${tag}Owner`, {
          actions: [{ operation: 'writeFile', args: { path: target, content: 'CD' } }], complete: true
        }));
        if (owner.run.status !== 'completed') {
          throw new Error(`${tag}: owner run did not complete (${owner.run.status}: ${owner.run.error})`);
        }
        const deleter = await runTicket(deleterCookie, agents[1], objectiveWith(`${tag}Del`, {
          actions: [{ operation: 'deletePath', args: { path: target } }], complete: true
        }));
        return { owner, deleter };
      }

      const pageFor = async (runId, mustContain) => waitFor(async () => {
        const page = await server.request('GET', `/runs/${runId}`, { cookie: adminCookie });
        if (page.statusCode !== 200) return null;
        if (mustContain && !page.body.includes(mustContain)) return null;
        return page;
      }, 20000, `run detail page for run ${runId}`);

      // ── 1. Permitted delete: the block renders with full provenance ─────────
      const permitPath = `pd-permit/CD-${STAMP}.txt`;
      const permitted = await deleteFlow(adminCookie, permitPath, 'permit');
      assert(permitted.deleter.run.status === 'completed',
        `1: the permissioned delete run completed (${permitted.deleter.run.status}: ${permitted.deleter.run.error})`);

      const permPage = await pageFor(permitted.deleter.run.id, AUDIT_HEADING);
      const body = permPage.body;
      assert(body.includes(AUDIT_HEADING), '1: the page shows the permissioned cross-ticket delete block');
      assert(body.includes('workspace.delete.cross_ticket_artifact'), '1: the block names the permission used');
      assert(body.includes('workspace.cross_ticket_delete_authorized'), '1: the block names the audit event type');
      assert(body.includes(`#${permitted.owner.ticket.id}`), '1: the block identifies the prior owner ticket');
      assert(body.includes(`#${permitted.owner.run.id}`), '1: the block identifies the prior owner run');
      assert(body.includes(`#${permitted.deleter.run.id}`), '1: the block identifies the requesting run');
      assert(body.includes('admin'), '1: the block names the delegated actor');
      assert(body.includes('created_from_ticket'), '1: the block names the delegated permission source');
      assert(body.includes(permitPath), '1: the block names the deleted path');

      // ── 2. The owner run never exercised the permission ────────────────────
      const ownerPage = await server.request('GET', `/runs/${permitted.owner.run.id}`, { cookie: adminCookie });
      assert(ownerPage.statusCode === 200, `2: the owner run page renders (HTTP ${ownerPage.statusCode})`);
      assert(!ownerPage.body.includes(AUDIT_HEADING),
        '2: a run that only created the artifact shows no permissioned-delete block');

      // ── 3. A blocked delete must not attest to an authorization ────────────
      const blockPath = `pd-block/CD-${STAMP}.txt`;
      const blocked = await deleteFlow(restrictedCookie, blockPath, 'block');
      assert(blocked.deleter.run.status === 'failed'
        && /conflict|previously produced/i.test(String(blocked.deleter.run.error || '')),
        `3: the unpermissioned delete failed with a conflict (${blocked.deleter.run.status}: ${blocked.deleter.run.error})`);

      const blockedPage = await server.request('GET', `/runs/${blocked.deleter.run.id}`, { cookie: adminCookie });
      assert(blockedPage.statusCode === 200, `3: the blocked run page renders (HTTP ${blockedPage.statusCode})`);
      assert(!blockedPage.body.includes(AUDIT_HEADING),
        '3: a delete blocked for lacking the permission shows no permissioned-delete block');
      assert(!blockedPage.body.includes('workspace.cross_ticket_delete_authorized'),
        '3: a blocked delete never names the authorization event');

      console.log(`\nPASS: run detail permissioned-delete audit — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'pd_delete_audit' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: run detail permissioned-delete audit — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
