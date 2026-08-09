'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DURABILITY_UNCONFIRMED_TEXT,
  SUCCESS_TEXT,
  rotateSessionSecret,
  runCli
} = require('./rotate-session-secret');

function check(condition, message) {
  assert.strictEqual(Boolean(condition), true, message);
}

function makeDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-session-rotate-'));
}

function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function deterministicRandom() {
  let generation = 0;
  return size => {
    generation += 1;
    return Buffer.alloc(size, generation);
  };
}

function trackedRandom() {
  let calls = 0;
  let value = '';
  return {
    randomBytes(size) {
      calls += 1;
      const bytes = Buffer.alloc(size, calls);
      value = bytes.toString('hex');
      return bytes;
    },
    calls: () => calls,
    value: () => value
  };
}

function injectedFileSystemError(code = 'EIO') {
  const error = new Error('injected filesystem failure');
  error.code = code;
  return error;
}

function tempPathFactory() {
  let index = 0;
  return envPath => {
    index += 1;
    return path.join(path.dirname(envPath), `.env.local.rotation-test-${index}.tmp`);
  };
}

function activeAssignments(contents) {
  return contents
    .split(/\r\n|\n|\r/)
    .filter(line => /^[ \t]*SESSION_SECRET[ \t]*=/.test(line));
}

function assignmentValue(contents) {
  const assignments = activeAssignments(contents);
  check(assignments.length === 1, 'expected exactly one active assignment');
  return assignments[0].replace(/^[ \t]*SESSION_SECRET[ \t]*=[ \t]*/, '');
}

function rotate(envPath, overrides = {}) {
  return rotateSessionSecret({
    envPath,
    randomBytes: deterministicRandom(),
    tempPathFactory: tempPathFactory(),
    ...overrides
  });
}

function captureCli(rotateOwner) {
  let stdout = '';
  let stderr = '';
  const exitCode = runCli({
    argv: [],
    stdout: { write: value => { stdout += value; } },
    stderr: { write: value => { stderr += value; } },
    rotate: rotateOwner
  });
  return { exitCode, stdout, stderr };
}

function testExistingAssignmentChangesAlone() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    const original = [
      '# local configuration',
      'DATABASE_URL=postgres://ticket_test@127.0.0.1:55432/ticket_system',
      '',
      'SESSION_SECRET=previous-value',
      'OPENAI_PROVIDER=openai',
      'OPENAI_MODEL=configured-model',
      ''
    ].join('\n');
    fs.writeFileSync(envPath, original, { mode: 0o644 });
    rotate(envPath);
    const updated = fs.readFileSync(envPath, 'utf8');
    const redacted = updated.replace(
      /^([ \t]*SESSION_SECRET[ \t]*=).*$/m,
      '$1<redacted>'
    );
    const expectedRedacted = original.replace(
      /^([ \t]*SESSION_SECRET[ \t]*=).*$/m,
      '$1<redacted>'
    );
    check(redacted === expectedRedacted, 'unrelated configuration changed');
    check(!updated.includes('SESSION_SECRET=previous-value'), 'old assignment remained active');
    check((fs.statSync(envPath).mode & 0o777) === 0o600, 'result mode was not 0600');
  } finally {
    removeDirectory(directory);
  }
}

function testAppendAndCommentPreservation() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    const original = '# SESSION_SECRET=commented-value\r\nDATABASE_URL=postgres://local/example\r\n\r\n';
    fs.writeFileSync(envPath, original, { mode: 0o600 });
    rotate(envPath);
    const updated = fs.readFileSync(envPath, 'utf8');
    check(updated.startsWith(original), 'comments or existing line bytes changed');
    check(activeAssignments(updated).length === 1, 'active assignment was not appended exactly once');
    check(updated.includes('# SESSION_SECRET=commented-value\r\n'), 'commented assignment changed');
    check(updated.endsWith('\r\n'), 'existing newline convention was not retained');
  } finally {
    removeDirectory(directory);
  }
}

function testMissingFileCreation() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    rotate(envPath);
    const updated = fs.readFileSync(envPath, 'utf8');
    check(activeAssignments(updated).length === 1, 'missing file did not receive one assignment');
    check((fs.statSync(envPath).mode & 0o777) === 0o600, 'created file mode was not 0600');
  } finally {
    removeDirectory(directory);
  }
}

