#!/usr/bin/env node
// ExpectedStateContract V1 Regression Test
// Verifies buildExpectedStateContract, buildObservedStateContract,
// and compareStateContracts for all four mutating operations.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function loadServerCode() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
}

function extractFunction(code, name) {
  const pattern = new RegExp(`function ${name}\\b[^{]*\\{`);
  const match = code.match(pattern);
  if (!match) return null;
  const start = match.index;
  let depth = 0;
  let i = start + match[0].length - 1;
  while (i < code.length) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
    if (depth === 0) break;
  }
  return code.slice(start, i);
}

function makeSandbox() {
  const sandbox = {};
  // Minimal crypto mock for hashContent
  sandbox.crypto = {
    createHash: (algo) => {
      let data = '';
      const hashObj = {
        update: (d) => { data += String(d); return hashObj; },
        digest: (fmt) => {
          // Simple non-crypto hash for testing determinism
          let hash = 0;
          for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
          }
          return Math.abs(hash).toString(16).padStart(64, '0');
        }
      };
      return hashObj;
    }
  };
  // Simple normalizeObjectivePathToken mock
  sandbox.normalizeObjectivePathToken = (value) => {
    const token = String(value || '').trim().replace(/\\/g, '/');
    if (!token || token.startsWith('/') || token.includes('\0')) return null;
    if (token.split('/').some(s => s === '..')) return null;
    return token;
  };
  return sandbox;
}

function installInSandbox(fnCode, sandbox) {
  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
  const wrapper = new Function(...keys, fnCode + `
    const result = {};
    if (typeof hashContent !== 'undefined') result.hashContent = hashContent;
    if (typeof buildExpectedStateContract !== 'undefined') result.buildExpectedStateContract = buildExpectedStateContract;
    if (typeof buildObservedStateContract !== 'undefined') result.buildObservedStateContract = buildObservedStateContract;
    if (typeof compareStateContracts !== 'undefined') result.compareStateContracts = compareStateContracts;
    return result;
  `);
  const result = wrapper(...values);
  Object.assign(sandbox, result);
}

