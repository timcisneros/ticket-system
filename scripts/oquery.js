#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(ROOT, 'workspace-root'));

function readJson(name) {
  const fp = path.join(DATA_DIR, name);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return []; }
}

function resolveLocalAgent(value) {
  const agents = readJson('agents.json');
  const requested = value === undefined || value === null || value === '' ? '1' : String(value).trim();
  const id = parseInt(requested, 10);
  if (!Number.isNaN(id) && String(id) === requested) {
    return agents.find(agent => agent.id === id) || { id, name: `Agent ${id}` };
  }
  const lower = requested.toLowerCase();
  return agents.find(agent => String(agent.name || '').toLowerCase() === lower) || null;
}

function loadAll() {
  return {
    tickets: readJson('tickets.json'),
    runs: readJson('runs.json'),
    logs: readJson('logs.json'),
    history: readJson('operation-history.json'),
    plans: readJson('allocation-plans.json'),
  };
}

function readRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return null;
  if (run.replaySnapshot && typeof run.replaySnapshot === 'object') return run.replaySnapshot;
  if (!run.replaySnapshotPath) return null;

  const snapshotPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(snapshotPath)) return null;

  try { return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch (e) { return null; }
}

function hydrateRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return run;
  const replaySnapshot = readRunReplaySnapshot(run);
  return replaySnapshot ? { ...run, replaySnapshot } : run;
}

function replaySummary(run) {
  return run && run.replaySummary && typeof run.replaySummary === 'object' ? run.replaySummary : {};
}

// ── Formatting helpers ──

