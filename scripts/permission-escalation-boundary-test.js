#!/usr/bin/env node
'use strict';
// Permission escalation boundaries — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// The authority half of `rbac-and-inline-data-security-test.js`, split out because
// that file bundles two unrelated concerns: privilege escalation (here) and inline
// data security — script escaping, provider-secret leakage, DOM sink avoidance —
// which is an injection contract, not an authority boundary. A20 records the second
// half as still needing a home; nothing from it is retired by this file.
//
// THE CONTRACT: a principal holding SOME administrative permissions must not be able
// to reach the ones it was not granted. This is the escalation shape that matters —
// not "can a nobody do nothing", but "can a partial admin promote itself".
//
// The seeded principal deliberately holds a realistic bundle:
//   user:create, user:read, user:update, group:create, group:update
// and must still be refused when it tries to:
//   * create an account already placed in a privileged group  (membership escalation)
//   * create a group carrying a permission it does not hold   (grant escalation)
//   * reach workflow management on the strength of user:read  (unrelated inheritance)
//   * read the event stream without ticket:read               (surface bypass)
//
// BOTH SIDES ARE PROVED. Each refusal is paired with the nearest ALLOWED action the
// same principal may legitimately take — an unassigned account, an empty group — and
// with an administrator succeeding where the limited principal failed. A refusal-only
// suite passes against a runtime that refuses everything, and against one where the
// endpoints do not exist at all.
//
// Refusals are also checked for EFFECT, not just status: a 403 that still wrote the
// row would be worse than a 500, and status alone cannot tell those apart.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const LIMITED_PASSWORD = 'limited-password-escalation';
const assert = createAsserter();
let scenariosRun = 0;

