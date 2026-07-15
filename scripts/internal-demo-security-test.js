#!/usr/bin/env node
'use strict';

// Internal-demo request/session regression. NODE_ENV=production is also the
// repository's tracked-data `npm start` mode, so it must remain usable over
// local HTTP without inventing a separate production product contract.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(port, method, route, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitForExit(child, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Server did not exit within timeout'));
    }, timeoutMs);
    child.once('close', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForReady(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, 'GET', '/health');
      if (response.status === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for internal-demo server');
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-demo-security-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-demo-security-workspace-'));
  const port = process.env.PORT || '3599';
  let output = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: port,
      DATA_DIR: dataDir,
      WORKSPACE_ROOT: workspaceRoot,
      SESSION_SECRET: '',
      ADMIN_BOOTSTRAP_PASSWORD: '',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      TRUST_PROXY: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });

  try {
    try {
      await waitForReady(port);
    } catch (error) {
      throw new Error(`${error.message}; serverOutput=${output.slice(-4000)}`);
    }

    const workflows = JSON.parse(fs.readFileSync(path.join(dataDir, 'workflows.json'), 'utf8'));
    assert(workflows.length > 0, 'fresh npm-start store did not inherit the internal-demo workflow catalog');

    const rejectedOrigin = await request(port, 'POST', '/login', {
      origin: 'https://attacker.example',
      form: { username: 'admin', password: 'admin123' }
    });
    assert(rejectedOrigin.status === 403, `cross-origin login returned HTTP ${rejectedOrigin.status}`);

    const login = await request(port, 'POST', '/login', {
      origin: `http://127.0.0.1:${port}`,
      form: { username: 'admin', password: 'admin123' }
    });
    assert(login.status === 302, `same-origin login returned HTTP ${login.status}; output=${output.slice(-1000)}`);
    const setCookie = (login.headers['set-cookie'] || []).join('; ');
    assert(!/\bSecure\b/i.test(setCookie), 'local HTTP session cookie was incorrectly marked Secure');
    assert(/\bHttpOnly\b/i.test(setCookie), 'session cookie is not HttpOnly');
    assert(/SameSite=Lax/i.test(setCookie), 'session cookie is not SameSite=Lax');

    const health = await request(port, 'GET', '/api/health');
    const healthBody = JSON.parse(health.body);
    assert(health.status === 200 && healthBody.ready === true, 'public health is not ready');
    assert(!Object.hasOwn(healthBody, 'dataDir') && !Object.hasOwn(healthBody, 'workspaceRoot'), 'public health leaked storage paths');
    assert(health.headers['x-frame-options'] === 'DENY', 'X-Frame-Options is missing');
    assert(String(health.headers['content-security-policy'] || '').includes("frame-ancestors 'none'"), 'frame-ancestor CSP is missing');
    assert(!health.headers['strict-transport-security'], 'local HTTP response incorrectly advertises HSTS');

    const cookie = cookieFrom(login);
    const identity = await request(port, 'GET', '/api/runtime/identity', { cookie });
    assert(identity.status === 200, `authenticated identity returned HTTP ${identity.status}`);
    assert(JSON.parse(identity.body).dataDir === path.resolve(dataDir), 'authenticated identity reported the wrong data directory');

    const getLogout = await request(port, 'GET', '/logout', { cookie });
    assert(getLogout.status === 404, `GET logout should not mutate session state; got HTTP ${getLogout.status}`);
    const logout = await request(port, 'POST', '/logout', {
      cookie,
      origin: `http://127.0.0.1:${port}`
    });
    assert(logout.status === 302, `POST logout returned HTTP ${logout.status}`);

    console.log('PASS: internal-demo startup, local HTTP sessions, origin checks, minimal health, security headers, and POST logout');
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await waitForExit(server).catch(() => {});
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
