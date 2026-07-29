#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROCESS_OUTPUT_CHUNK_BYTES,
  ProcessOutputArtifactStore
} = require('../runtime/process-output-artifact-store');

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
async function rejectsCode(operation, code, message) {
  await assert.rejects(operation, error => error && error.code === code);
  passed += 1;
  console.log(`  ok ${message}`);
}
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function reader(operationIdentity, stream, bytes, mutate = null) {
  const digest = sha256(bytes);
  return async request => {
    const start = request.offset;
    const end = Math.min(bytes.length, start + request.maximumBytes);
    const result = {
      operationIdentity,
      stream,
      offset: start,
      totalBytes: bytes.length,
      sha256: digest,
      bytes: bytes.subarray(start, end),
      end: end === bytes.length
    };
    return mutate ? mutate(result, request) : result;
  };
}

async function main() {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-artifacts-'));
  const store = new ProcessOutputArtifactStore({ artifactRoot });
  const operationIdentity = `process-operation:${'1'.repeat(64)}`;
  try {
    await store.health();
    const stdoutBytes = Buffer.concat([
      Buffer.from([0, 255, 1, 2, 3]),
      Buffer.alloc(PROCESS_OUTPUT_CHUNK_BYTES + 17, 0x61)
    ]);
    const stdout = await store.publish({
      operationIdentity,
      stream: 'stdout',
      expectedBytes: stdoutBytes.length,
      expectedSha256: sha256(stdoutBytes),
      readChunk: reader(operationIdentity, 'stdout', stdoutBytes)
    });
    const stdoutPath = path.join(artifactRoot, ...stdout.path.split('/'));
    ok(Buffer.compare(fs.readFileSync(stdoutPath), stdoutBytes) === 0,
      'stdout artifact preserves exact bounded raw bytes across chunks');
    ok(stdout.byteCount === stdoutBytes.length &&
      stdout.sha256 === sha256(stdoutBytes) &&
      !path.isAbsolute(stdout.path),
    'artifact reference binds byte count/hash without exposing a host path');

    const stderrBytes = Buffer.from('stderr\\nwith\\0raw\\xff', 'latin1');
    const stderr = await store.publish({
      operationIdentity,
      stream: 'stderr',
      expectedBytes: stderrBytes.length,
      expectedSha256: sha256(stderrBytes),
      readChunk: reader(operationIdentity, 'stderr', stderrBytes)
    });
    ok(Buffer.compare(
      fs.readFileSync(path.join(artifactRoot, ...stderr.path.split('/'))),
      stderrBytes
    ) === 0, 'stderr is published as a separate exact raw-byte artifact');
    const verifiedStderr = await store.verifyPublished(stderr);
    ok(verifiedStderr.byteCount === stderr.byteCount &&
      verifiedStderr.sha256 === stderr.sha256 &&
      verifiedStderr.status === 'verified',
    'published artifact verification binds actual bytes to durable metadata');
    const stderrPath = path.join(artifactRoot, ...stderr.path.split('/'));
    const missingProbe = path.join(artifactRoot, 'missing-stderr-probe.bin');
    fs.renameSync(stderrPath, missingProbe);
    await rejectsCode(
      () => store.verifyPublished(stderr),
      'PROCESS_OUTPUT_UNAVAILABLE',
      'missing published artifact bytes fail truthfully rather than becoming empty'
    );
    fs.renameSync(missingProbe, stderrPath);
    await store.verifyPublished(stderr);

    const replay = await store.publish({
      operationIdentity,
      stream: 'stdout',
      expectedBytes: stdoutBytes.length,
      expectedSha256: sha256(stdoutBytes),
      readChunk: async () => {
        throw new Error('exact immutable artifact replay must not re-read launcher output');
      }
    });
    ok(JSON.stringify(replay) === JSON.stringify(stdout),
      'exact artifact replay is immutable and idempotent');

    const emptyIdentity = `process-operation:${'2'.repeat(64)}`;
    let emptyReads = 0;
    const empty = Buffer.alloc(0);
    const emptyArtifact = await store.publish({
      operationIdentity: emptyIdentity,
      stream: 'stdout',
      expectedBytes: 0,
      expectedSha256: sha256(empty),
      readChunk: async request => {
        emptyReads += 1;
        return {
          operationIdentity: emptyIdentity,
          stream: 'stdout',
          offset: request.offset,
          totalBytes: 0,
          sha256: sha256(empty),
          bytes: empty,
          end: true
        };
      }
    });
    ok(emptyReads === 1 &&
      fs.statSync(path.join(artifactRoot, ...emptyArtifact.path.split('/'))).size === 0,
    'empty streams publish one deterministic immutable zero-byte artifact');

    const badIdentity = `process-operation:${'3'.repeat(64)}`;
    const data = Buffer.from('bounded-output');
    await rejectsCode(
      () => store.publish({
        operationIdentity: badIdentity,
        stream: 'stdout',
        expectedBytes: data.length,
        expectedSha256: sha256(data),
        readChunk: reader(badIdentity, 'stdout', data, result => ({
          ...result,
          offset: result.offset + 1
        }))
      }),
      'PROCESS_OUTPUT_CHUNK_INVALID',
      'output chunk substitution is rejected'
    );

    await rejectsCode(
      () => store.publish({
        operationIdentity: `process-operation:${'4'.repeat(64)}`,
        stream: 'stdout',
        expectedBytes: data.length,
        expectedSha256: sha256(data),
        readChunk: reader(
          `process-operation:${'4'.repeat(64)}`,
          'stdout',
          data.subarray(0, data.length - 1)
        )
      }),
      'PROCESS_OUTPUT_CHUNK_INVALID',
      'truncated launcher output is rejected'
    );

    await rejectsCode(
      () => store.publish({
        operationIdentity: `process-operation:${'5'.repeat(64)}`,
        stream: 'stdout',
        expectedBytes: data.length,
        expectedSha256: sha256(data),
        readChunk: reader(
          `process-operation:${'5'.repeat(64)}`,
          'stdout',
          Buffer.concat([data, Buffer.from('x')])
        )
      }),
      'PROCESS_OUTPUT_CHUNK_INVALID',
      'extended launcher output is rejected'
    );

    await fs.promises.chmod(stdoutPath, 0o400);
    await rejectsCode(
      () => store.publish({
        operationIdentity,
        stream: 'stdout',
        expectedBytes: stdoutBytes.length,
        expectedSha256: sha256(Buffer.from('different')),
        readChunk: reader(operationIdentity, 'stdout', stdoutBytes)
      }),
      'PROCESS_OUTPUT_ARTIFACT_FAILED',
      'an existing immutable artifact cannot be substituted'
    );

    const operationDirectory = path.dirname(stdoutPath);
    const abandoned = path.join(
      operationDirectory,
      `.stderr.${'a'.repeat(32)}.tmp`
    );
    fs.writeFileSync(abandoned, 'abandoned');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(abandoned, old, old);
    const cleanup = await store.cleanupAbandonedTemporaryFiles({
      olderThanMs: 60 * 60 * 1000,
      nowMs: Date.now()
    });
    ok(cleanup.removed === 1 && !fs.existsSync(abandoned) &&
      fs.existsSync(stdoutPath),
    'startup cleanup removes only stale staging files and retains published artifacts');

    const allFiles = fs.readdirSync(path.join(artifactRoot, 'process'), {
      recursive: true
    }).map(String);
    ok(!allFiles.some(name => name.endsWith('.tmp')),
      'failed transfers leave no published or abandoned temporary artifact');
    console.log(`PASS: process output artifact publication (${passed} assertions)`);
  } finally {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: process output artifact publication — ${error.stack || error.message}`);
  process.exit(1);
});
