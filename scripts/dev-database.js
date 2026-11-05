#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const {
  DEVELOPMENT_TARGET_SCHEMA,
  applyLocalEnv,
  assertDevelopmentTargetUsable,
  bundledDatabaseUrl,
  disposableDevelopmentTarget,
  formatTargetIdentity,
  safeErrorMessage,
  targetIdentity,
} = require('./dev-environment');
const { quoteIdentifier } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'compose.dev.yml');

// ── Authority property of this owner ───────────────────────────────────────
//
// COMPOSE-A: disposable migration authority cannot be obtained without the
// verified bundled-Compose lifecycle. No proof mechanism is caller-facing:
// the production lifecycle uses the real repository compose.dev.yml, the
// real repository-owned runtime selection, the real process-launch
// implementation, the real PostgreSQL verification implementation, and the
// real PostgreSQL client implementation — all imported or declared above.
// The two exported operations take NO arguments, so no caller can redirect
// the target, replace the ownership proof, or skip the bundled-service
// verification before the single disposable-authority construction site.
//
// TRUST-BOUNDARY HONESTY: this is REPOSITORY/APPLICATION defense in depth.
// It protects the ordinary DevEx path from ACCIDENTAL environment and
// runtime redirection (stale contexts, stray endpoint variables, ambient
// executable shadowing). It is NOT protection against arbitrary code
// executing under the same unrestricted Unix principal: such a principal
// owns its own process environment and can neither be constrained nor
// verified by this application layer. Adversarial developer-agent isolation
// from operational state is an OS/capability concern and is deliberately
// outside this correction (docs: P6-DEVEX-A decision record).

// ── Supported lifecycle runtime: system Docker Compose only ───────────────
//
// The repository's disposable development topology is proven against a
// system-installed Docker Compose (docker compose v2 plugin). Podman's
// local/remote endpoint selection (CONTAINER_HOST/CONTAINER_CONNECTION and
// its configured connections) is not repository-owned for this automatic
// path, so this lifecycle deliberately does not support it:
// determinism over runtime breadth.
const COMPOSE_PROGRAM = 'docker';
// Absolute resolution ONLY: the ambient PATH is never consulted, so a
// caller-modified PATH cannot choose the runtime. Candidate locations are
// ordinary system-owned binary directories, preferred in this order; every
// candidate is then validated (regular ROOT-OWNED executable file, not
// writable by the invoking user — file or any containing directory) before
// use.
const COMPOSE_TRUSTED_BIN_DIRECTORIES = Object.freeze([
  path.resolve('/usr/bin'),
  path.resolve('/bin'),
  path.resolve('/usr/local/bin')
]);
// Accepted system Docker CLI-plugin sites for the Compose plugin. User-level
// plugin locations under a personal Docker configuration NEVER participate:
// the lifecycle runs the Docker CLI with an explicitly created sterile
// configuration directory, and the loaded Compose plugin must resolve from one
// of these root-owned system sites (the installed topology satisfies this).
const DOCKER_CLI_PLUGIN_SYSTEM_DIRECTORIES = Object.freeze([
  path.resolve('/usr/libexec/docker/cli-plugins'),
  path.resolve('/usr/lib/docker/cli-plugins')
]);
// The Docker CLI surfaces the plugin paths actually loaded under the current
// configuration through docker info ClientInfo.
const DOCKER_PLUGIN_INFO_FORMAT = '{{json .ClientInfo.Plugins}}';
const COMPOSE_PLUGIN_NAME = 'compose';
// Explicit deterministic selection of the LOCAL DEFAULT engine rather than
// relying on ambient Docker configuration: the global flag placement is the
// only form Docker accepts for compose in front of the subcommand.
const COMPOSE_CONTEXT_ARGS = Object.freeze(['--context', 'default']);
const COMPOSE_UP_EXTRA_ARGS = Object.freeze(['up', '-d', '--wait']);

function commandSucceeded(result) {
  return Boolean(result) && !result.error && result.status === 0;
}

