'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const dotenv = require('dotenv');
// P6-S2: the development tooling surface consumes the canonical executable
// environment registry (docs/DEPLOYMENT_CONTRACT.md §8) so validation
// semantics, defaults, and secret handling cannot drift between the server's
// boot surface and the doctor/setup/docs surface.
const {
  validateAdminPassword: registryValidateAdminPassword,
  validatePostgresUrl: registryValidatePostgresUrl,
  validateSessionSecret: registryValidateSessionSecret
} = require('../runtime/environment-config-registry');
// Effect-root usability walk (non-mutating) is owned by ONE helper consumed
// by both the health routes and the doctor.
const { effectRootReadiness } = require('../runtime/health-readiness');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_ENV_PATH = path.join(ROOT, '.env.local');
const DEFAULT_BUNDLED_POSTGRES_PORT = 5432;
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_ADMIN_PASSWORD_LENGTH = 12;
const DEVELOPMENT_KEYS = Object.freeze([
  'DATABASE_URL',
  'TICKET_SYSTEM_POSTGRES_PORT',
  'POSTGRES_SCHEMA',
  'SESSION_SECRET',
  'ADMIN_BOOTSTRAP_PASSWORD',
  'DEV_AGENT_PROVIDER',
  'DEV_AGENT_NAME',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OLLAMA_MODEL',
  'OLLAMA_BASE_URL',
  'WORKSPACE_ROOT',
  'ARTIFACT_ROOT'
]);

function loadLocalEnvFile(filePath = LOCAL_ENV_PATH) {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath));
}

function applyLocalEnv(env = process.env, filePath = LOCAL_ENV_PATH) {
  const values = loadLocalEnvFile(filePath);
  for (const key of DEVELOPMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(env, key) && Object.prototype.hasOwnProperty.call(values, key)) {
      env[key] = values[key];
    }
  }
  // Normalize the effective URL back into the shared environment. Consumers
  // such as the development server read DATABASE_URL directly after the
  // preflight, so they must see the same port the resolver gave Compose,
  // setup, doctor, and the host-readiness probe.
  env.DATABASE_URL = resolveDevelopmentDatabaseTarget(env).databaseUrl;
  return values;
}

function validateDatabaseUrl(value) {
  return registryValidatePostgresUrl(value);
}

// Bundled compose development credentials (compose.dev.yml owns them). Code
// constants — never configuration, never a caller input.
const BUNDLED_CREDENTIALS = Object.freeze({ user: 'ticket_system', password: 'ticket_system' });

function bundledCredentialUrl(database, port) {
  return `postgresql://${BUNDLED_CREDENTIALS.user}:${BUNDLED_CREDENTIALS.password}@127.0.0.1:${port}/${database}`;
}

function bundledDatabaseUrl(port = DEFAULT_BUNDLED_POSTGRES_PORT) {
  const normalizedPort = resolveBundledComposePort({ TICKET_SYSTEM_POSTGRES_PORT: port });
  return bundledCredentialUrl('ticket_system', normalizedPort);
}

const DEFAULT_DATABASE_URL = bundledDatabaseUrl();

function isBundledDatabaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { return false; }
  return parsed.protocol === 'postgresql:' &&
    parsed.username === 'ticket_system' &&
    parsed.password === 'ticket_system' &&
    parsed.hostname === '127.0.0.1' &&
    parsed.pathname === '/ticket_system' &&
    parsed.search === '' &&
    parsed.hash === '';
}