function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s) { return `\x1b[36m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }

function statusTag(s) {
  if (s === 'completed') return green('completed');
  if (s === 'failed') return red('failed');
  return yellow(s || 'unknown');
}

function outcomeTag(s) {
  if (s === 'completed_with_verified_postcondition') return green(s);
  if (s === 'completed_with_mutations') return green(s);
  if (s === 'completed_noop') return yellow(s);
  if (s === 'impossible_within_boundary') return yellow(s);
  if (s === 'blocked/rejected') return red(s);
  if (s === 'failed_execution') return red(s);
  if (s === 'interrupted') return yellow(s);
  return dim(s || 'unknown');
}

function replayActionStateTag(state) {
  if (state === 'COMMITTED') return green(state);
  if (state === 'BLOCKED') return red(state);
  if (state === 'SKIPPED') return yellow(state);
  if (state === 'EXECUTED') return cyan(state);
  return dim(state || 'PROPOSED');
}

const MUTATING_OPERATIONS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

function classifyProposedActions(actions, ops, consumedOps = new Set()) {
  let stepBlocked = false;
  return (actions || []).map(a => {
    if (!a || typeof a !== 'object' || !a.operation) return { state: null, detail: '', opResult: null };
    const actionPath = a.args ? a.args.path : undefined;
    const opResult = (ops || []).find(o => {
      if (consumedOps.has(o)) return false;
      const match = o.operation && o.operation.operation === a.operation &&
        o.operation.args && o.operation.args.path === actionPath;
      if (match) consumedOps.add(o);
      return match;
    });
    const mutating = MUTATING_OPERATIONS.includes(a.operation);
    if (opResult) {
      if (opResult.blocked || opResult.error) {
        stepBlocked = true;
        return { state: 'BLOCKED', detail: opResult.reason || opResult.error || '', opResult };
      }
      if (mutating && (opResult.historyId || (opResult.result && opResult.result.historyId))) {
        return { state: 'COMMITTED', detail: '', opResult };
      }
      return { state: 'EXECUTED', detail: '', opResult };
    }
    if (stepBlocked) return { state: 'SKIPPED', detail: 'not executed after blocked/rejected operation', opResult: null };
    return { state: 'PROPOSED', detail: '', opResult: null };
  });
}

function opTypeTag(s) {
  if (!s) return '';
  if (s === 'createFolder') return cyan('CREATE');
  if (s === 'writeFile') return cyan('WRITE');
  if (s === 'readFile') return yellow('READ');
  if (s === 'listDirectory') return dim('LIST');
  if (s === 'deletePath') return red('DELETE');
  if (s === 'renamePath') return yellow('RENAME');
  return s;
}

function shortOpName(s) {
  const map = { createFolder: 'MKDIR', writeFile: 'WRITE', readFile: 'READ', listDirectory: 'LIST', deletePath: 'DEL', renamePath: 'MV' };
  return map[s] || s;
}

function truncate(s, n = 80) {
  if (!s) return '';
  return s.length > n ? s.substring(0, n) + '...' : s;
}

function datetime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toISOString().replace('T', ' ').substring(0, 19);
}

function runLogs(run, data) {
  const logs = Array.isArray(data.logs) ? data.logs : [];
  return logs.filter(l => l && l.runId === run.id);
}

function runHistory(run, data) {
  const history = Array.isArray(data.history) ? data.history : [];
  return history.filter(h => h && h.runId === run.id);
}

function replayEvents(run) {
  const snapshot = readRunReplaySnapshot(run);
  return snapshot && Array.isArray(snapshot.events)
    ? snapshot.events
    : [];
}

function replayWorkspaceOps(run) {
  const snapshot = readRunReplaySnapshot(run);
  return snapshot && Array.isArray(snapshot.workspaceOperations)
    ? snapshot.workspaceOperations
    : [];
}

function hasCompletedNoopEvent(run, data) {
  const summary = replaySummary(run);
  return summary.hasCompletedNoop ||
    replayEvents(run).some(e => e && e.type === 'run:completed_noop') ||
    runLogs(run, data).some(l => l && l.type === 'run:completed_noop');
}

function hasPostconditionCompletedEvent(run, data) {
  const summary = replaySummary(run);
  return summary.hasPostconditionCompleted ||
    replayEvents(run).some(e => e && e.type === 'run:postcondition_completed') ||
    runLogs(run, data).some(l => l && l.type === 'run:postcondition_completed');
}

function hasBlockedOrRejectedEvidence(run, data) {
  const summary = replaySummary(run);
  if (summary.hasBlockedOrRejected) return true;
  return runLogs(run, data).some(l => l && l.type === 'workspace:blocked') ||
    replayWorkspaceOps(run).some(o => o && (o.blocked || (o.operation && o.operation.blocked))) ||
    runHistory(run, data).some(h => h && (
      h.blocked ||
      (h.error && /protected|ownership|blocked/i.test(h.error)) ||
      (h.result && /protected|ownership|blocked/i.test(JSON.stringify(h.result)))
    ));
}

function hasNotFoundEvidence(run, data) {
  return runLogs(run, data).some(l => {
    const action = l && l.workspaceAction;
    return action && (
      action.status === 'not_found' ||
      (action.result && action.result.status === 'not_found') ||
      (action.error && /not_found|enoent/i.test(action.error))
    );
  }) ||
    replayWorkspaceOps(run).some(o => {
      const result = o && o.result;
      const error = o && o.error;
      return (result && result.status === 'not_found') || (error && /not_found|enoent/i.test(error));
    });
}

function mutationCountForRun(run) {
  if (run && run.mutationCount !== undefined) return run.mutationCount;
  if (run && run.replaySummary && run.replaySummary.mutationCount !== undefined) return run.replaySummary.mutationCount;
  if (run && run.replaySnapshot && run.replaySnapshot.mutationCount !== undefined) return run.replaySnapshot.mutationCount;
  return 0;
}

function classifyOperationalOutcome(run, data) {
  if (!run || typeof run !== 'object') return 'unknown';
  if (hasBlockedOrRejectedEvidence(run, data)) return 'blocked/rejected';
  if (run.status === 'interrupted') return 'interrupted';

  if (run.status === 'completed') {
    if (hasPostconditionCompletedEvent(run, data)) return 'completed_with_verified_postcondition';
    if (mutationCountForRun(run) > 0) return 'completed_with_mutations';
    if (hasNotFoundEvidence(run, data)) return 'impossible_within_boundary';
    if (hasCompletedNoopEvent(run, data)) return 'completed_noop';
    return 'completed_noop';
  }

  if (run.status === 'failed') return 'failed_execution';
  return run.status || 'unknown';
}

function runWithOperationalOutcome(run, data) {
  return { ...run, operationalOutcome: classifyOperationalOutcome(run, data) };
}

function ticketWithOperationalOutcome(ticket, data) {
  const runs = [...(Array.isArray(data.runs) ? data.runs : []).filter(r => r.ticketId === ticket.id)]
    .sort((a, b) => (a.id || 0) - (b.id || 0));
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  return {
    ...ticket,
    latestRunOutcome: lastRun ? classifyOperationalOutcome(lastRun, data) : null
  };
}

function sourceLabel(args) {
  if (args.api) return `[remote substrate — live server: ${args.url || opercUrl()}]`;
  return `[local substrate — files on disk, not the running server: ${DATA_DIR}]`;
}

function sourceLabelLine(args) {
  return dim(sourceLabel(args));
}

async function fetchServerIdentity(url) {
  try {
    const res = await httpReq('GET', `${url}/api/health`);
    if (res.status === 200) return JSON.parse(res.body);
  } catch (e) { /* unreachable */ }
  return null;
}

async function printDivergenceWarning(args) {
  if (args.api || args.json) return;
  const identity = await fetchServerIdentity(args.url || opercUrl());
  if (!identity) return;

  let any = false;
  if (identity.dataDir && identity.dataDir !== DATA_DIR) {
    console.log(dim(`  \u26A0 dataDir:        ${identity.dataDir} (server)`));
    console.log(dim(`                     ${DATA_DIR} (local)`));
    any = true;
  }
  if (identity.workspaceRoot && identity.workspaceRoot !== WORKSPACE_ROOT) {
    console.log(dim(`  \u26A0 workspaceRoot:  ${identity.workspaceRoot} (server)`));
    console.log(dim(`                     ${WORKSPACE_ROOT} (local)`));
    any = true;
  }
  if (any) {
    console.log(dim(`    These reads come from local files on disk, not the running server. Pass --api to query the server.`));
    console.log('');
  }
}

async function fetchRemoteData(args) {
  const url = args.url || opercUrl();
  const cookie = readCookie();
  const headers = {};
  if (cookie) headers['Cookie'] = `sessionId=${cookie}`;
  const res = await httpReq('GET', `${url}/api/export`, { headers });
  if (res.status === 200) {
    const data = JSON.parse(res.body);
    return {
      tickets: data.tickets || [],
      runs: data.runs || [],
      logs: data.logs || [],
      history: data.history || [],
      plans: data.plans || []
    };
  }
  if (res.status === 401 || res.status === 403) {
    console.log(red('  \u2717 Not authenticated. Run login first.'));
    process.exit(1);
  }
  throw new Error(`Failed to fetch remote data: HTTP ${res.status}`);
}

async function fetchRemoteDataForRuns(args) {
  const url = args.url || opercUrl();
  const cookie = readCookie();
  const headers = {};
  if (cookie) headers['Cookie'] = `sessionId=${cookie}`;

  let res;
  try {
    res = await httpReq('GET', `${url}/api/export`, { headers });
  } catch (error) {
    return { error: 'transport_error', message: error.message || String(error) };
  }

  if (!res || typeof res.body !== 'string' || res.body.trim() === '') {
    return { error: 'empty_response', message: `API returned empty response from ${url}/api/export` };
  }

  if (res.status !== 200) {
    return { error: 'api_error', message: `API returned HTTP ${res.status}` };
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (error) {
    return { error: 'malformed_response', message: error.message || 'API returned malformed JSON' };
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.runs)) {
    return { error: 'malformed_response', message: 'API response did not contain a runs array' };
  }

  return {
    data: {
      tickets: Array.isArray(data.tickets) ? data.tickets : [],
      runs: data.runs,
      logs: Array.isArray(data.logs) ? data.logs : [],
      history: Array.isArray(data.history) ? data.history : [],
      plans: Array.isArray(data.plans) ? data.plans : []
    }
  };
}

// ── Commands ──

async function cmdTickets(args) {
  const data = args.api ? await fetchRemoteData(args) : loadAll();
  let list = data.tickets;

  if (args.status) list = list.filter(t => t.status === args.status);
  if (args.search) {
    const q = args.search.toLowerCase();
    list = list.filter(t => (t.objective || '').toLowerCase().includes(q));
  }
  if (args.limit) list = list.slice(0, parseInt(args.limit));

  if (args.json) return console.log(JSON.stringify(list.map(t => ticketWithOperationalOutcome(t, data)), null, 2));

  if (list.length === 0) return console.log(dim('No tickets found.'));

  list.forEach(t => {
    const runs = [...data.runs.filter(r => r.ticketId === t.id)].sort((a, b) => (a.id || 0) - (b.id || 0));
    const runCount = runs.length;
    const lastRun = runCount > 0 ? runs[runCount - 1] : null;
    const rStatus = lastRun ? statusTag(lastRun.status) : dim('no run');
    const completedRuns = runs.filter(r => r.status === 'completed').length;
    const failedRuns = runs.filter(r => r.status === 'failed').length;
    const created = datetime(t.createdAt);

    if (runCount === 0) {
      console.log(`  ${bold(`#${t.id}`)} ${statusTag(t.status)} ${dim('no runs')} ${dim(created)}`);
    } else {
      const latestOutcome = classifyOperationalOutcome(lastRun, data);
      const runInfo = `runs: ${runCount} | latest: ${statusTag(lastRun.status)} | outcome: ${latestOutcome} | completed: ${completedRuns} | failed: ${failedRuns}`;
      console.log(`  ${bold(`#${t.id}`)} ticket: ${statusTag(t.status)} ${dim(runInfo)} ${dim(created)}`);
    }
    console.log(`       ${truncate((t.objective || '').replace(/\r?\n/g, '\\n'), 120)}`);
    // Show continuation lineage
    const contRuns = runs.filter(r => (r.replaySnapshot && r.replaySnapshot.continuationOf) || replaySummary(r).continuationOf);
    if (contRuns.length > 0) {
      contRuns.forEach(r => console.log(`       ${dim('↳ continuation of run #' + (replaySummary(r).continuationOf || r.replaySnapshot.continuationOf))}`));
    }
    // Show allocation info
    if (t.assignmentMode === 'allocated' && runCount > 1) {
      const agentRunCount = new Set(runs.map(r => r.agentName || r.agentId)).size;
      console.log(`       ${dim('allocated across ' + agentRunCount + ' agent(s)')}`);
    }
    console.log('');
  });
}

async function cmdRuns(args) {
  let printed = false;
  const print = (message) => {
    printed = true;
    console.log(message);
  };

  try {
    const remote = args.api ? await fetchRemoteDataForRuns(args) : null;
    if (remote && remote.error) {
      const state = { state: remote.error, message: remote.message };
      if (args.json) return print(JSON.stringify(state, null, 2));
      print(red(`Runs unavailable: ${remote.error}`));
      print(`       ${remote.message}`);
      return;
    }

    const data = remote ? remote.data : loadAll();
    let list = data.runs;

    if (!Array.isArray(list)) {
      const state = { state: 'malformed_response', message: 'Runs data is not an array' };
      if (args.json) return print(JSON.stringify(state, null, 2));
      print(red('Runs unavailable: malformed_response'));
      print('       Runs data is not an array');
      return;
    }

    if (args.ticket) list = list.filter(r => r && r.ticketId === parseInt(args.ticket));
    if (args.status) list = list.filter(r => r && r.status === args.status);
    if (args.agent) list = list.filter(r => r && r.agentId === parseInt(args.agent));
    if (args.limit) list = list.slice(0, parseInt(args.limit));
    if (args.id) list = list.filter(r => r && r.id === parseInt(args.id));

    if (args.json) return print(JSON.stringify(list.map(r => runWithOperationalOutcome(r, data)), null, 2));

    if (list.length === 0) {
      const filtered = args.ticket || args.status || args.agent || args.id;
      return print(dim(filtered ? 'No matching runs.' : 'No runs recorded.'));
    }

    list.forEach(r => {
      if (!r || typeof r !== 'object') {
        print(red('Runs unavailable: malformed_response'));
        print('       Run entry is not an object');
        return;
      }

      const tickets = Array.isArray(data.tickets) ? data.tickets : [];
      const ticket = tickets.find(t => t.id === r.ticketId);
      const ticketLabel = ticket ? `T${r.ticketId}` : dim(`T${r.ticketId} (deleted)`);
      const summary = replaySummary(r);
      const plans = r.replaySnapshot ? (r.replaySnapshot.parsedModelPlans || []) : [];
      const steps = summary.steps !== undefined ? summary.steps : plans.length;
      const initializing = !r.replaySnapshot && !r.replaySummary || steps === 0;
      const ops = summary.workspaceOperations !== undefined ? summary.workspaceOperations : (r.replaySnapshot ? (r.replaySnapshot.workspaceOperations || []).length : 0);
      const mutations = r.mutationCount !== undefined ? r.mutationCount : (summary.mutationCount !== undefined ? summary.mutationCount : (r.replaySnapshot && r.replaySnapshot.mutationCount !== undefined ? r.replaySnapshot.mutationCount : '?'));
      const operationalOutcome = classifyOperationalOutcome(r, data);
      const created = datetime(r.createdAt);
      const err = r.error ? red(r.error.substring(0, 80)) : '';

      print(`  ${bold(`R${r.id}`)} ${statusTag(r.status)} ${dim('ticket')} ${ticketLabel} ${dim('agent')} ${r.agentName || '?'}`);
      print(`       ${dim('outcome')} ${outcomeTag(operationalOutcome)} ${dim('steps')} ${steps} ${dim('ops')} ${ops} ${dim('mutations')} ${mutations} ${dim('model')} ${summary.model || (r.replaySnapshot ? r.replaySnapshot.model : '?')} ${dim(created)}`);
      if (initializing) print(`       ${yellow('initializing')} ${dim('no steps recorded yet')}`);
      if (err) print(`       ${err}`);
      if (r.allocationSubtask) print(`       ${yellow('allocated')} ${dim(truncate(r.allocationSubtask, 100))}`);
      if (summary.continuationOf || (r.replaySnapshot && r.replaySnapshot.continuationOf)) {
        print(`       ${dim('↳ continuation of run #' + (summary.continuationOf || r.replaySnapshot.continuationOf))}`);
      }
      print('');
    });
  } catch (error) {
    const state = { state: 'runs_query_error', message: error.message || String(error) };
    if (args.json) return print(JSON.stringify(state, null, 2));
    print(red('Runs unavailable: runs_query_error'));
    print(`       ${state.message}`);
  } finally {
    if (!printed) {
      if (args.json) console.log(JSON.stringify({ state: 'no_output', message: 'Runs query produced no output' }, null, 2));
      else console.log(dim('Runs query produced no output.'));
    }
  }
}

async function cmdLogs(args) {
  const data = args.api ? await fetchRemoteData(args) : loadAll();
  let list = data.logs;

  if (args.run) list = list.filter(l => l.runId === parseInt(args.run));
  if (args.ticket) list = list.filter(l => l.ticketId === parseInt(args.ticket));
  if (args.type) list = list.filter(l => l.type === args.type);
  if (args.search) {
    const q = args.search.toLowerCase();
    list = list.filter(l => (l.message || '').toLowerCase().includes(q) ||
      JSON.stringify(l.workspaceAction || '').toLowerCase().includes(q));
  }
  if (args.limit) list = list.slice(0, parseInt(args.limit));

  if (args.json) return console.log(JSON.stringify(list, null, 2));

  if (list.length === 0) return console.log(dim('No logs found.'));

  list.forEach(l => {
    const time = datetime(l.timestamp);
    const type = l.type || '?';
    const msg = l.message || '';
    const action = l.workspaceAction || null;
    const runInfo = l.runId ? dim(`R${l.runId}`) : '';
    const ticketInfo = l.ticketId ? dim(`T${l.ticketId}`) : '';

    console.log(`  ${dim(time)} ${runInfo} ${ticketInfo} ${type}`);
    if (msg) console.log(`       ${truncate(msg, 150)}`);
    if (action) {
      const a = action.operation || action.args ? JSON.stringify(action).substring(0, 120) : '';
      if (a) console.log(`       ${dim(truncate(a, 120))}`);
    }
    console.log('');
  });
}

async function cmdMutations(args) {
  const data = args.api ? await fetchRemoteData(args) : loadAll();
  let list = data.history;

  if (args.run) list = list.filter(h => h.runId === parseInt(args.run));
  if (args.ticket) list = list.filter(h => h.ticketId === parseInt(args.ticket));
  if (args.op) list = list.filter(h => h.operation === args.op);
  if (args.path) {
    const q = args.path.toLowerCase();
    list = list.filter(h => {
      const p = h.args ? (h.args.path || '') : '';
      return p.toLowerCase().includes(q);
    });
  }
  if (args.limit) list = list.slice(0, parseInt(args.limit));

  if (args.json) return console.log(JSON.stringify(list, null, 2));

  if (list.length === 0) return console.log(dim('No mutations found.'));

  list.forEach(h => {
    const time = datetime(h.timestamp);
    const op = opTypeTag(h.operation);
    const path_ = h.args ? (h.args.path || '?') : '?';
    const status_ = h.result ? (h.result.status || '') : '';
    const statusTag_ = status_ === 'created' ? green('created') : status_ === 'already_exists_noop' ? yellow('noop') : dim(status_);
    const runInfo = h.runId ? dim(`R${h.runId}`) : '';
    const ticketInfo = h.ticketId ? dim(`T${h.ticketId}`) : '';
    const historyInfo = h.id ? yellow(`H${h.id}`) : dim('H?');

    console.log(`  ${historyInfo} ${dim(time)} ${runInfo} ${ticketInfo} step=${h.step != null ? h.step : '?'}`);
    console.log(`       ${op} ${path_} ${statusTag_}`);
    if (h.error) console.log(`       ${red('error')} ${h.error}`);
    console.log('');
  });
}

async function cmdReplay(args) {
  const runId = parseInt(args._[0] || args.id || '');
  if (!runId) return console.log(red('Usage: oquery replay <run-id>'));

  const data = args.api ? await fetchRemoteData(args) : loadAll();
  const run = hydrateRunReplaySnapshot(data.runs.find(r => r.id === runId));
  if (!run) return console.log(red(`Run #${runId} not found.`));
  const snap = run.replaySnapshot;
  if (!snap) return console.log(red(`Run #${runId} has no replay snapshot.`));

  const ticket = data.tickets.find(t => t.id === run.ticketId);

  console.log(`\n  ${bold(`Replay: Run #${run.id}`)} ${statusTag(run.status)}`);
  console.log(`  ${dim('ticket')} #${run.ticketId} ${dim('agent')} ${run.agentName} ${dim('model')} ${snap.model}`);
  console.log(`  ${dim('budget')} ${snap.runtimeLimits.maxExecutionSteps} steps / ${snap.runtimeLimits.maxModelRequestsPerRun} reqs / ${snap.runtimeLimits.maxWorkspaceOperationsPerRun} ops`);
  const mutCount = run.mutationCount !== undefined ? run.mutationCount : (snap && snap.mutationCount !== undefined ? snap.mutationCount : '?');
  const mutOutcome = run.mutationOutcome || (snap && snap.mutationOutcome) || '?';
  console.log(`  ${dim('mutation count')} ${mutCount} ${dim('outcome')} ${mutOutcome}`);
  console.log(`  ${dim('created')} ${datetime(run.createdAt)} ${dim('finalized')} ${datetime(snap.finalizedAt)}`);
  if (run.error) console.log(`  ${red(run.error.substring(0, 120))}`);

  if (ticket) {
    console.log(`\n  ${bold('Ticket objective:')}`);
    console.log(`  ${truncate(ticket.objective.replace(/\r?\n/g, '\\n'), 200)}`);
  }

  // Step-by-step replay
  const plans = snap.parsedModelPlans || [];
  const ops = snap.workspaceOperations || [];

  console.log(`\n  ${bold('Execution steps:')}`);
  const consumedOps = new Set();
  plans.forEach((p, i) => {
    const comp = p.complete ? green('complete:true') : dim('complete:false');
    const msg = truncate(p.message || '', 100);
    console.log(`  ${dim(`step ${i}:`)} ${comp} ${msg}`);
    const actionStates = classifyProposedActions(p.actions || [], ops, consumedOps);
    (p.actions || []).forEach(a => {
      const op = opTypeTag(a.operation);
      const path_ = a.args ? (a.args.path || '') : '';
      const contentPreview = a.args && a.args.content ? dim(` content:${truncate(a.args.content, 40)}`) : '';
      const actionState = actionStates.shift() || { state: 'PROPOSED', detail: '', opResult: null };
      const opResult = actionState.opResult;
      const status_ = opResult && opResult.result ? (opResult.result.status || '') : '';
      const statusShow = status_ === 'created' ? green(' ✓') : status_ === 'already_exists_noop' ? yellow(' ⟲') : status_ ? dim(` ${status_}`) : '';
      const detail = actionState.detail || '';
      const detailText = detail ? dim(` (${truncate(detail, 80)})`) : '';
      console.log(`    [${dim('PROPOSED')}] [${replayActionStateTag(actionState.state)}] ${op} ${path_}${statusShow}${contentPreview}${detailText}`);
    });
  });

  // Continuation lineage
  if (snap.continuationOf) {
    const parentRun = data.runs.find(r => r.id === snap.continuationOf);
    console.log(`\n  ${bold('Continuation lineage:')}`);
    console.log(`  ${dim('↳ this run continues run #' + snap.continuationOf)}${parentRun ? ' (' + parentRun.status + ')' : ''}`);
  }
  const childRuns = data.runs.filter(r => (r.replaySnapshot && r.replaySnapshot.continuationOf === run.id) || replaySummary(r).continuationOf === run.id);
  if (childRuns.length > 0) {
    console.log(`  ${dim('↳ continued by:')}`);
    childRuns.forEach(r => console.log(`    run #${r.id} (${r.status})`));
  }

  // Allocation context
  if (run.allocationPlanId) {
    const plan = data.plans.find(p => p.id === run.allocationPlanId);
    if (plan) {
      console.log(`\n  ${bold('Allocation context:')}`);
      console.log(`  ${dim('plan')} #${plan.id} ${dim('mode')} ${plan.mode} ${statusTag(plan.status)}`);
      if (run.allocationSubtask) console.log(`  ${dim('subtask')} ${truncate(run.allocationSubtask, 120)}`);
    }
  }

  console.log('');
}

function classifyFailure(run) {
  const summary = replaySummary(run);
  const failure = summary.failure || (run && run.replaySnapshot ? run.replaySnapshot.failure : null);
  if (failure && typeof failure === 'object') {
    if (failure.kind) return failure.kind;
    if (failure.code === 'RUN_INTERRUPTED') return 'interrupted';
    if (failure.code === 'RUN_LIMIT_EXCEEDED') {
      return failure.detail && failure.detail.limitType === 'timeout' ? 'timeout' : 'budget_exhausted';
    }
    if (failure.code === 'WORKSPACE_PROTECTED_PATH' || failure.code === 'WORKSPACE_OWNERSHIP_VIOLATION') return 'protected_path';
    if (failure.code === 'MODEL_MALFORMED_JSON') return 'invalid_action';
  }
  if (run && run.status === 'interrupted') return 'interrupted';
  return 'unknown';
}

async function cmdFailures(args) {
  const data = args.api ? await fetchRemoteData(args) : loadAll();
  let list = data.runs.filter(r => r.status === 'failed' || r.status === 'interrupted');

  if (args.ticket) list = list.filter(r => r.ticketId === parseInt(args.ticket));
  if (args.run) list = list.filter(r => r.id === parseInt(args.run));
  if (args.type) {
    const targetType = args.type.toLowerCase();
    list = list.filter(r => classifyFailure(r) === targetType);
  }
  if (args.limit) list = list.slice(0, parseInt(args.limit));
  if (args.json) return console.log(JSON.stringify(list.map(r => buildFailureContext(r, data)), null, 2));

  if (list.length === 0) return console.log(dim('No failures found.'));

  list.forEach(r => {
    const ctx = buildFailureContext(r, data);
    const typeTag = ctx.failureType === 'budget_exhausted' ? red('BUDGET') :
      ctx.failureType === 'invalid_action' ? yellow('INVALID') :
      ctx.failureType === 'protected_path' ? red('PROTECTED_PATH') :
      ctx.failureType === 'workspace_error' ? red('FS ERROR') :
      ctx.failureType === 'provider_error' ? red('PROVIDER') :
      ctx.failureType === 'timeout' ? yellow('TIMEOUT') :
      ctx.failureType === 'no_progress' ? yellow('NO_PROGRESS') :
      ctx.failureType === 'interrupted' ? yellow('INTERRUPTED') : dim('UNKNOWN');

    console.log(`  ${bold(`R${r.id}`)} ${red('failed')} ticket ${bold(`T${r.ticketId}`)} [${typeTag}]`);
    console.log(`  ${dim('reason:')} ${ctx.failureReason}`);

    if (ctx.allocationSubtask) console.log(`  ${dim('subtask:')} ${yellow('allocated')} ${dim(ctx.allocationSubtask)}`);

    const mutOutcome = ctx.mutationOutcome === 'partial_mutations' ? yellow('partial') :
      ctx.mutationOutcome === 'all_intended' ? green('all_intended') :
      dim(ctx.mutationOutcome || 'none');
    console.log(`  ${dim('mutations:')} ${ctx.mutationCount} (${mutOutcome}) ${dim('| steps:')} ${ctx.stepsUsed}/${ctx.stepsBudget} ${dim('| ops:')} ${ctx.opsUsed}`);

    if (ctx.lastSuccessfulMutation) {
      console.log(`  ${dim('last success:')} ${opTypeTag(ctx.lastSuccessfulMutation.operation)} ${ctx.lastSuccessfulMutation.path}`);
    } else {
      console.log(`  ${dim('last success:')} ${red('none')}`);
    }

    // Step summary — operation types per step
    if (ctx.stepSummary && ctx.stepSummary.length > 0) {
      const parts = ctx.stepSummary.map(s => {
        const ops = Object.entries(s.counts)
          .map(([op, n]) => `${n} ${shortOpName(op)}`).join(' + ');
        return `${dim(`s${s.step}:`)} ${ops}`;
      });
      console.log(`  ${dim('steps:')} ${parts.join(dim(' | '))}`);
    }

    if (ctx.failedAction) {
      console.log(`  ${dim('failed action:')} ${ctx.failedAction.operation || '<invalid>'} ${ctx.failedAction.path || ''}`);
      if (ctx.failedAction.error) console.log(`  ${dim('error detail:')} ${red(ctx.failedAction.error)}`);
    }

    if (ctx.invalidActions && ctx.invalidActions.length > 0) {
      console.log(`  ${dim('model response had')} ${ctx.invalidActions.length} ${dim('action(s), last model response:')}`);
      const displayActionStates = failureDisplayActionStates(r);
      ctx.invalidActions.forEach((a, i) => {
        if (a.valid) {
          const actionState = displayActionStates[i] || { state: null, detail: '' };
          const state = actionState.state ? ` [${replayActionStateTag(actionState.state)}]` : '';
          const detail = actionState.detail ? dim(` (${truncate(actionState.detail, 80)})`) : '';
          console.log(`    ${i + 1}. ${opTypeTag(a.operation)} ${a.path} ${green('PROPOSED_VALID')}${state}${detail}`);
        } else {
          const reason = a.error || 'malformed';
          console.log(`    ${i + 1}. ${red('<invalid>')} ${dim(reason)}`);
          if (a.raw !== undefined) console.log(`       raw: ${dim(truncate(JSON.stringify(a.raw), 120))}`);
        }
      });
    }

    // Show last model response text for debugging
    if (ctx.lastModelResponseText) {
      console.log(`  ${dim('raw model output:')} ${dim(truncate(ctx.lastModelResponseText, 200))}`);
    }

    console.log(`  ${dim('replay:')} node scripts/oquery.js replay ${r.id}`);
    console.log('');
  });
}

function failureDisplayActionStates(run) {
  const snap = readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const modelResponses = snap.modelResponses || [];
  if (modelResponses.length === 0) return [];
  const lastResp = modelResponses[modelResponses.length - 1];
  try {
    const parsed = JSON.parse(lastResp.text || '{}');
    const actions = parsed.actions || [];
    if (!Array.isArray(actions)) return [];
    const consumedOps = new Set();
    const priorPlans = (snap.parsedModelPlans || []).slice(0, -1);
    priorPlans.forEach(p => classifyProposedActions(p.actions || [], snap.workspaceOperations || [], consumedOps));
    return classifyProposedActions(actions, snap.workspaceOperations || [], consumedOps);
  } catch (e) {
    return [];
  }
}

function buildFailureContext(run, data) {
  const hydratedRun = hydrateRunReplaySnapshot(run);
  const summary = replaySummary(hydratedRun);
  const snap = hydratedRun.replaySnapshot || {};
  const failureReason = hydratedRun.error || summary.failureReason || snap.failureReason || 'unknown';
  const failureType = classifyFailure(hydratedRun);

  const stepsUsed = summary.steps !== undefined ? summary.steps : (snap.parsedModelPlans || []).length;
  const opsUsed = summary.workspaceOperations !== undefined ? summary.workspaceOperations : (snap.workspaceOperations || []).length;
  const stepsBudget = snap.runtimeLimits ? snap.runtimeLimits.maxExecutionSteps : '?';
  const mutationCount = snap.mutationCount !== undefined ? snap.mutationCount : (hydratedRun.mutationCount !== undefined ? hydratedRun.mutationCount : 0);
  const mutationOutcome = snap.mutationOutcome || hydratedRun.mutationOutcome || summary.mutationOutcome || 'unknown';

  // Last successful mutation
  const ops = snap.workspaceOperations || [];
  const mutating = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];
  const successfulMutations = ops.filter(o => {
    if (!mutating.includes(o.operation.operation)) return false;
    if (!o.result) return false;
    if (o.operation.operation === 'createFolder' && o.result.status === 'already_exists_noop') return false;
    return true;
  });
  const lastSuccessfulMutation = successfulMutations.length > 0 ? {
    operation: successfulMutations[successfulMutations.length - 1].operation.operation,
    path: successfulMutations[successfulMutations.length - 1].operation.args.path
  } : null;

  // Failed action from operation history
  const history = data.history.filter(h => h.runId === run.id && h.error);
  const failedAction = history.length > 0 ? {
    operation: history[history.length - 1].operation,
    path: history[history.length - 1].args ? history[history.length - 1].args.path : '',
    error: history[history.length - 1].error
  } : null;

  // Last model response — try to parse it for invalid actions
  const modelResponses = snap.modelResponses || [];
  let invalidActions = null;
  let lastModelResponseText = null;

  if (modelResponses.length > 0) {
    const lastResp = modelResponses[modelResponses.length - 1];
    lastModelResponseText = lastResp.text || '';
    try {
      const parsed = JSON.parse(lastResp.text || '{}');
      const actions = parsed.actions || [];
      if (Array.isArray(actions)) {
        invalidActions = actions.map(a => {
          if (a && typeof a === 'object' && a.operation) {
            return {
              valid: true,
              operation: a.operation,
              path: a.args ? (a.args.path || '') : ''
            };
          }
          return {
            valid: false,
            raw: a,
            error: a === null ? 'null action' : typeof a !== 'object' ? `expected object, got ${typeof a}` : `missing 'operation' field, keys: ${Object.keys(a).join(', ')}`
          };
        });
      }
    } catch (e) {
      // JSON parse failed — show raw text
    }
  }

  // Step summary — operation types per step
  const plans = snap.parsedModelPlans || [];
  const stepSummary = plans.map((p, i) => {
    const actions = p.actions || [];
    const counts = {};
    actions.forEach(a => {
      if (!a || typeof a !== 'object') return;
      const op = a.operation;
      if (!op) return;
      counts[op] = (counts[op] || 0) + 1;
    });
    return { step: i, counts, total: actions.length };
  });

  return {
    runId: hydratedRun.id,
    ticketId: hydratedRun.ticketId,
    failureType,
    failureReason,
    mutationCount,
    mutationOutcome,
    stepsUsed,
    stepsBudget,
    opsUsed,
    stepSummary,
    lastSuccessfulMutation,
    failedAction,
    invalidActions,
    lastModelResponseText,
    allocationSubtask: hydratedRun.allocationSubtask || null,
  };
}

