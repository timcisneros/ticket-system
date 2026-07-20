'use strict';

const {
  BUILTIN_PERMISSIONS,
  AccessCatalogConflictError,
  AccessCatalogNameConflictError,
  AccessCatalogReferenceError,
  assertAccessCatalogRepository,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  requiredString,
  compareCatalogNames,
  normalizeIds,
  normalizePermissionNames
} = require('../access-catalog');

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function normalizeUser(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const revision = record.revision === undefined ? 1 : positiveSafeInteger(record.revision, 'user.revision');
  return {
    ...structuredClone(record),
    id: positiveSafeInteger(record.id, 'user.id'),
    username: requiredString(record.username, 'user.username'),
    passwordHash: requiredString(record.passwordHash, 'user.passwordHash'),
    type: 'user',
    revision,
    createdAt: validTimestamp(record.createdAt),
    changedBy: record.changedBy == null ? null : String(record.changedBy),
    changedAt: validTimestamp(record.changedAt || record.createdAt)
  };
}

function normalizeGroup(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const revision = record.revision === undefined ? 1 : positiveSafeInteger(record.revision, 'group.revision');
  return {
    ...structuredClone(record),
    id: positiveSafeInteger(record.id, 'group.id'),
    name: requiredString(record.name, 'group.name'),
    permissions: Array.isArray(record.permissions) ? [...new Set(record.permissions.map(value => requiredString(value, 'group.permission')))].sort(compareCatalogNames) : [],
    canReceiveTickets: record.canReceiveTickets === true,
    revision,
    createdAt: validTimestamp(record.createdAt),
    changedBy: record.changedBy == null ? null : String(record.changedBy),
    changedAt: validTimestamp(record.changedAt || record.createdAt)
  };
}

function normalizeMembership(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const principalType = record.principalType === 'agent' ? 'agent' : record.principalType === 'user' ? 'user' : null;
  if (!principalType) return null;
  return {
    ...structuredClone(record),
    principalType,
    principalId: positiveSafeInteger(record.principalId ?? record.userId, 'membership.principalId'),
    groupId: positiveSafeInteger(record.groupId, 'membership.groupId')
  };
}

