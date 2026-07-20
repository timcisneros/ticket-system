#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  BUILTIN_PERMISSIONS,
  REQUIRED_ACCESS_CATALOG_REPOSITORY_METHODS,
  AccessCatalogConflictError,
  AccessCatalogNameConflictError,
  AccessCatalogReferenceError,
  compareCatalogNames,
  assertAccessCatalogRepository
} = require('../persistence/access-catalog');
const { JsonAccessCatalogRepository } = require('../persistence/json/access-catalog-repository');
const { JsonConfiguredAgentRepository } = require('../persistence/json/configured-agent-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const NOW = '2026-07-19T12:00:00.000Z';

function user(id, username, revision = 1) {
  return {
    id,
    username,
    passwordHash: `hash-${username}`,
    type: 'user',
    revision,
    createdAt: '2026-07-01T00:00:00.000Z',
    changedBy: 'seed',
    changedAt: '2026-07-01T00:00:00.000Z'
  };
}

function group(id, name, permissions = [], canReceiveTickets = false, revision = 1) {
  return {
    id,
    name,
    permissions,
    canReceiveTickets,
    revision,
    createdAt: '2026-07-01T00:00:00.000Z',
    changedBy: 'seed',
    changedAt: '2026-07-01T00:00:00.000Z'
  };
}

function createHarness({ empty = false, appendSystemLog = null, maxQueryRows = 40 } = {}) {
  let users = empty ? [] : [user(1, 'admin'), user(2, 'operator')];
  let groups = empty ? [] : [
    group(10, 'Administrators', ['ticket:create', 'ops:read']),
    group(20, 'Agent Support', [], true)
  ];
  let memberships = empty ? [] : [
    { id: 1, principalType: 'user', principalId: 1, groupId: 10 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 20 },
    { id: 3, principalType: 'agent', principalId: 7, groupId: 20 }
  ];
  let tickets = [];
  const logs = [];
  const repository = new JsonAccessCatalogRepository({
    readUsers: () => structuredClone(users),
    writeUsers: value => { users = structuredClone(value); },
    readGroups: () => structuredClone(groups),
    writeGroups: value => { groups = structuredClone(value); },
    readMemberships: () => structuredClone(memberships),
    writeMemberships: value => { memberships = structuredClone(value); },
    readPermissions: () => [...BUILTIN_PERMISSIONS],
    readTickets: () => structuredClone(tickets),
    appendSystemLog: appendSystemLog || (entry => {
      const log = { id: logs.length + 1, ...structuredClone(entry) };
      logs.push(log);
      return log;
    }),
    now: () => new Date(NOW),
    maxQueryRows
  });
  return {
    repository,
    logs,
    users: () => structuredClone(users),
    groups: () => structuredClone(groups),
    memberships: () => structuredClone(memberships),
    setTickets: value => { tickets = structuredClone(value); },
    addMembership: value => { memberships.push(structuredClone(value)); }
  };
}

async function main() {
  const harness = createHarness();
  const { repository, logs } = harness;

  assert.deepEqual(REQUIRED_ACCESS_CATALOG_REPOSITORY_METHODS, [
    'listUsers',
    'getUserById',
    'getUserByUsername',
    'listGroups',
    'getGroupById',
    'getGroupsByIds',
    'listPermissions',
    'listUserGroupMemberships',
    'getUserAuthorization',
    'createUser',
    'updateUser',
    'deleteUser',
    'createGroup',
    'updateGroup',
    'deleteGroup',
    'ensureBootstrapAccess'
  ]);
  assert.equal(assertAccessCatalogRepository(repository), repository);
  assert.equal(
    assertAccessCatalogRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the access-catalog contract'
  );
  assert.throws(() => assertAccessCatalogRepository({}), /must implement listUsers/);

  const firstUsers = await repository.listUsers({ limit: 1 });
  assert.deepEqual(firstUsers.users.map(item => item.id), [1]);
  assert.equal(firstUsers.nextAfterId, 1);
  assert.deepEqual((await repository.listUsers({ afterId: 1, limit: 1 })).users.map(item => item.id), [2]);
  assert.equal((await repository.getUserByUsername('operator')).id, 2);
  assert.equal(await repository.getUserById(999), null);
  assert.deepEqual((await repository.listGroups({ canReceiveTickets: true, limit: 2 })).groups.map(item => item.id), [20]);
  assert.deepEqual((await repository.getGroupsByIds({ groupIds: [20, 10] })).map(item => item.id), [10, 20]);
  assert.deepEqual((await repository.listUserGroupMemberships({ limit: 5 })).memberships, [
    { userId: 1, groupId: 10 },
    { userId: 2, groupId: 20 }
  ]);
  assert.deepEqual((await repository.getUserAuthorization(1)).permissions, ['ops:read', 'ticket:create']);
  await assert.rejects(repository.listUsers({ limit: 41 }), /configured maximum/);

  const createdGroup = await repository.createGroup({
    value: { name: 'Reviewers', permissions: ['ticket:read'], canReceiveTickets: true },
    changedBy: 'operator'
  });
  assert.equal(createdGroup.group.id, 21);
  assert.equal(createdGroup.group.revision, 1);
  assert.equal(logs.at(-1).type, 'admin:group_create');
  await assert.rejects(
    repository.createGroup({ value: { name: 'Reviewers' }, changedBy: 'operator' }),
    error => error instanceof AccessCatalogNameConflictError && error.code === 'GROUP_NAME_CONFLICT'
  );
  await assert.rejects(
    repository.createGroup({ value: { name: 'Invalid', permissions: ['permission:not-real'] }, changedBy: 'operator' }),
    error => error instanceof AccessCatalogReferenceError && error.code === 'PERMISSION_NOT_FOUND'
  );

  const createdUser = await repository.createUser({
    value: { username: 'reviewer', passwordHash: 'hash-reviewer' },
    groupIds: [21],
    changedBy: 'operator'
  });
  assert.equal(createdUser.user.id, 3);
  assert.deepEqual(createdUser.user.groupIds, [21]);
  assert.deepEqual((await repository.getUserAuthorization(3)).permissions, ['ticket:read']);
  assert.equal(logs.at(-1).type, 'admin:user_create');
  await assert.rejects(
    repository.createUser({ value: { username: 'reviewer', passwordHash: 'other' }, changedBy: 'operator' }),
    error => error instanceof AccessCatalogNameConflictError && error.code === 'USER_NAME_CONFLICT'
  );

  const updatedUser = await repository.updateUser({
    userId: 3,
    expectedRevision: 1,
    value: { username: 'review-lead', passwordHash: 'hash-reviewer' },
    groupIds: [10, 21],
    changedBy: 'operator-2'
  });
  assert.equal(updatedUser.user.revision, 2);
  assert.deepEqual(updatedUser.user.groupIds, [10, 21]);
  await assert.rejects(
    repository.updateUser({
      userId: 3,
      expectedRevision: 1,
      value: { username: 'stale', passwordHash: 'hash' },
      changedBy: 'stale'
    }),
    error => error instanceof AccessCatalogConflictError && error.current.revision === 2
  );

  harness.setTickets([{ id: 1, assignmentTargetType: 'group', assignmentTargetId: 21 }]);
  await assert.rejects(
    repository.updateGroup({
      groupId: 21,
      expectedRevision: 1,
      value: { name: 'Reviewers', permissions: ['ticket:read'], canReceiveTickets: false },
      changedBy: 'operator'
    }),
    error => error instanceof AccessCatalogReferenceError && error.code === 'GROUP_HAS_ASSIGNED_TICKETS'
  );
  await assert.rejects(
    repository.deleteGroup({ groupId: 21, expectedRevision: 1, changedBy: 'operator' }),
    error => error instanceof AccessCatalogReferenceError && error.code === 'GROUP_HAS_ASSIGNED_TICKETS'
  );

  harness.setTickets([]);
  harness.addMembership({ id: 99, principalType: 'agent', principalId: 8, groupId: 21 });
  const deletedGroup = await repository.deleteGroup({ groupId: 21, expectedRevision: 1, changedBy: 'operator' });
  assert.equal(deletedGroup.removedMembershipCount, 2);
  assert.equal(harness.memberships().some(item => item.groupId === 21), false);
  const deletedUser = await repository.deleteUser({ userId: 3, expectedRevision: 2, changedBy: 'operator' });
  assert.equal(deletedUser.user.username, 'review-lead');
  assert.equal(harness.memberships().some(item => item.principalType === 'user' && item.principalId === 3), false);

  const rollback = createHarness({ appendSystemLog: () => { throw new Error('audit unavailable'); } });
  const beforeGroups = rollback.groups();
  await assert.rejects(
    rollback.repository.createGroup({
      value: { name: 'Rollback', permissions: ['ticket:read'] },
      changedBy: 'operator'
    }),
    /audit unavailable/
  );
  assert.deepEqual(rollback.groups(), beforeGroups, 'JSON adapter restores the catalog when required audit evidence fails');

  let sharedUsers = [user(1, 'admin')];
  let sharedGroups = [group(10, 'Administrators', ['ticket:create'])];
  let sharedMemberships = [{ id: 1, principalType: 'user', principalId: 1, groupId: 10 }];
  let sharedAgents = [];
  let mutationTail = Promise.resolve();
  const queueMutation = operation => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.catch(() => {});
    return result;
  };
  let rejectAccessAudit;
  const accessAudit = new Promise((resolve, reject) => { rejectAccessAudit = reject; });
  const sharedAccessRepository = new JsonAccessCatalogRepository({
    readUsers: () => structuredClone(sharedUsers),
    writeUsers: value => { sharedUsers = structuredClone(value); },
    readGroups: () => structuredClone(sharedGroups),
    writeGroups: value => { sharedGroups = structuredClone(value); },
    readMemberships: () => structuredClone(sharedMemberships),
    writeMemberships: value => { sharedMemberships = structuredClone(value); },
    readPermissions: () => [...BUILTIN_PERMISSIONS],
    readTickets: () => [],
    appendSystemLog: () => accessAudit,
    queueMutation,
    now: () => new Date(NOW)
  });
  const sharedAgentRepository = new JsonConfiguredAgentRepository({
    readAgents: () => structuredClone(sharedAgents),
    writeAgents: value => { sharedAgents = structuredClone(value); },
    readGroups: () => structuredClone(sharedGroups),
    readMemberships: () => structuredClone(sharedMemberships),
    writeMemberships: value => { sharedMemberships = structuredClone(value); },
    appendSystemLog: entry => entry,
    queueMutation,
    now: () => new Date(NOW)
  });
  const failingUserCreate = sharedAccessRepository.createUser({
    value: { username: 'must-roll-back', passwordHash: 'hash' },
    groupIds: [10],
    changedBy: 'operator'
  });
  await Promise.resolve();
  const concurrentAgentCreate = sharedAgentRepository.createConfiguredAgent({
    value: { name: 'Preserved Agent', provider: 'openai', model: 'gpt-test', apiKey: '' },
    groupIds: [10],
    changedBy: 'operator'
  });
  rejectAccessAudit(new Error('access audit unavailable'));
  await assert.rejects(failingUserCreate, /access audit unavailable/);
  await concurrentAgentCreate;
  assert.equal(sharedUsers.some(item => item.username === 'must-roll-back'), false);
  assert.equal(sharedMemberships.some(item => item.principalType === 'user' && item.principalId === 2), false);
  assert.equal(sharedMemberships.some(item => item.principalType === 'agent' && item.principalId === 1), true,
    'shared mutation coordination must preserve a later agent membership after an access mutation rolls back');

  const bootstrap = createHarness({ empty: true });
  const firstBootstrap = await bootstrap.repository.ensureBootstrapAccess({ passwordHash: 'hash-admin' });
  assert.equal(firstBootstrap.changed, true);
  assert.equal(firstBootstrap.createdAdminUser, true);
  assert.equal(firstBootstrap.createdAdministratorGroup, true);
  assert.equal(firstBootstrap.createdAssignableGroup, true);
  assert.equal(firstBootstrap.createdAdminMembership, true);
  assert.deepEqual(firstBootstrap.adminGroup.permissions, [...BUILTIN_PERMISSIONS].sort(compareCatalogNames));
  assert.equal((await bootstrap.repository.ensureBootstrapAccess({ passwordHash: 'ignored' })).changed, false);

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');
  const methodsSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'access-catalog-methods.js'), 'utf8');
  const migrationSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'migrations', '019_access_catalog_authority.sql'), 'utf8');
  const routeSource = serverSource.slice(
    serverSource.indexOf("// ==================== PUBLIC ROUTES"),
    serverSource.indexOf("function dataIntegrityError")
  );
  assert.ok(serverSource.includes('new JsonAccessCatalogRepository({'));
  assert.ok(serverSource.includes('queueMutation: queuePrincipalCatalogMutation'));
  assert.ok(serverSource.includes('getAccessCatalogRepository().getUserByUsername(username)'));
  assert.ok(serverSource.includes('getAccessCatalogRepository().getUserAuthorization(userId)'));
  assert.ok(serverSource.includes('requestAuthorizationContext.run({ userId: null, permissions: [] }, done)'));
  assert.ok(serverSource.includes('await accessCatalog.ensureBootstrapAccess({'));
  for (const rawCall of ['readUsers(', 'readGroups(', 'readPermissions(', 'writeUsers(', 'writeGroups(', 'writeMemberships(']) {
    assert.equal(routeSource.includes(rawCall), false, `request and startup routes must not call ${rawCall} directly`);
  }
  assert.ok(storeSource.includes('await this._assertTicketAssignmentTarget(connection, ticket);'));
  assert.ok(methodsSource.includes('FOR SHARE'));
  assert.ok(methodsSource.includes('FOR UPDATE'));
  for (const requiredSql of [
    'CREATE TABLE access_permissions',
    'CREATE INDEX access_permissions_name_c_idx',
    'CREATE TRIGGER access_permissions_migration_owned',
    'BEFORE INSERT OR UPDATE OR DELETE ON access_permissions',
    'CREATE TABLE access_groups',
    'CREATE TABLE access_group_permissions',
    'CREATE TABLE access_users',
    'CREATE TABLE user_group_memberships',
    'ADD CONSTRAINT agent_group_memberships_group_fk',
    'ADD COLUMN assignment_group_id BIGINT GENERATED ALWAYS AS',
    'CONSTRAINT tickets_assignment_group_fk'
  ]) {
    assert.ok(migrationSource.includes(requiredSql), `access-catalog migration must include: ${requiredSql}`);
  }

  console.log('access-catalog repository contract tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