function testDuplicateRefusalIsNonMutating() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    const original = 'SESSION_SECRET=first-value\nDATABASE_URL=postgres://local/example\nSESSION_SECRET=second-value\n';
    fs.writeFileSync(envPath, original, { mode: 0o600 });
    let refused = false;
    try {
      rotate(envPath);
    } catch (error) {
      refused = error && error.code === 'SESSION_SECRET_DUPLICATE_ASSIGNMENTS';
    }
    check(refused, 'duplicate assignments were not refused');
    check(fs.readFileSync(envPath, 'utf8') === original, 'duplicate refusal changed source bytes');
    check(fs.readdirSync(directory).length === 1, 'duplicate refusal produced an extra file');
  } finally {
    removeDirectory(directory);
  }
}

function testPreRenameFailuresPreserveAndClean() {
  for (const stage of ['create', 'write', 'temp-fsync', 'rename']) {
    const directory = makeDirectory();
    try {
      const envPath = path.join(directory, '.env.local');
      const tempPath = path.join(directory, `.env.local.${stage}.tmp`);
      const original = 'DATABASE_URL=postgres://local/example\nSESSION_SECRET=previous-value\n';
      fs.writeFileSync(envPath, original, { mode: 0o600 });

      const fileSystem = Object.create(fs);
      if (stage === 'create') {
        fileSystem.openSync = (target, ...args) => {
          if (target === tempPath) throw injectedFileSystemError('EACCES');
          return fs.openSync(target, ...args);
        };
      } else if (stage === 'write') {
        fileSystem.writeFileSync = () => { throw injectedFileSystemError(); };
      } else if (stage === 'temp-fsync') {
        fileSystem.fsyncSync = () => { throw injectedFileSystemError(); };
      } else {
        fileSystem.renameSync = () => { throw injectedFileSystemError(); };
      }

      const random = trackedRandom();
      let classifiedError;
      const result = captureCli(() => {
        try {
          rotateSessionSecret({
            envPath,
            fileSystem,
            randomBytes: random.randomBytes,
            tempPathFactory: () => tempPath
          });
        } catch (error) {
          classifiedError = error;
          throw error;
        }
      });
      const output = `${result.stdout}${result.stderr}`;
      check(result.exitCode === 1, `${stage} failure returned zero`);
      check(
        classifiedError && classifiedError.code === 'SESSION_SECRET_ATOMIC_UPDATE_FAILED',
        `${stage} failure received the wrong classification`
      );
      check(result.stderr.includes('rotation failed'), `${stage} failure did not report rotation failure`);
      check(!result.stderr.includes('was replaced'), `${stage} failure claimed replacement occurred`);
      check(!output.includes('previous-value'), `${stage} failure output exposed the old value`);
      check(!output.includes(random.value()), `${stage} failure output exposed the new value`);
      check(fs.readFileSync(envPath, 'utf8') === original, `${stage} failure changed source bytes`);
      check(fs.readdirSync(directory).length === 1, `${stage} failure left a temporary file`);
    } finally {
      removeDirectory(directory);
    }
  }
}

