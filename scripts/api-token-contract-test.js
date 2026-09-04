#!/usr/bin/env node
'use strict';

// Deterministic owner for the P1 governed-programmatic-access token contract
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, "P1 ... design freeze", section 16).
//
// PURE ONLY: no PostgreSQL contact, no server spawn, no provider. Everything
// asserted here is pinned from the repository-owned contract modules that the
// server and the oquery CLI consume — never from a re-declaration:
//   runtime/api-auth-planes.js   — the ONE authentication-plane classifier
//   runtime/api-token-contract.js — token format, digest, status/shape/redaction
//   persistence/access-catalog.js — the builtin permission floor
//
// Live session/bearer behavior against the real server is owned by
// scripts/api-token-authority-postgres-test.js (POSTGRES_INTEGRATION_SCRIPTS).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  AUTH_PLANES,
  PUBLIC_API_ROUTES,
  API_TOKEN_NAMESPACE_PATH,
  isApiPath,
  isApiTokenNamespacePath,
  classifyApiRoutePath
} = require('../runtime/api-auth-planes');
const {
  API_TOKEN_PREFIX,
  API_TOKEN_RANDOM_BYTES,
  API_TOKEN_MANAGE_PERMISSION,
  API_TOKEN_LABEL_MIN_LENGTH,
  API_TOKEN_LABEL_MAX_LENGTH,
  API_TOKEN_ISSUANCE_STATUS_CONTRACT,
  apiTokenIssuanceResponseBody,
  API_TOKEN_SECRET_REDACTION_KEYS,
  mintApiToken,
  sha256ApiTokenHex,
  isPlausibleApiToken
} = require('../runtime/api-token-contract');
const { BUILTIN_PERMISSIONS } = require('../persistence/access-catalog');

const scenarios = [];
function scenario(name, body) { scenarios.push([name, body]); }

// ── 1. Token format ──────────────────────────────────────────────────────────

scenario('token format: prefix + unpadded base64url of exactly 32 random bytes', () => {
  const bytes = crypto.randomBytes(API_TOKEN_RANDOM_BYTES);
  let calls = 0;
  const token = mintApiToken(count => {
    calls += 1;
    assert.equal(count, API_TOKEN_RANDOM_BYTES, 'minting must request exactly 32 random bytes');
    return bytes;
  });
  assert.equal(calls, 1, 'minting must draw randomness exactly once');
  assert.ok(token.startsWith(API_TOKEN_PREFIX), `raw token must carry the ${API_TOKEN_PREFIX} prefix`);
  const payload = token.slice(API_TOKEN_PREFIX.length);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(payload), 'payload must be 43 unpadded base64url characters');
  assert.ok(!payload.includes('=') && !payload.includes('+') && !payload.includes('/'),
    'payload must use unpadded base64url, not base64');
  assert.deepEqual(Buffer.from(payload, 'base64url'), bytes,
    'decoding the payload must reproduce the exact random bytes');
});

scenario('token format: production randomness yields well-shaped, distinct tokens', () => {
  const first = mintApiToken();
  const second = mintApiToken();
  assert.notEqual(first, second, 'two mints must never collide in practice');
  for (const token of [first, second]) {
    assert.equal(token.length, API_TOKEN_PREFIX.length + 43);
    assert.ok(isPlausibleApiToken(token));
  }
});

// ── 2. Exact digest behavior ────────────────────────────────────────────────

scenario('digest: SHA-256 hex of the COMPLETE presented token including the prefix', () => {
  const token = mintApiToken();
  const digest = sha256ApiTokenHex(token);
  const expected = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  assert.equal(digest, expected);
  assert.ok(/^[0-9a-f]{64}$/.test(digest), 'digest must be lowercase 64-character hex');
  // The prefix is part of the digested material: digesting the payload alone
  // (the classic mistake) must NOT match.
  const payloadOnlyDigest = crypto.createHash('sha256').update(token.slice(API_TOKEN_PREFIX.length), 'utf8').digest('hex');
  assert.notEqual(digest, payloadOnlyDigest, 'the tts_ prefix must be digested with the token');
  // Same input, same digest; one changed character, different digest.
  assert.equal(sha256ApiTokenHex(token), digest);
  assert.notEqual(sha256ApiTokenHex(token + 'x'), digest);
  assert.throws(() => sha256ApiTokenHex(''), /presented API token is required/);
  assert.throws(() => sha256ApiTokenHex(null), /presented API token is required/);
});

