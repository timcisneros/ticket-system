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

const native = [
  'src/lib.rs',
  'src/main.rs',
  'src/cgroup.rs',
  'src/executor.rs',
  'src/launch_contract.rs',
  'src/materializer_client.rs',
  'src/seccomp.rs'
].map(file =>
  fs.readFileSync(path.join(ROOT, 'native/process-launcher', file), 'utf8')
).join('\n');
assert.ok(!/\b(?:Command::new|posix_spawn|system\s*\()\b/.test(native) &&
  !/(?:["'](?:\/bin\/sh|\/bin\/bash)["'][\s\S]{0,80}["']-c["'])/.test(native),
  'native launcher invokes no shell or command-string process API');
passed += 1;
console.log('  ok launcher has no shell or command-string process API');
assert.match(native, /fexecve/);
assert.match(native, /cgroup\.procs/);
assert.match(native, /--unshare-pid/);
assert.match(native, /--unshare-net/);
assert.match(native, /--seccomp/);
assert.match(native, /verify_pre_execution_gate/);
assert.match(native, /F_DUPFD_CLOEXEC/);
assert.match(native, /struct ChildGuard/);
passed += 1;
console.log('  ok launcher contains the collision-free blocked-child containment sequence');
const operations = native.match(/enum ProtocolOperation \{[\s\S]*?\}/)[0];
assert.ok(/\bLaunch\b/.test(operations) &&
  /\bGetOperation\b/.test(operations) &&
  /\bCancelOperation\b/.test(operations) &&
  !/\b(?:Execute|Spawn|Signal|Output|Attach)\b/.test(operations),
'launcher protocol exposes only the bounded lifecycle, not generic execution');
passed += 1;
console.log('  ok launcher protocol is a bounded launch lifecycle');

const productionNode = [
  'runtime/process-launcher-foundation-contract.js',
  'runtime/process-launcher-foundation-client.js',
  'runtime/process-sandbox-prerequisite-inspection.js'
].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
assert.ok(!/require\(['"]child_process['"]\)|\b(?:spawn|exec|execFile)\s*\(/.test(productionNode),
  'production launcher client cannot spawn a service or executable');
passed += 1;
console.log('  ok production launcher client never spawns the native service');
assert.match(
  fs.readFileSync(path.join(ROOT, 'runtime/process-execution-contract.js'), 'utf8'),
  /const CURRENT_PROCESS_SANDBOX_CAPABILITY = null;/,
  '2A3 keeps model/runtime execution capability unavailable'
);
passed += 1;
console.log('  ok current runtime sandbox capability remains null');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
assert.ok(!/process-launcher-foundation|process-sandbox-prerequisite-inspection/.test(server),
  'launcher and prerequisite inspection remain disconnected from model dispatch');
passed += 1;
console.log('  ok prerequisite inspection remains private and non-dispatchable');

console.log(`\nPASS: process launcher foundation native gate — ${passed} checks`);