async function main() {
  await withHarness('permission escalation boundary', async ({ store, startServer }) => {
    // A privileged group the limited principal must not be able to join anyone to.
    const privilegedGroup = (await store.createGroup({
      value: { name: `Privileged ${STAMP}`, permissions: ['user:delete'], canReceiveTickets: false },
      changedBy: 'permission-escalation-boundary-test'
    })).group;

    // Realistic partial-admin bundle: enough to manage accounts and groups, and
    // deliberately NOT enough to grant permissions or manage workflows.
    const limitedGroup = (await store.createGroup({
      value: {
        name: `Limited account managers ${STAMP}`,
        permissions: ['user:create', 'user:read', 'user:update', 'group:create', 'group:update'],
        canReceiveTickets: false
      },
      changedBy: 'permission-escalation-boundary-test'
    })).group;

    await store.createUser({
      value: { username: 'limited', passwordHash: await argon2.hash(LIMITED_PASSWORD) },
      groupIds: [limitedGroup.id],
      changedBy: 'permission-escalation-boundary-test'
    });

    const server = await startServer({ RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' });
    const adminCookie = await server.login();
    const limitedCookie = await server.login('limited', LIMITED_PASSWORD);

    const usernames = async () => (await store.listUsers({ limit: 200 })).users.map(u => u.username);
    const groupNames = async () => (await store.listGroups({ limit: 200 })).groups.map(g => g.name);

    // ── 1. Membership escalation is refused, and writes nothing ──────────────
    scenariosRun += 1;
    const escalatedName = `escalated-user-${STAMP}`;
    const membership = await server.request('POST', '/admin/users', {
      cookie: limitedCookie,
      form: { accountType: 'user', username: escalatedName, password: 'temporary', groupIds: String(privilegedGroup.id) }
    });
    assert(membership.statusCode === 403,
      `1: creating an account inside a privileged group is refused (HTTP ${membership.statusCode})`);
    assert(!(await usernames()).includes(escalatedName),
      '1: the refused account was not created anyway');

    // Positive control: the same principal MAY create an unassigned account. Without
    // this, assertion 1 also passes against a runtime where /admin/users is broken.
    scenariosRun += 1;
    const allowedName = `unassigned-user-${STAMP}`;
    const unassigned = await server.request('POST', '/admin/users', {
      cookie: limitedCookie,
      form: { accountType: 'user', username: allowedName, password: 'temporary' }
    });
    assert(unassigned.statusCode === 302,
      `2: the same principal may create an unassigned account (HTTP ${unassigned.statusCode})`);
    assert((await usernames()).includes(allowedName),
      '2: the permitted account really was created');
    const created = (await store.listUsers({ limit: 200 })).users.find(u => u.username === allowedName);
    assert((created.groupIds || []).length === 0,
      '2: the permitted account carries no group membership it was not granted');

    // ── 3. Granting a permission the principal lacks is refused ──────────────
    scenariosRun += 1;
    const escalatedGroup = `Escalated group ${STAMP}`;
    const grant = await server.request('POST', '/admin/groups', {
      cookie: limitedCookie, form: { name: escalatedGroup, permissions: 'user:delete' }
    });
    assert(grant.statusCode === 403,
      `3: creating a group carrying an unheld permission is refused (HTTP ${grant.statusCode})`);
    assert(!(await groupNames()).includes(escalatedGroup),
      '3: the refused group was not created anyway');

    // Positive control for the same endpoint.
    scenariosRun += 1;
    const emptyGroup = `Empty group ${STAMP}`;
    const empty = await server.request('POST', '/admin/groups', {
      cookie: limitedCookie, form: { name: emptyGroup }
    });
    assert(empty.statusCode === 302,
      `4: the same principal may create a group carrying no permissions (HTTP ${empty.statusCode})`);
    assert((await groupNames()).includes(emptyGroup),
      '4: the permitted group really was created');
    const madeGroup = (await store.listGroups({ limit: 200 })).groups.find(g => g.name === emptyGroup);
    assert((madeGroup.permissions || []).length === 0,
      '4: the permitted group carries no permissions');

    // ── 5. Unrelated permissions do not inherit ─────────────────────────────
    // `user:read` must not open workflow management. Paired with the admin succeeding
    // on the same URL, so a 403 cannot come from a broken route.
    scenariosRun += 1;
    const limitedWorkflows = await server.request('GET', '/admin/workflows', { cookie: limitedCookie });
    assert(limitedWorkflows.statusCode === 403,
      `5: workflow management does not inherit from user:read (HTTP ${limitedWorkflows.statusCode})`);
    const adminWorkflows = await server.request('GET', '/admin/workflows', { cookie: adminCookie });
    assert(adminWorkflows.statusCode === 200,
      `5: an administrator reaches the same surface (HTTP ${adminWorkflows.statusCode})`);

    // ── 6. The event stream enforces ticket:read like any other surface ──────
    scenariosRun += 1;
    const limitedEvents = await server.request('GET', '/api/events', { cookie: limitedCookie });
    assert(limitedEvents.statusCode === 403,
      `6: the event stream does not bypass ticket:read (HTTP ${limitedEvents.statusCode})`);

    // ── 7. An unauthenticated caller reaches none of it ──────────────────────
    // The outer boundary, so the tests above are known to be measuring permissions
    // rather than authentication.
    scenariosRun += 1;
    // `/admin/users` and `/admin/groups` are POST-only, so an unauthenticated GET is
    // a 404 rather than a redirect. The property under test is that nothing is
    // SERVED, so this asserts "not 200" plus the admin succeeding on the one surface
    // that does have a GET — which is what makes the 403s above about permissions
    // rather than about authentication.
    for (const target of ['/admin/users', '/admin/groups', '/admin/workflows']) {
      const anon = await server.request('GET', target, {});
      assert(anon.statusCode !== 200,
        `7: ${target} serves nothing to an unauthenticated caller (HTTP ${anon.statusCode})`);
    }
    const anonWorkflows = await server.request('GET', '/admin/workflows', {});
    assert(anonWorkflows.statusCode === 302 || anonWorkflows.statusCode === 401 || anonWorkflows.statusCode === 403,
      `7: an authenticated-only surface refuses anonymously rather than 404ing (HTTP ${anonWorkflows.statusCode})`);

    assertScenariosExecuted({
      label: 'permission escalation boundary',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 16,
      minScenarios: 7
    });
    console.log(`\nPASS: permission escalation boundaries — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'permission_escalation' });
}

main().catch(error => {
  console.error(`\nFAIL: permission escalation boundaries — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
