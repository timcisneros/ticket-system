#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const servicePath = path.join(
  ROOT,
  'deployment/systemd/ticket-system-process-materializer.service'
);
const tmpfilesPath = path.join(
  ROOT,
  'deployment/systemd/ticket-system-process-materializer.tmpfiles'
);
const service = fs.readFileSync(servicePath, 'utf8');
const tmpfiles = fs.readFileSync(tmpfilesPath, 'utf8');
let passed = 0;

function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

ok(service.includes('User=ticket-system-materializer') &&
  service.includes('Group=ticket-system-runtime'),
'systemd unit uses the dedicated materializer user and runtime group');
ok(service.includes(
  'ExecStart=/usr/libexec/ticket-system/ticket-system-process-materializer ' +
  '/etc/ticket-system/process-materializer.json'
), 'systemd unit uses one fixed absolute binary and trusted configuration path');
ok(!/(?:^|\s)(?:sh|bash|zsh|dash)\s+-c(?:\s|$)/m.test(service) &&
  !service.includes('EnvironmentFile=') &&
  !/DATABASE_URL|PASSWORD|TOKEN|SECRET|CREDENTIAL/i.test(service),
'systemd unit contains no shell command string, inherited secret file, or credential');
ok(service.includes('Restart=on-failure') &&
  service.includes('NoNewPrivileges=true') &&
  service.includes('ProtectSystem=strict') &&
  service.includes('RestrictAddressFamilies=AF_UNIX'),
'systemd unit defines restart and conservative trusted-service hardening');
ok(tmpfiles.includes(
  'd /run/ticket-system-process 0750 root ticket-system-runtime -'
) && tmpfiles.includes(
  'd /run/ticket-system-process/materializer 0750 ' +
  'ticket-system-materializer ticket-system-runtime -'
) && tmpfiles.includes(
  'd /var/lib/ticket-system/process-inputs 0750 ' +
  'ticket-system-materializer ticket-system-runtime -'
), 'tmpfiles pre-provisions socket and sealed roots with exact ownership and modes');
ok(tmpfiles.includes(
  'z /etc/ticket-system/process-materializer.json 0640 root ticket-system-runtime -'
) && tmpfiles.includes(
  'z /etc/ticket-system/process-input-policy.json 0640 root ticket-system-runtime -'
), 'tmpfiles pins trusted configuration and policy permissions');
ok(!service.includes('/home/') && !tmpfiles.includes('/home/'),
'deployment examples contain no operator-specific home path');
ok(!/bwrap|bubblewrap|systemd-run|unshare|nsenter|cgroup|seccomp|child_process/.test(
  `${service}\n${tmpfiles}`
), 'deployment examples add no process sandbox or execution operation');

console.log(`\nPASS: process materializer deployment boundary — ${passed} assertions`);