// ONE bundled-port owner: the compose development infrastructure owns this
// mapping; the rule and message are exactly the shared owner's. The resolved
// port belongs to the DEVELOPMENT channel only and is resolved in every
// configuration because the development target exists independently of the
// operational one. It NEVER rewrites an explicitly supplied operational
// DATABASE_URL: the explicit URL owns the operational identity exactly,
// regardless of its shape (see the exact-identity branch below) — no
// localhost, bundled-credentials, database-name, or URL-shape heuristic
// reconnects the two channels.
function resolveDevelopmentDatabaseTarget(env = process.env) {
  const configuredUrl = String(env.DATABASE_URL || '').trim();
  const configuredPort = String(env.TICKET_SYSTEM_POSTGRES_PORT || '').trim();
  const composePort = resolveBundledComposePort(env);

  if (!configuredUrl) {
    return Object.freeze({
      kind: 'bundled',
      databaseUrl: bundledDatabaseUrl(composePort),
      composePort,
      source: configuredPort ? 'bundled-port' : 'default'
    });
  }

  const databaseError = validateDatabaseUrl(configuredUrl);
  if (databaseError) throw new Error(databaseError);
  // CHANNEL-SPLIT-A (exact): an EXPLICITLY supplied DATABASE_URL owns the
  // operational target EXACTLY — byte-exact URL, port, database, schema
  // (through POSTGRES_SCHEMA), always, with no exception for localhost,
  // bundled credentials, the bundled database name, or any resemblance to the
  // bundled default. TICKET_SYSTEM_POSTGRES_PORT MUST NOT rewrite the
  // explicit operational URL; it only ever selects the fixed disposable
  // development target, and no URL-shape heuristic reconnects the channels.
  return Object.freeze({
    kind: isBundledDatabaseUrl(configuredUrl) ? 'bundled' : 'external',
    databaseUrl: configuredUrl,
    composePort,
    source: 'database-url'
  });
}

// ── Fixed repository-owned disposable development target ───────────────────
//
// P6-DEVEX-A correction: the daily dev command needs ONE fixed, code-owned,
// disposable development identity that DATABASE_URL can never redirect. Every
// value below is a code constant. No environment variable, CLI flag, or caller
// argument may select the development database, schema, or host (the ONLY
// environmental input is TICKET_SYSTEM_POSTGRES_PORT because the bundled
// compose file already owns that host-port mapping; see
// resolveBundledComposePort). Disposability is an explicit code declaration —
// the module-internal verified-development lifecycle owner
// (scripts/dev-database.js) is the only place that grants it — never an
// environment kind, never a name inference, never a human bypass.
const DEVELOPMENT_TARGET_HOST = '127.0.0.1';
const DEVELOPMENT_TARGET_DATABASE = 'ticket_system_dev';
// The development schema is deliberately FIXED to the same code-owned schema
// name the operational default uses; the DATABASE name differs, so the
// collision guard below (host/port/database/schema) still separates the two
// identities. POSTGRES_SCHEMA is operational-only and cannot alter this.
const DEVELOPMENT_TARGET_SCHEMA = 'ticket_system';

// Extracted so the bundled port has exactly one owner (the existing
// bundled-compose rental already declared by compose.dev.yml and
// startDevelopmentDatabase). Same exact rule and message as before.
const BUNDLED_PORT_INVALID_MESSAGE =
  'TICKET_SYSTEM_POSTGRES_PORT must be an integer from 1 through 65535';

function resolveBundledComposePort(env = process.env) {
  const raw = env.TICKET_SYSTEM_POSTGRES_PORT;
  const configuredPort = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!configuredPort) return DEFAULT_BUNDLED_POSTGRES_PORT;
  if (!/^\d+$/.test(configuredPort)) throw new Error(BUNDLED_PORT_INVALID_MESSAGE);
  const port = Number(configuredPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(BUNDLED_PORT_INVALID_MESSAGE);
  }
  return port;
}

function disposableDevelopmentTarget(env = process.env) {
  const port = resolveBundledComposePort(env);
  return Object.freeze({
    kind: 'disposable-development',
    host: DEVELOPMENT_TARGET_HOST,
    port,
    database: DEVELOPMENT_TARGET_DATABASE,
    schema: DEVELOPMENT_TARGET_SCHEMA,
    // Bundled development credentials already owned by compose.dev.yml —
    // never configuration. Identity rows must render host/port/database/
    // schema only; this URL never appears in printed output or errors.
    databaseUrl: bundledCredentialUrl(DEVELOPMENT_TARGET_DATABASE, port)
  });
}

// ── Collision guard (before ANY development database contact) ──────────────
//
// Deterministic host normalization: `localhost` → `127.0.0.1` only. No DNS,
// no port scanning, no "is something listening on this port" inference — the
// guard compares identities only.
function normalizeTargetHost(host) {
  return host === 'localhost' ? '127.0.0.1' : host;
}

function targetIdentity({ host, port, database, schema }) {
  return Object.freeze({
    host: normalizeTargetHost(String(host)),
    port: Number(port),
    database: String(database),
    schema: String(schema)
  });
}