function main() {
  console.log('ExpectedStateContract V1 Regression Test');
  console.log('');

  const serverCode = loadServerCode();

  // Verify helpers exist in source
  const hashContentSrc = extractFunction(serverCode, 'hashContent');
  const buildExpectedSrc = extractFunction(serverCode, 'buildExpectedStateContract');
  const buildObservedSrc = extractFunction(serverCode, 'buildObservedStateContract');
  const compareSrc = extractFunction(serverCode, 'compareStateContracts');

  assert(hashContentSrc, 'hashContent not found in server.js');
  assert(buildExpectedSrc, 'buildExpectedStateContract not found in server.js');
  assert(buildObservedSrc, 'buildObservedStateContract not found in server.js');
  assert(compareSrc, 'compareStateContracts not found in server.js');

  console.log('  [OK] All four helpers present in server.js');

  // Verify compareStateContracts does not branch on operation name
  const compareBody = compareSrc.replace(/function compareStateContracts\b[^{]*\{/, '').replace(/\}$/, '');
  const hasOpBranch = /['"](writeFile|createFolder|renamePath|deletePath)['"]/.test(compareBody) ||
    /\boperation\b/.test(compareBody);
  assert(!hasOpBranch, 'compareStateContracts must not branch on operation name');
  console.log('  [OK] compareStateContracts is operation-agnostic (no operation branching)');

  // Load helpers into sandbox
  const sandbox = makeSandbox();
  installInSandbox(hashContentSrc + '\n' + buildExpectedSrc + '\n' + buildObservedSrc + '\n' + compareSrc, sandbox);

  const {
    hashContent,
    buildExpectedStateContract,
    buildObservedStateContract,
    compareStateContracts
  } = sandbox;

  // ── Test 1: writeFile match ────────────────────────────────────
  {
    const args = { path: 'foo.txt', content: 'hello' };
    const preState = null;
    const postState = { existed: true, type: 'file', contentHash: hashContent('hello') };

    const expected = buildExpectedStateContract('writeFile', args, preState);
    const observed = buildObservedStateContract('writeFile', args, postState);
    const result = compareStateContracts(expected, observed);

    assert(result.matched, 'writeFile match should succeed');
    assertEqual(result.mismatches.length, 0, 'writeFile match should have zero mismatches');
    console.log('  [OK] writeFile match');
  }

  // ── Test 2: writeFile content mismatch ───────────────────────────
  {
    const args = { path: 'foo.txt', content: 'hello' };
    const preState = null;
    const postState = { existed: true, type: 'file', contentHash: hashContent('world') };

    const expected = buildExpectedStateContract('writeFile', args, preState);
    const observed = buildObservedStateContract('writeFile', args, postState);
    const result = compareStateContracts(expected, observed);

    assert(!result.matched, 'writeFile content mismatch should fail');
    assertEqual(result.mismatches.length, 1, 'writeFile content mismatch should have one mismatch');
    assertEqual(result.mismatches[0].field, 'contentHash', 'writeFile mismatch field should be contentHash');
    console.log('  [OK] writeFile content mismatch');
  }

  // ── Test 3: createFolder match ─────────────────────────────────
  {
    const args = { path: 'bar' };
    const preState = null;
    const postState = { existed: true, type: 'directory' };

    const expected = buildExpectedStateContract('createFolder', args, preState);
    const observed = buildObservedStateContract('createFolder', args, postState);
    const result = compareStateContracts(expected, observed);

    assert(result.matched, 'createFolder match should succeed');
    assertEqual(result.mismatches.length, 0, 'createFolder match should have zero mismatches');
    console.log('  [OK] createFolder match');
  }

  // ── Test 4: deletePath match ───────────────────────────────────
  {
    const args = { path: 'baz.txt' };
    const preState = null;
    const postState = { existed: false, type: null };

    const expected = buildExpectedStateContract('deletePath', args, preState);
    const observed = buildObservedStateContract('deletePath', args, postState);
    const result = compareStateContracts(expected, observed);

    assert(result.matched, 'deletePath match should succeed');
    assertEqual(result.mismatches.length, 0, 'deletePath match should have zero mismatches');
    console.log('  [OK] deletePath match');
  }

  // ── Test 5: renamePath source/destination match ────────────────
  {
    const args = { path: 'old.txt', nextPath: 'new.txt' };
    const preState = {
      source: { existed: true, type: 'file', contentHash: hashContent('data'), content: 'data' },
      destination: { existed: false, type: null }
    };
    const postState = {
      source: { existed: false, type: null },
      destination: { existed: true, type: 'file', contentHash: hashContent('data') }
    };

    const expected = buildExpectedStateContract('renamePath', args, preState);
    const observed = buildObservedStateContract('renamePath', args, postState);
    const result = compareStateContracts(expected, observed);

    assert(result.matched, 'renamePath match should succeed');
    assertEqual(result.mismatches.length, 0, 'renamePath match should have zero mismatches');
    console.log('  [OK] renamePath source/destination match');
  }

  // ── Test 6: renamePath destination missing mismatch ────────────
  {
    const args = { path: 'old.txt', nextPath: 'new.txt' };
    const preState = {
      source: { existed: true, type: 'file', contentHash: hashContent('data'), content: 'data' },
      destination: { existed: false, type: null }
    };
    const postState = {
      source: { existed: false, type: null },
      destination: { existed: false, type: null }
    };

    const expected = buildExpectedStateContract('renamePath', args, preState);
    const observed = buildObservedStateContract('renamePath', args, postState);
    const result = compareStateContracts(expected, observed);

    assert(!result.matched, 'renamePath destination missing should fail');
    assertEqual(result.mismatches.length, 3, 'renamePath destination missing should have three mismatches (exists, type, contentHash)');
    const existsMismatch = result.mismatches.find(m => m.field === 'exists');
    assert(existsMismatch, 'renamePath mismatch should include exists field');
    assertEqual(existsMismatch.path, 'new.txt', 'renamePath mismatch path should be destination');
    console.log('  [OK] renamePath destination missing mismatch');
  }

  // ── Test 7: operation-agnostic comparison via cross-op check ──────
  {
    // Build a synthetic contract manually (not from any single operation)
    // and verify compareStateContracts handles it uniformly
    const expected = {
      paths: {
        'a.txt': { exists: true, type: 'file', contentHash: 'abc123' }
      }
    };
    const observed = {
      paths: {
        'a.txt': { exists: true, type: 'directory', contentHash: 'abc123' }
      }
    };
    const result = compareStateContracts(expected, observed);

    assert(!result.matched, 'cross-op type mismatch should fail');
    assertEqual(result.mismatches.length, 1, 'cross-op type mismatch should have one mismatch');
    assertEqual(result.mismatches[0].field, 'type', 'cross-op mismatch field should be type');
    console.log('  [OK] operation-agnostic comparison (cross-op type mismatch)');
  }

  console.log('');
  console.log('All ExpectedStateContract V1 regression tests passed.');
}

main();
