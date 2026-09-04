'use strict';

// The one API-token format/digest authority (P1 governed programmatic access,
// docs/ARCHITECTURAL_DECISIONS_PENDING.md, "P1 ... design freeze", section 5).
//
// Raw token = `tts_` + unpadded base64url encoding of 32 cryptographically
// random bytes (256-bit entropy). The persisted value is ONLY the SHA-256 hex
// digest of the COMPLETE presented token, including the `tts_` prefix. The raw
// token is returned exactly once on issuance and is never persisted, logged,
// or re-derived; the digest is secret-equivalent and never rendered.

const crypto = require('crypto');

const API_TOKEN_PREFIX = 'tts_';
const API_TOKEN_RANDOM_BYTES = 32;
const API_TOKEN_HASH_ALGORITHM = 'sha256';

// P1 frozen permission/label/status/redaction contracts. The server and the
// session-only token endpoints consume these constants; they are never
// re-declared at the transport layer, so this module is the single authority
// the deterministic contract suite pins.
const API_TOKEN_MANAGE_PERMISSION = 'apiToken:manage';

const API_TOKEN_LABEL_MIN_LENGTH = 1;
const API_TOKEN_LABEL_MAX_LENGTH = 128;

// The exact status table for the session-only token-management endpoints.
const API_TOKEN_ISSUANCE_STATUS_CONTRACT = Object.freeze({
  issueOwnerSelectionField: 400,
  issueInvalidOrMissingLabel: 400,
  issueNoSession: 401,
  issueMissingPermission: 403,
  issueSuccess: 201,
  listSuccess: 200,
  revokeNoActiveSelfOwnedMatch: 404,
  revokeSuccess: 200
});

// Exact issuance success body shape: the raw token returned once, the issued
// credential projection — and nothing else. No digest, no preview, no userId.
function apiTokenIssuanceResponseBody(rawToken, issued) {
  return {
    token: rawToken,
    apiToken: {
      id: issued.id,
      label: issued.label,
      createdAt: issued.createdAt
    }
  };
}

// Redaction keys defensively covered wherever secret redaction applies. The
// digest is secret-equivalent and is never rendered to user, log, or evidence.
const API_TOKEN_SECRET_REDACTION_KEYS = Object.freeze(['tokenhash', 'token_hash']);

// Mints one fresh raw token. The injectable byte source exists only so the
// deterministic contract suite can pin format and digest behavior without
// weakening production randomness (production always uses the default).
function mintApiToken(randomBytes = (count => crypto.randomBytes(count))) {
  const bytes = randomBytes(API_TOKEN_RANDOM_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== API_TOKEN_RANDOM_BYTES) {
    throw new TypeError(`API token minting requires exactly ${API_TOKEN_RANDOM_BYTES} random bytes`);
  }
  return API_TOKEN_PREFIX + bytes.toString('base64url');
}

function sha256ApiTokenHex(presentedToken) {
  const presented = String(presentedToken === undefined || presentedToken === null ? '' : presentedToken);
  if (!presented) throw new TypeError('a presented API token is required');
  return crypto.createHash(API_TOKEN_HASH_ALGORITHM).update(presented, 'utf8').digest('hex');
}

// Cheap deterministic plausibility gate used BEFORE any digest lookup: wrong
// prefix, wrong alphabet, or wrong payload length is a malformed bearer and
// never reaches persistence. A plausible token is not therefore valid —
// validity is decided solely by the active-token digest lookup.
function isPlausibleApiToken(value) {
  const presented = String(value === undefined || value === null ? '' : value);
  if (!presented.startsWith(API_TOKEN_PREFIX)) return false;
  const payload = presented.slice(API_TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(payload)) return false;
  const decoded = Buffer.from(payload, 'base64url');
  return decoded.length === API_TOKEN_RANDOM_BYTES;
}

module.exports = {
  API_TOKEN_PREFIX,
  API_TOKEN_RANDOM_BYTES,
  API_TOKEN_HASH_ALGORITHM,
  API_TOKEN_MANAGE_PERMISSION,
  API_TOKEN_LABEL_MIN_LENGTH,
  API_TOKEN_LABEL_MAX_LENGTH,
  API_TOKEN_ISSUANCE_STATUS_CONTRACT,
  apiTokenIssuanceResponseBody,
  API_TOKEN_SECRET_REDACTION_KEYS,
  mintApiToken,
  sha256ApiTokenHex,
  isPlausibleApiToken
};
