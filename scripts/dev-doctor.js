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
const { agentReadiness, firstConfiguredAgentPage } = require('./dev-agent-config');

function addCheck(checks, status, label, message) {
  checks.push({ status, label, message });
}

function postgresHelp() {
  return 'Start local PostgreSQL with `pnpm dev:db`, then run `pnpm dev:setup`.';
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
      addCheck(checks, 'fail', 'admin account', detail);
    } else {
      addCheck(checks, 'pass', 'admin account', 'configured');
      try {
        if (await verifyPassword(admin.passwordHash, 'admin123')) {
          addCheck(checks, 'warn', 'admin password', 'current password is a predictable default; change it with pnpm admin:password');
        }
      } catch (_) {
        // A malformed stored hash is reported by runtime integrity checks.
      }
    }

    const agentPage = await firstConfiguredAgentPage(store);
    const readiness = agentPage.agents.map(agent => ({
      agent,
      status: agentReadiness(agent, env)
    }));
    const readyAgents = readiness.filter(item => item.status.ready);
    if (agentPage.agents.length === 0) {
      addCheck(checks, 'fail', 'configured agents', 'none exist; run pnpm dev:setup');
    } else if (readyAgents.length === 0) {
      const reasons = [...new Set(readiness.flatMap(item => item.status.reasons))].join(', ');
      addCheck(checks, agentPage.truncated ? 'warn' : 'fail', 'runnable agent configuration',
        agentPage.truncated
          ? `none of the first 100 agents is runnable (${reasons}); inspect the remaining catalog in Admin`
          : `no agent has complete provider configuration (${reasons}); update Admin or rerun pnpm dev:setup`);
    } else {
      addCheck(checks, 'pass', 'runnable agent configuration',
        `${readyAgents.length} of ${agentPage.agents.length} inspected agent(s) have a provider, model, and required credential`);
    }
    if (agentPage.truncated) {
      addCheck(checks, 'warn', 'configured agents', 'doctor inspection is intentionally bounded to the first 100 agents');
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
