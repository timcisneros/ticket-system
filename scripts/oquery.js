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

// Render the internal outcome code as a truthful operator-facing label. The
// codes are kept internally for logic/comparison; only the display text here is
// reworded so the CLI does not over-claim objective verification.
function outcomeTag(s) {
  if (s === 'completed_with_verified_postcondition') return green('completed — postconditions checked');
  if (s === 'completed_with_mutations') return green('completed — changes applied');
  if (s === 'completed_noop') return yellow('completed — no workspace change needed');
  if (s === 'impossible_within_boundary') return yellow('could not complete in workspace');
  if (s === 'blocked/rejected') return red('blocked');
  if (s === 'failed_execution') return red('failed');
  if (s === 'interrupted') return yellow('stopped');
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
    const cookie = readCookie();
    const headers = cookie ? { Cookie: `sessionId=${cookie}` } : {};
    const res = await httpReq('GET', `${url}/api/runtime/identity`, { headers });
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

// Shared helper for authenticated JSON PATCH/POST calls. Returns { status, data }.
async function operatorJsonCall(url, cookie, method, routePath, jsonBody) {
  const headers = { 'Cookie': `sessionId=${cookie}`, 'Content-Type': 'application/json' };
  const body = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
  const res = await httpReq(method, `${url}${routePath}`, { headers, body });
  let data = null;
  try { data = res.body ? JSON.parse(res.body) : null; } catch (e) { data = null; }
  return { status: res.status, data };
}

// Shared helper for authenticated GET requests. Returns { status, data }.
async function operatorGetCall(url, cookie, routePath) {
  const headers = { 'Cookie': `sessionId=${cookie}` };
  const res = await httpReq('GET', `${url}${routePath}`, { headers });
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

// Reassign a ticket to a different agent. PATCH /api/tickets/:id/assignment
async function cmdAssignTicket(args) {
  const ticketId = parseInt(args._[0] || args.ticket, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery assign-ticket <ticketId> --agent <id|name>'));
  const agentValue = args.agent;
  if (!agentValue) return console.log(red('Usage: oquery assign-ticket <ticketId> --agent <id|name>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const agent = resolveLocalAgent(agentValue);
  if (!agent) return console.log(red(`  ✗ Agent not found: ${agentValue}`));
  const { status, data } = await operatorJsonCall(url, cookie, 'PATCH', `/api/tickets/${ticketId}/assignment`, { agentId: agent.id });
  if (status === 200 && data && data.ticket) {
    const t = data.ticket;
    if (args.json) return console.log(JSON.stringify({ ticketId: t.id, action: 'assign', agentId: agent.id, status: t.status }, null, 2));
    console.log(`  ${green('✓')} Ticket #${ticketId} reassigned to ${agent.name || `Agent ${agent.id}`} (${statusTag(t.status)}).`);
    console.log(dim(`  Next: oquery runs --ticket ${ticketId}`));
    return;
  }
  reportActionError(args, status, data);
}

// Update ticket status manually. PATCH /api/tickets/:id/status
async function cmdUpdateTicket(args) {
  const ticketId = parseInt(args._[0] || args.ticket, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery update-ticket <ticketId> --status <open|in_progress|completed|failed|blocked|closed>'));
  const status = args.status;
  if (!status || !['open', 'in_progress', 'completed', 'failed', 'blocked', 'closed'].includes(status)) {
    return console.log(red('Usage: oquery update-ticket <ticketId> --status <open|in_progress|completed|failed|blocked|closed>'));
  }
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status: httpStatus, data } = await operatorJsonCall(url, cookie, 'PATCH', `/api/tickets/${ticketId}/status`, { status });
  if (httpStatus === 200 && data && data.ticket) {
    const t = data.ticket;
    if (args.json) return console.log(JSON.stringify({ ticketId: t.id, action: 'update-status', status: t.status }, null, 2));
    console.log(`  ${green('✓')} Ticket #${ticketId} status updated to ${statusTag(t.status)}.`);
    console.log(dim(`  Next: oquery tickets --id ${ticketId}`));
    return;
  }
  if (httpStatus === 409 && data && data.error) {
    if (args.json) return console.log(JSON.stringify({ error: 'action_rejected', status: httpStatus, message: data.error }, null, 2));
    return console.log(red(`  ✗ ${data.error}`));
  }
  reportActionError(args, httpStatus, data);
}

// Resolve triage on a ticket or run. POST /api/tickets/:id/triage/resolve, POST /api/runs/:id/triage/resolve
async function cmdResolveTriage(args) {
  const ticketId = args.ticket ? parseInt(args.ticket, 10) : NaN;
  const runId = args.run ? parseInt(args.run, 10) : NaN;
  if ((Number.isNaN(ticketId) && Number.isNaN(runId)) || (!Number.isNaN(ticketId) && !Number.isNaN(runId))) {
    return console.log(red('Usage: oquery resolve-triage --ticket <id> --reason <text>'));
  }
  if (!args.reason || !args.reason.trim()) {
    return console.log(red('Usage: oquery resolve-triage --ticket <id> --reason <text>'));
  }
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const route = !Number.isNaN(ticketId) ? `/api/tickets/${ticketId}/triage/resolve` : `/api/runs/${runId}/triage/resolve`;
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', route, { resolution: args.reason.trim() });
  if (status === 200) {
    const kind = !Number.isNaN(ticketId) ? 'Ticket' : 'Run';
    const id = !Number.isNaN(ticketId) ? ticketId : runId;
    if (args.json) return console.log(JSON.stringify({ [kind.toLowerCase() + 'Id']: id, action: 'resolve-triage', resolution: args.reason.trim() }, null, 2));
    console.log(`  ${green('✓')} ${kind} #${id} triage resolved.`);
    console.log(dim(`  Reason: ${args.reason.trim()}`));
    return;
  }
  if (status === 409 && data && data.error) {
    if (args.json) return console.log(JSON.stringify({ error: 'action_rejected', status, message: data.error }, null, 2));
    return console.log(red(`  ✗ ${data.error}`));
  }
  reportActionError(args, status, data);
}

// Manually trigger a process template. POST /api/process-templates/:id/trigger
async function cmdTriggerTemplate(args) {
  const templateId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(templateId)) return console.log(red('Usage: oquery trigger-template <templateId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await postOperatorAction(url, cookie, `/api/process-templates/${templateId}/trigger`);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ templateId, action: 'trigger', ticketId: data.ticketId, deduped: data.deduped }, null, 2));
    if (data.deduped) {
      console.log(`  ${yellow('○')} Template #${templateId} already triggered recently (deduped). Ticket #${data.ticketId}.`);
    } else {
      console.log(`  ${green('✓')} Template #${templateId} triggered. Ticket #${data.ticketId} created.`);
    }
    return;
  }
  reportActionError(args, status, data);
}

// Show full runtime state for a single ticket. GET /api/tickets/:id/runtime
async function cmdTicket(args) {
  const ticketId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery ticket <ticketId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/tickets/${ticketId}/runtime`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const ticket = data.ticket || {};
  const currentRun = data.currentRun;
  const latestRun = data.latestRun;
  console.log(`\n  ${bold(`Ticket #${ticketId}`)} ${statusTag(ticket.status)}`);
  console.log(`  ${dim('objective')} ${(ticket.objective || '').replace(/\r?\n/g, ' ')}`);
  if (ticket.assignmentTargetType) console.log(`  ${dim('assigned to')} ${ticket.assignmentTargetType} #${ticket.assignmentTargetId}`);
  if (latestRun) console.log(`  ${dim('latest run')} #${latestRun.id} ${statusTag(latestRun.status)} agent: ${latestRun.agentName || latestRun.agentId}`);
  if (currentRun) console.log(`  ${dim('current run')} #${currentRun.id} ${statusTag(currentRun.status)}`);
  if (currentRun && currentRun.eventSummary) {
    const es = currentRun.eventSummary;
    if (es.currentStep) console.log(`  ${dim('step')} ${es.currentStep.stepId} ${es.currentStep.action || ''}`);
    if (es.latestError) console.log(`  ${red('error')} ${es.latestError.message}`);
  }
  if (data.outcomeLabel) console.log(`  ${dim('outcome')} ${data.outcomeLabel}`);
  if (data.leaseState) {
    const lease = data.leaseState;
    console.log(`  ${dim('lease')} owner: ${lease.owner || lease.leaseOwner || '?'} expires: ${lease.expiresAt ? datetime(lease.expiresAt) : '?'}`);
  }
  if (data.runStateInconsistency) console.log(`  ${yellow('inconsistency')} ${data.runStateInconsistency}`);
  if (ticket.createdAt) console.log(`  ${dim('created')} ${datetime(ticket.createdAt)}`);
  console.log('');
}

// Show chronological timeline for a ticket. GET /api/tickets/:id/timeline
async function cmdTimeline(args) {
  const ticketId = parseInt(args._[0] || args.ticket, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery timeline <ticketId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/tickets/${ticketId}/timeline`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const entries = data.entries || [];
  if (entries.length === 0) return console.log(dim(`  No timeline entries for Ticket #${ticketId}.`));
  console.log(`\n  ${bold(`Timeline for Ticket #${ticketId}`)}  ${dim(entries.length + ' entries')}`);
  entries.forEach(e => {
    const ts = datetime(e.timestamp);
    const type = e.type || e.sourceType || '';
    const src = e.sourceRef ? dim(e.sourceRef) : '';
    const title = (e.title || '').substring(0, 100);
    const statusInfo = e.status ? statusTag(e.status) : '';
    console.log(`  ${dim(ts)} ${type} ${statusInfo} ${title} ${src}`);
  });
  console.log('');
}

// Show events for a run. GET /api/runs/:id/events
async function cmdEvents(args) {
  const runId = parseInt(args.run || args._[0], 10);
  if (Number.isNaN(runId)) return console.log(red('Usage: oquery events --run <runId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/runs/${runId}/events`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const events = data.events || [];
  const summary = data.summary || {};
  console.log(`\n  ${bold(`Events for Run #${runId}`)}  ${dim(events.length + ' events')}`);
  if (summary.currentStep) console.log(`  ${dim('current step')} ${summary.currentStep.stepId} ${summary.currentStep.action || ''}`);
  if (summary.latestStatus) console.log(`  ${dim('status')} ${summary.latestStatus.type} ${statusTag(summary.latestStatus.status)}`);
  if (summary.latestError) console.log(`  ${red('error')} ${summary.latestError.message}`);
  if (events.length > 0) {
    const limit = args.limit ? parseInt(args.limit) : 50;
    const display = events.slice(-limit);
    display.forEach(e => {
      const ts = datetime(e.timestamp);
      const type = e.type || '';
      const msg = e.message || e.payload ? JSON.stringify(e.payload).substring(0, 80) : '';
      console.log(`  ${dim(ts)} ${type} ${dim(msg)}`);
    });
    if (events.length > limit) console.log(`  ${dim('... ' + (events.length - limit) + ' more. Use --limit to show more.')}`);
  }
  console.log('');
}

// Show serialized run state. GET /api/runs/:id/state
async function cmdRunState(args) {
  const runId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(runId)) return console.log(red('Usage: oquery run-state <runId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/runs/${runId}/state`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`\n  ${bold(`Run #${runId}`)} ${statusTag(data.status)}`);
  if (data.agentName) console.log(`  ${dim('agent')} ${data.agentName}  ${dim('model')} ${data.executionMode || data.agentId || ''}`);
  if (data.ticketId) console.log(`  ${dim('ticket')} #${data.ticketId}`);
  if (data.createdAt) console.log(`  ${dim('created')} ${datetime(data.createdAt)}`);
  if (data.startedAt) console.log(`  ${dim('started')} ${datetime(data.startedAt)}`);
  if (data.completedAt) console.log(`  ${dim('completed')} ${datetime(data.completedAt)}`);
  if (data.error) console.log(`  ${red(data.error)}`);
  if (data.replaySummary) {
    const rs = data.replaySummary;
    const mutCount = rs.mutationCount !== undefined ? rs.mutationCount : '?';
    console.log(`  ${dim('mutations')} ${mutCount}  ${dim('steps')} ${rs.currentStepIndex || rs.executionStepCount || '?'}`);
  }
  if (data.eventSummary) {
    const es = data.eventSummary;
    if (es.currentStep) console.log(`  ${dim('step')} ${es.currentStep.stepId} ${es.currentStep.action || ''}`);
    if (es.latestError) console.log(`  ${red('error')} ${es.latestError.message}`);
  }
  if (data.outcomeLabel) console.log(`  ${dim('outcome')} ${data.outcomeLabel}`);
  if (data.lease) {
    const l = data.lease;
    console.log(`  ${dim('lease')} owner: ${l.owner || '?'}  expires: ${l.expiresAt ? datetime(l.expiresAt) : '?'}`);
  }
  if (data.budgetStatus) {
    const b = data.budgetStatus;
    console.log(`  ${dim('budget')} steps: ${b.usedSteps || 0}/${b.maxSteps || 'unlim'}  reqs: ${b.usedRequests || 0}/${b.maxRequests || 'unlim'}  ops: ${b.usedOps || 0}/${b.maxOps || 'unlim'}`);
  }
  if (data.attemptUsage) {
    const a = data.attemptUsage;
    console.log(`  ${dim('attempts')} ${a.currentAttempt || 0}/${a.maxAttempts || 'unlim'}`);
  }
  if (data.triage && data.triage.required) console.log(`  ${yellow('triage required')} ${data.triage.reasonCode || ''} ${data.triage.summary || ''}`);
  console.log('');
}

// Browse or read workspace files. GET /api/workspace/list, GET /api/workspace/file
async function cmdWorkspace(args) {
  const sub = (args._[0] || '').toLowerCase();
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  if (sub === 'ls') {
    const relPath = args._.slice(1).join('/') || '';
    const { status, data } = await operatorGetCall(url, cookie, `/api/workspace/list?path=${encodeURIComponent(relPath)}`);
    if (status !== 200 || !data) return reportActionError(args, status, data);
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    const entries = Array.isArray(data) ? data : (data.entries || data.children || data.files || []);
    if (entries.length === 0) return console.log(dim(`  Empty directory: ${relPath || '/'}`));
    console.log(`\n  ${bold('workspace/' + relPath)}  ${dim(entries.length + ' entries')}`);
    entries.forEach(e => {
      const name = e.name || e.path || '';
      const isDir = e.type === 'directory' || e.isDirectory || e.kind === 'directory' || (e.name && !e.name.includes('.') && e.type !== 'file');
      const size = e.size !== undefined ? ` ${dim('(' + e.size + 'b)')}` : '';
      console.log(`  ${isDir ? cyan(name + '/') : name}${size}`);
    });
    console.log('');
  } else if (sub === 'cat') {
    const relPath = args._.slice(1).join('/');
    if (!relPath) return console.log(red('Usage: oquery workspace cat <path>'));
    const { status, data } = await operatorGetCall(url, cookie, `/api/workspace/file?path=${encodeURIComponent(relPath)}`);
    if (status !== 200 || !data) return reportActionError(args, status, data);
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    console.log(data.content || '');
  } else if (sub === 'mkdir') {
    const relPath = args._.slice(1).join('/');
    if (!relPath) return console.log(red('Usage: oquery workspace mkdir <path>'));
    const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/workspace/folder', { path: relPath });
    if (status === 200) {
      if (args.json) return console.log(JSON.stringify({ action: 'mkdir', path: relPath }, null, 2));
      console.log(`  ${green('✓')} Created folder: ${relPath}`);
      return;
    }
    if (data && data.error) return console.log(red(`  ✗ ${data.error}`));
    reportActionError(args, status, data);
  } else if (sub === 'touch') {
    const relPath = args._.slice(1).join('/');
    if (!relPath) return console.log(red('Usage: oquery workspace touch <path>'));
    const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/workspace/file', { path: relPath });
    if (status === 200) {
      if (args.json) return console.log(JSON.stringify({ action: 'touch', path: relPath }, null, 2));
      console.log(`  ${green('✓')} Created file: ${relPath}`);
      return;
    }
    if (data && data.error) return console.log(red(`  ✗ ${data.error}`));
    reportActionError(args, status, data);
  } else if (sub === 'write') {
    const relPath = args._[1];
    const content = args._.slice(2).join(' ');
    if (!relPath || !content) return console.log(red('Usage: oquery workspace write <path> <content>'));
    const { status, data } = await operatorJsonCall(url, cookie, 'PATCH', '/api/workspace/file', { path: relPath, content });
    if (status === 200) {
      if (args.json) return console.log(JSON.stringify({ action: 'write', path: relPath }, null, 2));
      console.log(`  ${green('✓')} Wrote ${relPath} (${content.length} bytes)`);
      return;
    }
    if (data && data.error) return console.log(red(`  ✗ ${data.error}`));
    reportActionError(args, status, data);
  } else if (sub === 'mv') {
    const from = args._[1];
    const to = args._[2];
    if (!from || !to) return console.log(red('Usage: oquery workspace mv <from> <to>'));
    const { status, data } = await operatorJsonCall(url, cookie, 'PATCH', '/api/workspace/rename', { path: from, nextPath: to });
    if (status === 200) {
      if (args.json) return console.log(JSON.stringify({ action: 'rename', from, to }, null, 2));
      console.log(`  ${green('✓')} Renamed ${from} → ${to}`);
      return;
    }
    if (data && data.error) return console.log(red(`  ✗ ${data.error}`));
    reportActionError(args, status, data);
  } else if (sub === 'rm') {
    const relPath = args._.slice(1).join('/');
    if (!relPath) return console.log(red('Usage: oquery workspace rm <path>'));
    const { status, data } = await operatorJsonCall(url, cookie, 'DELETE', '/api/workspace', { path: relPath });
    if (status === 200) {
      if (args.json) return console.log(JSON.stringify({ action: 'delete', path: relPath }, null, 2));
      console.log(`  ${green('✓')} Deleted: ${relPath}`);
      return;
    }
    if (data && data.error) return console.log(red(`  ✗ ${data.error}`));
    reportActionError(args, status, data);
  } else {
    return console.log(red('Usage: oquery workspace ls [path] | cat <path> | mkdir <path> | touch <path> | write <path> <content> | mv <from> <to> | rm <path>'));
  }
}

// List all process templates. GET /api/process-templates
async function cmdTemplates(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, '/api/process-templates');
  if (status !== 200 || !data) return reportActionError(args, status, data);
  const list = data.templates || data;
  if (!Array.isArray(list)) return console.log(dim('  No process templates.'));
  if (args.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log(dim('  No process templates.'));
  console.log(`\n  ${bold('Process Templates')}  ${dim(list.length + ' total')}`);
  list.forEach(t => {
    const id = t.id || '?';
    const name = t.name || '(unnamed)';
    const enabled = t.enabled ? green('enabled') : red('disabled');
    const schedule = t.scheduleInterval ? dim(` schedule: ${t.scheduleInterval}`) : dim('no schedule');
    const version = t.activeVersionId ? dim(` v${t.activeVersionId}`) : '';
    console.log(`  ${bold('#' + id)} ${name}  ${enabled}${schedule}${version}`);
    if (t.objective) console.log(`       ${dim(truncate(t.objective, 100))}`);
  });
  console.log(dim('\n  Trigger with: oquery trigger-template <id>'));
}

// Create a handoff ticket. POST /api/tickets/:id/handoff
async function cmdHandoff(args) {
  const ticketId = parseInt(args._[0] || args.ticket, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery handoff <ticketId> --objective <text>'));
  const objective = args.objective || args._.slice(1).join(' ');
  if (!objective) return console.log(red('Usage: oquery handoff <ticketId> --objective <text>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = { objective: objective.trim() };
  if (args.agent) {
    const agent = resolveLocalAgent(args.agent);
    if (!agent) return console.log(red(`  ✗ Agent not found: ${args.agent}`));
    body.toAssignmentTargetType = 'agent';
    body.toAssignmentTargetId = agent.id;
  }
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/tickets/${ticketId}/handoff`, body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ ticketId, action: 'handoff', createdTicketId: data.createdTicketId }, null, 2));
    console.log(`  ${green('✓')} Handoff created. Ticket #${data.createdTicketId} created from #${ticketId}.`);
    console.log(dim(`  Next: oquery ticket ${data.createdTicketId}`));
    return;
  }
  reportActionError(args, status, data);
}

// Show runtime status snapshot. GET /api/runtime/status
async function cmdRuntimeStatus(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, '/api/runtime/status');
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const counts = data.counts || {};
  console.log(`\n  ${bold('Runtime Status')}`);
  console.log(`  ${dim('scheduler')} ${data.scheduler && data.scheduler.running ? green('running') : red('stopped')}`);
  console.log(`  ${dim('lease owner')} ${data.leaseOwner || 'none'}`);
  console.log(`  ${dim('active runs')} ${counts.active || 0}  ${dim('pending')} ${counts.pending || 0}  ${dim('running')} ${counts.running || 0}`);
  if (counts.expiredLeases) console.log(`  ${yellow('expired leases')} ${counts.expiredLeases}`);
  if (data.runtimeLimits) {
    const rl = data.runtimeLimits;
    console.log(`  ${dim('limits')} steps: ${rl.maxExecutionSteps || 'unlim'}  reqs: ${rl.maxModelRequestsPerRun || 'unlim'}  ops: ${rl.maxWorkspaceOperationsPerRun || 'unlim'}`);
  }
  console.log('');
}

// View or update runtime limits. GET/POST /api/runtime-limits
async function cmdRuntimeLimits(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const setFields = {};
  if (args.set) {
    const pairs = Array.isArray(args.set) ? args.set : [args.set];
    pairs.forEach(p => {
      const eq = p.indexOf('=');
      if (eq > 0) setFields[p.slice(0, eq)] = p.slice(eq + 1);
    });
  }
  if (Object.keys(setFields).length > 0) {
    const { status: ps, data: pd } = await operatorJsonCall(url, cookie, 'POST', '/api/runtime-limits', setFields);
    if (ps !== 200 || !pd) return reportActionError(args, ps, pd);
    if (args.json) return console.log(JSON.stringify(pd, null, 2));
    console.log(`  ${green('✓')} Runtime limits updated.`);
    const eff = pd.effectiveLimits || {};
    console.log(`  ${dim('effective limits')}`);
    console.log(`    maxExecutionSteps:          ${eff.maxExecutionSteps}`);
    console.log(`    maxModelRequestsPerRun:     ${eff.maxModelRequestsPerRun}`);
    console.log(`    maxWorkspaceOperationsPerRun: ${eff.maxWorkspaceOperationsPerRun}`);
    console.log(`    maxConsecutiveContinuations: ${eff.maxConsecutiveContinuations}`);
    console.log(`    maxExecutionTimeMs:          ${eff.maxExecutionTimeMs}`);
    return;
  }
  const { status: gs, data: gd } = await operatorGetCall(url, cookie, '/api/runtime-limits');
  if (gs !== 200 || !gd) return reportActionError(args, gs, gd);
  if (args.json) return console.log(JSON.stringify(gd, null, 2));
  const config = gd.config || {};
  const eff = gd.effectiveLimits || {};
  console.log(`\n  ${bold('Runtime Limits')}`);
  console.log(`  ${dim('config')}`);
  console.log(`    maxExecutionSteps:          ${config.maxExecutionSteps !== undefined ? config.maxExecutionSteps : '(default)'}`);
  console.log(`    maxModelRequestsPerRun:     ${config.maxModelRequestsPerRun !== undefined ? config.maxModelRequestsPerRun : '(default)'}`);
  console.log(`    maxWorkspaceOperationsPerRun: ${config.maxWorkspaceOperationsPerRun !== undefined ? config.maxWorkspaceOperationsPerRun : '(default)'}`);
  console.log(`    maxConsecutiveContinuations: ${config.maxConsecutiveContinuations !== undefined ? config.maxConsecutiveContinuations : '(default)'}`);
  console.log(`    maxExecutionTimeMs:          ${config.maxExecutionTimeMs !== undefined ? config.maxExecutionTimeMs : '(default)'}`);
  console.log(`  ${dim('effective (after deployment caps)')}`);
  console.log(`    maxExecutionSteps:          ${eff.maxExecutionSteps}`);
  console.log(`    maxModelRequestsPerRun:     ${eff.maxModelRequestsPerRun}`);
  console.log(`    maxWorkspaceOperationsPerRun: ${eff.maxWorkspaceOperationsPerRun}`);
  console.log(`    maxConsecutiveContinuations: ${eff.maxConsecutiveContinuations}`);
  console.log(`    maxExecutionTimeMs:          ${eff.maxExecutionTimeMs}`);
  if (gd.deploymentCaps) {
    console.log(`  ${dim('deployment caps')}`);
    Object.entries(gd.deploymentCaps).forEach(([k, v]) => {
      if (v !== undefined && v !== null) console.log(`    ${k}: ${v}`);
    });
  }
  console.log(dim('\n  Update with: oquery runtime-limits --set maxExecutionSteps=100'));
}

// Show operational summary. GET /api/ops/summary
async function cmdOpsSummary(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, '/api/ops/summary');
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const s = data.summary || {};
  console.log(`\n  ${bold('Operational Summary')}`);
  console.log(`  ${dim('tickets')} ${s.tickets ? `${s.tickets.total} total (${s.tickets.open} open, ${s.tickets.completed} completed, ${s.tickets.failed} failed, ${s.tickets.blocked} blocked)` : '?'}`);
  console.log(`  ${dim('runs')} ${s.runs ? `${s.runs.total} total (${s.runs.running} running, ${s.runs.completed} completed, ${s.runs.failed} failed)` : '?'}`);
  if (s.triage) console.log(`  ${dim('triage')} ${s.triage.unresolvedTicketCount || 0} tickets, ${s.triage.unresolvedRunCount || 0} runs unresolved`);
  if (s.workContexts) console.log(`  ${dim('work contexts')} ${s.workContexts.active} active, ${s.workContexts.archived} archived`);
  if (s.watchers) console.log(`  ${dim('watchers')} ${s.watchers.active} active, ${s.watchers.paused} paused, ${s.watchers.archived} archived`);
  if (s.connectors) console.log(`  ${dim('connectors')} ${s.connectors.active} active, ${s.connectors.paused} paused, ${s.connectors.archived} archived`);
  if (s.modelRoutingPolicies) console.log(`  ${dim('routing policies')} ${s.modelRoutingPolicies.active} active, ${s.modelRoutingPolicies.archived} archived`);
  if (s.processTemplates) console.log(`  ${dim('templates')} ${s.processTemplates.total} total (${s.processTemplates.enabled} enabled, ${s.processTemplates.scheduled} scheduled)`);
  if (s.warnings) {
    const active = Object.entries(s.warnings).filter(([, v]) => v === true).map(([k]) => k);
    if (active.length > 0) console.log(`  ${yellow('warnings')} ${active.join(', ')}`);
  }
  console.log('');
}

// Preview or execute operation recovery. GET /api/operations/:id/recovery-preview, POST /api/operations/:id/recover
async function cmdRecovery(args) {
  const opId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(opId)) return console.log(red('Usage: oquery recovery <operationId> [--confirm]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status: ps, data: pd } = await operatorGetCall(url, cookie, `/api/operations/${opId}/recovery-preview`);
  if (ps !== 200 || !pd) return reportActionError(args, ps, pd);
  if (args.json && !args.confirm) return console.log(JSON.stringify(pd, null, 2));
  const preview = pd.preview || pd;
  console.log(`\n  ${bold(`Operation #${opId} Recovery`)}  ${preview.status || 'unknown'}`);
  if (preview.proposedAction) {
    console.log(`  ${dim('proposed action')} ${JSON.stringify(preview.proposedAction)}`);
    console.log(`  ${dim('validation')} ${preview.validation && preview.validation.valid ? green('valid') : red('invalid')}  ${preview.validation ? preview.validation.reason || '' : ''}`);
    console.log(`  ${dim('can proceed')} ${preview.canProceed ? green('yes') : red('no')}`);
  } else {
    console.log(`  ${dim('no recovery action available')}`);
    if (preview.validation) console.log(`  ${dim('reason')} ${preview.validation.reason || 'unknown'}`);
  }
  if (args.confirm) {
    if (!preview.canProceed) return console.log(red('  ✗ Cannot proceed with recovery.') + ` ${dim('Use --json to see full details.')}`);
    const { status: rs, data: rd } = await operatorJsonCall(url, cookie, 'POST', `/api/operations/${opId}/recover`, { confirmed: true });
    if (rs === 200 && rd && rd.recovery) {
      if (args.json) return console.log(JSON.stringify({ operationId: opId, action: 'recover', recovery: rd.recovery }, null, 2));
      console.log(`  ${green('✓')} Operation #${opId} recovered. Recovery record #${rd.recovery.id || '?'}.`);
      return;
    }
    reportActionError(args, rs, rd);
    return;
  }
  console.log(dim(`\n  Execute with: oquery recovery ${opId} --confirm`));
}

// Set max attempts execution policy on a ticket. POST /api/tickets/:id/execution-policy/max-attempts
async function cmdMaxAttempts(args) {
  const ticketId = parseInt(args._[0] || args.ticket, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery max-attempts <ticketId> <n>'));
  const raw = args._[1] !== undefined ? args._[1] : null;
  const n = raw === 'clear' || raw === null ? null : parseInt(raw, 10);
  if (raw !== null && (n === null || Number.isNaN(n))) return console.log(red('Usage: oquery max-attempts <ticketId> <n|clear>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = { maxAttempts: n === null && raw === 'clear' ? 'clear' : n };
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/tickets/${ticketId}/execution-policy/max-attempts`, body);
  if (status === 200 && data) {
    if (args.json) return console.log(JSON.stringify({ ticketId, action: 'max-attempts', maxAttempts: data.maxAttempts }, null, 2));
    console.log(`  ${green('✓')} Ticket #${ticketId} maxAttempts set to ${data.maxAttempts === null ? 'unlimited' : data.maxAttempts}.`);
    return;
  }
  reportActionError(args, status, data);
}

// Simulate a plan for a ticket. POST /api/tickets/:id/simulate-plan
async function cmdSimulate(args) {
  const ticketId = parseInt(args._[0] || args.ticket, 10);
  if (Number.isNaN(ticketId)) return console.log(red('Usage: oquery simulate <ticketId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = { includeModelPlan: !args.gateOnly };
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/tickets/${ticketId}/simulate-plan`, body);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`\n  ${bold(`Simulation for Ticket #${ticketId}`)}`);
  console.log(`  ${dim('objective')} ${data.objective || ''}`);
  if (data.gateVerdict) console.log(`  ${dim('gate verdict')} ${statusTag(data.gateVerdict)}  ${data.reasonCode || ''}`);
  if (data.gateSummary) console.log(`  ${dim('gate summary')} ${data.gateSummary}`);
  if (data.simulatedAgent) console.log(`  ${dim('simulated agent')} ${data.simulatedAgent}`);
  if (data.modelCalled) {
    if (data.modelError) {
      console.log(`  ${red('model error')} ${data.modelError}`);
    } else {
      console.log(`  ${dim('model')} ${data.modelComplete ? green('complete') : 'incomplete'}  ${data.actionsProposed ? data.actionsProposed.length + ' actions proposed' : ''}`);
    }
  } else {
    console.log(`  ${dim('model')} ${yellow('not called')}  ${dim('Pass --model or omit --gate-only to call the model')}`);
  }
  if (data.actionsProposed && data.actionsProposed.length > 0) {
    console.log(`  ${bold('Proposed actions:')}`);
    data.actionsProposed.forEach(a => {
      const op = opTypeTag(a.operation);
      const path_ = a.args ? (a.args.path || '') : '';
      const content = a.args && a.args.content ? dim(` (${truncate(a.args.content, 40)})`) : '';
      console.log(`    ${op} ${path_}${content}`);
    });
  }
  if (data.ambiguityPatterns && data.ambiguityPatterns.length > 0) {
    console.log(`  ${yellow('ambiguity patterns')} ${data.ambiguityPatterns.join(', ')}`);
  }
  console.log('');
}

// Enable a process template. POST /api/process-templates/:id/enable
async function cmdTemplateEnable(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery template-enable <templateId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/enable`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ templateId: id, action: 'enable', enabled: true }, null, 2));
    console.log(`  ${green('✓')} Template #${id} enabled.`);
    return;
  }
  reportActionError(args, status, data);
}

// Disable a process template. POST /api/process-templates/:id/disable
async function cmdTemplateDisable(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery template-disable <templateId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/disable`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ templateId: id, action: 'disable', enabled: false }, null, 2));
    console.log(`  ${green('✓')} Template #${id} disabled.`);
    return;
  }
  reportActionError(args, status, data);
}

// Set or clear schedule on a process template. POST /api/process-templates/:id/schedule
async function cmdTemplateSchedule(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery template-schedule <templateId> --interval <seconds>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  let body;
  if (args.interval) {
    const seconds = parseInt(args.interval, 10);
    if (Number.isNaN(seconds) || seconds <= 0) return console.log(red('  ✗ --interval must be a positive number of seconds'));
    body = { enabled: true, kind: 'interval', everySeconds: seconds };
  } else {
    body = { enabled: false };
  }
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/schedule`, body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ templateId: id, action: 'schedule', schedule: data.schedule }, null, 2));
    if (body.enabled && data.schedule) {
      console.log(`  ${green('✓')} Template #${id} scheduled every ${data.schedule.everySeconds}s. Next run: ${datetime(data.schedule.nextRunAt)}`);
    } else {
      console.log(`  ${green('✓')} Template #${id} schedule cleared.`);
    }
    return;
  }
  reportActionError(args, status, data);
}

// Pause a process template schedule. POST /api/process-templates/:id/schedule/pause
async function cmdTemplatePause(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery template-pause <templateId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/schedule/pause`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ templateId: id, action: 'schedule-pause' }, null, 2));
    console.log(`  ${green('✓')} Template #${id} schedule paused.`);
    return;
  }
  reportActionError(args, status, data);
}

// Resume a process template schedule. POST /api/process-templates/:id/schedule/resume
async function cmdTemplateResume(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery template-resume <templateId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/schedule/resume`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ templateId: id, action: 'schedule-resume' }, null, 2));
    console.log(`  ${green('✓')} Template #${id} schedule resumed.`);
    return;
  }
  reportActionError(args, status, data);
}

// List work contexts. GET /api/work-contexts
async function cmdWorkContexts(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, '/api/work-contexts');
  if (status !== 200 || !data) return reportActionError(args, status, data);
  const list = data.workContexts || [];
  if (args.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log(dim('  No work contexts.'));
  console.log(`\n  ${bold('Work Contexts')}  ${dim(list.length + ' total')}`);
  list.forEach(wc => {
    const name = wc.name || `#${wc.id}`;
    const status2 = wc.archived ? red('archived') : wc.paused ? yellow('paused') : green('active');
    console.log(`  ${bold('#' + wc.id)} ${name}  ${status2}`);
    if (wc.description) console.log(`       ${dim(truncate(wc.description, 100))}`);
  });
  console.log('');
}

// List watchers. GET /api/watchers
async function cmdWatchers(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, '/api/watchers');
  if (status !== 200 || !data) return reportActionError(args, status, data);
  const list = data.watchers || [];
  if (args.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log(dim('  No watchers.'));
  console.log(`\n  ${bold('Watchers')}  ${dim(list.length + ' total')}`);
  list.forEach(w => {
    const name = w.name || `#${w.id}`;
    const status2 = w.archived ? red('archived') : w.paused ? yellow('paused') : green('active');
    const schedule = w.schedule ? dim(` (${w.schedule})`) : '';
    console.log(`  ${bold('#' + w.id)} ${name}  ${status2}${schedule}`);
  });
  console.log('');
}

// List connectors. GET /api/connectors
async function cmdConnectors(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, '/api/connectors');
  if (status !== 200 || !data) return reportActionError(args, status, data);
  const list = data.connectors || [];
  if (args.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log(dim('  No connectors.'));
  console.log(`\n  ${bold('Connectors')}  ${dim(list.length + ' total')}`);
  list.forEach(c => {
    const name = c.name || `#${c.id}`;
    const status2 = c.archived ? red('archived') : c.paused ? yellow('paused') : green('active');
    const type = c.type || c.connectorType || '';
    console.log(`  ${bold('#' + c.id)} ${name}  ${status2}  ${dim(type)}`);
  });
  console.log('');
}

// List model routing policies. GET /api/model-routing-policies
async function cmdModelPolicies(args) {
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, '/api/model-routing-policies');
  if (status !== 200 || !data) return reportActionError(args, status, data);
  const list = data.policies || [];
  if (args.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log(dim('  No model routing policies.'));
  console.log(`\n  ${bold('Model Routing Policies')}  ${dim(list.length + ' total')}`);
  list.forEach(p => {
    const name = p.name || `#${p.id}`;
    const status2 = p.archived ? red('archived') : green('active');
    const priority = p.priority !== undefined ? dim(` priority: ${p.priority}`) : '';
    console.log(`  ${bold('#' + p.id)} ${name}  ${status2}${priority}`);
  });
  console.log('');
}

// ── Subsystem CRUD commands ──

// Create a work context. POST /api/work-contexts
async function cmdWorkContextCreate(args) {
  const name = args._.join(' ').trim() || args.name;
  if (!name) return console.log(red('Usage: oquery work-context-create <name> [--purpose <text>]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = { name, purpose: args.purpose || '' };
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/work-contexts', body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.workContext, null, 2));
    const wc = data.workContext;
    console.log(`  ${green('✓')} Work context #${wc.id} "${wc.name}" created.`);
    return;
  }
  reportActionError(args, status, data);
}

// Update a work context. POST /api/work-contexts/:id
async function cmdWorkContextUpdate(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery work-context-update <id> --name <name> [--purpose <text>]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = {};
  if (args.name) body.name = args.name;
  if (args.purpose) body.purpose = args.purpose;
  if (Object.keys(body).length === 0) return console.log(red('  ✗ At least one field to update required (--name, --purpose).'));
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/work-contexts/${id}`, body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.workContext, null, 2));
    console.log(`  ${green('✓')} Work context #${id} updated.`);
    return;
  }
  reportActionError(args, status, data);
}

// Create a watcher. POST /api/watchers
async function cmdWatcherCreate(args) {
  const name = args.name;
  const wcId = args['work-context-id'] ? parseInt(args['work-context-id'], 10) : NaN;
  const sourceRefs = args['source-refs'] ? args['source-refs'].split(',').map(s => ({ path: s.trim() })) : [];
  if (!name || Number.isNaN(wcId) || sourceRefs.length === 0) {
    return console.log(red('Usage: oquery watcher-create --name <name> --work-context-id <id> --source-refs <paths>'));
  }
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = { name, workContextId: wcId, sourceRefs };
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/watchers', body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.watcher, null, 2));
    console.log(`  ${green('✓')} Watcher #${data.watcher.id} "${data.watcher.name}" created.`);
    return;
  }
  reportActionError(args, status, data);
}

// Update a watcher. POST /api/watchers/:id
async function cmdWatcherUpdate(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery watcher-update <id> [--name <name>]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = {};
  if (args.name) body.name = args.name;
  if (Object.keys(body).length === 0) return console.log(red('  ✗ At least one field to update required (--name).'));
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/watchers/${id}`, body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.watcher, null, 2));
    console.log(`  ${green('✓')} Watcher #${id} updated.`);
    return;
  }
  reportActionError(args, status, data);
}

// Observe a watcher. POST /api/watchers/:id/observe
async function cmdWatcherObserve(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery watcher-observe <watcherId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/watchers/${id}/observe`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`  ${green('✓')} Watcher #${id} observation complete.`);
    if (data.proposals && data.proposals.length > 0) console.log(`       ${data.proposals.length} proposal(s) generated.`);
    if (data.error) console.log(`  ${yellow('warning')} ${data.error}`);
    return;
  }
  reportActionError(args, status, data);
}

// List proposals for a watcher. POST /api/watchers/:id/proposals
async function cmdWatcherProposals(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery watcher-proposals <watcherId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/watchers/${id}/proposals`, {});
  if (status === 200 && data && data.ok) {
    const list = data.proposals || [];
    if (args.json) return console.log(JSON.stringify(list, null, 2));
    if (list.length === 0) return console.log(dim(`  No proposals for watcher #${id}.`));
    console.log(`\n  ${bold(`Proposals for Watcher #${id}`)}  ${dim(list.length + ' total')}`);
    list.forEach(p => {
      const ts = datetime(p.createdAt || p.timestamp);
      const status2 = p.approvedAt ? green('approved') : p.rejectedAt ? red('rejected') : yellow('pending');
      console.log(`  ${bold('#P' + (p.id || ''))} ${status2} ${dim(ts)}`);
      if (p.summary) console.log(`       ${truncate(p.summary, 120)}`);
    });
    console.log('');
    return;
  }
  reportActionError(args, status, data);
}

// Approve a watcher proposal. POST /api/watcher-proposals/:id/approve
async function cmdWatcherApprove(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery watcher-approve <proposalId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/watcher-proposals/${id}/approve`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ proposalId: id, action: 'approve', ticketId: data.createdTicketId }, null, 2));
    console.log(`  ${green('✓')} Proposal #${id} approved. Ticket #${data.createdTicketId} created.`);
    return;
  }
  reportActionError(args, status, data);
}

// Reject a watcher proposal. POST /api/watcher-proposals/:id/reject
async function cmdWatcherReject(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery watcher-reject <proposalId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/watcher-proposals/${id}/reject`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify({ proposalId: id, action: 'reject' }, null, 2));
    console.log(`  ${green('✓')} Proposal #${id} rejected.`);
    return;
  }
  reportActionError(args, status, data);
}

// Create a connector. POST /api/connectors
async function cmdConnectorCreate(args) {
  const name = args.name;
  const wcId = args['work-context-id'] ? parseInt(args['work-context-id'], 10) : NaN;
  if (!name || Number.isNaN(wcId)) return console.log(red('Usage: oquery connector-create --name <name> --work-context-id <id> [--allowed-scopes read,write] [--source-roots <paths>] [--target-roots <paths>]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = {
    name,
    workContextId: wcId,
    allowedScopes: args['allowed-scopes'] ? args['allowed-scopes'].split(',').map(s => s.trim()) : ['read'],
    sourceRoots: args['source-roots'] ? args['source-roots'].split(',').map(s => s.trim()) : ['/'],
    targetRoots: args['target-roots'] ? args['target-roots'].split(',').map(s => s.trim()) : ['/'],
  };
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/connectors', body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.connector, null, 2));
    console.log(`  ${green('✓')} Connector #${data.connector.id} "${data.connector.name}" created.`);
    return;
  }
  reportActionError(args, status, data);
}

// Update a connector. POST /api/connectors/:id
async function cmdConnectorUpdate(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery connector-update <id> [--name <name>]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = {};
  if (args.name) body.name = args.name;
  if (Object.keys(body).length === 0) return console.log(red('  ✗ At least one field to update required (--name).'));
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/connectors/${id}`, body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.connector, null, 2));
    console.log(`  ${green('✓')} Connector #${id} updated.`);
    return;
  }
  reportActionError(args, status, data);
}

// Read through a connector. POST /api/connectors/:id/read
async function cmdConnectorRead(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery connector-read <connectorId> [--path <path>]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = {};
  if (args.path) body.path = args.path;
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/connectors/${id}/read`, body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`  ${green('✓')} Connector #${id} read complete.`);
    if (data.result) console.log(`  ${data.result}`);
    if (data.content) console.log(data.content);
    return;
  }
  reportActionError(args, status, data);
}

// Create a model routing policy. POST /api/model-routing-policies
async function cmdModelPolicyCreate(args) {
  const name = args.name;
  if (!name) return console.log(red('Usage: oquery model-policy-create --name <name> --allowed-providers <list> --fallback-providers <list>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = {
    name,
    allowedProviders: args['allowed-providers'] ? args['allowed-providers'].split(',').map(s => s.trim()) : [],
    fallbackProviders: args['fallback-providers'] ? args['fallback-providers'].split(',').map(s => s.trim()) : [],
    toolRequirements: args['tool-requirements'] ? args['tool-requirements'].split(',').map(s => s.trim()) : [],
    targetRequirements: args['target-requirements'] ? args['target-requirements'].split(',').map(s => s.trim()) : [],
  };
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/model-routing-policies', body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.policy, null, 2));
    console.log(`  ${green('✓')} Model routing policy #${data.policy.id} "${data.policy.name}" created.`);
    return;
  }
  reportActionError(args, status, data);
}

// Update a model routing policy. POST /api/model-routing-policies/:id
async function cmdModelPolicyUpdate(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery model-policy-update <id> [--name <name>]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const body = {};
  if (args.name) body.name = args.name;
  if (Object.keys(body).length === 0) return console.log(red('  ✗ At least one field to update required (--name).'));
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/model-routing-policies/${id}`, body);
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data.policy, null, 2));
    console.log(`  ${green('✓')} Model routing policy #${id} updated.`);
    return;
  }
  reportActionError(args, status, data);
}

