#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'native/process-launcher/Cargo.toml');
let passed = 0;

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CARGO_NET_OFFLINE: 'true' }
  });
  assert.strictEqual(
    result.status,
    0,
    `${label} failed\n${result.stdout || ''}\n${result.stderr || ''}`
  );
  passed += 1;
  console.log(`  ok ${label}`);
}

run('launcher native formatter check', 'cargo', [
  'fmt', '--manifest-path', MANIFEST, '--', '--check'
]);
run('launcher native linter with warnings denied', 'cargo', [
  'clippy', '--manifest-path', MANIFEST, '--all-targets', '--', '-D', 'warnings'
]);
run('launcher native debug build', 'cargo', [
  'build', '--manifest-path', MANIFEST
]);
run('launcher native release build', 'cargo', [
  'build', '--release', '--manifest-path', MANIFEST
]);
run('launcher native rootfs, manifest, identity, and protocol tests', 'cargo', [
  'test', '--manifest-path', MANIFEST
]);

const native = ['src/lib.rs', 'src/main.rs'].map(file =>
  fs.readFileSync(path.join(ROOT, 'native/process-launcher', file), 'utf8')
).join('\n');
assert.ok(!/\b(?:Command::new|posix_spawn|fork\s*\(|execv|execve|system\s*\()\b/.test(native),
  'launcher foundation invokes no child process, shell, or configured executable');
passed += 1;
console.log('  ok launcher foundation has no process-launch primitive');
assert.ok(!/\b(?:bwrap\s+--|systemd-run|unshare\s|nsenter|clone3?\s*\(|seccomp_load|cgroup\.procs)\b/
  .test(native),
'launcher foundation performs no sandbox, namespace, seccomp, or cgroup mutation');
passed += 1;
console.log('  ok launcher foundation performs prerequisite inspection only');
assert.ok(!/\b(?:Launch|Execute|Spawn|Cancel|Signal|Output|Attach)\b/.test(
  native.match(/enum ProtocolOperation \{[\s\S]*?\}/)[0]
), 'launcher protocol contains only health, getRootfs, and verifyExecutable');
passed += 1;
console.log('  ok launcher protocol exposes no lifecycle operation');

const productionNode = [
  'runtime/process-launcher-foundation-contract.js',
  'runtime/process-launcher-foundation-client.js',
  'runtime/process-sandbox-prerequisite-inspection.js'
].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
assert.ok(!/require\(['"]child_process['"]\)|\b(?:spawn|exec|execFile)\s*\(/.test(productionNode),
  'production launcher foundation client cannot spawn a service or executable');
passed += 1;
console.log('  ok production launcher client has no process-launch API');
assert.match(
  fs.readFileSync(path.join(ROOT, 'runtime/process-execution-contract.js'), 'utf8'),
  /const CURRENT_PROCESS_SANDBOX_CAPABILITY = null;/,
  '2A2 keeps runtime execution capability unavailable'
);
passed += 1;
console.log('  ok current runtime sandbox capability remains null');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
assert.ok(!/process-launcher-foundation|process-sandbox-prerequisite-inspection/.test(server),
  'launcher and prerequisite inspection remain disconnected from model dispatch');
passed += 1;
console.log('  ok prerequisite inspection remains private and non-dispatchable');

console.log(`\nPASS: process launcher foundation native gate — ${passed} checks`);
