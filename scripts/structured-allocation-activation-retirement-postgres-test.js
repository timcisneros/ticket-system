#!/usr/bin/env node
'use strict';

// Post-Tranche-6 product boundary.
//
// The persistence/contracts beneath this test deliberately remain capable of
// reconstructing historical structured authority. The product HTTP boundary,
// however, may no longer mint that authority or change the planner designation
// that used to activate it. General v1 group allocation must remain available.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withHarness } = require('./postgres-test-harness');

const STAMP = `${Date.now()}-${process.pid}`;
const ACTOR = 'structured-allocation-activation-retirement-test';

function parentDeclaredWork(objective) {
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One report per assigned owner' }],
    successCriteria: [{ kind: 'text', declaration: 'Every report is complete' }],
    evidenceRequirements: []
  };
}

async function main() {
  await withHarness('structured allocation activation retirement', async ({
    store, workspaceRoot, startServer
  }) => {
    let passed = 0;
    const check = (condition, message) => {
      assert.ok(condition, message);
      passed += 1;
      console.log(`  ok ${passed} - ${message}`);
    };

    const group = (await store.createGroup({
      value: { name: `Retired Structured ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const planner = (await store.createConfiguredAgent({
      value: {
        name: `Historical Planner ${STAMP}`,
        provider: 'ollama',
        model: 'historical-planner-model',
        baseUrl: 'http://127.0.0.1:1'
      },
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;
    const worker = (await store.createConfiguredAgent({
      value: {
        name: `General Worker ${STAMP}`,
        provider: 'ollama',
        model: 'general-worker-model',
        baseUrl: 'http://127.0.0.1:1'
      },
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;
    const designated = (await store.updateGroup({
      groupId: group.id,
      expectedRevision: group.revision,
      value: { ...group, plannerAgentId: planner.id },
      changedBy: ACTOR
    })).group;

    const ownedOutputPaths = {
      [planner.id]: 'reports/planner/',
      [worker.id]: 'reports/worker/'
    };
    for (const owned of Object.values(ownedOutputPaths)) {
      fs.mkdirSync(path.join(workspaceRoot, owned), { recursive: true });
    }

    const server = await startServer({ env: {
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      // An inherited historical-evaluation namespace must never turn this
      // product-boundary test into an evaluation fixture.
      EVALUATION_FIXTURE_NAMESPACE: ''
    } });
    const cookie = await server.login();

    const home = await server.request('GET', '/', { cookie });
    check(home.statusCode === 200, 'ticket creation page renders');
    check(!/name="declaredWork"/.test(home.body),
      'ticket creation exposes no structured parent-authority control');

    const groupForm = await server.request('GET', `/admin/groups/${designated.id}/edit`, { cookie });
    check(groupForm.statusCode === 200, 'group edit page renders');
    check(!/name="plannerAgentId"/.test(groupForm.body),
      'group edit exposes no planner-designation control');
    check(/Historical designation:[\s\S]*read-only/i.test(groupForm.body),
      'an existing planner designation remains inspectable as historical data');

    const plannerChange = await server.request('POST', `/admin/groups/${designated.id}`, {
      cookie,
      form: {
        name: designated.name,
        canReceiveTickets: 'on',
        revision: String(designated.revision),
        plannerAgentId: String(worker.id)
      }
    });
    check(plannerChange.statusCode === 400,
      'the product boundary refuses a new planner designation');
    check(/planner designation is retired/i.test(plannerChange.body),
      'the planner refusal names the retired activation surface');
    let storedGroup = await store.getGroupById(designated.id);
    check(storedGroup.plannerAgentId === planner.id,
      'a refused planner edit preserves the historical designation');

    const ordinaryGroupEdit = await server.request('POST', `/admin/groups/${designated.id}`, {
      cookie,
      form: {
        name: `${designated.name} renamed`,
        canReceiveTickets: 'on',
        revision: String(designated.revision)
      }
    });
    check(ordinaryGroupEdit.statusCode === 302,
      'an unrelated group edit remains available');
    storedGroup = await store.getGroupById(designated.id);
    check(storedGroup.plannerAgentId === planner.id,
      'an unrelated edit does not erase historical planner data');

    const structuredObjective = `Create retired structured reports ${STAMP}`;
    const structured = await server.request('POST', '/tickets', {
      cookie,
      form: {
        objective: structuredObjective,
        declaredWork: JSON.stringify(parentDeclaredWork(structuredObjective)),
        assignmentTargetType: 'group',
        assignmentTargetId: String(designated.id),
        assignmentMode: 'allocated',
        capabilityType: 'directAction',
        executionTargetKind: 'workspace',
        ownedOutputPaths: JSON.stringify(ownedOutputPaths)
      }
    });
    check(structured.statusCode === 400,
      'new structured parent authority is refused before Ticket creation');
    check(/first-class structured planner\/leaf product path is retired/i.test(structured.body),
      'the Ticket refusal names the post-Tranche-6 boundary');
    const rejectedTickets = (await store.listTickets({ limit: 500 })).tickets
      .filter(ticket => ticket.objective === structuredObjective);
    check(rejectedTickets.length === 0,
      'the refusal mints no Ticket and therefore no structured authority');
    check((await store.listAllocationPlans({ limit: 500 })).plans.length === 0,
      'the refusal admits no v2 plan and performs no v1 fallback');
    check((await store.listRuns({ limit: 500 })).runs.length === 0,
      'the refusal admits no planner or leaf Run');

    const v1Objective = `Create folders reports/planner and reports/worker ${STAMP}`;
    const general = await server.request('POST', '/tickets', {
      cookie,
      form: {
        objective: v1Objective,
        assignmentTargetType: 'group',
        assignmentTargetId: String(designated.id),
        assignmentMode: 'allocated',
        capabilityType: 'directAction',
        executionTargetKind: 'workspace',
        ownedOutputPaths: JSON.stringify(ownedOutputPaths)
      }
    });
    check(general.statusCode === 302,
      'general allocated Ticket creation remains available');
    const v1Ticket = (await store.listTickets({ limit: 500 })).tickets
      .find(ticket => ticket.objective === v1Objective);
    check(Boolean(v1Ticket), 'general allocation persists a normal Ticket');
    check(!Object.prototype.hasOwnProperty.call(v1Ticket, 'structuredAllocationAuthority'),
      'general allocation does not mint retired structured authority');
    const plans = (await store.listAllocationPlans({ ticketId: v1Ticket.id, limit: 20 })).plans;
    check(plans.length === 1 && !Object.prototype.hasOwnProperty.call(plans[0], 'version'),
      'general allocation still admits one historical-v1-shape Allocation Plan');
    const runs = (await store.listRunsForTicket({ ticketId: v1Ticket.id, limit: 20 })).runs;
    check(runs.length === 2, 'general allocation still admits one Run per group member');
    check(runs.every(run => !run.leafRunBinding && !run.governedExecution),
      'general allocated Runs remain topology-neutral normal Runs');

    console.log(`structured allocation activation retirement PostgreSQL test passed — ${passed}/${passed}`);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
