#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = 'THIRD_PARTY_NOTICES.md';
const MAX_NOTICE_BYTES = 1024 * 1024;
const NOTICE_NAME = /^(?:licen[cs]e|copying|copyright|notice)(?:[-._].*)?$/i;
const README_NAME = /^readme(?:[-._].*)?$/i;
const LOCKS = Object.freeze([
  ['Node production graph', 'pnpm-lock.yaml'],
  ['Process launcher graph', 'native/process-launcher/Cargo.lock'],
  ['Process materializer graph', 'native/process-materializer/Cargo.lock']
]);
const CARGO_MANIFESTS = Object.freeze([
  ['process launcher', 'native/process-launcher/Cargo.toml'],
  ['process materializer', 'native/process-materializer/Cargo.toml']
]);
const MIT_GRANT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function fail(code, detail = '') {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function byteSort(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function runJson(command, args, root = ROOT) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    fail('THIRD_PARTY_NOTICE_METADATA_UNAVAILABLE', `${command} ${args.join(' ')}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('THIRD_PARTY_NOTICE_METADATA_INVALID', command);
  }
}

function readText(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0 || bytes.length > MAX_NOTICE_BYTES || bytes.includes(0)) {
    fail('THIRD_PARTY_NOTICE_TEXT_INVALID', path.basename(file));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/\r\n?/g, '\n')
      .trim();
  } catch {
    fail('THIRD_PARTY_NOTICE_TEXT_INVALID', path.basename(file));
  }
}

function licenseSectionFromReadme(directory) {
  const readmes = fs.readdirSync(directory)
    .filter(name => README_NAME.test(name))
    .sort(byteSort);
  for (const name of readmes) {
    const text = readText(path.join(directory, name));
    const lines = text.split('\n');
    const index = lines.findIndex(line => /^(#{1,6})\s+licen[cs]e\s*$/i.test(line));
    if (index === -1) continue;
    const level = lines[index].match(/^(#+)/)[1].length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const heading = lines[cursor].match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= level) {
        end = cursor;
        break;
      }
    }
    const section = lines.slice(index + 1, end).join('\n').trim();
    if (section.includes('Permission is hereby granted')) {
      return Object.freeze({ label: `${name} License section`, text: section });
    }
  }
  return null;
}

function noticeFilesForPackage(directory, metadata) {
  const names = fs.readdirSync(directory)
    .filter(name => NOTICE_NAME.test(name))
    .sort(byteSort);
  if (names.length > 0) {
    return names.map(name => Object.freeze({
      label: name,
      text: readText(path.join(directory, name))
    }));
  }
  const readmeLicense = licenseSectionFromReadme(directory);
  if (readmeLicense) return [readmeLicense];
  if (metadata.license === 'MIT') {
    const attribution = metadata.author
      ? `Package author metadata: ${metadata.author}\n\n`
      : '';
    return [Object.freeze({
      label: 'declared MIT fallback',
      text:
        `The installed ${metadata.name}@${metadata.version} package declares the MIT license ` +
        'but does not include a standalone license text or a complete license section in its ' +
        'README. The following records the available package attribution and MIT terms without ' +
        `inventing an upstream copyright date or holder.\n\n${attribution}${MIT_GRANT}`
    })];
  }
  fail(
    'THIRD_PARTY_NOTICE_TEXT_MISSING',
    `${metadata.name}@${metadata.version} (${metadata.license || 'license unavailable'})`
  );
}

function normalizedNodePackages(root = ROOT, metadata = null) {
  const grouped = metadata || runJson('pnpm', ['licenses', 'list', '--prod', '--json'], root);
  const packages = new Map();
  for (const [groupLicense, records] of Object.entries(grouped)) {
    if (!Array.isArray(records)) fail('THIRD_PARTY_NOTICE_METADATA_INVALID', 'pnpm licenses');
    for (const record of records) {
      const packageDirectories = record.paths || [];
      const foundVersions = new Set();
      for (const packageDirectory of packageDirectories) {
        const packageJson = JSON.parse(readText(path.join(packageDirectory, 'package.json')));
        if (packageJson.name !== record.name) {
          fail('THIRD_PARTY_NOTICE_METADATA_INVALID', `pnpm package name ${record.name}`);
        }
        foundVersions.add(packageJson.version);
        const author = typeof record.author === 'string'
          ? record.author
          : (typeof packageJson.author === 'string'
            ? packageJson.author
            : packageJson.author?.name || null);
        const item = {
          ecosystem: 'node',
          name: packageJson.name,
          version: packageJson.version,
          license: record.license || packageJson.license || groupLicense,
          source: record.homepage || packageJson.homepage ||
            packageJson.repository?.url || 'npm registry',
          components: ['application'],
          author,
          notices: noticeFilesForPackage(packageDirectory, {
            name: packageJson.name,
            version: packageJson.version,
            license: record.license || packageJson.license || groupLicense,
            author
          })
        };
        const key = `node:${item.name}@${item.version}`;
        const existing = packages.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          fail('THIRD_PARTY_NOTICE_DUPLICATE_CONFLICT', key);
        }
        packages.set(key, item);
      }
      const expectedVersions = [...new Set(record.versions || [])].sort(byteSort);
      const actualVersions = [...foundVersions].sort(byteSort);
      if (
        packageDirectories.length === 0 ||
        JSON.stringify(expectedVersions) !== JSON.stringify(actualVersions)
      ) {
        fail('THIRD_PARTY_NOTICE_METADATA_INCOMPLETE', record.name);
      }
    }
  }
  return packages;
}

function reachableCargoPackages(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const root = metadata.resolve.root;
  const seen = new Set([root]);
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop();
    const node = nodes.get(id);
    if (!node) fail('THIRD_PARTY_NOTICE_METADATA_INVALID', 'cargo resolve');
    for (const dependency of node.dependencies) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        pending.push(dependency);
      }
    }
  }
  seen.delete(root);
  return seen;
}

function normalizedCargoPackages(root = ROOT) {
  const packages = new Map();
  for (const [component, manifest] of CARGO_MANIFESTS) {
    const metadata = runJson('cargo', [
      'metadata', '--locked', '--offline', '--format-version=1', '--manifest-path', manifest
    ], root);
    const byId = new Map(metadata.packages.map(item => [item.id, item]));
    for (const id of reachableCargoPackages(metadata)) {
      const cargoPackage = byId.get(id);
      if (!cargoPackage || !cargoPackage.source) continue;
      const directory = path.dirname(cargoPackage.manifest_path);
      const author = Array.isArray(cargoPackage.authors)
        ? cargoPackage.authors.join(', ') || null
        : null;
      const item = {
        ecosystem: 'rust',
        name: cargoPackage.name,
        version: cargoPackage.version,
        license: cargoPackage.license || null,
        source: cargoPackage.repository || cargoPackage.source,
        components: [component],
        author,
        notices: noticeFilesForPackage(directory, {
          name: cargoPackage.name,
          version: cargoPackage.version,
          license: cargoPackage.license,
          author
        })
      };
      const key = `rust:${item.name}@${item.version}`;
      const existing = packages.get(key);
      if (existing) {
        if (
          existing.license !== item.license ||
          existing.source !== item.source ||
          JSON.stringify(existing.notices) !== JSON.stringify(item.notices)
        ) fail('THIRD_PARTY_NOTICE_DUPLICATE_CONFLICT', key);
        existing.components = [...new Set([...existing.components, component])].sort(byteSort);
      } else {
        packages.set(key, item);
      }
    }
  }
  return packages;
}

function buildNoticeModel(root = ROOT) {
  for (const [, relative] of LOCKS) {
    if (!fs.existsSync(path.join(root, relative))) {
      fail('THIRD_PARTY_NOTICE_LOCKFILE_MISSING', relative);
    }
  }
  const packages = new Map([
    ...normalizedNodePackages(root),
    ...normalizedCargoPackages(root)
  ]);
  const texts = new Map();
  const inventory = [...packages.entries()]
    .sort(([left], [right]) => byteSort(left, right))
    .map(([key, item]) => {
      const noticeReferences = item.notices.map(notice => {
        const hash = sha256Bytes(Buffer.from(notice.text, 'utf8'));
        const existing = texts.get(hash);
        if (existing && existing.text !== notice.text) {
          fail('THIRD_PARTY_NOTICE_HASH_COLLISION', hash);
        }
        if (!existing) texts.set(hash, { text: notice.text, references: [] });
        texts.get(hash).references.push(`${key} (${notice.label})`);
        return Object.freeze({ label: notice.label, hash });
      }).sort((left, right) =>
        byteSort(`${left.hash}:${left.label}`, `${right.hash}:${right.label}`)
      );
      return Object.freeze({
        key,
        ecosystem: item.ecosystem,
        name: item.name,
        version: item.version,
        license: item.license,
        source: item.source,
        components: [...item.components].sort(byteSort),
        noticeReferences
      });
    });
  for (const value of texts.values()) value.references.sort(byteSort);
  return Object.freeze({
    locks: LOCKS.map(([label, relative]) => Object.freeze({
      label,
      file: relative,
      sha256: sha256File(path.join(root, relative))
    })),
    inventory,
    texts
  });
}

function indented(text) {
  return text.split('\n').map(line => {
    const normalized = line.replace(/\t/g, '    ').replace(/ +$/g, '');
    return normalized ? `    ${normalized}` : '';
  }).join('\n');
}

function renderNotices(model) {
  const nodeCount = model.inventory.filter(item => item.ecosystem === 'node').length;
  const rustCount = model.inventory.filter(item => item.ecosystem === 'rust').length;
  const lines = [
    '# Third-Party Notices',
    '',
    'This file records license and notice material for the locked production dependencies',
    'distributed with Ticket System. It is generated deterministically by',
    '`node scripts/third-party-notices.js`; edit the dependency locks or generator, then',
    'regenerate it rather than editing this file by hand.',
    '',
    'This inventory is compliance evidence, not legal advice and not a claim that every',
    'dependency has identical redistribution obligations.',
    '',
    '## Locked inputs',
    ''
  ];
  for (const lock of model.locks) {
    lines.push(`- ${lock.label}: \`${lock.file}\` — SHA-256 \`${lock.sha256}\``);
  }
  lines.push(
    '', '## Dependency inventory', '',
    `- Node production packages: ${nodeCount}`,
    `- Rust packages embedded in shipped native binaries: ${rustCount}`, ''
  );
  for (const item of model.inventory) {
    lines.push(
      `### \`${item.key}\``, '',
      `- Declared license: \`${item.license || 'unavailable'}\``,
      `- Shipped component: ${item.components.join(', ')}`,
      `- Upstream source: ${item.source}`,
      '- License/notice text: ' + item.noticeReferences.map(reference =>
        `\`${reference.hash}\` (${reference.label})`
      ).join(', '), ''
    );
  }
  lines.push('## License and notice texts', '');
  for (const [hash, value] of [...model.texts.entries()]
    .sort(([left], [right]) => byteSort(left, right))) {
    lines.push(
      `### SHA-256 \`${hash}\``, '',
      `Referenced by: ${value.references.join('; ')}`, '',
      indented(value.text), ''
    );
  }
  return `${lines.join('\n').trim()}\n`;
}

function generateNotices(root = ROOT) {
  return renderNotices(buildNoticeModel(root));
}

function main() {
  const generated = generateNotices(ROOT);
  const output = path.join(ROOT, OUTPUT_FILE);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== generated) {
      fail('THIRD_PARTY_NOTICES_STALE');
    }
    console.log('PASS: third-party notices match locked production dependencies');
    return;
  }
  fs.writeFileSync(output, generated, { mode: 0o644 });
  console.log(`Wrote ${OUTPUT_FILE}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.code || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  MIT_GRANT,
  OUTPUT_FILE,
  buildNoticeModel,
  generateNotices,
  licenseSectionFromReadme,
  noticeFilesForPackage,
  renderNotices
};
