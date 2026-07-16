#!/usr/bin/env node
// Verify Batch Operation Behavioral Regression Test
// Covers all batch.verification_failed checks NOT already tested by
// renamepath-preservation-regression-test.js.
//
// Uses real executeWorkspaceOperation, real verifyBatchOperation,
// real temp filesystem mutations, and real operation-history.
// Captures appendEvent / recordRunEvent to inspect exact emitted records.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function loadServerCode() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
}

function extractFunction(code, name) {
  const declPattern = new RegExp(`(?:async\\s+)?function ${name}\\b`);
  const declMatch = code.match(declPattern);
  if (!declMatch) return null;

  let i = declMatch.index + declMatch[0].length;
  let parenDepth = 0;
  let foundParen = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '(') { parenDepth++; foundParen = true; }
    else if (ch === ')') { parenDepth--; }
    else if (ch === '{' && foundParen && parenDepth === 0) { break; }
    i++;
  }
  if (i >= code.length || code[i] !== '{') return null;

  let depth = 0;
  let j = i;
  while (j < code.length) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') depth--;
    j++;
    if (depth === 0) break;
  }
  return code.slice(declMatch.index, j);
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

async function main() {
  console.log('Verify Batch Operation Behavioral Regression Test');
  console.log('');

  // ── 0. Setup ───────────────────────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'vb-batch-'));
  const workspaceDir = path.join(tmpDir, 'workspace');
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'tickets.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'runs.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'operation-history.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'logs.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'workflows.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'replay-snapshots.json'), '{}');

  const code = loadServerCode();

  const functionsToExtract = [
    'hashContent',
    'normalizeObjectivePathToken',
    'nextId',
    'sanitizeOperationArgs',
    'assertOnlyKeys',
    'computeMutationFingerprint',
    'computePathFingerprint',
    'normalizeArtifactOwnershipPath',
    'getSuccessfulArtifactOwnershipPath',
    'captureWorkspacePreState',
    'captureWorkspacePostState',
    'persistWorkspaceOperationHistory',
    'parseWorkspaceOperation',
    'findCommittedMutation',
    'findConflictingMutation',
    'findPriorSuccessfulArtifactOwner',
    'workspacePathsOverlap',
    'findOverlappingSuccessfulArtifactOwner',
    'assertNoCrossTicketOverlap',
    'buildTargetEvidenceMetadata',
    'buildTargetActorContext',
    'buildMutationResourceChanges',
    'buildTargetMutationReceipt',
    'executeWorkspaceOperation',
    'verifyBatchOperation'
  ];

  const extractedCode = functionsToExtract
    .map(name => extractFunction(code, name))
    .filter(Boolean)
    .join('\n\n');

  const emittedEvents = [];
  const emittedRunEvents = [];

  const sandbox = {
    eventAppendFailure: null,
    crypto,
    console,
    Buffer,
    path,
    require,
    module: {},
    exports: {},
    __dirname: ROOT,
    __filename: path.join(ROOT, 'server.js'),
    process,

    __workspaceDir: workspaceDir,
    __dataDir: dataDir,

    readOperationHistory() {
      const f = path.join(dataDir, 'operation-history.json');
      if (!fs.existsSync(f)) return [];
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    },
    writeOperationHistory(records) {
      fs.writeFileSync(path.join(dataDir, 'operation-history.json'), JSON.stringify(records, null, 2));
    },
    readRuns() {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8'));
    },
    writeRuns(runs) {
      fs.writeFileSync(path.join(dataDir, 'runs.json'), JSON.stringify(runs, null, 2));
    },
    readLogs() {
      const f = path.join(dataDir, 'logs.json');
      if (!fs.existsSync(f)) return [];
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    },
    writeLogs(logs) {
      fs.writeFileSync(path.join(dataDir, 'logs.json'), JSON.stringify(logs, null, 2));
    },

    getRunWorkspaceProvider(run) {
      return {
        root: workspaceDir,
        getPathInfo(p) {
          const fullPath = path.join(workspaceDir, p);
          try {
            const stat = fs.statSync(fullPath);
            return {
              exists: true,
              type: stat.isDirectory() ? 'directory' : 'file',
              contentHash: stat.isFile()
                ? hashContent(fs.readFileSync(fullPath, 'utf8'))
                : undefined
            };
          } catch {
            return { exists: false, type: null };
          }
        },
        readFile(p) {
          return fs.readFileSync(path.join(workspaceDir, p), 'utf8');
        },
        writeFile(p, content) {
          fs.writeFileSync(path.join(workspaceDir, p), content);
          return { path: p, status: 'created' };
        },
        delete(p) {
          try {
            fs.unlinkSync(path.join(workspaceDir, p));
            return { path: p, status: 'deleted' };
          } catch {
            return { path: p, status: 'already_missing_noop' };
          }
        },
        createFolder(p) {
          fs.mkdirSync(path.join(workspaceDir, p), { recursive: true });
          return { path: p, status: 'created' };
        },
        rename(from, to) {
          fs.renameSync(path.join(workspaceDir, from), path.join(workspaceDir, to));
          return { path: to, status: 'renamed' };
        },
        exists(p, opts) {
          return fs.existsSync(path.join(workspaceDir, p));
        },
        list(p) {
          return { path: p, entries: fs.readdirSync(path.join(workspaceDir, p)) };
        }
      };
    },

    checkWorkspaceMutationAuthority() {},
    assertAllocatedOwnershipAllowsMutation() {},
    assertAgentWorkspacePathAllowed() {},
    blockProtectedWorkspaceOperation() {},
    appendRunLog() {},
    buildWorkspaceActionMetadata() { return {}; },
    getRunOwnedOutputPaths() { return []; },
    appendEvent(event) {
      emittedEvents.push(event);
    },
    recordRunEvent(run, type, message, details) {
      emittedRunEvents.push({ runId: run.id, type, message, details });
    },

    AGENT_ALLOWED_OPERATIONS: [
      'listDirectory', 'readFile', 'createFolder', 'writeFile', 'renamePath', 'deletePath'
    ],
    AGENT_MUTATING_OPERATIONS: [
      'createFolder', 'writeFile', 'renamePath', 'deletePath'
    ],
    AGENT_OPERATION_ARGS: {
      listDirectory: ['path'],
      readFile: ['path'],
      createFolder: ['path'],
      writeFile: ['path', 'content'],
      renamePath: ['path', 'nextPath'],
      deletePath: ['path']
    },
    AGENT_DIRECT_OPERATIONS: [
      'listDirectory', 'readFile', 'createFolder', 'writeFile', 'renamePath', 'deletePath',
      'createWorkflowDraft', 'createWorkflowDraftIntent', 'createHandoffTask'
    ],

    createLogTimestamp() {
      return new Date().toISOString();
    },
    requireStringArg(args, name, options = {}) {
      if (!Object.prototype.hasOwnProperty.call(args, name)) {
        const error = new Error(`Workspace operation missing required arg: ${name}`);
        error.code = 'WORKSPACE_MALFORMED_ACTION';
        throw error;
      }
      if (typeof args[name] !== 'string') {
        const error = new Error(`Workspace operation arg must be a string: ${name}`);
        error.code = 'WORKSPACE_MALFORMED_ACTION';
        throw error;
      }
      if (options.nonEmpty && !args[name].trim()) {
        const error = new Error(`Workspace operation arg cannot be blank: ${name}`);
        error.code = 'WORKSPACE_MALFORMED_ACTION';
        throw error;
      }
      return args[name];
    },
    sanitizeSnapshotValue: function sanitizeSnapshotValue(value) {
      if (value === undefined) return null;
      if (value === null) return null;
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return value;
      if (typeof value === 'boolean') return value;
      if (Array.isArray(value)) return value.map(v => sanitizeSnapshotValue(v));
      if (typeof value === 'object') {
        const sanitized = {};
        for (const [key, val] of Object.entries(value)) {
          sanitized[key] = sanitizeSnapshotValue(val);
        }
        return sanitized;
      }
      return String(value);
    }
  };

  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
  const wrapper = new Function(...keys, extractedCode + `
    const result = {};
    ${functionsToExtract.map(name => `if (typeof ${name} !== 'undefined') result.${name} = ${name};`).join('\n    ')}
    return result;
  `);
  const extractedFns = wrapper(...values);
  Object.assign(sandbox, extractedFns);

  const run = {
    id: 1,
    ticketId: 1,
    agentId: 'test',
    agentName: 'TestAgent',
    currentPhase: 'mutation',
    workspaceType: 'main',
    executionWorkspaceType: 'main'
  };

  // ── 1. Test: renamePath source_still_exists (warning) ─────────
  {
    fs.writeFileSync(path.join(workspaceDir, 'src_warn.txt'), 'data');
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'renamePath', args: { path: 'src_warn.txt', nextPath: 'dst_warn.txt' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 1);

    // Recreate source after rename to induce the warning
    fs.writeFileSync(path.join(workspaceDir, 'src_warn.txt'), 'back');

    const passed = await sandbox.verifyBatchOperation(run, action, result);
    assert(!passed, 'source_still_exists should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'source_still_exists should emit exactly one event');
    assertEqual(emittedEvents[0].type, 'batch.verification_failed', 'event type should be batch.verification_failed');

    const emittedChecks = emittedEvents[0].payload.checks;
    const check = emittedChecks.find(c => c.check === 'source_still_exists');
    assert(check, 'should contain source_still_exists check');
    assertEqual(check.path, 'src_warn.txt', 'source_still_exists path');
    assertEqual(check.severity, 'warning', 'source_still_exists severity');

    console.log('  [OK] source_still_exists emits exact check');
  }

  // ── 2. Test: renamePath destination_missing (error) ──────────
  {
    fs.writeFileSync(path.join(workspaceDir, 'src_miss.txt'), 'data');
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'renamePath', args: { path: 'src_miss.txt', nextPath: 'dst_miss.txt' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 2);

    // Delete destination after rename
    fs.rmSync(path.join(workspaceDir, 'dst_miss.txt'), { force: true });

    const passed = await sandbox.verifyBatchOperation(run, action, result);
    assert(!passed, 'destination_missing should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'destination_missing should emit exactly one event');

    const emittedChecks = emittedEvents[0].payload.checks;
    const check = emittedChecks.find(c => c.check === 'destination_missing');
    assert(check, 'should contain destination_missing check');
    assertEqual(check.path, 'dst_miss.txt', 'destination_missing path');
    assertEqual(check.severity, 'error', 'destination_missing severity');

    console.log('  [OK] destination_missing emits exact check');
  }

  // ── 3. Test: createFolder folder_missing (error) ──────────────
  {
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'createFolder', args: { path: 'folder1' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 3);

    // Delete created folder
    fs.rmdirSync(path.join(workspaceDir, 'folder1'));

    const passed = await sandbox.verifyBatchOperation(run, action, result);
    assert(!passed, 'folder_missing should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'folder_missing should emit exactly one event');

    const emittedChecks = emittedEvents[0].payload.checks;
    const check = emittedChecks.find(c => c.check === 'folder_missing');
    assert(check, 'should contain folder_missing check');
    assertEqual(check.path, 'folder1', 'folder_missing path');
    assertEqual(check.severity, 'error', 'folder_missing severity');

    console.log('  [OK] folder_missing emits exact check');
  }

  // ── 4. Test: writeFile file_missing (error) ─────────────────
  {
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'writeFile', args: { path: 'file1.txt', content: 'hello' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 4);

    // Delete written file
    fs.rmSync(path.join(workspaceDir, 'file1.txt'), { force: true });

    const passed = await sandbox.verifyBatchOperation(run, action, result);
    assert(!passed, 'file_missing should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'file_missing should emit exactly one event');

    const emittedChecks = emittedEvents[0].payload.checks;
    const check = emittedChecks.find(c => c.check === 'file_missing');
    assert(check, 'should contain file_missing check');
    assertEqual(check.path, 'file1.txt', 'file_missing path');
    assertEqual(check.severity, 'error', 'file_missing severity');

    console.log('  [OK] file_missing emits exact check');
  }

  // ── 5. Test: writeFile content_mismatch (error) ─────────────
  {
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'writeFile', args: { path: 'file2.txt', content: 'hello' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 5);

    // Overwrite with different content
    fs.writeFileSync(path.join(workspaceDir, 'file2.txt'), 'world');

    const passed = await sandbox.verifyBatchOperation(run, action, result);
    assert(!passed, 'content_mismatch should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'content_mismatch should emit exactly one event');

    const emittedChecks = emittedEvents[0].payload.checks;
    const check = emittedChecks.find(c => c.check === 'content_mismatch');
    assert(check, 'should contain content_mismatch check');
    assertEqual(check.path, 'file2.txt', 'content_mismatch path');
    assertEqual(check.severity, 'error', 'content_mismatch severity');

    console.log('  [OK] content_mismatch emits exact check');
  }

  // ── 6. Test: deletePath path_still_exists (error) ───────────
  {
    fs.writeFileSync(path.join(workspaceDir, 'del1.txt'), 'data');
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'deletePath', args: { path: 'del1.txt' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 6);

    // Recreate deleted path
    fs.writeFileSync(path.join(workspaceDir, 'del1.txt'), 'back');

    const passed = await sandbox.verifyBatchOperation(run, action, result);
    assert(!passed, 'path_still_exists should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'path_still_exists should emit exactly one event');

    const emittedChecks = emittedEvents[0].payload.checks;
    const check = emittedChecks.find(c => c.check === 'path_still_exists');
    assert(check, 'should contain path_still_exists check');
    assertEqual(check.path, 'del1.txt', 'path_still_exists path');
    assertEqual(check.severity, 'error', 'path_still_exists severity');

    console.log('  [OK] path_still_exists emits exact check');
  }

  // ── 7. Test: valid operations emit zero events ───────────────
  {
    const ops = [
      { operation: 'createFolder', args: { path: 'valid_folder' } },
      { operation: 'writeFile', args: { path: 'valid_file.txt', content: 'ok' } },
      { operation: 'deletePath', args: { path: 'valid_file.txt' } },
      { operation: 'renamePath', args: { path: 'valid_folder', nextPath: 'valid_renamed' } }
    ];

    // Prepare files for rename
    fs.writeFileSync(path.join(workspaceDir, 'valid_src.txt'), 'ok');

    for (const action of ops) {
      sandbox.writeOperationHistory([]);
      emittedEvents.length = 0;
      emittedRunEvents.length = 0;

      const result = await sandbox.executeWorkspaceOperation(run, action, 99);
      const passed = await sandbox.verifyBatchOperation(run, action, result);
      assert(passed, `valid ${action.operation} should pass verifyBatchOperation`);
      assertEqual(emittedEvents.length, 0, `valid ${action.operation} should emit zero events`);
    }
    console.log('  [OK] valid operations emit zero verification events');
  }

  // ── 8. Cleanup ──────────────────────────────────────────────
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  console.log('All verify-batch-operation behavioral regression tests passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
