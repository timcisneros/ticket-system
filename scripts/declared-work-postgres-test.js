#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness } = require('./postgres-test-harness');

const STAMP = `${Date.now()}-${process.pid}`;

function processCatalog() {
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

async function ticketByObjective(store, objective) {
  const page = await store.listTickets({ limit: 400 });
  return page.tickets.find(ticket => ticket.objective === objective) || null;
}

async function firstRun(store, ticketId) {
  const page = await store.listRunsForTicket({ ticketId, limit: 20 });
  return page.runs.slice().sort((left, right) => left.id - right.id)[0] || null;
}

async function latestRun(store, ticketId) {
  const page = await store.listRunsForTicket({ ticketId, limit: 20 });
  return page.runs.slice().sort((left, right) => right.id - left.id)[0] || null;
}

async function main() {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-work-pg-'));
  const catalogPath = path.join(privateRoot, 'process-targets.json');
  fs.writeFileSync(catalogPath, JSON.stringify(processCatalog()));

  try {
    await withHarness('declared work PostgreSQL', async ({ store, startServer }) => {
      const ordinaryAgent = (await store.createConfiguredAgent({
        value: {
          name: `Declared Work ${STAMP}`,
          provider: 'openai',
          model: 'gpt-test',
          apiKey: ''
        },
        groupIds: [],
        changedBy: 'declared-work-postgres-test'
      })).agent;
      const processAgent = (await store.createConfiguredAgent({
        value: {
          name: `Declared Process ${STAMP}`,
          provider: 'openai',
          model: 'gpt-test',
          apiKey: '',
          runtimeConfig: {
            processProfileGrants: [{
              targetId: 'ticket-system-local',
              profileIds: ['syntax-check']
            }]
          }
        },
        groupIds: [],
        changedBy: 'declared-work-postgres-test'
      })).agent;
      await store.createBrowserTarget({
        target: {
          id: `declared-browser-${STAMP}`.toLowerCase(),
          name: 'Declared work browser',
          status: 'active',
          allowedOrigins: ['https://example.com'],
          startUrl: 'https://example.com',
          limits: {
            maxNavigationsPerRun: 2,
            maxActionsPerRun: 4,
            navTimeoutMs: 10000,
            waitTimeoutMsCap: 1000,
            maxPageTextBytes: 4096,
            maxScreenshotsPerRun: 1
          }
        },
        changedBy: 'declared-work-postgres-test'
      });

      const serverEnv = {
        TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
        ENABLE_PROCESS_EXECUTION_CONTRACT: 'true',
        PROCESS_TARGET_CATALOG_FILE: catalogPath,
        PROCESS_LAUNCHER_SOCKET_PATH: path.join(privateRoot, 'unavailable-launcher.sock'),
        PROCESS_MATERIALIZER_SOCKET_PATH: path.join(privateRoot, 'unavailable-materializer.sock')
      };
      const first = await startServer(serverEnv);
      const cookie = await first.login();

      async function admit(form) {
        const response = await first.request('POST', '/tickets', {
          cookie,
          form: {
            assignmentTargetType: 'agent',
            assignmentMode: 'individual',
            ...form
          }
        });
        assert.equal(response.statusCode, 302, response.body.slice(0, 1000));
        const ticket = await ticketByObjective(store, form.objective);
        assert(ticket, `ticket was persisted: ${form.objective}`);
        const run = await firstRun(store, ticket.id);
        assert(run, `run was admitted: ${form.objective}`);
        assert(run.declaredWorkSnapshot, `declared work was admitted: ${form.objective}`);
        return { ticket, run };
      }

      const directObjective = `Create folder declared-work-${STAMP}`;
      const direct = await admit({
        objective: directObjective,
        acceptanceCriteria: 'The admitted folder criterion remains declared separately.',
        assignmentTargetId: String(ordinaryAgent.id)
      });
      assert.equal(direct.run.declaredWorkSnapshot.objective.text, directObjective);
      assert(direct.run.declaredWorkSnapshot.successCriteria.some(item =>
        item.provenance === 'ticket-authored' && item.kind === 'text'));
      assert(direct.run.declaredWorkSnapshot.successCriteria.some(item =>
        item.provenance === 'deterministic-objective-contract' &&
        item.kind === 'typed-postcondition'));
      const admittedEvents = await store.listRunEvents(
        direct.run.id,
        { afterSeq: -1, limit: 20 }
      );
      const createdEvent = admittedEvents.find(event => event.type === 'run.created');
      assert(createdEvent, 'run admission emits one durable run.created event');
      assert.deepEqual(
        createdEvent.payload.declaredWorkSnapshot,
        direct.run.declaredWorkSnapshot,
        'run-created evidence binds the exact admitted declaration'
      );

      const browserObjective = `Inspect declared browser ${STAMP}`;
      const browser = await admit({
        objective: browserObjective,
        acceptanceCriteria: 'Return bounded browser evidence.',
        assignmentTargetId: String(ordinaryAgent.id),
        executionTargetKind: 'browser',
        browserTargetId: `declared-browser-${STAMP}`.toLowerCase()
      });
      assert(browser.run.targetRef && browser.run.targetRef.kind === 'browser');
      assert.equal(browser.run.declaredWorkSnapshot.objective.text, browserObjective);
      assert.deepEqual(browser.run.declaredWorkSnapshot.expectedOutputs, [],
        'browser actions and target configuration are not inferred as outputs');

      const workflowObjective = `Run declared legal intake ${STAMP}`;
      const workflow = await admit({
        objective: workflowObjective,
        acceptanceCriteria: 'The declared workflow artifacts must be reviewed.',
        assignmentTargetId: String(ordinaryAgent.id),
        capabilityType: 'workflow',
        executionMode: 'workflow',
        workflowId: 'legal-intake',
        workflowInput: JSON.stringify({ basePath: 'legal-intake' })
      });
      assert.equal(workflow.run.executionMode, 'workflow');
      assert.deepEqual(
        workflow.run.declaredWorkSnapshot.expectedOutputs.map(item => item.declaration),
        ['legal-intake/intake-register.csv', 'legal-intake/matter-summary.md']
      );
      assert(workflow.run.declaredWorkSnapshot.successCriteria.some(item =>
        item.provenance === 'workflow-defined' && item.criterionType === 'fileExists'));

      const processObjective = `Use admitted process authority ${STAMP}`;
      const process = await admit({
        objective: processObjective,
        acceptanceCriteria: 'Preserve the admitted process declaration.',
        assignmentTargetId: String(processAgent.id)
      });
      assert.equal(process.run.processPolicySnapshot.capabilityEnabled, true);
      assert.equal(process.run.processPolicySnapshot.profiles.length, 1);
      assert.equal(process.run.declaredWorkSnapshot.objective.text, processObjective);
      assert.deepEqual(process.run.declaredWorkSnapshot.expectedOutputs, [],
        'process profiles are not inferred as expected outputs');

      const directSnapshot = JSON.parse(JSON.stringify(direct.run.declaredWorkSnapshot));
      const workflowSnapshot = JSON.parse(JSON.stringify(workflow.run.declaredWorkSnapshot));
      const changedDirectTicket = (await store.transitionTicket({
        ticketId: direct.ticket.id,
        expectedRevision: direct.ticket.revision,
        fromStatuses: ['in_progress'],
        toStatus: 'in_progress',
        patch: {
          objective: `Changed objective ${STAMP}`,
          acceptanceCriteria: 'Changed acceptance criteria'
        },
        eventPayload: { source: 'declared-work-postgres-test' }
      })).ticket;
      assert.equal(
        (await store.getRun(direct.run.id)).declaredWorkSnapshot.contractHash,
        directSnapshot.contractHash,
        'ticket mutation does not rewrite admitted run authority'
      );

      const workflowDefinition = await store.getWorkflowById('legal-intake');
      const changedWorkflow = JSON.parse(JSON.stringify(workflowDefinition));
      changedWorkflow.verifierContract.expectedArtifacts.push('legal-intake/later.md');
      changedWorkflow.postconditions[0].path = 'legal-intake/later.csv';
      await store.updateWorkflow({
        workflowId: workflowDefinition.id,
        expectedRevision: workflowDefinition.revision,
        value: changedWorkflow,
        changedBy: 'declared-work-postgres-test'
      });
      assert.deepEqual(
        (await store.getRun(workflow.run.id)).declaredWorkSnapshot,
        workflowSnapshot,
        'workflow mutation does not rewrite admitted run authority'
      );

      const rerunResponse = await first.request(
        'POST',
        `/api/tickets/${changedDirectTicket.id}/rerun`,
        { cookie, body: {} }
      );
      assert.equal(rerunResponse.statusCode, 200, rerunResponse.body);
      const rerun = await latestRun(store, direct.ticket.id);
      assert.notEqual(rerun.id, direct.run.id);
      assert.equal(rerun.declaredWorkSnapshot.objective.text, `Changed objective ${STAMP}`);
      assert.notEqual(rerun.declaredWorkSnapshot.contractHash, directSnapshot.contractHash,
        'rerun admits a new declaration from then-current ticket authority');
      assert.deepEqual((await store.getRun(direct.run.id)).declaredWorkSnapshot, directSnapshot,
        'rerun does not reinterpret its predecessor');

      await store.recordOperationReceipt({
        runId: browser.run.id,
        idempotencyKey: `browser-operation:declared-work-${STAMP}`,
        stepId: '1',
        operation: 'observe',
        outcome: 'succeeded',
        targetId: browser.run.targetRef.browserTargetId,
        targetKind: 'browser',
        targetResourceId: 'https://example.com',
        receipt: {
          operation: 'observe',
          targetId: browser.run.targetRef.browserTargetId,
          targetKind: 'browser',
          metadata: { status: 200 },
          partial: false,
          truncated: false
        },
        eventType: null
      });
      assert.equal(
        (await store.getRun(browser.run.id)).declaredWorkSnapshot.contractHash,
        browser.run.declaredWorkSnapshot.contractHash,
        'produced evidence does not retroactively alter the declaration'
      );

      const runCountBeforeBindingRefusals = (await store.listRuns({ limit: 400 })).runs.length;
      await assert.rejects(
        () => store.createRun({
          ticketId: direct.ticket.id,
          agentId: ordinaryAgent.id,
          agentName: ordinaryAgent.name,
          executionMode: 'agent',
          status: 'pending',
          completionAuthoritySnapshot: null,
          verificationContractSnapshot: null,
          declaredWorkSnapshot: directSnapshot
        }),
        error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
          /require an immutable completionAuthoritySnapshot/.test(error.message),
        'the PostgreSQL admission seam rejects a declared direct criterion without authority'
      );
      await assert.rejects(
        () => store.createRun({
          ticketId: workflow.ticket.id,
          agentId: ordinaryAgent.id,
          agentName: ordinaryAgent.name,
          executionMode: 'workflow',
          workflowId: workflow.run.workflowId,
          status: 'pending',
          completionAuthoritySnapshot: workflow.run.completionAuthoritySnapshot,
          verificationContractSnapshot: {
            ...workflow.run.verificationContractSnapshot,
            postconditions: workflow.run.verificationContractSnapshot.postconditions.map(
              (postcondition, index) => index === 0
                ? { ...postcondition, path: `mismatched-${STAMP}.txt` }
                : postcondition
            )
          },
          declaredWorkSnapshot: workflowSnapshot
        }),
        error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH',
        'the PostgreSQL admission seam rejects drift from the frozen workflow authority'
      );
      assert.equal(
        (await store.listRuns({ limit: 400 })).runs.length,
        runCountBeforeBindingRefusals,
        'binding failures occur before any run row or execution can exist'
      );

      await assert.rejects(
        () => store.transitionRun({
          runId: browser.run.id,
          expectedRevision: browser.run.revision,
          fromStatuses: ['pending'],
          toStatus: 'pending',
          patch: { declaredWorkSnapshot: directSnapshot }
        }),
        error => error.code === 'DECLARED_WORK_SNAPSHOT_IMMUTABLE'
      );
      await assert.rejects(
        () => store.createRun({
          ticketId: browser.ticket.id,
          agentId: ordinaryAgent.id,
          agentName: ordinaryAgent.name,
          status: 'pending',
          declaredWorkSnapshot: {
            ...browser.run.declaredWorkSnapshot,
            contractHash: '0'.repeat(64)
          }
        }),
        error => error.code === 'DECLARED_WORK_SNAPSHOT_CONFLICT'
      );

      const directState = await first.request(
        'GET',
        `/api/runs/${direct.run.id}/state`,
        { cookie }
      );
      assert.equal(directState.statusCode, 200, directState.body);
      const directProjection = JSON.parse(directState.body);
      assert.deepEqual(directProjection.declaredWorkSnapshot, directSnapshot);
      assert.equal(directProjection.declaredWorkAvailability, 'available');
      assert.equal(directProjection.declaredCompletionBinding.status, 'bound');
      assert.equal(directProjection.declaredCompletionBinding.criteria.length, 1);
      assert.equal(
        directProjection.declaredCompletionBinding.criteria[0].authoritySource,
        'completion-authority-snapshot'
      );
      const workflowState = await first.request(
        'GET',
        `/api/runs/${workflow.run.id}/state`,
        { cookie }
      );
      assert.equal(workflowState.statusCode, 200, workflowState.body);
      const workflowProjection = JSON.parse(workflowState.body);
      assert(workflowProjection.declaredCompletionBinding.criteria.length > 0);
      assert(workflowProjection.declaredCompletionBinding.criteria.every(item =>
        item.authoritySource === 'verification-contract-snapshot'));
      const browserState = await first.request(
        'GET',
        `/api/runs/${browser.run.id}/state`,
        { cookie }
      );
      assert.equal(browserState.statusCode, 200, browserState.body);
      assert.equal(
        JSON.parse(browserState.body).declaredCompletionBinding.criteria.length,
        0,
        'browser evidence does not retroactively create a typed criterion'
      );
      const directPage = await first.request('GET', `/runs/${direct.run.id}`, { cookie });
      assert.equal(directPage.statusCode, 200, directPage.body.slice(0, 1000));
      assert.match(directPage.body, /Declared work/);
      assert.match(directPage.body, /Declarations are not produced evidence/);
      assert.match(directPage.body, /not automatically evaluated/);
      assert.match(directPage.body, /Typed-criterion binding/);
      assert.match(directPage.body, /bound to completion-authority-snapshot/);
      assert.match(directPage.body, /deterministic result shown in the canonical completion decision/);
      const declaredSection = directPage.body.match(
        /<summary>Declared work[\s\S]*?<summary>Work Type Snapshot/
      );
      assert(declaredSection, 'run detail contains a bounded declared-work section');
      assert.match(declaredSection[0], new RegExp(directObjective));
      assert.doesNotMatch(declaredSection[0], new RegExp(`Changed objective ${STAMP}`),
        'current ticket state is not substituted inside admitted run authority');
      const ticketPage = await first.request('GET', `/tickets/${direct.ticket.id}`, { cookie });
      assert.equal(ticketPage.statusCode, 200, ticketPage.body.slice(0, 1000));
      assert.match(ticketPage.body, new RegExp(directObjective));
      assert.match(ticketPage.body, new RegExp(`Changed objective ${STAMP}`));
      assert.match(ticketPage.body, /frozen/);

      const historicalTicket = (await store.createTicketWithEvent({
        ticket: {
          status: 'open',
          objective: `Historical declared work ${STAMP}`,
          assignmentTargetType: 'agent',
          assignmentTargetId: ordinaryAgent.id,
          assignmentMode: 'individual'
        },
        eventPayload: { source: 'declared-work-postgres-test' }
      })).ticket;
      // Model an admitted pre-contract run from immutable run authority that already
      // satisfies the repository's older snapshot contracts. Do not call current
      // admission and then pretend its missing field is historical.
      const historicalInsert = await store.pool.query(
        `INSERT INTO ${store.table('runs')}
          (ticket_id, agent_id, status, execution_mode, current_phase, body)
         SELECT $1, agent_id, 'pending', execution_mode, 'planning',
                body - 'declaredWorkSnapshot'
           FROM ${store.table('runs')}
          WHERE id = $2
         RETURNING id`,
        [historicalTicket.id, direct.run.id]
      );
      assert.equal(historicalInsert.rowCount, 1);
      const historicalRun = await store.getRun(Number(historicalInsert.rows[0].id));
      const historicalState = await first.request(
        'GET',
        `/api/runs/${historicalRun.id}/state`,
        { cookie }
      );
      assert.equal(historicalState.statusCode, 200, historicalState.body);
      assert.equal(
        JSON.parse(historicalState.body).declaredWorkAvailability,
        'historical-unavailable'
      );
      assert.equal(JSON.parse(historicalState.body).declaredCompletionBinding, null);
      const historicalPage = await first.request(
        'GET',
        `/runs/${historicalRun.id}`,
        { cookie }
      );
      assert.match(historicalPage.body, /Current ticket or workflow values are not substituted/);

      const allRuns = [
        direct.run,
        browser.run,
        workflow.run,
        process.run,
        rerun,
        historicalRun
      ];
      for (const item of allRuns) {
        const current = await store.getRun(item.id);
        if (!current || current.status !== 'pending') continue;
        await store.transitionRun({
          runId: current.id,
          expectedRevision: current.revision,
          fromStatuses: ['pending'],
          toStatus: 'interrupted',
          eventType: 'run.interrupted',
          eventPayload: { source: 'declared-work-postgres-test' }
        });
      }

      const second = await startServer(serverEnv);
      const secondCookie = await second.login();
      const [firstRead, secondRead] = await Promise.all([
        first.request('GET', `/api/runs/${direct.run.id}/state`, { cookie }),
        second.request('GET', `/api/runs/${direct.run.id}/state`, { cookie: secondCookie })
      ]);
      assert.equal(firstRead.statusCode, 200, firstRead.body);
      assert.equal(secondRead.statusCode, 200, secondRead.body);
      assert.deepEqual(
        JSON.parse(firstRead.body).declaredWorkSnapshot,
        JSON.parse(secondRead.body).declaredWorkSnapshot,
        'two runtimes reconstruct the identical declaration'
      );
      assert.deepEqual(
        JSON.parse(secondRead.body).declaredWorkSnapshot,
        directSnapshot,
        'restart reconstruction preserves exact authority and hash'
      );
      assert.deepEqual(
        JSON.parse(firstRead.body).declaredCompletionBinding,
        JSON.parse(secondRead.body).declaredCompletionBinding,
        'two runtimes reconstruct the same typed-criterion binding and hash'
      );

      const exposed = JSON.stringify(JSON.parse(secondRead.body).declaredWorkSnapshot);
      for (const forbidden of [
        '/home/',
        'PRIVATE',
        'allowedOrigins',
        'startUrl',
        'processPolicySnapshot',
        'executableIdentity',
        'environment',
        'runtimeBudgetSnapshot'
      ]) {
        assert.equal(exposed.includes(forbidden), false,
          `declared work excludes private runtime data: ${forbidden}`);
      }
    });
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }

  console.log('PASS: declared-work PostgreSQL admission, immutability, reconstruction, and presentation');
}

main().catch(error => {
  console.error(`FAIL: declared-work PostgreSQL — ${error.stack || error.message}`);
  process.exit(1);
});