// Trivially substitutable writability: world-writable, group-writable to one
// of the invoking user's groups, or owned-and-writable by the invoking user.
// Mode/ownership based; deliberately not a general executable-trust
// framework — this is the dev-database owner's own narrow policy.
function isUserWritableLocation(statInfo) {
  const writingUser = process.getuid ? process.getuid() : null;
  if (writingUser === null) return true; // fail closed when the POSIX facts cannot be read
  if ((statInfo.mode & 0o002) === 0o002) return true;
  if ((statInfo.mode & 0o020) === 0o020) {
    const userGroups = process.getGroups ? process.getGroups() : [];
    const groupWritableToUser = userGroups.includes(statInfo.gid);
    if (groupWritableToUser) return true;
    if (statInfo.gid === writingUser) return true;
  }
  return statInfo.uid === writingUser && (statInfo.mode & 0o200) === 0o200;
}

// PURE classifier (no side effects): accepts an absolute candidate path and
// returns trusted-executable facts, or null when the candidate is absent,
// symlinked into a foreign prefix, not a regular ROOT-OWNED executable file,
// or writable by the invoking user (file or any containing directory). Root
// ownership is enforced for the Docker CLI and its Compose plugin because the
// supported Linux topology already satisfies it.
function trustedComposeRuntimeExecutablePath(candidatePath) {
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) return null;
  let real;
  try { real = fs.realpathSync(candidatePath); } catch (_) { return null; }
  if (!path.isAbsolute(real)) return null;
  let fileStat;
  try { fileStat = fs.statSync(real); } catch (_) { return null; }
  if (!fileStat.isFile()) return null;
  if (fileStat.uid !== 0) return null;
  if ((fileStat.mode & 0o111) !== 0o111) return null;
  if (isUserWritableLocation(fileStat)) return null;
  // Every containing directory of the REAL target must itself be root-owned
  // and non-substitutable by the invoking user.
  const segments = real.split(path.sep).filter(Boolean);
  let walked = '';
  for (const segment of segments.slice(0, -1)) {
    walked = path.join(path.sep, walked, segment);
    let dirStat;
    try { dirStat = fs.statSync(walked); } catch (_) { return null; }
    if (!dirStat.isDirectory() || dirStat.uid !== 0 || isUserWritableLocation(dirStat)) return null;
  }
  return Object.freeze({
    absolutePath: real,
    programRoot: path.dirname(real),
    program: path.basename(real)
  });
}

// Sterile temporary Docker CLI configuration directory: the lifecycle NEVER
// reads a caller's personal Docker configuration/plugins. Plugin discovery
// under the sterile configuration resolves from the system plugin sites
// (verified on the supported topology; the personal `~/.docker/cli-plugins`
// never participates).
function createSterileDockerConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-dev-docker-config-'));
}

function isAcceptedPluginSite(programRoot) {
  const acceptedSites = new Set(DOCKER_CLI_PLUGIN_SYSTEM_DIRECTORIES.map(root => {
    try { return fs.realpathSync(root); } catch (_) { return null; }
  }).filter(Boolean));
  try {
    return acceptedSites.has(fs.realpathSync(programRoot));
  } catch (_) {
    return false;
  }
}

