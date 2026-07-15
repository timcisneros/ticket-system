#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'ARCHIVE',
  'node_modules',
  'data',
  'workspace-root',
  '.local-data',
  '.local-workspace',
  '.local-demo-data',
  '.local-demo-workspace'
]);

function collectJavaScriptFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(absolutePath, files);
    } else if (entry.isFile() && /\.(?:cjs|js)$/.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

const files = collectJavaScriptFiles(ROOT).sort();
const failures = [];

for (const file of files) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    new vm.Script(source, { filename: file });
  } catch (error) {
    failures.push({
      file: path.relative(ROOT, file),
      output: error && error.stack ? error.stack : String(error)
    });
  }
}

if (failures.length > 0) {
  failures.forEach(failure => {
    console.error(`FAIL: ${failure.file}`);
    if (failure.output) console.error(failure.output);
  });
  process.exit(1);
}

console.log(`PASS: JavaScript syntax (${files.length} source files)`);
