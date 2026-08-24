#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  PROCESS_SUPERVISION_VERSION,
  buildProcessSupervisionProjection
} = require('../runtime/process-supervision');

const HASH = 'a'.repeat(64);
const IDENTITY = `process-operation:${'b'.repeat(64)}`;
const OTHER_IDENTITY = `process-operation:${'c'.repeat(64)}`;
const NOW = '2026-07-29T12:00:00.000Z';

function run(overrides = {}) {
  return {
    id: 41,
    ticketId: 17,
    status: 'running',
    processPolicySnapshot: { version: 3 },
    ...overrides
  };
}

function record(overrides = {}) {
  return {
    operationIdentity: IDENTITY,
    targetId: 'local-workspace',
    profileId: 'node-check',
    lifecycleState: 'intent',
    launcherAcceptanceIdentity: null,
    requestedAt: NOW,
    startedAt: null,
    terminalAt: null,
    terminalOutcome: null,
    terminalResultHash: null,
    stdoutArtifact: null,
    stderrArtifact: null,
    requiredEvidenceState: 'pending',
    launcherOutputAcknowledged: false,
    cancellationRequested: false,
    cancellationRequestedAt: null,
    lastReconciliationResult: null,
    ...overrides
  };
}

function event(type, payload = {}) {
  return {
    type,
    ts: NOW,
    payload: {
      operationIdentity: IDENTITY,
      ...payload
    }
  };
}

function receipt(operationIdentity = IDENTITY, overrides = {}) {
  const {
    receipt: receiptOverrides = {},
    ...envelopeOverrides
  } = overrides;
  return {
    operation: 'runProcess',
    idempotencyKey: operationIdentity,
    targetId: 'local-workspace',
    profileId: 'node-check',
    terminalOutcome: 'completed',
    terminalResultHash: HASH,
    ...envelopeOverrides,
    receipt: {
      operationIdentity,
      targetId: 'local-workspace',
      profileId: 'node-check',
      terminalOutcome: 'completed',
      terminalResultHash: HASH,
      ...receiptOverrides
    }
  };
}

function completion(executionDisposition, completionDisposition) {
  return {
    runConsequence: {
      completionDecision: {
        executionDisposition,
        verificationDisposition: executionDisposition === 'succeeded'
          ? 'not_required'
          : 'unavailable',
        completionDisposition,
        reasonCode: completionDisposition === 'completed'
          ? 'OBJECTIVE_COMPLETED'
          : 'OBJECTIVE_INCOMPLETE',
        decisionHash: HASH
      }
    }
  };
}

function project({
  runValue = run(),
  operation = record(),
  operations = null,
  events = [],
  receipts = [],
  observations = []
} = {}) {
  return buildProcessSupervisionProjection({
    run: runValue,
    processOperations: operations === null
      ? operation
        ? [operation]
        : []
      : operations,
    events,
    receipts,
    launcherObservations: observations
  });
}

function lifecycleCases() {
  const terminalRecord = record({
    lifecycleState: 'terminal',
    launcherAcceptanceIdentity: 'launcher-acceptance',
    startedAt: NOW,
    terminalAt: NOW,
    terminalOutcome: 'completed',
    terminalResultHash: HASH,
    requiredEvidenceState: 'complete',
    launcherOutputAcknowledged: true
  });
  return [
    ['intent', project()],
    ['accepted', project({
      operation: record({ launcherAcceptanceIdentity: 'launcher-acceptance' })
    })],
    ['active', project({
      operation: record({
        lifecycleState: 'active',
        launcherAcceptanceIdentity: 'launcher-acceptance'
      }),
      observations: [{
        operationIdentity: IDENTITY,
        availability: 'available',
        state: 'active',
        observedAt: NOW
      }]
    })],
    ['cancellation_requested', project({
      operation: record({
        lifecycleState: 'active',
        launcherAcceptanceIdentity: 'launcher-acceptance',
        cancellationRequested: true,
        cancellationRequestedAt: NOW
      })
    })],
    ['cancelling', project({
      operation: record({
        lifecycleState: 'active',
        launcherAcceptanceIdentity: 'launcher-acceptance',
        cancellationRequested: true,
        cancellationRequestedAt: NOW
      }),
      events: [event('process.cancellation_reached_launcher')]
    })],
    ['finalizing', project({
      operation: record({
        lifecycleState: 'finalizing',
        launcherAcceptanceIdentity: 'launcher-acceptance',
        terminalAt: NOW,
        terminalOutcome: 'completed',
        terminalResultHash: HASH
      }),
      events: [event('process.terminal')]
    })],
    ['terminal', project({
      runValue: run({ status: 'completed', ...completion('succeeded', 'completed') }),
      operation: terminalRecord,
      events: [event('process.terminal')],
      receipts: [receipt()]
    })],
    ['interrupted', project({
      runValue: run({ status: 'interrupted', ...completion('cancelled', 'incomplete') }),
      operation: {
        ...terminalRecord,
        terminalOutcome: 'cancelled',
        cancellationRequested: true,
        cancellationRequestedAt: NOW
      },
      events: [
        event('process.cancellation_requested'),
        event('process.terminal')
      ],
      receipts: [receipt(IDENTITY, {
        terminalOutcome: 'cancelled',
        receipt: { terminalOutcome: 'cancelled' }
      })]
    })],
    ['failed', project({
      runValue: run({
        status: 'failed',
        ...completion('infrastructure_failed', 'blocked')
      }),
      operation: {
        ...terminalRecord,
        terminalOutcome: 'runtime_interrupted'
      },
      events: [event('process.terminal')],
      receipts: [receipt(IDENTITY, {
        terminalOutcome: 'runtime_interrupted',
        receipt: { terminalOutcome: 'runtime_interrupted' }
      })]
    })],
    ['unavailable', project({
      operation: record({
        lifecycleState: 'active',
        launcherAcceptanceIdentity: 'launcher-acceptance'
      }),
      observations: [{
        operationIdentity: IDENTITY,
        availability: 'unavailable',
        diagnosticCode: 'PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE',
        observedAt: NOW
      }]
    })]
  ];
}

