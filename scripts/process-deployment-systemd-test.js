#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-systemd-'));

function fixturePath(absolute) {
  return path.join(fixture, absolute.replace(/^\/+/, ''));
}

function write(absolute, bytes, mode = 0o644) {
  const target = fixturePath(absolute);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { mode });
}

try {
  for (const binary of [
    '/usr/bin/node',
    '/usr/libexec/ticket-system/ticket-system-process-materializer',
    '/usr/libexec/ticket-system/ticket-system-process-launcher-foundation'
  ]) {
    write(binary, '#!/bin/sh\nexit 0\n', 0o555);
  }
  for (const file of [
    'ticket-system.service',
    'ticket-system-process-materializer.service',
    'ticket-system-process-launcher-foundation.service'
  ]) {
    write(`/etc/systemd/system/${file}`, fs.readFileSync(path.join(
      ROOT,
      'deployment/systemd',
      file
    )));
  }
  write('/etc/systemd/system/postgresql.service',
    '[Service]\nType=oneshot\nExecStart=/usr/bin/true\n');
  for (const target of [
    'sysinit.target',
    'basic.target',
    'multi-user.target',
    'network.target',
    'local-fs.target'
  ]) {
    write(`/etc/systemd/system/${target}`, '[Unit]\nDefaultDependencies=no\n');
  }
  write('/usr/bin/true', '#!/bin/sh\nexit 0\n', 0o555);
  for (const directory of [
    '/run/ticket-system-process/launcher',
    '/run/ticket-system-process/materializer',
    '/var/lib/ticket-system/process-launcher',
    '/var/lib/ticket-system/process-inputs',
    '/var/lib/ticket-system/runtime-rootfs',
    '/var/lib/ticket-system/artifacts',
    '/srv/ticket-system/workspace',
    '/etc/ticket-system'
  ]) {
    fs.mkdirSync(fixturePath(directory), { recursive: true });
  }
  for (const file of [
    '/etc/ticket-system/ticket-system.env',
    '/etc/ticket-system/process-launcher-foundation.json',
    '/etc/ticket-system/process-seccomp-v1.json',
    '/etc/ticket-system/process-materializer.json',
    '/etc/ticket-system/process-input-policy.json'
  ]) write(file, '{}\n', 0o640);
  const result = spawnSync('systemd-analyze', [
    `--root=${fixture}`,
    'verify',
    'ticket-system.service',
    'ticket-system-process-materializer.service',
    'ticket-system-process-launcher-foundation.service'
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.status, 0, result.stderr);
  for (const service of [
    'ticket-system.service',
    'ticket-system-process-materializer.service',
    'ticket-system-process-launcher-foundation.service'
  ]) {
    const source = fs.readFileSync(path.join(
      ROOT,
      'deployment/systemd',
      service
    ), 'utf8');
    assert(source.includes('KillMode=control-group'));
    assert(!/(?:^|\s)(?:sh|bash|zsh|dash)\s+-c(?:\s|$)/m.test(source));
  }
  console.log('PASS: production systemd release units validate in a provisioned root');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
