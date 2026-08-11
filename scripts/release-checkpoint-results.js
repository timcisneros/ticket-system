'use strict';

// Durable, checkpoint-owned validation evidence.
//
// Raw owner streams are created before spawn and retained without truncation.
// They become authoritative only when the corresponding result record is
// atomically published. A started record without a result record therefore
// means exactly what it says: the owner started, but checkpoint orchestration
// did not durably establish its terminal disposition.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CHECKPOINT_RESULT_VERSION = 1;
const CHECKPOINT_REGISTRY_VERSION = 1;
const DEFAULT_RESULT_PARENT = path.resolve(
  __dirname,
  '..',
  '.local-artifacts',
  'release-checkpoint-results'
);
const TERMINAL_FILE = 'checkpoint-terminal.json';
const FIRST_FAILURE_FILE = 'first-failure.json';
const STARTED_FILE = 'checkpoint-started.json';
const REGISTRY_FILE = 'checkpoint-registry.json';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashCanonical(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function fsyncDirectory(directory, fileSystem = fs) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync(descriptor);
  } catch (error) {
    if (!error || !['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_) { /* best effort */ }
    }
  }
}

function atomicWriteOnce(file, bytes, { fileSystem = fs, mode = 0o600 } = {}) {
  if (fileSystem.existsSync(file)) {
    const error = new Error(`checkpoint result already exists: ${path.basename(file)}`);
    error.code = 'CHECKPOINT_RESULT_ALREADY_EXISTS';
    throw error;
  }
  const parent = path.dirname(file);
  const temporary = path.join(parent,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(10).toString('hex')}.tmp`);
  let descriptor;
  let created = false;
  let published = false;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', mode);
    created = true;
    fileSystem.writeFileSync(descriptor, bytes);
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.chmodSync(temporary, mode);
    fileSystem.renameSync(temporary, file);
    published = true;
    fsyncDirectory(parent, fileSystem);
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_) { /* best effort */ }
    }
    if (created && !published) {
      try { fileSystem.unlinkSync(temporary); } catch (_) { /* best effort */ }
    }
  }
}

function writeJsonOnce(file, value, options) {
  atomicWriteOnce(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), options);
}

function gitValue(root, args, { optional = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    if (optional) return null;
    const error = new Error(`unable to resolve Git identity (${args.join(' ')})`);
    error.code = 'CHECKPOINT_GIT_IDENTITY_UNAVAILABLE';
    throw error;
  }
  const value = result.stdout.trim();
  return value || null;
}

function repositoryIdentity(root) {
  const repositoryCommit = gitValue(root, ['rev-parse', 'HEAD']);
  const branchValue = gitValue(root, ['branch', '--show-current'], { optional: true });
  return Object.freeze({
    repositoryCommit,
    branch: branchValue || null
  });
}

function ownerIdentity(check) {
  if (!check || typeof check.owner !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(check.owner)) {
    throw new TypeError('checkpoint owner must be a safe filename identity');
  }
  if (!['syntax', 'deterministic', 'postgres'].includes(check.category)) {
    throw new TypeError(`checkpoint owner ${check.owner} has an invalid category`);
  }
  if (typeof check.sourcePath !== 'string' || !fs.existsSync(check.sourcePath)) {
    throw new TypeError(`checkpoint owner ${check.owner} has no source identity`);
  }
  return Object.freeze({
    owner: check.owner,
    sourceRawSha256: sha256(fs.readFileSync(check.sourcePath))
  });
}

function buildRegistryIdentity(checks) {
  const ordered = checks.map((check, index) => Object.freeze({
    ordinal: index + 1,
    category: check.category,
    ...ownerIdentity(check)
  }));
  const byCategory = category => ordered
    .filter(owner => owner.category === category)
    .map(({ ordinal, owner, sourceRawSha256 }) => ({ ordinal, owner, sourceRawSha256 }));
  const syntaxOwners = byCategory('syntax');
  if (syntaxOwners.length !== 1) {
    throw new TypeError('checkpoint registry must contain exactly one syntax owner');
  }
  const deterministicOwners = byCategory('deterministic');
  const postgresOwners = byCategory('postgres');
  const identity = {
    checkpointRegistryVersion: CHECKPOINT_REGISTRY_VERSION,
    syntaxOwner: syntaxOwners[0],
    syntaxOwnerHash: hashCanonical(syntaxOwners[0]),
    deterministicOwners,
    deterministicOwnerListHash: hashCanonical(deterministicOwners),
    postgresOwners,
    postgresOwnerListHash: hashCanonical(postgresOwners),
    orderedOwnerListHash: hashCanonical(ordered),
    totalCount: ordered.length
  };
  identity.registryHash = hashCanonical(identity);
  return Object.freeze(identity);
}

function isProviderOrLiveVariable(key) {
  return /^(OPENAI_|ALLOW_LIVE_OPENAI_TESTS$|EVALUATION_LIVE|STRUCTURED_ALLOCATION_LIVE|LIVE_)/i
    .test(key) || /PROVIDER.*CALL|CALL.*PROVIDER|LIVE.*AUTH|AUTH.*LIVE/i.test(key);
}

function scrubProviderAndLiveEnvironment(input) {
  const environment = { ...input };
  for (const key of Object.keys(environment)) {
    if (isProviderOrLiveVariable(key)) delete environment[key];
  }
  return environment;
}

function postgresTargetIdentity(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return Object.freeze({
      protocol: parsed.protocol,
      hostname: parsed.hostname || null,
      port: parsed.port || null,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || null
    });
  } catch (_) {
    return Object.freeze({ invalid: true });
  }
}

function environmentClassification(environment) {
  return Object.freeze({
    providerLiveVariablesScrubbed:
      Object.keys(environment).every(key => !isProviderOrLiveVariable(key)),
    postgresTarget: postgresTargetIdentity(environment.TEST_DATABASE_URL),
    supportedHost: Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      hostClass: process.platform === 'linux'
        ? 'linux-native-process-materializer'
        : `${process.platform}-repository-supported`
    })
  });
}

function ownerDirectoryName(ordinal, owner) {
  return `${String(ordinal).padStart(3, '0')}-${owner}`;
}

function createRunRoot({ resultParent, runIdentity, startedAt }) {
  fs.mkdirSync(resultParent, { recursive: true, mode: 0o700 });
  fs.chmodSync(resultParent, 0o700);
  const timestamp = startedAt.replace(/[-:.]/g, '').replace('Z', 'Z');
  const runRoot = path.join(resultParent, `${timestamp}-${runIdentity}`);
  fs.mkdirSync(runRoot, { mode: 0o700 });
  fs.mkdirSync(path.join(runRoot, 'owners'), { mode: 0o700 });
  fsyncDirectory(resultParent);
  return runRoot;
}

function mirror(stream, chunk, enabled) {
  if (enabled && stream && typeof stream.write === 'function') stream.write(chunk);
}

async function executeOwner({
  check, ordinal, runRoot, runIdentity, repositoryCommit, registryHash,
  environment, mirrorOutput, onOwnerStarted
}) {
  const ownerRoot = path.join(runRoot, 'owners', ownerDirectoryName(ordinal, check.owner));
  fs.mkdirSync(ownerRoot, { mode: 0o700 });
  fsyncDirectory(path.dirname(ownerRoot));
  const stdoutRelative = path.posix.join('owners', path.basename(ownerRoot), 'stdout.log');
  const stderrRelative = path.posix.join('owners', path.basename(ownerRoot), 'stderr.log');
  const startedAt = new Date().toISOString();
  const startedRecord = {
    checkpointResultVersion: CHECKPOINT_RESULT_VERSION,
    state: 'STARTED',
    checkpointRunIdentity: runIdentity,
    repositoryCommit,
    registryHash,
    ordinal,
    owner: check.owner,
    category: check.category,
    startedAt,
    stdoutArtifactPath: stdoutRelative,
    stderrArtifactPath: stderrRelative
  };
  writeJsonOnce(path.join(ownerRoot, 'owner-started.json'), startedRecord);
  if (typeof onOwnerStarted === 'function') {
    onOwnerStarted(Object.freeze({ ...startedRecord, runRoot, ownerRoot }));
  }

  const stdoutPath = path.join(runRoot, stdoutRelative);
  const stderrPath = path.join(runRoot, stderrRelative);
  const stdoutFd = fs.openSync(stdoutPath, 'wx', 0o600);
  const stderrFd = fs.openSync(stderrPath, 'wx', 0o600);
  let stdoutClosed = false;
  let stderrClosed = false;
  let spawnErrorCode = null;
  let outcome;
  try {
    const child = spawn(check.command, check.args, {
      cwd: check.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => {
      fs.writeSync(stdoutFd, chunk);
      mirror(process.stdout, chunk, mirrorOutput);
    });
    child.stderr.on('data', chunk => {
      fs.writeSync(stderrFd, chunk);
      mirror(process.stderr, chunk, mirrorOutput);
    });
    outcome = await new Promise(resolve => {
      child.once('error', error => {
        spawnErrorCode = error && error.code ? error.code : 'SPAWN_FAILED';
      });
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } finally {
    fs.fsyncSync(stdoutFd);
    fs.closeSync(stdoutFd);
    stdoutClosed = true;
    fs.fsyncSync(stderrFd);
    fs.closeSync(stderrFd);
    stderrClosed = true;
    fs.chmodSync(stdoutPath, 0o600);
    fs.chmodSync(stderrPath, 0o600);
    fsyncDirectory(ownerRoot);
  }
  if (!stdoutClosed || !stderrClosed) throw new Error('checkpoint owner streams did not close');

  const completedAt = new Date().toISOString();
  const stdoutRawSha256 = sha256(fs.readFileSync(stdoutPath));
  const stderrRawSha256 = sha256(fs.readFileSync(stderrPath));
  const result = spawnErrorCode
    ? 'SPAWN_FAILED'
    : outcome.signal
      ? 'SIGNALLED'
      : outcome.exitCode === 0 ? 'PASS' : 'FAIL';
  const record = {
    checkpointResultVersion: CHECKPOINT_RESULT_VERSION,
    checkpointRunIdentity: runIdentity,
    repositoryCommit,
    registryHash,
    ordinal,
    owner: check.owner,
    category: check.category,
    startedAt,
    completedAt,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    spawnErrorCode,
    stdoutArtifactPath: stdoutRelative,
    stderrArtifactPath: stderrRelative,
    stdoutRawSha256,
    stderrRawSha256,
    result
  };
  writeJsonOnce(path.join(ownerRoot, 'owner-result.json'), record);
  return Object.freeze(record);
}

async function executeCheckpoint({
  root,
  checks,
  environment = process.env,
  resultParent = process.env.RELEASE_CHECKPOINT_RESULTS_ROOT || DEFAULT_RESULT_PARENT,
  runIdentity = crypto.randomUUID(),
  mirrorOutput = true,
  onOwnerStarted = null
}) {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new TypeError('checkpoint requires at least one owner');
  }
  const repo = repositoryIdentity(root);
  const registry = buildRegistryIdentity(checks);
  const childEnvironment = scrubProviderAndLiveEnvironment({
    ...environment,
    NODE_ENV: environment.NODE_ENV || 'test'
  });
  const startedAt = new Date().toISOString();
  const runRoot = createRunRoot({ resultParent, runIdentity, startedAt });
  const checkpointSourcePath = path.join(root, 'scripts', 'release-checkpoint.js');
  writeJsonOnce(path.join(runRoot, REGISTRY_FILE), registry);
  writeJsonOnce(path.join(runRoot, STARTED_FILE), {
    checkpointResultVersion: CHECKPOINT_RESULT_VERSION,
    state: 'RUNNING',
    checkpointRunIdentity: runIdentity,
    repositoryCommit: repo.repositoryCommit,
    branch: repo.branch,
    branchAuthority: false,
    registryHash: registry.registryHash,
    registryArtifactPath: REGISTRY_FILE,
    resultRoot: runRoot,
    startedAt,
    environmentClassification: environmentClassification(childEnvironment),
    orchestrator: {
      owner: 'release-checkpoint.js',
      sourceRawSha256: sha256(fs.readFileSync(checkpointSourcePath))
    }
  });
  process.stdout.write(`RELEASE CHECKPOINT RESULT ROOT: ${runRoot}\n`);

  let passed = 0;
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const ordinal = index + 1;
    if (mirrorOutput) process.stdout.write(`\n$ node scripts/${check.owner}\n`);
    const owner = await executeOwner({
      check,
      ordinal,
      runRoot,
      runIdentity,
      repositoryCommit: repo.repositoryCommit,
      registryHash: registry.registryHash,
      environment: childEnvironment,
      mirrorOutput,
      onOwnerStarted
    });
    if (owner.result === 'PASS') {
      passed += 1;
      continue;
    }

    const firstFailure = {
      checkpointResultVersion: CHECKPOINT_RESULT_VERSION,
      checkpointRunIdentity: runIdentity,
      repositoryCommit: repo.repositoryCommit,
      registryHash: registry.registryHash,
      ordinal: owner.ordinal,
      owner: owner.owner,
      category: owner.category,
      startedAt: owner.startedAt,
      completedAt: owner.completedAt,
      exitCode: owner.exitCode,
      signal: owner.signal,
      spawnErrorCode: owner.spawnErrorCode,
      stdoutArtifactPath: owner.stdoutArtifactPath,
      stderrArtifactPath: owner.stderrArtifactPath,
      stdoutRawSha256: owner.stdoutRawSha256,
      stderrRawSha256: owner.stderrRawSha256,
      result: owner.result
    };
    writeJsonOnce(path.join(runRoot, FIRST_FAILURE_FILE), firstFailure);
    const completedAt = new Date().toISOString();
    const terminal = {
      checkpointResultVersion: CHECKPOINT_RESULT_VERSION,
      state: 'FAILED',
      checkpointRunIdentity: runIdentity,
      repositoryCommit: repo.repositoryCommit,
      registryHash: registry.registryHash,
      startedAt,
      completedAt,
      passedCount: passed,
      totalCount: checks.length,
      perOwnerResultCount: passed + 1,
      firstFailedOrdinal: owner.ordinal,
      firstFailedOwner: owner.owner,
      firstFailureArtifactPath: FIRST_FAILURE_FILE,
      failureResult: owner.result,
      exitCode: owner.exitCode,
      signal: owner.signal,
      spawnErrorCode: owner.spawnErrorCode
    };
    writeJsonOnce(path.join(runRoot, TERMINAL_FILE), terminal);
    return Object.freeze({
      runRoot,
      registry,
      terminal,
      exitCode: owner.result === 'FAIL' && Number.isInteger(owner.exitCode) && owner.exitCode !== 0
        ? owner.exitCode : 1
    });
  }

  const completedAt = new Date().toISOString();
  const terminal = {
    checkpointResultVersion: CHECKPOINT_RESULT_VERSION,
    state: 'PASSED',
    checkpointRunIdentity: runIdentity,
    repositoryCommit: repo.repositoryCommit,
    registryHash: registry.registryHash,
    startedAt,
    completedAt,
    passedCount: passed,
    totalCount: checks.length,
    perOwnerResultCount: passed,
    firstFailedOrdinal: null,
    firstFailedOwner: null,
    firstFailureArtifactPath: null,
    failureResult: null,
    exitCode: 0,
    signal: null,
    spawnErrorCode: null
  };
  writeJsonOnce(path.join(runRoot, TERMINAL_FILE), terminal);
  return Object.freeze({ runRoot, registry, terminal, exitCode: 0 });
}

module.exports = {
  CHECKPOINT_RESULT_VERSION,
  CHECKPOINT_REGISTRY_VERSION,
  DEFAULT_RESULT_PARENT,
  TERMINAL_FILE,
  FIRST_FAILURE_FILE,
  STARTED_FILE,
  REGISTRY_FILE,
  atomicWriteOnce,
  buildRegistryIdentity,
  canonicalJson,
  environmentClassification,
  executeCheckpoint,
  hashCanonical,
  isProviderOrLiveVariable,
  repositoryIdentity,
  scrubProviderAndLiveEnvironment,
  sha256
};
