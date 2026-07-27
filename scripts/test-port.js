'use strict';
// Shared test-port allocation.
//
// WHY THIS EXISTS. Eight suites used to derive a listen port from `process.pid % N`
// over hand-picked ranges that overlapped heavily — `page-render-regression-test.js`
// alone spanned 3400-4399, covering every other suite's range. `process.pid % N` is not
// collision-free, sequentially spawned suites get adjacent pids, and a previous suite's
// server child can still hold its port while the next suite starts. The observed
// failure was a suite reporting "server did not start" when the server had started fine
// and simply could not bind.
//
// THE FIX IS TO STOP GUESSING. The OS already owns a collision-free allocator: bind to
// port 0, ask what you got. Two concurrent probes cannot be handed the same port, which
// is precisely the guarantee the arithmetic could not provide.
//
// The residual race — the window between closing the probe socket and the server
// binding — is milliseconds wide and, unlike a fixed range, does not get worse with more
// suites, longer runs, or unlucky pids. Callers that need several ports get them from a
// single call so the probes are open simultaneously and cannot alias each other.

const net = require('net');

function probe() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address.port !== 'number') {
        server.close(() => reject(new Error('test port probe produced no address')));
        return;
      }
      resolve({ port: address.port, close: () => new Promise(done => server.close(done)) });
    });
  });
}

// Hold every probe open until all ports are known. Allocating one at a time would let
// the OS hand back a port it just reclaimed, so a caller asking for two could receive
// the same number twice — the exact aliasing this module exists to prevent.
async function allocateTestPorts(count = 1) {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new TypeError('allocateTestPorts requires a positive integer count');
  }
  const held = [];
  try {
    for (let i = 0; i < count; i += 1) held.push(await probe());
    const ports = held.map(entry => entry.port);
    if (new Set(ports).size !== ports.length) {
      throw new Error(`test port allocation produced duplicates: ${ports.join(', ')}`);
    }
    return ports;
  } finally {
    for (const entry of held) {
      try { await entry.close(); } catch (_) { /* already closed */ }
    }
  }
}

async function allocateTestPort() {
  return (await allocateTestPorts(1))[0];
}

module.exports = { allocateTestPort, allocateTestPorts };
