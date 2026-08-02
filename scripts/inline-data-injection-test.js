#!/usr/bin/env node
'use strict';
// Inline data injection safety — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// The injection-security half of `rbac-and-inline-data-security-test.js`, kept separate
// from the authority half throughout the A20 authority work because it is not an
// authority boundary: `permission-escalation-boundary-test.js` owns who may act, and
// this owns what operator-controlled text may do once rendered.
//
// THE BOUNDARIES IT GUARDS, taken from the historical assertions rather than guessed:
//   `/process-templates`  agent names rendered into an inline script/data block
//   `/`                   the ticket-creation page's allocated-agent selector
//
// THE ATTACK. An agent name is operator-supplied text that reaches an inline
// `<script>` data block. A name containing `</script>` terminates the block early, and
// everything after it becomes live markup in the page's own origin. So the escaping
// that matters is SCRIPT-CONTEXT escaping — `\u003c/script\u003e` — not HTML entity
// escaping, which is inert inside a script block.
//
// FOUR PROPERTIES:
//   1. the hostile name never appears RAW
//   2. it appears script-context ESCAPED, proving it was rendered rather than dropped
//   3. no provider credential accompanies it
//   4. client code assigns text through safe DOM APIs, never an HTML parsing sink
//
// (2) IS THE POSITIVE CONTROL AND IT IS LOAD-BEARING. "The raw payload is absent" is
// satisfied by a page that renders no agents at all — by a broken query, an empty list,
// or a 500. Requiring the escaped form proves the data reached the page and was made
// safe, which is the actual contract.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();

// Hostile payload: closes a script block, then injects executable markup. Quotes,
// backslashes and an HTML entity are included so escaping is exercised on each.
const HOSTILE = `</script><img src=x onerror=globalThis.__xss=1>"'\\&amp;`;
// Distinctive so absence means something; a generic "secret" would match noise.
const PROVIDER_SECRET = `sk-INLINEDATASECRET-${STAMP}-zzzzzzzzzzzz`;
const BENIGN = `BenignAgent-${STAMP}`;
const MANAGER_PASSWORD = 'process-manager-password-inline';

const assert = createAsserter();
let scenariosRun = 0;

async function main() {
  await withHarness('inline data injection', async ({ store, startServer }) => {
    // Two agents: one hostile-named, one benign. The benign one is the control that
    // proves the surfaces render agent data at all.
    await store.createConfiguredAgent({
      value: { name: `${HOSTILE}${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: PROVIDER_SECRET },
      groupIds: [], changedBy: 'inline-data-injection-test'
    });
    await store.createConfiguredAgent({
      value: { name: BENIGN, provider: 'openai', model: 'gpt-4.1-mini', apiKey: `sk-benign-${STAMP}` },
      groupIds: [], changedBy: 'inline-data-injection-test'
    });

    // A non-admin principal with only processTemplate:manage, matching the historical
    // fixture: the page must be safe for the principal that actually reaches it.
    const managerGroup = (await store.createGroup({
      value: { name: `Process managers ${STAMP}`, permissions: ['processTemplate:manage'], canReceiveTickets: false },
      changedBy: 'inline-data-injection-test'
    })).group;
    await store.createUser({
      value: { username: 'process-manager', passwordHash: await argon2.hash(MANAGER_PASSWORD) },
      groupIds: [managerGroup.id], changedBy: 'inline-data-injection-test'
    });

    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
    const adminCookie = await server.login();
    const managerCookie = await server.login('process-manager', MANAGER_PASSWORD);

    // The escaped form the runtime must emit inside a script context.
    const ESCAPED_SCRIPT_CLOSE = '\\u003c/script\\u003e';

    async function assertSafeSurface(label, page, { expectBenign = true } = {}) {
      scenariosRun += 1;
      assert(page.statusCode === 200, `${label}: renders (HTTP ${page.statusCode})`);

      // 1. Never raw.
      assert(!page.body.includes('</script><img'),
        `${label}: the hostile name never appears as raw script-closing markup`);
      // NOT asserted: absence of the `onerror=` text. Once `</script>` is escaped the
      // rest of the payload is an inert JS string literal, and demanding its absence
      // would be asserting that the data was DROPPED rather than made safe. The
      // vulnerability signature is raw block termination followed by markup, which the
      // assertion above covers; this one checks the markup never lands as an element.
      assert(!/<img[^>]*src=x/i.test(page.body),
        `${label}: the hostile payload never lands as a real <img> element`);

      // 2. Positive control — the data DID render, escaped.
      assert(page.body.includes(ESCAPED_SCRIPT_CLOSE),
        `${label}: the hostile name is present in script-context ESCAPED form, so it was rendered rather than dropped`);
      if (expectBenign) {
        assert(page.body.includes(BENIGN),
          `${label}: the benign agent renders normally, so escaping did not break legitimate data`);
      }

      // 3. No credential travels with it.
      assert(!page.body.includes(PROVIDER_SECRET),
        `${label}: the hostile agent's provider key does not reach the page`);
      assert(!page.body.includes('sk-benign-'),
        `${label}: no provider key reaches the page, hostile or otherwise`);
      assert(!page.body.includes('passwordHash'),
        `${label}: no password hash reaches the page`);

      return page.body;
    }

    // ── 1. The process-templates page ───────────────────────────────────────
    const templates = await server.request('GET', '/process-templates', { cookie: managerCookie });
    const templatesBody = await assertSafeSurface('process-templates', templates);
    assert(templatesBody.includes('textContent'),
      '1: the template selector assigns labels through textContent, not markup');

    // ── 2. The ticket-creation page and its allocated-agent selector ─────────
    const create = await server.request('GET', '/', { cookie: adminCookie });
    const createBody = await assertSafeSurface('ticket-creation', create);
    assert(createBody.includes('replaceChildren()'),
      '2: allocated-agent rows are rebuilt through DOM APIs rather than markup assignment');
    assert(createBody.includes('agentName.textContent'),
      '2: allocated-agent labels are assigned through textContent');
    assert(!createBody.includes('ownedPathsContainer.innerHTML'),
      '2: allocated-agent rows use no HTML parsing sink');

    // ── 3. The JSON API serializes the same data without leaking ────────────
    // A separate boundary: escaping the HTML page would not help if the API handed the
    // same record to a client verbatim with its credential attached.
    scenariosRun += 1;
    const api = await server.request('GET', '/api/configured-agents', { cookie: adminCookie });
    if (api.statusCode === 200) {
      assert(!api.body.includes(PROVIDER_SECRET),
        '3: the agents API does not serialize provider keys');
      assert(!/"apiKey"\s*:\s*"sk-/.test(api.body),
        '3: the agents API carries no populated apiKey field');
      assert(api.body.includes(BENIGN),
        '3: the agents API does return agent data, so the absence checks are meaningful');
    } else {
      // The surface must not be silently skipped: record what it did instead.
      assert(api.statusCode === 403 || api.statusCode === 404,
        `3: the agents API is either readable or explicitly unavailable (HTTP ${api.statusCode})`);
    }

    assertScenariosExecuted({
      label: 'inline data injection',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 18,
      minScenarios: 3
    });
    console.log(`\nPASS: inline data injection safety — ${scenariosRun} surfaces, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'inline_injection' });
}

main().catch(error => {
  console.error(`\nFAIL: inline data injection safety — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
