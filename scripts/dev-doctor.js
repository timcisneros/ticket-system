#!/usr/bin/env node
'use strict';

const argon2 = require('argon2');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  applyLocalEnv,
  developmentConfig,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writablePathStatus
} = require('./dev-environment');

function addCheck(checks, status, label, message) {
  checks.push({ status, label, message });
}

function postgresHelp() {
  return 'Start local PostgreSQL with `docker compose -f compose.dev.yml up -d` (or Podman Compose), then run `pnpm dev:setup`.';
}

function packageManagerCheck(userAgent) {
  const text = String(userAgent || '');
  const pnpmMatch = text.match(/pnpm\/(\d+)(?:\.|\s|$)/);
  if (pnpmMatch) {
    return { status: Number(pnpmMatch[1]) >= 11 ? 'pass' : 'fail', label: 'pnpm', message: pnpmMatch[1] };
  }
  const npmMatch = text.match(/npm\/(\d+)(?:\.|\s|$)/);
  if (npmMatch) {
    return { status: 'pass', label: 'npm', message: `${npmMatch[1]}; supported script runner` };
  }
  return { status: 'warn', label: 'package manager', message: 'version could not be inferred' };
}

async function inspectDevelopmentEnvironment({
  env = process.env,
  storeFactory = config => new PostgresRuntimeStore(config),
  verifyPassword = argon2.verify
} = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  addCheck(checks, nodeMajor >= 24 ? 'pass' : 'fail', 'Node.js', nodeMajor >= 24 ? process.versions.node : `${process.versions.node}; version 24 or newer is required`);

  const packageManager = packageManagerCheck(env.npm_config_user_agent);
  addCheck(checks, packageManager.status, packageManager.label, packageManager.message);

  const config = developmentConfig(env);
  const databaseError = validateDatabaseUrl(config.databaseUrl);
  addCheck(checks, databaseError ? 'fail' : 'pass', 'DATABASE_URL', databaseError || 'configured PostgreSQL URL');

  const sessionError = validateSessionSecret(config.sessionSecret);
  addCheck(checks, sessionError ? 'fail' : 'pass', 'SESSION_SECRET', sessionError || 'configured with sufficient length');

  for (const [label, target] of [['workspace path', config.workspaceRoot], ['artifact path', config.artifactRoot]]) {
    const result = writablePathStatus(target);
    addCheck(checks, result.ok ? 'pass' : 'fail', label, result.message);
  }

  if (databaseError) return { ok: false, checks, config };

  let store;
  try {
    store = storeFactory({ connectionString: config.databaseUrl, schema: config.postgresSchema });
    await store.prepareRuntimePersistence();
    addCheck(checks, 'pass', 'PostgreSQL', `connected; schema ${config.postgresSchema} is current`);

    const admin = await store.getUserByUsername('admin');
    if (!admin) {
      const passwordError = validateAdminPassword(config.adminBootstrapPassword, { required: true });
      const detail = passwordError ? `${passwordError}; run pnpm dev:setup` : 'account is missing; run pnpm dev:setup';
      addCheck(checks, 'fail', 'initial admin', detail);
    } else {
      addCheck(checks, 'pass', 'initial admin', 'admin account exists');
      if (config.adminBootstrapPassword) {
        const passwordError = validateAdminPassword(config.adminBootstrapPassword);
        addCheck(checks, 'warn', 'ADMIN_BOOTSTRAP_PASSWORD',
          passwordError || 'creation-only setting remains present after bootstrap');
        let matches = false;
        try {
          matches = await verifyPassword(admin.passwordHash, config.adminBootstrapPassword);
        } catch (_) {
          matches = false;
        }
        if (!matches) {
          addCheck(checks, 'warn', 'bootstrap password state',
            'configured creation-only value does not match the current admin password; use pnpm admin:password to rotate it');
        }
      }
      try {
        if (await verifyPassword(admin.passwordHash, 'admin123')) {
          addCheck(checks, 'warn', 'admin password', 'current admin still uses the legacy development default; rotate it with pnpm admin:password');
        }
      } catch (_) {
        // A malformed stored hash is reported by runtime integrity checks.
      }
    }
  } catch (error) {
    addCheck(checks, 'fail', 'PostgreSQL', `${safeErrorMessage(error)}. ${postgresHelp()}`);
  } finally {
    if (store) await store.close();
  }

  return { ok: !checks.some(check => check.status === 'fail'), checks, config };
}

function printChecks(result, output = process.stdout) {
  for (const check of result.checks) {
    output.write(`[${check.status.toUpperCase()}] ${check.label}: ${check.message}\n`);
  }
  output.write(result.ok ? 'Development environment is ready.\n' : 'Development environment needs attention.\n');
}

async function runDoctor(options = {}) {
  applyLocalEnv(options.env || process.env);
  const result = await inspectDevelopmentEnvironment(options);
  printChecks(result, options.output || process.stdout);
  return result.ok;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm dev:doctor\n\nRuns read-only development environment checks. Secret values are never printed.');
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:doctor does not accept arguments');
  if (!await runDoctor()) process.exitCode = 1;
}

module.exports = { inspectDevelopmentEnvironment, packageManagerCheck, postgresHelp, printChecks, runDoctor };

if (require.main === module) {
  main().catch(error => {
    console.error(`Development doctor failed: ${safeErrorMessage(error)}`);
    process.exit(1);
  });
}