// ── Coverage command — cross-ticket path coverage ──

function extractTicketPaths(objective) {
  const lines = (objective || '').split('\n').filter(l => /^\s*\d+[.)]/.test(l));
  const filePaths = [];
  const dirPaths = [];
  const fullPathRe = /ops-demo[\w\/.-]+/g;
  const bareFileRe = /[\w\/.-]+\.\w{1,4}/g;
  const bareDirRe = /[\w-]+\/[\w\/.-]+/g;
  // Accept bare filenames (.js, .md, .json, .txt) as potential targets
  const bareNameRe = /\b(\w+)\.(js|md|json|txt|ts|tsx|jsx|css|html|yml|yaml)\b/g;

  lines.forEach(line => {
    // First try full ops-demo paths (most reliable)
    const full = line.match(fullPathRe);
    if (full) {
      full.forEach(p => {
        const clean = p.replace(/\/$/, '');
        if (!clean.match(/\.\w+$/)) {
          if (!dirPaths.includes(clean)) dirPaths.push(clean);
        } else {
          if (!filePaths.includes(clean)) filePaths.push(clean);
        }
      });
      return;
    }

    // Fallback: extract bare paths for lines like "create math.js" inside a context directory
    const files = line.match(bareFileRe);
    if (files) {
      files.forEach(f => {
        // Accept paths containing / (e.g. "utils/math.js")
        if (f.includes('/')) {
          if (!filePaths.includes(f)) filePaths.push(f);
          return;
        }
        // Accept bare filenames with known extensions
        const nameMatch = f.match(/^(\w+)\.(js|md|json|txt|ts|tsx|jsx|css|html|yml|yaml)$/);
        if (nameMatch && !filePaths.includes(f)) {
          filePaths.push(f);
        }
      });
    }

    const dirs = line.match(bareDirRe);
    if (dirs) {
      dirs.forEach(d => {
        // Skip if it looks like a file path (has extension)
        if (d.match(/\.\w{1,4}$/)) return;
        if (!dirPaths.includes(d)) dirPaths.push(d);
      });
    }
  });

  return { filePaths, dirPaths };
}

