'use strict';

// API-token persistence methods (P1 governed programmatic access).
//
// Repository-native persistence for bearer credentials of EXISTING
// access_users. The persistence API is deliberately narrow and self-only:
//   - createApiToken            — persist the SHA-256 hex digest of a freshly
//                                 minted token for a specified existing user
//   - listApiTokens             — one user's tokens, digest-free projection
//   - revokeApiToken            — permanent revocation of an ACTIVE self-owned
//                                 token (null when nothing matches)
//   - findActiveApiTokenByDigest — authentication-time lookup only
//
// No raw token is ever accepted or persisted; no digest is ever returned.
// Issuance and revocation write the canonical `appendSystemLog` /
// `diagnostic_logs` audit INSIDE the same transaction as the row write.
// `findActiveApiTokenByDigest` is the only non-self-scoped method and returns
// the minimum authentication identity (tokenId, userId) — never the digest,
// and never an authorization decision (permissions resolve per request
// through the access catalog).

const {
  AccessCatalogReferenceError,
  positiveSafeInteger,
  requiredString
} = require('../access-catalog');

const API_TOKEN_LABEL_MAX_LENGTH = 128;
const API_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function rowTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return date.toISOString();
}

// Digest-free projection. `token_hash` and the internal user FK never leave
// persistence: the digest is secret-equivalent and ownership is implied by the
// self-only surface calling these methods.
function apiTokenFromRow(row) {
  return {
    id: positiveSafeInteger(row.id, 'apiToken.id'),
    label: requiredString(row.label, 'apiToken.label'),
    createdAt: rowTimestamp(row.created_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : rowTimestamp(row.revoked_at)
  };
}

function normalizeApiTokenHash(tokenHash) {
  const hash = String(tokenHash === undefined || tokenHash === null ? '' : tokenHash).trim();
  if (!API_TOKEN_HASH_PATTERN.test(hash)) {
    throw new TypeError('tokenHash must be a lowercase SHA-256 hex digest of the complete presented token');
  }
  return hash;
}

function normalizeApiTokenLabel(label) {
  const normalized = requiredString(label, 'label');
  if (normalized.length > API_TOKEN_LABEL_MAX_LENGTH) {
    throw new RangeError(`label exceeds the configured maximum of ${API_TOKEN_LABEL_MAX_LENGTH} characters`);
  }
  return normalized;
}

function methods() {
  return {
    async createApiToken({ userId, tokenHash, label }) {
      const id = positiveSafeInteger(userId, 'userId');
      const hash = normalizeApiTokenHash(tokenHash);
      const normalizedLabel = normalizeApiTokenLabel(label);
      return this.withTransaction(async client => {
        const userResult = await client.query(
          `SELECT id, username FROM ${this.table('access_users')} WHERE id = $1 FOR KEY SHARE`,
          [id]
        );
        if (userResult.rowCount === 0) {
          throw new AccessCatalogReferenceError(`User does not exist: ${id}`, 'USER_NOT_FOUND');
        }
        const result = await client.query(
          `INSERT INTO ${this.table('api_tokens')} (user_fk, token_hash, label)
           VALUES ($1, $2, $3) RETURNING *`,
          [id, hash, normalizedLabel]
        );
        const apiToken = apiTokenFromRow(result.rows[0]);
        const auditLog = await this._appendSystemLog(client, {
          type: 'api_token:issued',
          message: `API token \"${apiToken.label}\" issued for user #${id}`,
          metadata: {
            action: 'issued',
            tokenId: apiToken.id,
            userId: id,
            label: apiToken.label,
            createdAt: apiToken.createdAt
          }
        });
        return { apiToken, auditLog };
      });
    },

    async listApiTokens({ userId } = {}) {
      const id = positiveSafeInteger(userId, 'userId');
      const result = await this.pool.query(
        `SELECT id, label, created_at, revoked_at
         FROM ${this.table('api_tokens')}
         WHERE user_fk = $1
         ORDER BY id`,
        [id]
      );
      return result.rows.map(apiTokenFromRow);
    },

    async revokeApiToken({ userId, apiTokenId }) {
      const id = positiveSafeInteger(userId, 'userId');
      const tokenId = positiveSafeInteger(apiTokenId, 'apiTokenId');
      return this.withTransaction(async client => {
        const currentResult = await client.query(
          `SELECT id, label, created_at, revoked_at
           FROM ${this.table('api_tokens')}
           WHERE id = $1 AND user_fk = $2 AND revoked_at IS NULL
           FOR UPDATE`,
          [tokenId, id]
        );
        if (currentResult.rowCount === 0) return null;
        const result = await client.query(
          `UPDATE ${this.table('api_tokens')}
           SET revoked_at = clock_timestamp()
           WHERE id = $1 AND user_fk = $2 AND revoked_at IS NULL
           RETURNING id, label, created_at, revoked_at`,
          [tokenId, id]
        );
        if (result.rowCount === 0) return null;
        const apiToken = apiTokenFromRow(result.rows[0]);
        const auditLog = await this._appendSystemLog(client, {
          type: 'api_token:revoked',
          message: `API token \"${apiToken.label}\" (#${tokenId}) revoked for user #${id}`,
          metadata: {
            action: 'revoked',
            tokenId,
            userId: id,
            label: apiToken.label,
            createdAt: apiToken.createdAt
          }
        });
        return { apiToken, auditLog };
      });
    },

    async findActiveApiTokenByDigest(tokenHash) {
      const hash = normalizeApiTokenHash(tokenHash);
      const result = await this.pool.query(
        `SELECT id, user_fk
         FROM ${this.table('api_tokens')}
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hash]
      );
      if (result.rowCount === 0) return null;
      return {
        tokenId: positiveSafeInteger(result.rows[0].id, 'apiToken.id'),
        userId: positiveSafeInteger(result.rows[0].user_fk, 'apiToken.userId')
      };
    }
  };
}

function installApiTokenMethods(PostgresRuntimeStore, dependencies) {
  Object.assign(PostgresRuntimeStore.prototype, methods(dependencies));
}

module.exports = { installApiTokenMethods, apiTokenFromRow, normalizeApiTokenHash };
