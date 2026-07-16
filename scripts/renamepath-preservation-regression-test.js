#!/usr/bin/env node
// RenamePath Preservation Behavioral Regression Test
// Proves verifyBatchOperation emits exact checks in batch.verification_failed
// when renamePath destination type or contentHash diverges from source pre-state.

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
  console.log('RenamePath Preservation Behavioral Regression Test');
  console.log('');

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rename-pres-'));
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
        id: 'local-workspace',
        kind: 'localWorkspace',
        scope: { type: 'filesystemRoot', root: workspaceDir },
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

  // ── Test 1: Valid rename — no preservation violations ─────────
  {
    fs.writeFileSync(path.join(workspaceDir, 'src1.txt'), 'content-one');
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'renamePath', args: { path: 'src1.txt', nextPath: 'dst1.txt' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 1);
    const passed = await sandbox.verifyBatchOperation(run, action, result);

    assert(passed, 'valid rename should pass verifyBatchOperation');
    assertEqual(emittedEvents.length, 0, 'valid rename should emit zero events');
    assertEqual(emittedRunEvents.length, 0, 'valid rename should emit zero run events');
    console.log('  [OK] valid rename: no preservation violations emitted');
  }

  // ── Test 2: Destination type mismatch ─────────────────────────
  {
    fs.writeFileSync(path.join(workspaceDir, 'src2.txt'), 'content-two');
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'renamePath', args: { path: 'src2.txt', nextPath: 'dst2.txt' } };
    await sandbox.executeWorkspaceOperation(run, action, 2);

    // Replace destination file with a directory of the same name
    fs.rmSync(path.join(workspaceDir, 'dst2.txt'), { force: true });
    fs.mkdirSync(path.join(workspaceDir, 'dst2.txt'));

    // Re-read history and re-verify
    const histories = sandbox.readOperationHistory();
    const record = histories[histories.length - 1];
    const result = { historyId: record.id };
    const passed = await sandbox.verifyBatchOperation(run, action, result);

    assert(!passed, 'wrong destination type should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'wrong destination type should emit exactly one event');
    assertEqual(emittedEvents[0].type, 'batch.verification_failed', 'event type should be batch.verification_failed');

    const emittedChecks = emittedEvents[0].payload.checks;
    const typeMismatch = emittedChecks.find(c => c.check === 'destination_type_mismatch');
    assert(typeMismatch, 'event should contain destination_type_mismatch check');
    assertEqual(typeMismatch.path, 'dst2.txt', 'destination_type_mismatch path should be dst2.txt');
    assertEqual(typeMismatch.severity, 'error', 'destination_type_mismatch severity should be error');
    assertEqual(typeMismatch.expected, 'file', 'destination_type_mismatch expected should be file');
    assertEqual(typeMismatch.actual, 'directory', 'destination_type_mismatch actual should be directory');

    // ContentHash check is gated behind type preservation: when type mismatches,
    // contentHash is not evaluated (undefined for directories, would be false positive).
    const contentMismatch = emittedChecks.find(c => c.check === 'destination_content_mismatch');
    assert(!contentMismatch, 'event should NOT contain destination_content_mismatch when type already mismatched (gated check)');

    console.log('  [OK] destination type mismatch emits exact check in batch.verification_failed');
  }

  // ── Test 3: Destination content mismatch ───────────────────────
  {
    fs.writeFileSync(path.join(workspaceDir, 'src3.txt'), 'content-three');
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'renamePath', args: { path: 'src3.txt', nextPath: 'dst3.txt' } };
    await sandbox.executeWorkspaceOperation(run, action, 3);

    // Overwrite destination with different content
    fs.writeFileSync(path.join(workspaceDir, 'dst3.txt'), 'WRONG-CONTENT');

    const histories = sandbox.readOperationHistory();
    const record = histories[histories.length - 1];
    const result = { historyId: record.id };
    const passed = await sandbox.verifyBatchOperation(run, action, result);

    assert(!passed, 'wrong destination content should fail verifyBatchOperation');
    assertEqual(emittedEvents.length, 1, 'wrong destination content should emit exactly one event');
    assertEqual(emittedEvents[0].type, 'batch.verification_failed', 'event type should be batch.verification_failed');

    const emittedChecks = emittedEvents[0].payload.checks;
    const contentMismatch = emittedChecks.find(c => c.check === 'destination_content_mismatch');
    assert(contentMismatch, 'event should contain destination_content_mismatch check');
    assertEqual(contentMismatch.path, 'dst3.txt', 'destination_content_mismatch path should be dst3.txt');
    assertEqual(contentMismatch.severity, 'error', 'destination_content_mismatch severity should be error');

    // Should NOT contain type mismatch since type is correct (both are files)
    const typeMismatch = emittedChecks.find(c => c.check === 'destination_type_mismatch');
    assert(!typeMismatch, 'event should NOT contain destination_type_mismatch when type is correct');

    console.log('  [OK] destination content mismatch emits exact check in batch.verification_failed');
  }

  // ── Test 4: Both mismatches together ────────────────────────────
  {
    fs.writeFileSync(path.join(workspaceDir, 'src4.txt'), 'content-four');
    sandbox.writeOperationHistory([]);
    emittedEvents.length = 0;
    emittedRunEvents.length = 0;

    const action = { operation: 'renamePath', args: { path: 'src4.txt', nextPath: 'dst4.txt' } };
    await sandbox.executeWorkspaceOperation(run, action, 4);

    // Replace with directory (type mismatch) AND different implied content
    fs.rmSync(path.join(workspaceDir, 'dst4.txt'), { force: true });
    fs.mkdirSync(path.join(workspaceDir, 'dst4.txt'));
    fs.writeFileSync(path.join(workspaceDir, 'dst4.txt', 'inside.txt'), 'n/a');

    const histories = sandbox.readOperationHistory();
    const record = histories[histories.length - 1];
    const result = { historyId: record.id };
    const passed = await sandbox.verifyBatchOperation(run, action, result);

    assert(!passed, 'both mismatches should fail verifyBatchOperation');
    const emittedChecks = emittedEvents[0].payload.checks;
    assert(emittedChecks.some(c => c.check === 'destination_type_mismatch'),
      'both-mismatch case should contain destination_type_mismatch');
    assert(!emittedChecks.some(c => c.check === 'destination_content_mismatch'),
      'both-mismatch case should NOT contain destination_content_mismatch (gated behind type)');
    console.log('  [OK] both mismatches: only type mismatch detected (contentHash gated)');
  }

  // ── 5. Cleanup ───────────────────────────────────────────────
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  console.log('All renamePath preservation behavioral regression tests passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
