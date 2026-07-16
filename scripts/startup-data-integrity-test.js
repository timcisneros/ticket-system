#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Server did not refuse corrupt data within the timeout'));
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function runRefusalScenario(name, fileName, fileContent) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `startup-integrity-${name}-`));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `startup-integrity-workspace-${name}-`));
  const targetPath = path.join(dataDir, fileName);
  fs.writeFileSync(targetPath, fileContent, 'utf8');

  let output = '';
  try {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '0',
        DATA_DIR: dataDir,
        WORKSPACE_ROOT: workspaceRoot
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const exitCode = await waitForExit(child);

    assert(exitCode !== 0, `${name}: server unexpectedly started with corrupt data`);
    assert(fs.readFileSync(targetPath, 'utf8') === fileContent, `${name}: corrupt ${fileName} was rewritten`);
    assert(/Data integrity check failed/i.test(output), `${name}: startup refusal did not identify data integrity; output=${output}`);
    assert(!output.includes('password=') && !output.includes('admin123'), `${name}: bootstrap password leaked during refusal`);
    assert(!output.includes('Default admin user created'), `${name}: corrupt users were treated as an empty first-run store`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  await runRefusalScenario('malformed-json', 'users.json', '{"broken":');
  await runRefusalScenario('non-array', 'users.json', '{"id":1}');
  await runRefusalScenario('duplicate-id', 'users.json', JSON.stringify([
    { id: 1, username: 'one' },
    { id: 1, username: 'two' }
  ], null, 2));
  await runRefusalScenario('string-id', 'users.json', JSON.stringify([
    { id: '1junk', username: 'malformed' }
  ], null, 2));
  await runRefusalScenario('duplicate-ticket-id', 'tickets.json', JSON.stringify([
    { id: 1, objective: 'one', assignmentTargetType: 'agent', assignmentTargetId: 1 },
    { id: 1, objective: 'two', assignmentTargetType: 'agent', assignmentTargetId: 1 }
  ], null, 2));
  await runRefusalScenario('missing-run-limits-snapshot', 'runs.json', JSON.stringify([
    { id: 1, ticketId: 1, agentId: 1, status: 'completed' }
  ], null, 2));
  await runRefusalScenario('auxiliary-json', 'process-templates.json', '[{"broken":');
  await runRefusalScenario('runtime-limits-json', 'runtime-limits.json', '{"maxExecutionSteps":"many"}');
  await runRefusalScenario('legacy-run-event', 'events.jsonl', `${JSON.stringify({
    id: 'legacy-event',
    ts: new Date().toISOString(),
    type: 'run.created',
    ticketId: 1,
    runId: 1,
    payload: {}
  })}\n`);
  console.log('PASS: startup strictly refuses and preserves malformed, non-array, duplicate-identity, missing run-snapshot, auxiliary, runtime-limit, and legacy run-event data');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