function buildCoverageMap(runs) {
  // path -> [{ runId, ticketId, operation, status }]
  const map = {};
  runs.forEach(r => {
    const snapshot = readRunReplaySnapshot(r) || r.replaySnapshot || {};
    const ops = snapshot.workspaceOperations || [];
    ops.forEach(o => {
      const op = o.operation && o.operation.operation;
      if (op !== 'writeFile' && op !== 'createFolder') return;
      const p = o.operation.args.path;
      if (!p) return;
      if (!map[p]) map[p] = [];
      map[p].push({
        runId: r.id,
        ticketId: r.ticketId,
        operation: op,
        status: r.status,
      });
    });
  });
  return map;
}

function matchCoverage(extracted, coverageMap) {
  // Match files
  const fileCoverage = extracted.filePaths.map(p => {
    const exact = coverageMap[p];
    if (exact) return { path: p, type: 'file', matched: true, by: exact };
    // Try suffix match: "tests/test.js" should match "ops-demo/tests/test.js"
    const suffix = Object.keys(coverageMap).filter(k => k.endsWith('/' + p) || k.endsWith(p));
    if (suffix.length > 0) {
      const by = suffix.flatMap(k => coverageMap[k]);
      return { path: p, type: 'file', matched: true, by };
    }
    return { path: p, type: 'file', matched: false, by: [] };
  });

  // Match directories
  const dirCoverage = extracted.dirPaths.map(p => {
    const exact = coverageMap[p];
    if (exact) return { path: p, type: 'dir', matched: true, by: exact };
    // For dirs, check if any writeFile or createFolder starts with this path
    const prefix = Object.keys(coverageMap).filter(k => k.startsWith(p + '/') || k.startsWith(p));
    if (prefix.length > 0) {
      const by = prefix.flatMap(k => coverageMap[k]);
      return { path: p, type: 'dir', matched: true, by };
    }
    return { path: p, type: 'dir', matched: false, by: [] };
  });

  return { fileCoverage, dirCoverage };
}

