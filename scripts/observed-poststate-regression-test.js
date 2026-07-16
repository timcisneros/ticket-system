#!/usr/bin/env node
// Observed Post-State V1 Behavioral Regression Test
// Proves operation-history.postState comes from filesystem observation
// (captureWorkspacePostState), not from hardcoded args or literals.
//
// Strategy: mock the workspace provider to produce filesystem states
// that differ from the action's requested args. Then verify the
// persisted operation-history reflects the filesystem reality.

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
  // Find the function declaration, then scan to the body opening brace
  // (skipping past parameter defaults that may contain braces).
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

async function main() {
  console.log('Observed Post-State V1 Behavioral Regression Test');
  console.log('');

  // ── 1. Create temp workspace and data dirs ──────────────────────
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'poststate-beh-'));
  const workspaceDir = path.join(tmpDir, 'workspace');
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // Initialize empty data files
  fs.writeFileSync(path.join(dataDir, 'tickets.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'runs.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'operation-history.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'logs.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'workflows.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'replay-snapshots.json'), '{}');

  // ── 2. Load server code and extract functions ──────────────────
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
    'executeWorkspaceOperation'
  ];

  const extractedCode = functionsToExtract
    .map(name => extractFunction(code, name))
    .filter(Boolean)
    .join('\n\n');

  assert(extractedCode.includes('function executeWorkspaceOperation'),
    'Must extract executeWorkspaceOperation from server.js');

  // ── 3. Build sandbox with mocked runtime ───────────────────────
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

    // Data helpers
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

    // Mocked workspace provider factory
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
                ? sandbox.hashContent(fs.readFileSync(fullPath, 'utf8'))
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
          // BEHAVIORAL KEY: write DIFFERENT content than requested
          fs.writeFileSync(path.join(workspaceDir, p), 'ACTUAL_FILESYSTEM_CONTENT');
          return { path: p, status: 'created' };
        },
        delete(p) {
          // BEHAVIORAL KEY: do NOT actually delete the file
          return { path: p, status: 'deleted' };
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

    // Authority / permission mocks (no-op)
    checkWorkspaceMutationAuthority() {},
    assertAllocatedOwnershipAllowsMutation() {},
    assertAgentWorkspacePathAllowed() {},
    blockProtectedWorkspaceOperation() {},
    appendRunLog() {},
    buildWorkspaceActionMetadata() { return {}; },
    getRunOwnedOutputPaths() { return []; },

    // Constants
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

    // Functions that reference module-level vars or have brace-in-signature issues
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

  // Eval extracted functions into sandbox
  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
  const wrapper = new Function(...keys, extractedCode + `
    const result = {};
    ${functionsToExtract.map(name => `if (typeof ${name} !== 'undefined') result.${name} = ${name};`).join('\n    ')}
    return result;
  `);
  const extractedFns = wrapper(...values);
  Object.assign(sandbox, extractedFns);

  // ── 4. Create mock run ─────────────────────────────────────────
  const run = {
    id: 1,
    ticketId: 1,
    agentId: 'test',
    agentName: 'TestAgent',
    currentPhase: 'mutation',
    workspaceType: 'main',
    executionWorkspaceType: 'main'
  };

  // ── 5. Behavioral proof: writeFile ───────────────────────────
  {
    const action = { operation: 'writeFile', args: { path: 'test.txt', content: 'REQUESTED_CONTENT' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 1);

    const histories = sandbox.readOperationHistory();
    assert(histories.length === 1, 'writeFile should persist exactly one history record');
    const record = histories[0];

    assertEqual(record.operation, 'writeFile', 'record operation should be writeFile');

    // Old code would have recorded hashContent('REQUESTED_CONTENT') from args.
    // New code calls captureWorkspacePostState which reads the ACTUAL filesystem.
    // Our mock provider wrote 'ACTUAL_FILESYSTEM_CONTENT'.
    const observedHash = record.postState.contentHash;
    const filesystemHash = sandbox.hashContent('ACTUAL_FILESYSTEM_CONTENT');
    const argsHash = sandbox.hashContent('REQUESTED_CONTENT');

    assertEqual(observedHash, filesystemHash,
      'writeFile postState.contentHash must match actual filesystem content');
    assert(observedHash !== argsHash,
      'writeFile postState.contentHash must NOT match args.content — proves observation');

    console.log('  [OK] writeFile postState provenance: filesystem observation');
  }

  // ── 6. Behavioral proof: deletePath ────────────────────────────
  {
    // Create a file that our mock delete will pretend to delete
    fs.writeFileSync(path.join(workspaceDir, 'delete-me.txt'), 'file-content');
    sandbox.writeOperationHistory([]);

    const action = { operation: 'deletePath', args: { path: 'delete-me.txt' } };
    const result = await sandbox.executeWorkspaceOperation(run, action, 2);

    const histories = sandbox.readOperationHistory();
    assert(histories.length === 1, 'deletePath should persist exactly one history record');
    const record = histories[0];

    assertEqual(record.operation, 'deletePath', 'record operation should be deletePath');

    // Old code hardcoded postState = { existed: false }.
    // New code calls captureWorkspacePostState which reads the filesystem.
    // Our mock provider did NOT delete the file, so it still exists.
    assertEqual(record.postState.existed, true,
      'deletePath postState.existed must reflect actual filesystem (file still exists)');
    assert(record.postState.existed !== false,
      'deletePath postState.existed must NOT be hardcoded false — proves observation');

    console.log('  [OK] deletePath postState provenance: filesystem observation');
  }

  // ── 7. Cleanup ───────────────────────────────────────────────
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  console.log('All behavioral post-state provenance tests passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