function main() {
  assert.strictEqual(
    buildProcessSupervisionProjection({
      run: run({ processPolicySnapshot: null }),
      processOperations: [],
      events: [
        event('authority.denied', { operation: 'writeFile' }),
        event('budget.exhausted', { dimension: 'workspace_operation' })
      ],
      receipts: [],
      launcherObservations: []
    }),
    null,
    'a non-process run does not fabricate process supervision'
  );

  const notStarted = project({ operation: null });
  assert.strictEqual(notStarted.version, PROCESS_SUPERVISION_VERSION);
  assert.strictEqual(notStarted.lifecycleState, 'not_started');

  for (const [expected, projection] of lifecycleCases()) {
    assert.strictEqual(
      projection.lifecycleState,
      expected,
      `${expected} is a distinct supervision lifecycle state`
    );
  }

  const active = lifecycleCases().find(([name]) => name === 'active')[1];
  assert.strictEqual(active.launcherOwnershipState, 'owned_active');
  assert.strictEqual(active.processTreeState, 'active');
  assert.strictEqual(active.operations[0].targetId, 'local-workspace');
  assert.strictEqual(active.operations[0].profileId, 'node-check');
  assert.strictEqual(active.operations[0].operationIdentity, IDENTITY);

  const mismatch = project({
    operation: record({
      lifecycleState: 'active',
      launcherAcceptanceIdentity: 'launcher-acceptance'
    }),
    observations: [{
      operationIdentity: IDENTITY,
      availability: 'available',
      state: 'terminal',
      observedAt: NOW
    }]
  });
  assert.strictEqual(mismatch.lifecycleState, 'unavailable');
  assert.strictEqual(mismatch.launcherOwnershipState, 'mismatch');
  assert.strictEqual(mismatch.reconciliationState, 'pending');

  const unavailable = lifecycleCases()
    .find(([name]) => name === 'unavailable')[1];
  assert.strictEqual(unavailable.processTreeState, 'unknown');
  assert.notStrictEqual(unavailable.processTreeState, 'confirmed_empty');

  const artifact = project({
    runValue: run({ status: 'completed', ...completion('succeeded', 'completed') }),
    operation: record({
      lifecycleState: 'terminal',
      launcherAcceptanceIdentity: 'launcher-acceptance',
      terminalAt: NOW,
      terminalOutcome: 'completed',
      terminalResultHash: HASH,
      requiredEvidenceState: 'complete',
      launcherOutputAcknowledged: true,
      stdoutArtifact: {
        id: 'stdout-artifact',
        path: 'private/process/stdout.bin',
        stream: 'stdout',
        byteCount: 3,
        sha256: HASH
      },
      stderrArtifact: {
        id: 'stderr-artifact',
        path: 'private/process/stderr.bin',
        stream: 'stderr',
        byteCount: 0,
        sha256: HASH
      }
    }),
    events: [event('process.terminal')],
    receipts: [receipt()]
  });
  assert.deepStrictEqual(
    artifact.operations[0].stdoutArtifact,
    {
      artifactId: 'stdout-artifact',
      stream: 'stdout',
      byteCount: 3,
      sha256: HASH,
      publicationState: 'published'
    }
  );
  const serialized = JSON.stringify(artifact);
  for (const prohibited of [
    'private/process',
    'pid',
    'cgroup',
    'executablePath',
    'environment',
    'launchPlan',
    'socketPath'
  ]) {
    assert(!serialized.includes(prohibited),
      `projection excludes private field ${prohibited}`);
  }
  assert(Object.isFrozen(artifact) && Object.isFrozen(artifact.operations[0]),
    'the derived projection is deeply immutable');

  const diagnostics = [
    ['policy_denial', 'PROCESS_SANDBOX_UNAVAILABLE'],
    ['capacity_waiting', 'RUNTIME_CAPACITY_UNAVAILABLE'],
    ['budget_exhaustion', 'RUN_BUDGET_EXHAUSTED'],
    ['containment_failure', 'PROCESS_NAMESPACE_UNAVAILABLE'],
    ['cancellation_failure', 'PROCESS_EXECUTION_CANCELLATION_FAILED'],
    ['artifact_failure', 'PROCESS_OUTPUT_HASH_MISMATCH'],
    ['evidence_failure', 'PROCESS_EXECUTION_EVIDENCE_FAILED'],
    ['recovery_failure', 'PROCESS_EXECUTION_RECONCILIATION_FAILED'],
    ['verification_failure', 'VERIFICATION_FAILED']
  ];
  for (const [category, code] of diagnostics) {
    const classified = project({
      events: [event('process.diagnostic', { code })]
    });
    assert.strictEqual(classified.diagnosticCategory, category);
    assert.strictEqual(classified.diagnosticCode, code);
  }
  const unknownDiagnostic = project({
    events: [event('process.diagnostic', {
      code: 'PROCESS_SUPERVISION_UNCLASSIFIED_FIXTURE'
    })]
  });
  assert.strictEqual(unknownDiagnostic.diagnosticCategory, 'unknown');
  assert.strictEqual(
    unknownDiagnostic.diagnosticCode,
    'PROCESS_SUPERVISION_UNCLASSIFIED_FIXTURE'
  );
  const executionFailure = project({
    operation: record({
      lifecycleState: 'terminal',
      launcherAcceptanceIdentity: 'launcher-acceptance',
      terminalAt: NOW,
      terminalOutcome: 'exited_nonzero',
      terminalResultHash: HASH,
      requiredEvidenceState: 'complete',
      launcherOutputAcknowledged: true
    }),
    events: [event('process.terminal')],
    receipts: [receipt(IDENTITY, {
      terminalOutcome: 'exited_nonzero',
      receipt: { terminalOutcome: 'exited_nonzero' }
    })]
  });
  assert.strictEqual(
    executionFailure.diagnosticCategory,
    'execution_failure'
  );
  const cancellationPending = project({
    operation: record({
      lifecycleState: 'active',
      launcherAcceptanceIdentity: 'launcher-acceptance',
      cancellationRequested: true,
      cancellationRequestedAt: NOW
    })
  });
  assert.strictEqual(
    cancellationPending.diagnosticCategory,
    'cancellation_pending'
  );
  const objectiveIncomplete = project({
    runValue: run({
      status: 'completed',
      ...completion('succeeded', 'incomplete')
    }),
    operation: null
  });
  assert.strictEqual(
    objectiveIncomplete.diagnosticCategory,
    'objective_incomplete'
  );
  assert.strictEqual(
    project({
      runValue: run({
        status: 'completed',
        ...completion('succeeded', 'completed')
      }),
      operation: null
    }).diagnosticCategory,
    'completed'
  );

  const receiptConflict = project({
    runValue: run({
      status: 'completed',
      ...completion('succeeded', 'completed')
    }),
    operation: {
      ...record(),
      lifecycleState: 'terminal',
      launcherAcceptanceIdentity: 'launcher-acceptance',
      terminalAt: NOW,
      terminalOutcome: 'completed',
      terminalResultHash: HASH,
      requiredEvidenceState: 'complete',
      launcherOutputAcknowledged: true
    },
    events: [event('process.terminal')],
    receipts: [{
      ...receipt(IDENTITY, {
        receipt: { terminalResultHash: 'd'.repeat(64) }
      })
    }]
  });
  assert.strictEqual(receiptConflict.lifecycleState, 'unavailable');
  assert.strictEqual(
    receiptConflict.diagnosticCode,
    'PROCESS_EXECUTION_STATE_INVALID'
  );

  const terminalReceiptRecord = {
    ...record(),
    lifecycleState: 'terminal',
    launcherAcceptanceIdentity: 'launcher-acceptance',
    startedAt: NOW,
    terminalAt: NOW,
    terminalOutcome: 'completed',
    terminalResultHash: HASH,
    terminalResult: {
      outputComplete: true
    },
    stdoutArtifact: {
      id: 'receipt-stdout',
      stream: 'stdout',
      byteCount: 0,
      sha256: HASH
    },
    stderrArtifact: {
      id: 'receipt-stderr',
      stream: 'stderr',
      byteCount: 0,
      sha256: HASH
    },
    requiredEvidenceState: 'complete',
    launcherOutputAcknowledged: true
  };
  const terminalReceiptRun = run({
    status: 'completed',
    ...completion('succeeded', 'completed')
  });
  const terminalReceiptEvents = [event('process.terminal')];
  const missingReceipt = project({
    runValue: terminalReceiptRun,
    operation: terminalReceiptRecord,
    events: terminalReceiptEvents,
    receipts: []
  });
  assert.strictEqual(missingReceipt.finalizationState, 'pending');
  assert.strictEqual(missingReceipt.lifecycleState, 'finalizing');
  assert.strictEqual(missingReceipt.reconciliationState, 'pending');
  assert.strictEqual(
    missingReceipt.diagnosticCategory,
    'recovery_failure'
  );
  assert.strictEqual(
    missingReceipt.diagnosticCode,
    'PROCESS_OPERATION_RECEIPT_MISSING'
  );
  assert.strictEqual(
    missingReceipt.operations[0].terminalResultHash,
    HASH,
    'missing receipt preserves authoritative terminal facts'
  );

  const exactReceipt = project({
    runValue: terminalReceiptRun,
    operation: terminalReceiptRecord,
    events: terminalReceiptEvents,
    receipts: [receipt()]
  });
  assert.strictEqual(exactReceipt.finalizationState, 'complete');
  assert.strictEqual(exactReceipt.lifecycleState, 'terminal');
  assert.strictEqual(exactReceipt.diagnosticCode, 'OBJECTIVE_COMPLETED');

  const anotherOperationReceipt = project({
    runValue: terminalReceiptRun,
    operation: terminalReceiptRecord,
    events: terminalReceiptEvents,
    receipts: [receipt(OTHER_IDENTITY)]
  });
  assert.strictEqual(
    anotherOperationReceipt.diagnosticCode,
    'PROCESS_OPERATION_RECEIPT_MISSING',
    'a receipt for another operation cannot satisfy this operation'
  );

  const otherTerminalRecord = {
    ...terminalReceiptRecord,
    operationIdentity: OTHER_IDENTITY,
    requestedAt: '2026-07-29T12:00:01.000Z'
  };
  const multiOperation = buildProcessSupervisionProjection({
    run: terminalReceiptRun,
    processOperations: [terminalReceiptRecord, otherTerminalRecord],
    events: [
      event('process.terminal'),
      event('process.terminal', { operationIdentity: OTHER_IDENTITY })
    ],
    receipts: [receipt()],
    launcherObservations: []
  });
  assert.strictEqual(multiOperation.operations[0].lifecycleState, 'terminal');
  assert.strictEqual(
    multiOperation.operations[1].lifecycleState,
    'finalizing'
  );
  assert.strictEqual(
    multiOperation.operations[1].diagnosticCode,
    'PROCESS_OPERATION_RECEIPT_MISSING'
  );
  assert.strictEqual(
    multiOperation.lifecycleState,
    'finalizing',
    'one exact receipt cannot finalize two process operations'
  );

  const crossBoundReceipt = receipt(IDENTITY, {
    receipt: { operationIdentity: OTHER_IDENTITY }
  });
  const crossBound = buildProcessSupervisionProjection({
    run: terminalReceiptRun,
    processOperations: [terminalReceiptRecord, otherTerminalRecord],
    events: [
      event('process.terminal'),
      event('process.terminal', { operationIdentity: OTHER_IDENTITY })
    ],
    receipts: [crossBoundReceipt],
    launcherObservations: []
  });
  assert(crossBound.operations.every(operation =>
    operation.lifecycleState === 'unavailable' &&
    operation.diagnosticCode === 'PROCESS_EXECUTION_STATE_INVALID'),
  'conflicting identity locations cannot let one receipt satisfy two operations');
  assert.strictEqual(crossBound.lifecycleState, 'unavailable');
  assert.notStrictEqual(
    missingReceipt.diagnosticCode,
    receiptConflict.diagnosticCode,
    'receipt absence remains distinct from receipt contradiction'
  );

  const unprovedCancellation = project({
    runValue: run({
      status: 'interrupted',
      ...completion('cancelled', 'incomplete')
    }),
    operation: {
      ...record(),
      lifecycleState: 'terminal',
      launcherAcceptanceIdentity: 'launcher-acceptance',
      terminalAt: NOW,
      terminalOutcome: 'cancelled',
      terminalResultHash: HASH,
      requiredEvidenceState: 'complete',
      launcherOutputAcknowledged: true,
      cancellationRequested: true,
      cancellationRequestedAt: NOW
    }
  });
  assert.strictEqual(unprovedCancellation.lifecycleState, 'finalizing');
  assert.strictEqual(unprovedCancellation.cancellationState, 'unavailable');
  assert.strictEqual(
    unprovedCancellation.diagnosticCode,
    'PROCESS_OPERATION_TERMINATION_FAILED'
  );

  const historical = project({
    runValue: run({ processPolicySnapshot: { version: 2 }, status: 'failed' }),
    operation: null
  });
  assert.strictEqual(historical.availability, 'historical');
  assert.match(historical.historicalCompatibility, /historical process lifecycle/);

  const replayInputs = {
    runValue: run({ status: 'completed', ...completion('succeeded', 'completed') }),
    operation: {
      ...record(),
      lifecycleState: 'terminal',
      launcherAcceptanceIdentity: 'launcher-acceptance',
      terminalAt: NOW,
      terminalOutcome: 'completed',
      terminalResultHash: HASH,
      requiredEvidenceState: 'complete',
      launcherOutputAcknowledged: true
    },
    events: [event('process.terminal')],
    receipts: [receipt()]
  };
  const replayed = project(replayInputs);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(replayed)),
    JSON.parse(JSON.stringify(project(replayInputs))),
    'the same durable authority reconstructs the same projection'
  );

  const serverSource = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'),
    'utf8'
  );
  const viewSource = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'run-detail.ejs'),
    'utf8'
  );
  const supervisionSource = fs.readFileSync(
    path.join(__dirname, '..', 'runtime', 'process-supervision.js'),
    'utf8'
  );
  assert(
    /processExecutionController\.cancelRunOperations\(run, reason\)/.test(
      serverSource
    ),
    'the public cancellation seam delegates to the canonical controller'
  );
  assert.match(serverSource, /Run cancellation accepts no request fields/);
  const stopRouteSource = serverSource.slice(
    serverSource.indexOf("fastify.post('/api/runs/:id/stop'"),
    serverSource.indexOf("fastify.post('/api/runs/:id/retry'")
  );
  assert(!/request\.body\.(?:pid|signal|command|cgroup|path|executable|arguments|environment|containment)/.test(
    stopRouteSource
  ), 'the cancellation route accepts no direct process-control authority');
  assert(!viewSource.includes('stdout content') &&
    !viewSource.includes('stderr content') &&
    !viewSource.includes('stdoutContent') &&
    !viewSource.includes('stderrContent') &&
    !viewSource.includes('artifact.content'),
  'the supervision view does not render raw process output');
  assert(!serverSource.includes("fastify.post('/process-control"),
    'no second process-control backend exists');
  assert(!/cancelOperation|getOperation|launcher\.sock/.test(viewSource),
    'the operator UI has no direct launcher authority');
  assert(!/\bnew Map\b|process(?:Operation)?Registry\s*=/.test(
    supervisionSource
  ),
    'the derived projection introduces no process-local lifecycle registry');
  assert.match(
    supervisionSource,
    /const receiptComplete = Boolean\(receipt\) && !receiptMismatch;/
  );
  const terminalFinalizationSource = supervisionSource.slice(
    supervisionSource.indexOf("if (record.lifecycleState === 'finalizing')"),
    supervisionSource.indexOf('let lifecycleState;')
  );
  assert(
    /receiptComplete/.test(terminalFinalizationSource),
    'complete finalization requires the exact canonical process receipt'
  );
  const migrations = fs.readdirSync(
    path.join(__dirname, '..', 'persistence', 'postgres', 'migrations')
  );
  // The canonical Ticket-cancellation AUTHORITY substrate (migration 040) is
  // product authority, not a supervision shadow table; every OTHER migration
  // name must stay free of supervision/lifecycle/control vocabulary.
  assert(!migrations.some(file => file !== '040_ticket_cancellation_authority.sql' &&
    /supervision|process_control|cancellation/i.test(file)),
    'supervision adds no shadow lifecycle, cancellation, or control table');

  console.log('PASS: process supervision projection contract');
}

main();