function testPostRenameDurabilityFailureIsDistinct() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    const tempPath = path.join(directory, '.env.local.post-rename.tmp');
    const original = [
      '# local configuration',
      'DATABASE_URL=postgres://local/example',
      'SESSION_SECRET=previous-value',
      'OPENAI_MODEL=configured-model',
      ''
    ].join('\n');
    fs.writeFileSync(envPath, original, { mode: 0o644 });

    const fileSystem = Object.create(fs);
    let fsyncCalls = 0;
    let renameCalls = 0;
    fileSystem.fsyncSync = descriptor => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) throw injectedFileSystemError();
      return fs.fsyncSync(descriptor);
    };
    fileSystem.renameSync = (source, destination) => {
      renameCalls += 1;
      return fs.renameSync(source, destination);
    };

    const random = trackedRandom();
    let classifiedError;
    const result = captureCli(() => {
      try {
        rotateSessionSecret({
          envPath,
          fileSystem,
          randomBytes: random.randomBytes,
          tempPathFactory: () => tempPath
        });
      } catch (error) {
        classifiedError = error;
        throw error;
      }
    });
    const updated = fs.readFileSync(envPath, 'utf8');
    const newValue = assignmentValue(updated);
    const output = `${result.stdout}${result.stderr}`;
    const redacted = updated.replace(/^([ \t]*SESSION_SECRET[ \t]*=).*$/m, '$1<redacted>');
    const expectedRedacted = original.replace(/^([ \t]*SESSION_SECRET[ \t]*=).*$/m, '$1<redacted>');

    check(result.exitCode === 1, 'durability-unconfirmed result returned zero');
    check(result.stdout === '', 'durability-unconfirmed result wrote success output');
    check(result.stderr === DURABILITY_UNCONFIRMED_TEXT, 'durability-unconfirmed CLI wording drifted');
    check(
      classifiedError && classifiedError.code === 'SESSION_SECRET_ROTATED_DURABILITY_UNCONFIRMED',
      'post-rename failure received the wrong classification'
    );
    check(!result.stderr.includes('rotation failed'), 'post-rename result claimed rotation simply failed');
    check(result.stderr.includes('was replaced'), 'post-rename result omitted visible replacement');
    check(result.stderr.includes('Do not automatically retry'), 'post-rename result omitted retry warning');
    check(activeAssignments(updated).length === 1, 'post-rename result did not retain one assignment');
    check(newValue !== 'previous-value', 'post-rename result retained the old assignment');
    check(redacted === expectedRedacted, 'post-rename result changed unrelated bytes');
    check((fs.statSync(envPath).mode & 0o777) === 0o600, 'post-rename result mode was not 0600');
    check(renameCalls === 1 && random.calls() === 1, 'post-rename failure retried rotation');
    check(fsyncCalls === 2, 'post-rename failure did not occur at directory fsync');
    check(!output.includes('previous-value'), 'post-rename output exposed the old value');
    check(!output.includes(newValue), 'post-rename output exposed the new value');
    check(fs.readdirSync(directory).length === 1, 'post-rename result left a temporary file');
  } finally {
    removeDirectory(directory);
  }
}

function testUnsupportedDirectoryFsyncIsPortableSuccess() {
  for (const code of ['EINVAL', 'ENOTSUP', 'EBADF']) {
    const directory = makeDirectory();
    try {
      const envPath = path.join(directory, '.env.local');
      const tempPath = path.join(directory, `.env.local.${code}.tmp`);
      fs.writeFileSync(envPath, 'SESSION_SECRET=previous-value\n', { mode: 0o600 });
      const fileSystem = Object.create(fs);
      let fsyncCalls = 0;
      fileSystem.fsyncSync = descriptor => {
        fsyncCalls += 1;
        if (fsyncCalls === 2) throw injectedFileSystemError(code);
        return fs.fsyncSync(descriptor);
      };
      const random = trackedRandom();
      const result = captureCli(() => rotateSessionSecret({
        envPath,
        fileSystem,
        randomBytes: random.randomBytes,
        tempPathFactory: () => tempPath
      }));
      const updated = fs.readFileSync(envPath, 'utf8');
      const newValue = assignmentValue(updated);
      const output = `${result.stdout}${result.stderr}`;
      check(result.exitCode === 0, `${code} directory fsync condition did not remain portable success`);
      check(result.stdout === SUCCESS_TEXT && result.stderr === '', `${code} success output drifted`);
      check(fsyncCalls === 2, `${code} was not injected at directory fsync`);
      check(activeAssignments(updated).length === 1, `${code} result assignment count changed`);
      check((fs.statSync(envPath).mode & 0o777) === 0o600, `${code} result mode was not 0600`);
      check(!output.includes('previous-value'), `${code} output exposed the old value`);
      check(!output.includes(newValue), `${code} output exposed the new value`);
    } finally {
      removeDirectory(directory);
    }
  }
}

function testTempNameCollisionPreservesExistingFile() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    const collisionPath = path.join(directory, '.env.local.preexisting.tmp');
    const original = 'SESSION_SECRET=previous-value\n';
    const collisionContents = 'preexisting temporary-path contents\n';
    fs.writeFileSync(envPath, original, { mode: 0o600 });
    fs.writeFileSync(collisionPath, collisionContents, { mode: 0o600 });
    let refused = false;
    try {
      rotateSessionSecret({
        envPath,
        randomBytes: deterministicRandom(),
        tempPathFactory: () => collisionPath
      });
    } catch (error) {
      refused = error && error.code === 'SESSION_SECRET_ATOMIC_UPDATE_FAILED';
    }
    check(refused, 'temporary-path collision was not refused');
    check(fs.readFileSync(envPath, 'utf8') === original, 'collision changed source bytes');
    check(
      fs.readFileSync(collisionPath, 'utf8') === collisionContents,
      'collision removed or changed a preexisting file'
    );
  } finally {
    removeDirectory(directory);
  }
}

