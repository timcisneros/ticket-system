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
const DATA_FILES = ['agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json', 'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json', 'users.json', 'workflows.json'];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (file === 'events.jsonl') {
    fs.writeFileSync(dst, '');
  } else if (fs.existsSync(src)) {
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

async function waitForEvent(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const event = events.find(predicate);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}

async function waitForStoredRun(runId, predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = readJson('runs.json').find(item => item.id === runId);
    if (run && predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return readJson('runs.json').find(item => item.id === runId) || null;
}

async function waitForStoredTicket(ticketId, predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ticket = readJson('tickets.json').find(item => item.id === ticketId);
    if (ticket && predicate(ticket)) return ticket;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return readJson('tickets.json').find(item => item.id === ticketId) || null;
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

function seedMikeExecutor() {
  const agents = readJson('agents.json');
  const existing = agents.find(agent => agent.name === 'Mike');
  if (existing) return existing;
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id)) + 1,
    name: 'Mike',
    type: 'agent',
    provider: 'ollama',
    model: 'gemma3:latest',
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
    "      complete: true",
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
    "  if (combined.includes('workspace-objective-satisfied')) {",
    "    return okResponse({",
    "      message: 'Writing requested note.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'workspace-objective-note.md', content: 'workspace objective satisfied' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workspace-root-objective-satisfied')) {",
    "    return okResponse({",
    "      message: 'Writing requested workspace-root note.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'mike-repair-recommendation.md', content: 'workspace-root objective satisfied' } }",
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
    "  if (combined.includes('workflow-draft-valid')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraft', args: { workflow: {",
    "          id: 'agent-draft-valid',",
    "          name: 'Agent draft valid',",
    "          inputSchema: { path: 'string', content: 'string' },",
    "          actions: [",
    "            { id: 'write', action: 'writeFile', input: { path: '{{workflow.input.path}}', content: '{{workflow.input.content}}' }, next: 'done' },",
    "            { id: 'done', action: 'stop', input: { result: { path: '{{workflow.input.path}}' } } }",
    "          ],",
    "          postconditions: [",
    "            { id: 'file-exists', type: 'fileExists', path: '{{workflow.input.path}}' }",
    "          ]",
    "        } } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-intent-numeric-id')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft intent with numeric id.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraftIntent', args: {",
    "          id: '12345',",
    "          name: 'Numeric id draft intent',",
    "          writes: [",
    "            { path: 'numeric-intent-summary.txt', content: 'numeric intent summary content' }",
    "          ],",
    "          postconditions: [",
    "            { type: 'fileExists', path: 'numeric-intent-summary.txt' },",
    "            { type: 'fileContains', path: 'numeric-intent-summary.txt', contains: 'numeric intent summary content' }",
    "          ]",
    "        } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-intent')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft from intent.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraftIntent', args: {",
    "          id: 'agent-draft-intent',",
    "          name: 'Agent draft intent',",
    "          writes: [",
    "            { path: 'intent-summary.txt', content: 'intent summary content' }",
    "          ],",
    "          postconditions: [",
    "            { type: 'fileExists', path: 'intent-summary.txt' },",
    "            { type: 'fileContains', path: 'intent-summary.txt', contains: 'intent summary content' }",
    "          ]",
    "        } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-branching-unsupported')) {",
    "    return okResponse({",
    "      message: 'Branching workflow drafts are not available to normal agents with the allowed operations.',",
    "      actions: [],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('handoff-valid')) {",
    "    return okResponse({",
    "      message: 'Creating bounded handoff task for Mike.',",
    "      actions: [",
    "        { operation: 'createHandoffTask', args: {",
    "          executor: 'Mike',",
    "          operation: 'writeFile',",
    "          args: { path: 'handoff-note.md', content: 'handoff content' }",
    "        } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('handoff-invalid-path')) {",
    "    return okResponse({",
    "      message: 'Creating invalid handoff task.',",
    "      actions: [",
    "        { operation: 'createHandoffTask', args: {",
    "          executor: 'Mike',",
    "          operation: 'writeFile',",
    "          args: { path: '/tmp/handoff-note.md', content: 'bad path' }",
    "        } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('handoff-unknown-executor')) {",
    "    return okResponse({",
    "      message: 'Creating handoff task for unknown executor.',",
    "      actions: [",
    "        { operation: 'createHandoffTask', args: {",
    "          executor: 'MissingAgent',",
    "          operation: 'writeFile',",
    "          args: { path: 'handoff-note.md', content: 'unknown executor' }",
    "        } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-invalid')) {",
    "    return okResponse({",
    "      message: 'Creating invalid workflow draft.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraft', args: { workflow: {",
    "          id: 'agent-draft-invalid',",
    "          name: 'Agent draft invalid',",
    "          inputSchema: { path: 'string' },",
    "          actions: [",
    "            { id: 'write', action: 'writeFile', input: { path: '{{workflow.input.path}}', content: 'x' }, next: 'done' },",
    "            { id: 'done', action: 'stop', input: {} }",
    "          ]",
    "        } } }",
    "      ],",
    "      complete: true",
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
      AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1',
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

    if (typeof expectations.verify === 'function') {
      await expectations.verify({ run, ticket, snapshot, cookie });
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
  const mike = seedMikeExecutor();

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

    // 6. direct write objectives complete from successful mutation evidence
    await runScenario(
      preloadPath,
      agent,
      `workspace-objective-satisfied write workspace-objective-note.md ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(snapshot.parsedModelPlans.length === 1, 'Workspace objective complete:false should not trigger a second model turn');
          assert(snapshot.parsedModelPlans[0].complete === false, 'Regression should cover direct workspace complete:false');
          assert(snapshot.events.some(event => event.type === 'workspace.objective_satisfied'), 'Replay should record workspace objective satisfaction');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed', 'Ticket should complete after successful direct workspace objective');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should still be recorded');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should still be recorded');
          assert(storedRun.runEvaluation.efficiency.modelResponses === 1, 'Run evaluation should record one model response');
          assert(storedRun.runConsequence.created.some(item => item.path === 'workspace-objective-note.md'), 'Run consequence should record created note');
        }
      }
    );

    // 7. workspace-root-prefixed objective paths match runtime-relative write paths
    await runScenario(
      preloadPath,
      agent,
      `workspace-root-objective-satisfied write workspace-root/mike-repair-recommendation.md ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        verify: async ({ run, snapshot }) => {
          assert(snapshot.parsedModelPlans.length === 1, 'workspace-root objective should not trigger a second model turn');
          assert(snapshot.parsedModelPlans[0].complete === false, 'Regression should cover complete:false with workspace-root objective path');
          assert(snapshot.events.some(event => event.type === 'workspace.objective_satisfied'), 'Replay should record workspace objective satisfaction');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed', 'Ticket should complete after workspace-root path objective is satisfied');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should be recorded for workspace-root path objective');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should be recorded for workspace-root path objective');
          assert(storedRun.runEvaluation.efficiency.modelResponses === 1, 'Run evaluation should record one model response');
          assert(storedRun.runConsequence.created.some(item => item.path === 'mike-repair-recommendation.md'), 'Run consequence should record created recommendation file');
        }
      }
    );

    // 8. once all meaningful mutations are done, redundant no-op batch auto-completes
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

    // 8. agent-created workflow drafts are saved disabled and exposed in workflow data
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-valid ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot, cookie }) => {
          const draft = readJson('workflows.json').find(workflow => workflow.id === 'agent-draft-valid');
          assert(draft, 'Agent-created workflow draft was not saved');
          assert(draft.enabled === false, 'Agent-created workflow draft should be disabled');
          assert(draft.createdByType === 'agent', 'Agent-created workflow draft should persist createdByType');
          assert(draft.createdByAgentId === agent.id, 'Agent-created workflow draft should persist createdByAgentId');
          assert(draft.createdByRunId === run.id, 'Agent-created workflow draft should persist createdByRunId');
          assert(Array.isArray(draft.postconditions) && draft.postconditions.length === 1, 'Agent-created mutating workflow draft should persist postconditions');
          assert(snapshot.workflowDrafts.some(item => item.workflowId === 'agent-draft-valid' && item.enabled === false), 'Replay should record workflow draft creation');
          const draftEvent = await waitForEvent(event => event.type === 'workflow.draft_created' && event.runId === run.id);
          assert(draftEvent, 'workflow.draft_created event missing');
          const enableResponse = await request('POST', '/admin/workflows/agent-draft-valid', {
            cookie,
            form: {
              definition: JSON.stringify({
                ...draft,
                enabled: true,
                updatedAt: new Date().toISOString()
              }, null, 2)
            }
          });
          assert(enableResponse.statusCode === 302, `Operator enable workflow draft returned HTTP ${enableResponse.statusCode}`);
          const enabledDraft = readJson('workflows.json').find(workflow => workflow.id === 'agent-draft-valid');
          assert(enabledDraft.enabled === true, 'Operator should be able to enable agent-created draft through admin workflow path');
        }
      }
    );

    // 9. agent-created workflow draft intent compiles to valid disabled workflow draft
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-intent ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          const draft = readJson('workflows.json').find(workflow => workflow.id === 'agent-draft-intent');
          assert(draft, 'Agent-created workflow draft intent was not saved');
          assert(draft.enabled === false, 'Agent-created workflow draft intent should be disabled');
          assert(draft.createdByType === 'agent', 'Intent-created workflow draft should persist createdByType');
          assert(draft.createdByAgentId === agent.id, 'Intent-created workflow draft should persist createdByAgentId');
          assert(draft.createdByRunId === run.id, 'Intent-created workflow draft should persist createdByRunId');
          assert(Array.isArray(draft.actions) && draft.actions.length === 2, 'Intent should compile one write step and one stop step');
          assert(draft.actions[0].action === 'writeFile', 'Intent write should compile to writeFile workflow action');
          assert(draft.actions[0].next === 'stop', 'Intent write step should point to stop step');
          assert(draft.actions[1].action === 'stop', 'Intent should compile a stop workflow action');
          assert(Array.isArray(draft.postconditions) && draft.postconditions.length === 2, 'Intent postconditions should compile to workflow.postconditions');
          assert(snapshot.workflowDraftIntents.some(item => item.compiledWorkflowId === 'agent-draft-intent'), 'Replay should record workflow draft intent compilation');
          assert(snapshot.workflowDrafts.some(item => item.workflowId === 'agent-draft-intent' && item.enabled === false), 'Replay should record compiled workflow draft creation');
          assert(snapshot.parsedModelPlans.length === 1, 'Workflow draft intent complete:false should not trigger a second model turn');
          assert(snapshot.parsedModelPlans[0].complete === false, 'Regression should cover model complete:false');
          assert(snapshot.events.some(event => event.type === 'workflow.draft_objective_satisfied'), 'Replay should record workflow draft objective satisfaction');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed', 'Ticket should complete after successful workflow draft intent');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should still be recorded');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should still be recorded');
        }
      }
    );

    // 10. workflow draft intent rejects bare numeric ids with a clear terminal error
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-intent-numeric-id ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          const expectedError = 'createWorkflowDraftIntent.id must be a descriptive non-numeric id such as draft-summary-file-123 or draft-verified-output-123';
          assert(run.error === expectedError, 'Numeric workflow draft intent id should preserve clear validation error');
          assert(snapshot.failureReason === expectedError, 'Numeric workflow draft intent id should preserve failure reason');
          assert(snapshot.parsedModelPlans.length === 1, 'Numeric id validation should not retry or recover');
          assert(snapshot.workflowDraftIntents.length === 0, 'Invalid numeric id intent should not record compiled workflow intent');
          assert(snapshot.workflowDrafts.length === 0, 'Invalid numeric id intent should not create a workflow draft');
          const draft = readJson('workflows.json').find(workflow => workflow.id === '12345');
          assert(!draft, 'Invalid numeric id should not create a workflow under the numeric id');
        }
      }
    );

    // 11. unsupported workflow draft objectives fail terminally without retrying until timeout
    await runScenario(
      preloadPath,
      agent,
      `workflow-branching-unsupported ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'Branching workflow drafts are not available to normal agents with the allowed operations.', 'Unsupported objective message should be preserved as run error');
          assert(snapshot.failureReason === run.error, 'Unsupported objective message should be preserved as failure reason');
          assert(snapshot.parsedModelPlans.length === 1, 'Unsupported objective should not trigger a second model turn');
          assert(snapshot.providerRequests.length === 1, 'Unsupported objective should stop after one provider request');
          assert(snapshot.modelResponses.length === 1, 'Unsupported objective should stop after one model response');
          assert(snapshot.workflowDrafts.length === 0, 'Unsupported objective should not create a workflow draft');
          assert(snapshot.workspaceOperations.length === 0, 'Unsupported objective should not mutate workspace');
          assert(snapshot.events.some(event => event.type === 'model:unsupported_objective'), 'Replay should record unsupported objective event');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should still be recorded');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should still be recorded');
        }
      }
    );

    // 11. structured handoff task executes one writeFile through executor identity without executor model call
    await runScenario(
      preloadPath,
      agent,
      `handoff-valid ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(snapshot.providerRequests.length === 1, 'Handoff planner should use one model request');
          assert(snapshot.modelResponses.length === 1, 'Handoff planner should use one model response');
          assert(snapshot.handoffTasks && snapshot.handoffTasks.some(item => item.status === 'validated' && item.executorAgentId === mike.id), 'Handoff validation evidence missing');
          assert(snapshot.handoffTasks.some(item => item.status === 'executed' && item.executorAgentId === mike.id), 'Handoff execution evidence missing');
          assert(snapshot.workspaceOperations.length === 1, 'Handoff should record one workspace operation');
          assert(snapshot.workspaceOperations[0].operation.operation === 'writeFile', 'Handoff should execute writeFile');
          assert(snapshot.workspaceOperations[0].operation.args.path === 'handoff-note.md', 'Handoff write path mismatch');
          assert(snapshot.authorityChecks.some(item => item.status === 'allowed' && item.actor === `agent:${mike.id}` && item.path === 'handoff-note.md'), 'Handoff authority should use executor identity');
          assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'handoff-note.md'), 'utf8') === 'handoff content', 'Handoff should write exact content');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Handoff run evaluation should be recorded');
          assert(storedRun && storedRun.runConsequence, 'Handoff run consequence should be recorded');
          assert(storedRun.runConsequence.created.some(item => item.path === 'handoff-note.md'), 'Handoff consequence should record created file');
        }
      }
    );

    // 12. handoff invalid paths are rejected before execution
    await runScenario(
      preloadPath,
      agent,
      `handoff-invalid-path ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'createHandoffTask args.path must be a relative workspace path', 'Invalid handoff path should preserve validation error');
          assert(!snapshot.workspaceOperations.length, 'Invalid handoff path should not execute workspace operation');
          assert(!fs.existsSync('/tmp/handoff-note.md'), 'Invalid handoff path should not write outside workspace');
        }
      }
    );

    // 13. handoff unknown executor is rejected before execution
    await runScenario(
      preloadPath,
      agent,
      `handoff-unknown-executor ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'createHandoffTask executor not found: MissingAgent', 'Unknown executor should preserve validation error');
          assert(!snapshot.workspaceOperations.length, 'Unknown executor handoff should not execute workspace operation');
        }
      }
    );

    // 14. invalid agent-created mutating workflow without postconditions is rejected
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-invalid ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async () => {
          const draft = readJson('workflows.json').find(workflow => workflow.id === 'agent-draft-invalid');
          assert(!draft, 'Invalid workflow draft should not be saved');
        }
      }
    );

    console.log(JSON.stringify({
      folderFileAutoComplete: true,
      repeatedWriteAutoComplete: true,
      timeoutAvoided: true,
      failedOpNoAutoComplete: true,
      mixedReadNoAutoComplete: true,
      workspaceObjectiveSatisfied: true,
      partialMutationHandled: true,
      workflowDraftCreated: true,
      workflowDraftIntentCreated: true,
      workflowDraftIntentNumericIdRejected: true,
      unsupportedObjectiveFailed: true,
      handoffTaskExecuted: true,
      handoffInvalidPathRejected: true,
      handoffUnknownExecutorRejected: true,
      invalidWorkflowDraftRejected: true
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
