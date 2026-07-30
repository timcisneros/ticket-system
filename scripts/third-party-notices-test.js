#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildNoticeModel,
  generateNotices,
  noticeFilesForPackage,
  renderNotices
} = require('./third-party-notices');
const { packageInventory } = require('./release-package');

const root = path.resolve(__dirname, '..');
const model = buildNoticeModel(root);
const generated = renderNotices(model);
assert.equal(generateNotices(root), generated);
assert.equal(fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), generated);
assert.equal(renderNotices(model), generated);

const keys = model.inventory.map(item => item.key);
assert.deepEqual(keys, [...keys].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
assert.equal(new Set(keys).size, keys.length);
assert(keys.some(key => key.startsWith('node:fastify@')));
assert(keys.some(key => key.startsWith('rust:libc@')));
assert.equal(keys.some(key => key.includes('ticket-system-process-')), false);

for (const lock of model.locks) {
  const expected = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(root, lock.file)))
    .digest('hex');
  assert.equal(lock.sha256, expected);
}
for (const item of model.inventory) {
  assert(item.noticeReferences.length > 0, item.key);
  for (const reference of item.noticeReferences) {
    assert(model.texts.has(reference.hash), `${item.key}: ${reference.hash}`);
  }
}
for (const name of ['@epic-web/invariant', 'abstract-logging']) {
  const item = model.inventory.find(candidate =>
    candidate.ecosystem === 'node' && candidate.name === name
  );
  assert(item, name);
  assert(item.noticeReferences.some(reference => reference.label === 'declared MIT fallback'));
}
for (const name of ['pg-types', 'pgpass']) {
  const item = model.inventory.find(candidate =>
    candidate.ecosystem === 'node' && candidate.name === name
  );
  assert(item, name);
  assert(item.noticeReferences.some(reference => /README/i.test(reference.label)));
}
assert(model.inventory.some(item => /BSD-3-Clause/.test(item.license)));
assert(model.inventory.some(item => /Apache-2\.0/.test(item.license)));
assert(model.inventory.some(item => /Unicode-3\.0/.test(item.license)));
assert(generated.includes('The above copyright notice and this permission notice shall be'));
assert.equal(generated.includes('copyright and permission notices supplied'), false);

for (const forbidden of [
  root,
  '/home/',
  'node_modules/.pnpm',
  'process.env',
  'SESSION_SECRET',
  'DATABASE_URL'
]) {
  assert.equal(generated.includes(forbidden), false, forbidden);
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-contract-'));
try {
  fs.writeFileSync(path.join(fixture, 'README.md'), '# Package\n');
  assert.throws(
    () => noticeFilesForPackage(fixture, {
      name: 'missing-license',
      version: '1.0.0',
      license: 'Apache-2.0',
      author: null
    }),
    error => error.code === 'THIRD_PARTY_NOTICE_TEXT_MISSING'
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

const packageFiles = packageInventory(root);
assert(packageFiles.includes('LICENSE'));
assert(packageFiles.includes('THIRD_PARTY_NOTICES.md'));
assert(packageFiles.includes('CONTRIBUTING.md'));

console.log(
  `PASS: deterministic third-party notices (${model.inventory.length} packages, ` +
  `${model.texts.size} unique texts)`
);