scenario('plausibility gate: malformed bearers are refused before any digest lookup', () => {
  assert.equal(isPlausibleApiToken(mintApiToken()), true);
  const refusals = [
    '',                                   // empty
    null,                                 // not a string
    undefined,                            // not a string
    'sk-abc',                             // wrong credential family
    'tts_',                               // prefix only, empty payload
    `tts_${'A'.repeat(42)}`,              // one byte short
    `tts_${'A'.repeat(44)}`,              // one byte long
    `tts_${crypto.createHash('sha256').digest('base64')}`, // padded base64, not base64url
    `tts_${'A+'.repeat(21)}A`,            // '+' is not base64url alphabet
    `tts_${'A/'.repeat(21)}A`             // '/' is not base64url alphabet
  ];
  for (const refusal of refusals) {
    assert.equal(isPlausibleApiToken(refusal), false, `must refuse: ${String(refusal).slice(0, 24)}`);
  }
});

// ── 3. Route-plane classification ───────────────────────────────────────────

scenario('classification seam: exactly four planes, one classifier', () => {
  assert.deepEqual([...AUTH_PLANES], ['BEARER_ELIGIBLE_API', 'SESSION_ONLY_API', 'PUBLIC_API', 'NON_API']);
  assert.ok(typeof classifyApiRoutePath === 'function');
});

scenario('PUBLIC_API_ROUTES is frozen to exactly ["/api/health"]', () => {
  assert.deepEqual([...PUBLIC_API_ROUTES], ['/api/health']);
  assert.ok(Object.isFrozen(PUBLIC_API_ROUTES), 'the public API list must be frozen');
  assert.equal(classifyApiRoutePath('/api/health'), 'PUBLIC_API');
});

scenario('token namespace: pathname === /api/tokens OR starts with /api/tokens/', () => {
  assert.equal(API_TOKEN_NAMESPACE_PATH, '/api/tokens');
  const inside = ['/api/tokens', '/api/tokens/', '/api/tokens/5', '/api/tokens/5/extra'];
  for (const pathname of inside) {
    assert.equal(isApiTokenNamespacePath(pathname), true, `${pathname} is token management`);
    assert.equal(classifyApiRoutePath(pathname), 'SESSION_ONLY_API', `${pathname} must be session-only`);
  }
});

scenario('boundary: /api/tokensomething is NOT token management', () => {
  assert.equal(isApiTokenNamespacePath('/api/tokensomething'), false);
  assert.equal(classifyApiRoutePath('/api/tokensomething'), 'BEARER_ELIGIBLE_API');
  assert.equal(isApiTokenNamespacePath('/api/token'), false);
  assert.equal(classifyApiRoutePath('/api/token'), 'BEARER_ELIGIBLE_API');
  assert.equal(isApiTokenNamespacePath('/api/tokensmanager'), false);
});

