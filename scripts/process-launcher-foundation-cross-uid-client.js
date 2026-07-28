#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  ProcessLauncherFoundationClient
} = require('./runtime/process-launcher-foundation-client');

async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const client = new ProcessLauncherFoundationClient(input.client);
  let result;
  if (input.operation === 'health') result = await client.health(input.options);
  else if (input.operation === 'getRootfs') result = await client.getRootfs(input.request);
  else if (input.operation === 'verifyExecutable') {
    result = await client.verifyExecutable(input.request);
  } else {
    throw new Error('unsupported test client operation');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    code: error.code || 'UNEXPECTED',
    message: error.message
  })}\n`);
  process.exit(1);
});
