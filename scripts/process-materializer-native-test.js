#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'native/process-materializer/Cargo.toml');
let passed = 0;

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  assert.strictEqual(
    result.status,
    0,
    `${label} failed\n${result.stdout || ''}\n${result.stderr || ''}`
  );
  passed += 1;
  console.log(`  ok ${label}`);
}

run('native formatter check', 'cargo', [
  'fmt', '--manifest-path', MANIFEST, '--', '--check'
]);
run('native linter with warnings denied', 'cargo', [
  'clippy', '--manifest-path', MANIFEST, '--all-targets', '--', '-D', 'warnings'
]);
run('native debug build', 'cargo', [
  'build', '--manifest-path', MANIFEST
]);
run('native release build', 'cargo', [
  'build', '--release', '--manifest-path', MANIFEST
]);
run('native unit, manifest, policy, registry, and traversal tests', 'cargo', [
  'test', '--manifest-path', MANIFEST
]);

const nativeSource = [
  'src/lib.rs',
  'src/main.rs',
  'src/contract.rs',
  'src/filesystem.rs',
  'src/service.rs'
].map(file => fs.readFileSync(
  path.join(ROOT, 'native/process-materializer', file),
  'utf8'
)).join('\n');
assert.ok(!/\b(?:Command::new|posix_spawn|fork\s*\(|execv|execve|system\s*\()\b/.test(nativeSource),
  'native service source must not invoke a child process or shell');
passed += 1;
console.log('  ok native service contains no child-process or shell invocation');
assert.ok(!/\b(?:bwrap|bubblewrap|systemctl|systemd-run|unshare|nsenter|cgroup|seccomp)\b/i
  .test(nativeSource),
'native service contains no launcher, namespace, cgroup, or seccomp implementation');
passed += 1;
console.log('  ok native service remains launcher- and sandbox-free');

const productionNode = [
  'runtime/process-materializer-contract.js',
  'runtime/process-materializer-client.js',
  'runtime/process-input-materialization.js'
].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
assert.ok(!/require\(['"]child_process['"]\)|\b(?:spawn|exec|execFile)\s*\(/.test(productionNode),
  'production materializer Node modules must not spawn a service or executable');
passed += 1;
console.log('  ok production Node integration contains no process-launch API');

const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
assert.ok(!/process-input-materialization|ProcessMaterializerClient/.test(serverSource),
  'server dispatch must not import the trusted standalone materialization seam');
passed += 1;
console.log('  ok materialization remains disconnected from server and model dispatch');

const executionContractSource = fs.readFileSync(
  path.join(ROOT, 'runtime/process-execution-contract.js'),
  'utf8'
);
assert.match(executionContractSource, /const CURRENT_PROCESS_SANDBOX_CAPABILITY = null;/,
  'Tranche 2A1 must leave sandbox capability permanently unavailable');
passed += 1;
console.log('  ok current sandbox capability remains null');

console.log(`\nPASS: native process materializer gate — ${passed} checks`);
