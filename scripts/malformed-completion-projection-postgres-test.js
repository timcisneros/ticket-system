#!/usr/bin/env node
'use strict';

// Tranche 5 — `completed` is the one claim that must not survive without
// evidence.
//
// The Ticket projection was relaxed so a Run in a terminal NON-SUCCESS state no
// longer needs a completion decision: it did not get there by claiming
// anything, and demanding evidence execution never produced held whole Tickets
// hostage to one broken leaf. That relaxation is only safe while the opposite
// case stays strict, and nothing asserted it — removing the strictness failed
// no test, which is how a projection that invents success would have shipped.
//
// So this drives the real production projection against Runs whose stored
// status claims completion while their completion authority does not support
// it, and proves each is refused rather than believed.
//
// The malformed states are written directly. They cannot be produced through
// any supported path — that is the point of them — and every assertion is about
// what PRODUCTION does when it meets one.

const assert = require('node:assert/strict');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { seedGovernedStructuredTicket } = require('./governed-structured-fixture');

const STAMP = `mcp-${Date.now()}`;
const ACTOR = 'malformed-completion-projection-test';

async function main() {
  await withHarness('malformed completion projection',
    async ({ store, workspaceRoot }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        leafPostconditions: (item, owned) => [
          { type: 'folder_exists', path: `${owned}/alpha` }
        ]
      });
      const runId = seeded.runIds[0];
      const run = await store.getRun(runId);

      const project = async () => {
        try {
          await store.transitionTicketAfterRun({ runId });
          return null;
        } catch (error) {
          return error;
        }
      };

      // The Run lifecycle trigger enforces pending -> running -> terminal, so a
      // malformed terminal state is reached THROUGH `running` rather than by
      // bypassing the lifecycle. Only the completion EVIDENCE is missing, which
      // is the thing under test.
      const setRunStatus = async status => {
        const current = (await store.pool.query(
          `SELECT status FROM ${store.table('runs')} WHERE id = $1`, [runId])).rows[0].status;
        if (current !== 'running') {
          await store.pool.query(
            `UPDATE ${store.table('runs')}
                SET status = 'running',
                    current_phase = 'mutation',
                    body = body || jsonb_build_object('status', 'running'),
                    started_at = COALESCE(started_at, clock_timestamp()),
                    completed_at = NULL,
                    revision = revision + 1
              WHERE id = $1`, [runId]);
        }
        await store.pool.query(
          `UPDATE ${store.table('runs')}
              SET status = $2,
                  current_phase = 'terminalization',
                  body = body || jsonb_build_object('status', $2::text),
                  completed_at = COALESCE(completed_at, clock_timestamp()),
                  lease_owner = NULL, lease_expires_at = NULL,
                  revision = revision + 1
            WHERE id = $1`, [runId, status]);
      };
      const ticketStatus = async () => (await store.pool.query(
        `SELECT status FROM ${store.table('tickets')} WHERE id = $1`,
        [run.ticketId])).rows[0].status;

      // ── 1. `completed` with NO decision ─────────────────────────────────
      await setRunStatus('completed');
      const before = await ticketStatus();
      const missing = await project();
      assertThat(missing !== null,
        'a Run claiming completion with NO decision is REFUSED');
      assertThat(missing.code === 'COMPLETION_EVIDENCE_MISSING',
        'and refused with the canonical evidence-missing code');
      assertThat(await ticketStatus() === before,
        'the Ticket status is unchanged — no completion was projected');

      const decisionsAfter = (await store.pool.query(
        `SELECT count(*)::int AS n FROM ${store.table('run_consequences')}
          WHERE run_id = $1`, [runId])).rows[0].n;
      assertThat(decisionsAfter === 0,
        'NO synthetic completion decision was created to satisfy the check');

      // ONE CASE, NOT THREE — AND THE REASON IS ITSELF EVIDENCE.
      //
      // The intended sequence also drove the same Run to `failed` and back, to
      // contrast identical missing evidence with an opposite outcome. The
      // database refuses to build those states: a Run may not skip `running`,
      // must satisfy `runs_lifecycle_timestamps`, must carry a terminal
      // `current_phase`, and — decisively — "terminal runs cannot be reopened".
      //
      // So malformed success is not merely rejected by the projection; it is
      // hard to persist at all. That is real defense in depth and is recorded
      // rather than worked around by disabling constraints, which would have
      // proved something about a database this system does not run on.
      //
      // The non-success half of the contrast is covered where it occurs
      // naturally: governed-replay-corruption-postgres-test drives a genuinely
      // failed Run with no completion decision through this same projection and
      // proves it renders.

      console.log(`  (${assertThat.count()} malformed-completion assertions)`);
    });

  // The suite writes malformed Run STATUS deliberately — that is the scenario.
  // It never writes the completion decision that would make the claim valid,
  // which is the thing production must refuse to invent.
  const fs = require('node:fs');
  const forbidden = [
    ['recordRun', 'Consequence'],
    ['buildCompletion', 'Decision'],
    ['normalizeCompletion', 'Decision']
  ].map(parts => parts.join(''));
  const executable = fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !/^\s*\['/.test(line))
    .join('\n');
  for (const name of forbidden) {
    assert.equal(executable.includes(name), false,
      `the suite never calls ${name} — it must not manufacture the evidence under test`);
  }

  console.log('malformed completion projection PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