class JsonAccessCatalogRepository {
  constructor({
    readUsers,
    writeUsers,
    readGroups,
    writeGroups,
    readMemberships,
    writeMemberships,
    readPermissions,
    readTickets,
    appendSystemLog,
    queueMutation = null,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readUsers = requiredFunction(readUsers, 'readUsers');
    this.writeUsers = requiredFunction(writeUsers, 'writeUsers');
    this.readGroups = requiredFunction(readGroups, 'readGroups');
    this.writeGroups = requiredFunction(writeGroups, 'writeGroups');
    this.readMemberships = requiredFunction(readMemberships, 'readMemberships');
    this.writeMemberships = requiredFunction(writeMemberships, 'writeMemberships');
    this.readPermissions = requiredFunction(readPermissions, 'readPermissions');
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.mutationTail = Promise.resolve();
    this.queueMutation = queueMutation === null
      ? operation => {
          const result = this.mutationTail.then(operation, operation);
          this.mutationTail = result.catch(() => {});
          return result;
        }
      : requiredFunction(queueMutation, 'queueMutation');
  }

  _boundedLimit(limit) {
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    return size;
  }

  _rawUsers() { return structuredClone(this.readUsers()); }
  _rawGroups() { return structuredClone(this.readGroups()); }
  _rawMemberships() { return structuredClone(this.readMemberships()); }
  _users() { return this._rawUsers().map(normalizeUser).filter(Boolean); }
  _groups() { return this._rawGroups().map(normalizeGroup).filter(Boolean); }
  _memberships() { return this._rawMemberships().map(normalizeMembership).filter(Boolean); }

  _permissions() {
    const permissions = [...BUILTIN_PERMISSIONS];
    const configured = this.readPermissions();
    if (!Array.isArray(configured)) throw new TypeError('permissions catalog must be an array');
    for (const value of configured) {
      const permission = requiredString(value, 'permission');
      if (!permissions.includes(permission)) permissions.push(permission);
    }
    return permissions.sort(compareCatalogNames);
  }

  _queueMutation(operation) {
    return this.queueMutation(operation);
  }

  _validateGroupIds(groupIds, groups = this._groups()) {
    const ids = normalizeIds(groupIds, 'groupIds', this.maxQueryRows);
    const available = new Set(groups.map(group => group.id));
    const missing = ids.find(id => !available.has(id));
    if (missing) throw new AccessCatalogReferenceError(`Group does not exist: ${missing}`, 'GROUP_NOT_FOUND');
    return ids;
  }

  _nextUserMemberships(rawMemberships, userId, groupIds, deleting = false) {
    const retained = rawMemberships.filter(item => {
      const membership = normalizeMembership(item);
      return !membership || membership.principalType !== 'user' || membership.principalId !== userId;
    });
    if (deleting) return retained;
    let nextId = retained.reduce((maximum, item) => {
      const id = Number(item && item.id);
      return Number.isSafeInteger(id) && id > maximum ? id : maximum;
    }, 0) + 1;
    return [...retained, ...groupIds.map(groupId => ({
      id: nextId++, principalType: 'user', principalId: userId, groupId
    }))];
  }

  async _writeWithAudit({
    nextUsers,
    nextGroups,
    nextMemberships,
    rollbackUsers,
    rollbackGroups,
    rollbackMemberships,
    audit = null
  }) {
    try {
      if (nextUsers !== undefined) this.writeUsers(nextUsers);
      if (nextGroups !== undefined) this.writeGroups(nextGroups);
      if (nextMemberships !== undefined) this.writeMemberships(nextMemberships);
      const auditLog = audit ? await this.appendSystemLog(audit) : null;
      return auditLog;
    } catch (error) {
      try { if (nextUsers !== undefined) this.writeUsers(rollbackUsers); } catch (_) {}
      try { if (nextGroups !== undefined) this.writeGroups(rollbackGroups); } catch (_) {}
      try { if (nextMemberships !== undefined) this.writeMemberships(rollbackMemberships); } catch (_) {}
      throw error;
    }
  }

  async listUsers({ afterId = 0, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = this._boundedLimit(limit);
    const matches = this._users().filter(user => user.id > cursor).sort((a, b) => a.id - b.id).slice(0, size + 1);
    const users = matches.slice(0, size);
    return { users, nextAfterId: matches.length > size && users.length ? users[users.length - 1].id : null };
  }

  async getUserById(userId) {
    const id = positiveSafeInteger(userId, 'userId');
    const user = this._users().find(item => item.id === id) || null;
    if (!user) return null;
    const groupIds = this._memberships().filter(item => item.principalType === 'user' && item.principalId === id).map(item => item.groupId);
    if (groupIds.length > this.maxQueryRows) throw new RangeError(`user ${id} group memberships exceed the configured maximum`);
    return { ...user, groupIds: [...new Set(groupIds)].sort((a, b) => a - b) };
  }

  async getUserByUsername(username) {
    const name = requiredString(username, 'username');
    const user = this._users().find(item => item.username === name) || null;
    return user ? this.getUserById(user.id) : null;
  }

  async listGroups({ afterId = 0, canReceiveTickets = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = this._boundedLimit(limit);
    if (canReceiveTickets !== null && typeof canReceiveTickets !== 'boolean') throw new TypeError('canReceiveTickets must be a boolean or null');
    const matches = this._groups()
      .filter(group => group.id > cursor && (canReceiveTickets === null || group.canReceiveTickets === canReceiveTickets))
      .sort((a, b) => a.id - b.id)
      .slice(0, size + 1);
    const groups = matches.slice(0, size);
    return { groups, nextAfterId: matches.length > size && groups.length ? groups[groups.length - 1].id : null };
  }

  async getGroupById(groupId) {
    const id = positiveSafeInteger(groupId, 'groupId');
    return this._groups().find(group => group.id === id) || null;
  }

  async getGroupsByIds({ groupIds }) {
    const ids = normalizeIds(groupIds, 'groupIds', this.maxQueryRows, { allowEmpty: false });
    const allowed = new Set(ids);
    return this._groups().filter(group => allowed.has(group.id)).sort((a, b) => a.id - b.id);
  }

  async listPermissions({ afterName = '', limit = 100 } = {}) {
    const cursor = String(afterName || '');
    const size = this._boundedLimit(limit);
    const matches = this._permissions().filter(name => name > cursor).slice(0, size + 1);
    const permissions = matches.slice(0, size);
    return { permissions, nextAfterName: matches.length > size && permissions.length ? permissions[permissions.length - 1] : null };
  }

  async listUserGroupMemberships({ afterUserId = 0, afterGroupId = 0, userIds = null, groupIds = null, limit = 100 } = {}) {
    const userCursor = nonNegativeSafeInteger(afterUserId, 'afterUserId');
    const groupCursor = nonNegativeSafeInteger(afterGroupId, 'afterGroupId');
    const size = this._boundedLimit(limit);
    const allowedUsers = userIds == null ? null : new Set(normalizeIds(userIds, 'userIds', this.maxQueryRows, { allowEmpty: false }));
    const allowedGroups = groupIds == null ? null : new Set(normalizeIds(groupIds, 'groupIds', this.maxQueryRows, { allowEmpty: false }));
    const matches = this._memberships()
      .filter(item => item.principalType === 'user')
      .filter(item => item.principalId > userCursor || (item.principalId === userCursor && item.groupId > groupCursor))
      .filter(item => !allowedUsers || allowedUsers.has(item.principalId))
      .filter(item => !allowedGroups || allowedGroups.has(item.groupId))
      .sort((a, b) => a.principalId - b.principalId || a.groupId - b.groupId)
      .slice(0, size + 1);
    const memberships = matches.slice(0, size).map(item => ({ userId: item.principalId, groupId: item.groupId }));
    const last = memberships[memberships.length - 1] || null;
    return {
      memberships,
      nextCursor: matches.length > size && last ? { afterUserId: last.userId, afterGroupId: last.groupId } : null
    };
  }

  async getUserAuthorization(userId) {
    const user = await this.getUserById(userId);
    if (!user) return null;
    const groups = this._groups().filter(group => user.groupIds.includes(group.id)).sort((a, b) => a.id - b.id);
    if (groups.length > this.maxQueryRows) throw new RangeError(`user ${user.id} authorization exceeds the configured maximum`);
    const permissions = [...new Set(groups.flatMap(group => group.permissions))].sort(compareCatalogNames);
    return { user, groupIds: user.groupIds, groups, permissions };
  }

  createUser(options) { return this._queueMutation(() => this._createUser(options)); }
  async _createUser({ value, groupIds = [], changedBy }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('value must be an object');
    const username = requiredString(value.username, 'value.username');
    const passwordHash = requiredString(value.passwordHash, 'value.passwordHash');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackUsers = this._rawUsers();
    const rollbackMemberships = this._rawMemberships();
    const users = rollbackUsers.map(normalizeUser).filter(Boolean);
    const groups = this._validateGroupIds(groupIds);
    if (users.some(user => user.username === username)) throw new AccessCatalogNameConflictError('user', username);
    const changedAt = this.now().toISOString();
    const user = {
      id: users.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
      username,
      passwordHash,
      type: 'user',
      revision: 1,
      createdAt: changedAt,
      changedBy: actor,
      changedAt
    };
    const nextMemberships = this._nextUserMemberships(rollbackMemberships, user.id, groups);
    const auditLog = await this._writeWithAudit({
      nextUsers: [...users, user], nextMemberships, rollbackUsers, rollbackMemberships,
      audit: {
        type: 'admin:user_create',
        message: `User \"${username}\" created by ${actor}`,
        metadata: { changedBy: actor, changedAt, userId: user.id, username }
      }
    });
    return { user: { ...user, groupIds: groups }, auditLog };
  }

  updateUser(options) { return this._queueMutation(() => this._updateUser(options)); }
  async _updateUser({ userId, expectedRevision, value, groupIds = [], changedBy }) {
    const id = positiveSafeInteger(userId, 'userId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('value must be an object');
    const username = requiredString(value.username, 'value.username');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackUsers = this._rawUsers();
    const rollbackMemberships = this._rawMemberships();
    const users = rollbackUsers.map(normalizeUser).filter(Boolean);
    const index = users.findIndex(user => user.id === id);
    if (index === -1) return null;
    if (users[index].revision !== revision) throw new AccessCatalogConflictError('user', id, revision, users[index]);
    if (users.some(user => user.username === username && user.id !== id)) throw new AccessCatalogNameConflictError('user', username);
    const groups = this._validateGroupIds(groupIds);
    const changedAt = this.now().toISOString();
    const previous = users[index];
    const user = {
      ...previous,
      username,
      passwordHash: value.passwordHash ? requiredString(value.passwordHash, 'value.passwordHash') : previous.passwordHash,
      revision: revision + 1,
      changedBy: actor,
      changedAt
    };
    const nextUsers = users.slice();
    nextUsers[index] = user;
    const nextMemberships = this._nextUserMemberships(rollbackMemberships, id, groups);
    const auditLog = await this._writeWithAudit({
      nextUsers, nextMemberships, rollbackUsers, rollbackMemberships,
      audit: {
        type: 'admin:user_edit',
        message: `User \"${username}\" (#${id}) edited by ${actor}`,
        metadata: { changedBy: actor, changedAt, userId: id, username }
      }
    });
    return { user: { ...user, groupIds: groups }, auditLog };
  }

  deleteUser(options) { return this._queueMutation(() => this._deleteUser(options)); }
  async _deleteUser({ userId, expectedRevision, changedBy }) {
    const id = positiveSafeInteger(userId, 'userId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackUsers = this._rawUsers();
    const rollbackMemberships = this._rawMemberships();
    const users = rollbackUsers.map(normalizeUser).filter(Boolean);
    const user = users.find(item => item.id === id);
    if (!user) return null;
    if (user.revision !== revision) throw new AccessCatalogConflictError('user', id, revision, user);
    const changedAt = this.now().toISOString();
    const auditLog = await this._writeWithAudit({
      nextUsers: users.filter(item => item.id !== id),
      nextMemberships: this._nextUserMemberships(rollbackMemberships, id, [], true),
      rollbackUsers,
      rollbackMemberships,
      audit: {
        type: 'admin:user_delete',
        message: `User \"${user.username}\" deleted by ${actor}`,
        metadata: { changedBy: actor, changedAt, userId: id, username: user.username }
      }
    });
    return { user, auditLog };
  }

  createGroup(options) { return this._queueMutation(() => this._createGroup(options)); }
  async _createGroup({ value, changedBy }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('value must be an object');
    const name = requiredString(value.name, 'value.name');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackGroups = this._rawGroups();
    const groups = rollbackGroups.map(normalizeGroup).filter(Boolean);
    if (groups.some(group => group.name === name)) throw new AccessCatalogNameConflictError('group', name);
    const permissions = normalizePermissionNames(value.permissions || [], new Set(this._permissions()), this.maxQueryRows);
    const changedAt = this.now().toISOString();
    const group = {
      id: groups.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
      name,
      permissions,
      canReceiveTickets: value.canReceiveTickets === true,
      revision: 1,
      createdAt: changedAt,
      changedBy: actor,
      changedAt
    };
    const auditLog = await this._writeWithAudit({
      nextGroups: [...groups, group], rollbackGroups,
      audit: {
        type: 'admin:group_create',
        message: `Group \"${name}\" created by ${actor}`,
        metadata: { changedBy: actor, changedAt, groupId: group.id, groupName: name }
      }
    });
    return { group, auditLog };
  }

  updateGroup(options) { return this._queueMutation(() => this._updateGroup(options)); }
  async _updateGroup({ groupId, expectedRevision, value, changedBy }) {
    const id = positiveSafeInteger(groupId, 'groupId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('value must be an object');
    const name = requiredString(value.name, 'value.name');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackGroups = this._rawGroups();
    const groups = rollbackGroups.map(normalizeGroup).filter(Boolean);
    const index = groups.findIndex(group => group.id === id);
    if (index === -1) return null;
    if (groups[index].revision !== revision) throw new AccessCatalogConflictError('group', id, revision, groups[index]);
    if (groups.some(group => group.name === name && group.id !== id)) throw new AccessCatalogNameConflictError('group', name);
    const canReceiveTickets = value.canReceiveTickets === true;
    if (!canReceiveTickets && this.readTickets().some(ticket => ticket && ticket.assignmentTargetType === 'group' && ticket.assignmentTargetId === id)) {
      throw new AccessCatalogReferenceError('Group has assigned tickets and must remain ticket-capable', 'GROUP_HAS_ASSIGNED_TICKETS');
    }
    const permissions = normalizePermissionNames(value.permissions || [], new Set(this._permissions()), this.maxQueryRows);
    const changedAt = this.now().toISOString();
    const group = { ...groups[index], name, permissions, canReceiveTickets, revision: revision + 1, changedBy: actor, changedAt };
    const nextGroups = groups.slice();
    nextGroups[index] = group;
    const auditLog = await this._writeWithAudit({
      nextGroups, rollbackGroups,
      audit: {
        type: 'admin:group_edit',
        message: `Group \"${name}\" (#${id}) edited by ${actor}`,
        metadata: { changedBy: actor, changedAt, groupId: id, groupName: name }
      }
    });
    return { group, auditLog };
  }

  deleteGroup(options) { return this._queueMutation(() => this._deleteGroup(options)); }
  async _deleteGroup({ groupId, expectedRevision, changedBy }) {
    const id = positiveSafeInteger(groupId, 'groupId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackGroups = this._rawGroups();
    const rollbackMemberships = this._rawMemberships();
    const groups = rollbackGroups.map(normalizeGroup).filter(Boolean);
    const group = groups.find(item => item.id === id);
    if (!group) return null;
    if (group.revision !== revision) throw new AccessCatalogConflictError('group', id, revision, group);
    if (this.readTickets().some(ticket => ticket && ticket.assignmentTargetType === 'group' && ticket.assignmentTargetId === id)) {
      throw new AccessCatalogReferenceError('Cannot delete a group with assigned tickets', 'GROUP_HAS_ASSIGNED_TICKETS');
    }
    const changedAt = this.now().toISOString();
    const nextMemberships = rollbackMemberships.filter(item => {
      const membership = normalizeMembership(item);
      return !membership || membership.groupId !== id;
    });
    const auditLog = await this._writeWithAudit({
      nextGroups: groups.filter(item => item.id !== id),
      nextMemberships,
      rollbackGroups,
      rollbackMemberships,
      audit: {
        type: 'admin:group_delete',
        message: `Group \"${group.name}\" deleted by ${actor}`,
        metadata: { changedBy: actor, changedAt, groupId: id, groupName: group.name }
      }
    });
    return { group, auditLog, removedMembershipCount: rollbackMemberships.length - nextMemberships.length };
  }

  ensureBootstrapAccess(options) { return this._queueMutation(() => this._ensureBootstrapAccess(options)); }
  async _ensureBootstrapAccess({ adminUsername = 'admin', passwordHash, changedBy = 'system' } = {}) {
    const username = requiredString(adminUsername, 'adminUsername');
    const hash = requiredString(passwordHash, 'passwordHash');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackUsers = this._rawUsers();
    const rollbackGroups = this._rawGroups();
    const rollbackMemberships = this._rawMemberships();
    const users = rollbackUsers.map(normalizeUser).filter(Boolean);
    const groups = rollbackGroups.map(normalizeGroup).filter(Boolean);
    const memberships = rollbackMemberships.map(normalizeMembership).filter(Boolean);
    const changedAt = this.now().toISOString();
    let changed = false;
    let createdAdminUser = false;
    let createdAdministratorGroup = false;
    let createdAssignableGroup = false;
    let createdAdminMembership = false;
    let adminUser = users.find(user => user.username === username) || null;
    if (!adminUser) {
      adminUser = {
        id: users.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        username,
        passwordHash: hash,
        type: 'user',
        revision: 1,
        createdAt: changedAt,
        changedBy: actor,
        changedAt
      };
      users.push(adminUser);
      changed = true;
      createdAdminUser = true;
    }
    const permissionCatalog = this._permissions();
    let adminGroup = groups.find(group => group.name === 'Administrators') || null;
    if (!adminGroup) {
      adminGroup = {
        id: groups.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        name: 'Administrators',
        permissions: permissionCatalog,
        canReceiveTickets: false,
        revision: 1,
        createdAt: changedAt,
        changedBy: actor,
        changedAt
      };
      groups.push(adminGroup);
      changed = true;
      createdAdministratorGroup = true;
    } else if (adminGroup.canReceiveTickets !== false ||
      adminGroup.permissions.length !== permissionCatalog.length ||
      permissionCatalog.some(name => !adminGroup.permissions.includes(name))) {
      adminGroup.permissions = permissionCatalog;
      adminGroup.canReceiveTickets = false;
      adminGroup.revision += 1;
      adminGroup.changedBy = actor;
      adminGroup.changedAt = changedAt;
      changed = true;
    }
    if (!groups.some(group => group.canReceiveTickets)) {
      groups.push({
        id: groups.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        name: 'Agent Support',
        permissions: [],
        canReceiveTickets: true,
        revision: 1,
        createdAt: changedAt,
        changedBy: actor,
        changedAt
      });
      changed = true;
      createdAssignableGroup = true;
    }
    if (!memberships.some(item => item.principalType === 'user' && item.principalId === adminUser.id && item.groupId === adminGroup.id)) {
      const nextId = memberships.reduce((maximum, item) => Math.max(maximum, Number(item.id) || 0), 0) + 1;
      memberships.push({ id: nextId, principalType: 'user', principalId: adminUser.id, groupId: adminGroup.id });
      changed = true;
      createdAdminMembership = true;
    }
    if (changed) {
      await this._writeWithAudit({
        nextUsers: users,
        nextGroups: groups,
        nextMemberships: memberships,
        rollbackUsers,
        rollbackGroups,
        rollbackMemberships
      });
    }
    return {
      changed,
      adminUser: { ...adminUser },
      adminGroup: { ...adminGroup },
      createdAdminUser,
      createdAdministratorGroup,
      createdAssignableGroup,
      createdAdminMembership
    };
  }
}

module.exports = {
  JsonAccessCatalogRepository,
  assertAccessCatalogRepository
};
