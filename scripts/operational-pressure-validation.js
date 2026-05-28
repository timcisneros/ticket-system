#!/usr/bin/env node
// Operational Pressure Validation — 10 diverse workloads, same runtime semantics.
// No new runtime semantics, no limit changes, no weakened enforcement.
// If a task fails, categorize: workload design | prompt/profile | semantic gap.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-pressure-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('operational-pressure');
const PORT = process.env.PORT || '3451';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();

const DATA_FILES = [
  'agents.json', 'events.jsonl', 'groups.json', 'logs.json', 'operation-history.json',
  'permissions.json', 'runs.json', 'tickets.json', 'users.json', 'workflows.json'
];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (file === 'events.jsonl') fs.writeFileSync(dst, '');
  else fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function readEvents() {
  const fp = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function assert(condition, message) { if (!condition) throw new Error(message); }

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(a => a.id || 0)) + 1,
    name: `PressureAgent-${STAMP}`,
    type: 'agent', provider: 'openai', model: 'gpt-4.1-mini',
    apiKey: 'test-key-pressure', createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(DATA_DIR, 'agents.json'), JSON.stringify([...agents.filter(a => a.name !== agent.name), agent], null, 2));
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `pressure-openai-${process.pid}-${STAMP}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'fake-pressure']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

const PLANS = new Map();

// 1. organize invoices by year (2 files, 2 years)
PLANS.set('invoices', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Creating year folders', actions: [
    { operation: 'createFolder', args: { path: '2024' } },
    { operation: 'createFolder', args: { path: '2025' } }
  ], complete: false },
  { message: 'Moving invoices to year folders', actions: [
    { operation: 'renamePath', args: { path: 'inv-01.txt', nextPath: '2024/inv-01.txt' } },
    { operation: 'renamePath', args: { path: 'inv-02.txt', nextPath: '2025/inv-02.txt' } }
  ], complete: false },
  { message: 'Organization complete', actions: [], complete: true }
]);

// 2. archive logs (3 logs to archive/)
PLANS.set('archive', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Creating archive and moving first log', actions: [
    { operation: 'createFolder', args: { path: 'archive' } },
    { operation: 'renamePath', args: { path: 'app.log', nextPath: 'archive/app.log' } }
  ], complete: false },
  { message: 'Moving remaining logs', actions: [
    { operation: 'renamePath', args: { path: 'error.log', nextPath: 'archive/error.log' } },
    { operation: 'renamePath', args: { path: 'access.log', nextPath: 'archive/access.log' } }
  ], complete: false },
  { message: 'Archive complete', actions: [], complete: true }
]);

// 3. normalize filenames (2 files with spaces)
PLANS.set('normalize', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Normalizing filenames', actions: [
    { operation: 'renamePath', args: { path: 'File One.txt', nextPath: 'file_one.txt' } },
    { operation: 'renamePath', args: { path: 'File Two.txt', nextPath: 'file_two.txt' } }
  ], complete: false },
  { message: 'Normalization complete', actions: [], complete: true }
]);

// 4. move PDFs by prefix (2 PDFs to reports/)
PLANS.set('pdfs', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Creating reports folder and moving first PDF', actions: [
    { operation: 'createFolder', args: { path: 'reports' } },
    { operation: 'renamePath', args: { path: 'report-Q1.pdf', nextPath: 'reports/report-Q1.pdf' } }
  ], complete: false },
  { message: 'Moving remaining PDF', actions: [
    { operation: 'renamePath', args: { path: 'report-Q2.pdf', nextPath: 'reports/report-Q2.pdf' } }
  ], complete: false },
  { message: 'Move complete', actions: [], complete: true }
]);

// 5. cleanup empty folders (2 empty folders)
PLANS.set('cleanup', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Deleting empty folders', actions: [
    { operation: 'deletePath', args: { path: 'empty-a' } },
    { operation: 'deletePath', args: { path: 'empty-b' } }
  ], complete: false },
  { message: 'Cleanup complete', actions: [], complete: true }
]);

// 6. create inventory report (list + read, then write)
PLANS.set('inventory', [
  { message: 'Listing and reading items', actions: [
    { operation: 'listDirectory', args: { path: '' } },
    { operation: 'readFile', args: { path: 'item-a.txt' } }
  ], complete: false },
  { message: 'Writing inventory report', actions: [
    { operation: 'writeFile', args: { path: 'inventory.md', content: '# Inventory\\n\\n- item-a\\n- item-b\\n' } }
  ], complete: false },
  { message: 'Report complete', actions: [], complete: true }
]);

// 7. consolidate extension groups (1 txt to txt/, 1 md to md/)
PLANS.set('extensions', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Creating type folders', actions: [
    { operation: 'createFolder', args: { path: 'txt' } },
    { operation: 'createFolder', args: { path: 'md' } }
  ], complete: false },
  { message: 'Moving files by extension', actions: [
    { operation: 'renamePath', args: { path: 'notes.txt', nextPath: 'txt/notes.txt' } },
    { operation: 'renamePath', args: { path: 'notes.md', nextPath: 'md/notes.md' } }
  ], complete: false },
  { message: 'Consolidation complete', actions: [], complete: true }
]);

// 8. bounded document rewrite (overwrite one file)
PLANS.set('rewrite', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Rewriting document', actions: [
    { operation: 'writeFile', args: { path: 'document.md', content: '# Updated Document\\n\\nNew content here.\\n' } }
  ], complete: false },
  { message: 'Rewrite complete', actions: [], complete: true }
]);

// 9. bounded code refactor (read then rewrite)
PLANS.set('refactor', [
  { message: 'Listing and reading code', actions: [
    { operation: 'listDirectory', args: { path: '' } },
    { operation: 'readFile', args: { path: 'code.js' } }
  ], complete: false },
  { message: 'Refactoring code', actions: [
    { operation: 'writeFile', args: { path: 'code.js', content: 'function renamedFunc() { return 42; }\\n' } }
  ], complete: false },
  { message: 'Refactor complete', actions: [], complete: true }
]);

// 10. media folder normalization (1 jpg + 1 png to media/)
PLANS.set('media', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Creating media folder and moving first file', actions: [
    { operation: 'createFolder', args: { path: 'media' } },
    { operation: 'renamePath', args: { path: 'photo.jpg', nextPath: 'media/photo.jpg' } }
  ], complete: false },
  { message: 'Moving remaining file', actions: [
    { operation: 'renamePath', args: { path: 'icon.png', nextPath: 'media/icon.png' } }
  ], complete: false },
  { message: 'Normalization complete', actions: [], complete: true }
]);

const RESPONSE_INDEX = new Map();

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  let planKey = null;
  if (combined.includes('invoices by year')) planKey = 'invoices';
  else if (combined.includes('archive logs')) planKey = 'archive';
  else if (combined.includes('normalize filenames')) planKey = 'normalize';
  else if (combined.includes('move PDFs')) planKey = 'pdfs';
  else if (combined.includes('cleanup empty')) planKey = 'cleanup';
  else if (combined.includes('inventory report')) planKey = 'inventory';
  else if (combined.includes('consolidate extension')) planKey = 'extensions';
  else if (combined.includes('document rewrite')) planKey = 'rewrite';
  else if (combined.includes('code refactor')) planKey = 'refactor';
  else if (combined.includes('media folder')) planKey = 'media';

  if (!planKey) return okResponse({ message: 'No plan matched', actions: [], complete: true });
  const index = RESPONSE_INDEX.get(planKey) || 0;
  const plan = PLANS.get(planKey);
  const response = plan[index] || { message: 'Done', actions: [], complete: true };
  RESPONSE_INDEX.set(planKey, index + 1);
  return okResponse(response);
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(response.statusCode === 302, `Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