function testOutputRedactionAndNoBackup() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    fs.writeFileSync(envPath, 'SESSION_SECRET=previous-value\n', { mode: 0o600 });
    const success = captureCli(() => rotate(envPath));
    const updated = fs.readFileSync(envPath, 'utf8');
    const currentValue = assignmentValue(updated);
    const successOutput = `${success.stdout}${success.stderr}`;
    check(success.exitCode === 0, 'successful CLI invocation returned nonzero');
    check(success.stdout === SUCCESS_TEXT && success.stderr === '', 'successful CLI output was not the safe contract');
    check(!successOutput.includes('previous-value'), 'successful output exposed the old value');
    check(!successOutput.includes(currentValue), 'successful output exposed the new value');
    check(fs.readdirSync(directory).length === 1, 'successful rotation produced a backup or temporary file');

    const failure = captureCli(() => {
      const error = new Error('unsafe internal detail');
      error.exposedMaterial = currentValue;
      throw error;
    });
    const failureOutput = `${failure.stdout}${failure.stderr}`;
    check(failure.exitCode === 1, 'failed CLI invocation returned zero');
    check(!failureOutput.includes('previous-value'), 'failure output exposed the old value');
    check(!failureOutput.includes(currentValue), 'failure output exposed the new value');
    check(!failureOutput.includes('unsafe internal detail'), 'failure output exposed an unclassified internal error');
  } finally {
    removeDirectory(directory);
  }
}

function testRepeatedRotation() {
  const directory = makeDirectory();
  try {
    const envPath = path.join(directory, '.env.local');
    fs.writeFileSync(envPath, 'DATABASE_URL=postgres://local/example\n', { mode: 0o600 });
    const randomBytes = deterministicRandom();
    const options = {
      envPath,
      randomBytes,
      tempPathFactory: tempPathFactory()
    };
    rotateSessionSecret(options);
    const firstContents = fs.readFileSync(envPath, 'utf8');
    const firstValue = assignmentValue(firstContents);
    rotateSessionSecret(options);
    const secondContents = fs.readFileSync(envPath, 'utf8');
    const secondValue = assignmentValue(secondContents);
    check(firstValue !== secondValue, 'repeated rotation did not change the assignment');
    check(activeAssignments(secondContents).length === 1, 'repeated rotation accumulated assignments');
    check(secondContents.startsWith('DATABASE_URL=postgres://local/example\n'), 'repeated rotation changed unrelated content');
  } finally {
    removeDirectory(directory);
  }
}

function testHelpAndArgumentRefusal() {
  let help = '';
  let invoked = false;
  const helpCode = runCli({
    argv: ['--help'],
    stdout: { write: value => { help += value; } },
    stderr: { write: () => {} },
    rotate: () => { invoked = true; }
  });
  check(helpCode === 0 && !invoked, 'help invoked rotation');
  check(help.includes('Restart') && help.includes('log in again'), 'help omitted operational consequences');

  let refusal = '';
  const refusalCode = runCli({
    argv: ['not-a-secret'],
    stdout: { write: () => {} },
    stderr: { write: value => { refusal += value; } },
    rotate: () => { invoked = true; }
  });
  check(refusalCode === 1, 'unexpected arguments were not refused');
  check(refusal.includes('accepts no arguments'), 'argument refusal was unclear');
}

function main() {
  testExistingAssignmentChangesAlone();
  testAppendAndCommentPreservation();
  testMissingFileCreation();
  testDuplicateRefusalIsNonMutating();
  testPreRenameFailuresPreserveAndClean();
  testPostRenameDurabilityFailureIsDistinct();
  testUnsupportedDirectoryFsyncIsPortableSuccess();
  testTempNameCollisionPreservesExistingFile();
  testOutputRedactionAndNoBackup();
  testRepeatedRotation();
  testHelpAndArgumentRefusal();
  process.stdout.write('SESSION_SECRET rotation tests passed.\n');
}

main();
