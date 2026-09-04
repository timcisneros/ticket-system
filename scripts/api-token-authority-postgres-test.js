#!/usr/bin/env node
'use strict';

// Live owner for P1 governed-programmatic-access authentication authority
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, "P1 ... design freeze", section 16).
//
// Drives the REAL server against a disposable PostgreSQL schema
// (TEST_DATABASE_URL only; the repository harness owns the lifecycle) and
// proves, per plane:
//   - session-only token management, with the exact status contract;
//   - bearer is NOT an authentication input on the token plane;
//   - bearer precedence with no session fallback on eligible API routes;
//   - malformed/unknown/revoked/deleted-user bearer refusals;
//   - current permission resolution on the NEXT request after a change;
//   - origin-gate inheritance for token mutation;
//   - public /api/health unaffected by any Authorization header;
//   - HTML/operator surfaces inaccessible with bearer credentials;
//   - route-table parity from the server's REAL registered route inventory;
//   - raw token and digest never persisted to the canonical audit log, and
//     audit metadata carrying exactly the permitted keys.
//
// Pure classification/status/shape/redaction contracts are owned by
// scripts/api-token-contract-test.js (deterministic); oquery bootstrap
// behavior is owned by scripts/oquery-parity-test.js.

const assert = require('node:assert/strict');
const argon2 = require('argon2');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withHarness } = require('./postgres-test-harness');
const { classifyApiRoutePath, PUBLIC_API_ROUTES } = require('../runtime/api-auth-planes');
const { mintApiToken, sha256ApiTokenHex, API_TOKEN_MANAGE_PERMISSION } = require('../runtime/api-token-contract');

let scenariosRun = 0;

function jsonOf(response) {
  try { return JSON.parse(response.body); } catch (_) { return null; }
}