function selectComposeRuntime() {
  const trustedProgramRoot = new Set(COMPOSE_TRUSTED_BIN_DIRECTORIES.map(root => {
    try { return fs.realpathSync(root); } catch (_) { return null; }
  }).filter(Boolean));
  let resolved = null;
  for (const root of COMPOSE_TRUSTED_BIN_DIRECTORIES) {
    const candidate = trustedComposeRuntimeExecutablePath(path.join(root, COMPOSE_PROGRAM));
    if (!candidate) continue;
    if (trustedProgramRoot.has(candidate.programRoot)) {
      resolved = candidate;
      break;
    }
    // A symlink that escapes the trusted prefix is refused (fail closed).
  }
  if (!resolved) return null;
  const sterileDockerConfig = createSterileDockerConfig();
  const discardSterileDockerConfig = () => {
    try { fs.rmSync(sterileDockerConfig, { recursive: true, force: true }); } catch (_) {}
  };
  const childEnvironment = {
    ...composeInvocationEnvironment(process.env),
    DOCKER_CONFIG: sterileDockerConfig
  };
  // Prove the resolved absolute runtime answers as Docker Compose.
  const probe = spawnSync(resolved.absolutePath, [...COMPOSE_CONTEXT_ARGS, 'compose', 'version'], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: childEnvironment
  });
  if (!commandSucceeded(probe)) {
    discardSterileDockerConfig();
    return null;
  }
  // Recover the Compose plugin path ACTUALLY loaded by that sterile
  // system-Docker invocation, then validate it against the narrow supported
  // Linux policy (absolute, regular ROOT-OWNED executable, not writable by
  // the invoking user, under an accepted system CLI-plugin site).
  const info = spawnSync(
    resolved.absolutePath,
    [...COMPOSE_CONTEXT_ARGS, 'info', '--format', DOCKER_PLUGIN_INFO_FORMAT],
    { encoding: 'utf8', stdio: 'pipe', env: childEnvironment }
  );
  if (!commandSucceeded(info)) {
    discardSterileDockerConfig();
    return null;
  }
  let plugins;
  try { plugins = JSON.parse(String(info.stdout).trim()); } catch (_) {
    discardSterileDockerConfig();
    return null;
  }
  const loadedComposePlugin = (Array.isArray(plugins) ? plugins : [])
    .filter(entry => entry && entry.Name === COMPOSE_PLUGIN_NAME && typeof entry.Path === 'string')[0];
  const pluginCandidate = loadedComposePlugin
    ? trustedComposeRuntimeExecutablePath(loadedComposePlugin.Path)
    : null;
  if (!pluginCandidate || !isAcceptedPluginSite(pluginCandidate.programRoot)) {
    discardSterileDockerConfig();
    return null;
  }
  return Object.freeze({
    command: resolved.absolutePath,
    programRoot: resolved.programRoot,
    label: `Docker Compose (system ${resolved.programRoot}/docker, plugin ${pluginCandidate.programRoot}/${pluginCandidate.program})`,
    pluginPath: pluginCandidate.absolutePath,
    pluginRoot: pluginCandidate.programRoot,
    dockerConfigDir: sterileDockerConfig,
    discardSterileDockerConfig
  });
}

// Docker/Podman runtime and Compose project redirection environment is
// scrubbed for the Compose CHILD PROCESS ONLY (this process keeps its own
// environment; consumer scopes are unaffected). Compose then receives the
// explicit -f flag below, so no ambient project selection can apply. The
// default local engine is selected explicitly via --context default.
const COMPOSE_RUNTIME_REDIRECT_ENV_KEYS = Object.freeze([
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'COMPOSE_FILE',
  'COMPOSE_PROJECT_NAME'
]);

// PURE helper (no side effects): the exact child-process environment for a
// deterministic local Compose invocation. Exposed for deterministic tests
// only; the lifecycle uses it internally and callers cannot redirect it.
function composeInvocationEnvironment(env = process.env) {
  const fixed = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (COMPOSE_RUNTIME_REDIRECT_ENV_KEYS.includes(key)) continue;
    fixed[key] = value;
  }
  return fixed;
}