async function cmdCoverage(args) {
  const ticketId = parseInt(args._[0], 10);
  if (!ticketId) return console.log(red('Usage: oquery coverage <ticket-id>'));

  const data = args.api ? await fetchRemoteData(args) : loadAll();
  const ticket = data.tickets.find(t => t.id === ticketId);
  if (!ticket) return console.log(red(`Ticket T${ticketId} not found.`));

  const extracted = extractTicketPaths(ticket.objective);
  const coverageMap = buildCoverageMap(data.runs);
  const coverage = matchCoverage(extracted, coverageMap);

  const total = coverage.fileCoverage.length + coverage.dirCoverage.length;
  const covered = coverage.fileCoverage.filter(c => c.matched).length +
    coverage.dirCoverage.filter(c => c.matched).length;

  if (args.json) {
    const payload = {
      ticketId,
      extracted,
      coverage,
      summary: { covered, total },
    };
    if (total === 0) payload.extractionStatus = 'no_paths_extracted';
    return console.log(JSON.stringify(payload, null, 2));
  }

  const headerMsg = total === 0
    ? `no explicit paths extracted`
    : `${covered}/${total} paths covered`;
  console.log(`\n  ${bold(`Coverage for T${ticketId}`)} — ${headerMsg}\n`);

  // File paths
  if (coverage.fileCoverage.length > 0) {
    console.log(`  ${bold('Files:')}`);
    coverage.fileCoverage.forEach(c => {
      if (c.matched) {
        const provenance = c.by.map(entry =>
          `T${entry.ticketId} R${entry.runId} ${entry.operation} ${statusTag(entry.status)}`
        ).join('\n             ');
        console.log(`  ${green('✓')} ${c.path}`);
        console.log(`       ${dim(provenance)}`);
      } else {
        console.log(`  ${red('✗')} ${c.path}  ${dim('(not written)')}`);
      }
    });
    console.log('');
  }

  // Directory paths
  if (coverage.dirCoverage.length > 0) {
    console.log(`  ${bold('Directories:')}`);
    coverage.dirCoverage.forEach(c => {
      if (c.matched) {
        const provenance = c.by.map(entry =>
          `T${entry.ticketId} R${entry.runId} ${entry.operation} ${statusTag(entry.status)}`
        ).join('\n             ');
        console.log(`  ${green('✓')} ${c.path}/`);
        console.log(`       ${dim(provenance)}`);
      } else {
        console.log(`  ${red('✗')} ${c.path}/  ${dim('(not created)')}`);
      }
    });
    console.log('');
  }
}