// Create a process template. POST /api/process-templates
async function cmdTemplateCreate(args) {
  const name = args.name || args._.join(' ').trim();
  if (!name) return console.log(red('Usage: oquery template-create --name <name> [--objective <text>] [--capability-type directAction|workflow]'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const ticketTemplate = {
    objective: args.objective || '',
    assignmentTargetType: args['assignment-target-type'] || null,
    assignmentTargetId: args['assignment-target-id'] ? parseInt(args['assignment-target-id'], 10) : null,
    assignmentMode: args['assignment-mode'] || null,
    capabilityType: args['capability-type'] || 'directAction',
  };
  const body = { name, ticketTemplate, enabled: true };
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/process-templates', body);
  if (status === 200 && data && data.template) {
    if (args.json) return console.log(JSON.stringify(data.template, null, 2));
    console.log(`  ${green('✓')} Process template #${data.template.id} "${data.template.name}" created.`);
    return;
  }
  reportActionError(args, status, data);
}

// Activate a draft version of a process template. POST /api/process-templates/:id/versions/:versionId/activate
async function cmdTemplateActivate(args) {
  const id = parseInt(args._[0] || args.id, 10);
  const versionId = args._[1] || args.version;
  if (Number.isNaN(id) || !versionId) return console.log(red('Usage: oquery template-activate <templateId> <versionId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/versions/${versionId}/activate`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`  ${green('✓')} Version ${versionId} activated for template #${id}.`);
    return;
  }
  if (data && data.error) {
    if (args.json) return console.log(JSON.stringify({ error: data.error }, null, 2));
    return console.log(red(`  ✗ ${data.error}`));
  }
  reportActionError(args, status, data);
}

// Set or clear the work context on a process template. POST /api/process-templates/:id/work-context
async function cmdTemplateWorkContext(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery template-work-context <templateId> --work-context-id <id>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const wcId = args['work-context-id'] ? parseInt(args['work-context-id'], 10) : null;
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/work-context`, { workContextId: wcId });
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    const label = data.workContextId ? `set to #${data.workContextId}` : 'cleared';
    console.log(`  ${green('✓')} Template #${id} work context ${label}.`);
    return;
  }
  if (data && data.error) {
    if (args.json) return console.log(JSON.stringify({ error: data.error }, null, 2));
    return console.log(red(`  ✗ ${data.error}`));
  }
  reportActionError(args, status, data);
}

// Show work context summary. GET /api/work-contexts/:id/summary
async function cmdWorkContextSummary(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery work-context-summary <id>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/work-contexts/${id}/summary`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const s = data.summary || data;
  console.log(`\n  ${bold('Work Context #' + (s.id || id))}  ${s.name ? bold(s.name) : ''}`);
  if (s.purpose) console.log(`  ${dim('purpose')} ${s.purpose}`);
  if (s.counts) {
    const c = s.counts;
    console.log(`  ${dim('tickets')}  ${c.ticketCount || 0} (${c.openTicketCount || 0} open, ${c.blockedTicketCount || 0} blocked)`);
    if (c.unresolvedTriageCount) console.log(`  ${dim('triage')}  ${c.unresolvedTriageCount} unresolved`);
    if (c.processTemplateCount) console.log(`  ${dim('templates')} ${c.processTemplateCount}`);
    if (c.watcherCount) console.log(`  ${dim('watchers')} ${c.watcherCount}`);
    if (c.connectorCount) console.log(`  ${dim('connectors')} ${c.connectorCount}`);
  }
  console.log('');
}

// ── Additional read/action commands ──

// Show claim receipt for a run. GET /api/runs/:id/claim-receipt
async function cmdClaimReceipt(args) {
  const runId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(runId)) return console.log(red('Usage: oquery claim-receipt <runId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/runs/${runId}/claim-receipt`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const cr = data.claimReceipt;
  if (!cr) return console.log(red('  No claim receipt available for this run.'));
  console.log(`\n  ${bold(`Claim Receipt — Run #${cr.runId}`)}`);
  console.log(`  ${dim('ticket')}    #${cr.ticketId}`);
  console.log(`  ${dim('agent')}    ${cr.actorAgentName || cr.actorAgentId || '?'}`);
  if (cr.assignee) console.log(`  ${dim('assignee')} ${cr.assignee.type} #${cr.assignee.id}`);
  if (cr.leaseOwner) console.log(`  ${dim('lease')}   ${cr.leaseOwner} ${cr.leaseExpiresAt ? dim('expires ' + datetime(cr.leaseExpiresAt)) : ''}`);
  if (cr.workContextId) console.log(`  ${dim('context')} #${cr.workContextId}`);
  console.log(`  ${dim('claimed')} ${datetime(cr.claimedAt)}`);
  console.log('');
}

// Show work receipt for a run. GET /api/runs/:id/work-receipt
async function cmdWorkReceipt(args) {
  const runId = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(runId)) return console.log(red('Usage: oquery work-receipt <runId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/runs/${runId}/work-receipt`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const wr = data.workReceipt;
  if (!wr) return console.log(red('  No work receipt available for this run.'));
  console.log(`\n  ${bold(`Work Receipt — Run #${wr.runId}`)}  ${statusTag(wr.status)}`);
  console.log(`  ${dim('ticket')}   #${wr.ticketId}  ${dim('agent')} ${wr.actorAgentName || wr.actorAgentId || '?'}`);
  if (wr.startedAt) console.log(`  ${dim('started')} ${datetime(wr.startedAt)}`);
  if (wr.completedAt) console.log(`  ${dim('ended')}   ${datetime(wr.completedAt)}`);
  if (wr.authorityDecisions) console.log(`  ${dim('authority')} ${wr.authorityDecisions.allowed} allowed, ${wr.authorityDecisions.denied} denied`);
  if (wr.verification) console.log(`  ${dim('verify')}  ${wr.verification.result} ${wr.verification.required ? '(required)' : '(not required)'}`);
  if (wr.targetOperationsPerformed && wr.targetOperationsPerformed.length > 0) {
    console.log(`  ${dim('operations')} (${wr.targetOperationsPerformed.length})`);
    wr.targetOperationsPerformed.forEach(op => {
      console.log(`    ${op.operation} ${op.path || ''}`);
    });
  }
  if (wr.artifactsProduced && wr.artifactsProduced.length > 0) {
    console.log(`  ${dim('artifacts')}`);
    wr.artifactsProduced.forEach(a => console.log(`    ${a}`));
  }
  if (wr.whatWasDone) console.log(`  ${dim('done')}    ${wr.whatWasDone}`);
  if (wr.whatWasNotDone) console.log(`  ${dim('undone')}  ${wr.whatWasNotDone}`);
  if (wr.nextRecommendedAction) console.log(`  ${dim('next')}    ${wr.nextRecommendedAction}`);
  console.log('');
}

// Show operations for a run. GET /api/runs/:id/operations
async function cmdRunOps(args) {
  const runId = parseInt(args._[0] || args.run, 10);
  if (Number.isNaN(runId)) return console.log(red('Usage: oquery run-ops <runId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/runs/${runId}/operations`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  const ops = data.operations || [];
  if (args.json) return console.log(JSON.stringify(ops, null, 2));
  if (ops.length === 0) return console.log(dim(`  No operations for Run #${runId}.`));
  console.log(`\n  ${bold(`Operations — Run #${runId}`)}  ${dim(ops.length + ' total')}`);
  ops.forEach((op, i) => {
    const ts = op.timestamp ? datetime(op.timestamp) : '';
    const opName = op.operation || '?';
    const path = op.path || op.targetPath || '';
    const status_ = op.result ? (op.result.status || '') : '';
    const statusTag_ = status_ === 'created' ? green('created') : status_ === 'noop' ? yellow('noop') : dim(status_);
    console.log(`  ${dim('#' + (op.id || op.historyId || i))} ${dim(ts)} ${opTypeTag(opName)} ${path} ${statusTag_}`);
    if (op.error) console.log(`       ${red('error')} ${op.error}`);
  });
  console.log('');
}

// Shape a ticket objective via the model. POST /api/tickets/shape-objective
async function cmdShapeObjective(args) {
  const objective = args._.join(' ').trim() || args.objective;
  if (!objective) return console.log(red('Usage: oquery shape-objective <objective text>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', '/api/tickets/shape-objective', { objective });
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`\n  ${bold('Shaped Objective')}`);
  if (data.suggestedObjective) console.log(`  ${data.suggestedObjective}`);
  if (data.expectedOutputs && data.expectedOutputs.length > 0) {
    console.log(`\n  ${dim('expected outputs:')}`);
    data.expectedOutputs.forEach(o => console.log(`    ${o}`));
  }
  if (data.decomposition && data.decomposition.length > 0) {
    console.log(`\n  ${dim('decomposition:')}`);
    data.decomposition.forEach(d => console.log(`    ${d}`));
  }
  if (data.warnings && data.warnings.length > 0) {
    console.log(`\n  ${yellow('warnings:')}`);
    data.warnings.forEach(w => console.log(`    ${yellow(w)}`));
  }
  if (data.parseError) console.log(`\n  ${red('parse error:')} ${data.parseError}`);
  if (data.usage) console.log(`\n  ${dim('usage')} ${JSON.stringify(data.usage)}`);
  console.log('');
}

// Create a draft version of a process template. POST /api/process-templates/:id/versions/draft
async function cmdTemplateDraft(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery template-draft <templateId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorJsonCall(url, cookie, 'POST', `/api/process-templates/${id}/versions/draft`, {});
  if (status === 200 && data && data.ok) {
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`  ${green('✓')} Draft v${data.draft.version} created for template #${id} (active: v${data.activeVersion}).`);
    return;
  }
  if (status === 409 && data && data.error) {
    if (args.json) return console.log(JSON.stringify({ error: data.error }, null, 2));
    return console.log(red(`  ✗ ${data.error}`));
  }
  reportActionError(args, status, data);
}

// Show a single watcher detail. GET /api/watchers/:id
async function cmdWatcherDetail(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery watcher <watcherId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/watchers/${id}`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const w = data.watcher || data;
  console.log(`\n  ${bold('Watcher #' + (w.id || id))}  ${w.name ? bold(w.name) : ''}`);
  if (w.workContextId) console.log(`  ${dim('context')}  #${w.workContextId}`);
  if (w.sourceRefs && w.sourceRefs.length > 0) {
    console.log(`  ${dim('sources')}`);
    w.sourceRefs.forEach(s => console.log(`    ${s.path || s}`));
  }
  if (w.status) console.log(`  ${dim('status')}  ${w.status}`);
  if (w.lastObservedAt) console.log(`  ${dim('observed')} ${datetime(w.lastObservedAt)}`);
  console.log('');
}

// Show a single connector detail. GET /api/connectors/:id
async function cmdConnectorDetail(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery connector <connectorId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/connectors/${id}`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const c = data.connector || data;
  console.log(`\n  ${bold('Connector #' + (c.id || id))}  ${c.name ? bold(c.name) : ''}`);
  if (c.workContextId) console.log(`  ${dim('context')}  #${c.workContextId}`);
  if (c.allowedScopes && c.allowedScopes.length > 0) console.log(`  ${dim('scopes')}  ${c.allowedScopes.join(', ')}`);
  if (c.sourceRoots && c.sourceRoots.length > 0) console.log(`  ${dim('source')}  ${c.sourceRoots.join(', ')}`);
  if (c.targetRoots && c.targetRoots.length > 0) console.log(`  ${dim('target')}  ${c.targetRoots.join(', ')}`);
  if (c.status) console.log(`  ${dim('status')}  ${c.status}`);
  console.log('');
}

// Show a single model routing policy. GET /api/model-routing-policies/:id
async function cmdModelPolicyDetail(args) {
  const id = parseInt(args._[0] || args.id, 10);
  if (Number.isNaN(id)) return console.log(red('Usage: oquery model-policy <policyId>'));
  const cookie = requireSession(args); if (!cookie) return;
  const url = args.url || opercUrl();
  const { status, data } = await operatorGetCall(url, cookie, `/api/model-routing-policies/${id}`);
  if (status !== 200 || !data) return reportActionError(args, status, data);
  if (args.json) return console.log(JSON.stringify(data, null, 2));
  const p = data.policy || data;
  console.log(`\n  ${bold('Model Routing Policy #' + (p.id || id))}  ${p.name ? bold(p.name) : ''}`);
  if (p.allowedProviders && p.allowedProviders.length > 0) console.log(`  ${dim('allowed')}  ${p.allowedProviders.join(', ')}`);
  if (p.fallbackProviders && p.fallbackProviders.length > 0) console.log(`  ${dim('fallback')} ${p.fallbackProviders.join(', ')}`);
  if (p.toolRequirements && p.toolRequirements.length > 0) console.log(`  ${dim('tools')}    ${p.toolRequirements.join(', ')}`);
  if (p.targetRequirements && p.targetRequirements.length > 0) console.log(`  ${dim('targets')}  ${p.targetRequirements.join(', ')}`);
  if (p.status) console.log(`  ${dim('status')}  ${p.status}`);
  console.log('');
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

    assign-ticket <ticketId>
                    Reassign a ticket to an agent
      --agent <id|name>
                      Assign to agent id or local agent name
      --json          Raw JSON output
      --url <url>     Server base URL

    update-ticket <ticketId>
                    Change ticket status
      --status <s>    New status (open, in_progress, completed, failed, blocked, closed)
      --json          Raw JSON output
      --url <url>     Server base URL

    resolve-triage  Resolve ticket-level or run-level triage
      --ticket <id>   Resolve triage on a ticket
      --run <id>      Resolve triage on a run
      --reason <text> Resolution note (required)
      --json          Raw JSON output
      --url <url>     Server base URL

    trigger-template <id>
                    Manually trigger a process template
                      Creates a ticket from the template definition
      --json          Raw JSON output
      --url <url>     Server base URL

    handoff <ticketId>
                    Create a handoff ticket from an existing ticket
                      Copies assignment from source by default
      --objective <text>
                      Handoff objective (required)
      --agent <id|name>
                      Assign to a different agent (optional)
      --json          Raw JSON output
      --url <url>     Server base URL

    shape-objective <objective>
                    Shape a ticket objective through the model
                      Calls the model to suggest bounded wording, outputs,
                      decomposition, and warnings for a ticket draft
      --json          Raw JSON output
      --url <url>     Server base URL

  ${bold('Diagnostic Commands:')}
    ticket <id>     Show full runtime state for a ticket
                      Displays ticket, current/latest run, lease, outcome
      --json          Raw JSON output
      --url <url>     Server base URL

    timeline <ticketId>
                    Show chronological timeline for a ticket
      --json          Raw JSON output
      --url <url>     Server base URL

    events          Show events for a run
      --run <id>      Filter by run (required)
      --limit <n>     Max events to display
      --json          Raw JSON output
      --url <url>     Server base URL

    run-state <id>  Show serialized runtime state of a run
                      Includes budget, lease, triage, outcome, attempts
      --json          Raw JSON output
      --url <url>     Server base URL

    claim-receipt <runId>
                    Show claim/lease receipt for a run
      --json          Raw JSON output
      --url <url>     Server base URL

    work-receipt <runId>
                    Show work receipt (ops, artifacts, verification)
      --json          Raw JSON output
      --url <url>     Server base URL

    run-ops <runId> Show operation history for a specific run
      --json          Raw JSON output
      --url <url>     Server base URL

     workspace       Browse and manipulate workspace files
       ls [path]       List directory contents
       cat <path>      Print file contents
       mkdir <path>    Create a folder
       touch <path>    Create an empty file
       write <path> <content>
                       Write content to a file
       mv <from> <to>  Rename/move a file or folder
       rm <path>       Delete a file or folder
       --json          Raw JSON output
       --url <url>     Server base URL

    templates       List process templates
      --json          Raw JSON output
      --url <url>     Server base URL

  ${bold('System Commands:')}
    runtime-status  Show runtime status (scheduler, leases, active runs)
      --json          Raw JSON output
      --url <url>     Server base URL

    runtime-limits  View or update runtime limits
                      Without --set, prints current config and effective limits
      --set <key>=<value>
                      Update a limit (repeatable: --set maxExecutionSteps=200
                      --set maxModelRequestsPerRun=50)
      --json          Raw JSON output
      --url <url>     Server base URL

    ops-summary     Show operational summary across all subsystems
      --json          Raw JSON output
      --url <url>     Server base URL

    max-attempts <ticketId> <n>
                    Set max retry attempts on a ticket
                      Use 'clear' for unlimited
      --json          Raw JSON output
      --url <url>     Server base URL

    simulate <ticketId>
                    Simulate a plan for a ticket
                      Calls the model to propose actions (or --gate-only to
                      skip the model call and check the gate only)
      --gate-only     Skip model call, only show gate verdict
      --json          Raw JSON output
      --url <url>     Server base URL

  ${bold('Recovery:')}
    recovery <operationId>
                    Preview or execute operation recovery
      --confirm       Execute the recovery after previewing
      --json          Raw JSON output
      --url <url>     Server base URL

  ${bold('Template Controls:')}
    template-enable <id>
                    Enable a process template
      --json          Raw JSON output
      --url <url>     Server base URL

    template-disable <id>
                    Disable a process template
      --json          Raw JSON output
      --url <url>     Server base URL

    template-schedule <id>
                    Set or clear a template's interval schedule
      --interval <s>  Schedule every N seconds (omit to clear)
      --json          Raw JSON output
      --url <url>     Server base URL

    template-pause <id>
                    Pause a template's schedule
      --json          Raw JSON output
      --url <url>     Server base URL

    template-resume <id>
                    Resume a template's schedule
      --json          Raw JSON output
      --url <url>     Server base URL

    template-draft <id>
                    Create a draft version of a process template
      --json          Raw JSON output
      --url <url>     Server base URL

    template-activate <templateId> <versionId>
                    Activate a draft version of a process template
      --json          Raw JSON output
      --url <url>     Server base URL

    template-work-context <templateId>
                    Set or clear a template's linked work context
      --work-context-id <id>
                      Work context id (omit or set empty to clear)
      --json          Raw JSON output
      --url <url>     Server base URL

  ${bold('Subsystems:')}
    work-contexts   List work contexts
      --json          Raw JSON output
      --url <url>     Server base URL

    work-context-summary <id>
                    Show work context summary with counts
      --json          Raw JSON output
      --url <url>     Server base URL

    work-context-create <name>
                    Create a work context
      --purpose <text>
      --json          Raw JSON output
      --url <url>     Server base URL

    work-context-update <id>
                    Update a work context
      --name <name>   New name
      --purpose <text>
      --json          Raw JSON output
      --url <url>     Server base URL

    watchers        List watchers
      --json          Raw JSON output
      --url <url>     Server base URL

    watcher-create  Create a watcher
      --name <name>   Watcher name
      --work-context-id <id>
      --source-refs <paths>
                      Comma-separated source paths
      --json          Raw JSON output
      --url <url>     Server base URL

    watcher-update <id>
                    Update a watcher
      --name <name>   New name
      --json          Raw JSON output
      --url <url>     Server base URL

    watcher-observe <watcherId>
                    Run observation on a watcher
      --json          Raw JSON output
      --url <url>     Server base URL

    watcher-proposals <watcherId>
                    List proposals for a watcher
      --json          Raw JSON output
      --url <url>     Server base URL

    watcher-approve <proposalId>
                    Approve a watcher proposal
      --json          Raw JSON output
      --url <url>     Server base URL

    watcher-reject <proposalId>
                    Reject a watcher proposal
      --json          Raw JSON output
      --url <url>     Server base URL

    watcher <id>    Show watcher detail
      --json          Raw JSON output
      --url <url>     Server base URL

    connectors      List connectors
      --json          Raw JSON output
      --url <url>     Server base URL

    connector-create
                    Create a connector
      --name <name>   Connector name
      --work-context-id <id>
      --allowed-scopes read,write
                      Comma-separated scopes
      --source-roots <paths>
      --target-roots <paths>
      --json          Raw JSON output
      --url <url>     Server base URL

    connector-update <id>
                    Update a connector
      --name <name>   New name
      --json          Raw JSON output
      --url <url>     Server base URL

    connector-read <connectorId>
                    Read through a connector
      --path <path>   Path to read
      --json          Raw JSON output
      --url <url>     Server base URL

    connector <id>  Show connector detail
      --json          Raw JSON output
      --url <url>     Server base URL

    model-policies  List model routing policies
      --json          Raw JSON output
      --url <url>     Server base URL

    model-policy-create
                    Create a model routing policy
      --name <name>   Policy name
      --allowed-providers <list>
      --fallback-providers <list>
      --tool-requirements <list>
      --target-requirements <list>
      --json          Raw JSON output
      --url <url>     Server base URL

    model-policy-update <id>
                    Update a model routing policy
      --name <name>   New name
      --json          Raw JSON output
      --url <url>     Server base URL

    model-policy <id>
                    Show model routing policy detail
      --json          Raw JSON output
      --url <url>     Server base URL

    template-create  Create a process template
      --name <name>   Template name
      --objective <text>
      --capability-type directAction|workflow
      --json          Raw JSON output
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
    node scripts/oquery.js assign-ticket 5 --agent Mike
    node scripts/oquery.js update-ticket 5 --status closed
    node scripts/oquery.js resolve-triage --ticket 5 --reason "Reviewed, looks good"
    node scripts/oquery.js trigger-template 2
    node scripts/oquery.js handoff 5 --objective "Continue widget work"
    node scripts/oquery.js ticket 5
    node scripts/oquery.js timeline 5
    node scripts/oquery.js events --run 12
    node scripts/oquery.js run-state 12
    node scripts/oquery.js workspace ls
    node scripts/oquery.js workspace cat src/index.js
    node scripts/oquery.js templates
    node scripts/oquery.js runtime-status
    node scripts/oquery.js runtime-limits
    node scripts/oquery.js runtime-limits --set maxExecutionSteps=200
    node scripts/oquery.js ops-summary
    node scripts/oquery.js max-attempts 5 3
    node scripts/oquery.js max-attempts 5 clear
    node scripts/oquery.js simulate 5
    node scripts/oquery.js simulate 5 --gate-only
    node scripts/oquery.js recovery 42 --confirm
    node scripts/oquery.js template-enable 2
    node scripts/oquery.js template-disable 2
    node scripts/oquery.js template-schedule 2 --interval 3600
    node scripts/oquery.js template-pause 2
    node scripts/oquery.js template-resume 2
    node scripts/oquery.js work-contexts
    node scripts/oquery.js watchers
    node scripts/oquery.js connectors
    node scripts/oquery.js model-policies
    node scripts/oquery.js work-context-create "My Context" --purpose "Track experiments"
    node scripts/oquery.js work-context-update 1 --name "Updated Context"
    node scripts/oquery.js watcher-create --name "Watch src" --work-context-id 1 --source-refs workspace-root/
    node scripts/oquery.js watcher-observe 1
    node scripts/oquery.js watcher-proposals 1
    node scripts/oquery.js watcher-approve 3
    node scripts/oquery.js connector-create --name "Data feed" --work-context-id 1 --allowed-scopes read
    node scripts/oquery.js connector-read 1 --path /data
    node scripts/oquery.js model-policy-create --name "Fast policy" --allowed-providers ollama --fallback-providers openai
    node scripts/oquery.js template-create --name "Quick fix" --objective "Fix bugs"
    node scripts/oquery.js workspace mkdir test
    node scripts/oquery.js workspace touch hello.txt
    node scripts/oquery.js workspace write hello.txt "Hello world"
    node scripts/oquery.js workspace mv hello.txt greeting.txt
    node scripts/oquery.js workspace rm greeting.txt
    node scripts/oquery.js claim-receipt 4
    node scripts/oquery.js work-receipt 4
    node scripts/oquery.js run-ops 4
    node scripts/oquery.js shape-objective "Fix the widget rendering"
    node scripts/oquery.js template-draft 2
    node scripts/oquery.js watcher 1
    node scripts/oquery.js connector 1
    node scripts/oquery.js model-policy 1
    node scripts/oquery.js template-activate 2 v3
    node scripts/oquery.js template-work-context 2 --work-context-id 1
    node scripts/oquery.js work-context-summary 1
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
  } else if (cmd === 'assign-ticket') {
    await cmdAssignTicket(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'update-ticket') {
    await cmdUpdateTicket(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'resolve-triage') {
    await cmdResolveTriage(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'trigger-template') {
    await cmdTriggerTemplate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'ticket') {
    await cmdTicket(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'timeline') {
    await cmdTimeline(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'events') {
    await cmdEvents(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'run-state') {
    await cmdRunState(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'workspace') {
    await cmdWorkspace(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'templates') {
    await cmdTemplates(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'handoff') {
    await cmdHandoff(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'runtime-status') {
    await cmdRuntimeStatus(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'runtime-limits') {
    await cmdRuntimeLimits(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'ops-summary') {
    await cmdOpsSummary(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'recovery') {
    await cmdRecovery(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'max-attempts') {
    await cmdMaxAttempts(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'simulate') {
    await cmdSimulate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-enable') {
    await cmdTemplateEnable(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-disable') {
    await cmdTemplateDisable(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-schedule') {
    await cmdTemplateSchedule(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-pause') {
    await cmdTemplatePause(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-resume') {
    await cmdTemplateResume(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'work-contexts') {
    await cmdWorkContexts(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watchers') {
    await cmdWatchers(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'connectors') {
    await cmdConnectors(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'model-policies') {
    await cmdModelPolicies(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'work-context-create') {
    await cmdWorkContextCreate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'work-context-update') {
    await cmdWorkContextUpdate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watcher-create') {
    await cmdWatcherCreate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watcher-update') {
    await cmdWatcherUpdate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watcher-observe') {
    await cmdWatcherObserve(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watcher-proposals') {
    await cmdWatcherProposals(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watcher-approve') {
    await cmdWatcherApprove(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watcher-reject') {
    await cmdWatcherReject(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'connector-create') {
    await cmdConnectorCreate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'connector-update') {
    await cmdConnectorUpdate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'connector-read') {
    await cmdConnectorRead(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'model-policy-create') {
    await cmdModelPolicyCreate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'model-policy-update') {
    await cmdModelPolicyUpdate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-create') {
    await cmdTemplateCreate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'claim-receipt') {
    await cmdClaimReceipt(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'work-receipt') {
    await cmdWorkReceipt(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'run-ops') {
    await cmdRunOps(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'shape-objective') {
    await cmdShapeObjective(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-draft') {
    await cmdTemplateDraft(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'watcher') {
    await cmdWatcherDetail(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'connector') {
    await cmdConnectorDetail(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'model-policy') {
    await cmdModelPolicyDetail(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-activate') {
    await cmdTemplateActivate(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'template-work-context') {
    await cmdTemplateWorkContext(args).catch(e => console.error(red('Error: ' + e.message)));
  } else if (cmd === 'work-context-summary') {
    await cmdWorkContextSummary(args).catch(e => console.error(red('Error: ' + e.message)));
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
