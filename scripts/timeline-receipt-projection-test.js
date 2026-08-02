#!/usr/bin/env node
'use strict';
// Timeline receipt, triage and provenance projection — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Completes the migration of `ticket-timeline-authority-visibility-test.js`. Its
// authority half moved to `timeline-authority-evidence-test.js`; this is the remaining
// half — operation receipts, triage projection, and process-template provenance.
//
// THE CENTRAL CONTRACT IS DEDUPLICATION, and it exists because the SAME operation is
// durably recorded in TWO places: the append-only `workspace.operation` event and the
// run's replay snapshot `workspaceOperations`. Both are authoritative for different
// questions, and both survive a crash. The timeline folds them into one entry per real
// operation, keyed on history id and an evidence key.
//
// If that folding breaks, the timeline double-reports every operation the run performed.
// An operator counting reads or writes off the timeline — or auditing what an agent
// touched — sees twice the activity that occurred, with no indication which half is
// real. That is a truthfulness failure, not a cosmetic one.
//
// THE POSITIVE CONTROL IS LOAD-BEARING. "Renders once" is trivially satisfied by a
// projection that drops receipts entirely, so scenario 2 requires two GENUINELY distinct
// operations to render as two entries. Scenario 3 pairs a receipted read with an
// unreceipted one and requires DIFFERENT source labels, proving the label is derived
// from the evidence rather than being a constant.
//
// `legacyUnversioned` provenance is NOT migrated: the mechanism is gone. The runtime now
// REFUSES a process-template source lacking `templateVersion` with a data-integrity
// error instead of rendering it "safely". Scenario 6 pins that replacement behaviour, so
// the retirement is evidence-backed rather than an omission.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

function parse(body) {
  try { return JSON.parse(body); } catch (_) { return {}; }
}

