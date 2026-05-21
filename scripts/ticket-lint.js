#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

function readJson(name) {
  const fp = path.join(DATA_DIR, name);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return []; }
}

function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s) { return `\x1b[36m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }

// ── Ticket parsing ──

function parseTicketText(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let currentLabel = '';
  let currentLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const numbered = trimmed.match(/^(\d+)[.)]\s*(.*)/);
    if (numbered) {
      if (currentLabel) {
        items.push({ label: currentLabel, text: currentLines.join('\n').trim() });
      }
      currentLabel = numbered[1];
      currentLines = [numbered[2]];
    } else {
      if (currentLabel) currentLines.push(trimmed);
    }
  }
  if (currentLabel) {
    items.push({ label: currentLabel, text: currentLines.join('\n').trim() });
  }

  return {
    lines,
    items,
    rawText: text,
  };
}

// ── Lint rules ──

// Rule 1: No numbered items
function ruleHasNumberedItems(parsed) {
  if (parsed.items.length === 0) {
    return { fail: true, severity: 'error', message: 'No numbered items found. Use "1.", "2.", etc. to enumerate concrete work items.' };
  }
  return null;
}

// Rule 2: Too many items for single run (>16)
function ruleItemCount(parsed) {
  const count = parsed.items.length;
  if (count > 16) {
    const extra = count - 16;
    const suggestedRuns = Math.ceil(count / 16);
    return {
      fail: true,
      severity: 'warning',
      message: `${count} items exceeds the ~16-item reliable mutation ceiling. Suggests splitting across ${suggestedRuns} runs (continuations).`,
      detail: `First ${suggestedRuns - 1} run(s): ~16 items each. Final run: ${count - (suggestedRuns - 1) * 16} items.`
    };
  }
  if (count > 10) {
    return { fail: true, severity: 'info', message: `${count} items is near the mutation ceiling. Consider whether a continuation boundary is needed.` };
  }
  return null;
}

// Rule 3: Vague / compound items
function ruleVagueItems(parsed) {
  const vaguePatterns = [
    /\bmanage\b/i,
    /\bhandle\b/i,
    /\bprocess\b/i,
    /\bdeal\s+with\b/i,
    /\bdo\s+(the\s+)?(rest|remaining|other)\b/i,
    /\betc\b/i,
    /\ball\s+(the\s+)?(necessary|required|appropriate)\b/i,
    /\bas\s+needed\b/i,
  ];
  const findings = [];
  for (const item of parsed.items) {
    for (const pat of vaguePatterns) {
      if (pat.test(item.text)) {
        findings.push({ item: item.label, text: item.text.substring(0, 80), pattern: pat.source });
        break;
      }
    }
  }
  if (findings.length > 0) {
    return {
      fail: true,
      severity: 'warning',
      message: `${findings.length} item(s) may be vague or compound:`,
      detail: findings.map(f => `  Item ${f.item}: "${f.text}"`).join('\n')
    };
  }
  return null;
}

// Rule 4: Range descriptors like "Monday through Sunday"
function ruleRangeDescriptors(parsed) {
  const rangePat = /\b(through|thru|to|through|and|or)\b/i;
  const findings = [];
  for (const item of parsed.items) {
    if (rangePat.test(item.text) && !item.text.match(/^\d+\s*[-–]/)) {
      // Check if it's actually a range
      const rangeIndicators = item.text.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).+(through|thru|to|\band\b).+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
      if (rangeIndicators) {
        findings.push({ item: item.label, text: item.text.substring(0, 80) });
      }
    }
  }
  if (findings.length > 0) {
    return {
      fail: true,
      severity: 'info',
      message: `${findings.length} item(s) use range descriptors — these are accepted but explicit enumeration is safer:`,
      detail: findings.map(f => `  Item ${f.item}: "${f.text}"`).join('\n')
    };
  }
  return null;
}

// Rule 5: Missing "Do not recreate" for continuation tickets
function ruleContinuationDoNotRecreate(parsed) {
  const text_lower = parsed.rawText.toLowerCase();
  const isContinuation = /continua|continue|resume|further\s+work/i.test(text_lower) || /remaining/i.test(text_lower) || /missing/i.test(text_lower);
  if (isContinuation && !/do\s+not\s+(recreate|re[- ]?create|create\s+existing)/i.test(text_lower)) {
    return { fail: true, severity: 'warning', message: 'Continuation/remaining-work ticket should include "Do not recreate existing items."' };
  }
  return null;
}

// Rule 6: Continuation missing explicit item listing
function ruleContinuationExplicitItems(parsed) {
  const text_lower = parsed.rawText.toLowerCase();
  const isContinuation = /continua|continue|resume|further\s+work/i.test(text_lower) || /remaining/i.test(text_lower) || /missing/i.test(text_lower) || /do\s+not\s+recreate/i.test(text_lower);
  if (isContinuation && parsed.items.length < 3) {
    return { fail: true, severity: 'info', message: 'Continuation ticket has few numbered items — consider explicitly enumerating remaining items to avoid side-branch skipping.' };
  }
  return null;
}

// Rule 7: Missing "Do not inspect first" for optimistic continuation
function ruleOptimisticNoInspect(parsed) {
  const text_lower = parsed.rawText.toLowerCase();
  const hasOptInstruct = /do\s+not\s+(inspect|list|check|look)/i.test(text_lower);
  const isBulkWork = parsed.items.length > 5 || /\bcreate\b/i.test(parsed.rawText) && parsed.items.length > 3;
  // Also trigger for content-dependent patterns (read+write in same ticket)
  const hasReadAndWrite = /\b(read|check|verify)\b/i.test(text_lower) && /\b(overwrite|update|modify)\b/i.test(text_lower);
  if ((isBulkWork || hasReadAndWrite) && !hasOptInstruct) {
    return { fail: true, severity: 'info', message: 'Bulk create or content-dependent work may benefit from "Do not inspect first" to avoid wasting steps on inspection.' };
  }
  return null;
}

// Rule 8: Budget estimation
function ruleBudgetEstimation(parsed) {
  const items = parsed.items.length || 1;
  const estMutations = Math.max(
    items * 2 + 1,
    // Estimate: each item is roughly 2 mutations (one ops per numbered action)
    // Overhead: 1-2 list operations
    3
  );
  const estSteps = Math.ceil(estMutations / 8);
  const defaultBudget = 4;
  const opsPerStep = 8;

  const itemOps = {};
  for (const item of parsed.items) {
    // Count 'create', 'write', 'add', 'overwrite' keywords as operations
    const opMatches = (item.text.match(/\b(create|write|add|overwrite|make|copy|delete|rename|move)\b/gi) || []).length;
    itemOps[item.label] = Math.max(1, opMatches);
  }

  const totalEstimatedOps = Object.values(itemOps).reduce((a, b) => a + b, 0) + items + 1; // +1 for list
  const estimatedSteps = Math.ceil(totalEstimatedOps / opsPerStep);
  const budgetOk = estimatedSteps <= defaultBudget;

  return {
    fail: !budgetOk,
    severity: budgetOk ? 'info' : 'warning',
    message: `Estimated ~${totalEstimatedOps} ops across ~${estimatedSteps} steps (${defaultBudget}-step budget: ${budgetOk ? green('OK') : red('OVER')})`,
    detail: `  Steps needed: ${estimatedSteps} (budget: ${defaultBudget}, ops: ~${totalEstimatedOps}, max ${opsPerStep}/step)\n  Per-item estimate:\n` +
      Object.entries(itemOps).map(([k, v]) => `    Item ${k}: ~${v} op(s)`).join('\n') +
      `\n  Estimated runs: ${Math.ceil(totalEstimatedOps / 16)} (if >1, needs continuation)`
  };
}

// Rule 9: Check if the ticket has explicit "do not write outside" for allocated agents
function ruleAllocatedScope(parsed) {
  const text_lower = parsed.rawText.toLowerCase();
  const allocated = /allocat/i.test(text_lower) || /agent/i.test(text_lower);
  if (allocated && !/do\s+not\s+(write|create|go)\s+(outside|beyond)/i.test(text_lower)) {
    return { fail: true, severity: 'info', message: 'Allocated ticket — consider adding "Do not write outside the owned output path."' };
  }
  return null;
}

// Rule 10: Mixed instructions (create + verify in same ticket)
function ruleMixedInspectAndDo(parsed) {
  const hasInspect = /\b(check|verify|list|inspect|confirm|ensure)\b/i.test(parsed.rawText);
  const hasCreate = /\b(create|write|add|make)\b/i.test(parsed.rawText);
  if (hasInspect && hasCreate) {
    return { fail: true, severity: 'info', message: 'Ticket mixes inspection and creation — this is fine but may waste a step on listing. Consider "Do not inspect first" for efficiency.' };
  }
  return null;
}

// ── Estimation helpers ──

function estimate(parsed) {
  const items = parsed.items;
  let totalOps = 0;
  let crudOps = 0;
  let fileOps = 0;

  for (const item of items) {
    const creates = (item.text.match(/\b(create|make)\b/gi) || []).length;
    const writes = (item.text.match(/\b(write|add|overwrite)\b/gi) || []).length;
    const deletes = (item.text.match(/\b(delete|remove)\b/gi) || []).length;
    const renames = (item.text.match(/\b(rename|move)\b/gi) || []).length;
    const lists = (item.text.match(/\b(list|check|inspect|confirm|verify)\b/gi) || []).length;

    const itemOps = creates + writes + deletes + renames + Math.min(lists, 1);
    totalOps += itemOps;
    crudOps += creates + writes + deletes + renames;
    fileOps += writes + renames;
  }

  const totalWithOverhead = totalOps + 1; // +1 for initial list
  const steps4Budget = Math.ceil(totalWithOverhead / 8);
  const steps5Budget = Math.ceil(totalWithOverhead / 8);

  return {
    totalEstimatedOps: totalWithOverhead,
    crudOps,
    fileOps,
    estimatedSteps4Budget: Math.max(steps4Budget, 1),
    estimatedSteps5Budget: Math.max(steps5Budget, 1),
    estimatedRuns: Math.ceil(totalWithOverhead / 16),
    suggestedContinuations: Math.max(0, Math.ceil(totalWithOverhead / 16) - 1),
    itemsPerRun: items.length > 0 ? Math.ceil(items.length / Math.max(1, Math.ceil(totalWithOverhead / 16))) : 0,
  };
}

// ─── Continuation suggestions ───

function suggestContinuations(parsed) {
  const items = parsed.items;
  if (items.length <= 16) return [];

  const suggestions = [];
  const runs = Math.ceil(items.length / 16);

  for (let r = 0; r < runs; r++) {
    const start = r * 16;
    const end = Math.min(start + 16, items.length);
    const runItems = items.slice(start, end);
    const firstLine = runItems[0] ? `${runItems[0].label}. ${runItems[0].text}` : '';

    if (r === 0) {
      suggestions.push({
        run: r + 1,
        type: 'initial',
        items: runItems.map(i => i.label),
        suggestedBudget: '4-5 steps (default)',
        hint: `Items ${start + 1}-${end}. First item: "${firstLine.substring(0, 60)}"`
      });
    } else {
      suggestions.push({
        run: r + 1,
        type: 'continuation',
        items: runItems.map(i => i.label),
        suggestedBudget: '4 steps (continuation resets window)',
        firstItem: runItems[0] ? `${runItems[0].label}. ${runItems[0].text}` : '',
        hint: `Continuation ticket. Items ${start + 1}-${end}. First item must be "${runItems[0] ? runItems[0].text.substring(0, 40) : ''}". Include "Do not recreate existing items."`
      });
    }
  }

  return suggestions;
}

// ─── Allocation template suggestion ───

function suggestAllocationTemplate(parsed) {
  const items = parsed.items;
  if (items.length === 0) return null;

  // Check if items seem independently allocatable
  const isIndependent = items.every(item => {
    // Each item should be a self-contained unit
    return item.text.length > 0 && !/\binside\s+(the\s+)?(same\b|above\b|prior\b|previous\b)/i.test(item.text);
  });

  if (!isIndependent) return null;

  return {
    suggestedMode: items.length > 3 ? 'allocated' : 'individual',
    template: items.length > 3 ? 'allocated' : 'individual',
    subtaskTemplate: items.map(item => `  Agent <%= agentId %>: Item ${item.label}: ${item.text}`).join('\n'),
    note: items.length > 3
      ? 'Items are independent — consider allocating to multiple agents.'
      : 'Few items — individual assignment is fine.',
  };
}

// ─── Preview (pretty-print with annotations) ───

function preview(parsed, rules, estimates, contSuggestions, allocSuggestion) {
  console.log(`\n  ${bold('Ticket Preview')}`);
  console.log(`  ${dim('─'.repeat(50))}`);

  for (let i = 0; i < parsed.lines.length; i++) {
    const line = parsed.lines[i];
    // Check if this line starts a numbered item
    const itemMatch = line.trim().match(/^(\d+)[.)]/);
    if (itemMatch) {
      const itemNum = itemMatch[1];
      const item = parsed.items.find(it => it.label === itemNum);
      if (item) {
        const est = item ? estimateForItem(item, parsed) : '';
        const estStr = est ? ` ${dim(`[~${est} op(s)]`)}` : '';
        console.log(`  ${bold(line)}${estStr}`);
        continue;
      }
    }
    console.log(`  ${line}`);
  }

  console.log('');

  // Estimates summary
  if (estimates) {
    console.log(`  ${bold('Estimates')}`);
    console.log(`  ${dim('─'.repeat(40))}`);
    const stepStr = estimates.estimatedSteps4Budget <= 4
      ? green(`${estimates.estimatedSteps4Budget} steps`)
      : red(`${estimates.estimatedSteps4Budget} steps (over budget)`);
    console.log(`  Operations:    ~${estimates.totalEstimatedOps}`);
    console.log(`  Steps needed:  ${stepStr} (budget: 4)`);
    console.log(`  Runs needed:   ${estimates.estimatedRuns} (continuations: ${estimates.suggestedContinuations})`);
    console.log(`  Items/run:     ~${estimates.itemsPerRun}`);
    console.log('');
  }

  // Continuation suggestions
  if (contSuggestions && contSuggestions.length > 0) {
    console.log(`  ${bold('Continuation Split')}`);
    console.log(`  ${dim('─'.repeat(40))}`);
    for (const s of contSuggestions) {
      const type = s.type === 'initial' ? green('INITIAL') : yellow('CONTINUATION');
      console.log(`  ${type} Run ${s.run}: items ${s.items.join(', ')}`);
      console.log(`         ${dim(s.hint)}`);
    }
    console.log('');
  }

  // Allocation suggestion
  if (allocSuggestion) {
    console.log(`  ${bold('Allocation Suggestion')}`);
    console.log(`  ${dim('─'.repeat(40))}`);
    console.log(`  Mode: ${allocSuggestion.suggestedMode}`);
    console.log(`  ${dim(allocSuggestion.note)}`);
    console.log('');
  }
}

function estimateForItem(item, parsed) {
  const creates = (item.text.match(/\b(create|make)\b/gi) || []).length;
  const writes = (item.text.match(/\b(write|add|overwrite)\b/gi) || []).length;
  return Math.max(1, creates + writes);
}

// ─── Main lint function ───

function lintTicket(text, opts = {}) {
  const parsed = parseTicketText(text);
  const rules = [];

  if (!opts.noNumberedItems) rules.push(ruleHasNumberedItems(parsed));
  if (!opts.noItemCount) rules.push(ruleItemCount(parsed));
  if (!opts.noVagueItems) rules.push(ruleVagueItems(parsed));
  if (!opts.noRangeDesc) rules.push(ruleRangeDescriptors(parsed));
  if (!opts.noContinuationRecreate) rules.push(ruleContinuationDoNotRecreate(parsed));
  if (!opts.noContinuationExplicit) rules.push(ruleContinuationExplicitItems(parsed));
  if (!opts.noOptimisticNoInspect) rules.push(ruleOptimisticNoInspect(parsed));
  if (!opts.noBudget) rules.push(ruleBudgetEstimation(parsed));
  if (!opts.noAllocScope) rules.push(ruleAllocatedScope(parsed));
  if (!opts.noMixedInspectDo) rules.push(ruleMixedInspectAndDo(parsed));

  const pass = rules.filter(r => !r || !r.fail);
  const fail = rules.filter(r => r && r.fail);
  const errors = fail.filter(r => r.severity === 'error');
  const warnings = fail.filter(r => r.severity === 'warning');
  const infos = fail.filter(r => r.severity === 'info');

  const est = estimate(parsed);
  const contSug = suggestContinuations(parsed);
  const allocSug = suggestAllocationTemplate(parsed);

  return {
    parsed,
    summary: { total: rules.length, pass: pass.length, fail: fail.length, errors: errors.length, warnings: warnings.length, infos: infos.length },
    errors,
    warnings,
    infos,
    estimates: est,
    continuationSuggestions: contSug,
    allocationSuggestion: allocSug,
  };
}

// ─── Display ───

function displayResult(result, opts = {}) {
  if (opts.json) return console.log(JSON.stringify(result, null, 2));

  const s = result.summary;
  console.log(`\n  ${bold('Lint Results')}`);
  console.log(`  ${dim('─'.repeat(40))}`);
  console.log(`  ${s.pass} pass / ${s.fail} fail (${s.errors} errors, ${s.warnings} warnings, ${s.infos} infos)`);
  console.log('');

  if (result.errors.length > 0) {
    console.log(`  ${bold(red('Errors'))}`);
    result.errors.forEach(r => console.log(`    ${red('✗')} ${r.message}`));
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log(`  ${bold(yellow('Warnings'))}`);
    result.warnings.forEach(r => {
      console.log(`    ${yellow('⚠')} ${r.message}`);
      if (r.detail) console.log(`       ${dim(r.detail)}`);
    });
    console.log('');
  }

  if (result.infos.length > 0) {
    console.log(`  ${bold('Info')}`);
    result.infos.forEach(r => {
      console.log(`    ${cyan('ℹ')} ${r.message}`);
      if (r.detail) console.log(`       ${dim(r.detail)}`);
    });
    console.log('');
  }

  if (!opts.noPreview) {
    preview(result.parsed, result.infos, result.estimates, result.continuationSuggestions, result.allocationSuggestion);
  }
}

// ─── Analyze existing tickets from data store ───

function analyzeExisting(opts) {
  console.log(dim(`[local substrate: ${DATA_DIR}]`));
  const data = readJson('tickets.json');
  if (data.length === 0) return console.log(dim('No existing tickets found.'));

  const targetIds = opts.id ? opts.id.split(',').map(Number) : null;

  for (const ticket of data) {
    if (targetIds && !targetIds.includes(ticket.id)) continue;

    console.log(`\n${bold(`══════════════════════ Ticket #${ticket.id} ══════════════════════`)}`);
    console.log(`  ${dim('Status:')} ${ticket.status} ${dim('Created:')} ${ticket.createdAt}`);
    console.log(`  ${dim('Objective:')} ${ticket.objective.substring(0, 120).replace(/\r?\n/g, '\\n')}`);
    console.log('');

    // Check if related runs exist
    const runs = readJson('runs.json').filter(r => r.ticketId === ticket.id);
    if (runs.length > 0) {
      const completed = runs.filter(r => r.status === 'completed').length;
      const failed = runs.filter(r => r.status === 'failed').length;
      console.log(`  ${dim('Runs:')} ${runs.length} (${green(`${completed} completed`)}, ${red(`${failed} failed`)})`);
      const totalMutations = runs.reduce((sum, r) => sum + (r.mutationCount || 0), 0);
      console.log(`  ${dim('Total mutations:')} ${totalMutations}`);
      console.log('');
    }

    const result = lintTicket(ticket.objective, opts);
    displayResult(result, opts);
  }
}

// ─── Main ───

function help() {
  console.log(`
  ${bold('ticket-lint')} — ticket ergonomics tool

  ${bold('Usage:')}
    ticket-lint <command> [options]

  ${bold('Commands:')}
    lint "<ticket-text>"    Lint a ticket objective string
    lint --file <path>      Lint a ticket from a file
    lint --stdin            Lint from stdin (pipe or paste)

    analyze                 Analyze ALL existing tickets in data store
    analyze --id <ids>      Analyze specific ticket IDs (comma-separated)

    template <n>            Generate a ticket template with n items

  ${bold('Options:')}
    --json                  Output raw JSON
    --no-preview            Skip the preview section
    --no-numbered-items     Skip numbered-items rule
    --no-item-count         Skip item-count rule
    --no-vague-items        Skip vague-items rule
    --no-range-desc         Skip range-descriptor rule
    --no-continuation-recreate    Skip continuation recreate rule
    --no-continuation-explicit    Skip continuation explicit rule
    --no-optimistic-no-inspect    Skip optimistic no-inspect rule
    --no-budget             Skip budget estimation rule
    --no-alloc-scope        Skip allocation scope rule
    --no-mixed-inspect-do   Skip mixed inspect-do rule

  ${bold('Examples:')}
    node scripts/ticket-lint.js lint "1. Create folder X\\n2. Write file Y"
    node scripts/ticket-lint.js lint --file ticket.txt
    node scripts/ticket-lint.js analyze --id 5,9
    node scripts/ticket-lint.js analyze
    node scripts/ticket-lint.js template 12
    echo "1. My item" | node scripts/ticket-lint.js lint --stdin
`);
}

function generateTemplate(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`${i}. [task description ${i}]`);
  }
  console.log(lines.join('\n'));
}

function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h') return help();

  const args = { _: [] };
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.slice(2).split('=') : [a.slice(2), process.argv[++i]];
      if (v !== undefined) args[k] = v;
      else args[k] = true;
    } else {
      args._.push(a);
    }
  }

  // Parse opts for rules
  const ruleOpts = {};
  for (const key of ['noNumberedItems', 'noItemCount', 'noVagueItems', 'noRangeDesc',
    'noContinuationRecreate', 'noContinuationExplicit', 'noOptimisticNoInspect',
    'noBudget', 'noAllocScope', 'noMixedInspectDo', 'noPreview']) {
    if (args[key] !== undefined) ruleOpts[key] = true;
  }

  if (cmd === 'lint') {
    let text = args._.join(' ');

    if (args.stdin) {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const result = lintTicket(input.trim(), ruleOpts);
        displayResult(result, { ...ruleOpts, json: args.json });
      });
      return;
    }

    if (args.file) {
      text = fs.readFileSync(path.resolve(args.file), 'utf8');
    }

    if (!text) {
      return console.log(red('No ticket text provided. Use a positional argument, --file, or --stdin.'));
    }

    const result = lintTicket(text, ruleOpts);
    displayResult(result, { ...ruleOpts, json: args.json });

  } else if (cmd === 'analyze') {
    analyzeExisting({ ...ruleOpts, id: args.id, json: args.json, noPreview: args['no-preview'] || ruleOpts.noPreview });

  } else if (cmd === 'template') {
    const n = parseInt(args._[0] || '8');
    generateTemplate(n);

  } else {
    console.log(`Unknown command: ${cmd}`);
    help();
  }
}

main();
