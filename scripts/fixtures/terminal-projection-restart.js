'use strict';

// Shared fixture support for fresh-process terminal-projection proofs.
//
// DELIBERATELY NOT A SECOND RUNTIME ABSTRACTION. Starting, stopping and
// restarting a real server, logging in and issuing requests are already owned
// by `postgres-test-harness` (`startServer`, `server.stop`, `server.login`,
// `server.request`); this adds nothing there and wraps none of it. What was
// genuinely duplicated across the terminal suites is narrower and purely
// observational:
//
//   * counting the durable execution and economic facts of one Ticket, so a
//     projection can be shown to have created none of them;
//   * waiting for the scheduler to be quiet using DURABLE state rather than a
//     fixed sleep, which proves nothing about whether work is still starting.
//
// Neither function interprets terminal authority. They report rows. Every
// judgement about disposition, reason, block or replay availability stays with
// the production authorities and the suites that assert them.

// Every execution or economic fact a projection could create if it were
// misbehaving. Counted per TICKET, because a projection reads a whole batch and
// a side effect could land on any Run in it.
async function durableTerminalCounts(store, ticketId) {
  const scalar = async sql =>
    Number((await store.pool.query(sql, [ticketId])).rows[0].n);
  const runIdsSql = `SELECT id FROM ${store.table('runs')} WHERE ticket_id = $1`;

  return {
    runs: await scalar(
      `SELECT count(*) AS n FROM ${store.table('runs')} WHERE ticket_id = $1`),
    activeLeases: await scalar(
      `SELECT count(*) AS n FROM ${store.table('runs')}
        WHERE ticket_id = $1 AND lease_owner IS NOT NULL`),
    leaseEvents: await scalar(
      `SELECT count(*) AS n FROM ${store.table('events')}
        WHERE ticket_id = $1 AND type = 'run.lease_acquired'`),
    reservations: await scalar(
      `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
        WHERE run_id IN (${runIdsSql})`),
    requestOrdinals: await scalar(
      `SELECT count(DISTINCT model_request_ordinal) AS n
         FROM ${store.table('economic_request_reservations')}
        WHERE run_id IN (${runIdsSql})`),
    settlements: await scalar(
      `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
        WHERE run_id IN (${runIdsSql}) AND settlement_receipt IS NOT NULL`),
    responseReplays: await scalar(
      `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
        WHERE run_id IN (${runIdsSql}) AND response_identity IS NOT NULL`),
    receipts: await scalar(
      `SELECT count(*) AS n FROM ${store.table('operation_receipts')}
        WHERE run_id IN (${runIdsSql})`),
    consequences: await scalar(
      `SELECT count(*) AS n FROM ${store.table('run_consequences')}
        WHERE run_id IN (${runIdsSql})`),
    replaySnapshots: await scalar(
      `SELECT count(*) AS n FROM ${store.table('replay_snapshots')}
        WHERE run_id IN (${runIdsSql})`),
    events: await scalar(
      `SELECT count(*) AS n FROM ${store.table('events')} WHERE ticket_id = $1`),
    retryEvents: await scalar(
      `SELECT count(*) AS n FROM ${store.table('events')}
        WHERE ticket_id = $1 AND type IN ('run.created', 'ticket.reopened')`)
  };
}

// Names the counts that changed, so a failure says WHICH fact a projection
// invented rather than only that something moved.
function countDelta(before, after) {
  const changed = [];
  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) {
      changed.push(`${key}: ${before[key]} -> ${after[key]}`);
    }
  }
  return changed;
}

// QUIESCENCE FROM DURABLE STATE, NOT FROM A CLOCK.
//
// A fixed sleep asserts that nothing happened during an arbitrary interval,
// which is the one thing it cannot know. This waits until the Ticket's runs
// hold no lease and none is pending or running, and then requires that to stay
// true across consecutive independent reads — so a scheduler mid-claim is
// observed rather than slept through.
async function waitForSchedulerQuiescence(store, ticketId, {
  stableReads = 3,
  intervalMs = 400,
  timeoutMs = 60_000
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let last = null;
  while (Date.now() < deadline) {
    const row = (await store.pool.query(
      `SELECT
         count(*) FILTER (WHERE lease_owner IS NOT NULL) AS leased,
         count(*) FILTER (WHERE status IN ('pending', 'running')) AS active,
         max(revision) AS revision
       FROM ${store.table('runs')} WHERE ticket_id = $1`, [ticketId])).rows[0];
    const snapshot = `${row.leased}:${row.active}:${row.revision}`;
    const quiet = Number(row.leased) === 0 && Number(row.active) === 0;
    stable = quiet && snapshot === last ? stable + 1 : 0;
    last = snapshot;
    if (stable >= stableReads) return { quiet: true, snapshot };
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `scheduler did not reach durable quiescence for ticket ${ticketId} (last ${last})`);
}

// The same facts scoped to ONE Run.
//
// Ticket scope is right when every Run in the batch is terminal. It is wrong
// when a neighbour is still legitimately executing: its ordinary progress then
// shows up as drift and accuses the projection of side effects it never had.
// A terminal Run's own facts are the honest measurement in that case.
async function durableRunCounts(store, runId) {
  const scalar = async sql =>
    Number((await store.pool.query(sql, [runId])).rows[0].n);
  return {
    reservations: await scalar(
      `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1`),
    requestOrdinals: await scalar(
      `SELECT count(DISTINCT model_request_ordinal) AS n
         FROM ${store.table('economic_request_reservations')} WHERE run_id = $1`),
    settlements: await scalar(
      `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1 AND settlement_receipt IS NOT NULL`),
    responseReplays: await scalar(
      `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1 AND response_identity IS NOT NULL`),
    receipts: await scalar(
      `SELECT count(*) AS n FROM ${store.table('operation_receipts')} WHERE run_id = $1`),
    consequences: await scalar(
      `SELECT count(*) AS n FROM ${store.table('run_consequences')} WHERE run_id = $1`),
    replaySnapshots: await scalar(
      `SELECT count(*) AS n FROM ${store.table('replay_snapshots')} WHERE run_id = $1`),
    leaseEvents: await scalar(
      `SELECT count(*) AS n FROM ${store.table('events')}
        WHERE run_id = $1 AND type = 'run.lease_acquired'`),
    events: await scalar(
      `SELECT count(*) AS n FROM ${store.table('events')} WHERE run_id = $1`),
    activeLease: await scalar(
      `SELECT count(*) AS n FROM ${store.table('runs')}
        WHERE id = $1 AND lease_owner IS NOT NULL`),
    revision: await scalar(
      `SELECT revision AS n FROM ${store.table('runs')} WHERE id = $1`)
  };
}

module.exports = {
  durableRunCounts,
  durableTerminalCounts,
  countDelta,
  waitForSchedulerQuiescence
};
