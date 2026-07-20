const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-regression-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('recovery-regression');
const PORT = process.env.PORT || '3423';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_FILES = [
  'agents.json',
  'allocation-plans.json',
  'groups.json',
  'logs.json',
  'memberships.json',
  'operation-history.json',
  'permissions.json',
  'runs.json',
  'tickets.json',
  'users.json'
];
const STAMP = Date.now();
const WRITE_TEST_FILE = `recovery-write-${STAMP}.txt`;
const RENAME_SOURCE_FILE = `recovery-rename-source-${STAMP}.txt`;
const RENAME_DEST_FILE = `recovery-rename-dest-${STAMP}.txt`;
const DELETE_TEST_FILE = `recovery-delete-${STAMP}.txt`;

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else {
    fs.writeFileSync(dst, '[]');
  }
}

function readRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return null;
  if (run.replaySnapshot && typeof run.replaySnapshot === 'object') return run.replaySnapshot;
  if (!run.replaySnapshotPath) return null;

  const snapshotPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(snapshotPath)) return null;
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function hydrateRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return run;
  const replaySnapshot = readRunReplaySnapshot(run);
  return replaySnapshot ? { ...run, replaySnapshot } : run;
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  if (file !== 'runs.json' || !Array.isArray(value)) return value;
  return value.map(hydrateRunReplaySnapshot);
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body
      ? JSON.stringify(options.body)
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

async function waitForReady() {
  const started = Date.now();

  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        if (body.ready) return;
      }
    } catch (error) {
      // Server is still starting.
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  }

  return cookieFrom(response);
}

function seedAgent() {
  const agents = readJson('agents.json');
  const nextAgentId = Math.max(0, ...agents.map(agent => agent.id)) + 1;
  const agent = {
    id: nextAgentId,
    name: `RecoveryRegression-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-recovery',
    createdAt: new Date().toISOString()
  };

  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `recovery-regression-openai-${process.pid}-${Date.now()}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-recovery-request']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  await new Promise(resolve => setTimeout(resolve, 50));

  // Match the current ticket objective exactly. Prior recovery cases leave
  // filenames in workspace context that share the recovery-* prefix, so
  // substring matching against the full combined prompt selects the wrong plan.
  if (combined.includes('recovery-write ${STAMP}')) {
    return okResponse({
      message: 'Creating test file for recovery.',
      actions: [{
        operation: 'writeFile',
        args: {
          path: '${WRITE_TEST_FILE}',
          content: 'recovery-write-content'
        }
      }],
      complete: true
    });
  }

  if (combined.includes('recovery-rename ${STAMP}')) {
    return okResponse({
      message: 'Creating and renaming test file for recovery.',
      actions: [
        {
          operation: 'writeFile',
          args: {
            path: '${RENAME_SOURCE_FILE}',
            content: 'recovery-rename-content'
          }
        },
        {
          operation: 'renamePath',
          args: {
            path: '${RENAME_SOURCE_FILE}',
            nextPath: '${RENAME_DEST_FILE}'
          }
        }
      ],
      complete: true
    });
  }

  if (combined.includes('recovery-delete ${STAMP}')) {
    return okResponse({
      message: 'Deleting test file for recovery.',
      actions: [{
        operation: 'deletePath',
        args: {
          path: '${DELETE_TEST_FILE}'
        }
      }],
      complete: true
    });
  }

  return okResponse({
    message: 'recovery fallback complete',
    actions: [],
    complete: true
  });
};
`;

  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function createAssignedTicket(cookie, agentId, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId)
    }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Assigned ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  }

  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Assigned ticket was not persisted');
  return ticket;
}

async function waitForTicketStatus(ticketId, expectedStatus) {
  const started = Date.now();

  while (Date.now() - started < 30000) {
    const ticket = readJson('tickets.json').find(item => item.id === ticketId);
    if (ticket && ticket.status === expectedStatus) return ticket;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ticket ${ticketId} to become ${expectedStatus}`);
}