async function verifyConfiguredDatabase({ databaseTarget } = {}) {
  if (!databaseTarget || !databaseTarget.databaseUrl) {
    throw new Error('A resolved development database target is required for host readiness');
  }

  const client = new Client({
    connectionString: databaseTarget.databaseUrl,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    application_name: 'ticket-system-dev-database-readiness'
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    throw new Error(
      'The development database target cannot complete a host-side PostgreSQL query: ' + safeErrorMessage(error)
    );
  } finally {
    try { await client.end(); } catch (_) {}
  }
  return databaseTarget;
}

// ── Bundled infrastructure lifecycle (fixed disposable development target) ─
//
// The requested host port is permitted ONLY through the bundled-compose
// development owner: start/verify the repository's bundled PostgreSQL service
// first; refuse when that owner cannot own the port; never silently connect
// to an arbitrary PostgreSQL process found on the requested loopback port and
// grant it disposable authority. The development identity is code-owned
// (scripts/dev-environment.js); TICKET_SYSTEM_POSTGRES_PORT is the only
// environmental input and only through this compose owner.
async function startDevelopmentDatabase() {
  applyLocalEnv(process.env);
  // The collision guard runs BEFORE any compose contact, database contact, or
  // mutation: a configured operational target identical to the fixed
  // disposable development target refuses here.
  const devTarget = assertDevelopmentTargetUsable(process.env);

  const selectedRuntime = selectComposeRuntime();
  if (!selectedRuntime) {
    throw new Error(
      'A trusted system Docker Compose installation is required to start the bundled development ' +
      'PostgreSQL service that owns the fixed disposable development target (the requested port is ' +
      'permitted only through this owner). The lifecycle requires the absolute system Docker CLI with a ' +
      'root-owned Compose CLI plugin under an accepted system plugin site; the ambient executable ' +
      'resolution and the personal Docker configuration never participate. Install Docker Compose ' +
      'system-wide; Podman is not supported by this automatic development path.'
    );
  }
  try {
    const result = spawnSync(
      selectedRuntime.command,
      [...COMPOSE_CONTEXT_ARGS, 'compose', '-f', COMPOSE_FILE, ...COMPOSE_UP_EXTRA_ARGS],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...composeInvocationEnvironment(process.env),
          DOCKER_CONFIG: selectedRuntime.dockerConfigDir,
          TICKET_SYSTEM_POSTGRES_PORT: String(devTarget.port)
        }
      }
    );
    if (!commandSucceeded(result)) {
      throw result && result.error
        ? result.error
        : new Error(selectedRuntime.label + ' exited with status ' + String(result && result.status));
    }
  } finally {
    // The sterile Docker CLI configuration lived exactly for this lifecycle.
    selectedRuntime.discardSterileDockerConfig();
  }
  // Prove the bundled compose service actually answers on the mapped port
  // (it created the bundled database `ticket_system` at initialization), and
  // that this loopback endpoint is the compose-owned one — this connection
  // target is the service the port owner starts, not an arbitrary listener.
  await verifyConfiguredDatabase({
    databaseTarget: {
      kind: 'bundled',
      databaseUrl: bundledDatabaseUrl(devTarget.port)
    }
  });
  return Object.freeze({
    devTarget,
    runtime: Object.freeze({ command: selectedRuntime.command, label: selectedRuntime.label })
  });
}

// ── Disposable migration authority (single, lifecycle-bound construction) ──
//
// THE ONE non-test production construction site that grants the code-declared
// disposable migration authority. It is deliberately MODULE-INTERNAL (never
// exported): no caller can obtain a disposable-migration store from env, a
// port, a target object, or a database URL alone. Every reachable flow that
// constructs this store FIRST runs the bundled-compose ownership proof in the
// same flow — collision guard → bundled compose start → bundled service
// verification on the mapped port → fixed development database ensure — and
// only the compose-verified flow reaches here. The target is derived
// INTERNALLY from the fixed constants; no connection string, database,
// schema, host, or target object is accepted from a caller.
function createDisposableDevelopmentStore(env = process.env) {
  const target = disposableDevelopmentTarget(env);
  const { PostgresRuntimeStore } = require('../persistence/postgres/store');
  return new PostgresRuntimeStore({
    connectionString: target.databaseUrl,
    schema: DEVELOPMENT_TARGET_SCHEMA,
    disposableMigrations: true
  });
}

// Module-internal identity gate for the destructive create/drop helpers.
// The presented target must equal the fixed, internally derived disposable
// development identity on ALL FOUR normalized fields (host, port, database,
// schema) — not just database/schema — where the port is the one the bundled
// compose owner verified for this same devTarget. `localhost` is
// deterministically read as `127.0.0.1`. A caller-supplied or
// port-redirected identity cannot pass because the expected identity is
// derived here, not passed in.
function assertFixedDevelopmentIdentity(env, devTarget, action) {
  if (!devTarget) {
    throw new Error(
      `Refusing development database ${action}: no target was presented for the verification gate`
    );
  }
  let expected;
  let presentedIdentity;
  try {
    expected = disposableDevelopmentTarget(env);
    presentedIdentity = targetIdentity(devTarget);
  } catch (error) {
    throw new Error(
      `Refusing development database ${action}: unable to verify the fixed disposable ` +
      'development identity (' + safeErrorMessage(error) + ')'
    );
  }
  const fixed = targetIdentity(expected);
  if (JSON.stringify(presentedIdentity) !== JSON.stringify(fixed) ||
      devTarget.databaseUrl !== expected.databaseUrl) {
    throw new Error(
      `Refusing development database ${action}: the target is not the fixed disposable development identity ` +
      `(${formatTargetIdentity(fixed)})`
    );
  }
  return fixed;
}

