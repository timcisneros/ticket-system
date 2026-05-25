const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'benchmark-cases.jsonl');
const MAX_EVENTS = parseInt(process.env.BENCHMARK_CASE_MAX_EVENTS || '80', 10) || 80;

function readJsonArray(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    return [];
  }
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    return null;
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

function replaySnapshotForRun(run) {
  if (!run || !run.replaySnapshotPath) return null;
  const snapshotPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  return readJsonObject(snapshotPath);
}

function runEvents(events, runId) {
  return events.filter(event => event.runId === runId);
}

function truncateEvents(events) {
  if (events.length <= MAX_EVENTS) return events;
  const headCount = Math.floor(MAX_EVENTS / 2);
  const tailCount = MAX_EVENTS - headCount;
  return [
    ...events.slice(0, headCount),
    {
      id: 'truncated',
      ts: null,
      type: 'events.truncated',
      ticketId: null,
      runId: null,
      stepId: null,
      payload: {
        originalCount: events.length,
        retained: MAX_EVENTS
      }
    },
    ...events.slice(events.length - tailCount)
  ];
}

function summarizeReplay(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    replaySnapshotPath: snapshot.replaySnapshotPath || null,
    terminalStatus: snapshot.terminalStatus || null,
    failureReason: snapshot.failureReason || null,
    mutationCount: snapshot.mutationCount,
    workflowActions: Array.isArray(snapshot.workflowActions) ? snapshot.workflowActions.length : 0,
    workspaceOperations: Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations.length : 0,
    providerRequests: Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests.length : 0,
    modelResponses: Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses.length : 0,
    authorityChecks: Array.isArray(snapshot.authorityChecks) ? snapshot.authorityChecks.length : 0
  };
}

function failureTypeForRun(run, evaluation) {
  if (evaluation && evaluation.violations && evaluation.violations.status === 'present') return 'violation_present';
  if (evaluation && evaluation.effectiveness && evaluation.effectiveness.status === 'failed') return 'effectiveness_failed';
  if (run.status === 'interrupted') return 'run_interrupted';
  if (run.status === 'failed') return 'run_failed';
  return 'unknown_failure';
}

function shouldHarvest(run) {
  const evaluation = run.runEvaluation || {};
  return Boolean(
    evaluation.effectiveness && evaluation.effectiveness.status === 'failed' ||
    evaluation.violations && evaluation.violations.status === 'present' ||
    ['failed', 'interrupted'].includes(run.status)
  );
}

function expectedRepairProperties(caseRecord) {
  const properties = [
    'replacement draft enabled:false',
    'uses only existing actions',
    'passes workflow validation',
    'executes successfully after operator enablement',
    'postconditions pass'
  ];
  if (caseRecord.runEvaluation && caseRecord.runEvaluation.violations && caseRecord.runEvaluation.violations.status === 'present') {
    properties.push('violations resolved');
  }
  return properties;
}

function stableCaseKey(caseRecord) {
  const source = {
    failureType: caseRecord.failureType,
    workflowId: caseRecord.workflow && caseRecord.workflow.id,
    workflowActions: caseRecord.workflow && caseRecord.workflow.actions,
    workflowInput: caseRecord.workflowInput,
    effectiveness: caseRecord.runEvaluation && caseRecord.runEvaluation.effectiveness && caseRecord.runEvaluation.effectiveness.status,
    violations: caseRecord.runEvaluation && caseRecord.runEvaluation.violations && caseRecord.runEvaluation.violations.status
  };
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function main() {
  const runs = readJsonArray('runs.json');
  const workflows = readJsonArray('workflows.json');
  const events = readEvents();
  const cases = [];
  const seen = new Set();

  runs.filter(run => run.executionMode === 'workflow' && shouldHarvest(run)).forEach(run => {
    const workflow = workflows.find(item => item.id === run.workflowId) || null;
    if (!workflow) return;
    const snapshot = replaySnapshotForRun(run);
    const eventsForRun = truncateEvents(runEvents(events, run.id));
    const caseRecord = {
      sourceRunId: run.id,
      failureType: failureTypeForRun(run, run.runEvaluation || null),
      workflow,
      workflowInput: run.workflowInput || {},
      runEvaluation: run.runEvaluation || {},
      runConsequence: run.runConsequence || {},
      events: eventsForRun,
      authorityEvidence: Array.isArray(snapshot && snapshot.authorityChecks) ? snapshot.authorityChecks : [],
      replaySummary: {
        ...(run.replaySummary || {}),
        replaySnapshotPath: run.replaySnapshotPath || null,
        summary: summarizeReplay(snapshot)
      },
      replayReferences: {
        replaySnapshotPath: run.replaySnapshotPath || null,
        eventsFile: 'events.jsonl'
      },
      expectedRepairProperties: []
    };
    caseRecord.expectedRepairProperties = expectedRepairProperties(caseRecord);
    const key = stableCaseKey(caseRecord);
    if (seen.has(key)) return;
    seen.add(key);
    cases.push(caseRecord);
  });

  fs.writeFileSync(OUTPUT_FILE, cases.map(item => JSON.stringify(item)).join('\n') + (cases.length ? '\n' : ''));
  console.log(JSON.stringify({ harvested: cases.length, output: OUTPUT_FILE }));
}

main();