async function cmdSearch(args) {
  const q = args._.join(' ') || args.query || '';
  if (!q) return console.log(red('Usage: oquery search <text>'));

  const data = args.api ? await fetchRemoteData(args) : loadAll();
  const limit = parseInt(args.limit || '10');
  const query = q.toLowerCase();
  let results = [];

  // Search tickets
  data.tickets.forEach(t => {
    const obj = (t.objective || '').toLowerCase();
    if (obj.includes(query)) {
      results.push({ type: 'ticket', id: t.id, source: `data/tickets.json`, preview: truncate(t.objective.replace(/\r?\n/g, '\\n'), 120), ref: `T${t.id}` });
    }
  });

  // Search runs
  data.runs.forEach(r => {
    if (r.error && r.error.toLowerCase().includes(query)) {
      results.push({ type: 'run', id: r.id, source: `data/runs.json`, preview: truncate(r.error, 120), ref: `R${r.id} error` });
    }
    if (r.allocationSubtask && r.allocationSubtask.toLowerCase().includes(query)) {
      results.push({ type: 'run', id: r.id, source: `data/runs.json`, preview: truncate(r.allocationSubtask, 120), ref: `R${r.id} subtask` });
    }
  });

  // Search history (mutations)
  data.history.forEach(h => {
    const p = h.args ? (h.args.path || '') : '';
    if (p.toLowerCase().includes(query)) {
      results.push({ type: 'mutation', id: h.id, source: `data/operation-history.json`, preview: `${h.operation}: ${p}`, ref: `R${h.runId} step ${h.step}` });
    }
    if (h.error && h.error.toLowerCase().includes(query)) {
      results.push({ type: 'mutation', id: h.id, source: `data/operation-history.json`, preview: truncate(h.error, 120), ref: `R${h.runId}` });
    }
  });

  // Search logs
  data.logs.forEach(l => {
    const msg = (l.message || '') + ' ' + JSON.stringify(l.workspaceAction || '');
    if (msg.toLowerCase().includes(query)) {
      results.push({ type: 'log', id: l.id, source: `data/logs.json`, preview: truncate(l.message || '', 120), ref: l.runId ? `R${l.runId}` : '' });
    }
  });

  // Search plans
  data.plans.forEach(p => {
    (p.items || []).forEach(item => {
      if (item.allocationSubtask && item.allocationSubtask.toLowerCase().includes(query)) {
        results.push({ type: 'allocation', id: p.id, source: `data/allocation-plans.json`, preview: truncate(item.allocationSubtask, 120), ref: `T${p.ticketId} agent ${item.assignedAgentId}` });
      }
    });
  });

  results = results.slice(0, limit);

  if (args.json) return console.log(JSON.stringify(results, null, 2));

  if (results.length === 0) return console.log(dim(`No results for "${q}".`));

  console.log(`  ${bold(`${results.length} result(s)`)} for "${q}"\n`);
  results.forEach(r => {
    const typeTag = r.type === 'ticket' ? bold(`T${r.id}`) :
      r.type === 'run' ? cyan(`R${r.id}`) :
      r.type === 'mutation' ? yellow(`H${r.id}`) :
      r.type === 'log' ? dim(`L${r.id}`) : r.type;
    console.log(`  ${typeTag} ${dim(r.ref)}`);
    console.log(`       ${r.preview}`);
    console.log(`       ${dim(r.source)}`);
    console.log('');
  });

  if (results.length === limit) {
    console.log(`  ${dim('... more results may exist. Use --limit to increase.')}`);
  }
}

// ── Cookie / Auth helpers ──

function cookiePath() {
  return process.env.OPERC_COOKIE_PATH || path.join(ROOT, '.opercookie');
}

function readCookie() {
  try { return fs.readFileSync(cookiePath(), 'utf8').trim(); } catch (e) { return null; }
}

function saveCookie(value) {
  fs.writeFileSync(cookiePath(), value, 'utf8');
  console.log(`  ${green('✓')} Session cached to ${dim(cookiePath())}`);
}

function opercUrl() {
  return process.env.OPERC_URL || 'http://localhost:3099';
}

function prompt(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, answer => { rl.close(); resolve(answer); }));
}

function httpReq(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: opts.headers || {},
    };
    if (opts.body) options.headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = http.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function cmdLogin(args) {
  const url = args.url || opercUrl();
  let username = process.env.OPERC_USERNAME;
  let password = process.env.OPERC_PASSWORD;

  if (!username) username = await prompt('Username: ');
  if (!password) password = await prompt('Password: ');

  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const res = await httpReq('POST', `${url}/login`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (res.status === 302) {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const match = cookieStr.match(/sessionId=([^;]+)/);
      if (match) {
        saveCookie(match[1]);
        console.log(`  ${green('✓')} Login successful (${username} @ ${url})`);
        return;
      }
    }
    console.log(red('  ✗ Login succeeded but no session cookie received'));
  } else {
    console.log(red(`  ✗ Login failed (HTTP ${res.status})`));
    if (res.body) console.log(`    ${dim(res.body.slice(0, 200))}`);
  }
}

function createTicketSummary(ticket, run, agent) {
  return {
    ticketId: ticket ? ticket.id : 0,
    runId: run ? run.id : 0,
    status: run ? run.status : ticket ? ticket.status : 'unknown',
    agent: agent ? agent.name : run ? run.agentName : null
  };
}

