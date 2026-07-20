#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required for Postgres verification');
  process.exit(1);
}

const child = spawn('npm', ['run', 'checkpoint:release'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' }
});
child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', code => process.exit(code || 0));