async function main() {
  await withHarness('api token authority', async ({ store, startServer }) => {
    const routeInventoryFile = path.join(os.tmpdir(), `tts-route-inventory-${process.pid}-${Date.now()}.json`);
    const server = await startServer({
      env: {
        RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
        PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000',
        TTS_TEST_ROUTE_INVENTORY_FILE: routeInventoryFile
      }
    });
    const adminCookie = await server.login();

    // Principals: `tokenmgr` manages tokens and creates tickets; `readonly`
    // can read tickets but neither manages tokens nor creates them.
    const ticketReadGroup = (await store.createGroup({
      value: { name: 'API Token Authority Readers', permissions: ['ticket:read'], canReceiveTickets: false },
      changedBy: 'api-token-authority-test'
    })).group;
    const tokenManagerGroup = (await store.createGroup({
      value: { name: 'API Token Managers', permissions: ['ticket:read', 'ticket:create', API_TOKEN_MANAGE_PERMISSION], canReceiveTickets: false },
      changedBy: 'api-token-authority-test'
    })).group;
    await store.createUser({
      value: { username: 'tokenmgr', passwordHash: await argon2.hash('tokenmgr-password') },
      groupIds: [tokenManagerGroup.id],
      changedBy: 'api-token-authority-test'
    });
    await store.createUser({
      value: { username: 'readonly', passwordHash: await argon2.hash('readonly-password') },
      groupIds: [ticketReadGroup.id],
      changedBy: 'api-token-authority-test'
    });

    const agent = (await store.createConfiguredAgent({
      value: { name: 'API Token Authority Demo Agent', provider: 'ollama', model: 'demo-model', apiKey: '' },
      groupIds: [],
      changedBy: 'api-token-authority-test'
    })).agent;

    const tokenmgrCookie = await server.login('tokenmgr', 'tokenmgr-password');
    const readonlyCookie = await server.login('readonly', 'readonly-password');

    // -- 1. Session-only token management: issue, exact 201 shape ------------
    scenariosRun += 1;
    const noAuthIssue = await server.request('POST', '/api/tokens', {
      body: { label: 'no session' }
    });
    assert.equal(noAuthIssue.statusCode, 401, `no session on POST /api/tokens must be 401 (got ${noAuthIssue.statusCode})`);

    const readonlyIssue = await server.request('POST', '/api/tokens', {
      cookie: readonlyCookie,
      body: { label: 'forbidden label' }
    });
    assert.equal(readonlyIssue.statusCode, 403, `session without ${API_TOKEN_MANAGE_PERMISSION} must be 403 (got ${readonlyIssue.statusCode})`);

    const issued = await server.request('POST', '/api/tokens', {
      cookie: tokenmgrCookie,
      body: { label: '  padded live token label  ' }
    });
    assert.equal(issued.statusCode, 201, `session with ${API_TOKEN_MANAGE_PERMISSION} must issue (got ${issued.statusCode})`);
    const issuedBody = jsonOf(issued);
    assert.ok(issuedBody && typeof issuedBody.token === 'string' && issuedBody.token.startsWith('tts_'),
      'issuance must return the raw tts_ token exactly once');
    assert.deepEqual(Object.keys(issuedBody), ['token', 'apiToken'], 'issuance body must be exactly {token, apiToken}');
    assert.deepEqual(Object.keys(issuedBody.apiToken), ['id', 'label', 'createdAt'],
      'the issued projection must carry id/label/createdAt and never a digest, preview, or userId');
    assert.equal(issuedBody.apiToken.label, 'padded live token label', 'the label must be stored trimmed');
    assert.ok(!JSON.stringify(issuedBody).includes('tokenHash') && !JSON.stringify(issuedBody).includes('digest'),
      'issuance must not expose any digest');
    const rawToken = issuedBody.token;
    const issuedTokenId = issuedBody.apiToken.id;

    scenariosRun += 1;
    const badLabels = await Promise.all([
      server.request('POST', '/api/tokens', { cookie: tokenmgrCookie, body: {} }),
      server.request('POST', '/api/tokens', { cookie: tokenmgrCookie, body: { label: '   ' } }),
      server.request('POST', '/api/tokens', { cookie: tokenmgrCookie, body: { label: 'x'.repeat(129) } }),
      server.request('POST', '/api/tokens', { cookie: tokenmgrCookie, body: { label: 42 } })
    ]);
    for (const [index, response] of badLabels.entries()) {
      assert.equal(response.statusCode, 400, `invalid/missing label case ${index + 1} must be 400 (got ${response.statusCode})`);
    }

    scenariosRun += 1;
    for (const ownerField of [{ userId: 1 }, { username: 'admin' }]) {
      const response = await server.request('POST', '/api/tokens', {
        cookie: tokenmgrCookie,
        body: { label: 'ok', ...ownerField }
      });
      assert.equal(response.statusCode, 400, `owner-selection field ${Object.keys(ownerField)[0]} must be 400 (got ${response.statusCode})`);
      const persisted = await store.pool.query(
        `SELECT COUNT(*)::int AS count FROM ${store.table('api_tokens')} WHERE label = 'ok'`
      );
      assert.equal(persisted.rows[0].count, 0, 'a refused owner-selecting issue must write nothing');
    }

    // -- 2. Bearer is NOT an authentication input on the token plane ----------
    scenariosRun += 1;
    const bearerOnlyIssue = await server.request('POST', '/api/tokens', {
      headers: { Authorization: `Bearer ${rawToken}` },
      body: { label: 'bearer must not manage tokens' }
    });
    assert.equal(bearerOnlyIssue.statusCode, 401,
      `bearer-only token management must be refused with 401 (got ${bearerOnlyIssue.statusCode})`);
    const bearerOnlyList = await server.request('GET', '/api/tokens', {
      headers: { Authorization: `Bearer ${rawToken}` }
    });
    assert.equal(bearerOnlyList.statusCode, 401, 'bearer-only token list must be refused');
    const bearerOnlyRevoke = await server.request('DELETE', `/api/tokens/${issuedTokenId}`, {
      headers: { Authorization: `Bearer ${rawToken}` }
    });
    assert.equal(bearerOnlyRevoke.statusCode, 401, 'bearer-only token revoke must be refused');

    scenariosRun += 1;
    const sessionPlusMalformedBearer = await server.request('GET', '/api/tokens', {
      cookie: tokenmgrCookie,
      headers: { Authorization: 'Bearer not-a-real-token-shape' }
    });
    assert.equal(sessionPlusMalformedBearer.statusCode, 200,
      `valid session with a malformed bearer stays session-authoritative on the token plane (got ${sessionPlusMalformedBearer.statusCode})`);
    const sessionPlusBearerIssue = await server.request('POST', '/api/tokens', {
      cookie: readonlyCookie,
      headers: { Authorization: `Bearer ${rawToken}` },
      body: { label: 'session plane ignores bearer' }
    });
    assert.equal(sessionPlusBearerIssue.statusCode, 403,
      'on the token plane the SESSION permission decides, never the bearer credential');

    // -- 3. Listing is self-only and digest-free ------------------------------
    scenariosRun += 1;
    const adminIssued = await server.request('POST', '/api/tokens', {
      cookie: adminCookie,
      body: { label: 'admin private token' }
    });
    assert.equal(adminIssued.statusCode, 201);
    const adminTokenId = jsonOf(adminIssued).apiToken.id;

    const tokenmgrList = jsonOf(await server.request('GET', '/api/tokens', { cookie: tokenmgrCookie }));
    assert.ok(Array.isArray(tokenmgrList.tokens));
    assert.ok(tokenmgrList.tokens.some(token => token.id === issuedTokenId), 'own tokens are listed');
    assert.ok(!tokenmgrList.tokens.some(token => token.id === adminTokenId),
      "another user's tokens are invisible — self-only listing");
    for (const token of tokenmgrList.tokens) {
      assert.deepEqual(Object.keys(token).sort(), ['createdAt', 'id', 'label', 'revokedAt'].sort(),
        'list projections carry exactly id/label/createdAt/revokedAt — no digest, no userId');
    }

    // -- 4. Revocation: active self-owned only, 404 otherwise, permanent ------
    scenariosRun += 1;
    const foreignRevoke = await server.request('DELETE', `/api/tokens/${adminTokenId}`, { cookie: tokenmgrCookie });
    assert.equal(foreignRevoke.statusCode, 404, "revoking another user's token must be 404");
    const nonexistentRevoke = await server.request('DELETE', '/api/tokens/999999', { cookie: tokenmgrCookie });
    assert.equal(nonexistentRevoke.statusCode, 404, 'revoking a nonexistent token must be 404');
    const malformedRevoke = await server.request('DELETE', '/api/tokens/not-a-number', { cookie: tokenmgrCookie });
    assert.equal(malformedRevoke.statusCode, 404, 'a malformed id matches no active token: 404');

    const revokeOk = await server.request('DELETE', `/api/tokens/${issuedTokenId}`, { cookie: tokenmgrCookie });
    assert.equal(revokeOk.statusCode, 200, 'revoking an ACTIVE self-owned token must be 200');
    assert.deepEqual(jsonOf(revokeOk), { ok: true }, 'successful revoke answers exactly {ok:true}');
    const revokeAgain = await server.request('DELETE', `/api/tokens/${issuedTokenId}`, { cookie: tokenmgrCookie });
    assert.equal(revokeAgain.statusCode, 404, 'an already-revoked token matches nothing: 404');

    const listAfterRevoke = jsonOf(await server.request('GET', '/api/tokens', { cookie: tokenmgrCookie }));
    const revokedProjection = listAfterRevoke.tokens.find(token => token.id === issuedTokenId);
    assert.ok(revokedProjection && revokedProjection.revokedAt,
      'revocation is visible as revokedAt, and the row remains listed (permanent, never deleted)');

    // -- 5. Bearer precedence on eligible API routes --------------------------
    scenariosRun += 1;
    const precedenceIssue = await server.request('POST', '/api/tokens', { cookie: tokenmgrCookie, body: { label: 'precedence probe' } });
    assert.equal(precedenceIssue.statusCode, 201);
    const bearerToken = jsonOf(precedenceIssue).token;
    const precedenceList = await server.request('GET', '/api/tickets', {
      cookie: adminCookie,
      headers: { Authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(precedenceList.statusCode, 200, 'a valid bearer with an unrelated valid session must still be 200');
    assert.equal(jsonOf(precedenceList).canUpdateTickets, false,
      'bearer owns authentication: the identity is the tokenmgr principal (ticket:update absent), not the admin session');

    scenariosRun += 1;
    const malformedOnEligible = await Promise.all([
      server.request('GET', '/api/tickets', { cookie: readonlyCookie, headers: { Authorization: 'Basic dXNlcjpwYXNz' } }),
      server.request('GET', '/api/tickets', { cookie: readonlyCookie, headers: { Authorization: 'Bearer totally-unknown-token' } }),
      server.request('GET', '/api/tickets', { cookie: readonlyCookie, headers: { Authorization: 'Bearer tts_' } }),
      server.request('GET', '/api/tickets', { cookie: readonlyCookie, headers: { Authorization: '   ' } })
    ]);
    for (const [index, response] of malformedOnEligible.entries()) {
      assert.equal(response.statusCode, 401,
        `malformed/wrong-scheme/unknown bearer on an eligible route is 401 with NO session fallback (case ${index + 1}: ${response.statusCode})`);
    }

    // -- 6. JSON ticket creation through the canonical seam -------------------
    scenariosRun += 1;
    const ticketCreation = await server.request('POST', '/api/tickets', {
      headers: { Authorization: `Bearer ${bearerToken}` },
      body: {
        objective: 'API token authority: create one governed ticket',
        assignmentTargetType: 'agent',
        assignmentTargetId: agent.id,
        assignmentMode: 'individual'
      }
    });
    assert.equal(ticketCreation.statusCode, 201, `bearer JSON ticket creation must be 201 (got ${ticketCreation.statusCode})`);
    const createdTicket = jsonOf(ticketCreation);
    assert.ok(createdTicket.ticket && Number.isInteger(createdTicket.ticket.id),
      'the response carries the canonical created Ticket identity');
    assert.ok(Array.isArray(createdTicket.runs), 'the response carries the Runs actually created');
    assert.equal(createdTicket.ticket.createdBy, 'tokenmgr',
      'actor identity comes from the bearer principal, never from a body-selected actor');
    // The created ticket is addressed by its canonical id, never re-discovered
    // by objective string.
    const runtimeById = await server.request('GET', `/api/tickets/${createdTicket.ticket.id}/runtime`, {
      headers: { Authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(runtimeById.statusCode, 200, 'the returned canonical ticket id resolves the created ticket');

    scenariosRun += 1;
    const bodySelectedActor = await server.request('POST', '/api/tickets', {
      headers: { Authorization: `Bearer ${bearerToken}` },
      body: {
        objective: 'API token authority: body-selected actor refused',
        assignmentTargetType: 'agent',
        assignmentTargetId: agent.id,
        assignmentMode: 'individual',
        createdBy: 'admin'
      }
    });
    assert.equal(bodySelectedActor.statusCode, 400, 'a body-supplied actor authority field must be refused with 400');

    scenariosRun += 1;
    const readonlyTicketCreation = await server.request('POST', '/api/tickets', {
      cookie: readonlyCookie,
      body: {
        objective: 'readonly must not create tickets',
        assignmentTargetType: 'agent',
        assignmentTargetId: agent.id,
        assignmentMode: 'individual'
      }
    });
    assert.equal(readonlyTicketCreation.statusCode, 403, 'JSON ticket creation requires ticket:create');

    // -- 7. Revoked and deleted-user bearer refusals; dynamic permissions -----
    scenariosRun += 1;
    const revokedBearer = await server.request('GET', '/api/tickets', {
      headers: { Authorization: `Bearer ${rawToken}` }
    });
    assert.equal(revokedBearer.statusCode, 401, 'a revoked token authenticates nothing');

    scenariosRun += 1;
    // A doomed user gets a token minted through the store, then is deleted:
    // the cascade must remove the credential and the bearer must fail closed.
    const doomedGroup = (await store.createGroup({
      value: { name: 'API Token Doomed Users', permissions: ['ticket:read'], canReceiveTickets: false },
      changedBy: 'api-token-authority-test'
    })).group;
    const doomedUser = (await store.createUser({
      value: { username: 'doomed-bearer', passwordHash: 'doomed-hash' },
      groupIds: [doomedGroup.id],
      changedBy: 'api-token-authority-test'
    })).user;
    const doomedRawToken = mintApiToken();
    await store.createApiToken({
      userId: doomedUser.id,
      tokenHash: sha256ApiTokenHex(doomedRawToken),
      label: 'doomed user token'
    });
    const doomedBefore = await server.request('GET', '/api/tickets', {
      headers: { Authorization: `Bearer ${doomedRawToken}` }
    });
    assert.equal(doomedBefore.statusCode, 200, 'the doomed user authenticates while the account exists');
    await store.deleteUser({ userId: doomedUser.id, expectedRevision: doomedUser.revision, changedBy: 'api-token-authority-test' });
    const doomedAfter = await server.request('GET', '/api/tickets', {
      headers: { Authorization: `Bearer ${doomedRawToken}` }
    });
    assert.equal(doomedAfter.statusCode, 401, 'a deleted user bears no working credentials');
    const cascade = await store.pool.query(`SELECT COUNT(*)::int AS count FROM ${store.table('api_tokens')} WHERE user_fk = $1`, [doomedUser.id]);
    assert.equal(cascade.rows[0].count, 0, 'deleting the user cascades its tokens away');

    scenariosRun += 1;
    const beforePermissionChange = await server.request('GET', '/api/tickets', {
      headers: { Authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(beforePermissionChange.statusCode, 200);
    // Drop ticket:read from the bearer user's group; the NEXT request must see it.
    const currentGroup = await store.getGroupById(tokenManagerGroup.id);
    await store.updateGroup({
      groupId: tokenManagerGroup.id,
      expectedRevision: currentGroup.revision,
      value: { name: currentGroup.name, permissions: ['ticket:create', API_TOKEN_MANAGE_PERMISSION], canReceiveTickets: false },
      changedBy: 'api-token-authority-test'
    });
    const afterPermissionDrop = await server.request('GET', '/api/tickets', {
      headers: { Authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(afterPermissionDrop.statusCode, 403, 'a dropped permission is observed on the NEXT bearer request');
    const updatedGroup = await store.getGroupById(tokenManagerGroup.id);
    await store.updateGroup({
      groupId: tokenManagerGroup.id,
      expectedRevision: updatedGroup.revision,
      value: { name: updatedGroup.name, permissions: ['ticket:read', 'ticket:create', API_TOKEN_MANAGE_PERMISSION], canReceiveTickets: false },
      changedBy: 'api-token-authority-test'
    });
    const afterPermissionRestore = await server.request('GET', '/api/tickets', {
      headers: { Authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(afterPermissionRestore.statusCode, 200, 'a restored permission is observed on the NEXT bearer request');

    // -- 8. Origin-gate inheritance for session token mutation ----------------
    scenariosRun += 1;
    const evilOrigin = await server.request('POST', '/api/tokens', {
      cookie: tokenmgrCookie,
      headers: { Origin: 'http://evil.example' },
      body: { label: 'cross-origin refused' }
    });
    assert.equal(evilOrigin.statusCode, 403, 'token mutation inherits the repository origin gate (cross-origin refused)');
    const nullOrigin = await server.request('POST', '/api/tokens', {
      cookie: tokenmgrCookie,
      headers: { Origin: 'null' },
      body: { label: 'null origin refused' }
    });
    assert.equal(nullOrigin.statusCode, 403, 'an unvouched Origin: null is refused by the inherited gate');
    const noOrigin = await server.request('POST', '/api/tokens', {
      cookie: tokenmgrCookie,
      body: { label: 'non-browser no origin' }
    });
    assert.equal(noOrigin.statusCode, 201, 'a non-browser client with no Origin continues through ordinary semantics');

    // -- 9. /api/health is unaffected by any Authorization header --------------
    scenariosRun += 1;
    const healthMalformed = await server.request('GET', '/api/health', {
      headers: { Authorization: 'Bearer not-a-real-token-shape' }
    });
    assert.equal(healthMalformed.statusCode, 200, 'a malformed bearer must not make /api/health return 401');
    const healthWrongScheme = await server.request('GET', '/api/health', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' }
    });
    assert.equal(healthWrongScheme.statusCode, 200, 'a wrong-scheme Authorization header leaves /api/health public');

    // -- 10. Bearer never widens onto HTML/operator surfaces ------------------
    scenariosRun += 1;
    const htmlRoot = await server.request('GET', '/', {
      headers: { Authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(htmlRoot.statusCode, 302, 'bearer on the HTML root is unauthenticated: redirect to /login');
    assert.ok(String(htmlRoot.headers.location || '').startsWith('/login'), 'the HTML root redirects to /login');
    const htmlForm = await server.request('POST', '/tickets', {
      headers: { Authorization: `Bearer ${bearerToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      form: { objective: 'bearer must not create via HTML form' }
    });
    assert.equal(htmlForm.statusCode, 302, 'bearer cannot reach HTML ticket mutation');
    const htmlRedirectBody = htmlForm.headers.location || '';
    assert.ok(htmlRedirectBody.startsWith('/login'), 'the HTML mutation route redirects to /login, never processes the bearer');

    // -- 11. Audit: transactional system log with permitted metadata only -----
    scenariosRun += 1;
    const auditRows = await store.pool.query(
      `SELECT type, body FROM ${store.table('diagnostic_logs')} WHERE type LIKE 'api_token:%' ORDER BY id`
    );
    assert.ok(auditRows.rowCount >= 2, 'issuance and revocation are recorded in the canonical diagnostic log');
    for (const row of auditRows.rows) {
      assert.ok(['api_token:issued', 'api_token:revoked'].includes(row.type));
      const body = row.body;
      assert.ok(['issued', 'revoked'].includes(body.action), 'audit metadata carries the action');
      assert.ok(Number.isInteger(body.tokenId) && Number.isInteger(body.userId), 'audit metadata carries tokenId and userId');
      assert.ok(typeof body.label === 'string' && typeof body.createdAt === 'string', 'audit metadata carries label and createdAt');
      for (const forbidden of ['token', 'tokenHash', 'token_hash', 'digest', 'authorization', 'rawToken']) {
        assert.ok(!(forbidden in body), `audit metadata must never carry ${forbidden}`);
      }
      assert.ok(!JSON.stringify(body).includes(rawToken), 'the raw token never reaches the audit log');
      assert.ok(!JSON.stringify(body).includes(sha256ApiTokenHex(rawToken)), 'the digest never reaches the audit log');
    }
    const tokenRow = await store.pool.query(
      `SELECT token_hash, label, revoked_at, user_fk FROM ${store.table('api_tokens')} WHERE id = $1`,
      [issuedTokenId]
    );
    assert.equal(tokenRow.rows[0].token_hash, sha256ApiTokenHex(rawToken), 'exactly the SHA-256 hex digest of the complete token is persisted');
    assert.ok(tokenRow.rows[0].revoked_at !== null, 'revocation is durable');
    // The revoked row keeps its digest: uniqueness covers revoked rows too.
    await assert.rejects(
      store.pool.query(
        `INSERT INTO ${store.table('api_tokens')} (user_fk, token_hash, label) VALUES ($1, $2, 'digest collision refused')`,
        [doomedUser.id, sha256ApiTokenHex(rawToken)]
      ),
      /unique|duplicate/i,
      'a duplicate digest is refused even against a revoked row'
    );

    // -- 12. Route-table parity from the server's REAL route inventory --------
    scenariosRun += 1;
    assert.ok(fs.existsSync(routeInventoryFile), 'the server dumped its real route inventory');
    const inventory = JSON.parse(fs.readFileSync(routeInventoryFile, 'utf8'));
    assert.ok(Array.isArray(inventory) && inventory.length > 0, 'the route inventory is populated');
    const apiRoutes = inventory.filter(route => String(route.url).startsWith('/api'));
    assert.ok(apiRoutes.length > 0, 'the server serves API routes');
    for (const route of apiRoutes) {
      const plane = classifyApiRoutePath(route.url);
      if (plane === 'PUBLIC_API') {
        assert.ok(PUBLIC_API_ROUTES.includes(route.url),
          `public API route ${route.method} ${route.url} must be exactly in PUBLIC_API_ROUTES`);
      } else {
        assert.ok(plane === 'BEARER_ELIGIBLE_API' || plane === 'SESSION_ONLY_API',
          `API route ${route.method} ${route.url} must be authenticated (got ${plane})`);
      }
    }
    assert.ok(apiRoutes.some(route => route.url === '/api/health' && classifyApiRoutePath(route.url) === 'PUBLIC_API'),
      '/api/health is served and classified public');
    assert.ok(apiRoutes.some(route => classifyApiRoutePath(route.url) === 'SESSION_ONLY_API'),
      'the token-management namespace is served and session-only');
    assert.ok(inventory.some(route => !String(route.url).startsWith('/api')),
      'the inventory also covers the HTML/operator plane');

    // -- 13. Persistence-layer contract: revoke-once and FK integrity ---------
    scenariosRun += 1;
    const tokenmgrUser = (await store.pool.query(
      `SELECT id FROM ${store.table('access_users')} WHERE username = 'tokenmgr'`
    )).rows[0].id;
    const integrityRaw = mintApiToken();
    const integrityToken = (await store.createApiToken({
      userId: tokenmgrUser,
      tokenHash: sha256ApiTokenHex(integrityRaw),
      label: 'revoke-once integrity token'
    })).apiToken;
    const integrityId = integrityToken.id;
    await store.revokeApiToken({ userId: tokenmgrUser, apiTokenId: integrityId });
    const rowAfterRevoke = (await store.pool.query(
      `SELECT revoked_at FROM ${store.table('api_tokens')} WHERE id = $1`,
      [integrityId]
    )).rows[0];
    assert.ok(rowAfterRevoke.revoked_at, 'store-level revocation is durable');
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('api_tokens')} SET revoked_at = NULL WHERE id = $1`, [integrityId]),
      /permanent/,
      'resurrection (revoked_at -> NULL) is refused by the revoke-once guard'
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('api_tokens')} SET label = 'relabeled' WHERE id = $1`, [integrityId]),
      /permanent/,
      'identity mutation after revocation is refused'
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('api_tokens')} SET token_hash = $2 WHERE id = $1`, [integrityId, sha256ApiTokenHex(mintApiToken())]),
      /permanent/,
      'digest substitution is refused'
    );
    await assert.rejects(
      store.createApiToken({ userId: 99999999, tokenHash: sha256ApiTokenHex(mintApiToken()), label: 'orphan' }),
      error => error && error.code === 'USER_NOT_FOUND',
      'a token cannot be created for a nonexistent user'
    );
    await assert.rejects(
      store.createApiToken({ userId: tokenmgrUser, tokenHash: 'not-a-digest', label: 'bad hash' }),
      /tokenHash/,
      'persistence accepts only a SHA-256 hex digest'
    );
    await assert.rejects(
      store.createApiToken({ userId: tokenmgrUser, tokenHash: sha256ApiTokenHex(mintApiToken()), label: 'x'.repeat(129) }),
      /128/,
      'persistence enforces the 128-character label ceiling'
    );
  });
}

main().then(() => {
  if (scenariosRun === 0) throw new Error('no scenarios ran');
  console.log(`PASS: api token authority — ${scenariosRun} scenarios against the real server and a disposable PostgreSQL schema`);
}).catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
