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

function bundledDatabaseUrl(port = DEFAULT_BUNDLED_POSTGRES_PORT) {
  const normalizedPort = Number(port);
  if (!Number.isSafeInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error('TICKET_SYSTEM_POSTGRES_PORT must be an integer from 1 through 65535');
  }
  return `postgresql://ticket_system:ticket_system@127.0.0.1:${normalizedPort}/ticket_system`;
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

function resolveDevelopmentDatabaseTarget(env = process.env) {
  const configuredUrl = String(env.DATABASE_URL || '').trim();
  const configuredPort = String(env.TICKET_SYSTEM_POSTGRES_PORT || '').trim();
  const composePort = configuredPort
    ? Number(configuredPort)
    : DEFAULT_BUNDLED_POSTGRES_PORT;
  if (configuredPort &&
      (!/^\d+$/.test(configuredPort) || !Number.isSafeInteger(composePort) || composePort < 1 || composePort > 65535)) {
    throw new Error('TICKET_SYSTEM_POSTGRES_PORT must be an integer from 1 through 65535');
  }

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
  if (!isBundledDatabaseUrl(configuredUrl)) {
    if (configuredPort) {
      throw new Error(
        'TICKET_SYSTEM_POSTGRES_PORT configures the bundled database and cannot be combined ' +
        'with an external DATABASE_URL'
      );
    }
    return Object.freeze({
      kind: 'external',
      databaseUrl: configuredUrl,
      composePort: null,
      source: 'database-url'
    });
  }

  const parsed = new URL(configuredUrl);
  const databasePort = parsed.port ? Number(parsed.port) : DEFAULT_BUNDLED_POSTGRES_PORT;
  const effectivePort = configuredPort ? composePort : databasePort;
  return Object.freeze({
    kind: 'bundled',
    databaseUrl: bundledDatabaseUrl(effectivePort),
    composePort: effectivePort,
    source: configuredPort ? 'bundled-port' : 'database-url'
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
  LOCAL_ENV_PATH,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_SESSION_SECRET_LENGTH,
  applyLocalEnv,
  bundledDatabaseUrl,
  developmentConfig,
  generateSessionSecret,
  loadLocalEnvFile,
  promptHidden,
  promptVisible,
  renderLocalEnv,
  resolveDevelopmentDatabaseTarget,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writablePathStatus,
  writeLocalEnv
};
