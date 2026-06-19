// Focused regression: /api/health must report the live, selected runtime
// data/workspace paths (DATA_DIR / workspaceProvider.root), not hardcoded
// literals. Display/observability only — does not exercise store/workspace
// mutation behavior.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'health-ws-'));
const PORT = process.env.PORT || '3571';
const BASE = `http://127.0.0.1:${PORT}`;
// Server resolves both paths with path.resolve(); compare against the same.
const EXPECT_DATA_DIR = path.resolve(DATA_DIR);
const EXPECT_WORKSPACE_ROOT = path.resolve(WORKSPACE_ROOT);

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request(`${BASE}${p}`, { method }, resp => { const c = []; resp.on('data', d => c.push(d)); resp.on('end', () => res({ status: resp.statusCode, body: Buffer.concat(c).toString('utf8') })); });
    r.on('error', rej); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; server.stderr.on('data', d => err += d);
  let pass = 0, fail = 0;
  const ok = (n, c) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ FAIL: ' + n));
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { const h = await req('GET', '/health'); if (h.status === 200 && JSON.parse(h.body).ready) { ready = true; break; } } catch {} await sleep(100); }
    ok('server boots', ready); if (!ready) { console.log(err.slice(0, 400)); throw new Error('not ready'); }

    const res = await req('GET', '/api/health');
    ok('/api/health returns 200', res.status === 200);
    const body = JSON.parse(res.body);

    ok('status is ok', body.status === 'ok');
    ok('port matches selected PORT', String(body.port) === String(PORT));
    ok('dataDir reports the selected DATA_DIR (not "data")', body.dataDir === EXPECT_DATA_DIR && body.dataDir !== 'data');
    ok('workspaceRoot reports the selected WORKSPACE_ROOT (not "workspace-root")', body.workspaceRoot === EXPECT_WORKSPACE_ROOT && body.workspaceRoot !== 'workspace-root');
    ok('uptime field preserved (number)', typeof body.uptime === 'number');

    console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ': health live store paths (' + pass + ' passed, ' + fail + ' failed)');
  } catch (e) {
    console.error('ERROR', e.stack || e.message);
    fail++;
  } finally {
    server.kill();
    await sleep(200);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }
})();