function formatTargetIdentity(identity) {
  return `host ${identity.host}, port ${identity.port}, database ${identity.database}, schema ${identity.schema}`;
}

// Recovers the OPERATIONAL target identity through the canonical operational
// resolver's URL and schema (no credentials are ever kept in the identity).
function operationalIdentityFrom(config) {
  let parsed;
  try {
    parsed = new URL(config.databaseUrl);
  } catch (_) {
    throw new TypeError('DATABASE_URL did not resolve to a connection URL identity');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new TypeError('DATABASE_URL did not resolve to a host and database identity');
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.slice(1)),
    schema: config.postgresSchema
  };
}

// ── Operational-channel authority (ONE pre-normalization decision) ─────────
//
// The operational channel (admin:password --operational) must be authorized
// from and resolved through ONE decision, made BEFORE any applyLocalEnv
// normalization — applyLocalEnv writes a DEVELOPMENT-shaped default back into
// DATABASE_URL, so a decision read after that point could not distinguish an
// explicitly configured target from the bundled development default. Exactly
// one of two sources owns the decision:
//
//   1. The explicit process-environment property. If DATABASE_URL exists as an
//      own property of the process environment, environment values OWN the
//      channel: the value is trimmed only to decide whether it is empty, and
//      an explicitly empty/whitespace DATABASE_URL REFUSES the channel — it
//      never falls back to .env.local (a blank explicit override cannot
//      authorize a different source than the one it defeated). A nonempty
//      property supplies the exact operational URL (trimmed once by the same
//      rule every operational consumer validates with).
//   2. Only when the process environment has NO DATABASE_URL property may
//      .env.local supply it (the canonical explicit-file fallback the rest of
//      the domain layering already follows). Absent or empty/whitespace here
//      too REFUSES the channel.
//
// POSTGRES_SCHEMA follows the repository's canonical operational precedence —
// explicit process property first, then .env.local, then the canonical default
// `ticket_system` (this is the exact precedence every operational consumer
// already applies, e.g. release-db-preflight and db:migrate) — read from the
// SAME decision-time snapshot. An explicitly blank POSTGRES_SCHEMA is therefore
// the canonical default at the same instant the URL is fixed; no post-authorization
// re-read can re-derive either value from a different source.
//
// The frozen decision object is the operational target's single authority:
// consumers must not re-read or re-normalize another source after receiving it.
function resolveOperationalChannelAuthority(env = process.env, { localEnvFile = LOCAL_ENV_PATH } = {}) {
  const canonicalSchemaDefault = 'ticket_system';
  const resolveSchema = (explicit, fileValue) => {
    if (explicit !== undefined && explicit !== null) {
      const value = String(explicit).trim();
      return value ? value : canonicalSchemaDefault;
    }
    const value = String(fileValue === undefined || fileValue === null ? '' : fileValue).trim();
    return value ? value : canonicalSchemaDefault;
  };
  const local = loadLocalEnvFile(localEnvFile);
  if (Object.prototype.hasOwnProperty.call(env, 'DATABASE_URL')) {
    const explicit = env.DATABASE_URL === undefined || env.DATABASE_URL === null ? '' : String(env.DATABASE_URL);
    if (!explicit.trim()) {
      return Object.freeze({
        authorized: false,
        source: 'environment',
        databaseUrl: null,
        postgresSchema: null,
        reason: 'DATABASE_URL is explicitly present but empty; the operational channel does not fall back to another source'
      });
    }
    return Object.freeze({
      authorized: true,
      source: 'environment',
      databaseUrl: explicit.trim(),
      postgresSchema: resolveSchema(env.POSTGRES_SCHEMA, local.POSTGRES_SCHEMA),
      reason: null
    });
  }
  const fileUrl = String(local.DATABASE_URL || '').trim();
  if (!fileUrl) {
    return Object.freeze({
      authorized: false,
      source: 'env-file',
      databaseUrl: null,
      postgresSchema: null,
      reason: 'DATABASE_URL is not configured; the operational channel requires an explicit nonempty DATABASE_URL in the process environment or .env.local'
    });
  }
  return Object.freeze({
    authorized: true,
    source: 'env-file',
    databaseUrl: fileUrl,
    postgresSchema: resolveSchema(env.POSTGRES_SCHEMA, local.POSTGRES_SCHEMA),
    reason: null
  });
}