// Idempotently create the fixed disposable development database through the
// bundled maintenance connection (the compose-created `ticket_system` admin
// database). A concurrent `CREATE DATABASE` race is safe: the canonical
// duplicate-database SQLSTATE (42P04) is resolved as "already present".
// Module-internal: only the verified compose lifecycle calls it, always with
// its own compose-verified devTarget (identity checked against the
// internally derived fixed identity above; never caller-selectable).
async function ensureDisposableDevelopmentDatabase(env, devTarget) {
  const fixed = assertFixedDevelopmentIdentity(env, devTarget, 'creation');
  const client = new Client({
    connectionString: bundledDatabaseUrl(fixed.port),
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    application_name: 'ticket-system-dev-database-create'
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error('Development database creation failed: ' + safeErrorMessage(error));
  }
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(fixed.database)}`);
    return { devTarget, created: true };
  } catch (error) {
    if (error && error.code === '42P04') return { devTarget, created: false };
    throw new Error('Development database creation failed: ' + safeErrorMessage(error));
  } finally {
    try { await client.end(); } catch (_) {}
  }
}

// Destroy ONLY the fixed disposable development identity. Module-internal for
// the same reason: the identity must be the code-owned constant checked
// against the compose-verified devTarget (`npm run dev:reset` never accepts an
// arbitrary target argument, URL override, or mode flag).
async function destroyDisposableDevelopmentDatabase(env, devTarget) {
  const fixed = assertFixedDevelopmentIdentity(env, devTarget, 'destruction');
  const client = new Client({
    connectionString: bundledDatabaseUrl(fixed.port),
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    application_name: 'ticket-system-dev-database-destroy'
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error('Development database destruction failed: ' + safeErrorMessage(error));
  }
  try {
    // WITH (FORCE) (PostgreSQL 13+) terminates remaining connections so a
    // partially torn-down dev server session cannot block the reset.
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(fixed.database)} WITH (FORCE)`);
    return { devTarget, destroyed: true };
  } finally {
    try { await client.end(); } catch (_) {}
  }
}

// Migration belongs to the verified lifecycle: the store is constructed HERE,
// only after the compose ownership proof in the calling flow has succeeded.
// The store is always closed before this helper returns; no store object ever
// escapes to a caller.
async function migrateDisposableDevelopmentDatabase(env = process.env) {
  const store = createDisposableDevelopmentStore(env);
  try {
    const applied = await store.migrate();
    return Object.freeze([...applied]);
  } finally {
    await store.close();
  }
}

// Required dev lifecycle steps 3–6 (scripts/dev.js, dev:setup, dev:db):
// collision guard, bundled PostgreSQL start/verification, development
// database creation, and a read-only readiness probe of the fixed
// development target. No mutation beyond the disposable development identity,
// and no migration authority is involved: callers needing disposable
// migration use prepareAndMigrateDisposableDevelopmentDatabase below.
// The lifecycle owns every proof mechanism (the real repository compose
// dev.yml file, the real trusted runtime selection, the real process-launch
// implementation, the real PostgreSQL verification, the real client); it
// accepts no caller identity or mechanics at all.
async function prepareDisposableDevelopmentDatabase() {
  const started = await startDevelopmentDatabase();
  const ensured = await ensureDisposableDevelopmentDatabase(process.env, started.devTarget);
  await verifyConfiguredDatabase({ databaseTarget: started.devTarget });
  return Object.freeze({
    devTarget: started.devTarget,
    created: ensured.created === true,
    runtime: started.runtime
  });
}

