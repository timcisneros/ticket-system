const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(ROOT, 'workspace-root'));
const BASE_URL = String(process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const WORKFLOW_ID = 'legal-intake-summary';

const workflowDefinition = {
  id: WORKFLOW_ID,
  name: 'Legal intake summary',
  description: 'Extract legal intake fields, branch on urgency, write a case summary, and stop with the extracted fields.',
  enabled: true,
  inputSchema: {
    intakeText: 'string'
  },
  actions: [
    {
      id: 'extract',
      action: 'agentStructuredOutput',
      input: {
        instruction: 'Extract legal intake fields from the provided intake text. Return only JSON. Use urgency value exactly high or normal. Use high when there is an immediate deadline, active court date, lockout, arrest, restraining order, or urgent filing risk; otherwise use normal.',
        input: {
          intakeText: '{{workflow.input.intakeText}}'
        },
        outputSchema: {
          clientName: 'string',
          matterType: 'string',
          urgency: 'string',
          summary: 'string',
          recommendedNextStep: 'string'
        }
      },
      saveAs: 'intake',
      next: 'urgency_check'
    },
    {
      id: 'urgency_check',
      action: 'condition',
      input: {
        value: '{{intake.urgency}}',
        equals: 'high'
      },
      trueNext: 'write_urgent',
      falseNext: 'write_standard'
    },
    {
      id: 'write_urgent',
      action: 'writeFile',
      input: {
        path: 'urgent-case-summary.md',
        content: '# Urgent Case Summary\n\nClient: {{intake.clientName}}\nMatter Type: {{intake.matterType}}\nUrgency: {{intake.urgency}}\n\nSummary:\n{{intake.summary}}\n\nRecommended Next Step:\n{{intake.recommendedNextStep}}\n'
      },
      next: 'stop_urgent'
    },
    {
      id: 'write_standard',
      action: 'writeFile',
      input: {
        path: 'case-summary.md',
        content: '# Case Summary\n\nClient: {{intake.clientName}}\nMatter Type: {{intake.matterType}}\nUrgency: {{intake.urgency}}\n\nSummary:\n{{intake.summary}}\n\nRecommended Next Step:\n{{intake.recommendedNextStep}}\n'
      },
      next: 'stop_standard'
    },
    {
      id: 'stop_urgent',
      action: 'stop',
      input: {
        result: {
          path: 'urgent-case-summary.md',
          clientName: '{{intake.clientName}}',
          matterType: '{{intake.matterType}}',
          urgency: '{{intake.urgency}}',
          summary: '{{intake.summary}}',
          recommendedNextStep: '{{intake.recommendedNextStep}}'
        }
      }
    },
    {
      id: 'stop_standard',
      action: 'stop',
      input: {
        result: {
          path: 'case-summary.md',
          clientName: '{{intake.clientName}}',
          matterType: '{{intake.matterType}}',
          urgency: '{{intake.urgency}}',
          summary: '{{intake.summary}}',
          recommendedNextStep: '{{intake.recommendedNextStep}}'
        }
      }
    }
  ]
};

const intakeInput = {
  intakeText: 'Client name: Jordan Lee. Matter type: landlord tenant emergency. Jordan received a lockout notice and says the landlord changed the locks this morning. There is a court filing deadline tomorrow at 9 AM and Jordan needs urgent help getting access restored. Please summarize the matter and recommend the next step.'
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
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
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
  });
  assert(response.statusCode === 302, `Login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

async function saveWorkflow(cookie) {
  const editResponse = await request('GET', `/admin/workflows/${encodeURIComponent(WORKFLOW_ID)}/edit`, { cookie });
  const pathForSave = editResponse.statusCode === 200
    ? `/admin/workflows/${encodeURIComponent(WORKFLOW_ID)}`
    : '/admin/workflows';
  const response = await request('POST', pathForSave, {
    cookie,
    form: { definition: JSON.stringify(workflowDefinition, null, 2) }
  });
  assert(response.statusCode === 302, `Workflow save failed with HTTP ${response.statusCode}`);
}

function getMikeAgent() {
  const agents = readJson('agents.json');
  const mike = agents.find(agent => agent.name === 'Mike');
  assert(mike, 'Agent "Mike" was not found in data/agents.json');
  return mike;
}

async function createTicket(cookie, mike) {
  const beforeTickets = readJson('tickets.json');
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective: 'Run the Legal intake summary workflow for a high-urgency intake and write the case summary.',
      capabilityType: 'workflow',
      workflowId: WORKFLOW_ID,
      workflowInput: JSON.stringify(intakeInput),
      assignmentTargetType: 'agent',
      assignmentTargetId: String(mike.id),
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, `Ticket create failed with HTTP ${response.statusCode}`);

  const beforeIds = new Set(beforeTickets.map(ticket => ticket.id));
  const createdTicket = readJson('tickets.json')
    .filter(ticket => !beforeIds.has(ticket.id))
    .sort((a, b) => b.id - a.id)[0];
  assert(createdTicket, 'Could not find created ticket in data/tickets.json');
  return createdTicket;
}

async function waitForRun(ticketId) {
  const started = Date.now();

  while (Date.now() - started < 180000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const run = runs.sort((a, b) => b.id - a.id)[0];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for ticket #${ticketId}`);
}

async function main() {
  const cookie = await login();
  await saveWorkflow(cookie);
  const mike = getMikeAgent();
  const ticket = await createTicket(cookie, mike);
  const run = await waitForRun(ticket.id);
  assert(run.status === 'completed', `Run #${run.id} ended as ${run.status}: ${run.error || 'no error message'}`);

  const snapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, run.replaySnapshotPath), 'utf8'));
  const output = snapshot.capabilityOutputs && snapshot.capabilityOutputs[0] ? snapshot.capabilityOutputs[0].output : {};
  const outputPath = output.path || 'urgent-case-summary.md';
  const workspaceOutputPath = path.join(WORKSPACE_ROOT, outputPath);
  assert(fs.existsSync(workspaceOutputPath), `Output file not found: ${workspaceOutputPath}`);

  const history = readJson('operation-history.json').filter(record => record.runId === run.id);
  const writeHistory = history.find(record => record.operation === 'writeFile');
  assert(writeHistory, 'No writeFile operation history record found');

  const recoveryPreview = await request('GET', `/api/operations/${writeHistory.id}/recovery-preview`, { cookie });
  assert(recoveryPreview.statusCode === 200, `Recovery preview failed with HTTP ${recoveryPreview.statusCode}`);

  const actionSequence = (snapshot.workflowActions || []).map(action => action.action);
  const summary = {
    ticketId: ticket.id,
    runId: run.id,
    agent: mike.name,
    workflow: WORKFLOW_ID,
    outputPath,
    extractedFields: output,
    replay: {
      capabilitySelection: (snapshot.capabilitySelection || []).length,
      workflowActions: actionSequence,
      capabilityOutputs: (snapshot.capabilityOutputs || []).length,
      workspaceOperations: (snapshot.workspaceOperations || []).map(item => item.operation && item.operation.operation)
    },
    operationHistoryId: writeHistory.id,
    recoveryPreview: JSON.parse(recoveryPreview.body).preview
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