async function createAgentTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
  });
  assert(response.statusCode === 302, `Agent ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  return readJson('tickets.json').find(t => t.objective === objective);
}

async function waitForTerminalRun(ticketId) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const runs = readJson('runs.json');
    const run = runs.find(r => r.ticketId === ticketId && (r.status === 'completed' || r.status === 'failed' || r.status === 'interrupted'));
    if (run) return run;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

// ── Workspace fixtures ────────────────────────────────────────────

function setupWorkspaceFixture(caseName) {
  fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

  if (caseName === 'invoices') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'inv-01.txt'), 'inv1');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'inv-02.txt'), 'inv2');
  } else if (caseName === 'archive') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'app.log'), 'app');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'error.log'), 'error');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'access.log'), 'access');
  } else if (caseName === 'normalize') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'File One.txt'), 'one');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'File Two.txt'), 'two');
  } else if (caseName === 'pdfs') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'report-Q1.pdf'), 'q1');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'report-Q2.pdf'), 'q2');
  } else if (caseName === 'cleanup') {
    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'empty-a'));
    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'empty-b'));
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'keep.txt'), 'keep');
  } else if (caseName === 'inventory') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'item-a.txt'), 'a');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'item-b.txt'), 'b');
  } else if (caseName === 'extensions') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'notes.txt'), 'txt notes');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'notes.md'), 'md notes');
  } else if (caseName === 'rewrite') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'document.md'), '# Old');
  } else if (caseName === 'refactor') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'code.js'), 'function oldFunc() { return 1; }');
  } else if (caseName === 'media') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'photo.jpg'), 'jpg');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'icon.png'), 'png');
  }
}

function assertWorkspaceState(caseName) {
  if (caseName === 'invoices') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, '2024', 'inv-01.txt')), '2024/inv-01.txt should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, '2025', 'inv-02.txt')), '2025/inv-02.txt should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'inv-01.txt')), 'inv-01.txt should no longer exist at root');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'inv-02.txt')), 'inv-02.txt should no longer exist at root');
  } else if (caseName === 'archive') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'archive', 'app.log')), 'archive/app.log should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'archive', 'error.log')), 'archive/error.log should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'archive', 'access.log')), 'archive/access.log should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'app.log')), 'app.log should no longer exist at root');
  } else if (caseName === 'normalize') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'file_one.txt')), 'file_one.txt should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'file_two.txt')), 'file_two.txt should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'File One.txt')), 'File One.txt should no longer exist');
  } else if (caseName === 'pdfs') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'reports', 'report-Q1.pdf')), 'reports/report-Q1.pdf should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'reports', 'report-Q2.pdf')), 'reports/report-Q2.pdf should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'report-Q1.pdf')), 'report-Q1.pdf should no longer exist at root');
  } else if (caseName === 'cleanup') {
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'empty-a')), 'empty-a should be deleted');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'empty-b')), 'empty-b should be deleted');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'keep.txt')), 'keep.txt should still exist');
  } else if (caseName === 'inventory') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'inventory.md')), 'inventory.md should exist');
    const content = fs.readFileSync(path.join(WORKSPACE_ROOT, 'inventory.md'), 'utf8');
    assert(content.includes('Inventory'), 'inventory should contain expected content');
  } else if (caseName === 'extensions') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'txt', 'notes.txt')), 'txt/notes.txt should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'md', 'notes.md')), 'md/notes.md should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'notes.txt')), 'notes.txt should no longer exist at root');
  } else if (caseName === 'rewrite') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'document.md')), 'document.md should exist');
    const content = fs.readFileSync(path.join(WORKSPACE_ROOT, 'document.md'), 'utf8');
    assert(content.includes('Updated Document'), 'document should contain new content');
  } else if (caseName === 'refactor') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'code.js')), 'code.js should exist');
    const content = fs.readFileSync(path.join(WORKSPACE_ROOT, 'code.js'), 'utf8');
    assert(content.includes('renamedFunc'), 'code should contain renamed function');
  } else if (caseName === 'media') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'media', 'photo.jpg')), 'media/photo.jpg should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'media', 'icon.png')), 'media/icon.png should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'photo.jpg')), 'photo.jpg should no longer exist at root');
  }
}

// ── Contract validation ──────────────────────────────────────────

function validateContract(run, events, logs, caseName) {
  const runEvents = events.filter(e => e.runId === run.id);
  const runLogs = logs.filter(l => l.runId === run.id);
  const modelRequests = runLogs.filter(l => l.type === 'model:request').length;
  const workspaceOps = runEvents.filter(e => e.type === 'workspace.operation').length;
  const verificationEvents = runEvents.filter(e => e.type === 'batch.verification_failed').length;
  const phaseViolations = runEvents.filter(e => e.type === 'execution.phase_violation').length;
  const noProgressEvents = runEvents.filter(e => e.type === 'run.limit_exceeded' && e.payload && e.payload.failureKind === 'no_progress').length;

  let failureReason = null;
  if (run.status === 'failed') {
    const failLog = runLogs.find(l => l.type === 'run:failed');
    if (failLog) failureReason = failLog.message;
    else {
      const lastRelevant = runLogs.filter(l => l.type !== 'model:request' && l.type !== 'model:response').pop();
      if (lastRelevant) failureReason = `${lastRelevant.type}: ${lastRelevant.message}`;
    }
  }

  return {
    caseName,
    runId: run.id,
    status: run.status,
    modelRequests,
    workspaceOps,
    verificationEvents,
    phaseViolations,
    noProgressEvents,
    failureReason,
    passed: run.status === 'completed' && phaseViolations === 0 && noProgressEvents === 0 && verificationEvents === 0
  };
}

// ── Main ─────────────────────────────────────────────────────────

const CASES = [
  { name: 'invoices', objective: 'organize invoices by year: Create year folders and move invoice files into the correct year folder.' },
  { name: 'archive', objective: 'archive logs: Create an archive folder and move all .log files into it.' },
  { name: 'normalize', objective: 'normalize filenames: Rename files with spaces to use underscores.' },
  { name: 'pdfs', objective: 'move PDFs by prefix: Move all files starting with "report-" into a reports folder.' },
  { name: 'cleanup', objective: 'cleanup empty folders: Delete all empty folders but keep files.' },
  { name: 'inventory', objective: 'create inventory report: List workspace contents and write an inventory.md file.' },
  { name: 'extensions', objective: 'consolidate extension groups: Move .txt files into txt/ and .md files into md/.' },
  { name: 'rewrite', objective: 'bounded document rewrite: Rewrite document.md with updated content.' },
  { name: 'refactor', objective: 'bounded code refactor: Rename the function in code.js.' },
  { name: 'media', objective: 'media folder normalization: Move image files into a media folder.' }
];

async function main() {
  console.log('Operational Pressure Validation');
  console.log('='.repeat(70));

  const preloadPath = createFakeOpenAIPreload();
  const server = spawn('node', ['--require', preloadPath, path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, WORKSPACE_ROOT, NODE_ENV: 'test' },
    stdio: 'ignore'
  });

  let allPassed = true;
  const results = [];

  try {
    await waitForReady();
    const cookie = await login();
    const agent = seedAgent();

    for (const testCase of CASES) {
      console.log(`\nCase: ${testCase.name}`);
      console.log('-'.repeat(70));

      setupWorkspaceFixture(testCase.name);

      let run;
      let contract;
      let error = null;

      try {
        const ticket = await createAgentTicket(cookie, agent, testCase.objective);
        run = await waitForTerminalRun(ticket.id);
        const events = readEvents();
        const logs = readJson('logs.json');
        contract = validateContract(run, events, logs, testCase.name);
        assertWorkspaceState(testCase.name);
      } catch (err) {
        error = err.message;
        contract = { caseName: testCase.name, status: run ? run.status : 'unknown', passed: false, error };
        allPassed = false;
      }

      results.push(contract);

      const display = (v) => v === undefined || v === null ? 'N/A' : v;
      console.log(`  Status:       ${contract.status}`);
      console.log(`  Model reqs:   ${display(contract.modelRequests)}`);
      console.log(`  Workspace ops: ${display(contract.workspaceOps)}`);
      console.log(`  Verif fails:  ${display(contract.verificationEvents)}`);
      console.log(`  Phase viol:   ${display(contract.phaseViolations)}`);
      console.log(`  No-progress:  ${display(contract.noProgressEvents)}`);
      if (contract.failureReason) console.log(`  Failure:      ${contract.failureReason.slice(0, 120)}`);
      console.log(`  Workspace:    ${error ? 'FAIL (' + error + ')' : 'PASS'}`);
      console.log(`  Contract:     ${contract.passed ? 'PASS' : 'FAIL'}`);

      if (!contract.passed) allPassed = false;
    }

    // Generate report
    const report = generateReport(results);
    fs.writeFileSync(path.join(ROOT, 'docs', 'OPERATIONAL_PRESSURE_VALIDATION.md'), report);

    console.log('\n' + '='.repeat(70));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(allPassed ? 'Result: PASS' : 'Result: FAIL');
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    server.kill('SIGTERM');
    try { removeTempWorkspaceRoot(WORKSPACE_ROOT); } catch (e) {}
    try { fs.unlinkSync(preloadPath); } catch (e) {}
  }
}

function generateReport(results) {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  const lines = [
    '# Operational Pressure Validation Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `Total workloads: ${results.length}`,
    `Passed: ${passed}`,
    `Failed: ${failed}`,
    '',
    '| Case | Status | Model Requests | Workspace Ops | Verif Fails | Phase Viol | No-Progress | Contract |',
    '|------|--------|---------------|--------------|-------------|-----------|-------------|----------|'
  ];

  for (const r of results) {
    const d = (v) => v === undefined || v === null ? 'N/A' : v;
    lines.push(`| ${r.caseName} | ${r.status} | ${d(r.modelRequests)} | ${d(r.workspaceOps)} | ${d(r.verificationEvents)} | ${d(r.phaseViolations)} | ${d(r.noProgressEvents)} | ${r.passed ? 'PASS' : 'FAIL'} |`);
  }

  lines.push('');

  // Failure analysis
  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    lines.push('## Failure Analysis');
    lines.push('');
    for (const f of failures) {
      lines.push(`### ${f.caseName}`);
      lines.push('');
      lines.push(`- **Status:** ${f.status}`);
      if (f.failureReason) lines.push(`- **Failure reason:** ${f.failureReason}`);
      if (f.error) lines.push(`- **Workspace error:** ${f.error}`);

      // Categorization
      let category = 'semantic gap';
      if (f.failureReason && (f.failureReason.includes('exceeded execution step limit') || f.failureReason.includes('exceeded listDirectory limit'))) {
        category = 'workload design';
      } else if (f.failureReason && f.failureReason.includes('no_progress')) {
        category = 'prompt/profile';
      } else if (f.failureReason && (f.failureReason.includes('MUTATION_CONFLICT') || f.failureReason.includes('mixed_phase'))) {
        category = 'semantic gap';
      }
      lines.push(`- **Category:** ${category}`);
      lines.push('');
    }
  }

  // Recurring patterns
  lines.push('## Recurring Operational Patterns');
  lines.push('');

  const allCompleted = results.filter(r => r.status === 'completed');
  const avgModelRequests = allCompleted.length > 0 ? (allCompleted.reduce((s, r) => s + r.modelRequests, 0) / allCompleted.length).toFixed(1) : 'N/A';
  const avgWorkspaceOps = allCompleted.length > 0 ? (allCompleted.reduce((s, r) => s + r.workspaceOps, 0) / allCompleted.length).toFixed(1) : 'N/A';

  lines.push(`- **Average model requests (completed):** ${avgModelRequests}`);
  lines.push(`- **Average workspace ops (completed):** ${avgWorkspaceOps}`);
  lines.push(`- **Phase violations:** ${results.reduce((s, r) => s + (r.phaseViolations || 0), 0)}`);
  lines.push(`- **No-progress events:** ${results.reduce((s, r) => s + (r.noProgressEvents || 0), 0)}`);
  lines.push(`- **Verification failures:** ${results.reduce((s, r) => s + (r.verificationEvents || 0), 0)}`);
  lines.push('');

  const inspectionOnlyRuns = results.filter(r => r.status === 'completed' && r.modelRequests <= 2);
  const batchedRuns = results.filter(r => r.status === 'completed' && r.modelRequests > 2);
  lines.push(`- **Single-response completions:** ${inspectionOnlyRuns.length}`);
  lines.push(`- **Multi-response completions:** ${batchedRuns.length}`);
  lines.push('');

  // Conclusion
  lines.push('## Conclusion');
  lines.push('');
  if (failed === 0) {
    lines.push('All workloads passed within existing runtime limits. The substrate generalizes across diverse workspace tasks without per-task semantic changes.');
  } else {
    lines.push(`${passed}/${results.length} workloads passed. Failures are categorized above.`);
    const designFails = failures.filter(f => f.failureReason && (f.failureReason.includes('exceeded execution step limit') || f.failureReason.includes('exceeded listDirectory limit'))).length;
    const promptFails = failures.filter(f => f.failureReason && f.failureReason.includes('no_progress')).length;
    const semanticFails = failures.length - designFails - promptFails;
    lines.push(`- Workload design failures: ${designFails}`);
    lines.push(`- Prompt/profile failures: ${promptFails}`);
    lines.push(`- Semantic gaps: ${semanticFails}`);
  }
  lines.push('');

  return lines.join('\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
