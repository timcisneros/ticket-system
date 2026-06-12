#!/usr/bin/env node
/**
 * NEEDS_ARMS monthly census (read-only measurement).
 * Reads the failure-classification register and run records; emits a census of
 * every NEEDS_ARMS verdict: run id, workflow, classification date, arm spec,
 * estimated experiment cost, and status.
 *
 * Status convention (no machinery): every case is "pending" unless a human adds
 * "armStatus": "approved" | "completed" to its register entry by hand.
 *
 * Cost basis (measured, this repo):
 *   spec-clarification arm, N=20, gpt-4.1-mini  ~= $0.06
 *   cross-model arm,       N=5,  gpt-5.5        ~= $0.04
 *   per-case total                              ~= $0.10
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const WS = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : path.join(ROOT, 'workspace-root');
const REGISTER = path.join(WS, 'failure-classification', 'register.json');
const OUT = path.join(WS, 'failure-classification', 'needs-arms-census.md');
const PER_CASE_COST = 0.10;

const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8')).classified;
const runs = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8')).map((r) => [r.id, r]),
);

const all = Object.entries(register);
const windowDays = Number(process.env.WINDOW_DAYS || 30);
const cutoff = Date.now() - windowDays * 86400e3;
const inWindow = all.filter(([, v]) => new Date(v.at).getTime() >= cutoff);
const needsArms = inWindow.filter(
  ([, v]) => ((v.verdict || {}).classification === 'NEEDS_ARMS') || (v.verdict || {}).needsDiscriminatorArms === true,
);

const byWorkflow = {};
for (const [k, v] of needsArms) {
  const wf = (runs[Number(k.split('-')[1])] || {}).workflowId || 'unknown';
  (byWorkflow[wf] = byWorkflow[wf] || []).push(k);
}

let md = `# NEEDS_ARMS Census — ${new Date().toISOString().slice(0, 10)} (window: last ${windowDays} days)

| Metric | Value |
|---|---|
| Classifications in window | ${inWindow.length} |
| NEEDS_ARMS cases | ${needsArms.length} |
| NEEDS_ARMS share | ${inWindow.length ? ((100 * needsArms.length) / inWindow.length).toFixed(1) : '0'}% |
| Generating workflows | ${Object.keys(byWorkflow).join(', ') || '(none)'} |
| Estimated total experiment cost | $${(needsArms.length * PER_CASE_COST).toFixed(2)} |
| Workflows able to generate content cases | ${(() => {
  const CONTENT = new Set(['fileContains', 'jsonPathEquals', 'outputFieldEquals']);
  const wfs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'workflows.json'), 'utf8'));
  return wfs.filter((w) => (w.postconditions || []).some((p) => CONTENT.has(p.type))).map((w) => w.id).join(', ') || '(none)';
})()} |

## Cases

| Run | Workflow | Classified (UTC) | Arm specification | Est. cost | Status |
|---|---|---|---|---|---|
`;
for (const [k, v] of needsArms) {
  const rid = Number(k.split('-')[1]);
  const wf = (runs[rid] || {}).workflowId || 'unknown';
  const spec = String((v.verdict || {}).armSpec || '').replace(/\|/g, '/').slice(0, 220);
  md += `| ${k} | ${wf} | ${v.at} | ${spec}... | $${PER_CASE_COST.toFixed(2)} | ${v.armStatus || 'pending'} |\n`;
}
md += `\nStatus values: pending (default) / approved / completed — set by hand in register.json ("armStatus").\n`;

fs.writeFileSync(OUT, md);
console.log(md);
