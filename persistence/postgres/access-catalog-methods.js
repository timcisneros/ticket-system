'use strict';

const {
  BUILTIN_PERMISSIONS,
  AccessCatalogReferenceError,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  requiredString,
  compareCatalogNames,
  normalizeIds
} = require('../access-catalog');

function rowTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return date.toISOString();
}

function nullableBody(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function userFromRow(row) {
  return {
    ...nullableBody(row.body),
    id: positiveSafeInteger(row.id, 'user.id'),
    username: row.username,
    passwordHash: row.password_hash,
    type: 'user',
    revision: positiveSafeInteger(row.revision, 'user.revision'),
    createdAt: rowTimestamp(row.created_at),
    changedBy: row.updated_by,
    changedAt: rowTimestamp(row.updated_at)
  };
}

function groupFromRow(row) {
  return {
    ...nullableBody(row.body),
    id: positiveSafeInteger(row.id, 'group.id'),
    name: row.name,
    permissions: Array.isArray(row.permissions) ? [...row.permissions].sort(compareCatalogNames) : [],
    canReceiveTickets: row.can_receive_tickets === true,
    revision: positiveSafeInteger(row.revision, 'group.revision'),
    createdAt: rowTimestamp(row.created_at),
    changedBy: row.updated_by,
    changedAt: rowTimestamp(row.updated_at)
  };
}

function namedConflict(error, entity, name) {
  const expected = entity === 'user' ? 'access_users_username_unique' : 'access_groups_name_unique';
  if (error && error.code === '23505' && error.constraint === expected) {
    const conflict = new Error(`${entity} name already exists: ${name}`);
    conflict.name = 'AccessCatalogNameConflictError';
    conflict.code = entity === 'user' ? 'USER_NAME_CONFLICT' : 'GROUP_NAME_CONFLICT';
    conflict.entity = entity;
    conflict.nameValue = name;
    throw conflict;
  }
  throw error;
}

function methods({ OptimisticConcurrencyError }) {
  return {
    _accessLimit(limit) {
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      return size;
    },

    _accessIds(value, label, options = {}) {
      return normalizeIds(value, label, this.maxQueryRows, options);
    },

    _accessUserValue(value) {
      const source = this.assertJsonRecord(value, 'value');
      const username = requiredString(source.username, 'value.username');
      const passwordHash = requiredString(source.passwordHash, 'value.passwordHash');
      const body = { ...source };
      for (const key of ['id', 'username', 'passwordHash', 'type', 'revision', 'groupIds', 'createdAt', 'changedBy', 'changedAt']) delete body[key];
      return { username, passwordHash, body: this.assertJsonRecord(body, 'user body') };
    },

    _accessGroupValue(value) {
      const source = this.assertJsonRecord(value, 'value');
      const name = requiredString(source.name, 'value.name');
      const permissions = source.permissions == null ? [] : source.permissions;
      if (!Array.isArray(permissions)) throw new TypeError('value.permissions must be an array');
      const permissionNames = [...new Set(permissions.map((item, index) => requiredString(item, `value.permissions[${index}]`)))];
      permissionNames.sort(compareCatalogNames);
      if (permissionNames.length > this.maxQueryRows) throw new RangeError(`permissions exceeds the configured maximum of ${this.maxQueryRows}`);
      const body = { ...source };
      for (const key of ['id', 'name', 'permissions', 'canReceiveTickets', 'revision', 'createdAt', 'changedBy', 'changedAt']) delete body[key];
      return {
        name,
        permissions: permissionNames,
        canReceiveTickets: source.canReceiveTickets === true,
        body: this.assertJsonRecord(body, 'group body')
      };
    },

    async _assertAccessGroups(connection, groupIds) {
      if (groupIds.length === 0) return;
      const result = await connection.query(
        `SELECT id FROM ${this.table('access_groups')} WHERE id = ANY($1::bigint[]) ORDER BY id FOR KEY SHARE`,
        [groupIds]
      );
      if (result.rowCount !== groupIds.length) {
        const found = new Set(result.rows.map(row => positiveSafeInteger(row.id, 'group.id')));
        const missing = groupIds.find(id => !found.has(id));
        throw new AccessCatalogReferenceError(`Group does not exist: ${missing}`, 'GROUP_NOT_FOUND');
      }
    },

    async _assertAccessPermissions(connection, permissionNames) {
      if (permissionNames.length === 0) return;
      const result = await connection.query(
        `SELECT name FROM ${this.table('access_permissions')} WHERE name = ANY($1::text[]) ORDER BY name`,
        [permissionNames]
      );
      if (result.rowCount !== permissionNames.length) {
        const found = new Set(result.rows.map(row => row.name));
        const missing = permissionNames.find(name => !found.has(name));
        throw new AccessCatalogReferenceError(`Permission does not exist: ${missing}`, 'PERMISSION_NOT_FOUND');
      }
    },

    async _replaceUserGroupMemberships(connection, userId, groupIds, actor) {
      await connection.query(`DELETE FROM ${this.table('user_group_memberships')} WHERE user_id = $1`, [userId]);
      if (groupIds.length === 0) return;
      await connection.query(
        `INSERT INTO ${this.table('user_group_memberships')} (user_id, group_id, created_by)
         SELECT $1, group_id, $3 FROM unnest($2::bigint[]) AS membership(group_id)`,
        [userId, groupIds, actor]
      );
    },

    async _replaceAccessGroupPermissions(connection, groupId, permissionNames, actor) {
      await connection.query(`DELETE FROM ${this.table('access_group_permissions')} WHERE group_id = $1`, [groupId]);
      if (permissionNames.length === 0) return;
      await connection.query(
        `INSERT INTO ${this.table('access_group_permissions')} (group_id, permission_name, created_by)
         SELECT $1, permission_name, $3 FROM unnest($2::text[]) AS grant_row(permission_name)`,
        [groupId, permissionNames, actor]
      );
    },

    async _assertTicketAssignmentTarget(connection, ticket) {
      if (!ticket || ticket.assignmentTargetType !== 'group') return;
      const groupId = positiveSafeInteger(ticket.assignmentTargetId, 'ticket.assignmentTargetId');
      const result = await connection.query(
        `SELECT id, can_receive_tickets FROM ${this.table('access_groups')} WHERE id = $1 FOR SHARE`,
        [groupId]
      );
      if (result.rowCount === 0) {
        throw new AccessCatalogReferenceError(`Selected group does not exist: ${groupId}`, 'GROUP_NOT_FOUND');
      }
      if (result.rows[0].can_receive_tickets !== true) {
        throw new AccessCatalogReferenceError(`Selected group cannot receive tickets: ${groupId}`, 'GROUP_NOT_TICKET_CAPABLE');
      }
    },

    async listUsers({ afterId = 0, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const size = this._accessLimit(limit);
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('access_users')} WHERE id > $1 ORDER BY id LIMIT $2`,
        [cursor, size + 1]
      );
      const users = result.rows.slice(0, size).map(userFromRow);
      return { users, nextAfterId: result.rows.length > size && users.length ? users[users.length - 1].id : null };
    },

    async _accessUserWithGroups(connection, row) {
      if (!row) return null;
      const user = userFromRow(row);
      const result = await connection.query(
        `SELECT group_id FROM ${this.table('user_group_memberships')}
         WHERE user_id = $1 ORDER BY group_id LIMIT $2`,
        [user.id, this.maxQueryRows + 1]
      );
      if (result.rowCount > this.maxQueryRows) throw new RangeError(`user ${user.id} group memberships exceed the configured maximum`);
      return { ...user, groupIds: result.rows.map(item => positiveSafeInteger(item.group_id, 'membership.groupId')) };
    },

    async getUserById(userId) {
      const id = positiveSafeInteger(userId, 'userId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('access_users')} WHERE id = $1`, [id]);
      return result.rowCount === 0 ? null : this._accessUserWithGroups(this.pool, result.rows[0]);
    },

    async getUserByUsername(username) {
      const name = requiredString(username, 'username');
      const result = await this.pool.query(`SELECT * FROM ${this.table('access_users')} WHERE username = $1`, [name]);
      return result.rowCount === 0 ? null : this._accessUserWithGroups(this.pool, result.rows[0]);
    },

    async listGroups({ afterId = 0, canReceiveTickets = null, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const size = this._accessLimit(limit);
      if (canReceiveTickets !== null && typeof canReceiveTickets !== 'boolean') throw new TypeError('canReceiveTickets must be a boolean or null');
      const result = await this.pool.query(
        `SELECT access_group.*,
                ARRAY(SELECT grant_row.permission_name
                      FROM ${this.table('access_group_permissions')} AS grant_row
                      WHERE grant_row.group_id = access_group.id
                      ORDER BY grant_row.permission_name COLLATE "C") AS permissions
         FROM ${this.table('access_groups')} AS access_group
         WHERE access_group.id > $1
           AND ($2::boolean IS NULL OR access_group.can_receive_tickets = $2)
         ORDER BY access_group.id
         LIMIT $3`,
        [cursor, canReceiveTickets, size + 1]
      );
      const groups = result.rows.slice(0, size).map(groupFromRow);
      return { groups, nextAfterId: result.rows.length > size && groups.length ? groups[groups.length - 1].id : null };
    },

    async getGroupById(groupId) {
      const id = positiveSafeInteger(groupId, 'groupId');
      const result = await this.pool.query(
        `SELECT access_group.*,
                ARRAY(SELECT grant_row.permission_name FROM ${this.table('access_group_permissions')} AS grant_row
                      WHERE grant_row.group_id = access_group.id ORDER BY grant_row.permission_name COLLATE "C") AS permissions
         FROM ${this.table('access_groups')} AS access_group WHERE access_group.id = $1`,
        [id]
      );
      return result.rowCount === 0 ? null : groupFromRow(result.rows[0]);
    },

    async getGroupsByIds({ groupIds }) {
      const ids = this._accessIds(groupIds, 'groupIds', { allowEmpty: false });
      const result = await this.pool.query(
        `SELECT access_group.*,
                ARRAY(SELECT grant_row.permission_name FROM ${this.table('access_group_permissions')} AS grant_row
                      WHERE grant_row.group_id = access_group.id ORDER BY grant_row.permission_name COLLATE "C") AS permissions
         FROM ${this.table('access_groups')} AS access_group
         WHERE access_group.id = ANY($1::bigint[]) ORDER BY access_group.id LIMIT $2`,
        [ids, ids.length]
      );
      return result.rows.map(groupFromRow);
    },

    async listPermissions({ afterName = '', limit = 100 } = {}) {
      const cursor = String(afterName || '');
      const size = this._accessLimit(limit);
      const result = await this.pool.query(
        `SELECT name FROM ${this.table('access_permissions')} WHERE (name COLLATE "C") > ($1 COLLATE "C")
         ORDER BY name COLLATE "C" LIMIT $2`,
        [cursor, size + 1]
      );
      const permissions = result.rows.slice(0, size).map(row => row.name);
      return { permissions, nextAfterName: result.rows.length > size && permissions.length ? permissions[permissions.length - 1] : null };
    },

    async listUserGroupMemberships({ afterUserId = 0, afterGroupId = 0, userIds = null, groupIds = null, limit = 100 } = {}) {
      const userCursor = nonNegativeSafeInteger(afterUserId, 'afterUserId');
      const groupCursor = nonNegativeSafeInteger(afterGroupId, 'afterGroupId');
      const size = this._accessLimit(limit);
      const allowedUsers = userIds == null ? null : this._accessIds(userIds, 'userIds', { allowEmpty: false });
      const allowedGroups = groupIds == null ? null : this._accessIds(groupIds, 'groupIds', { allowEmpty: false });
      const result = await this.pool.query(
        `SELECT user_id, group_id FROM ${this.table('user_group_memberships')}
         WHERE (user_id, group_id) > ($1, $2)
           AND ($3::bigint[] IS NULL OR user_id = ANY($3::bigint[]))
           AND ($4::bigint[] IS NULL OR group_id = ANY($4::bigint[]))
         ORDER BY user_id, group_id LIMIT $5`,
        [userCursor, groupCursor, allowedUsers, allowedGroups, size + 1]
      );
      const memberships = result.rows.slice(0, size).map(row => ({
        userId: positiveSafeInteger(row.user_id, 'membership.userId'),
        groupId: positiveSafeInteger(row.group_id, 'membership.groupId')
      }));
      const last = memberships[memberships.length - 1] || null;
      return { memberships, nextCursor: result.rows.length > size && last ? { afterUserId: last.userId, afterGroupId: last.groupId } : null };
    },

    async getUserAuthorization(userId) {
      const id = positiveSafeInteger(userId, 'userId');
      const result = await this.pool.query(
        `SELECT access_user.*,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', member_group.id,
                    'name', member_group.name,
                    'canReceiveTickets', member_group.can_receive_tickets,
                    'permissions', ARRAY(
                      SELECT grant_row.permission_name
                      FROM ${this.table('access_group_permissions')} AS grant_row
                      WHERE grant_row.group_id = member_group.id
                      ORDER BY grant_row.permission_name COLLATE "C"
                    )
                  ) ORDER BY member_group.id)
                  FROM (
                    SELECT access_group.*
                    FROM ${this.table('user_group_memberships')} AS membership
                    JOIN ${this.table('access_groups')} AS access_group ON access_group.id = membership.group_id
                    WHERE membership.user_id = access_user.id
                    ORDER BY access_group.id
                    LIMIT $2
                  ) AS member_group
                ), '[]'::jsonb) AS authorization_groups
         FROM ${this.table('access_users')} AS access_user
         WHERE access_user.id = $1`,
        [id, this.maxQueryRows + 1]
      );
      if (result.rowCount === 0) return null;
      const groups = Array.isArray(result.rows[0].authorization_groups) ? result.rows[0].authorization_groups : [];
      if (groups.length > this.maxQueryRows) throw new RangeError(`user ${id} authorization exceeds the configured maximum`);
      const normalizedGroups = groups.map(group => ({
        id: positiveSafeInteger(group.id, 'authorization.groupId'),
        name: group.name,
        canReceiveTickets: group.canReceiveTickets === true,
        permissions: Array.isArray(group.permissions) ? group.permissions : []
      }));
      const user = userFromRow(result.rows[0]);
      const groupIds = normalizedGroups.map(group => group.id);
      const permissions = [...new Set(normalizedGroups.flatMap(group => group.permissions))].sort(compareCatalogNames);
      return { user: { ...user, groupIds }, groupIds, groups: normalizedGroups, permissions };
    },

    async createUser({ value, groupIds = [], changedBy }) {
      const normalized = this._accessUserValue(value);
      const groups = this._accessIds(groupIds, 'groupIds');
      const actor = requiredString(changedBy, 'changedBy');
      try {
        return await this.withTransaction(async client => {
          await this._assertAccessGroups(client, groups);
          const result = await client.query(
            `INSERT INTO ${this.table('access_users')} (username, password_hash, body, created_by, updated_by)
             VALUES ($1, $2, $3::jsonb, $4, $4) RETURNING *`,
            [normalized.username, normalized.passwordHash, normalized.body, actor]
          );
          const user = userFromRow(result.rows[0]);
          await this._replaceUserGroupMemberships(client, user.id, groups, actor);
          const auditLog = await this._appendSystemLog(client, {
            type: 'admin:user_create', message: `User \"${user.username}\" created by ${actor}`,
            metadata: { changedBy: actor, changedAt: user.changedAt, userId: user.id, username: user.username }
          });
          return { user: { ...user, groupIds: groups }, auditLog };
        });
      } catch (error) { return namedConflict(error, 'user', normalized.username); }
    },

    async updateUser({ userId, expectedRevision, value, groupIds = [], changedBy }) {
      const id = positiveSafeInteger(userId, 'userId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const normalized = this._accessUserValue(value);
      const groups = this._accessIds(groupIds, 'groupIds');
      const actor = requiredString(changedBy, 'changedBy');
      try {
        return await this.withTransaction(async client => {
          const currentResult = await client.query(`SELECT * FROM ${this.table('access_users')} WHERE id = $1 FOR UPDATE`, [id]);
          if (currentResult.rowCount === 0) return null;
          const current = userFromRow(currentResult.rows[0]);
          if (current.revision !== revision) throw new OptimisticConcurrencyError('user', id, revision, current);
          await this._assertAccessGroups(client, groups);
          const result = await client.query(
            `UPDATE ${this.table('access_users')}
             SET username = $3, password_hash = $4, body = $5::jsonb,
                 revision = revision + 1, updated_by = $6, updated_at = clock_timestamp()
             WHERE id = $1 AND revision = $2 RETURNING *`,
            [id, revision, normalized.username, normalized.passwordHash, normalized.body, actor]
          );
          if (result.rowCount === 0) throw new OptimisticConcurrencyError('user', id, revision, current);
          const user = userFromRow(result.rows[0]);
          await this._replaceUserGroupMemberships(client, id, groups, actor);
          const auditLog = await this._appendSystemLog(client, {
            type: 'admin:user_edit', message: `User \"${user.username}\" (#${id}) edited by ${actor}`,
            metadata: { changedBy: actor, changedAt: user.changedAt, userId: id, username: user.username }
          });
          return { user: { ...user, groupIds: groups }, auditLog };
        });
      } catch (error) { return namedConflict(error, 'user', normalized.username); }
    },

    async deleteUser({ userId, expectedRevision, changedBy }) {
      const id = positiveSafeInteger(userId, 'userId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(`SELECT * FROM ${this.table('access_users')} WHERE id = $1 FOR UPDATE`, [id]);
        if (currentResult.rowCount === 0) return null;
        const user = userFromRow(currentResult.rows[0]);
        if (user.revision !== revision) throw new OptimisticConcurrencyError('user', id, revision, user);
        const deleted = await client.query(`DELETE FROM ${this.table('access_users')} WHERE id = $1 AND revision = $2`, [id, revision]);
        if (deleted.rowCount === 0) throw new OptimisticConcurrencyError('user', id, revision, user);
        const clock = await client.query('SELECT clock_timestamp() AS changed_at');
        const changedAt = rowTimestamp(clock.rows[0].changed_at);
        const auditLog = await this._appendSystemLog(client, {
          type: 'admin:user_delete', message: `User \"${user.username}\" deleted by ${actor}`,
          metadata: { changedBy: actor, changedAt, userId: id, username: user.username }
        });
        return { user, auditLog };
      });
    },

    async createGroup({ value, changedBy }) {
      const normalized = this._accessGroupValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      try {
        return await this.withTransaction(async client => {
          await this._assertAccessPermissions(client, normalized.permissions);
          const result = await client.query(
            `INSERT INTO ${this.table('access_groups')} (name, can_receive_tickets, body, created_by, updated_by)
             VALUES ($1, $2, $3::jsonb, $4, $4) RETURNING *`,
            [normalized.name, normalized.canReceiveTickets, normalized.body, actor]
          );
          await this._replaceAccessGroupPermissions(client, result.rows[0].id, normalized.permissions, actor);
          const group = groupFromRow({ ...result.rows[0], permissions: normalized.permissions });
          const auditLog = await this._appendSystemLog(client, {
            type: 'admin:group_create', message: `Group \"${group.name}\" created by ${actor}`,
            metadata: { changedBy: actor, changedAt: group.changedAt, groupId: group.id, groupName: group.name }
          });
          return { group, auditLog };
        });
      } catch (error) { return namedConflict(error, 'group', normalized.name); }
    },

    async updateGroup({ groupId, expectedRevision, value, changedBy }) {
      const id = positiveSafeInteger(groupId, 'groupId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const normalized = this._accessGroupValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      try {
        return await this.withTransaction(async client => {
          const currentResult = await client.query(
            `SELECT access_group.*,
                    ARRAY(SELECT permission_name FROM ${this.table('access_group_permissions')}
                          WHERE group_id = access_group.id ORDER BY permission_name COLLATE "C") AS permissions
             FROM ${this.table('access_groups')} AS access_group WHERE id = $1 FOR UPDATE`,
            [id]
          );
          if (currentResult.rowCount === 0) return null;
          const current = groupFromRow(currentResult.rows[0]);
          if (current.revision !== revision) throw new OptimisticConcurrencyError('group', id, revision, current);
          if (!normalized.canReceiveTickets) {
            const assigned = await client.query(
              `SELECT 1 FROM ${this.table('tickets')} WHERE assignment_group_id = $1 LIMIT 1`, [id]
            );
            if (assigned.rowCount > 0) {
              throw new AccessCatalogReferenceError('Group has assigned tickets and must remain ticket-capable', 'GROUP_HAS_ASSIGNED_TICKETS');
            }
          }
          await this._assertAccessPermissions(client, normalized.permissions);
          const result = await client.query(
            `UPDATE ${this.table('access_groups')}
             SET name = $3, can_receive_tickets = $4, body = $5::jsonb,
                 revision = revision + 1, updated_by = $6, updated_at = clock_timestamp()
             WHERE id = $1 AND revision = $2 RETURNING *`,
            [id, revision, normalized.name, normalized.canReceiveTickets, normalized.body, actor]
          );
          if (result.rowCount === 0) throw new OptimisticConcurrencyError('group', id, revision, current);
          await this._replaceAccessGroupPermissions(client, id, normalized.permissions, actor);
          const group = groupFromRow({ ...result.rows[0], permissions: normalized.permissions });
          const auditLog = await this._appendSystemLog(client, {
            type: 'admin:group_edit', message: `Group \"${group.name}\" (#${id}) edited by ${actor}`,
            metadata: { changedBy: actor, changedAt: group.changedAt, groupId: id, groupName: group.name }
          });
          return { group, auditLog };
        });
      } catch (error) { return namedConflict(error, 'group', normalized.name); }
    },

    async deleteGroup({ groupId, expectedRevision, changedBy }) {
      const id = positiveSafeInteger(groupId, 'groupId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(
          `SELECT access_group.*,
                  ARRAY(SELECT permission_name FROM ${this.table('access_group_permissions')}
                        WHERE group_id = access_group.id ORDER BY permission_name COLLATE "C") AS permissions
           FROM ${this.table('access_groups')} AS access_group WHERE id = $1 FOR UPDATE`, [id]
        );
        if (currentResult.rowCount === 0) return null;
        const group = groupFromRow(currentResult.rows[0]);
        if (group.revision !== revision) throw new OptimisticConcurrencyError('group', id, revision, group);
        const assigned = await client.query(`SELECT 1 FROM ${this.table('tickets')} WHERE assignment_group_id = $1 LIMIT 1`, [id]);
        if (assigned.rowCount > 0) throw new AccessCatalogReferenceError('Cannot delete a group with assigned tickets', 'GROUP_HAS_ASSIGNED_TICKETS');
        const memberCount = await client.query(
          `SELECT ((SELECT COUNT(*) FROM ${this.table('user_group_memberships')} WHERE group_id = $1) +
                   (SELECT COUNT(*) FROM ${this.table('agent_group_memberships')} WHERE group_id = $1))::bigint AS count`, [id]
        );
        const removedMembershipCount = Number(memberCount.rows[0].count);
        if (!Number.isSafeInteger(removedMembershipCount) || removedMembershipCount < 0) throw new RangeError('group membership count exceeds safe integer range');
        const deleted = await client.query(`DELETE FROM ${this.table('access_groups')} WHERE id = $1 AND revision = $2`, [id, revision]);
        if (deleted.rowCount === 0) throw new OptimisticConcurrencyError('group', id, revision, group);
        const clock = await client.query('SELECT clock_timestamp() AS changed_at');
        const changedAt = rowTimestamp(clock.rows[0].changed_at);
        const auditLog = await this._appendSystemLog(client, {
          type: 'admin:group_delete', message: `Group \"${group.name}\" deleted by ${actor}`,
          metadata: { changedBy: actor, changedAt, groupId: id, groupName: group.name }
        });
        return { group, auditLog, removedMembershipCount };
      });
    },

    async ensureBootstrapAccess({ adminUsername = 'admin', passwordHash, changedBy = 'system' } = {}) {
      const username = requiredString(adminUsername, 'adminUsername');
      const hash = requiredString(passwordHash, 'passwordHash');
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${this.schema}:access-bootstrap`]);
        const permissionResult = await client.query(
          `SELECT name FROM ${this.table('access_permissions')} WHERE name = ANY($1::text[])`, [BUILTIN_PERMISSIONS]
        );
        if (permissionResult.rowCount !== BUILTIN_PERMISSIONS.length) {
          const error = new Error('PostgreSQL permission catalog is missing required application permissions');
          error.code = 'ACCESS_PERMISSION_CATALOG_INCOMPLETE';
          throw error;
        }
        let changed = false;
        let userResult = await client.query(`SELECT * FROM ${this.table('access_users')} WHERE username = $1 FOR UPDATE`, [username]);
        if (userResult.rowCount === 0) {
          userResult = await client.query(
            `INSERT INTO ${this.table('access_users')} (username, password_hash, body, created_by, updated_by)
             VALUES ($1, $2, '{}'::jsonb, $3, $3) RETURNING *`, [username, hash, actor]
          );
          changed = true;
        }
        const adminUser = userFromRow(userResult.rows[0]);
        let groupResult = await client.query(`SELECT * FROM ${this.table('access_groups')} WHERE name = 'Administrators' FOR UPDATE`);
        if (groupResult.rowCount === 0) {
          groupResult = await client.query(
            `INSERT INTO ${this.table('access_groups')} (name, can_receive_tickets, body, created_by, updated_by)
             VALUES ('Administrators', FALSE, '{}'::jsonb, $1, $1) RETURNING *`, [actor]
          );
          changed = true;
        }
        let adminGroupRow = groupResult.rows[0];
        const grantCount = await client.query(
          `SELECT COUNT(*)::bigint AS count FROM ${this.table('access_group_permissions')} WHERE group_id = $1`, [adminGroupRow.id]
        );
        const permissionCount = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${this.table('access_permissions')}`);
        if (adminGroupRow.can_receive_tickets === true || Number(grantCount.rows[0].count) !== Number(permissionCount.rows[0].count)) {
          const updated = await client.query(
            `UPDATE ${this.table('access_groups')}
             SET can_receive_tickets = FALSE, revision = revision + 1, updated_by = $2, updated_at = clock_timestamp()
             WHERE id = $1 RETURNING *`, [adminGroupRow.id, actor]
          );
          adminGroupRow = updated.rows[0];
          await client.query(`DELETE FROM ${this.table('access_group_permissions')} WHERE group_id = $1`, [adminGroupRow.id]);
          await client.query(
            `INSERT INTO ${this.table('access_group_permissions')} (group_id, permission_name, created_by)
             SELECT $1, name, $2 FROM ${this.table('access_permissions')}`, [adminGroupRow.id, actor]
          );
          changed = true;
        }
        const ticketCapable = await client.query(`SELECT 1 FROM ${this.table('access_groups')} WHERE can_receive_tickets = TRUE LIMIT 1`);
        if (ticketCapable.rowCount === 0) {
          await client.query(
            `INSERT INTO ${this.table('access_groups')} (name, can_receive_tickets, body, created_by, updated_by)
             VALUES ('Agent Support', TRUE, '{}'::jsonb, $1, $1)`, [actor]
          );
          changed = true;
        }
        const membership = await client.query(
          `INSERT INTO ${this.table('user_group_memberships')} (user_id, group_id, created_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id`, [adminUser.id, adminGroupRow.id, actor]
        );
        if (membership.rowCount > 0) changed = true;
        const adminGroup = groupFromRow({ ...adminGroupRow, permissions: (await client.query(
          `SELECT permission_name FROM ${this.table('access_group_permissions')} WHERE group_id = $1 ORDER BY permission_name COLLATE "C"`, [adminGroupRow.id]
        )).rows.map(row => row.permission_name) });
        return { changed, adminUser, adminGroup };
      });
    }
  };
}

function installAccessCatalogMethods(PostgresRuntimeStore, dependencies) {
  Object.assign(PostgresRuntimeStore.prototype, methods(dependencies));
}

module.exports = { installAccessCatalogMethods };
