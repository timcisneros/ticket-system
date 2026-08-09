'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { LOCAL_ENV_PATH } = require('./dev-environment');

const HELP_TEXT = [
  'Usage: pnpm session:rotate',
  '',
  'Generate a new SESSION_SECRET and atomically store it in .env.local.',
  'Rotation invalidates sessions signed with the previous secret.',
  'Restart the application afterward and log in again.',
  ''
].join('\n');

const SUCCESS_TEXT = [
  'SESSION_SECRET rotated successfully.',
  'Restart the application to activate the new secret.',
  ''
].join('\n');

const DURABILITY_UNCONFIRMED_TEXT = [
  'SESSION_SECRET was replaced, but filesystem durability confirmation failed.',
  'Do not automatically retry the rotation.',
  ''
].join('\n');

class SessionSecretRotationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionSecretRotationError';
    this.code = code;
  }
}

function isMissingPathError(error) {
  return Boolean(error && error.code === 'ENOENT');
}

function readRegularFile(filePath, fileSystem) {
  let status;
  try {
    status = fileSystem.lstatSync(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return '';
    throw new SessionSecretRotationError(
      'SESSION_SECRET_PATH_INSPECTION_FAILED',
      'Unable to inspect .env.local safely.'
    );
  }

  if (status.isSymbolicLink() || !status.isFile()) {
    throw new SessionSecretRotationError(
      'SESSION_SECRET_PATH_NOT_REGULAR',
      '.env.local must be a regular file and must not be a symbolic link.'
    );
  }

  try {
    return fileSystem.readFileSync(filePath, 'utf8');
  } catch (_error) {
    throw new SessionSecretRotationError(
      'SESSION_SECRET_READ_FAILED',
      'Unable to read .env.local safely.'
    );
  }
}

function activeSessionSecretLineIndexes(parts) {
  const indexes = [];
  for (let index = 0; index < parts.length; index += 2) {
    if (/^[ \t]*SESSION_SECRET[ \t]*=/.test(parts[index])) indexes.push(index);
  }
  return indexes;
}

function updatedLocalEnv(contents, secret) {
  const parts = contents.split(/(\r\n|\n|\r)/);
  const activeIndexes = activeSessionSecretLineIndexes(parts);

  if (activeIndexes.length > 1) {
    throw new SessionSecretRotationError(
      'SESSION_SECRET_DUPLICATE_ASSIGNMENTS',
      'Refusing to rotate because .env.local contains multiple active SESSION_SECRET assignments.'
    );
  }

  if (activeIndexes.length === 1) {
    const index = activeIndexes[0];
    parts[index] = parts[index].replace(
      /^([ \t]*SESSION_SECRET[ \t]*=[ \t]*).*$/,
      (_line, assignmentPrefix) => `${assignmentPrefix}${secret}`
    );
    return parts.join('');
  }

  const existingNewline = contents.match(/\r\n|\n|\r/);
  const newline = existingNewline ? existingNewline[0] : '\n';
  if (contents.length === 0) return `SESSION_SECRET=${secret}${newline}`;
  if (/(?:\r\n|\n|\r)$/.test(contents)) {
    return `${contents}SESSION_SECRET=${secret}${newline}`;
  }
  return `${contents}${newline}SESSION_SECRET=${secret}${newline}`;
}

function defaultTempPath(envPath) {
  const parent = path.dirname(envPath);
  const basename = path.basename(envPath);
  const token = crypto.randomBytes(12).toString('hex');
  return path.join(parent, `.${basename}.${process.pid}.${token}.tmp`);
}

function fsyncParentDirectory(parentPath, fileSystem) {
  let directoryDescriptor;
  try {
    directoryDescriptor = fileSystem.openSync(parentPath, 'r');
    fileSystem.fsyncSync(directoryDescriptor);
  } catch (error) {
    if (!error || !['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (directoryDescriptor !== undefined) {
      try {
        fileSystem.closeSync(directoryDescriptor);
      } catch (_error) {
        // The directory entry has already been persisted or the operation will fail below.
      }
    }
  }
}

function rotateSessionSecret({
  envPath = LOCAL_ENV_PATH,
  fileSystem = fs,
  randomBytes = crypto.randomBytes,
  tempPathFactory = defaultTempPath
} = {}) {
  const originalContents = readRegularFile(envPath, fileSystem);
  const secret = randomBytes(32).toString('hex');
  const replacementContents = updatedLocalEnv(originalContents, secret);
  const parentPath = path.dirname(envPath);
  const tempPath = tempPathFactory(envPath);

  if (path.dirname(tempPath) !== parentPath || tempPath === envPath) {
    throw new SessionSecretRotationError(
      'SESSION_SECRET_TEMP_PATH_INVALID',
      'Unable to create a safe temporary file for .env.local.'
    );
  }

  let tempDescriptor;
  let tempCreated = false;
  let renamed = false;
  try {
    tempDescriptor = fileSystem.openSync(tempPath, 'wx', 0o600);
    tempCreated = true;
    fileSystem.writeFileSync(tempDescriptor, replacementContents, 'utf8');
    fileSystem.fsyncSync(tempDescriptor);
    fileSystem.closeSync(tempDescriptor);
    tempDescriptor = undefined;
    fileSystem.chmodSync(tempPath, 0o600);
    fileSystem.renameSync(tempPath, envPath);
    renamed = true;
  } catch (error) {
    if (error instanceof SessionSecretRotationError) throw error;
    throw new SessionSecretRotationError(
      'SESSION_SECRET_ATOMIC_UPDATE_FAILED',
      'Unable to rotate SESSION_SECRET atomically.'
    );
  } finally {
    if (tempDescriptor !== undefined) {
      try {
        fileSystem.closeSync(tempDescriptor);
      } catch (_error) {
        // Best-effort close is followed by best-effort temporary-file cleanup.
      }
    }
    if (tempCreated && !renamed) {
      try {
        fileSystem.unlinkSync(tempPath);
      } catch (_error) {
        // The temporary file may not have been created.
      }
    }
  }

  try {
    fsyncParentDirectory(parentPath, fileSystem);
  } catch (_error) {
    throw new SessionSecretRotationError(
      'SESSION_SECRET_ROTATED_DURABILITY_UNCONFIRMED',
      'SESSION_SECRET was replaced, but filesystem durability could not be confirmed. Do not automatically retry the rotation.'
    );
  }
}

function runCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  rotate = rotateSessionSecret
} = {}) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    stdout.write(HELP_TEXT);
    return 0;
  }
  if (argv.length !== 0) {
    stderr.write('session:rotate accepts no arguments. Use --help for usage.\n');
    return 1;
  }

  try {
    rotate();
    stdout.write(SUCCESS_TEXT);
    return 0;
  } catch (error) {
    if (error instanceof SessionSecretRotationError &&
        error.code === 'SESSION_SECRET_ROTATED_DURABILITY_UNCONFIRMED') {
      stderr.write(DURABILITY_UNCONFIRMED_TEXT);
      return 1;
    }
    const message = error instanceof SessionSecretRotationError
      ? error.message
      : 'Unable to rotate SESSION_SECRET safely.';
    stderr.write(`SESSION_SECRET rotation failed: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  DURABILITY_UNCONFIRMED_TEXT,
  HELP_TEXT,
  SUCCESS_TEXT,
  SessionSecretRotationError,
  rotateSessionSecret,
  runCli,
  updatedLocalEnv
};
