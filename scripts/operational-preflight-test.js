#!/usr/bin/env node
'use strict';

// OP-PREFLIGHT-A deterministic owner. Covers the operational deployment
// preflight WITHOUT any database contact:
//   - `--self-test` CLI mode passes (pure no-contact vignettes);
//   - the read-only posture is structural: no mutation surface, no migration
//     call, no T10 authorization or repair call anywhere in the preflight;
//   - the composition uses the canonical owners only (environment registry,
//     single operational authority decision, health-readiness walk, canonical
//     store probe/integrity gate);
//   - refusal shapes fail closed before any contact (unconfigured channel,
//     blank explicit channel, invalid boot configuration, unreachable target);
//   - rendered identities are credential-free.
// The PostgreSQL-native live posture (current ledger PASS, behind-template
// refusal, agent observation) is owned by p6-s2-readiness-postgres-test.js
// to avoid a second database-harness in the deterministic list.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { runOperationalPreflight } = require('./operational-preflight');
const { LOCAL_ENV_PATH } = require('./dev-environment');

async function main() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-preflight-owner-'));
  const absentFile = path.join(fixtureDir, 'absent.env');
  try {
    // 1. The CLI self-test passes end to end without any database contact.
    const selfTest = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'operational-preflight.js'), '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(selfTest.status, 0, `--self-test must pass (exit ${selfTest.status}):\n${selfTest.stdout}\n${selfTest.stderr}`);
    assert.match(selfTest.stdout, /PASS: operational preflight self-test \(no database contact\)/);

    // 2. Refusal shapes fail closed before any contact.
    const unconfigured = await runOperationalPreflight({ env: {}, cwd: fixtureDir, localEnvFile: absentFile });
    assert.equal(unconfigured.ok, false, 'an unconfigured operational channel refuses');
    assert.match(String(unconfigured.reason), /requires an explicit nonempty DATABASE_URL/);
    assert.ok(!/\bD\W*ATABASE_URL='/.test(ffs(unconfigured.facts.identity)), 'no identity when unauthorized');

    const blank = await runOperationalPreflight({ env: { DATABASE_URL: '' }, cwd: fixtureDir, localEnvFile: absentFile });
    assert.equal(blank.ok, false, 'an explicitly blank DATABASE_URL refuses (never .env.local fallback)');
    assert.match(String(blank.reason), /explicitly present but empty/);

    const whitespace = await runOperationalPreflight({ env: { DATABASE_URL: '  \t  ' }, cwd: fixtureDir, localEnvFile: absentFile });
    assert.equal(whitespace.ok, false, 'a whitespace-only DATABASE_URL refuses');
    assert.match(String(whitespace.reason), /explicitly present but empty/);

    const invalidConfiguration = await runOperationalPreflight({
      env: { DATABASE_URL: 'postgresql://ops:pw@192.0.2.9:7200/opsdb', SESSION_SECRET: 'short' },
      cwd: fixtureDir,
      localEnvFile: absentFile
    });
    assert.equal(invalidConfiguration.ok, false, 'invalid boot configuration refuses');
    assert.match(String(invalidConfiguration.reason), /configuration failure/);

    const unreachable = await runOperationalPreflight({
      env: { DATABASE_URL: 'postgresql://ops:pw@192.0.2.9:7200/opsdb',
        SESSION_SECRET: `operational-preflight-secret-${'x'.repeat(64)}` },
      cwd: fixtureDir,
      localEnvFile: absentFile
    });
    assert.equal(unreachable.ok, false, 'an unreachable operational database refuses');
    assert.match(String(unreachable.reason), /unreachable/);

    // 3. Credential-free rendering everywhere.
    for (const result of [invalidConfiguration, unreachable]) {
      assert.doesNotMatch(String(result.reason), /ops:pw/);
      assert.doesNotMatch(result.lines.join('\n'), /ops:pw/);
    }

    // 4. The authorized target identity is printed before any DB contact and
    //    stays credential-free (no password material, no connection string).
    assert.match(unreachable.lines.join('\n'), /operational channel: environment;/);
    assert.match(unreachable.lines.join('\n'), /host 192\.0\.2\.9, port 7200, database opsdb, schema ticket_system/);
    assert.doesNotMatch(unreachable.lines.join('\n'), /postgresql/);

    // 5. Structural read-only anchors: no mutation, no migration execution, no
    //    T10 authorization or repair surface in the preflight.
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'operational-preflight.js'), 'utf8');
    assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE)\b/, 'the preflight contains no SQL mutation keywords');
    assert.doesNotMatch(source, /\.migrate\(/, 'the preflight never executes the migration command');
    assert.doesNotMatch(source, /repair|authorize-migration|T10_REPAIR/i,
      'the preflight contains no repair or migration-authorization surface');
    assert.match(source, /runOperationalPreflight/);
    assert.match(source, /resolveOperationalChannelAuthority/,
      'the exact operational channel must come from the single pre-normalization authority decision');
    assert.match(source, /getMigrationStatus\(\)/, 'ledger facts come from the canonical probe');
    assert.match(source, /prepareRuntimePersistence\(\)/, 'the T10 integrity gate is the identity-compatibility owner');
    assert.match(source, /validateEnvironment\(env, \{ context: 'boot' \}\)/,
      'configuration validity must use the canonical registry gate');
    assert.match(source, /effectRootReadiness\(/, 'effect-root usability must use the single canonical walk');
    assert.doesNotMatch(source, /dev:doctor/,
      'the operational preflight must not route through the disposable development doctor');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  assert.ok(LOCAL_ENV_PATH.endsWith('.env.local'), 'the .env.local authority seam is the file owner');
  console.log('PASS: operational preflight is read-only, single-authority, and fails closed before contact');
}

function ffs(value) {
  return value === null || value === undefined ? '' : String(value);
}

main().catch(error => {
  console.error(`FAIL: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
