#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const {
  buildProcessOperationResolutionRecord,
  resolveProcessOperationRequest,
  restoreProcessOperationResolution
} = require('../runtime/process-execution-contract');

const STAMP = Date.now();
const assert = createAsserter();

function encodePlans(plans) {
  return Buffer.from(JSON.stringify(plans), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `process-contract-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
const planIndexes = new Map();
function response(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'process-contract-runtime']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    combined = (Array.isArray(body.input) ? body.input : [])
      .map(item => item && item.content ? String(item.content) : '')
      .join('\\n');
  } catch (_) {}
  const match = combined.match(/#PLANS=([A-Za-z0-9_-]+=*)/);
  if (!match) return response({ message: 'no plan', actions: [], complete: true });
  const plans = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  const index = planIndexes.get(match[1]) || 0;
  planIndexes.set(match[1], index + 1);
  return response(plans[Math.min(index, plans.length - 1)]);
};
`);
  return preloadPath;
}

function createCatalogFile() {
  const catalogPath = path.join(os.tmpdir(), `process-targets-${process.pid}-${STAMP}.json`);
  fs.writeFileSync(catalogPath, JSON.stringify({
    version: 1,
    targets: [{
      id: 'ticket-system-local',
      profiles: [{
        id: 'inspection-check',
        allowedPhases: ['inspection'],
        executable: '/usr/bin/node',
        arguments: ['--check', 'server.js'],
        workingDirectory: '.',
        environment: { CI: '1' },
        limits: {
          wallTimeMs: 30000,
          maxOutputBytes: 1048576,
          maxProcesses: 8
        }
      }, {
        id: 'verification-check',
        allowedPhases: ['verification'],
        executable: '/usr/bin/node',
        arguments: ['--check', 'server.js'],
        workingDirectory: '.',
        environment: { CI: '1' },
        limits: {
          wallTimeMs: 30000,
          maxOutputBytes: 1048576,
          maxProcesses: 8
        }
      }]
    }]
  }, null, 2));
  return catalogPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFetchStub();
  const catalogPath = createCatalogFile();
  const catalogSource = fs.readFileSync(catalogPath, 'utf8');
  try {
    await withHarness('process execution runtime contract', async ({ store, workspaceRoot, startServer }) => {
      async function createAgent(name, processProfileGrants) {
        return (await store.createConfiguredAgent({
          value: {
            name: `${name}-${STAMP}`,
            provider: 'openai',
            model: 'gpt-4.1-mini',
            apiKey: 'test-key-process-contract',
            runtimeConfig: { processProfileGrants }
          },
          groupIds: [],
          changedBy: 'process-execution-runtime-test'
        })).agent;
      }
      const grantedAgent = await createAgent('ProcessGranted', [{
        targetId: 'ticket-system-local',
        profileIds: ['inspection-check', 'verification-check']
      }]);
      const ungrantedAgent = await createAgent('ProcessUngranted', []);
      const invalidGrantAgent = await createAgent('ProcessInvalidGrant', [{
        targetId: 'missing-target',
        profileIds: ['inspection-check']
      }]);

      let server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        ENABLE_PROCESS_EXECUTION_CONTRACT: 'true',
        PROCESS_TARGET_CATALOG_FILE: catalogPath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      let cookie = await server.login();
      fs.writeFileSync(path.join(workspaceRoot, 'inspection.txt'), 'inspection fixture');

      async function runPlans(label, agent, plans) {
        const objective = `process-contract ${label} ${STAMP} #PLANS=${encodePlans(plans)}`;
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(agent.id),
            assignmentMode: 'individual'
          }
        });
        assert(created.statusCode === 302, `${label}: ticket creation is accepted`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 100 });
          return tickets.find(item => item.objective === objective) || null;
        }, 30000, `${label} ticket`);
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `${label} run`);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 90000, `${label} terminal run`);
        const replay = (await store.readRunReplay(terminal.id)).snapshot;
        const events = await store.listRunEvents(terminal.id, { afterSeq: -1, limit: 500 });
        const operationPage = await store.listRunOperations(terminal.id, { limit: 100 });
        return {
          ticket,
          run: terminal,
          replay,
          events,
          operations: operationPage.operations || operationPage
        };
      }

      const inspectionPlan = {
        message: 'Enter inspection phase.',
        actions: [{ operation: 'readFile', args: { path: 'inspection.txt' } }],
        complete: false
      };
      const operationId = `process-operation-${STAMP}`;
      const exactRequest = {
        operation: 'runProcess',
        args: {
          targetId: 'ticket-system-local',
          profileId: 'inspection-check',
          operationId
        }
      };
      const authorized = await runPlans('authorized-replay', grantedAgent, [
        inspectionPlan,
        {
          message: 'Request the authorized inspection profile twice.',
          actions: [exactRequest, structuredClone(exactRequest)],
          complete: true
        }
      ]);
      assert(authorized.run.status === 'failed',
        'authorized process request terminates because the executor is unavailable');
      assert(authorized.run.processPolicySnapshot.version === 2,
        'admission stores a version-2 process policy snapshot');
      assert(authorized.run.processPolicySnapshot.profiles.length === 2,
        'exact trusted grants resolve both selected profiles and no others');
      const inspectionProfile = authorized.run.processPolicySnapshot.profiles.find(profile =>
        profile.profileId === 'inspection-check');
      assert(inspectionProfile.executable === '/usr/bin/node' &&
        inspectionProfile.arguments.join(' ') === '--check server.js' &&
        inspectionProfile.environment.CI === '1',
      'run snapshot contains complete resolved profile authority');
      assert(inspectionProfile.executionPolicy.shell === false &&
        inspectionProfile.executionPolicy.stdin === 'disabled' &&
        inspectionProfile.executionPolicy.detached === false &&
        inspectionProfile.executionPolicy.networkAccess === 'none' &&
        inspectionProfile.executionPolicy.environmentMode === 'replace',
      'run snapshot makes all fixed execution policy values explicit');
      assert(authorized.replay.processPolicySnapshot.snapshotHash ===
        authorized.run.processPolicySnapshot.snapshotHash,
      'replay retains the exact admitted process snapshot and hash');

      const runtimeEnvelopes = (authorized.replay.providerRequests || []).flatMap(request =>
        request && request.body && Array.isArray(request.body.input)
          ? request.body.input.map(item => {
              try {
                const parsed = JSON.parse(item.content);
                return parsed.runtimeEnvelope || null;
              } catch (_) {
                return null;
              }
            }).filter(Boolean)
          : []);
      const inspectionEnvelope = runtimeEnvelopes.find(envelope =>
        envelope.currentPhase === 'inspection');
      assert(Boolean(inspectionEnvelope) &&
        !Object.hasOwn(inspectionEnvelope, 'processTargets') &&
        !Object.hasOwn(inspectionEnvelope, 'processOperation') &&
        !inspectionEnvelope.allowedOperations.includes('runProcess'),
      'historical version-2 authority remains executor-free and is not advertised');
      const providerEvidence = JSON.stringify(inspectionEnvelope);
      for (const hiddenValue of ['/usr/bin/node', '--check', '1048576']) {
        assert(!providerEvidence.includes(hiddenValue),
          `model envelope does not expose trusted authority material ${hiddenValue}`);
      }

      const resolutions = authorized.events.filter(event =>
        event.type === 'process.operation_resolution');
      assert(resolutions.length === 1,
        'exact operation-ID replay appends no duplicate resolution event');
      assert(resolutions[0].payload.code === 'PROCESS_EXECUTOR_UNAVAILABLE' &&
        resolutions[0].payload.disposition === 'unsupported' &&
        resolutions[0].payload.authorityStatus === 'allowed' &&
        resolutions[0].payload.terminalOutcome === null &&
        resolutions[0].payload.runtimePhase === 'inspection' &&
        resolutions[0].payload.policySnapshotHash ===
          authorized.run.processPolicySnapshot.snapshotHash,
      'persisted resolution stores the complete original executor-unavailable result');
      assert((authorized.replay.processOperations || []).length === 1,
        'exact operation-ID replay appends no duplicate replay resolution');
      const allowedEvents = authorized.events.filter(event =>
        event.type === 'authority.allowed' &&
        event.payload && event.payload.operationId === operationId);
      assert(allowedEvents.length === 1 && allowedEvents[0].payload.runtimePhase === 'inspection',
        'exact replay retains one authority.allowed event in the original runtime phase');
      const failedEvent = authorized.events.find(event =>
        event.type === 'run.failed' || event.type === 'run:failed');
      assert(authorized.events.some(event =>
        JSON.stringify(event.payload || {}).includes('PROCESS_EXECUTOR_UNAVAILABLE')) ||
        (failedEvent && JSON.stringify(failedEvent).includes('PROCESS_EXECUTOR_UNAVAILABLE')),
      'authorized request terminates with PROCESS_EXECUTOR_UNAVAILABLE');
      assert(!authorized.operations.some(operation =>
        operation && operation.operation === 'runProcess'),
      'authorized request creates no process target-operation receipt');
      assert(!authorized.events.some(event =>
        ['process.started', 'process.output', 'process.completed'].includes(event.type)),
      'authorization creates no process-start, PID, or output evidence');

      const wrongPhase = await runPlans('wrong-phase', grantedAgent, [
        inspectionPlan,
        {
          message: 'Request a verification-only profile during inspection.',
          actions: [{
            operation: 'runProcess',
            args: {
              targetId: 'ticket-system-local',
              profileId: 'verification-check',
              operationId: `wrong-phase-${STAMP}`
            }
          }],
          complete: true
        }
      ]);
      assert(wrongPhase.events.some(event =>
        event.type === 'authority.denied' &&
        event.payload && event.payload.disposition === 'policy_denied' &&
        event.payload.runtimePhase === 'inspection'),
      'wrong-phase request records authority.denied');
      assert(wrongPhase.events.some(event =>
        event.type === 'process.operation_resolution' &&
        event.payload && event.payload.enforcementCause &&
        event.payload.enforcementCause.errorCode === 'PROCESS_PHASE_DENIED'),
      'wrong-phase profile produces PROCESS_PHASE_DENIED rather than unknown profile');

      async function persistResolutionThenAdvancePhase({
        label,
        action,
        originalPhase,
        laterPhase
      }) {
        const ticket = await store.createTicket({
          status: 'open',
          title: `process persisted replay ${label} ${STAMP}`
        });
        const pending = await store.createRun({
          ticketId: ticket.id,
          agentId: grantedAgent.id,
          status: 'pending',
          executionMode: 'agent',
          currentPhase: 'planning',
          processPolicySnapshot: authorized.run.processPolicySnapshot
        });
        const leaseOwner = `process-replay-${label}-${STAMP}`;
        await store.claimPendingRun({
          leaseOwner,
          leaseDurationMs: 60000,
          eligibleRunIds: [pending.id]
        });
        await store.startClaimedRun({
          runId: pending.id,
          leaseOwner,
          leaseDurationMs: 60000
        });
        const admittedPhase = await store.advanceRunPhase({
          runId: pending.id,
          leaseOwner,
          fromPhase: 'planning',
          toPhase: originalPhase,
          stepId: '1',
          reason: 'persist original process resolution'
        });
        const resolution = resolveProcessOperationRequest(
          action,
          authorized.run.processPolicySnapshot,
          admittedPhase.run.currentPhase
        );
        const record = buildProcessOperationResolutionRecord({
          resolution,
          runId: pending.id,
          ticketId: ticket.id
        });
        await store.initializeRunReplay({
          runId: pending.id,
          ticketId: ticket.id,
          snapshot: {
            processPolicySnapshot: authorized.run.processPolicySnapshot,
            processOperations: [record]
          }
        });
        const advanced = await store.advanceRunPhase({
          runId: pending.id,
          leaseOwner,
          fromPhase: originalPhase,
          toPhase: laterPhase,
          stepId: '2',
          reason: 'prove process resolution replay ignores later phase'
        });
        const replay = (await store.readRunReplay(pending.id)).snapshot;
        const restored = restoreProcessOperationResolution(replay.processOperations[0], action);
        return { advanced: advanced.run, record: replay.processOperations[0], restored };
      }

      const persistedAllowed = await persistResolutionThenAdvancePhase({
        label: 'allowed',
        action: exactRequest,
        originalPhase: 'inspection',
        laterPhase: 'verification'
      });
      assert(persistedAllowed.advanced.currentPhase === 'verification' &&
        persistedAllowed.restored.code === 'PROCESS_EXECUTOR_UNAVAILABLE' &&
        persistedAllowed.restored.runtimePhase === 'inspection' &&
        persistedAllowed.restored.policySnapshotHash ===
          authorized.run.processPolicySnapshot.snapshotHash,
      'PostgreSQL replay preserves authorized/executor-unavailable resolution after phase changes to denial');

      const persistedDeniedRequest = {
        operation: 'runProcess',
        args: {
          targetId: 'ticket-system-local',
          profileId: 'verification-check',
          operationId: `persisted-denied-${STAMP}`
        }
      };
      const persistedDenied = await persistResolutionThenAdvancePhase({
        label: 'denied',
        action: persistedDeniedRequest,
        originalPhase: 'inspection',
        laterPhase: 'verification'
      });
      assert(persistedDenied.advanced.currentPhase === 'verification' &&
        persistedDenied.restored.code === 'PROCESS_PHASE_DENIED' &&
        persistedDenied.restored.authorityStatus === 'denied' &&
        persistedDenied.restored.runtimePhase === 'inspection' &&
        persistedDenied.restored.policySnapshotHash ===
          authorized.run.processPolicySnapshot.snapshotHash,
      'PostgreSQL replay preserves phase denial after phase changes to permission');

      const unknownTarget = await runPlans('unknown-target', grantedAgent, [
        inspectionPlan,
        {
          message: 'Request an unknown target.',
          actions: [{
            operation: 'runProcess',
            args: {
              targetId: 'unknown-target',
              profileId: 'inspection-check',
              operationId: `unknown-target-${STAMP}`
            }
          }],
          complete: true
        }
      ]);
      assert(unknownTarget.events.some(event =>
        event.type === 'process.operation_resolution' &&
        event.payload.enforcementCause.errorCode === 'PROCESS_TARGET_UNKNOWN'),
      'unknown process target remains a distinct typed denial');

      const unknownProfile = await runPlans('unknown-profile', grantedAgent, [
        inspectionPlan,
        {
          message: 'Request an unknown profile.',
          actions: [{
            operation: 'runProcess',
            args: {
              targetId: 'ticket-system-local',
              profileId: 'unknown-profile',
              operationId: `unknown-profile-${STAMP}`
            }
          }],
          complete: true
        }
      ]);
      assert(unknownProfile.events.some(event =>
        event.type === 'process.operation_resolution' &&
        event.payload.enforcementCause.errorCode === 'PROCESS_PROFILE_UNKNOWN'),
      'unknown process profile remains a distinct typed denial');

      const conflictId = `conflict-${STAMP}`;
      const conflict = await runPlans('operation-conflict', grantedAgent, [
        inspectionPlan,
        {
          message: 'Attempt conflicting reuse.',
          actions: [{
            operation: 'runProcess',
            args: {
              targetId: 'ticket-system-local',
              profileId: 'inspection-check',
              operationId: conflictId
            }
          }, {
            operation: 'runProcess',
            args: {
              targetId: 'ticket-system-local',
              profileId: 'verification-check',
              operationId: conflictId
            }
          }],
          complete: true
        }
      ]);
      assert((conflict.replay.processOperations || []).length === 1,
        'conflicting operation-ID reuse cannot append a second resolution');
      assert(conflict.events.some(event =>
        JSON.stringify(event.payload || {}).includes('PROCESS_OPERATION_ID_CONFLICT')),
      'conflicting operation-ID reuse terminates with PROCESS_OPERATION_ID_CONFLICT');

      const originalSnapshot = JSON.stringify(authorized.run.processPolicySnapshot);
      const originalHash = authorized.run.processPolicySnapshot.snapshotHash;
      fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, targets: [] }));
      await store.updateConfiguredAgent({
        agentId: grantedAgent.id,
        expectedRevision: grantedAgent.revision,
        value: {
          ...grantedAgent,
          runtimeConfig: { processProfileGrants: [] }
        },
        groupIds: [],
        changedBy: 'process-execution-runtime-test'
      });
      const reread = await store.getRun(authorized.run.id);
      assert(JSON.stringify(reread.processPolicySnapshot) === originalSnapshot &&
        reread.processPolicySnapshot.snapshotHash === originalHash,
      'later catalog and agent-grant mutation cannot rewrite an admitted run snapshot');

      const invalidObjective = `process-contract invalid-grant ${STAMP}`;
      const invalidAdmission = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective: invalidObjective,
          assignmentTargetType: 'agent',
          assignmentTargetId: String(invalidGrantAgent.id),
          assignmentMode: 'individual'
        }
      });
      assert(invalidAdmission.statusCode >= 400,
        'unknown trusted target grant fails closed during admission');
      const invalidTicket = (await store.listTickets({ limit: 100 })).tickets.find(ticket =>
        ticket.objective === invalidObjective);
      const invalidRuns = invalidTicket
        ? (await store.listRunsForTicket({ ticketId: invalidTicket.id, limit: 10 })).runs
        : [];
      assert(invalidRuns.length === 0,
        'invalid trusted grant creates no run with partial authority');

      const outputPath = `process-contract-fs-control-${STAMP}.txt`;
      const filesystem = await runPlans('filesystem-control', ungrantedAgent, [{
        message: 'Write the filesystem positive control.',
        actions: [{
          operation: 'writeFile',
          args: { path: outputPath, content: 'filesystem-unchanged' }
        }],
        complete: true
      }]);
      assert(filesystem.run.status === 'completed',
        'ordinary filesystem behavior remains unchanged');
      assert(fs.readFileSync(path.join(workspaceRoot, outputPath), 'utf8') === 'filesystem-unchanged',
        'ordinary filesystem operation still produces its expected effect');
      assert(filesystem.run.processPolicySnapshot.profiles.length === 0 &&
        !JSON.stringify(filesystem.replay.providerRequests || []).includes('runProcess'),
      'an ungranted existing agent receives no implicit process authority');

      fs.writeFileSync(catalogPath, catalogSource);
      await server.stop();
      const disabledAgent = await createAgent('ProcessFeatureDisabled', [{
        targetId: 'ticket-system-local',
        profileIds: ['inspection-check']
      }]);
      server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        ENABLE_PROCESS_EXECUTION_CONTRACT: 'false',
        PROCESS_TARGET_CATALOG_FILE: catalogPath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      cookie = await server.login();
      const disabledPath = `process-contract-disabled-${STAMP}.txt`;
      const disabled = await runPlans('feature-disabled', disabledAgent, [{
        message: 'Write the feature-disabled positive control.',
        actions: [{
          operation: 'writeFile',
          args: { path: disabledPath, content: 'disabled' }
        }],
        complete: true
      }]);
      assert(disabled.run.processPolicySnapshot.capabilityEnabled === false &&
        disabled.run.processPolicySnapshot.profiles.length === 0,
      'feature-disabled admission stores no process authority despite configured grants');
      assert(!JSON.stringify(disabled.replay.providerRequests || []).includes('runProcess'),
        'feature-disabled model envelopes never advertise runProcess');

      await server.stop();
      fs.writeFileSync(catalogPath, JSON.stringify({
        version: 2,
        runtimeRootfs: [{
          id: 'node-24-fedora-runtime-v1',
          manifestSha256: 'a'.repeat(64)
        }],
        targets: [{
          id: 'ticket-system-local',
          profiles: [{
            id: 'inspection-check',
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
      }, null, 2));
      const versionThreeAgent = await createAgent('ProcessVersionThree', [{
        targetId: 'ticket-system-local',
        profileIds: ['inspection-check']
      }]);
      server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        ENABLE_PROCESS_EXECUTION_CONTRACT: 'true',
        PROCESS_TARGET_CATALOG_FILE: catalogPath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      cookie = await server.login();
      const versionThreePath = `process-contract-v3-${STAMP}.txt`;
      const versionThree = await runPlans('version-three-nondispatchable', versionThreeAgent, [{
        message: 'Write the version-three non-dispatch positive control.',
        actions: [{
          operation: 'writeFile',
          args: { path: versionThreePath, content: 'version-three' }
        }],
        complete: true
      }]);
      assert(versionThree.run.processPolicySnapshot.version === 3 &&
        versionThree.run.processPolicySnapshot.profiles.length === 1,
      'catalog version 2 admission stores complete process-policy snapshot version 3');
      assert(versionThree.run.processPolicySnapshot.profiles[0].runtimeRootfs.id ===
        'node-24-fedora-runtime-v1' &&
        versionThree.run.processPolicySnapshot.profiles[0].executableIdentity.format === 'elf' &&
        versionThree.run.processPolicySnapshot.profiles[0].limits.memoryBytes === 268435456,
      'PostgreSQL run and replay retain complete version-3 rootfs, ELF, and resource authority');
      assert(versionThree.replay.processPolicySnapshot.snapshotHash ===
        versionThree.run.processPolicySnapshot.snapshotHash,
      'PostgreSQL replay retains the exact version-3 snapshot hash');
      assert(!JSON.stringify(versionThree.replay.providerRequests || []).includes('runProcess') &&
        !JSON.stringify(versionThree.replay.providerRequests || []).includes('/usr/bin/node') &&
        !JSON.stringify(versionThree.replay.providerRequests || []).includes('node-24-fedora-runtime-v1'),
      'version-3 authority and launch material remain absent from model envelopes');
      const hiddenVersionThree = await runPlans(
        'version-three-hidden-direct-denial',
        versionThreeAgent,
        [{
          message: 'Attempt a hidden version-three request.',
          actions: [{
            operation: 'runProcess',
            args: {
              targetId: 'ticket-system-local',
              profileId: 'inspection-check',
              operationId: 'hidden-v3-operation'
            }
          }],
          complete: false
        }]
      );
      const hiddenResolution = hiddenVersionThree.events.find(event =>
        event.type === 'process.operation_resolution');
      assert(hiddenVersionThree.run.status === 'failed' &&
        hiddenResolution &&
        hiddenResolution.payload.code === 'PROCESS_SANDBOX_UNAVAILABLE' &&
        hiddenResolution.payload.disposition === 'policy_denied' &&
        hiddenResolution.payload.authorityStatus === 'denied' &&
        hiddenResolution.payload.terminalOutcome === 'policy_denied',
      'hidden direct version-3 request fails closed as sandbox unavailable');
      assert(hiddenVersionThree.events.some(event =>
        event.type === 'authority.denied' &&
        event.payload &&
        event.payload.operationId === 'hidden-v3-operation') &&
        !hiddenVersionThree.events.some(event =>
          event.type === 'authority.allowed' &&
          event.payload &&
          event.payload.operationId === 'hidden-v3-operation'),
      'version-3 sandbox refusal records authority.denied and no authority.allowed');
      assert(hiddenVersionThree.operations.length === 0 &&
        !JSON.stringify(hiddenVersionThree.replay).match(
          /launchPlanHash|"pid"|stdoutByteCount|stderrByteCount|process-start/i
        ),
      'version-3 sandbox refusal creates no launch, receipt, PID, or output evidence');

      console.log(`\nPASS: process execution runtime contract — ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'process_execution_runtime' });
  } finally {
    for (const filePath of [preloadPath, catalogPath]) {
      try { fs.unlinkSync(filePath); } catch (_) { /* best effort */ }
    }
  }
}

main().catch(error => {
  console.error(`\nFAIL: process execution runtime contract — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