// HIGH-LEVEL SAFE OPERATION: bundle-verified prepare THEN disposable
// migration. Takes NO ARGUMENTS: internally — construct the fixed target from
// process environment configuration (TICKET_SYSTEM_POSTGRES_PORT through the
// compose owner) — collision guard — start/verify bundled Compose ownership —
// ensure the fixed database — probe — only THEN construct the disposable
// store — migrate — close the store — return sanitized target/result facts
// (devTarget identity, created flag, runtime label, applied migration
// versions). No authority-bearing store object is ever returned or exported.
async function prepareAndMigrateDisposableDevelopmentDatabase() {
  if (arguments.length > 0) {
    throw new Error(
      'prepareAndMigrateDisposableDevelopmentDatabase accepts no arguments: ' +
      'every proof mechanism of the disposable development authority is module-owned ' +
      '(real repository compose.dev.yml, trusted runtime selection, process launch, ' +
      'PostgreSQL verification, client)'
    );
  }
  const prepared = await prepareDisposableDevelopmentDatabase();
  const appliedVersions = await migrateDisposableDevelopmentDatabase(process.env);
  return Object.freeze({ ...prepared, appliedVersions });
}

// HIGH-LEVEL SAFE OPERATION: bounded destructive reset. Takes NO ARGUMENTS.
// Order (frozen): construct the fixed target internally from the process
// environment — collision guard — prove/verify bundled compose ownership —
// destroy ONLY the fixed development identity — recreate it — migrate it
// under the exact code-declared disposable authority — close the store —
// sanitized facts. Every identity is derived internally and checked against
// the compose-verified devTarget; no caller input can select the destruction
// target or replace any proof mechanism.
async function resetDisposableDevelopmentDatabase() {
  if (arguments.length > 0) {
    throw new Error(
      'resetDisposableDevelopmentDatabase accepts no arguments: ' +
      'every proof mechanism of the disposable development authority is module-owned ' +
      '(real repository compose.dev.yml, trusted runtime selection, process launch, ' +
      'PostgreSQL verification, client)'
    );
  }
  const started = await startDevelopmentDatabase();
  await destroyDisposableDevelopmentDatabase(process.env, started.devTarget);
  const ensured = await ensureDisposableDevelopmentDatabase(process.env, started.devTarget);
  const appliedVersions = await migrateDisposableDevelopmentDatabase(process.env);
  return Object.freeze({
    devTarget: started.devTarget,
    created: ensured.created === true,
    runtime: started.runtime,
    appliedVersions
  });
}

function printHelp() {
  console.log(
    'Usage: pnpm dev:db\n\n' +
    'Starts the bundled PostgreSQL 17 service and prepares the fixed repository-owned disposable\n' +
    'development database (ticket_system_dev; scripts/dev-environment.js). TICKET_SYSTEM_POSTGRES_PORT\n' +
    'is honored only through the bundled compose owner; DATABASE_URL cannot alter the development target.\n' +
    'Existing volumes and the development database are preserved (reset is `pnpm dev:reset`).'
  );
}

async function main() {
  if (process.argv.includes('--help')) {
    printHelp();
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:db does not accept arguments');
  const result = await prepareDisposableDevelopmentDatabase();
  console.log(
    `Development PostgreSQL (${result.runtime.label}) and disposable development database ` +
    `${result.devTarget.database} (schema ${result.devTarget.schema}) are ready.` +
    (result.created ? ' The development database was created.' : ' The development database already existed.') +
    ' Run pnpm dev:setup for initial configuration.'
  );
}

// ✅ COMPOSE-A export surface: the two zero-argument high-level operations are
// the only authority-bearing exports; both return lifecycle-owned facts only
// (never an authority-bearing store). The additionally exported
// trustedComposeRuntimeExecutablePath and composeInvocationEnvironment are
// PURE single-argument classifiers/helpers for deterministic tests — they
// take no lifecycle control, cannot construct or authorize a store, and the
// lifecycle consumes them internally from module-owned constants. The
// disposable-authority store constructor, the destructive create/drop
// helpers, the runtime selector, and the readiness verifier remain
// MODULE-INTERNAL: the only path to the authority site is the real
// production Compose ownership proof.
module.exports = {
  composeInvocationEnvironment,
  prepareAndMigrateDisposableDevelopmentDatabase,
  resetDisposableDevelopmentDatabase,
  trustedComposeRuntimeExecutablePath
};

if (require.main === module) {
  main().catch(error => {
    console.error('Development database setup failed: ' + safeErrorMessage(error));
    process.exit(1);
  });
}