// Pure, credential-free collision assessment. The operational side is
// recovered through the existing canonical operational resolver
// (developmentConfig → resolveDevelopmentDatabaseTarget), never re-derived.
// Refusal happens BEFORE any development database contact or mutation.
function assessDevelopmentTargetCollision(env = process.env) {
  const devTarget = disposableDevelopmentTarget(env);
  const development = targetIdentity(devTarget);
  let operational;
  try {
    operational = targetIdentity(operationalIdentityFrom(developmentConfig(env)));
  } catch (error) {
    return {
      ok: false,
      devTarget,
      development,
      operational: null,
      reason:
        'the configured operational target identity could not be established (' +
        safeErrorMessage(error) +
        '); refusing development database contact because identity equality cannot be disproven'
    };
  }
  const equal = development.host === operational.host &&
    development.port === operational.port &&
    development.database === operational.database &&
    development.schema === operational.schema;
  if (!equal) {
    return { ok: true, devTarget, development, operational, reason: null };
  }
  return {
    ok: false,
    devTarget,
    development,
    operational,
    reason:
      'the configured operational target (' + formatTargetIdentity(operational) + ') is identical to the ' +
      'fixed disposable development target (' + formatTargetIdentity(development) + '); no operational state ' +
      'may be touched with disposable migration authority. Note: localhost is deterministically read as ' +
      '127.0.0.1. The disposable development identity is code-owned and cannot be redirected by DATABASE_URL, ' +
      'POSTGRES_SCHEMA, or CLI input; reconfigure the operational DATABASE_URL (or run dev commands) instead'
  };
}

class DevelopmentTargetCollisionError extends Error {
  constructor(reason) {
    super('Development target refused before any database contact: ' + reason);
    this.name = 'DevelopmentTargetCollisionError';
    this.code = 'DEVELOPMENT_TARGET_REFUSED';
    this.reason = String(reason);
  }
}

// ── BUNDLED-TOPOLOGY-A: shared bundled PostgreSQL service port guard ───────
//
// The repository's bundled local PostgreSQL Compose SERVICE may be the same
// physical service that hosts the configured OPERATIONAL database (the
// sanctioned local topology: one bundled service, one operational database
// `ticket_system`, one disposable `ticket_system_dev` distinguished by
// database name). In that topology the development Compose host port and the
// exact operational DATABASE_URL address the SAME service, so they MUST be
// equal; remapping the service with a different TICKET_SYSTEM_POSTGRES_PORT
// would make the exact operational DATABASE_URL unreachable. This is a
// PHYSICAL-TOPOLOGY guard, deliberately separate from COLLISION-A (the two
// databases have different names, so no identity collision exists while the
// physical service is still shared). Refusal happens BEFORE any Compose,
// runtime, or database contact, and the explicit operational URL is never
// rewritten: the caller must use the operational port or leave
// TICKET_SYSTEM_POSTGRES_PORT unset (the bundled default expresses the same
// service the operational URL already names).

class DevelopmentServiceTopologyError extends Error {
  constructor(reason) {
    super('Development service port cannot be remapped before any database contact: ' + reason);
    this.name = 'DevelopmentServiceTopologyError';
    this.code = 'DEVELOPMENT_SERVICE_TOPOLOGY_REFUSED';
    this.reason = String(reason);
  }
}

