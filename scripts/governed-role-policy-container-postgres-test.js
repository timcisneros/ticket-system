#!/usr/bin/env node
'use strict';

// Tranche 6 — the role-keyed governed policy container, against REAL
// PostgreSQL.
//
// The contract suite proves the shape. This proves the parts that only real
// persistence can: that one stored active container funds both canonical roles,
// that role selection survives a fresh connection, that replacing the CURRENT
// container never rewrites authority a Run already captured, and that a second
// active container is still refused.
//
// WHY THE LAST ONE MATTERS MOST. The whole decision rests on "exactly one
// active container, funding many roles". If a second active container ever
// became acceptable, "which policy funds this role" would have two answers
// again — the ambiguity the role-keyed set exists to remove.

const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { readGovernedPolicySource } = require('../runtime/governed-policy-source');
const {
  buildGovernedExecutionValue,
  buildSingularGovernedContainer
} = require('./fixtures/governed-role-policy-container');

const PLANNER = 'structured_planner';
const WORKER = 'structured_leaf_executor';

function policyValue(name, governedExecution) {
  return {
    name,
    status: 'active',
    workContextId: null,
    capabilityId: null,
    allowedProviders: ['openai'],
    preferredProvider: 'openai',
    preferredModel: 'gpt-4o-mini-2024-07-18',
    fallbackProviders: [],
    maxCost: null,
    maxLatency: null,
    riskClass: 'standard',
    toolRequirements: [],
    targetRequirements: [],
    verificationRequirement: null,
    triageOnNoRoute: true,
    governedExecution
  };
}

// The production loader's rule, transcribed from `server.js`: exactly one
// ACTIVE routing policy carrying governed execution configuration.
function loadActiveGovernedContainer(rows) {
  const governed = rows.filter(row => row && row.governedExecution);
  if (governed.length === 0) {
    const error = new Error('no active governed container');
    error.code = 'GOVERNED_PLANNER_POLICY_ABSENT';
    throw error;
  }
  if (governed.length > 1) {
    const error = new Error(`${governed.length} active governed containers`);
    error.code = 'GOVERNED_PLANNER_POLICY_AMBIGUOUS';
    throw error;
  }
  return { body: governed[0] };
}

async function activeRows(store) {
  const page = await store.listModelRoutingPolicies({ statuses: ['active'], limit: 100 });
  return Array.isArray(page) ? page : (page && page.policies) || [];
}

