#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

function readJson(name, fallback = []) {
  const filePath = path.join(DATA_DIR, name);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function readEvents() {
  const filePath = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--run') {
      args.run = argv[index + 1];
      index += 1;
    } else if (!args.run && /^\d+$/.test(value)) {
      args.run = value;
    }
  }
  return args;
}

function readReplaySnapshot(run) {
  if (!run) return null;
  if (run.replaySnapshot && typeof run.replaySnapshot === 'object') return run.replaySnapshot;
  if (!run.replaySnapshotPath) return null;
  const snapshotPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function latestWorkflowForRun(run, ticket, workflows, snapshot) {
  const workflowId = run.workflowId || run.capabilityId || ticket.workflowId ||
    (snapshot.workflowInvocation && snapshot.workflowInvocation.workflowId);
  if (!workflowId) return null;
  const workflow = workflows.find(item => item.id === workflowId);
  if (!workflow) return { id: workflowId, found: false };
  return {
    id: workflow.id,
    name: workflow.name || null,
    enabled: workflow.enabled !== false,
    actions: Array.isArray(workflow.actions) ? workflow.actions.map(step => ({
      id: step.id || null,
      action: step.action || null,
      next: step.next || null,
      trueNext: step.trueNext || null,
      falseNext: step.falseNext || null
    })) : [],
    postconditions: workflow.postconditions || []
  };
}

function operationPath(operation) {
  if (!operation) return null;
  if (operation.args && operation.args.path) return operation.args.path;
  if (operation.path) return operation.path;
  return null;
}

const args = parseArgs(process.argv.slice(2));
const runId = parseInt(args.run || '', 10);
if (!runId) {
  console.error('Usage: npm run codex:trace -- --run <id>');
  process.exit(1);
}

const tickets = readJson('tickets.json');
const runs = readJson('runs.json');
const logs = readJson('logs.json');
const history = readJson('operation-history.json');
const workflows = readJson('workflows.json');
const run = runs.find(item => item.id === runId);

if (!run) {
  console.error(`Run ${runId} not found in ${path.join(DATA_DIR, 'runs.json')}`);
  process.exit(1);
}

const ticket = tickets.find(item => item.id === run.ticketId) || null;
const snapshot = readReplaySnapshot(run) || {};
const events = readEvents().filter(event =>
  event.runId === run.id ||
  (ticket && event.runId === null && event.ticketId === ticket.id)
);
const authorityEvidence = [
  ...(Array.isArray(snapshot.authorityChecks) ? snapshot.authorityChecks : []),
  ...events
    .filter(event => event.type === 'authority.allowed' || event.type === 'authority.denied')
    .map(event => ({ type: event.type, ...(event.payload || {}) }))
];
const postconditionEvents = events.filter(event => event.type === 'run.postconditions_checked' || event.type === 'run.postcondition_failed');
const violationEvents = events.filter(event => event.type === 'run.violations_checked' || event.type === 'run.violation_detected');

const output = {
  runState: {
    id: run.id,
    ticketId: run.ticketId,
    agentId: run.agentId,
    agentName: run.agentName || null,
    status: run.status,
    executionMode: run.executionMode || null,
    capabilityType: run.capabilityType || null,
    capabilityId: run.capabilityId || null,
    workflowId: run.workflowId || null,
    leaseOwner: run.leaseOwner || null,
    leaseExpiresAt: run.leaseExpiresAt || null,
    currentStepId: run.currentStepId || null,
    currentWorkflowAction: run.currentWorkflowAction || null,
    lastHeartbeatAt: run.lastHeartbeatAt || null,
    createdAt: run.createdAt || null,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    updatedAt: run.updatedAt || null,
    error: run.error || null
  },
  ticket: ticket ? {
    id: ticket.id,
    objective: ticket.objective,
    status: ticket.status,
    workflowId: ticket.workflowId || null,
    capabilityType: ticket.capabilityType || null,
    capabilityId: ticket.capabilityId || null
  } : null,
  events,
  replaySummary: run.replaySummary || null,
  replaySnapshotSummary: {
    path: run.replaySnapshotPath || null,
    providerRequests: Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests.length : 0,
    modelResponses: Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses.length : 0,
    parsedModelPlans: Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans.length : 0,
    workflowActions: Array.isArray(snapshot.workflowActions) ? snapshot.workflowActions.length : 0,
    workspaceOperations: Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations.length : 0,
    workflowDrafts: Array.isArray(snapshot.workflowDrafts) ? snapshot.workflowDrafts : [],
    failure: snapshot.failure || null,
    failureReason: snapshot.failureReason || null
  },
  runEvaluation: run.runEvaluation || null,
  runConsequence: run.runConsequence || null,
  authorityEvidence,
  violations: {
    evaluation: run.runEvaluation && run.runEvaluation.violations ? run.runEvaluation.violations : null,
    events: violationEvents
  },
  postconditions: {
    workflow: latestWorkflowForRun(run, ticket || {}, workflows, snapshot)
      ? latestWorkflowForRun(run, ticket || {}, workflows, snapshot).postconditions || []
      : [],
    events: postconditionEvents
  },
  workflowMetadata: latestWorkflowForRun(run, ticket || {}, workflows, snapshot),
  operationHistory: history.filter(item => item.runId === run.id),
  logs: logs.filter(item => item.runId === run.id).map(item => ({
    id: item.id,
    ts: item.ts || item.createdAt || null,
    type: item.type,
    message: item.message,
    operation: item.workspaceAction && item.workspaceAction.operation ? item.workspaceAction.operation : null,
    path: item.workspaceAction ? operationPath(item.workspaceAction.args || item.workspaceAction) : null
  }))
};

console.log(JSON.stringify(output, null, 2));