scenario('classification table: bearer-eligible API plane and NON_API surfaces', () => {
  const bearerEligible = [
    '/api',                       // API root falls through to the product plane
    '/api/tickets',
    '/api/tickets/3/runtime',
    '/api/tokensomething',
    '/api/healthx',               // not an exact public route
    '/api/runs/7/events',
    '/api/unknown-future-route'   // unknown API paths are authenticated by default
  ];
  for (const pathname of bearerEligible) {
    assert.equal(classifyApiRoutePath(pathname), 'BEARER_ELIGIBLE_API', pathname);
  }
  const nonApi = ['', '/login', '/logout', '/', '/tickets', '/tickets/3', '/admin/users', '/health', '/styles.css', '/work-contexts'];
  for (const pathname of nonApi) {
    assert.equal(isApiPath(pathname), false, `${pathname} is not on the API plane`);
    assert.equal(classifyApiRoutePath(pathname), 'NON_API', pathname);
  }
  assert.equal(isApiPath('/api'), true);
  assert.equal(isApiPath('/api/anything'), true);
  assert.equal(isApiPath('/apix'), false, '/apix is not the API plane');
  assert.equal(classifyApiRoutePath('/apix'), 'NON_API');
});

scenario('classification accepts route patterns with :parameter segments', () => {
  assert.equal(classifyApiRoutePath('/api/tokens/:id'), 'SESSION_ONLY_API');
  assert.equal(classifyApiRoutePath('/api/tickets/:id/runtime'), 'BEARER_ELIGIBLE_API');
  assert.equal(classifyApiRoutePath('/api/health'), 'PUBLIC_API');
});

// ── 4. Frozen status contract ───────────────────────────────────────────────

scenario('frozen status contract for the session-only token endpoints', () => {
  assert.deepEqual({ ...API_TOKEN_ISSUANCE_STATUS_CONTRACT }, {
    issueOwnerSelectionField: 400,
    issueInvalidOrMissingLabel: 400,
    issueNoSession: 401,
    issueMissingPermission: 403,
    issueSuccess: 201,
    listSuccess: 200,
    revokeNoActiveSelfOwnedMatch: 404,
    revokeSuccess: 200
  });
  assert.ok(Object.isFrozen(API_TOKEN_ISSUANCE_STATUS_CONTRACT), 'the status table must be frozen');
});

scenario('frozen issuance response shape: token once + projection, nothing else', () => {
  const body = apiTokenIssuanceResponseBody('tts_raw', { id: 7, label: 'L', createdAt: 'T', userId: 3, tokenHash: 'deadbeef' });
  assert.deepEqual(Object.keys(body), ['token', 'apiToken'], 'no extra top-level keys');
  assert.deepEqual(body, { token: 'tts_raw', apiToken: { id: 7, label: 'L', createdAt: 'T' } });
  assert.deepEqual(Object.keys(body.apiToken), ['id', 'label', 'createdAt'],
    'no digest, no preview, no userId on the issued credential projection');
});

// ── 5. Redaction and permission-floor contracts ─────────────────────────────

scenario('redaction contract: token digests are secret-equivalent keys', () => {
  assert.deepEqual([...API_TOKEN_SECRET_REDACTION_KEYS], ['tokenhash', 'token_hash']);
  assert.ok(Object.isFrozen(API_TOKEN_SECRET_REDACTION_KEYS));
});

scenario('builtin floor includes apiToken:manage exactly once, scoped to self-management', () => {
  assert.equal(API_TOKEN_MANAGE_PERMISSION, 'apiToken:manage');
  assert.equal(BUILTIN_PERMISSIONS.filter(name => name === API_TOKEN_MANAGE_PERMISSION).length, 1,
    'the builtin floor names the permission exactly once');
  assert.ok(Object.isFrozen(BUILTIN_PERMISSIONS));
});

scenario('label bounds: trimmed non-empty, maximum 128 characters', () => {
  assert.equal(API_TOKEN_LABEL_MIN_LENGTH, 1);
  assert.equal(API_TOKEN_LABEL_MAX_LENGTH, 128);
});

// ── Runner ───────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, body] of scenarios) {
  try {
    body();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}\n      ${error && error.message ? error.message : error}`);
  }
}
if (failed > 0) {
  console.error(`FAILED: ${failed}/${scenarios.length} api-token contract scenarios`);
  process.exit(1);
}
console.log(`PASS: api-token contract — ${scenarios.length} scenarios, pure deterministic (no PostgreSQL contact)`);