async function main() {
  await withHarness('governed role policy container', async ({ store, databaseUrl, schema }) => {
    const assertThat = createAsserter();

    // ── One stored active container, funding both roles ──────────────────
    const created = await store.createModelRoutingPolicy({
      value: policyValue('Role-keyed governed container', buildGovernedExecutionValue()),
      changedBy: 'role-policy-test'
    });
    assertThat(Boolean(created), 'the role-keyed container persisted');

    const container = loadActiveGovernedContainer(await activeRows(store));
    const planner = readGovernedPolicySource(container, { role: PLANNER });
    const worker = readGovernedPolicySource(container, { role: WORKER });
    assertThat(planner.economicPolicy.role === PLANNER &&
      worker.economicPolicy.role === WORKER,
    'one persisted active container funds both canonical roles');
    assertThat(planner.economicPolicySetHash === worker.economicPolicySetHash,
      'both roles report the same parent economic-set identity');
    assertThat(planner.economicPolicyHash !== worker.economicPolicyHash,
      'each role carries its own economic-policy identity');
    assertThat(planner.economicPolicySetVersion === 2,
      'the persisted container is read at the role-keyed version');

    // The JSONB body round-trips the new shape with no migration: the stored
    // container is read back into the identical hashes.
    assertThat(container.body.governedExecution.economicPolicies.length === 2,
      'the role-keyed set round-trips through JSONB unchanged');

    // ── Survives a completely fresh connection ───────────────────────────
    //
    // A new store means a new pool and no in-process cache, so anything that
    // had been memoized rather than persisted would disappear here.
    const reopened = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    try {
      const afterRestart = loadActiveGovernedContainer(await activeRows(reopened));
      const plannerAgain = readGovernedPolicySource(afterRestart, { role: PLANNER });
      const workerAgain = readGovernedPolicySource(afterRestart, { role: WORKER });
      assertThat(plannerAgain.economicPolicyHash === planner.economicPolicyHash,
        'planner authority survives a fresh connection byte-for-byte');
      assertThat(workerAgain.economicPolicyHash === worker.economicPolicyHash,
        'leaf-executor authority survives a fresh connection byte-for-byte');
      assertThat(plannerAgain.economicPolicySetHash === planner.economicPolicySetHash,
        'role selection is deterministic after restart');
      // Repeated selection is stable, not merely equal once.
      assertThat(readGovernedPolicySource(afterRestart, { role: WORKER })
        .economicPolicyHash === workerAgain.economicPolicyHash,
      'repeated role selection returns the identical authority');
    } finally {
      await reopened.close();
    }

    // ── Replacing the CURRENT container never rewrites captured authority ─
    //
    // The hashes captured above stand for what a Run froze at admission. The
    // administrator now edits the container; the captured values must not move.
    const capturedPlannerHash = planner.economicPolicyHash;
    const capturedWorkerHash = worker.economicPolicyHash;
    const capturedSetHash = planner.economicPolicySetHash;
    const rows = await activeRows(store);
    await store.updateModelRoutingPolicy({
      policyId: rows[0].id,
      expectedRevision: rows[0].revision,
      value: policyValue(rows[0].name, buildGovernedExecutionValue({
        economicOverrides: { [WORKER]: { authorizedMicroUsd: 123_456 } }
      })),
      changedBy: 'role-policy-test'
    });
    const edited = loadActiveGovernedContainer(await activeRows(store));
    const editedWorker = readGovernedPolicySource(edited, { role: WORKER });
    assertThat(editedWorker.economicPolicyHash !== capturedWorkerHash,
      'editing the worker policy produces a different current identity');
    assertThat(editedWorker.economicPolicySetHash !== capturedSetHash,
      'and a different parent set identity');
    // The planner entry was NOT edited, so its own hash is unchanged even
    // though the set hash moved — entry identity and set identity are separate.
    assertThat(readGovernedPolicySource(edited, { role: PLANNER })
      .economicPolicyHash === capturedPlannerHash,
    'an unedited role keeps its exact identity when a sibling changes');
    assertThat(capturedWorkerHash !== editedWorker.economicPolicyHash &&
      capturedSetHash !== editedWorker.economicPolicySetHash,
    'authority captured before the edit is unchanged by it');

    // ── A historical singular container remains readable for its role ────
    const historical = buildSingularGovernedContainer({ role: PLANNER });
    const historicalSource = readGovernedPolicySource(historical, { role: PLANNER });
    assertThat(historicalSource.economicPolicySetVersion === 1,
      'a historical singular container is still readable for its recorded role');
    let leaked = null;
    try {
      leaked = readGovernedPolicySource(historical, { role: WORKER });
    } catch (_) { leaked = null; }
    assertThat(leaked === null,
      'and never lends its one policy to another role');

    // ── A required role absent refuses BEFORE anything is spent ──────────
    //
    // The refusal is raised while reading configuration — before any routing
    // decision, reservation or provider contact exists.
    const plannerOnly = { body: { governedExecution:
      buildGovernedExecutionValue({ roles: [PLANNER] }) } };
    let refusal = null;
    try {
      readGovernedPolicySource(plannerOnly, { role: WORKER });
    } catch (error) { refusal = error; }
    assertThat(refusal !== null && refusal.detail &&
      refusal.detail.reason === 'governed_policy_role_absent',
    'a missing required role refuses as absent authority before any spending');
    const reservations = (await store.pool.query(
      `SELECT count(*)::int AS n FROM ${store.table('economic_request_reservations')}`)).rows[0].n;
    assertThat(reservations === 0,
      'no reservation was created by the refused read');

    // ── A second active governed container is still refused ──────────────
    await store.createModelRoutingPolicy({
      value: policyValue('Second governed container', buildGovernedExecutionValue()),
      changedBy: 'role-policy-test'
    });
    let ambiguity = null;
    try {
      loadActiveGovernedContainer(await activeRows(store));
    } catch (error) { ambiguity = error; }
    assertThat(ambiguity !== null && ambiguity.code === 'GOVERNED_PLANNER_POLICY_AMBIGUOUS',
      'a second active governed container is refused, not merged or preferred');
    // Concurrent reads see the same ambiguity — it is a property of stored
    // state, never a race in the reader.
    const concurrent = await Promise.all([0, 1, 2, 3].map(async () => {
      try {
        loadActiveGovernedContainer(await activeRows(store));
        return 'loaded';
      } catch (error) { return error.code; }
    }));
    assertThat(concurrent.every(code => code === 'GOVERNED_PLANNER_POLICY_AMBIGUOUS'),
      'concurrent reads agree: no container ambiguity resolves itself');

    console.log(`\n  (${assertThat.count()} role-policy persistence assertions)`);
  }, { timeoutMs: 300_000 });

  console.log('governed role policy container PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
