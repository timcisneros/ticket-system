#!/usr/bin/env node
'use strict';

const argon2 = require('argon2');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const {
  withHarness,
  createAsserter,
  sleep
} = require('./postgres-test-harness');
const {
  buildProcessOperationIdentity,
  hashProcessContractValue
} = require('../runtime/process-execution-contract');
const {
  buildProcessExecutionReleaseContract
} = require('../runtime/process-execution-release-contract');

const assert = createAsserter();
const STAMP = Date.now();
const UNAUTHORIZED_PASSWORD = 'process-supervision-no-access';

function encodePlans(plans) {
  return Buffer.from(JSON.stringify(plans), 'utf8').toString('base64url');
}

function createProviderStub(root) {
  const preloadPath = path.join(root, 'provider-stub.js');
  fs.writeFileSync(preloadPath, `
const indexes = new Map();
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
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
    headers: new Map([['x-request-id', 'process-supervision']]),
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
  const framed = Buffer.alloc(payload.length + 4);
  framed.writeUInt32BE(payload.length, 0);
  payload.copy(framed, 4);
  return framed;
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
      } catch (error) {
        socket.destroy(error);
        return;
      }
      Promise.resolve().then(
        () => handler(request.operation, request.body)
      ).then(
        result => socket.end(frame({
          version: 1,
          requestId: request.requestId,
          ok: true,
          result
        })),
        error => socket.end(frame({
          version: 1,
          requestId: request.requestId,
          ok: false,
          error: {
            code: error.code || 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
            message: error.message
          }
        }))
      );
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
    await sleep(75);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function json(response) {
  return JSON.parse(response.body);
}

async function main() {
  await withHarness('process supervision PostgreSQL public seam', async ({
    store,
    workspaceRoot,
    startServer
  }) => {
    const privateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'process-supervision-')
    );
    const materializerSocket = path.join(privateRoot, 'materializer.sock');
    const launcherSocket = path.join(privateRoot, 'launcher.sock');
    const catalogPath = path.join(privateRoot, 'process-targets.json');
    const artifactRoot = path.join(privateRoot, 'artifacts');
    const preloadPath = createProviderStub(privateRoot);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog()));
    fs.writeFileSync(path.join(workspaceRoot, 'input.txt'), 'inspection input');

    const materializerGeneration = `materializer-v1-${'5'.repeat(64)}`;
    const rootfsGeneration = `rootfs-registry-v1-${'4'.repeat(64)}`;
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
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 240000).toISOString(),
      readyForExecution: true
    };
    const emptySha256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const native = {
      status: null,
      launchCount: 0,
      cancelInvocations: 0,
      cancelEffects: 0,
      cancelAt: null,
      acknowledgeCount: 0,
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
            id: 'workspace-snapshot-supervision',
            runId: body.runId,
            policySnapshotHash: body.policySnapshotHash,
            materializerGeneration,
            manifestSha256: 'd'.repeat(64),
            fileCount: 1,
            totalBytes: 16
          };
          return native.workspaceDescriptor;
        }
        if (operation === 'getSnapshot') return native.workspaceDescriptor;
        throw new Error(`unexpected materializer operation ${operation}`);
      }
    );

    function terminalizeCancelled() {
      if (!native.status || native.status.state === 'terminal') return;
      const endedAt = new Date().toISOString();
      const startedAt = new Date(Date.parse(endedAt) - 1).toISOString();
      const result = {
        operationIdentity: native.status.operationIdentity,
        terminalOutcome: 'cancelled',
        startedAt,
        endedAt,
        durationMs: 1,
        exitCode: null,
        signal: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        combinedOutputBytes: 0,
        stdoutSha256: emptySha256,
        stderrSha256: emptySha256,
        outputComplete: true,
        resourceCause: null,
        enforcementCause: null,
        cpuThrottledEvents: 0,
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
          native.status = {
            operationIdentity: body.launchPlan.operationIdentity,
            state: 'active',
            launcherAcceptanceIdentity:
              `process-launcher-acceptance:${'f'.repeat(64)}`,
            terminalResultHash: null,
            outputAvailable: false,
            result: null
          };
          return native.status;
        }
        if (operation === 'getOperation') {
          if (!native.status) {
            const error = new Error('operation missing');
            error.code = 'PROCESS_OPERATION_NOT_FOUND';
            throw error;
          }
          if (native.cancelAt && Date.now() - native.cancelAt >= 750) {
            terminalizeCancelled();
          }
          return native.status;
        }
        if (operation === 'cancelOperation') {
          if (!native.status) {
            const error = new Error('operation missing');
            error.code = 'PROCESS_OPERATION_NOT_FOUND';
            throw error;
          }
          native.cancelInvocations += 1;
          if (!native.cancelAt) {
            native.cancelAt = Date.now();
            native.cancelEffects += 1;
          }
          return native.status;
        }
        if (operation === 'readOutput') {
          return {
            operationIdentity: body.operationIdentity,
            stream: body.stream,
            offset: body.offset,
            totalBytes: 0,
            sha256: emptySha256,
            dataBase64: '',
            end: true
          };
        }
        if (operation === 'acknowledgeOutput') {
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
          name: `Process Supervision ${STAMP}`,
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
        changedBy: 'process-supervision-test'
      })).agent;
      const noAccessGroup = (await store.createGroup({
        value: {
          name: `No process access ${STAMP}`,
          permissions: [],
          canReceiveTickets: false
        },
        changedBy: 'process-supervision-test'
      })).group;
      await store.createUser({
        value: {
          username: `process-no-access-${STAMP}`,
          passwordHash: await argon2.hash(UNAUTHORIZED_PASSWORD)
        },
        groupIds: [noAccessGroup.id],
        changedBy: 'process-supervision-test'
      });

      const plans = [{
        message: 'Inspect the workspace.',
        actions: [{ operation: 'readFile', args: { path: 'input.txt' } }],
        complete: false
      }, {
        message: 'Start the exact bounded process profile.',
        actions: [{
          operation: 'runProcess',
          args: {
            targetId: 'ticket-system-local',
            profileId: 'syntax-check',
            operationId: 'supervised-operation-001'
          }
        }],
        complete: false
      }];
      const objective =
        `Supervise a bounded process ${STAMP} #PLANS=${encodePlans(plans)}`;
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
        changedBy: 'process-supervision-test',
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
        RUNTIME_SCHEDULER_INTERVAL_MS: '75',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const adminCookie = await server.login();
      const unauthorizedCookie = await server.login(
        `process-no-access-${STAMP}`,
        UNAUTHORIZED_PASSWORD
      );
      const created = await server.request('POST', '/tickets', {
        cookie: adminCookie,
        form: {
          objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual'
        }
      });
      assert(created.statusCode === 302, 'authorized process run is admitted');
      const ticket = await waitFor(async () => {
        const page = await store.listTickets({ limit: 100 });
        return page.tickets.find(item => item.objective === objective);
      }, 30000, 'process ticket');
      const run = await waitFor(async () => {
        const page = await store.listRunsForTicket({
          ticketId: ticket.id,
          limit: 10
        });
        return page.runs[0];
      }, 30000, 'process run');
      const activeOperation = await waitFor(async () => {
        const operations = await store.listProcessOperationsForRun(run.id);
        return operations.find(operation =>
          operation.lifecycleState === 'active') || null;
      }, 60000, 'active process operation');
      await waitFor(async () => {
        const events = await store.listRunEvents(
          run.id,
          { afterSeq: -1, limit: 500 }
        );
        return events.some(event =>
          event.type === 'process.launcher_accepted') || null;
      }, 10000, 'launcher acceptance evidence');
      assert(native.launchCount === 1,
        'one launcher operation owns the active process');

      const stableActiveOperation = await store.getProcessOperation(
        activeOperation.operationIdentity
      );
      const revisionBeforeGet = stableActiveOperation.revision;
      const eventsBeforeGet = await store.listRunEvents(
        run.id,
        { afterSeq: -1, limit: 500 }
      );
      const stateResponse = await server.request(
        'GET',
        `/api/runs/${run.id}/state`,
        { cookie: adminCookie }
      );
      assert(stateResponse.statusCode === 200,
        'authorized runtime-state request succeeds');
      const state = json(stateResponse);
      assert(state.processSupervision.lifecycleState === 'active' &&
        state.processSupervision.launcherOwnershipState === 'owned_active' &&
        state.processSupervision.processTreeState === 'active',
      'runtime-state reports active launcher ownership and tree authority');
      const serializedState = JSON.stringify(state.processSupervision);
      for (const prohibited of [
        '/usr/bin/node',
        'CI',
        'cgroup',
        'launcher.sock',
        'materializer.sock',
        workspaceRoot,
        privateRoot,
        '"pid"'
      ]) {
        assert(!serializedState.includes(prohibited),
          `runtime-state hides private process authority ${prohibited}`);
      }
      const afterGet = await store.getProcessOperation(
        activeOperation.operationIdentity
      );
      const eventsAfterGet = await store.listRunEvents(
        run.id,
        { afterSeq: -1, limit: 500 }
      );
      assert(afterGet.revision === revisionBeforeGet &&
        eventsAfterGet.length === eventsBeforeGet.length,
      'GET supervision performs no reconciliation or lifecycle mutation');
      const eventResponse = await server.request(
        'GET',
        `/api/runs/${run.id}/events`,
        { cookie: adminCookie }
      );
      assert(eventResponse.statusCode === 200 &&
        !eventResponse.body.includes('/usr/bin/node') &&
        !eventResponse.body.includes(workspaceRoot) &&
        !eventResponse.body.includes(privateRoot) &&
        !eventResponse.body.includes('launcherAcceptanceIdentity'),
      'authorized evidence remains useful without exposing private launch authority');

      const htmlResponse = await server.request('GET', `/runs/${run.id}`, {
        cookie: adminCookie
      });
      assert(htmlResponse.statusCode === 200 &&
        htmlResponse.body.includes('Process supervision') &&
        htmlResponse.body.includes('ticket-system-local') &&
        htmlResponse.body.includes('syntax-check') &&
        htmlResponse.body.includes(activeOperation.operationIdentity),
      'run detail renders the same bounded active supervision facts');
      for (const prohibited of [
        '/usr/bin/node',
        'launcher.sock',
        'materializer.sock',
        workspaceRoot,
        privateRoot
      ]) {
        const privateIndex = htmlResponse.body.indexOf(prohibited);
        assert(privateIndex === -1,
          `run detail hides private process authority ${prohibited}`);
      }

      const hidden = await server.request(
        'GET',
        `/api/runs/${run.id}/state`,
        { cookie: unauthorizedCookie }
      );
      assert(hidden.statusCode === 403,
        'a principal without ticket read authority cannot inspect supervision');
      const hiddenCancel = await server.request(
        'POST',
        `/api/runs/${run.id}/stop`,
        {
          cookie: unauthorizedCookie,
          headers: { Origin: server.baseUrl }
        }
      );
      assert(hiddenCancel.statusCode === 403 && native.cancelInvocations === 0,
        'an unauthorized principal cannot request process cancellation');

      const crossOrigin = await server.request(
        'POST',
        `/api/runs/${run.id}/stop`,
        {
          cookie: adminCookie,
          headers: { Origin: 'https://not-ticket-system.invalid' }
        }
      );
      assert(crossOrigin.statusCode === 403 && native.cancelInvocations === 0,
        'same-origin CSRF enforcement protects cancellation');
      const expandedAuthority = await server.request(
        'POST',
        `/api/runs/${run.id}/stop`,
        {
          cookie: adminCookie,
          body: { pid: 1234 },
          headers: { Origin: server.baseUrl }
        }
      );
      assert(expandedAuthority.statusCode === 400 &&
        native.cancelInvocations === 0,
      'the public route rejects PID or other process-selector input');

      const cancellationResponsePromise = server.request(
        'POST',
        `/api/runs/${run.id}/stop`,
        {
          cookie: adminCookie,
          headers: { Origin: server.baseUrl }
        }
      );
      await waitFor(async () => {
        const operation = await store.getProcessOperation(
          activeOperation.operationIdentity
        );
        return operation.cancellationRequested ? operation : null;
      }, 10000, 'durable cancellation request');
      const cancellingState = await waitFor(async () => {
        const response = await server.request(
          'GET',
          `/api/runs/${run.id}/state`,
          { cookie: adminCookie }
        );
        const current = json(response).processSupervision;
        return current &&
          ['cancellation_requested', 'cancelling'].includes(
            current.lifecycleState
          )
          ? current
          : null;
      }, 10000, 'visible cancellation state');
      assert(
        ['termination_requested', 'unknown'].includes(
          cancellingState.processTreeState
        ) &&
        cancellingState.lifecycleState !== 'terminal',
        'pending cancellation does not claim terminal success or an empty tree'
      );

      const cancellationResponse = await cancellationResponsePromise;
      assert(cancellationResponse.statusCode === 200,
        'authorized cancellation completes through the public run route ' +
        `(HTTP ${cancellationResponse.statusCode}: ${
          cancellationResponse.body.slice(0, 500)
        })`);
      for (const prohibited of [
        '/usr/bin/node',
        workspaceRoot,
        privateRoot,
        'launcherAcceptanceIdentity',
        'runtimeCapabilityGeneration'
      ]) {
        assert(!cancellationResponse.body.includes(prohibited),
          `cancellation response hides private process authority ${prohibited}`);
      }
      const terminalRun = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current && current.status === 'interrupted' ? current : null;
      }, 30000, 'interrupted run');
      assert(terminalRun.status === 'interrupted',
        'run terminalization follows process-tree cancellation');
      const terminalOperation = await store.getProcessOperation(
        activeOperation.operationIdentity
      );
      assert(terminalOperation.lifecycleState === 'terminal' &&
        terminalOperation.terminalOutcome === 'cancelled' &&
        terminalOperation.launcherOutputAcknowledged === true,
      'process artifacts, evidence, receipt, and acknowledgement finish first');
      const operationResponse = await server.request(
        'GET',
        `/api/runs/${run.id}/operations`,
        { cookie: adminCookie }
      );
      assert(operationResponse.statusCode === 200 &&
        operationResponse.body.includes(terminalOperation.stdoutArtifact.id) &&
        operationResponse.body.includes(terminalOperation.stdoutArtifact.sha256) &&
        operationResponse.body.includes(terminalOperation.stderrArtifact.id) &&
        operationResponse.body.includes(terminalOperation.stderrArtifact.sha256) &&
        !operationResponse.body.includes(terminalOperation.stdoutArtifact.path) &&
        !operationResponse.body.includes('/usr/bin/node') &&
        !operationResponse.body.includes(privateRoot),
      'existing operation authority exposes bounded artifact metadata without paths');
      assert(native.cancelInvocations === 1 && native.cancelEffects === 1,
        'one durable request causes one launcher cancellation invocation and effect ' +
        `(observed ${native.cancelInvocations}/${native.cancelEffects})`);

      const events = await store.listRunEvents(
        run.id,
        { afterSeq: -1, limit: 500 }
      );
      for (const type of [
        'process.cancellation_requested',
        'process.cancellation_reached_launcher',
        'process.terminal',
        'run.completion_decided'
      ]) {
        assert(events.filter(item => item.type === type).length === 1,
          `${type} is persisted exactly once`);
      }
      const operatorCancellation = events.find(item =>
        item.type === 'process.operator_cancellation_requested');
      assert(operatorCancellation &&
        operatorCancellation.payload &&
        Number.isSafeInteger(
          operatorCancellation.payload.actorUserId
        ) &&
        operatorCancellation.payload.actorUserId > 0 &&
        operatorCancellation.payload.action === 'cancel_run' &&
        operatorCancellation.payload.reasonCode ===
          'OPERATOR_RUN_CANCELLATION_REQUESTED',
      'existing append-only evidence audits the authorized cancellation request');
      const receipts = await store.listRunOperations(run.id, { limit: 100 });
      assert(receipts.filter(item =>
        item.operation === 'runProcess').length === 1,
      'one process operation receipt is durable');
      assert(receipts.some(item =>
        item.operation === 'runProcess' &&
        item.operationKey === activeOperation.operationIdentity),
      'the process receipt binds the canonical operation identity');
      const consequence = await store.getRunConsequence(run.id);
      assert(consequence &&
        consequence.consequence.completionDecision &&
        consequence.consequence.completionDecision.executionDisposition ===
          'cancelled' &&
        consequence.consequence.completionDecision.completionDisposition ===
          'incomplete',
      'canonical completion remains distinct from process terminalization');
      const ticketAfter = await store.getTicket(ticket.id);
      assert(ticketAfter.status !== 'completed',
        'operator cancellation does not project objective completion');

      const retry = await server.request(
        'POST',
        `/api/runs/${run.id}/stop`,
        {
          cookie: adminCookie,
          headers: { Origin: server.baseUrl }
        }
      );
      assert(retry.statusCode === 200 && native.cancelInvocations === 1,
        'repeated cancellation returns terminal supervision without another launcher call');
      const retryState = json(retry).processSupervision;
      assert(retryState.lifecycleState === 'interrupted' &&
        retryState.processTreeState === 'confirmed_empty' &&
        retryState.cancellationState === 'complete',
      'final supervision matches durable terminal and empty-tree authority ' +
        JSON.stringify(retryState));
      const repeatedEvents = await store.listRunEvents(
        run.id,
        { afterSeq: -1, limit: 500 }
      );
      assert(repeatedEvents.filter(item =>
        item.type === 'process.cancellation_requested').length === 1 &&
        repeatedEvents.filter(item =>
          item.type === 'process.operator_cancellation_requested').length === 1 &&
        repeatedEvents.filter(item =>
          item.type === 'process.terminal').length === 1 &&
        repeatedEvents.filter(item =>
          item.type === 'run.completion_decided').length === 1,
      'retry duplicates no lifecycle, terminal, or completion evidence');

      const gapPlans = [{
        message: 'The bounded fixture has no further work.',
        actions: [],
        complete: true
      }];
      const gapObjective =
        `Receipt finalization projection ${STAMP} #PLANS=${
          encodePlans(gapPlans)
        }`;
      const gapTicketResponse = await server.request('POST', '/tickets', {
        cookie: adminCookie,
        form: {
          objective: gapObjective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id),
          assignmentMode: 'individual'
        }
      });
      assert(gapTicketResponse.statusCode === 302,
        'receipt-gap fixture run is admitted through the public seam');
      const gapTicket = await waitFor(async () => {
        const page = await store.listTickets({ limit: 100 });
        return page.tickets.find(item => item.objective === gapObjective);
      }, 30000, 'receipt-gap ticket');
      const gapRun = await waitFor(async () => {
        const page = await store.listRunsForTicket({
          ticketId: gapTicket.id,
          limit: 10
        });
        const candidate = page.runs[0];
        if (!candidate ||
            !['completed', 'failed', 'interrupted'].includes(candidate.status)) {
          return null;
        }
        const durableConsequence = await store.getRunConsequence(candidate.id);
        return durableConsequence &&
          durableConsequence.consequence.completionDecision
          ? candidate
          : null;
      }, 45000, 'terminal receipt-gap run with completion decision');
      const gapOperationIdentity = buildProcessOperationIdentity(
        gapRun.id,
        'receipt-gap-operation-001'
      );
      const gapHash = 'a'.repeat(64);
      let gapOperation = (await store.createProcessExecutionIntent({
        operationIdentity: gapOperationIdentity,
        runId: gapRun.id,
        ticketId: gapRun.ticketId,
        actingAgentId: gapRun.agentId,
        stepId: 'receipt-gap-step',
        runtimePhase: 'verification',
        targetId: 'ticket-system-local',
        profileId: 'syntax-check',
        policySnapshotHash: gapHash,
        runtimeCapabilityGeneration: `process-runtime-v1-${gapHash}`,
        launchPlanVersion: 1,
        launchPlanHash: gapHash,
        launchPlan: {
          version: 1,
          operationIdentity: gapOperationIdentity,
          authority: 'immutable-receipt-gap-fixture'
        },
        workspaceSnapshotId: 'workspace-snapshot-receipt-gap',
        workspaceManifestHash: gapHash,
        materializerGeneration: 'materializer-v1-receipt-gap',
        containmentGenerationId: `sandbox-containment-v1-${gapHash}`,
        rootfsId: 'node-24-fedora-runtime-v1',
        rootfsManifestHash: gapHash,
        executableIdentityHash: gapHash,
        executionPolicyHash: gapHash,
        filesystemPolicyHash: gapHash
      })).record;
      gapOperation = await store.transitionProcessOperation({
        operationIdentity: gapOperationIdentity,
        expectedStates: ['intent'],
        expectedRevision: gapOperation.revision,
        changes: {
          lifecycleState: 'active',
          launcherAcceptanceIdentity:
            `process-launcher-acceptance:${'1'.repeat(64)}`,
          lastReconciliationResult: {
            kind: 'launcher_accepted',
            observedAt: new Date().toISOString()
          }
        }
      });
      const gapEndedAt = new Date().toISOString();
      const gapStartedAt = new Date(Date.parse(gapEndedAt) - 1).toISOString();
      const gapTerminalResult = {
        operationIdentity: gapOperationIdentity,
        terminalOutcome: 'completed',
        startedAt: gapStartedAt,
        endedAt: gapEndedAt,
        durationMs: 1,
        exitCode: 0,
        signal: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        combinedOutputBytes: 0,
        stdoutSha256: emptySha256,
        stderrSha256: emptySha256,
        outputComplete: true,
        resourceCause: null,
        enforcementCause: null,
        cpuThrottledEvents: 0,
        launcherEnvironment: {
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TMPDIR: '/tmp'
        }
      };
      const gapTerminalResultHash =
        hashProcessContractValue(gapTerminalResult);
      gapOperation = await store.transitionProcessOperation({
        operationIdentity: gapOperationIdentity,
        expectedStates: ['active'],
        expectedRevision: gapOperation.revision,
        changes: {
          lifecycleState: 'finalizing',
          startedAt: gapStartedAt,
          terminalAt: gapEndedAt,
          terminalOutcome: 'completed',
          terminalResult: gapTerminalResult,
          terminalResultHash: gapTerminalResultHash,
          exitCode: 0,
          stdoutByteCount: 0,
          stdoutSha256: emptySha256,
          stderrByteCount: 0,
          stderrSha256: emptySha256,
          combinedOutputByteCount: 0,
          lastReconciliationResult: {
            kind: 'launcher_terminal',
            observedAt: gapEndedAt,
            terminalResultHash: gapTerminalResultHash
          }
        }
      });
      const gapStdoutArtifact = {
        version: 1,
        id: 'receipt-gap-stdout',
        path: path.join(privateRoot, 'receipt-gap-stdout.bin'),
        stream: 'stdout',
        byteCount: 0,
        sha256: emptySha256
      };
      const gapStderrArtifact = {
        version: 1,
        id: 'receipt-gap-stderr',
        path: path.join(privateRoot, 'receipt-gap-stderr.bin'),
        stream: 'stderr',
        byteCount: 0,
        sha256: emptySha256
      };
      await store.appendEvent({
        type: 'process.terminal',
        ticketId: gapRun.ticketId,
        runId: gapRun.id,
        stepId: 'receipt-gap-step',
        payload: {
          operationIdentity: gapOperationIdentity,
          terminalOutcome: 'completed',
          terminalResultHash: gapTerminalResultHash
        }
      });
      gapOperation = await store.transitionProcessOperation({
        operationIdentity: gapOperationIdentity,
        expectedStates: ['finalizing'],
        expectedRevision: gapOperation.revision,
        changes: {
          lifecycleState: 'terminal',
          requiredEvidenceState: 'complete',
          stdoutArtifact: gapStdoutArtifact,
          stderrArtifact: gapStderrArtifact,
          lastReconciliationResult: {
            kind: 'durable_finalization_complete',
            observedAt: new Date().toISOString()
          }
        }
      });
      gapOperation = await store.transitionProcessOperation({
        operationIdentity: gapOperationIdentity,
        expectedStates: ['terminal'],
        expectedRevision: gapOperation.revision,
        changes: {
          launcherOutputAcknowledged: true,
          lastReconciliationResult: {
            kind: 'launcher_output_acknowledged',
            observedAt: new Date().toISOString()
          }
        }
      });
      const gapReceiptsBefore =
        await store.listRunOperations(gapRun.id, { limit: 100 });
      assert(!gapReceiptsBefore.some(item =>
        item.operation === 'runProcess'),
      'terminal fixture deliberately has no canonical runProcess receipt');
      const gapEventsBefore = await store.listRunEvents(
        gapRun.id,
        { afterSeq: -1, limit: 500 }
      );
      const gapRevisionBefore = gapOperation.revision;
      const launchCountBeforeReceiptProjection = native.launchCount;

      const gapStateResponse = await server.request(
        'GET',
        `/api/runs/${gapRun.id}/state`,
        { cookie: adminCookie }
      );
      const gapState = json(gapStateResponse).processSupervision;
      assert(gapStateResponse.statusCode === 200 &&
        gapState.lifecycleState === 'finalizing' &&
        gapState.finalizationState === 'pending' &&
        gapState.reconciliationState === 'pending' &&
        gapState.diagnosticCategory === 'recovery_failure' &&
        gapState.diagnosticCode === 'PROCESS_OPERATION_RECEIPT_MISSING',
      'authorized state API keeps a terminal operation finalizing without its receipt');
      const gapPage = await server.request(
        'GET',
        `/runs/${gapRun.id}`,
        { cookie: adminCookie }
      );
      const gapSectionStart = gapPage.body.indexOf('Process supervision');
      const gapSectionEnd = gapPage.body.indexOf('</section>', gapSectionStart);
      const gapSupervisionHtml = gapPage.body.slice(
        gapSectionStart,
        gapSectionEnd + '</section>'.length
      );
      assert(gapPage.statusCode === 200 &&
        gapSupervisionHtml.includes(
          '<dt>Finalization</dt><dd><code>pending</code></dd>'
        ) &&
        !gapSupervisionHtml.includes(
          '<dt>Finalization</dt><dd><code>complete</code></dd>'
        ),
      'run detail does not render all finalization obligations complete');
      const gapAfterReads = await store.getProcessOperation(
        gapOperationIdentity
      );
      const gapEventsAfterReads = await store.listRunEvents(
        gapRun.id,
        { afterSeq: -1, limit: 500 }
      );
      const gapReceiptsAfterReads =
        await store.listRunOperations(gapRun.id, { limit: 100 });
      assert(gapAfterReads.revision === gapRevisionBefore &&
        gapEventsAfterReads.length === gapEventsBefore.length &&
        gapReceiptsAfterReads.length === gapReceiptsBefore.length,
      'state and page GETs neither repair nor mutate PostgreSQL');

      await store.recordOperationReceipt({
        runId: gapRun.id,
        idempotencyKey: gapOperationIdentity,
        stepId: 'receipt-gap-step',
        operation: 'runProcess',
        outcome: 'succeeded',
        receipt: {
          version: 1,
          operationIdentity: gapOperationIdentity,
          targetId: 'ticket-system-local',
          profileId: 'syntax-check',
          terminalOutcome: 'completed',
          terminalResultHash: gapTerminalResultHash,
          stdoutArtifact: gapStdoutArtifact,
          stderrArtifact: gapStderrArtifact
        },
        eventType: null
      });
      const convergedResponse = await server.request(
        'GET',
        `/api/runs/${gapRun.id}/state`,
        { cookie: adminCookie }
      );
      const converged = json(convergedResponse).processSupervision;
      assert(convergedResponse.statusCode === 200 &&
        converged.lifecycleState === 'terminal' &&
        converged.finalizationState === 'complete' &&
        converged.processTreeState === 'confirmed_empty',
      'existing receipt publication converges supervision to terminal');
      const gapProcessReceipts = (
        await store.listRunOperations(gapRun.id, { limit: 100 })
      ).filter(item => item.operation === 'runProcess');
      assert(gapProcessReceipts.length === 1 &&
        gapProcessReceipts[0].operationKey === gapOperationIdentity,
      'exactly one canonical receipt binds the operation identity');
      const replayedConverged = json(await server.request(
        'GET',
        `/api/runs/${gapRun.id}/state`,
        { cookie: adminCookie }
      )).processSupervision;
      assert(JSON.stringify(replayedConverged) === JSON.stringify(converged),
        'exact replay reconstructs the same final supervision projection');
      assert(native.launchCount === launchCountBeforeReceiptProjection,
        'receipt recovery and repeated reads cause no process or launcher side effect');
    } finally {
      await new Promise(resolve => materializerServer.close(resolve));
      await new Promise(resolve => launcherServer.close(resolve));
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });
  console.log(
    `PASS: process supervision PostgreSQL public seam (${assert.count()} assertions)`
  );
}

main().catch(error => {
  console.error(
    `FAIL: process supervision PostgreSQL public seam — ${
      error.stack || error.message
    }`
  );
  process.exit(1);
});
