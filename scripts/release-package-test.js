#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const {
  packageInventory
} = require('./release-package');
const {
  isForbiddenTrackedFile
} = require('./release-security-check');

const root = path.resolve(__dirname, '..');
const inventory = packageInventory(root);
assert(inventory.includes('LICENSE'));
assert(inventory.includes('CONTRIBUTING.md'));
assert(inventory.includes('THIRD_PARTY_NOTICES.md'));
assert(inventory.includes('server.js'));
assert(inventory.includes('package.json'));
assert(inventory.includes('pnpm-lock.yaml'));
assert(inventory.includes(
  'deployment/systemd/ticket-system-process-launcher-foundation.service'
));
assert(inventory.includes(
  'persistence/postgres/migrations/030_runtime_budget_and_capacity.sql'
));
assert.equal(inventory.some(file => file.endsWith('-test.js')), false);
assert.equal(inventory.some(file => file.includes('node_modules')), false);
assert.equal(inventory.some(file => /(^|\/)\.env(?:\.|$)/.test(file)), false);
assert.equal(isForbiddenTrackedFile('.env.example'), false);
assert.equal(isForbiddenTrackedFile('config/.env.example'), false);
for (const file of [
  '.env',
  '.env.local',
  'config/.env.production',
  'native/process-launcher/target/release/launcher',
  'node_modules/example/index.js'
]) {
  assert.equal(isForbiddenTrackedFile(file), true, `${file} is forbidden`);
}
for (const relative of inventory) {
  assert(fs.statSync(path.join(root, relative)).isFile());
}

console.log(`PASS: release package allowlist (${inventory.length} tracked files)`);
