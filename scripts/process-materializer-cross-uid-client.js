#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  ProcessMaterializerClient
} = require('./runtime/process-materializer-client');

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
  throw new Error('unsupported cross-UID client operation');
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    code: error.code || 'UNEXPECTED',
    message: error.message || String(error)
  })}\n`);
  process.exit(1);
});
