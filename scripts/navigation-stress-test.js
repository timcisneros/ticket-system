const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3099';
const USERNAME = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ITERATIONS = parseInt(process.env.NAV_STRESS_ITERATIONS || '8', 10) || 8;
const CONCURRENCY = parseInt(process.env.NAV_STRESS_CONCURRENCY || '1', 10) || 1;

function request(method, pathValue, options = {}) {
  const url = new URL(pathValue, BASE_URL);
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : null;

  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data
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

function percentile(values, pct) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index];
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: USERNAME, password: PASSWORD }
  });

  if (response.statusCode !== 302) {
    throw new Error(`Login failed with HTTP ${response.statusCode}`);
  }

  return cookieFrom(response);
}

async function discoverPaths(cookie) {
  const paths = [
    '/logs?limit=20',
    '/logs?page=2&limit=20',
    '/tickets?limit=25',
    '/tickets?page=2&limit=25'
  ];

  const logsResponse = await request('GET', '/api/logs?limit=20', { cookie });
  if (logsResponse.statusCode === 200) {
    const payload = JSON.parse(logsResponse.body);
    const firstRunLog = (payload.logs || []).find(log => log.runId);
    const firstTicketLog = (payload.logs || []).find(log => log.ticketId);

    if (firstRunLog) {
      paths.push(`/runs/${firstRunLog.runId}`);
      paths.push(`/logs?runId=${firstRunLog.runId}&limit=20`);
    }

    if (firstTicketLog) {
      paths.push(`/tickets/${firstTicketLog.ticketId}`);
      paths.push(`/logs?ticketId=${firstTicketLog.ticketId}&limit=20`);
    }
  }

  return [...new Set(paths)];
}

async function main() {
  const cookie = await login();
  const paths = await discoverPaths(cookie);
  const samples = [];

  async function visit(pathValue) {
    const started = process.hrtime.bigint();
    const response = await request('GET', pathValue, { cookie });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const routeMs = parseFloat(response.headers['x-route-time-ms'] || '0');

    if (response.statusCode !== 200) {
      throw new Error(`${pathValue} returned HTTP ${response.statusCode}: ${response.body.slice(0, 160)}`);
    }

    samples.push({ path: pathValue, elapsedMs, routeMs, bytes: Buffer.byteLength(response.body) });
  }

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    if (CONCURRENCY > 1) {
      const batch = [];
      for (let index = 0; index < CONCURRENCY; index += 1) {
        batch.push(...paths.map(pathValue => visit(pathValue)));
      }
      await Promise.all(batch);
      continue;
    }

    for (const pathValue of paths) {
      await visit(pathValue);
    }
  }

  const elapsed = samples.map(sample => sample.elapsedMs);
  const route = samples.map(sample => sample.routeMs).filter(value => Number.isFinite(value));
  const byPath = new Map();

  for (const sample of samples) {
    if (!byPath.has(sample.path)) byPath.set(sample.path, []);
    byPath.get(sample.path).push(sample.routeMs || sample.elapsedMs);
  }

  const pathsSummary = [...byPath.entries()].map(([pathValue, values]) => ({
    path: pathValue,
    count: values.length,
    p50RouteMs: Number(percentile(values, 50).toFixed(1)),
    p95RouteMs: Number(percentile(values, 95).toFixed(1)),
    maxBytes: Math.max(...samples.filter(sample => sample.path === pathValue).map(sample => sample.bytes))
  }));

  console.log(JSON.stringify({
    baseUrl: BASE_URL,
    iterations: ITERATIONS,
    concurrency: CONCURRENCY,
    requests: samples.length,
    p50ElapsedMs: Number(percentile(elapsed, 50).toFixed(1)),
    p95ElapsedMs: Number(percentile(elapsed, 95).toFixed(1)),
    p50RouteMs: Number(percentile(route, 50).toFixed(1)),
    p95RouteMs: Number(percentile(route, 95).toFixed(1)),
    paths: pathsSummary
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
