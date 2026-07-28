#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const {
  ProcessMaterializerClient,
  encodeFrame,
  parseResponse
} = require('./runtime/process-materializer-client');

function rawAcquire(client, request) {
  const requestId = `request-${crypto.randomBytes(24).toString('hex')}`;
  const frame = encodeFrame({
    version: 1,
    requestId,
    operation: 'acquireSnapshot',
    body: request
  });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: client.socketPath });
    let bytes = Buffer.alloc(0);
    socket.setTimeout(client.timeoutMs);
    socket.on('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (bytes.length !== length + 4) return;
      try {
        resolve(parseResponse(bytes.subarray(4), requestId));
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
    socket.on('timeout', () => reject(new Error('raw acquire timed out')));
    socket.on('error', reject);
  });
}

async function main() {
  if (process.argv.length !== 3) throw new Error('client request file is required');
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const client = new ProcessMaterializerClient(input.client);
  if (input.operation === 'health') {
    process.stdout.write(`${JSON.stringify(await client.health())}\n`);
    return;
  }
  if (input.operation === 'materialize') {
    process.stdout.write(`${JSON.stringify(await client.materialize(input.request))}\n`);
    return;
  }
  if (input.operation === 'getSnapshot') {
    process.stdout.write(`${JSON.stringify(await client.getSnapshot(input.request))}\n`);
    return;
  }
  if (input.operation === 'rawAcquire') {
    process.stdout.write(`${JSON.stringify(await rawAcquire(input.client, input.request))}\n`);
    return;
  }
  throw new Error('unsupported cross-UID client operation');
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    code: error.code || 'UNEXPECTED',
    message: error.message || String(error)
  })}\n`);
  process.exit(1);
});
