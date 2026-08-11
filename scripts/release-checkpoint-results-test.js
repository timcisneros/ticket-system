#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_RESULT_PARENT,
  FIRST_FAILURE_FILE,
  REGISTRY_FILE,
  TERMINAL_FILE,
  buildRegistryIdentity,
  sha256
} = require('./release-checkpoint-results');

const ROOT = path.resolve(__dirname, '..');
const RECORDER = path.join(__dirname, 'release-checkpoint-results.js');
let assertions = 0;

function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function currentHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function ownerDirectory(runRoot, ordinal, owner) {
  return path.join(runRoot, 'owners', `${String(ordinal).padStart(3, '0')}-${owner}`);
}

function writeOwner(directory, name, { stdout, stderr, exitCode = 0, marker = null }) {
  const file = path.join(directory, name);
  const source = [
    "'use strict';",
    "const fs = require('node:fs');",
    marker ? `fs.writeFileSync(${JSON.stringify(marker)}, 'ran\\n');` : '',
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.exitCode = ${exitCode};`,
    ''
  ].filter(Boolean).join('\n');
  fs.writeFileSync(file, source, { mode: 0o700 });
  return file;
}

function makeChecks(ownerSpecs) {
  return ownerSpecs.map(spec => ({
    owner: spec.owner,
    category: spec.category,
    sourcePath: spec.sourcePath,
    command: process.execPath,
    args: [spec.sourcePath],
    cwd: ROOT
  }));
}

function runControlled(directory, name, ownerSpecs, { interruptOrdinal = null } = {}) {
  const resultParent = path.join(directory, `${name}-results`);
  const runIdentity = `${name}-${crypto.randomBytes(8).toString('hex')}`;
  const specPath = path.join(directory, `${name}-spec.json`);
  const harnessPath = path.join(directory, `${name}-harness.js`);
  const spec = {
    resultParent,
    runIdentity,
    interruptOrdinal,
    owners: ownerSpecs
  };
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  fs.writeFileSync(harnessPath, [
    "'use strict';",
    "const fs = require('node:fs');",
    `const { executeCheckpoint } = require(${JSON.stringify(RECORDER)});`,
    `const root = ${JSON.stringify(ROOT)};`,
    'const spec = JSON.parse(fs.readFileSync(process.env.CHECKPOINT_CONTROL_SPEC, \'utf8\'));',
    'const checks = spec.owners.map(owner => ({',
    '  ...owner,',
    '  command: process.execPath,',
    '  args: [owner.sourcePath],',
    '  cwd: root',
    '}));',
    'executeCheckpoint({',
    '  root,',
    '  checks,',
    '  environment: { ...process.env, NODE_ENV: \'test\' },',
    '  resultParent: spec.resultParent,',
    '  runIdentity: spec.runIdentity,',
    '  mirrorOutput: false,',
    '  onOwnerStarted: owner => {',
    '    if (owner.ordinal === spec.interruptOrdinal) process.exit(86);',
    '  }',
    '}).then(result => { process.exitCode = result.exitCode; }).catch(error => {',
    '  process.stderr.write(`${error.stack || error.message}\\n`);',
    '  process.exitCode = 99;',
    '});',
    ''
  ].join('\n'));

  const child = spawnSync(process.execPath, [harnessPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CHECKPOINT_CONTROL_SPEC: specPath,
      OPENAI_API_KEY: 'fake-checkpoint-recorder-test-credential',
      EVALUATION_LIVE_AUTHORIZATION: 'fake-checkpoint-recorder-test-authorization'
    },
    maxBuffer: 10 * 1024 * 1024
  });
  const matches = fs.readdirSync(resultParent)
    .filter(entry => entry.endsWith(`-${runIdentity}`));
  assert.equal(matches.length, 1, `expected one durable run root, got ${matches.join(', ')}`);
  return {
    child,
    runRoot: path.join(resultParent, matches[0]),
    checks: makeChecks(ownerSpecs)
  };
}

function assertStreamEvidence(runRoot, ordinal, spec, expectedResult) {
  const directory = ownerDirectory(runRoot, ordinal, spec.owner);
  const result = readJson(path.join(directory, 'owner-result.json'));
  const stdout = fs.readFileSync(path.join(directory, 'stdout.log'));
  const stderr = fs.readFileSync(path.join(directory, 'stderr.log'));
  equal(stdout.toString('utf8'), spec.stdout, `${spec.owner} stdout is complete`);
  equal(stderr.toString('utf8'), spec.stderr, `${spec.owner} stderr is complete`);
  equal(result.stdoutRawSha256, sha256(stdout), `${spec.owner} stdout hash reproduces`);
  equal(result.stderrRawSha256, sha256(stderr), `${spec.owner} stderr hash reproduces`);
  equal(result.result, expectedResult, `${spec.owner} result is durable`);
  return result;
}

function failureScenario(directory, ownersDirectory, head) {
  const marker = path.join(directory, 'failure-owner-three-ran');
  const specs = [
    {
      owner: 'controlled-syntax-pass.js',
      category: 'syntax',
      stdout: 'owner one stdout line 1\nowner one stdout line 2\n',
      stderr: 'owner one stderr\n'
    },
    {
      owner: 'controlled-deterministic-fail.js',
      category: 'deterministic',
      stdout: 'owner two stdout beginning\nowner two stdout end\n',
      stderr: 'owner two exact failure diagnostic\n',
      exitCode: 7
    },
    {
      owner: 'controlled-postgres-must-not-run.js',
      category: 'postgres',
      stdout: 'owner three stdout\n',
      stderr: 'owner three stderr\n',
      marker
    }
  ];
  for (const spec of specs) {
    spec.sourcePath = writeOwner(ownersDirectory, spec.owner, { ...spec, marker: spec.marker });
  }
  const execution = runControlled(directory, 'failure', specs);
  equal(execution.child.status, 7, 'controlled failure preserves the owner exit code');
  check(execution.child.stdout.includes('RELEASE CHECKPOINT RESULT ROOT:'),
    'checkpoint prints its durable result root at startup');
  const registry = readJson(path.join(execution.runRoot, REGISTRY_FILE));
  const expectedRegistry = buildRegistryIdentity(execution.checks);
  equal(registry.registryHash, expectedRegistry.registryHash,
    'durable registry identity matches the executed owner registry');
  const started = readJson(path.join(execution.runRoot, 'checkpoint-started.json'));
  equal(started.repositoryCommit, head, 'exact repository HEAD is recorded');
  equal(started.environmentClassification.providerLiveVariablesScrubbed, true,
    'provider and live variables are scrubbed before owners run');
  const first = assertStreamEvidence(execution.runRoot, 1, specs[0], 'PASS');
  equal(first.exitCode, 0, 'owner one exit code is retained');
  const failed = assertStreamEvidence(execution.runRoot, 2, specs[1], 'FAIL');
  equal(failed.exitCode, 7, 'owner two nonzero exit code is retained');
  check(!fs.existsSync(ownerDirectory(execution.runRoot, 3, specs[2].owner)),
    'fail-fast orchestration never starts owner three');
  check(!fs.existsSync(marker), 'owner three side effect is absent');
  const firstFailure = readJson(path.join(execution.runRoot, FIRST_FAILURE_FILE));
  equal(firstFailure.ordinal, 2, 'first-failure marker points to ordinal two');
  equal(firstFailure.owner, specs[1].owner, 'first-failure marker points to owner two');
  equal(firstFailure.stdoutRawSha256, failed.stdoutRawSha256,
    'first-failure stdout identity matches owner evidence');
  equal(firstFailure.stderrRawSha256, failed.stderrRawSha256,
    'first-failure stderr identity matches owner evidence');
  const terminal = readJson(path.join(execution.runRoot, TERMINAL_FILE));
  equal(terminal.state, 'FAILED', 'overall result is FAILED');
  equal(terminal.passedCount, 1, 'failed checkpoint preserves the passed count');
  equal(terminal.perOwnerResultCount, 2, 'failed checkpoint preserves two owner results');
  equal(terminal.firstFailedOwner, specs[1].owner, 'terminal record names the exact owner');
  check(fs.existsSync(path.join(ownerDirectory(execution.runRoot, 2, specs[1].owner), 'stdout.log')),
    'owner streams survive orchestration process exit');
}

function successScenario(directory, ownersDirectory, head) {
  const specs = [
    { owner: 'success-syntax.js', category: 'syntax', stdout: 'syntax ok\n', stderr: 'syntax note\n' },
    { owner: 'success-deterministic.js', category: 'deterministic', stdout: 'deterministic ok\n', stderr: '' },
    { owner: 'success-postgres.js', category: 'postgres', stdout: 'postgres ok\n', stderr: 'postgres note\n' }
  ];
  for (const spec of specs) spec.sourcePath = writeOwner(ownersDirectory, spec.owner, spec);
  const execution = runControlled(directory, 'success', specs);
  equal(execution.child.status, 0, 'all-pass checkpoint exits zero');
  const started = readJson(path.join(execution.runRoot, 'checkpoint-started.json'));
  equal(started.repositoryCommit, head, 'success record binds the exact repository HEAD');
  specs.forEach((spec, index) => {
    const result = assertStreamEvidence(execution.runRoot, index + 1, spec, 'PASS');
    equal(result.ordinal, index + 1, `${spec.owner} retains exact order`);
  });
  check(!fs.existsSync(path.join(execution.runRoot, FIRST_FAILURE_FILE)),
    'successful checkpoint has no first-failure marker');
  const terminal = readJson(path.join(execution.runRoot, TERMINAL_FILE));
  equal(terminal.state, 'PASSED', 'overall result is PASSED');
  equal(terminal.passedCount, specs.length, 'all owners count as passed');
  equal(terminal.totalCount, specs.length, 'terminal result retains total count');
  equal(terminal.perOwnerResultCount, specs.length, 'terminal result retains every owner result');
  equal(terminal.firstFailedOwner, null, 'successful checkpoint has no failed owner');
}

function interruptionScenario(directory, ownersDirectory, head) {
  const specs = [
    { owner: 'interrupt-syntax.js', category: 'syntax', stdout: 'first complete\n', stderr: '' },
    { owner: 'interrupt-started.js', category: 'deterministic', stdout: 'must not execute\n', stderr: '' },
    { owner: 'interrupt-never-started.js', category: 'postgres', stdout: 'never\n', stderr: '' }
  ];
  for (const spec of specs) spec.sourcePath = writeOwner(ownersDirectory, spec.owner, spec);
  const execution = runControlled(directory, 'interruption', specs, { interruptOrdinal: 2 });
  equal(execution.child.status, 86, 'bounded interruption exits at the controlled seam');
  const started = readJson(path.join(execution.runRoot, 'checkpoint-started.json'));
  equal(started.repositoryCommit, head, 'interrupted checkpoint binds the exact repository HEAD');
  assertStreamEvidence(execution.runRoot, 1, specs[0], 'PASS');
  const secondDirectory = ownerDirectory(execution.runRoot, 2, specs[1].owner);
  const secondStarted = readJson(path.join(secondDirectory, 'owner-started.json'));
  equal(secondStarted.state, 'STARTED', 'interrupted owner is durably STARTED');
  check(!fs.existsSync(path.join(secondDirectory, 'owner-result.json')),
    'interrupted owner has no fabricated terminal result');
  check(!fs.existsSync(ownerDirectory(execution.runRoot, 3, specs[2].owner)),
    'owner after interruption was never started');
  check(!fs.existsSync(path.join(execution.runRoot, TERMINAL_FILE)),
    'interruption fabricates no terminal PASSED or FAILED verdict');
  check(!fs.existsSync(path.join(execution.runRoot, FIRST_FAILURE_FILE)),
    'orchestrator interruption is not misreported as an owner failure');
}

function persistentDefaultLocationScenario(directory, ownersDirectory, head) {
  const relativeParent = path.relative(ROOT, DEFAULT_RESULT_PARENT);
  check(!DEFAULT_RESULT_PARENT.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    'default checkpoint result parent is outside the temporary directory');
  equal(relativeParent, path.join('.local-artifacts', 'release-checkpoint-results'),
    'default checkpoint result parent uses the repository local-artifact convention');

  const ignored = spawnSync('git', ['check-ignore', '--quiet', DEFAULT_RESULT_PARENT], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  equal(ignored.status, 0, 'default checkpoint result parent is excluded from Git');

  const spec = {
    owner: 'persistent-default-syntax.js',
    category: 'syntax',
    stdout: 'persistent stdout line 1\npersistent stdout line 2\n',
    stderr: 'persistent stderr line\n'
  };
  spec.sourcePath = writeOwner(ownersDirectory, spec.owner, spec);
  const runIdentity = `persistent-default-${crypto.randomBytes(8).toString('hex')}`;
  const harnessPath = path.join(directory, 'persistent-default-harness.js');
  fs.writeFileSync(harnessPath, [
    "'use strict';",
    `const { executeCheckpoint } = require(${JSON.stringify(RECORDER)});`,
    `const root = ${JSON.stringify(ROOT)};`,
    `const sourcePath = ${JSON.stringify(spec.sourcePath)};`,
    'executeCheckpoint({',
    '  root,',
    '  checks: [{',
    `    owner: ${JSON.stringify(spec.owner)},`,
    `    category: ${JSON.stringify(spec.category)},`,
    '    sourcePath,',
    '    command: process.execPath,',
    '    args: [sourcePath],',
    '    cwd: root',
    '  }],',
    `  runIdentity: ${JSON.stringify(runIdentity)},`,
    '  mirrorOutput: false',
    '}).then(result => { process.exitCode = result.exitCode; }).catch(error => {',
    '  process.stderr.write(`${error.stack || error.message}\\n`);',
    '  process.exitCode = 99;',
    '});',
    ''
  ].join('\n'));

  const producer = spawnSync(process.execPath, [harnessPath], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  equal(producer.status, 0, 'default-location producer exits successfully');
  const matches = fs.readdirSync(DEFAULT_RESULT_PARENT)
    .filter(entry => entry.endsWith(`-${runIdentity}`));
  equal(matches.length, 1, 'default location contains exactly one produced result root');
  const runRoot = path.join(DEFAULT_RESULT_PARENT, matches[0]);

  try {
    const freshReaderPath = path.join(directory, 'persistent-default-reader.js');
    fs.writeFileSync(freshReaderPath, [
      "'use strict';",
      "const crypto = require('node:crypto');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const runRoot = ${JSON.stringify(runRoot)};`,
      `const ownerRoot = path.join(runRoot, 'owners', ${JSON.stringify(`001-${spec.owner}`)});`,
      "const stdout = fs.readFileSync(path.join(ownerRoot, 'stdout.log'));",
      "const stderr = fs.readFileSync(path.join(ownerRoot, 'stderr.log'));",
      "const result = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'owner-result.json'), 'utf8'));",
      "const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');",
      'process.stdout.write(JSON.stringify({',
      '  stdout: stdout.toString(\'utf8\'),',
      '  stderr: stderr.toString(\'utf8\'),',
      '  stdoutHash: hash(stdout),',
      '  stderrHash: hash(stderr),',
      '  recordedStdoutHash: result.stdoutRawSha256,',
      '  recordedStderrHash: result.stderrRawSha256,',
      '  repositoryCommit: JSON.parse(fs.readFileSync(path.join(runRoot, \'checkpoint-started.json\'), \'utf8\')).repositoryCommit',
      '}));',
      ''
    ].join('\n'));
    const freshReader = spawnSync(process.execPath, [freshReaderPath], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    equal(freshReader.status, 0,
      'fresh process reads checkpoint evidence after the producer exits');
    const observed = JSON.parse(freshReader.stdout);
    equal(observed.stdout, spec.stdout, 'fresh process reads complete persistent stdout');
    equal(observed.stderr, spec.stderr, 'fresh process reads complete persistent stderr');
    equal(observed.stdoutHash, observed.recordedStdoutHash,
      'fresh process reproduces the persistent stdout hash');
    equal(observed.stderrHash, observed.recordedStderrHash,
      'fresh process reproduces the persistent stderr hash');
    equal(observed.repositoryCommit, head,
      'persistent default result remains bound to the producing repository HEAD');

    const gitStatus = spawnSync(
      'git',
      ['status', '--porcelain=v2', '--untracked-files=all', '--', runRoot],
      { cwd: ROOT, encoding: 'utf8' }
    );
    equal(gitStatus.status, 0, 'Git can inspect the generated persistent result path');
    equal(gitStatus.stdout, '', 'Git does not see generated persistent result artifacts');
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-checkpoint-results-test-'));
  const ownersDirectory = path.join(directory, 'owners');
  fs.mkdirSync(ownersDirectory);
  try {
    const head = currentHead();
    failureScenario(directory, ownersDirectory, head);
    successScenario(directory, ownersDirectory, head);
    interruptionScenario(directory, ownersDirectory, head);
    persistentDefaultLocationScenario(directory, ownersDirectory, head);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`release-checkpoint-results-test: PASS (${assertions} assertions)`);
}

main();
