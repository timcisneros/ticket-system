const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'postcondition-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('postcondition');
const PORT = process.env.PORT || '3441';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const DATA_FILES = ['agents.json', 'allocation-plans.json', 'groups.json', 'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json', 'users.json'];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else {
    fs.writeFileSync(dst, '[]');
  }
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  if (file !== 'runs.json' || !Array.isArray(value)) return value;
  return value.map(hydrateRunReplaySnapshot);
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

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
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

async function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
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
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id)) + 1,
    name: `PostconditionAgent-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-postcondition',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `postcondition-openai-${process.pid}-${Date.now()}.js`);
  const source = [
    "const responseCounts = new Map();",
    "",
    "function nextCount(key) {",
    "  const count = (responseCounts.get(key) || 0) + 1;",
    "  responseCounts.set(key, count);",
    "  return count;",
    "}",
    "",
    "function okResponse(plan) {",
    "  return {",
    "    ok: true,",
    "    status: 200,",
    "    headers: new Map([['x-request-id', 'fake-postcondition-request']]),",
    "    async text() {",
    "      return JSON.stringify({",
    "        output_text: JSON.stringify(plan),",
    "        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }",
    "      });",
    "    }",
    "  };",
    "}",
    "",
    "global.fetch = async function(url, options = {}) {",
    "  const body = JSON.parse(options.body || '{}');",
    "  const input = Array.isArray(body.input) ? body.input : [];",
    "  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');",
    "",
    "  await new Promise(resolve => setTimeout(resolve, 50));",
    "",
    "  if (combined.includes('postcondition-create-folder-file')) {",
    "    const count = nextCount('create-folder-file');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating folder and file.',",
    "        actions: [",
    "          { operation: 'createFolder', args: { path: 'pc-folder' } },",
    "          { operation: 'writeFile', args: { path: 'pc-folder/file.txt', content: 'hello' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Ensuring folder and file exist.',",
    "      actions: [",
    "        { operation: 'createFolder', args: { path: 'pc-folder' } },",
    "        { operation: 'writeFile', args: { path: 'pc-folder/file.txt', content: 'hello' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-repeated-write')) {",
    "    const count = nextCount('repeated-write');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Writing file.',",
    "        actions: [",
    "          { operation: 'writeFile', args: { path: 'pc-file.txt', content: 'same-content' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Ensuring file exists.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'pc-file.txt', content: 'same-content' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-failed-op')) {",
    "    const count = nextCount('failed-op');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating folder then overwriting protected file.',",
    "        actions: [",
    "          { operation: 'createFolder', args: { path: 'pc-folder-fail' } },",
    "          { operation: 'writeFile', args: { path: '.env', content: 'should-fail' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Trying again.',",
    "      actions: [",
    "        { operation: 'createFolder', args: { path: 'pc-folder-fail' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-mixed-read')) {",
    "    return okResponse({",
    "      message: 'Listing then writing.',",
    "      actions: [",
    "        { operation: 'listDirectory', args: { path: '' } },",
    "        { operation: 'writeFile', args: { path: 'pc-mixed.txt', content: 'mixed' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-non-obvious')) {",
    "    const count = nextCount('non-obvious');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating folder A then folder B.',",
    "        actions: [",
    "          { operation: 'createFolder', args: { path: 'pc-folder-a' } },",
    "          { operation: 'createFolder', args: { path: 'pc-folder-b' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Ensuring both exist.',",
    "      actions: [",
    "        { operation: 'createFolder', args: { path: 'pc-folder-a' } },",
    "        { operation: 'createFolder', args: { path: 'pc-folder-b' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  return okResponse({ message: 'default', actions: [], complete: true });",
    "};",
    ""
  ].join('\n');

  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function startServer(preloadPath, env) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      NODE_OPTIONS: `--require ${preloadPath}`,
      WORKSPACE_ROOT,
      DATA_DIR,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  server.stderr.on('data', chunk => process.stderr.write(String(chunk)));
  return server;
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
    throw new Error(`Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  }
  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Ticket was not persisted');
  return ticket;
}

async function waitForTerminalRun(ticketId, expectedStatus) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    if (runs.length >= 1 && runs[0].status === expectedStatus && runs[0].replaySnapshot && runs[0].replaySnapshot.terminalStatus === expectedStatus) {
      return runs[0];
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runScenario(preloadPath, agent, objective, envOverrides, expectations) {
  let server = null;
  try {
    server = startServer(preloadPath, envOverrides);
    await waitForReady();
    const cookie = await login();
    const ticket = await createAssignedTicket(cookie, agent.id, objective);
    const run = await waitForTerminalRun(ticket.id, expectations.expectedStatus);
    const snapshot = run.replaySnapshot;

    assert(run.status === expectations.expectedStatus, `Run ${run.id} status ${run.status} !== ${expectations.expectedStatus}`);

    if (expectations.expectPostconditionCompleted) {
      assert(snapshot.events.some(e => e.type === 'run:postcondition_completed'), `Missing run:postcondition_completed event for run ${run.id}`);
      const operationalOutcome = snapshot.events.some(e => e.type === 'run:postcondition_completed') ? 'completed_with_verified_postcondition' : null;
      assert(operationalOutcome === 'completed_with_verified_postcondition', `Run ${run.id} did not classify as postcondition completed`);
    }

    if (expectations.expectNoPostcondition) {
      assert(!snapshot.events.some(e => e.type === 'run:postcondition_completed'), `Unexpected run:postcondition_completed event for run ${run.id}`);
    }

    if (expectations.expectStepsAtMost !== undefined) {
      assert(snapshot.parsedModelPlans.length <= expectations.expectStepsAtMost, `Run ${run.id} used ${snapshot.parsedModelPlans.length} steps, expected at most ${expectations.expectStepsAtMost}`);
    }

    if (expectations.expectStepsAtLeast !== undefined) {
      assert(snapshot.parsedModelPlans.length >= expectations.expectStepsAtLeast, `Run ${run.id} used ${snapshot.parsedModelPlans.length} steps, expected at least ${expectations.expectStepsAtLeast}`);
    }

    return run;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
  }
}

async function main() {
  const preloadPath = createFakeOpenAIPreload();
  const agent = seedAgent();

  try {
    // 1. folder+file creation finalizes automatically once satisfied
    await runScenario(
      preloadPath,
      agent,
      `postcondition-create-folder-file ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 2. repeated identical write does not continue forever
    await runScenario(
      preloadPath,
      agent,
      `postcondition-repeated-write ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 3. provider timeout avoided after verified completion (low step limit, but still completes)
    await runScenario(
      preloadPath,
      agent,
      `postcondition-repeated-write timeout-avoided ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '2000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 4. blocked/failed operations do not trigger completion
    await runScenario(
      preloadPath,
      agent,
      `postcondition-failed-op ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true
      }
    );

    // 5. non-obvious tasks (mixed read + write) still require model completion
    await runScenario(
      preloadPath,
      agent,
      `postcondition-mixed-read ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        expectStepsAtLeast: 2
      }
    );

    // 6. once all meaningful mutations are done, redundant no-op batch auto-completes
    await runScenario(
      preloadPath,
      agent,
      `postcondition-non-obvious ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    console.log(JSON.stringify({
      folderFileAutoComplete: true,
      repeatedWriteAutoComplete: true,
      timeoutAvoided: true,
      failedOpNoAutoComplete: true,
      mixedReadNoAutoComplete: true,
      partialMutationHandled: true
    }));
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(preloadPath, { force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