// BUNDLED-TOPOLOGY-A shape detection: the configured operational target
// addresses the REPOSITORY's bundled local PostgreSQL service when it is a
// PostgreSQL URL for the bundled role/database on the local loopback (any
// password is accepted for shape purposes — the password never leaks). The
// password byte-shape must NOT participate so a local deployment with a
// custom password still shares the physical topology.
function isBundledServiceShape(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { return false; }
  return (parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:') &&
    parsed.username === 'ticket_system' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
    parsed.pathname === '/ticket_system' &&
    parsed.search === '' &&
    parsed.hash === '';
}

function assessBundledServiceTopologyGuard(env = process.env) {
  const databaseTarget = resolveDevelopmentDatabaseTarget(env);
  if (!databaseTarget || !isBundledServiceShape(databaseTarget.databaseUrl)) {
    // The operational target is not the bundled local service (no explicit
    // URL at all, or an explicit external/non-bundled one): the development
    // Compose host port may independently select the local disposable
    // development service port.
    return { ok: true, databaseTarget, operationalPort: null, composePort: null, reason: null };
  }
  let operationalPort;
  try {
    const parsed = new URL(databaseTarget.databaseUrl);
    operationalPort = parsed.port ? Number(parsed.port) : DEFAULT_BUNDLED_POSTGRES_PORT;
  } catch (error) {
    // The bundled-shaped URL was already validated; refuse fail-closed with
    // the honest reason if its port cannot be established.
    return {
      ok: false,
      databaseTarget,
      operationalPort: null,
      composePort: null,
      reason: 'the bundled operational target port could not be established (' + safeErrorMessage(error) + ')'
    };
  }
  const composePort = resolveBundledComposePort(env);
  if (operationalPort === composePort) {
    return { ok: true, databaseTarget, operationalPort, composePort, reason: null };
  }
  return {
    ok: false,
    databaseTarget,
    operationalPort,
    composePort,
    reason:
      'the configured operational target is bound to the same bundled local PostgreSQL service ' +
      '(the explicitly supplied bundled-shaped DATABASE_URL resolves to the repository compose service), ' +
      'whose exact address must stay reachable at port ' + operationalPort + '; remapping that service to the ' +
      'requested Compose host port ' + composePort + ' would make the exact operational DATABASE_URL unavailable. ' +
      'Use TICKET_SYSTEM_POSTGRES_PORT=' + operationalPort + ' or leave TICKET_SYSTEM_POSTGRES_PORT unset.'
  };
}

// Throwing wrapper for mutating dev entry points. THE refusal always happens
// before any bundled infra start, database existence probe, or mutation.
// Two DISTINCT guards compose here: COLLISION-A (identity equality) and
// BUNDLED-TOPOLOGY-A (shared bundled-service port remapping).
function assertDevelopmentTargetUsable(env = process.env) {
  const assessment = assessDevelopmentTargetCollision(env);
  if (!assessment.ok) throw new DevelopmentTargetCollisionError(assessment.reason);
  const topology = assessBundledServiceTopologyGuard(env);
  if (!topology.ok) throw new DevelopmentServiceTopologyError(topology.reason);
  return assessment.devTarget;
}

// NO disposable authority lives here: the single authority-bearing
// construction site is the module-internal factory in scripts/dev-database.js
// (createDisposableDevelopmentStore), reachable ONLY through the verified
// bundled-compose development lifecycle (collision guard → compose
// start/verification → fixed database ensure → migrate), never from env
// alone. The exported factory in this file is the ordinary GUARDED seam for
// the doctor's read-only diagnosis and the post-migration dev provisioning:
// its disposable flag stays false, so it cannot migrate anything. It is bound
// to the fixed development identity derived internally from the code
// constants and the bounded bundled compose port; callers cannot redirect its
// identity, and it grants NO migration authority.
function createGuardedDevelopmentStore(env = process.env) {
  const target = disposableDevelopmentTarget(env);
  const { PostgresRuntimeStore } = require('../persistence/postgres/store');
  return new PostgresRuntimeStore({
    connectionString: target.databaseUrl,
    schema: DEVELOPMENT_TARGET_SCHEMA
  });
}

function validateSessionSecret(value) {
  return registryValidateSessionSecret(value);
}

function validateAdminPassword(value, { required = false } = {}) {
  return registryValidateAdminPassword(value, { required });
}

function developmentConfig(env = process.env) {
  const databaseTarget = resolveDevelopmentDatabaseTarget(env);
  return {
    databaseUrl: databaseTarget.databaseUrl,
    databaseTarget,
    postgresSchema: String(env.POSTGRES_SCHEMA || 'ticket_system').trim(),
    sessionSecret: String(env.SESSION_SECRET || ''),
    adminBootstrapPassword: String(env.ADMIN_BOOTSTRAP_PASSWORD || ''),
    // One canonical default with the server boot surface (server.js resolves
    // the same relative default under the repository root when
    // WORKSPACE_ROOT is unset); the registry owns the declared default.
    workspaceRoot: path.resolve(ROOT, env.WORKSPACE_ROOT || 'workspace-root'),
    artifactRoot: path.resolve(ROOT, env.ARTIFACT_ROOT || '.local-artifacts')
  };
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value));
}