async function waitForRuns(ticketId, expectedCount, predicate) {
  const started = Date.now();

  while (Date.now() - started < 30000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const terminalSnapshotsReady = runs.every(run =>
      !['completed', 'failed', 'interrupted'].includes(run.status) ||
      (run.replaySnapshot && run.replaySnapshot.terminalStatus === run.status)
    );
    if (runs.length >= expectedCount && terminalSnapshotsReady && (!predicate || predicate(runs))) return runs;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
  throw new Error(`Timed out waiting for ${expectedCount} runs for ticket ${ticketId}: ${JSON.stringify(runs.map(run => ({
    id: run.id,
    status: run.status,
    error: run.error,
    terminalStatus: run.replaySnapshot && run.replaySnapshot.terminalStatus
  })))}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const agent = seedAgent();
  const preloadPath = createFakeOpenAIPreload();
  let server = null;

  try {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, DELETE_TEST_FILE), 'recovery-delete-content');

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        NODE_OPTIONS: `--require ${preloadPath}`,
        WORKSPACE_ROOT,
        DATA_DIR,
        TEST_INTERRUPT_AFTER_OPERATOR_RECOVERY_EFFECT: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();

    // --- writeFile recovery test ---
    const writeTicket = await createAssignedTicket(cookie, agent.id, `recovery-write ${STAMP}`);
    await waitForTicketStatus(writeTicket.id, 'in_progress');
    const writeRuns = await waitForRuns(writeTicket.id, 1, runs => runs.every(run => run.status === 'completed'));
    const writeRun = writeRuns[0];

    assert(fs.existsSync(path.join(WORKSPACE_ROOT, WRITE_TEST_FILE)), 'writeFile test file should exist');

    const writeHistory = readJson('operation-history.json');
    const writeOp = writeHistory.find(h => h.runId === writeRun.id && h.operation === 'writeFile');
    assert(writeOp, 'writeFile operation history record should exist');
    assert(writeOp.preState && writeOp.preState.existed === false, 'writeFile preState should show non-existent');
    assert(writeOp.postState && writeOp.postState.existed === true, 'writeFile postState should show existed');

    // Preview writeFile recovery
    const writePreviewResponse = await request('GET', `/api/operations/${writeOp.id}/recovery-preview`, { cookie });
    assert(writePreviewResponse.statusCode === 200, `writeFile recovery preview failed: HTTP ${writePreviewResponse.statusCode}`);
    const writePreview = JSON.parse(writePreviewResponse.body);
    assert(writePreview.preview && writePreview.preview.canProceed === true, 'writeFile recovery preview should indicate can proceed');
    assert(writePreview.preview.proposedAction && writePreview.preview.proposedAction.operation === 'deletePath', 'writeFile recovery should propose deletePath');

    // Interrupt after the external effect but before completion evidence. A
    // retry must confirm the prepared effect and must not execute it again.
    const interruptedWriteRecoverResponse = await request('POST', `/api/operations/${writeOp.id}/recover`, {
      cookie,
      body: { confirmed: true }
    });
    assert(interruptedWriteRecoverResponse.statusCode === 400,
      `interrupted writeFile recovery should expose the test interruption: HTTP ${interruptedWriteRecoverResponse.statusCode}`);
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, WRITE_TEST_FILE)),
      'interrupted recovery should have applied the target effect before evidence completion');

    const writeRecoverResponse = await request('POST', `/api/operations/${writeOp.id}/recover`, {
      cookie,
      body: { confirmed: true }
    });
    assert(writeRecoverResponse.statusCode === 200, `writeFile recovery failed: HTTP ${writeRecoverResponse.statusCode}`);
    const writeRecover = JSON.parse(writeRecoverResponse.body);
    assert(writeRecover.recovery && writeRecover.recovery.isRecovery === true, 'Recovery record should be marked isRecovery');
    assert(writeRecover.recovery.recoveredHistoryId === writeOp.id, 'Recovery record should link to original history');
    assert(writeRecover.reconciled === true, 'Retry should reconcile the already-applied prepared recovery effect');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, WRITE_TEST_FILE)), 'writeFile recovery should delete the file');

    const duplicateWriteRecoverResponse = await request('POST', `/api/operations/${writeOp.id}/recover`, {
      cookie,
      body: { confirmed: true }
    });
    assert(duplicateWriteRecoverResponse.statusCode === 200, 'Repeated recovery should be an idempotent success');
    const duplicateWriteRecover = JSON.parse(duplicateWriteRecoverResponse.body);
    assert(duplicateWriteRecover.idempotent === true, 'Repeated recovery response should be labelled idempotent');
    assert(duplicateWriteRecover.recovery.id === writeRecover.recovery.id,
      'Repeated recovery must return the original completion receipt');

    const writeEvents = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').trim().split(/\r?\n/)
      .filter(Boolean).map(line => JSON.parse(line)).filter(event => event.runId === writeRun.id);
    assert(writeEvents.some(event => event.type === 'workspace.recovery_prepared'),
      'Recovery intent must be durably recorded before the target effect');
    assert(writeEvents.some(event => event.type === 'workspace.recovery_completed'),
      'Reconciled recovery must record completion evidence');

    // Recovery blocked on diverged state
    fs.writeFileSync(path.join(WORKSPACE_ROOT, WRITE_TEST_FILE), 'modified-content');
    const divergedPreviewResponse = await request('GET', `/api/operations/${writeOp.id}/recovery-preview`, { cookie });
    assert(divergedPreviewResponse.statusCode === 200, 'Diverged preview request should succeed');
    const divergedPreview = JSON.parse(divergedPreviewResponse.body);
    assert(divergedPreview.preview && divergedPreview.preview.canProceed === false, 'Diverged state recovery should be blocked');
    fs.unlinkSync(path.join(WORKSPACE_ROOT, WRITE_TEST_FILE));

    // --- renamePath recovery test ---
    const renameTicket = await createAssignedTicket(cookie, agent.id, `recovery-rename ${STAMP}`);
    await waitForTicketStatus(renameTicket.id, 'in_progress');
    const renameRuns = await waitForRuns(renameTicket.id, 1, runs => runs.every(run => run.status === 'completed'));
    const renameRun = renameRuns[0];

    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, RENAME_SOURCE_FILE)), 'rename source should no longer exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, RENAME_DEST_FILE)), 'rename destination should exist');

    const renameHistory = readJson('operation-history.json');
    const renameOp = renameHistory.find(h => h.runId === renameRun.id && h.operation === 'renamePath');
    assert(renameOp, 'renamePath operation history record should exist');
    assert(renameOp.preState && renameOp.preState.source && renameOp.preState.source.existed === true, 'renamePath preState source should show existed');
    assert(renameOp.preState.destination && renameOp.preState.destination.existed === false, 'renamePath preState destination should show non-existent');

    // Preview renamePath recovery
    const renamePreviewResponse = await request('GET', `/api/operations/${renameOp.id}/recovery-preview`, { cookie });
    assert(renamePreviewResponse.statusCode === 200, `renamePath recovery preview failed: HTTP ${renamePreviewResponse.statusCode}`);
    const renamePreview = JSON.parse(renamePreviewResponse.body);
    assert(renamePreview.preview && renamePreview.preview.canProceed === true, 'renamePath recovery preview should indicate can proceed');
    assert(renamePreview.preview.proposedAction && renamePreview.preview.proposedAction.operation === 'renamePath', 'renamePath recovery should propose renamePath');
    assert(renamePreview.preview.proposedAction.args.path === RENAME_DEST_FILE, 'renamePath recovery should use dest as source');
    assert(renamePreview.preview.proposedAction.args.nextPath === RENAME_SOURCE_FILE, 'renamePath recovery should use source as dest');

    // Execute renamePath recovery
    const renameRecoverResponse = await request('POST', `/api/operations/${renameOp.id}/recover`, {
      cookie,
      body: { confirmed: true }
    });
    assert(renameRecoverResponse.statusCode === 200, `renamePath recovery failed: HTTP ${renameRecoverResponse.statusCode}`);
    const renameRecover = JSON.parse(renameRecoverResponse.body);
    assert(renameRecover.recovery && renameRecover.recovery.isRecovery === true, 'renamePath recovery record should be marked isRecovery');
    assert(renameRecover.recovery.recoveredHistoryId === renameOp.id, 'renamePath recovery record should link to original history');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, RENAME_SOURCE_FILE)), 'renamePath recovery should restore source file');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, RENAME_DEST_FILE)), 'renamePath recovery should remove destination file');

    // Recovery operation history linkage
    const allHistory = readJson('operation-history.json');
    const recoveryRecords = allHistory.filter(h => h.isRecovery);
    assert(recoveryRecords.length >= 2, 'At least 2 recovery records should exist');
    assert(recoveryRecords.every(h => h.recoveredHistoryId != null), 'All recovery records should have recoveredHistoryId');
    assert(recoveryRecords.some(h => h.operation === 'deletePath'), 'Recovery records should include deletePath');
    assert(recoveryRecords.some(h => h.operation === 'renamePath'), 'Recovery records should include renamePath');

    // Recovery logs visibility
    const logs = readJson('logs.json');
    const recoveryLogs = logs.filter(log => log.type === 'workspace:recovery');
    assert(recoveryLogs.length >= 2, 'At least 2 recovery system logs should exist');
    assert(recoveryLogs.every(log => log.workspaceAction && log.workspaceAction.operation === 'recovery'), 'Recovery logs should have recovery workspaceAction');

    // Recovery replay visibility via run detail page
    const runDetailPage = await request('GET', `/runs/${renameRun.id}`, { cookie });
    assert(runDetailPage.statusCode === 200, 'Run detail page should load');
    assert(runDetailPage.body.includes('RECOVERABLE') || runDetailPage.body.includes('RECOVERY AVAILABLE') || runDetailPage.body.includes('RECOVERY'), 'Run detail page should show recovery status');

    // --- deletePath unrecoverable visibility ---
    const deleteTicket = await createAssignedTicket(cookie, agent.id, `recovery-delete ${STAMP}`);
    await waitForTicketStatus(deleteTicket.id, 'in_progress');
    const deleteRuns = await waitForRuns(deleteTicket.id, 1, runs => runs.every(run => run.status === 'completed'));
    const deleteRun = deleteRuns[0];

    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, DELETE_TEST_FILE)), 'deletePath test file should be deleted');

    const deleteHistory = readJson('operation-history.json');
    const deleteOp = deleteHistory.find(h => h.runId === deleteRun.id && h.operation === 'deletePath');
    assert(deleteOp, 'deletePath operation history record should exist');
    assert(deleteOp.preState && deleteOp.preState.existed === true, 'deletePath preState should show existed');

    const deletePreviewResponse = await request('GET', `/api/operations/${deleteOp.id}/recovery-preview`, { cookie });
    assert(deletePreviewResponse.statusCode === 200, `deletePath recovery preview request should succeed`);
    const deletePreview = JSON.parse(deletePreviewResponse.body);
    assert(deletePreview.preview && deletePreview.preview.canProceed === false, 'deletePath should be unrecoverable');
    assert(deletePreview.preview.status === 'unrecoverable', 'deletePath should have unrecoverable status');

    // Ticket detail page should show recovery visibility
    const ticketDetailPage = await request('GET', `/tickets/${writeTicket.id}`, { cookie });
    assert(ticketDetailPage.statusCode === 200, 'Ticket detail page should load');
    assert(ticketDetailPage.body.includes('Operation History'), 'Ticket detail page should show operation history');
    assert(ticketDetailPage.body.includes('RECOVERABLE') || ticketDetailPage.body.includes('UNRECOVERABLE') || ticketDetailPage.body.includes('RECOVERY'), 'Ticket detail page should show recovery badges');

    console.log(JSON.stringify({
      writeFileRecovered: true,
      renamePathRecovered: true,
      divergedStateBlocked: true,
      recoveryHistoryLinkage: true,
      recoveryLogVisibility: true,
      recoveryReplayVisibility: true,
      deletePathUnrecoverable: true
    }));
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
