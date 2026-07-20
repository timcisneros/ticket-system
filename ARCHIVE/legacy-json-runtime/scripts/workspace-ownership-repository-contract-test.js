#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonWorkspaceOwnershipRepository,
  REQUIRED_WORKSPACE_OWNERSHIP_REPOSITORY_METHODS,
  assertWorkspaceOwnershipRepository,
  normalizeWorkspaceOwnershipPath,
  workspaceArtifactPath,
  workspaceMutationFingerprint
} = require('../persistence/json/workspace-ownership-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const history = [
  {
    id: 1,
    runId: 1,
    ticketId: 10,
    operation: 'writeFile',
    args: { path: 'reports/summary.md', content: 'ready' },
    outcome: 'succeeded',
    targetId: 'local-workspace'
  },
  {
    id: 2,
    runId: 2,
    ticketId: 20,
    operation: 'createFolder',
    args: { path: 'reports/archive' },
    outcome: 'succeeded',
    targetId: 'local-workspace'
  },
  {
    id: 3,
    runId: 3,
    ticketId: 30,
    operation: 'renamePath',
    args: { path: 'draft.md', nextPath: 'reports/archive/final.md' },
    outcome: 'succeeded',
    targetId: 'local-workspace'
  },
  {
    id: 4,
    runId: 4,
    ticketId: 40,
    operation: 'writeFile',
    args: { path: 'reports/failed.md', content: 'not committed' },
    outcome: 'failed',
    error: 'write failed',
    targetId: 'local-workspace'
  },
  {
    id: 5,
    runId: 5,
    ticketId: 50,
    operation: 'writeFile',
    args: { path: 'reports/other-target.md', content: 'isolated' },
    outcome: 'succeeded',
    targetId: 'other-workspace'
  }
];

async function main() {
  assert.deepEqual(REQUIRED_WORKSPACE_OWNERSHIP_REPOSITORY_METHODS, [
    'findMutationConflict',
    'listArtifactOwners'
  ]);
  assert.equal(normalizeWorkspaceOwnershipPath('./reports//summary.md'), 'reports/summary.md');
  assert.throws(() => normalizeWorkspaceOwnershipPath('../secret'), /Unsafe workspace path/);
  assert.equal(workspaceMutationFingerprint('renamePath', { path: 'a', nextPath: 'b' }), 'renamePath:a->b');
  assert.equal(workspaceArtifactPath('renamePath', { path: 'a', nextPath: 'b' }), 'b');

  const repository = new JsonWorkspaceOwnershipRepository({
    readOperationHistory: () => structuredClone(history),
    maxQueryRows: 2
  });
  assert.equal(assertWorkspaceOwnershipRepository(repository), repository);
  assert.equal(
    assertWorkspaceOwnershipRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the ownership repository contract'
  );
  assert.throws(() => assertWorkspaceOwnershipRepository({}), /must implement findMutationConflict/);

  const conflict = await repository.findMutationConflict({
    runId: 1,
    targetId: 'local-workspace',
    operation: 'deletePath',
    args: { path: 'reports/summary.md' }
  });
  assert.equal(conflict.id, 1, 'a different same-run mutation on the source path must conflict');
  assert.equal(await repository.findMutationConflict({
    runId: 1,
    targetId: 'local-workspace',
    operation: 'writeFile',
    args: { path: 'reports/summary.md', content: 'changed' }
  }), null, 'the existing writeFile idempotency semantics must remain unchanged');
  assert.equal(await repository.findMutationConflict({
    runId: 1,
    targetId: 'local-workspace',
    operation: 'renamePath',
    args: { path: 'reports/summary.md', nextPath: 'reports/final.md' }
  }), null, 'write/create followed by rename must remain allowed');

  const exact = await repository.listArtifactOwners({
    targetId: 'local-workspace',
    candidatePath: 'reports/summary.md',
    excludeTicketId: 99,
    limit: 2
  });
  assert.deepEqual(exact.owners.map(owner => owner.id), [1]);
  assert.equal(exact.nextAfterId, null);

  const firstOverlapPage = await repository.listArtifactOwners({
    targetId: 'local-workspace',
    candidatePath: 'reports',
    overlap: true,
    excludeTicketId: 10,
    limit: 1
  });
  assert.deepEqual(firstOverlapPage.owners.map(owner => owner.id), [2]);
  assert.equal(firstOverlapPage.nextAfterId, 2);
  const secondOverlapPage = await repository.listArtifactOwners({
    targetId: 'local-workspace',
    candidatePath: 'reports',
    overlap: true,
    excludeTicketId: 10,
    afterId: firstOverlapPage.nextAfterId,
    limit: 2
  });
  assert.deepEqual(secondOverlapPage.owners.map(owner => owner.id), [3]);
  assert.equal(secondOverlapPage.nextAfterId, null);

  const ticketOwners = await repository.listArtifactOwners({
    targetId: 'local-workspace',
    candidatePath: 'reports/archive',
    overlap: true,
    ticketId: 30,
    limit: 2
  });
  assert.deepEqual(ticketOwners.owners.map(owner => owner.artifactPath), ['reports/archive/final.md']);
  assert.equal(ticketOwners.owners.some(owner => owner.id === 4), false, 'failed receipts never own artifacts');
  assert.equal(ticketOwners.owners.some(owner => owner.id === 5), false, 'target identities remain isolated');
  await assert.rejects(
    repository.listArtifactOwners({ targetId: 'local-workspace', candidatePath: 'reports', limit: 3 }),
    /configured maximum/
  );

  const root = path.resolve(__dirname, '..');
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const postgresSource = fs.readFileSync(path.join(root, 'persistence', 'postgres', 'store.js'), 'utf8');
  assert.equal((serverSource.match(/await findPersistedMutationConflict\(/g) || []).length, 4);
  assert.equal(serverSource.includes('findPriorSuccessfulArtifactOwner(readOperationHistory()'), false);
  assert.equal(serverSource.includes('findOverlappingSuccessfulArtifactOwner(readOperationHistory()'), false);
  assert.ok(serverSource.includes('getWorkspaceOwnershipRepository().listArtifactOwners({'));
  assert.ok(postgresSource.includes('async findMutationConflict({'));
  assert.ok(postgresSource.includes('async listArtifactOwners({'));
  assert.ok(postgresSource.includes("artifact_path LIKE $3 ESCAPE"));
  assert.ok(postgresSource.includes('this.targetOperationClientStorage.getStore() || this.pool'));

  console.log('PASS: workspace ownership repository — indexed authority queries preserve mutation conflicts, exact owners, overlap paging, ticket filters, and target isolation');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
