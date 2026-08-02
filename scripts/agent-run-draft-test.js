#!/usr/bin/env node
'use strict';

// Tranche 5 — one deterministic Run-draft construction, shared by production
// and fixtures.
//
// The drift this prevents was real and expensive to find. Test fixtures
// hand-assembled a Run body and omitted `runtimeLimitsSnapshot` and
// `runtimeBudgetSnapshot`. Every suite driving the store directly passed, while
// the real scheduler crash-looped the Run: claimed, started, integrity failure
// outside the execution boundary, recovered to pending, reclaimed. Nothing
// surfaced it because no test executed the real worker.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AGENT_RUN_DRAFT_FIELDS,
  buildAgentRunDraft
} = require('../runtime/agent-run-draft');

const inputs = () => ({
  ticket: {
    id: 3, objective: 'Create folder reports/a', executionMode: 'agent',
    executionPolicy: { mode: 'assisted' }, workTypeId: null,
    workTypeSnapshot: null, acceptanceCriteria: '  do it  ',
    rerunMode: null, workflowId: null, workflowInput: null
  },
  agent: { id: 5, name: 'Worker' },
  browserTarget: null,
  workspaceRoot: '/tmp/ws',
  usesOwnedScope: true,
  ownedOutputPaths: ['reports/a/'],
  executionPolicySnapshot: { mode: 'assisted', workspaceScope: 'owned_paths' },
  processPolicySnapshot: null,
  processRuntimeCapabilitySnapshot: null,
  runtimeLimitsSnapshot: { maxRuntimeDurationMs: 120000, source: { runtimeLimitsRevision: 1 } },
  runtimeBudgetSnapshot: { version: 1, maxAttempts: 3 },
  verificationContractSnapshot: null,
  completionAuthoritySnapshot: { version: 1 },
  declaredWorkSnapshot: { objective: { text: 'x' } },
  routingSnapshot: { routeId: 'r' },
  allocationPlanId: 7,
  allocationItem: { allocationItemId: 9, allocationSubtask: 'sub' },
  structuredLeafItem: null,
  delegated: null,
  copyWorkTypeSnapshot: value => value,
  normalizeBrowserTargetSnapshot: value => value
});

const draft = buildAgentRunDraft(inputs());

// ── The required snapshots are present, which is the whole point ────────────
assert.ok(draft.runtimeLimitsSnapshot,
  'the draft carries its runtime limits snapshot');
assert.ok(draft.runtimeBudgetSnapshot,
  'the draft carries its runtime budget snapshot');
assert.equal(draft.status, 'pending');
assert.equal(draft.currentPhase, 'planning');

// ── CLOSED FIELD SET ────────────────────────────────────────────────────────
//
// A required field added to the draft cannot appear on one side only, because
// there is one draft and this asserts its exact shape.
assert.deepEqual(Object.keys(draft).sort(), [...AGENT_RUN_DRAFT_FIELDS].sort(),
  'the draft shape matches the declared closed field set exactly');

// ── Structured leaf items carry no v1 allocation subtask ────────────────────
const leafDraft = buildAgentRunDraft({
  ...inputs(),
  structuredLeafItem: { item: { allocationItemId: 9 }, sharedConstraints: [] }
});
assert.equal(leafDraft.allocationSubtask, null,
  'a structured leaf Run carries no v1 allocation subtask');
assert.equal(leafDraft.allocationItemId, 9);
assert.deepEqual(Object.keys(leafDraft).sort(), [...AGENT_RUN_DRAFT_FIELDS].sort());

// ── Owned-scope drives the workspace type ───────────────────────────────────
assert.equal(draft.executionWorkspaceType, 'main_owned_paths');
assert.equal(buildAgentRunDraft({ ...inputs(), usesOwnedScope: false })
  .executionWorkspaceType, 'main');

// ── Deterministic: same inputs, same draft ──────────────────────────────────
assert.deepEqual(buildAgentRunDraft(inputs()), draft,
  'the builder is deterministic for identical inputs');

// ── It resolves nothing ─────────────────────────────────────────────────────
const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'agent-run-draft.js'), 'utf8');
const executable = source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
for (const [label, pattern] of [
  ['environment', /process\.env/],
  ['database', /query\(|pool\./],
  ['filesystem', /require\(['"]node:fs['"]\)|readFileSync/],
  ['network', /fetch\(|https?\./],
  ['clock', /Date\.now\s*\(|new Date\(/]
]) {
  assert.equal(pattern.test(executable), false,
    `the deterministic draft builder reads no ${label}`);
}

// ── Production calls it ─────────────────────────────────────────────────────
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(server.includes("require('./runtime/agent-run-draft')"),
  'production imports the shared builder');
assert.ok(server.includes('const run = buildAgentRunDraft({'),
  'prepareAgentRunDraft constructs its draft through the shared builder');
assert.equal(/const run = \{\s*\n\s*ticketId: ticket\.id,/.test(server), false,
  'production no longer hand-assembles a second Run draft');

console.log('agent run draft test passed');