async function main() {
  await withHarness('timeline receipt projection', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `TimelineReceipt-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'timeline-receipt-projection-test'
    })).agent;

    const now = () => new Date().toISOString();
    async function makeTicket(label, extra = {}) {
      return (await store.createTicketWithEvent({
        ticket: {
          objective: `timeline receipt ${label} ${STAMP}`, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: { mode: 'assisted', requireVerification: 'when_declared' },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status: 'in_progress', createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now(), ...extra
        },
        eventPayload: { source: 'timeline-receipt-projection-test' }
      })).ticket;
    }

    // Established A10 fixture pattern: create → claim → running → terminal.
    async function makeRun(ticketId) {
      const created = await store.createRun({
        ticketId, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: {}, status: 'pending'
      });
      const claim = await store.claimPendingRun({
        leaseOwner: 'timeline-fixture', leaseDurationMs: 60000, eligibleRunIds: [created.id]
      });
      const started = await store.transitionRun({
        runId: created.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
        toStatus: 'running', leaseOwner: 'timeline-fixture', eventType: 'run.started'
      });
      await store.transitionRun({
        runId: created.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
        toStatus: 'completed', leaseOwner: 'timeline-fixture', eventType: 'run.execution_completed',
        patch: { completedAt: now() }, eventPayload: { status: 'completed' }
      });
      return store.getRun(created.id);
    }

    const READ_TS = '2026-03-01T10:00:00.000Z';
    const readReceipt = (path, historyId) => ({
      operationId: historyId,
      targetId: 'main', targetKind: 'workspace',
      targetPath: path, timestamp: READ_TS,
      metadata: { contentHash: `read-hash-${path}`, size: 42 }
    });

    const ticket = await makeTicket('receipts');
    const run = await makeRun(ticket.id);

    // The SAME read, recorded in BOTH durable sources — exactly as a real run does.
    // Matching historyId and evidence key is what the projection must fold on.
    await store.appendEvent({
      type: 'workspace.operation', ticketId: ticket.id, runId: run.id,
      payload: {
        operation: 'readFile', path: 'shared-read.txt', historyId: 4001,
        targetId: 'main', targetKind: 'workspace',
        readReceipt: readReceipt('shared-read.txt', 4001),
        result: { historyId: 4001 }
      }
    });
    // A second, genuinely DIFFERENT read — the positive control for scenario 2.
    await store.appendEvent({
      type: 'workspace.operation', ticketId: ticket.id, runId: run.id,
      payload: {
        operation: 'listDirectory', path: 'other-dir', historyId: 4002,
        targetId: 'main', targetKind: 'workspace',
        readReceipt: readReceipt('other-dir', 4002),
        result: { historyId: 4002 }
      }
    });
    // A read with NO receipt — negative control for the source label.
    await store.appendEvent({
      type: 'workspace.operation', ticketId: ticket.id, runId: run.id,
      payload: {
        operation: 'readFile', path: 'unreceipted.txt', historyId: 4003,
        result: { historyId: 4003 }
      }
    });

    await store.initializeRunReplay({
      runId: run.id, ticketId: ticket.id,
      snapshot: {
        version: 1, runId: run.id, ticketId: ticket.id, terminalStatus: 'completed',
        providerRequests: [], modelResponses: [], events: [],
        workspaceOperations: [
          // The SAME operation as the first event. Must fold, not duplicate.
          {
            operation: { operation: 'readFile', args: { path: 'shared-read.txt' } },
            historyId: 4001, startedAt: READ_TS,
            readReceipt: readReceipt('shared-read.txt', 4001)
          },
          // Replay-only read: present in replay but never evented. Must still render,
          // otherwise evidence that exists only in replay would be invisible.
          {
            operation: { operation: 'readFile', args: { path: 'replay-only.txt' } },
            historyId: 4004, startedAt: READ_TS,
            readReceipt: readReceipt('replay-only.txt', 4004)
          }
        ]
      }
    });

    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
    const cookie = await server.login();
    const timelineOf = async ticketId => {
      const response = await server.request('GET', `/api/tickets/${ticketId}/timeline`, { cookie });
      return { response, entries: parse(response.body).entries || [] };
    };

    const { response, entries } = await timelineOf(ticket.id);
    assert(response.statusCode === 200, `timeline answered (HTTP ${response.statusCode})`);
    const reads = entries.filter(entry => entry.type === 'target.read');

    // ── 1. One real operation, two durable sources, ONE entry ───────────────
    scenariosRun += 1;
    const shared = reads.filter(entry => entry.details && entry.details.path === 'shared-read.txt');
    assert(shared.length === 1,
      `1: an operation recorded in BOTH the event journal and replay renders exactly once (${shared.length})`);
    assert(shared[0].details.receipt && shared[0].details.receipt.operationId === 4001,
      '1: and the surviving entry keeps the receipt identity that made them the same operation');

    // ── 2. POSITIVE CONTROL — distinct operations are NOT folded together ───
    // Without this, scenario 1 is satisfied by a projection that drops reads.
    scenariosRun += 1;
    assert(reads.length === 4,
      `2: four genuinely distinct reads render as four entries (${reads.length}: ${reads.map(r => r.details.path).join(', ')})`);
    const paths = reads.map(entry => entry.details.path).sort();
    assert(JSON.stringify(paths) === JSON.stringify(
      ['other-dir', 'replay-only.txt', 'shared-read.txt', 'unreceipted.txt']),
      `2: each distinct operation is present exactly once (${paths.join(', ')})`);
    assert(reads.some(entry => entry.details.path === 'replay-only.txt'),
      '2: evidence that exists only in replay is still projected, not lost to the fold');

    // ── 3. Source labels are DERIVED from the evidence, not constant ────────
    scenariosRun += 1;
    const receipted = reads.find(entry => entry.details.path === 'shared-read.txt');
    const unreceipted = reads.find(entry => entry.details.path === 'unreceipted.txt');
    assert(receipted.sourceRole === 'embedded_receipt',
      `3: a read backed by a receipt is labelled embedded_receipt (${receipted.sourceRole})`);
    assert(unreceipted.sourceRole !== 'embedded_receipt',
      `3: a read WITHOUT a receipt is labelled differently, so the label is derived (${unreceipted.sourceRole})`);
    assert(receipted.details.receipt.metadata.contentHash === 'read-hash-shared-read.txt',
      `3: the receipt's content hash survives projection (${JSON.stringify(receipted.details.receipt.metadata)})`);
    assert(receipted.details.receipt.metadata.size === 42,
      '3: as does its size — receipt metadata is preserved, not summarized away');
    assert(unreceipted.details.receipt === null,
      '3: an unreceipted read claims no receipt rather than inventing an empty one');

    // ── 4. Committed mutations project their operation-history receipt ──────
    scenariosRun += 1;
    const mutationTicket = await makeTicket('mutation');
    const mutationRun = await makeRun(mutationTicket.id);
    const recorded = await store.recordOperationReceipt({
      runId: mutationRun.id,
      idempotencyKey: `timeline-receipt-${STAMP}`,
      operation: 'writeFile',
      outcome: 'succeeded',
      workspacePath: `receipt-${STAMP}.txt`,
      // The store requires a fingerprint for workspace receipts, so a projection can
      // never claim a committed mutation it cannot identify.
      mutationFingerprint: `writeFile:receipt-${STAMP}.txt`,
      receipt: {
        targetId: 'main', targetKind: 'workspace',
        targetPath: `receipt-${STAMP}.txt`, timestamp: now(),
        createdResources: [`receipt-${STAMP}.txt`]
      }
    });
    const historyId = recorded && recorded.record ? recorded.record.id : null;
    assert(historyId, `4: the operation receipt was recorded (${JSON.stringify(recorded && recorded.record)})`);
    const mutationEntries = (await timelineOf(mutationTicket.id)).entries;
    const committed = mutationEntries.filter(entry => entry.sourceType === 'operation_history');
    assert(committed.length === 1,
      `4: a committed mutation projects exactly one operation-history entry (${committed.length})`);
    assert(committed[0].sourceRole === 'operation_history',
      `4: labelled by the authority it came from (${committed[0].sourceRole})`);
    // Asserted on `historyId`, which the PROJECTION derives from the durable record, not
    // on `receipt.operationId`, which is only whatever the caller placed in the receipt
    // document. The former is the link an auditor can follow back to the ledger.
    assert(committed[0].details.historyId === historyId,
      `4: carrying the durable operation id that links it back to the receipt ledger ` +
      `(${committed[0].details.historyId} vs ${historyId})`);
    assert(committed[0].details.path === `receipt-${STAMP}.txt`,
      `4: naming the exact path the receipt covers (${committed[0].details.path})`);
    assert(committed[0].details.operation === 'writeFile',
      `4: and the operation it recorded (${committed[0].details.operation})`);
    assert(committed[0].details.committed === true,
      '4: a succeeded receipt is projected as committed');

    // ── 5. Triage projects at both ticket and run level ─────────────────────
    scenariosRun += 1;
    const triageTicket = await makeTicket('triage');
    const triageRun = await makeRun(triageTicket.id);
    await store.createRunTriage({
      runId: triageRun.id,
      triage: {
        required: true, reasonCode: 'verification_failed', requiredDecision: 'review_failure',
        allowedActions: ['review'], prohibitedActions: ['automatic_retry']
      }
    });
    const triageEntriesBefore = (await timelineOf(triageTicket.id)).entries;
    const required = triageEntriesBefore.filter(entry => entry.type === 'triage.required');
    assert(required.length >= 1,
      `5: an unresolved triage appears on the timeline (${required.length})`);
    assert(required.some(entry => entry.details && entry.details.reasonCode === 'verification_failed'),
      '5: naming why review is required, not merely that it is');

    await store.resolveRunTriage({
      runId: triageRun.id, resolution: 'reviewed', resolvedBy: 'admin'
    });
    const triageEntriesAfter = (await timelineOf(triageTicket.id)).entries;
    const resolved = triageEntriesAfter.find(entry => entry.type === 'triage.resolved');
    assert(resolved,
      `5: resolving triage projects a resolution entry (${triageEntriesAfter.map(e => e.type).join(', ')})`);
    // The load-bearing detail: resolving triage must NOT be read as changing the run's
    // outcome. A reviewed failure is still a failure.
    assert(resolved.details && resolved.details.statusUnchangedByResolution === true,
      `5: and states explicitly that resolution did not change the run's status ` +
      `(${JSON.stringify(resolved.details && resolved.details.statusUnchangedByResolution)})`);
    assert(resolved.runId === triageRun.id,
      '5: attributed to the run that required review');

    // ── 6. Provenance is versioned, and unbacked provenance is impossible ───
    // Built from a REAL template trigger rather than a synthetic ticket source, because
    // the store enforces a foreign key from the ticket to the trigger that produced it.
    // That constraint is why the historical `legacyUnversioned` assertion is retired
    // rather than migrated: an unversioned, unbacked template source cannot be created
    // at all now, so "renders safely" describes a state the runtime no longer permits.
    scenariosRun += 1;
    const templateResponse = await server.request('POST', '/api/process-templates', {
      cookie,
      body: {
        name: `Timeline provenance ${STAMP}`,
        ticketTemplate: {
          objective: `timeline provenance generated ${STAMP}`,
          capabilityType: 'directAction',
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual'
        }
      }
    });
    assert(templateResponse.statusCode === 200,
      `6: the process template was created (HTTP ${templateResponse.statusCode}: ${String(templateResponse.body).slice(0, 160)})`);
    const templateId = parse(templateResponse.body).template.id;

    const triggerToken = `timeline-provenance-${STAMP}`;
    const fired = await server.request('POST', `/api/process-templates/${templateId}/trigger`, {
      cookie, body: { triggerToken }
    });
    assert(fired.statusCode === 200 && parse(fired.body).ticketId,
      `6: triggering it created a ticket (HTTP ${fired.statusCode}: ${String(fired.body).slice(0, 160)})`);
    const generatedTicketId = parse(fired.body).ticketId;

    const provenanceEntries = (await timelineOf(generatedTicketId)).entries;
    const provenance = provenanceEntries.find(entry => entry.type === 'ticket.provenance');
    assert(provenance,
      `6: a template-created ticket shows its provenance (${provenanceEntries.map(e => e.type).join(', ')})`);
    assert(Number.isSafeInteger(provenance.details.templateVersion) && provenance.details.templateVersion > 0,
      `6: naming the template VERSION it was created from (${JSON.stringify(provenance.details.templateVersion)})`);
    assert(provenance.details.templateId === templateId,
      `6: and the template itself (${provenance.details.templateId} vs ${templateId})`);
    assert(provenance.details.triggerType === 'manual' && provenance.details.triggerToken === triggerToken,
      `6: with the exact trigger that produced it (${provenance.details.triggerType}, ${provenance.details.triggerToken})`);
    assert(provenance.sourceRole === 'provenance',
      `6: labelled as provenance rather than as runtime evidence (${provenance.sourceRole})`);

    // NEGATIVE CONTROL: provenance cannot be fabricated. A ticket claiming a template
    // source with no backing trigger is refused by the store, so the timeline never has
    // to decide whether to trust it.
    let fabricationError = null;
    try {
      await makeTicket('provenance-fabricated', {
        source: { type: 'process_template', templateId: 999999, templateName: 'Ghost', triggerType: 'manual' }
      });
    } catch (error) {
      fabricationError = error;
    }
    assert(fabricationError,
      '6: a ticket claiming template provenance with no backing trigger is REFUSED at the store');
    assert(/foreign key|constraint|trigger/i.test(String(fabricationError.message)),
      `6: by referential integrity, not by a render-time guess (${String(fabricationError.message).slice(0, 120)})`);

    assertScenariosExecuted({
      label: 'timeline receipt projection',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 26,
      minScenarios: 6
    });
    console.log(`\nPASS: timeline receipt projection — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'timeline_receipt' });
}

main().catch(error => {
  console.error(`\nFAIL: timeline receipt projection — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
