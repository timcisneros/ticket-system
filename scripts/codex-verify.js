#!/usr/bin/env node
const { spawn } = require('child_process');

const checks = [
  ['syntax/build verification', 'npm', ['run', 'build']],
  ['workflow verification', 'npm', ['run', 'test:workflow']],
  ['postcondition verification', 'npm', ['run', 'test:postcondition']],
  ['endurance verification', 'npm', ['run', 'benchmark:operational-endurance']],
  ['catalog consistency', 'node', ['scripts/catalog-consistency-test.js']],
  ['page render regression', 'node', ['scripts/page-render-regression-test.js']]
];

function runCheck([label, command, args]) {
  return new Promise((resolve, reject) => {
    console.log(`\n## ${label}`);
    console.log(`$ ${[command, ...args].join(' ')}`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'test'
      }
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

(async () => {
  for (const check of checks) {
    await runCheck(check);
  }
  console.log('\nDeterministic verification passed.');
})().catch(error => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
