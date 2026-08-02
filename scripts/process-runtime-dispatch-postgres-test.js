#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const {
  hashProcessContractValue
} = require('../runtime/process-execution-contract');
const {
  buildProcessExecutionReleaseContract
} = require('../runtime/process-execution-release-contract');

const assert = createAsserter();
const STAMP = Date.now();

function encodePlans(plans) {
  return Buffer.from(JSON.stringify(plans), 'utf8').toString('base64url');
}

function createFetchStub(root) {
  const preloadPath = path.join(root, 'provider-stub.js');
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const indexes = new Map();
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  if (process.env.PROCESS_PROVIDER_PROMPT_LOG) {
    fs.appendFileSync(
      process.env.PROCESS_PROVIDER_PROMPT_LOG,
      JSON.stringify(body) + '\\n',
      'utf8'
    );
  }
  const combined = (body.input || []).map(item => String(item.content || '')).join('\\n');
  const match = combined.match(/#PLANS=([A-Za-z0-9_-]+)/);
  const plans = match
    ? JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
    : [{ message: 'complete', actions: [], complete: true }];
  const key = match ? match[1] : 'default';
  const index = indexes.get(key) || 0;
  indexes.set(key, index + 1);
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'process-runtime-dispatch']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plans[Math.min(index, plans.length - 1)]),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`);
  return preloadPath;
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const result = Buffer.alloc(payload.length + 4);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function createProtocolServer(socketPath, handler) {
  const server = net.createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (bytes.length !== length + 4) return;
      let request;
      try {
        request = JSON.parse(bytes.subarray(4).toString('utf8'));
        Promise.resolve().then(
          () => handler(request.operation, request.body)
        ).then(value => {
          socket.end(frame({
            version: 1,
            requestId: request.requestId,
            ok: true,
            result: value
          }));
        }, error => {
          socket.end(frame({
            version: 1,
            requestId: request.requestId,
            ok: false,
            error: {
              code: error.code || 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
              message: error.message
            }
          }));
        });
      } catch (error) {
        socket.destroy(error);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

function catalog() {
  return {
    version: 2,
    runtimeRootfs: [{
      id: 'node-24-fedora-runtime-v1',
      manifestSha256: 'a'.repeat(64)
    }],
    targets: [{
      id: 'ticket-system-local',
      profiles: [{
        id: 'syntax-check',
        allowedPhases: ['inspection'],
        runtimeRootfsId: 'node-24-fedora-runtime-v1',
        executableIdentity: {
          path: '/usr/bin/node',
          sha256: 'b'.repeat(64),
          format: 'elf'
        },
        arguments: ['--check', 'server.js'],
        workingDirectory: '.',
        environment: { CI: '1' },
        filesystemPolicy: {
          inputMode: 'materialized_read_only',
          writableRoots: [],
          allowSymlinks: false,
          allowSpecialFiles: false,
          maxInputFiles: 10000,
          maxInputBytes: 268435456
        },
        limits: {
          wallTimeMs: 30000,
          maxOutputBytes: 1048576,
          maxProcesses: 8,
          memoryBytes: 268435456,
          cpuQuotaMicrosPer100ms: 100000,
          maxOpenFiles: 128,
          maxFileBytes: 16777216,
          maxTempBytes: 67108864
        }
      }]
    }]
  };
}

async function waitFor(operation, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  await withHarness('process runtime dispatch PostgreSQL', async ({
    store,
    workspaceRoot,
    startServer
  }) => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-runtime-dispatch-'));
    const materializerSocket = path.join(privateRoot, 'materializer.sock');
    const launcherSocket = path.join(privateRoot, 'launcher.sock');
    const catalogPath = path.join(privateRoot, 'process-targets.json');
    const artifactRoot = path.join(privateRoot, 'artifacts');
    const providerPromptLog = path.join(privateRoot, 'provider-prompts.jsonl');
    const preloadPath = createFetchStub(privateRoot);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog()));
    fs.writeFileSync(path.join(workspaceRoot, 'input.txt'), 'trusted inspection input');

    const materializerGeneration = `materializer-v1-${'5'.repeat(64)}`;
    const rootfsGeneration = `rootfs-registry-v1-${'4'.repeat(64)}`;
    const now = Date.now();
    const containment = {
      version: 1,
      status: 'containment_verified',
      generationId: `sandbox-containment-v1-${'c'.repeat(64)}`,
      launcherProtocolVersion: 1,
      launcherIdentityHash: '1'.repeat(64),
      sandboxBackendIdentityHash: '2'.repeat(64),
      seccompPolicyHash: '3'.repeat(64),
      rootfsRegistryGeneration: rootfsGeneration,
      materializerGeneration,
      delegatedCgroupIdentityHash: '6'.repeat(64),
      containmentProbeHash: '7'.repeat(64),
      maxActiveOperations: 4,
      verifiedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 240000).toISOString(),
      readyForExecution: true
    };
    const stdout = Buffer.from([0, 1, 2, 255, 10]);
    const stderr = Buffer.from('verified syntax\\n', 'utf8');
    const native = {
      launchCount: 0,
      acknowledgeCount: 0,
      status: null,
      workspaceDescriptor: null
    };

    const materializerServer = await createProtocolServer(
      materializerSocket,
      (operation, body) => {
        if (operation === 'health') {
          return {
            materializerGeneration,
            materializerIdentityHash: '8'.repeat(64),
            inputPolicyHash: '9'.repeat(64),
            manifestSchemaVersion: 1,
            registrySchemaVersion: 1
          };
        }
        if (operation === 'materialize') {
          native.workspaceDescriptor = {
            id: 'workspace-snapshot-dispatch',
            runId: body.runId,
            policySnapshotHash: body.policySnapshotHash,
            materializerGeneration,
            manifestSha256: 'd'.repeat(64),
            fileCount: 1,
            totalBytes: 24
          };
          return native.workspaceDescriptor;
        }
        if (operation === 'getSnapshot') return native.workspaceDescriptor;
        throw new Error(`unexpected materializer operation ${operation}`);
      }
    );
    const launcherServer = await createProtocolServer(
      launcherSocket,
      (operation, body) => {
        if (operation === 'health') return containment;
        if (operation === 'getRootfs') {
          return {
            id: body.rootfsId,
            manifestSha256: body.rootfsManifestSha256,
            physicalIdentityHash: 'e'.repeat(64),
            entryCount: 12,
            totalRegularBytes: 123456,
            rootfsRegistryGeneration: rootfsGeneration
          };
        }
        if (operation === 'verifyExecutable') {
          return {
            rootfsId: body.rootfsId,
            rootfsManifestSha256: body.rootfsManifestSha256,
            executablePath: body.executablePath,
            executableSha256: body.executableSha256,
            format: 'elf',
            rootfsRegistryGeneration: rootfsGeneration
          };
        }
        if (operation === 'launch') {
          native.launchCount += 1;
          const operationIdentity = body.launchPlan.operationIdentity;
          native.status = {
            operationIdentity,
            state: 'active',
            launcherAcceptanceIdentity:
              `process-launcher-acceptance:${'f'.repeat(64)}`,
            terminalResultHash: null,
            outputAvailable: false,
            result: null
          };
          return native.status;
        }
        if (operation === 'getOperation' || operation === 'cancelOperation') {
          if (!native.status) {
            const error = new Error('operation missing');
            error.code = 'PROCESS_OPERATION_NOT_FOUND';
            throw error;
          }
          if (native.status.state !== 'terminal') {
            const endedAt = new Date().toISOString();
            const result = {
              operationIdentity: native.status.operationIdentity,
              terminalOutcome: 'completed',
              startedAt: new Date(Date.parse(endedAt) - 5).toISOString(),
              endedAt,
              durationMs: 5,
              exitCode: 0,
              signal: null,
              stdoutBytes: stdout.length,
              stderrBytes: stderr.length,
              combinedOutputBytes: stdout.length + stderr.length,
              stdoutSha256: crypto.createHash('sha256').update(stdout).digest('hex'),
              stderrSha256: crypto.createHash('sha256').update(stderr).digest('hex'),
              outputComplete: true,
              resourceCause: null,
              enforcementCause: null,
              cpuThrottledEvents: 1,
              launcherEnvironment: {
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                TMPDIR: '/tmp'
              }
            };
            native.status = {
              ...native.status,
              state: 'terminal',
              terminalResultHash: hashProcessContractValue(result),
              outputAvailable: true,
              result
            };
          }
          return native.status;
        }
        if (operation === 'readOutput') {
          const source = body.stream === 'stdout' ? stdout : stderr;
          const end = Math.min(source.length, body.offset + body.maximumBytes);
          return {
            operationIdentity: body.operationIdentity,
            stream: body.stream,
            offset: body.offset,
            totalBytes: source.length,
            sha256: crypto.createHash('sha256').update(source).digest('hex'),
            dataBase64: source.subarray(body.offset, end).toString('base64'),
            end: end === source.length
          };
        }
        if (operation === 'acknowledgeOutput') {
          if (body.terminalResultHash !== native.status.terminalResultHash) {
            throw new Error('terminal hash mismatch');
          }
          native.acknowledgeCount += 1;
          native.status.outputAvailable = false;
          return native.status;
        }
        throw new Error(`unexpected launcher operation ${operation}`);
      }
    );

    try {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `Process Dispatch ${STAMP}`,
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'test-key',
          runtimeConfig: {
            processProfileGrants: [{
              targetId: 'ticket-system-local',
              profileIds: ['syntax-check']
            }]
          }
        },
        groupIds: [],
        changedBy: 'process-runtime-dispatch-test'
      })).agent;
      const plans = [{
        message: 'Inspect the workspace first.',
        actions: [{ operation: 'readFile', args: { path: 'input.txt' } }],
        complete: false
      }, {
        message: 'Run the exact authorized syntax profile.',
        actions: [{
          operation: 'runProcess',
          args: {
            targetId: 'ticket-system-local',
            profileId: 'syntax-check',
            operationId: 'syntax-operation-001'
          }
        }],
        complete: false
      }, {
        message: 'The authorized syntax inspection completed.',
        actions: [],
        complete: true
      }];
      const objective =
        `Inspect project syntax with the trusted process profile ${STAMP} ` +
        `#PLANS=${encodePlans(plans)}`;
      const sourceRevision = 'a'.repeat(40);
      const releaseContract = buildProcessExecutionReleaseContract({
        applicationVersion: require('../package.json').version,
        sourceRevision
      });
      await store.setProcessExecutionAdmission({
        enabled: true,
        releaseContractHash: releaseContract.releaseContractHash,
        sourceRevision,
        applicationVersion: releaseContract.applicationVersion,
        changedBy: 'process-runtime-dispatch-test',
        reason: 'validated isolated process test deployment'
      });
      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        ENABLE_PROCESS_EXECUTION_CONTRACT: 'true',
        PROCESS_EXECUTION_SOURCE_REVISION: sourceRevision,
        PROCESS_EXECUTION_DEPLOYMENT_VALIDATED: 'true',
        PROCESS_TARGET_CATALOG_FILE: catalogPath,
        PROCESS_MATERIALIZER_SOCKET_PATH: materializerSocket,
        PROCESS_LAUNCHER_SOCKET_PATH: launcherSocket,
        PROCESS_WORKSPACE_ALLOCATION_ID: 'primary-workspace',
        ARTIFACT_ROOT: artifactRoot,
        PROCESS_PROVIDER_PROMPT_LOG: providerPromptLog,
        RUNTIME_SCHEDULER_INTERVAL_MS: '100',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();
      const created = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual'
        }
      });
      assert(created.statusCode === 302, 'authorized process ticket is admitted');
      const ticket = await waitFor(async () => {
        const page = await store.listTickets({ limit: 100 });
        return page.tickets.find(item => item.objective === objective);
      }, 30000, 'process ticket');
      const run = await waitFor(async () => {
        const page = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
        return page.runs[0];
      }, 30000, 'process run');
      const terminalRun = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status)
          ? current
          : null;
      }, 90000, 'terminal process run');
      if (terminalRun.status !== 'completed') {
        const diagnosticEvents = await store.listRunEvents(
          run.id,
          { afterSeq: -1, limit: 500 }
        );
        const diagnosticOperations = await store.listProcessOperationsForRun(run.id);
        throw new Error(
          `authorized process run ended ${terminalRun.status}: ` +
          JSON.stringify({
            failureKind: terminalRun.failureKind,
            failureMessage: terminalRun.failureMessage,
            events: diagnosticEvents.slice(-12).map(event => ({
              type: event.type,
              message: event.message,
              payload: event.payload
            })),
            processOperations: diagnosticOperations,
            native
          })
        );
      }
      assert(terminalRun.status === 'completed',
        'authorized process action participates in ordinary run completion');
      assert(terminalRun.processPolicySnapshot.version === 3 &&
        terminalRun.processRuntimeCapabilitySnapshot.readyForExecution === true,
      'admission freezes version-3 authority and one runtime capability generation');
      const providerPrompts = fs.readFileSync(providerPromptLog, 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      assert(providerPrompts.some(prompt =>
        (prompt.input || []).some(item => {
          let decoded;
          try {
            decoded = JSON.parse(item.content);
          } catch (_) {
            return false;
          }
          const envelope = decoded && decoded.runtimeEnvelope;
          if (!envelope) return false;
          const serialized = JSON.stringify(envelope);
          return envelope.allowedOperations.includes('runProcess') &&
            serialized.includes('"ticket-system-local"') &&
            serialized.includes('"syntax-check"') &&
            !serialized.includes('"/usr/bin/node"') &&
            !serialized.includes('"maxTempBytes"');
        })
      ), 'fresh runtime capability advertises only model-safe process references');

      const operations = await store.listProcessOperationsForRun(run.id);
      assert(operations.length === 1 && operations[0].lifecycleState === 'terminal',
        'one canonical durable process operation reaches terminal');
      const operation = operations[0];
      const budgetState = await store.getRunBudgetState(run.id);
      assert(budgetState.usage.process_operation.committed === 1 &&
        budgetState.usage.output_artifact_bytes.committed ===
          stdout.length + stderr.length &&
        budgetState.usage.model_request.committed >= 1 &&
        budgetState.usage.execution_step.committed >= 1,
      'authorized dispatch charges process, output, model, and execution-step usage exactly once');
      assert(budgetState.charges.filter(charge =>
        charge.dimension === 'process_operation' &&
        charge.sourceIdentity === operation.operationIdentity
      ).length === 1,
      'canonical process operation identity is the durable budget source');
      assert(native.launchCount === 1 && native.acknowledgeCount === 1,
        'runtime submits once and acknowledges output only after finalization');
      assert(operation.requiredEvidenceState === 'complete' &&
        operation.launcherOutputAcknowledged === true,
      'database finalization binds required evidence and launcher acknowledgement');
      assert(operation.stdoutArtifact.byteCount === stdout.length &&
        operation.stderrArtifact.byteCount === stderr.length,
      'stdout and stderr artifact metadata bind exact launcher facts');
      assert(Buffer.compare(
        fs.readFileSync(path.join(artifactRoot, ...operation.stdoutArtifact.path.split('/'))),
        stdout
      ) === 0 && Buffer.compare(
        fs.readFileSync(path.join(artifactRoot, ...operation.stderrArtifact.path.split('/'))),
        stderr
      ) === 0, 'published artifacts preserve exact raw stream bytes');

      const events = await store.listRunEvents(run.id, { afterSeq: -1, limit: 500 });
      for (const type of [
        'process.intent_admitted',
        'process.launcher_accepted',
        'process.terminal',
        'process.stdout_artifact',
        'process.stderr_artifact'
      ]) {
        assert(events.filter(event => event.type === type).length === 1,
          `${type} required evidence is published exactly once`);
      }
      const receipts = await store.listRunOperations(run.id, { limit: 100 });
      assert(receipts.some(receipt => receipt.operation === 'runProcess' &&
        receipt.outcome === 'succeeded'),
      'process receipt participates in generic run reconstruction');
      const consequenceRecord = await store.getRunConsequence(run.id);
      const processConsequences = consequenceRecord &&
        Array.isArray(consequenceRecord.consequence.processOperations)
        ? consequenceRecord.consequence.processOperations
        : [];
      assert(processConsequences.length === 1 &&
        processConsequences[0].operationIdentity === operation.operationIdentity &&
        processConsequences[0].operation === 'runProcess' &&
        processConsequences[0].outcome === 'succeeded' &&
        processConsequences[0].terminalOutcome === 'completed' &&
        processConsequences[0].terminalResultHash === operation.terminalResultHash,
      'successful process receipt participates in the persisted ordinary run consequence');
      assert(['created', 'updated', 'deleted', 'renamed']
        .every(key => Array.isArray(consequenceRecord.consequence[key]) &&
          consequenceRecord.consequence[key].length === 0),
      'process consequence does not claim a workspace mutation');

      const databaseEvidence = JSON.stringify({
        operation,
        events: events.filter(event => event.type.startsWith('process.'))
      });
      assert(!databaseEvidence.includes(stdout.toString('base64')) &&
        !databaseEvidence.includes(stderr.toString('utf8')),
      'raw process output is absent from PostgreSQL lifecycle and evidence');
      assert(!/\/(?:tmp|var|home)\//.test(databaseEvidence),
        'host paths are absent from process database records and evidence');
    } finally {
      await new Promise(resolve => materializerServer.close(resolve));
      await new Promise(resolve => launcherServer.close(resolve));
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });
  console.log(`PASS: authorized process runtime dispatch PostgreSQL (${assert.count()} assertions)`);
}

main().catch(error => {
  console.error(`FAIL: authorized process runtime dispatch PostgreSQL — ${error.stack || error.message}`);
  process.exit(1);
});