async function fetchTicketAndRun(url, cookie, fallbackObjective = null) {
  const listRes = await httpReq('GET', `${url}/api/tickets`, {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  if (listRes.status !== 200) return { ticket: null, run: null };

  const ticketData = JSON.parse(listRes.body);
  const tickets = ticketData.tickets || ticketData;
  const matchingTickets = fallbackObjective
    ? tickets.filter(ticket => ticket.objective === fallbackObjective)
    : tickets;
  const ticket = matchingTickets.length > 0
    ? matchingTickets.reduce((a, b) => (a.id > b.id ? a : b))
    : tickets.reduce((a, b) => (a.id > b.id ? a : b), null);
  if (!ticket) return { ticket: null, run: null };

  const exportRes = await httpReq('GET', `${url}/api/export`, {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  if (exportRes.status !== 200) return { ticket, run: null };

  const data = JSON.parse(exportRes.body);
  const runs = (data.runs || [])
    .filter(run => run.ticketId === ticket.id)
    .sort((a, b) => (a.id || 0) - (b.id || 0));
  return { ticket, run: runs.length > 0 ? runs[runs.length - 1] : null };
}

async function waitForCreatedTicketRun(url, cookie, ticketId) {
  const terminal = new Set(['completed', 'failed', 'interrupted', 'resumable_pending']);
  const started = Date.now();
  const timeoutMs = 300000;
  let latest = { ticket: null, run: null };

  while (Date.now() - started < timeoutMs) {
    const exportRes = await httpReq('GET', `${url}/api/export`, {
      headers: { 'Cookie': `sessionId=${cookie}` }
    });
    if (exportRes.status === 200) {
      const data = JSON.parse(exportRes.body);
      const ticket = (data.tickets || []).find(item => item.id === ticketId) || null;
      const runs = (data.runs || [])
        .filter(run => run.ticketId === ticketId)
        .sort((a, b) => (a.id || 0) - (b.id || 0));
      const run = runs.length > 0 ? runs[runs.length - 1] : null;
      latest = { ticket, run };
      if (ticket && ['completed', 'failed'].includes(ticket.status) && run && terminal.has(run.status)) {
        return latest;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return latest;
}

async function cmdCreateTicket(args) {
  const cookie = readCookie();
  if (!cookie) {
    const message = 'Not logged in. Run oquery login first.';
    if (args.json) return console.log(JSON.stringify({ error: 'not_authenticated', message }, null, 2));
    return console.log(red('  ✗ Not logged in. Run') + ` ${bold('oquery login')} ${red('first.')}`);
  }

  const objective = args._.join(' ');
  if (!objective) {
    const message = 'Usage: oquery create-ticket [--agent <id|name>] [--wait] [--json] <objective>';
    if (args.json) return console.log(JSON.stringify({ error: 'missing_objective', message }, null, 2));
    return console.log(red(message));
  }

  const url = args.url || opercUrl();
  const agent = resolveLocalAgent(args.agent || '1');
  if (!agent) {
    const message = `Agent not found: ${args.agent}`;
    if (args.json) return console.log(JSON.stringify({ error: 'agent_not_found', message }, null, 2));
    return console.log(red(`  ✗ ${message}`));
  }

  // POST to create ticket
  const body = `objective=${encodeURIComponent(objective)}&assignmentTargetType=agent&assignmentTargetId=${encodeURIComponent(String(agent.id))}&assignmentMode=individual`;
  const res = await httpReq('POST', `${url}/tickets`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `sessionId=${cookie}`,
    },
    body
  });

  if (res.status === 302) {
    let { ticket, run } = await fetchTicketAndRun(url, cookie, objective);
    if (args.wait && ticket) {
      ({ ticket, run } = await waitForCreatedTicketRun(url, cookie, ticket.id));
    }
    const summary = createTicketSummary(ticket, run, agent);
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (ticket) {
      console.log(`  ${green('✓')} Ticket T${ticket.id} created on ${url} (${statusTag(ticket.status)}) assigned to ${agent.name || `Agent ${agent.id}`}${run ? `, run R${run.id} ${statusTag(run.status)}` : ''}`);
      return;
    }
    console.log(`  ${green('✓')} Ticket created (HTTP ${res.status})`);
  } else if (res.status === 401 || res.status === 403) {
    const message = 'Session expired or permission denied. Run oquery login again.';
    if (args.json) return console.log(JSON.stringify({ error: 'permission_denied', message }, null, 2));
    console.log(red('  ✗ Session expired or permission denied. Run') + ` ${bold('oquery login')} ${red('again.')}`);
  } else {
    if (args.json) return console.log(JSON.stringify({ error: 'create_failed', status: res.status, body: res.body ? res.body.slice(0, 300) : null }, null, 2));
    console.log(red(`  ✗ Failed (HTTP ${res.status})`));
    if (res.body) console.log(`    ${dim(res.body.replace(/<[^>]+>/g, '').slice(0, 300))}`);
  }
}

async function cmdStats(args) {
  const data = args && args.api ? await fetchRemoteData(args) : loadAll();
  const ticketsByStatus = {};
  data.tickets.forEach(t => { ticketsByStatus[t.status] = (ticketsByStatus[t.status] || 0) + 1; });
  const runsByStatus = {};
  data.runs.forEach(r => { runsByStatus[r.status] = (runsByStatus[r.status] || 0) + 1; });

  const totalMutations = data.history.filter(h => h.operation !== 'listDirectory' && h.operation !== 'readFile').length;
  const totalReads = data.history.filter(h => h.operation === 'listDirectory' || h.operation === 'readFile').length;
  const totalCreates = data.history.filter(h => h.operation === 'createFolder').length;
  const totalWrites = data.history.filter(h => h.operation === 'writeFile').length;
  const uniquePaths = new Set(data.history.map(h => h.args ? h.args.path : '').filter(Boolean));
  const pathCountByOp = {};
  data.history.forEach(h => {
    const p = h.args ? h.args.path : '';
    if (!p) return;
    if (!pathCountByOp[h.operation]) pathCountByOp[h.operation] = new Set();
    pathCountByOp[h.operation].add(p);
  });
  const opsBreakdown = {
    createFolder: totalCreates,
    writeFile: totalWrites,
    readFile: data.history.filter(h => h.operation === 'readFile').length,
    listDirectory: data.history.filter(h => h.operation === 'listDirectory').length,
    deletePath: data.history.filter(h => h.operation === 'deletePath').length,
    renamePath: data.history.filter(h => h.operation === 'renamePath').length,
  };
  const uniquePathsByOp = {};
  Object.entries(pathCountByOp).forEach(([op, paths]) => { uniquePathsByOp[op] = paths.size; });

  if (args.json) {
    return console.log(JSON.stringify({
      tickets: { total: data.tickets.length, byStatus: ticketsByStatus },
      runs: { total: data.runs.length, byStatus: runsByStatus },
      mutations: totalMutations,
      reads: totalReads,
      uniquePaths: uniquePaths.size,
      logEntries: data.logs.length,
      continuations: data.runs.filter(r => (r.replaySnapshot && r.replaySnapshot.continuationOf) || replaySummary(r).continuationOf).length,
      operationsBreakdown: opsBreakdown,
      uniquePathsByOperation: uniquePathsByOp,
    }, null, 2));
  }

  console.log(`\n  ${bold('Operational Statistics')}`);
  console.log(`  ${dim('─'.repeat(50))}`);
  console.log(`  ${'Tickets'.padEnd(20)} ${data.tickets.length}`);
  console.log(`  ${'Runs'.padEnd(20)} ${data.runs.length}`);
  console.log(`  ${'Mutations'.padEnd(20)} ${totalMutations}`);
  console.log(`  ${'Reads (list+read)'.padEnd(20)} ${totalReads}`);
  console.log(`  ${'Unique paths touched'.padEnd(20)} ${uniquePaths.size}`);
  console.log(`  ${'Log entries'.padEnd(20)} ${data.logs.length}`);
  console.log(`  ${'Continuations'.padEnd(20)} ${data.runs.filter(r => (r.replaySnapshot && r.replaySnapshot.continuationOf) || replaySummary(r).continuationOf).length}`);
  console.log('');

  console.log(`  ${bold('Tickets by status')}`);
  Object.entries(ticketsByStatus).forEach(([s, c]) => console.log(`    ${statusTag(s).padEnd(20)} ${c}`));
  console.log('');

  console.log(`  ${bold('Runs by status')}`);
  Object.entries(runsByStatus).forEach(([s, c]) => console.log(`    ${statusTag(s).padEnd(20)} ${c}`));
  console.log('');

  console.log(`  ${bold('Operations breakdown')}`);
  Object.entries(opsBreakdown).forEach(([op, count]) => console.log(`    ${op.padEnd(20)} ${count}`));
  console.log('');

  console.log(`  ${bold('Unique paths by operation')}`);
  Object.entries(uniquePathsByOp).forEach(([op, count]) => console.log(`    ${op.padEnd(20)} ${count}`));
  console.log('');
}

// ── Operator action commands (headless equivalents of UI controls) ──

// List agents from the local store so an operator can discover the id/name to
// assign without reading raw agents.json. Never prints provider API keys.
function cmdAgents(args) {
  const agents = readJson('agents.json');
  if (args.json) {
    console.log(JSON.stringify(agents.map(a => ({
      id: a.id, name: a.name || `Agent ${a.id}`, provider: a.provider || null, model: a.model || null
    })), null, 2));
    return;
  }
  if (!agents.length) {
    console.log(dim('  No agents in the local store.'));
    return;
  }
  console.log(`  ${bold('Agents')}`);
  for (const a of agents) {
    const name = a.name || `Agent ${a.id}`;
    const pm = `${a.provider || '?'}/${a.model || '?'}`;
    console.log(`    ${cyan('A' + a.id)}  ${bold(name)}  ${dim(pm)}`);
  }
  console.log(dim('\n  Assign with: oquery create-ticket --agent <id|name> "<objective>"'));
}

// Shared helper for authenticated mutating POSTs. Returns { status, data }.
async function postOperatorAction(url, cookie, routePath, body) {
  const headers = { 'Cookie': `sessionId=${cookie}` };
  if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await httpReq('POST', `${url}${routePath}`, { headers, body });
  let data = null;
  try { data = res.body ? JSON.parse(res.body) : null; } catch (e) { data = null; }
  return { status: res.status, data };
}

function requireSession(args) {
  const cookie = readCookie();
  if (!cookie) {
    const message = 'Not logged in. Run oquery login first.';
    if (args.json) console.log(JSON.stringify({ error: 'not_authenticated', message }, null, 2));
    else console.log(red('  ✗ Not logged in. Run') + ` ${bold('oquery login')} ${red('first.')}`);
    return null;
  }
  return cookie;
}

// Truthfully report a non-2xx operator-action response. Never invents success.
function reportActionError(args, status, data) {
  const message = (data && data.error) || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    if (args.json) return console.log(JSON.stringify({ error: 'permission_denied', status, message }, null, 2));
    return console.log(red('  ✗ ' + message + '. If your session expired, run') + ` ${bold('oquery login')} ${red('again.')}`);
  }
  if (args.json) return console.log(JSON.stringify({ error: 'action_rejected', status, message }, null, 2));
  console.log(red(`  ✗ ${message}`));
}

// Stop an active run (UI "Stop Run"). POST /api/runs/:id/stop
async function cmdStop(args) {
  const runId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(runId)) return console.log(red('Usage: oquery stop <runId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await postOperatorAction(url, cookie, `/api/runs/${runId}/stop`);
  if (status === 200 && data && data.run) {
    if (args.json) return console.log(JSON.stringify({ runId, action: 'stop', status: data.run.status }, null, 2));
    console.log(`  ${green('✓')} Stop requested for Run #${runId}.`);
    console.log(`  Run is now ${statusTag(data.run.status)}.`);
    console.log(dim(`  Next: oquery runs --id ${runId}`));
    return;
  }
  reportActionError(args, status, data);
}

// Retry a failed/interrupted run (UI "Retry"). POST /api/runs/:id/retry
async function cmdRetry(args) {
  const runId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(runId)) return console.log(red('Usage: oquery retry <runId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await postOperatorAction(url, cookie, `/api/runs/${runId}/retry`);
  if (status === 200 && data && data.ticket) {
    const t = data.ticket;
    if (args.json) return console.log(JSON.stringify({ runId, action: 'retry', ticketId: t.id, ticketStatus: t.status }, null, 2));
    console.log(`  ${green('✓')} Retry requested for Run #${runId}.`);
    console.log(`  Ticket #${t.id} reopened and a new run started (${statusTag(t.status)}).`);
    console.log(dim(`  Next: oquery runs --ticket ${t.id}`));
    return;
  }
  reportActionError(args, status, data);
}

// Rerun a ticket from the beginning (UI "Rerun"). POST /api/tickets/:id/rerun
async function cmdRerun(args) {
  const ticketId = parseInt(args._[0] || args.ticket, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery rerun <ticketId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const mode = args.reassess ? 'reassess' : 'retry';
  const { status, data } = await postOperatorAction(url, cookie, `/api/tickets/${ticketId}/rerun`, `mode=${mode}`);
  if (status === 200 && data && data.ticket) {
    const t = data.ticket;
    if (args.json) return console.log(JSON.stringify({ ticketId: t.id, action: 'rerun', mode, ticketStatus: t.status }, null, 2));
    console.log(`  ${green('✓')} Rerun requested for Ticket #${ticketId} (mode: ${mode}).`);
    console.log(`  Ticket reopened and a new run started (${statusTag(t.status)}).`);
    console.log(dim(`  Next: oquery runs --ticket ${t.id}`));
    return;
  }
  reportActionError(args, status, data);
}

// ── Main ──

function help() {
  console.log(`
  ${bold('oquery')} — operational query tool

  ${bold('Commands:')}
    tickets         List/search tickets
      --status <s>    Filter by status (completed/failed)
      --search <q>    Search ticket objectives
      --limit <n>     Max results
      --json          Raw JSON output
      --api           Query remote server substrate

    runs            List/search runs
      --ticket <id>   Filter by ticket
      --status <s>    Filter by status
      --agent <id>    Filter by agent
      --id <id>       Specific run
      --limit <n>     Max results
      --json          Raw JSON output
      --api           Query remote server substrate

    logs            Search log entries
      --run <id>      Filter by run
      --ticket <id>   Filter by ticket
      --type <t>      Filter by log type
      --search <q>    Search message text
      --limit <n>     Max results
      --json          Raw JSON output
      --api           Query remote server substrate

    mutations       Search operation history
      --run <id>      Filter by run
      --ticket <id>   Filter by ticket
      --op <op>       Filter by operation (createFolder, writeFile, etc.)
      --path <p>      Filter by path
      --limit <n>     Max results
      --json          Raw JSON output
      --api           Query remote server substrate

    replay <id>     Full replay for a run (steps, ops, lineage)
      --api           Query remote server substrate

     failures        Show failure context for failed runs
      --ticket <id>   Filter by ticket
      --run <id>      Specific run
      --type <t>      Filter by type (budget_exhausted, invalid_action, workspace_error, provider_error, timeout, interrupted)
      --limit <n>     Max results
      --json          Raw JSON output (full context)
      --api           Query remote server substrate

    coverage <id>    Show cross-ticket path coverage
                     Extracts paths from ticket items, matches against
                     all writeFile/createFolder operations across runs.
                     Reports which paths are covered and by which tickets.
      --json          Raw JSON output
      --api           Query remote server substrate

    search <q>      Search across all data sources
      --limit <n>     Max results per source
      --json          Raw JSON output
      --api           Query remote server substrate

    stats           Show operational statistics
      --api           Query remote server substrate

    agents          List agents from the local store (id, name, provider/model)
                      Use the id/name with create-ticket --agent
      --json          Raw JSON output

  ${bold('Operator Actions:')}
    login           Authenticate and cache session
                      Env: OPERC_URL, OPERC_USERNAME, OPERC_PASSWORD
                      OPERC_COOKIE_PATH overrides the cached-session file
                      (default: .opercookie) — set it to isolate sessions
                      Prompts interactively if env vars not set

    stop <runId>    Stop an active (pending/running) run
                      Reflects the API response; reports clearly if not active
      --json          Raw JSON output

    retry <runId>   Retry a failed/interrupted run (reopens the ticket)
      --json          Raw JSON output

    rerun <ticketId>
                    Rerun a ticket from the beginning
      --reassess      Use reassess mode instead of retry
      --json          Raw JSON output

    create-ticket <objective>
                    Create a new ticket via API
                      Uses cached session (run 'login' first)
                      Defaults to agent-1, individual mode
                      Prints created ticket id and status
      --agent <id|name>
                      Assign to agent id or local agent name
      --wait          Poll until the created ticket/run reaches terminal state
      --json          Print {"ticketId", "runId", "status", "agent"}
      --url <url>     Server base URL

  ${bold('Examples:')}
    node scripts/oquery.js runs --ticket 5
    node scripts/oquery.js runs --status failed --limit 5
    node scripts/oquery.js mutations --path test-medium
    node scripts/oquery.js replay 8
    node scripts/oquery.js search "F17"
    node scripts/oquery.js logs --type workspace:create --limit 10
    node scripts/oquery.js failures --ticket 8
    node scripts/oquery.js failures --type invalid_action
    node scripts/oquery.js failures --run 4 --json
    node scripts/oquery.js coverage 3
    node scripts/oquery.js coverage 5 --json
    node scripts/oquery.js stats
    node scripts/oquery.js agents
    node scripts/oquery.js stop 4
    node scripts/oquery.js retry 3
    node scripts/oquery.js rerun 1
`);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h') return help();

  const boolFlags = new Set(['api', 'json', 'help', 'h', 'wait', 'reassess']);
  const args = { _: [] };
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        args[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      } else {
        const key = a.slice(2);
        if (boolFlags.has(key)) {
          args[key] = true;
        } else {
          const next = process.argv[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            args[key] = next;
            i++;
          } else {
            args[key] = true;
          }
        }
      }
    } else {
      args._.push(a);
    }
  }

  const cmds = {
    tickets: cmdTickets,
    runs: cmdRuns,
    logs: cmdLogs,
    mutations: cmdMutations,
    replay: cmdReplay,
    failures: cmdFailures,
    coverage: cmdCoverage,
    search: cmdSearch,
    stats: cmdStats,
    agents: cmdAgents,
  };

  if (cmd === 'login') {
    await cmdLogin(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'create-ticket') {
    await cmdCreateTicket(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'stop') {
    await cmdStop(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'retry') {
    await cmdRetry(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'rerun') {
    await cmdRerun(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmds[cmd]) {
    if (!args.json) {
      console.log(sourceLabelLine(args));
      await printDivergenceWarning(args);
    }
    await cmds[cmd](args);
  } else {
    console.log(`Unknown command: ${cmd}`);
    help();
  }
}

main();
