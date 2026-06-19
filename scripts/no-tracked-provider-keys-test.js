// Guard: no tracked file may contain a live-looking provider API key.
//
// Uses a length-40+ threshold so it catches real provider keys (OpenAI keys are
// ~100+ chars) without flagging short, clearly-fake test fixtures such as
// `sk-fake-...`. Prints only file PATHS, never secret values. Also asserts the
// tracked seed agents (data/agents.json) carry no real-looking apiKey.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Real provider keys are long; this threshold avoids matching sk-fake-* fixtures.
const REAL_KEY_PATTERN = 'sk-(proj-)?[A-Za-z0-9_-]{40,}';

function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }

// 1) git grep across tracked files — paths only (-l), never values.
let matchedPaths = [];
try {
  const out = execFileSync('git', ['grep', '-lE', REAL_KEY_PATTERN, '--', '.'], { cwd: ROOT, encoding: 'utf8' });
  matchedPaths = out.split('\n').map(s => s.trim()).filter(Boolean);
} catch (e) {
  // git grep exits 1 when there are no matches; that is the success case.
  if (e.status !== 1) { console.error('git grep failed:', e.message); process.exit(1); }
}
if (matchedPaths.length > 0) {
  console.error('FAIL: tracked files contain a live-looking provider key (paths only):');
  matchedPaths.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log('  ✓ no tracked file contains a real-looking provider key (>=40 chars)');

// 2) Seed agents must not carry a real-looking apiKey.
const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agents.json'), 'utf8'));
const realKeyRe = new RegExp('^' + REAL_KEY_PATTERN + '$');
const offenders = agents.filter(a => typeof a.apiKey === 'string' && realKeyRe.test(a.apiKey)).map(a => a.id);
assert(offenders.length === 0, 'data/agents.json agents carry a real-looking apiKey (ids: ' + offenders.join(', ') + ')');
console.log('  ✓ data/agents.json seed agents carry no real-looking apiKey (' + agents.length + ' agents checked)');

console.log('\nPASS: no tracked provider keys');
