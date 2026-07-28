#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(
  ROOT,
  'deployment/systemd/ticket-system-process-launcher-foundation.service'
), 'utf8');
const tmpfiles = fs.readFileSync(path.join(
  ROOT,
  'deployment/systemd/ticket-system-process-launcher-foundation.tmpfiles'
), 'utf8');
const configuration = JSON.parse(fs.readFileSync(path.join(
  ROOT,
  'config/process-launcher-foundation.example.json'
), 'utf8'));
let passed = 0;

function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

ok(service.includes('User=ticket-system-launcher') &&
  service.includes('Group=ticket-system-runtime'),
'launcher unit uses a dedicated service UID and the runtime client group');
ok(service.includes(
  'ExecStart=/usr/libexec/ticket-system/ticket-system-process-launcher-foundation ' +
  '/etc/ticket-system/process-launcher-foundation.json'
), 'launcher unit uses a fixed absolute binary and configuration without a shell');
ok(!/(?:^|\s)(?:sh|bash|zsh|dash)\s+-c(?:\s|$)/m.test(service) &&
  !service.includes('EnvironmentFile=') &&
  !/DATABASE_URL|PASSWORD|TOKEN|SECRET|CREDENTIAL/i.test(service),
'launcher unit inherits no application secret environment');
ok(service.includes('NoNewPrivileges=true') &&
  service.includes('ProtectSystem=strict') &&
  service.includes('RestrictAddressFamilies=AF_UNIX') &&
  service.includes('Restart=on-failure'),
'launcher foundation unit applies bounded trusted-service hardening');
ok(tmpfiles.includes(
  'd /run/ticket-system-process/launcher 0750 ticket-system-launcher ticket-system-runtime -'
) && tmpfiles.includes(
  'd /var/lib/ticket-system/process-launcher 0750 ' +
  'ticket-system-launcher ticket-system-runtime -'
), 'launcher socket and state roots are pre-provisioned with exact ownership and mode');
ok(tmpfiles.includes(
  'd /var/lib/ticket-system/runtime-rootfs 0555 root root -'
) && tmpfiles.includes(
  'z /etc/ticket-system/process-seccomp-v1.bpf 0440 root ticket-system-runtime -'
), 'deployment pins root-owned rootfs and seccomp authority boundaries');
ok(configuration.sandboxBackend.kind === 'bubblewrap' &&
  configuration.sandboxBackend.binaryPath === '/usr/bin/bwrap' &&
  configuration.rootfsRegistry[0].rootPath.startsWith(
    '/var/lib/ticket-system/runtime-rootfs/'
  ), 'trusted example uses a fixed backend and versioned private rootfs');
ok(!JSON.stringify(configuration).includes('/home/') &&
  !service.includes('/home/') && !tmpfiles.includes('/home/'),
'deployment examples contain no operator-specific home path');
ok(!/\b(?:launch|execute|spawn|cancel|signal|output|attach)\b/i.test(
  JSON.stringify(configuration)
), 'deployment configuration contains no execution operation or arguments');

console.log(`\nPASS: launcher foundation deployment boundary — ${passed} assertions`);