function renderLocalEnv({ databaseUrl, sessionSecret, adminBootstrapPassword, postgresSchema = 'ticket_system' }) {
  const lines = [
    '# Generated by pnpm dev:setup. This file is local and ignored by Git.',
    `DATABASE_URL=${quoteEnvValue(databaseUrl)}`,
    `POSTGRES_SCHEMA=${quoteEnvValue(postgresSchema)}`,
    `SESSION_SECRET=${quoteEnvValue(sessionSecret)}`
  ];
  if (adminBootstrapPassword) {
    lines.push('# Creation-only: ignored after the admin account exists.');
    lines.push(`ADMIN_BOOTSTRAP_PASSWORD=${quoteEnvValue(adminBootstrapPassword)}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeLocalEnv(values, filePath = LOCAL_ENV_PATH) {
  fs.writeFileSync(filePath, renderLocalEnv(values), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// Non-mutating usability walkthrough (effect-root directory-boundary
// semantics). The exact walk semantics are owned by runtime/health-readiness.js
// so the doctor, the health routes, and the readiness contract never disagree.
// Only the human-facing message rendering stays here.
function writablePathStatus(targetPath) {
  const [entry] = effectRootReadiness([{ id: 'path', root: path.resolve(targetPath) }]);
  if (entry.usable) {
    return { ok: true, message: fs.existsSync(path.resolve(targetPath)) ? String(targetPath) : `${targetPath} (will be created)` };
  }
  switch (entry.reason) {
    case 'no_existing_parent':
      return { ok: false, message: `no existing parent for ${targetPath}` };
    case 'not_a_directory':
      return { ok: false, message: `${targetPath}: exists but is not a directory` };
    case 'insufficient_permissions':
      return { ok: false, message: `${targetPath}: the runtime cannot read, write into, and traverse this directory` };
    case 'parent_not_a_directory':
      return { ok: false, message: `${targetPath}: cannot be created — the nearest existing parent is not a directory` };
    case 'parent_insufficient_permissions':
      return { ok: false, message: `${targetPath}: cannot be created — the parent directory does not support creation and traversal` };
    default:
      return { ok: false, message: `${targetPath}: not usable as an effect root (${entry.reason})` };
  }
}

async function promptVisible(message, { input = process.stdin, output = process.stdout, defaultValue = '' } = {}) {
  if (!input.isTTY) throw new Error('Interactive setup requires a TTY');
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(`${message}${suffix}: `);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptHidden(message, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Secure password entry requires an interactive TTY');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw === true;
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      output.write('\n');
    };
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          reject(Object.assign(new Error('Cancelled'), { code: 'INTERACTIVE_CANCELLED' }));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    output.write(`${message}: `);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function safeErrorMessage(error) {
  return String(error && error.message ? error.message : error || 'unknown error')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '<postgres-url>');
}

module.exports = {
  DEFAULT_BUNDLED_POSTGRES_PORT,
  DEFAULT_DATABASE_URL,
  DEVELOPMENT_TARGET_DATABASE,
  DEVELOPMENT_TARGET_HOST,
  DEVELOPMENT_TARGET_SCHEMA,
  DevelopmentTargetCollisionError,
  DevelopmentServiceTopologyError,
  LOCAL_ENV_PATH,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_SESSION_SECRET_LENGTH,
  applyLocalEnv,
  assertDevelopmentTargetUsable,
  assessBundledServiceTopologyGuard,
  assessDevelopmentTargetCollision,
  bundledDatabaseUrl,
  createGuardedDevelopmentStore,
  developmentConfig,
  disposableDevelopmentTarget,
  formatTargetIdentity,
  generateSessionSecret,
  loadLocalEnvFile,
  normalizeTargetHost,
  operationalIdentityFrom,
  resolveOperationalChannelAuthority,
  promptHidden,
  promptVisible,
  renderLocalEnv,
  resolveBundledComposePort,
  resolveDevelopmentDatabaseTarget,
  safeErrorMessage,
  targetIdentity,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writablePathStatus,
  writeLocalEnv
};
