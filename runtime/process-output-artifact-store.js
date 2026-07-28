'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  PROCESS_OPERATION_IDENTITY_PATTERN
} = require('./process-launch-plan');

const PROCESS_ARTIFACT_PUBLICATION_CONTRACT_VERSION = 1;
const PROCESS_OUTPUT_CHUNK_BYTES = 65_536;

class ProcessOutputArtifactError extends Error {
  constructor(message, code = 'PROCESS_OUTPUT_ARTIFACT_FAILED') {
    super(message);
    this.name = 'ProcessOutputArtifactError';
    this.code = code;
    this.failureKind = 'process_output_failed';
  }
}

async function sha256File(filePath) {
  const metadata = await fs.promises.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o222) !== 0) {
    throw new ProcessOutputArtifactError(
      'Existing process artifact is not an immutable regular file'
    );
  }
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    return await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const input = handle.createReadStream({ autoClose: false });
      input.on('data', chunk => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      input.once('error', reject);
      input.once('end', () => resolve({
        bytes,
        sha256: hash.digest('hex')
      }));
    });
  } finally {
    await handle.close();
  }
}

class ProcessOutputArtifactStore {
  constructor({ artifactRoot } = {}) {
    if (typeof artifactRoot !== 'string' || !path.isAbsolute(artifactRoot)) {
      throw new TypeError('artifactRoot must be an absolute trusted runtime path');
    }
    this.artifactRoot = artifactRoot;
    this.processRoot = path.join(artifactRoot, 'process');
  }

  async health() {
    try {
      await fs.promises.mkdir(this.processRoot, {
        recursive: true,
        mode: 0o700
      });
      await fs.promises.access(this.processRoot, fs.constants.R_OK | fs.constants.W_OK);
      const metadata = await fs.promises.lstat(this.processRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('process artifact root is not a directory');
      }
      return Object.freeze({
        version: PROCESS_ARTIFACT_PUBLICATION_CONTRACT_VERSION,
        status: 'writable'
      });
    } catch (error) {
      throw new ProcessOutputArtifactError(
        `Process artifact storage is unavailable: ${error.message}`
      );
    }
  }

  async publish({
    operationIdentity,
    stream,
    expectedBytes,
    expectedSha256,
    readChunk
  } = {}) {
    if (typeof operationIdentity !== 'string' ||
        !PROCESS_OPERATION_IDENTITY_PATTERN.test(operationIdentity)) {
      throw new ProcessOutputArtifactError('Invalid process operation identity');
    }
    if (!['stdout', 'stderr'].includes(stream)) {
      throw new ProcessOutputArtifactError('Process artifact stream must be stdout or stderr');
    }
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
        typeof expectedSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(expectedSha256) ||
        typeof readChunk !== 'function') {
      throw new ProcessOutputArtifactError('Process artifact authority is invalid');
    }
    await this.health();
    const operationHash = crypto.createHash('sha256')
      .update(operationIdentity)
      .digest('hex');
    const directory = path.join(this.processRoot, operationHash);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const finalPath = path.join(directory, `${stream}.bin`);
    const relativePath = path.posix.join('process', operationHash, `${stream}.bin`);
    try {
      const existing = await sha256File(finalPath);
      if (existing.bytes !== expectedBytes || existing.sha256 !== expectedSha256) {
        throw new ProcessOutputArtifactError(
          'Existing immutable process artifact conflicts with terminal output'
        );
      }
      return Object.freeze({
        version: PROCESS_ARTIFACT_PUBLICATION_CONTRACT_VERSION,
        id: `${operationHash}:${stream}`,
        path: relativePath,
        stream,
        byteCount: expectedBytes,
        sha256: expectedSha256
      });
    } catch (error) {
      if (error instanceof ProcessOutputArtifactError) throw error;
      if (error.code !== 'ENOENT') {
        throw new ProcessOutputArtifactError(
          `Cannot inspect existing process artifact: ${error.message}`
        );
      }
    }

    const temporaryPath = path.join(
      directory,
      `.${stream}.${crypto.randomBytes(16).toString('hex')}.tmp`
    );
    let handle;
    try {
      handle = await fs.promises.open(
        temporaryPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT |
          fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600
      );
      const hash = crypto.createHash('sha256');
      let offset = 0;
      while (offset < expectedBytes) {
        const maximumBytes = Math.min(PROCESS_OUTPUT_CHUNK_BYTES, expectedBytes - offset);
        const chunk = await readChunk({
          stream,
          offset,
          maximumBytes,
          expectedTotalBytes: expectedBytes,
          expectedSha256
        });
        if (!chunk || !Buffer.isBuffer(chunk.bytes) ||
            chunk.offset !== offset ||
            chunk.bytes.length === 0 ||
            chunk.bytes.length > maximumBytes ||
            chunk.end !== (offset + chunk.bytes.length === expectedBytes)) {
          throw new ProcessOutputArtifactError(
            'Launcher returned an invalid or substituted output chunk',
            'PROCESS_OUTPUT_CHUNK_INVALID'
          );
        }
        await handle.write(chunk.bytes, 0, chunk.bytes.length, offset);
        hash.update(chunk.bytes);
        offset += chunk.bytes.length;
      }
      if (expectedBytes === 0) {
        const chunk = await readChunk({
          stream,
          offset: 0,
          maximumBytes: PROCESS_OUTPUT_CHUNK_BYTES,
          expectedTotalBytes: 0,
          expectedSha256
        });
        if (!chunk || !Buffer.isBuffer(chunk.bytes) ||
            chunk.bytes.length !== 0 || chunk.end !== true) {
          throw new ProcessOutputArtifactError(
            'Launcher empty-output response is invalid',
            'PROCESS_OUTPUT_CHUNK_INVALID'
          );
        }
      }
      const actualHash = hash.digest('hex');
      if (offset !== expectedBytes || actualHash !== expectedSha256) {
        throw new ProcessOutputArtifactError(
          'Launcher output does not match terminal byte/hash authority',
          'PROCESS_OUTPUT_HASH_MISMATCH'
        );
      }
      await handle.chmod(0o400);
      await handle.sync();
      await handle.close();
      handle = null;
      // link(2) fails with EEXIST and therefore publishes without replacing an
      // already durable artifact. rename(2) would silently overwrite it.
      await fs.promises.link(temporaryPath, finalPath);
      await fs.promises.unlink(temporaryPath);
      const directoryHandle = await fs.promises.open(directory, fs.constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return Object.freeze({
        version: PROCESS_ARTIFACT_PUBLICATION_CONTRACT_VERSION,
        id: `${operationHash}:${stream}`,
        path: relativePath,
        stream,
        byteCount: expectedBytes,
        sha256: expectedSha256
      });
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch (_) {}
      }
      try { await fs.promises.unlink(temporaryPath); } catch (_) {}
      if (error instanceof ProcessOutputArtifactError) throw error;
      throw new ProcessOutputArtifactError(
        `Process output artifact publication failed: ${error.message}`
      );
    }
  }
}

module.exports = {
  PROCESS_ARTIFACT_PUBLICATION_CONTRACT_VERSION,
  PROCESS_OUTPUT_CHUNK_BYTES,
  ProcessOutputArtifactError,
  ProcessOutputArtifactStore
};
