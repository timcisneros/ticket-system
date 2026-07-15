#!/usr/bin/env node
'use strict';

// Public health is intentionally minimal. Detailed live data/workspace identity
// remains available to authenticated operators and the oquery divergence check.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'health-ws-'));
const PORT = process.env.PORT || '3571';
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, route, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${route}`, {
      method,
      headers: {
        ...(options.cookie ? { Cookie: options.cookie } : {}),
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

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (response.status === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server readiness');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });

  try {
    await waitForReady();
    const publicHealth = await request('GET', '/api/health');
    assert(publicHealth.status === 200, `/api/health returned HTTP ${publicHealth.status}`);
    const health = JSON.parse(publicHealth.body);
    assert(health.status === 'ok' && health.ready === true, 'public health did not report ready');
    assert(typeof health.uptime === 'number', 'public health omitted numeric uptime');
    assert(!Object.hasOwn(health, 'dataDir') && !Object.hasOwn(health, 'workspaceRoot') && !Object.hasOwn(health, 'port'), 'public health leaked runtime paths or port');

    const anonymousIdentity = await request('GET', '/api/runtime/identity');
    assert(anonymousIdentity.status === 302, `anonymous runtime identity returned HTTP ${anonymousIdentity.status}`);

    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(login.status === 302, `admin login returned HTTP ${login.status}`);
    const identityResponse = await request('GET', '/api/runtime/identity', { cookie: cookieFrom(login) });
    assert(identityResponse.status === 200, `authenticated runtime identity returned HTTP ${identityResponse.status}`);
    const identity = JSON.parse(identityResponse.body);
    assert(identity.dataDir === path.resolve(DATA_DIR), 'authenticated identity did not report selected DATA_DIR');
    assert(identity.workspaceRoot === path.resolve(WORKSPACE_ROOT), 'authenticated identity did not report selected WORKSPACE_ROOT');
    assert(String(identity.port) === String(PORT), 'authenticated identity did not report selected port');
    assert(publicHealth.headers['x-content-type-options'] === 'nosniff', 'security headers were not applied to public health');

    console.log('PASS: public health is minimal and authenticated runtime identity preserves live-path diagnostics');
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(output.slice(-2000));
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await Promise.race([waitForExit(server), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main();
