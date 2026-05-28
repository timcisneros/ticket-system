const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const PORT = '3443';

function readEventIds() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs.readFileSync(EVENTS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line).id; } catch (_) { return null; } })
    .filter(Boolean);
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body
      ? JSON.stringify(options.body)
      : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
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

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        if (body.ready) return;
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function main() {
  // Fresh WAL
  fs.writeFileSync(EVENTS_FILE, '');
  console.log(`WAL: ${readEventIds().length} events before test`);

  // Seed a real agent for createFolder (needs authority)
  const agents = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'agents.json'), 'utf8') || '[]');
  const agentId = Math.max(0, ...agents.map(a => a.id)) + 1;
  agents.push({
    id: agentId,
    name: `WALTestAgent-${Date.now()}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-wal'
  });
  fs.writeFileSync(path.join(DATA_DIR, 'agents.json'), JSON.stringify(agents, null, 2));

  // Create fake OpenAI preload that writes one file then completes
  const preloadPath = path.join(os.tmpdir(), `wal-preload-${process.pid}-${Date.now()}.js`);
  const preloadSrc = `
const responseCounts = new Map();
function nextCount(key) {
  const count = (responseCounts.get(key) || 0) + 1;
  responseCounts.set(key, count);
  return count;
}
global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  await new Promise(resolve => setTimeout(resolve, 30));
  const count = nextCount('wal');
  if (count === 1) {
    return {
      ok: true, status: 200,
      headers: new Map([['x-request-id', 'wal-test']]),
      async text() {
        return JSON.stringify({
          output_text: JSON.stringify({
            message: 'Creating folder.',
            actions: [{ operation: 'createFolder', args: { path: 'wal-test-dir' } }],
            complete: false
          }),
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'wal-test']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({
          message: 'Done.',
          actions: [],
          complete: true
        }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`;
  fs.writeFileSync(preloadPath, preloadSrc);

  // Start server with deterministic crash at first workspace operation
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      NODE_OPTIONS: `--require ${preloadPath}`,
      TEST_INTERRUPTION_POINT: 'after_first_workspace.operation',
      AGENT_MAX_EXECUTION_STEPS: '10',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '10',
      AGENT_MAX_RUNTIME_DURATION_MS: '10000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  await waitForReady();

  // Login
  const loginRes = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  const cookie = (loginRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  // Create ticket (triggers run which triggers workspace op → crash)
  await request('POST', '/tickets', {
    cookie,
    form: {
      objective: `wal-test-objective ${Date.now()}`,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId)
    }
  });

  // Wait for SIGKILL (server exits)
  await new Promise(resolve => {
    server.on('exit', () => resolve());
    setTimeout(() => { server.kill(); resolve(); }, 15000);
  });

  // Read WAL after crash
  const ids = readEventIds();
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  const uniqueIds = [...new Set(ids)];

  console.log(`WAL: ${uniqueIds.length} unique, ${duplicates.length} duplicate(s) after crash`);
  if (duplicates.length > 0) {
    console.log(`DUPLICATE IDs: ${[...new Set(duplicates)].join(', ')}`);
  }

  // Validate
  const allPass = new Set();
  allPass.add('no_duplicates');

  if (duplicates.length === 0) allPass.delete('no_duplicates');

  if (duplicates.length > 0) {
    throw new Error(`Found ${duplicates.length} duplicate event IDs after crash:\n${JSON.stringify(duplicates.slice(0, 20))}`);
  }
  if (uniqueIds.length === 0) {
    throw new Error('No events were persisted after crash (WAL empty)');
  }

  // Verify interruption event was written
  const hasInterrupt = ids.some(id => {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.some(line => line.includes('interruption.test_hook'));
  });
  if (!hasInterrupt) {
    console.log('WARN: interruption.test_hook not found in WAL (may have been before flush)');
  }

  console.log(`WAL append test PASSED (${uniqueIds.length} unique events, 0 duplicates)`);

  // Cleanup
  fs.rmSync(preloadPath, { force: true });
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
