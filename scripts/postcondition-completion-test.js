#!/usr/bin/env node
'use strict';
// Postcondition-based completion, workflow-draft intents, and handoff tasks —
// PostgreSQL-native (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Twenty scenarios, ported one-for-one from the JSON-era original against the
// inventory recorded in A10. Each keeps its own server restart, its own runtime
// budget, its own objective and provider-response branch, and the exact negative
// regression it guards. They are deliberately NOT collapsed into shared
// assertions: scenarios 1-8 cover postcondition completion, 9-15 cover workflow
// draft intents, 16-18 cover handoff tasks, 19 covers draft rejection, and 20
// covers compiled partial completion.
//
// Repaired, not rewritten. The provider preload (21 objective branches) and every
// scenario body are preserved verbatim from the original; only the storage layer
// changed. Seeding, run/ticket/workflow lookups, and event waits now go through
// the PostgreSQL store via scripts/postgres-test-harness.js instead of a DATA_DIR
// of JSON files the server no longer reads.
//
// AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT and ENABLE_MODEL_CONTRACT_COMPILER are
// baseline environment for every scenario, as in the original.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const STAMP = Date.now();
const assert = createAsserter();

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `postcondition-openai-${process.pid}-${Date.now()}.js`);
  const source = [
    "const responseCounts = new Map();",
    "",
    "function nextCount(key) {",
    "  const count = (responseCounts.get(key) || 0) + 1;",
    "  responseCounts.set(key, count);",
    "  return count;",
    "}",
    "",
    "function okResponse(plan) {",
    "  return {",
    "    ok: true,",
    "    status: 200,",
    "    headers: new Map([['x-request-id', 'fake-postcondition-request']]),",
    "    async text() {",
    "      return JSON.stringify({",
    "        output_text: JSON.stringify(plan),",
    "        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }",
    "      });",
    "    }",
    "  };",
    "}",
    "",
    "global.fetch = async function(url, options = {}) {",
    "  const body = JSON.parse(options.body || '{}');",
    "  const input = Array.isArray(body.input) ? body.input : [];",
    "  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');",
    "",
    "  await new Promise(resolve => setTimeout(resolve, 50));",
    "",
    "  // Preflight contract compiler: one scenario uses a strict two-target",
    "  // contract; all others fall back so their execution counters stay aligned.",
    "  if (combined.includes('objective compiler')) {",
    "    const userContent = input.filter(item => item && item.role === 'user').map(item => String(item.content || '')).join(' ');",
    "    if (userContent.includes('compiled-partial-completion')) {",
    "      return okResponse({ intent: 'create_folders', targetRoot: '', targets: ['compiled-A', 'compiled-B'] });",
    "    }",
    "    return okResponse({",
    "      intent: 'model_driven',",
    "      targetRoot: '',",
    "      targets: []",
    "    });",
    "  }",
    "",
    "  if (combined.includes('compiled-partial-completion')) {",
    "    const count = nextCount('compiled-partial-completion');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating only the first contracted folder.',",
    "        actions: [{ operation: 'createFolder', args: { path: 'compiled-A' } }],",
    "        complete: true",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Creating the remaining contracted folder.',",
    "      actions: [{ operation: 'createFolder', args: { path: 'compiled-B' } }],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-create-folder-file')) {",
    "    const count = nextCount('create-folder-file');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating folder and file.',",
    "        actions: [",
    "          { operation: 'createFolder', args: { path: 'pc-folder' } },",
    "          { operation: 'writeFile', args: { path: 'pc-folder/file.txt', content: 'hello' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Ensuring folder and file exist.',",
    "      actions: [",
    "        { operation: 'createFolder', args: { path: 'pc-folder' } },",
    "        { operation: 'writeFile', args: { path: 'pc-folder/file.txt', content: 'hello' } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-repeated-write')) {",
    "    const timeoutAvoided = combined.includes('timeout-avoided');",
    "    const targetPath = timeoutAvoided ? 'pc-timeout-file.txt' : 'pc-file.txt';",
    "    const count = nextCount(timeoutAvoided ? 'repeated-write-timeout' : 'repeated-write');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Writing file.',",
    "        actions: [",
    "          { operation: 'writeFile', args: { path: targetPath, content: 'same-content' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Ensuring file exists.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: targetPath, content: 'same-content' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-failed-op')) {",
    "    const count = nextCount('failed-op');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating folder then overwriting protected file.',",
    "        actions: [",
    "          { operation: 'createFolder', args: { path: 'pc-folder-fail' } },",
    "          { operation: 'writeFile', args: { path: '.env', content: 'should-fail' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Trying again.',",
    "      actions: [",
    "        { operation: 'createFolder', args: { path: 'pc-folder-fail' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-mixed-read')) {",
    "    return okResponse({",
    "      message: 'Listing then writing.',",
    "      actions: [",
    "        { operation: 'listDirectory', args: { path: '' } },",
    "        { operation: 'writeFile', args: { path: 'pc-mixed.txt', content: 'mixed' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workspace-objective-satisfied')) {",
    "    return okResponse({",
    "      message: 'Writing requested note.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'workspace-objective-note.md', content: 'workspace objective satisfied' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workspace-root-objective-satisfied')) {",
    "    return okResponse({",
    "      message: 'Writing requested workspace-root note.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'mike-repair-recommendation.md', content: 'workspace-root objective satisfied' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('postcondition-non-obvious')) {",
    "    const count = nextCount('non-obvious');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating folder A then folder B.',",
    "        actions: [",
    "          { operation: 'createFolder', args: { path: 'pc-folder-a' } },",
    "          { operation: 'createFolder', args: { path: 'pc-folder-b' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Ensuring both exist.',",
    "      actions: [",
    "        { operation: 'createFolder', args: { path: 'pc-folder-a' } },",
    "        { operation: 'createFolder', args: { path: 'pc-folder-b' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-valid')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraft', args: { workflow: {",
    "          id: 'agent-draft-valid',",
    "          name: 'Agent draft valid',",
    "          inputSchema: { path: 'string', content: 'string' },",
    "          actions: [",
    "            { id: 'write', action: 'writeFile', input: { path: '{{workflow.input.path}}', content: '{{workflow.input.content}}' }, next: 'done' },",
    "            { id: 'done', action: 'stop', input: { result: { path: '{{workflow.input.path}}' } } }",
    "          ],",
    "          postconditions: [",
    "            { id: 'file-exists', type: 'fileExists', path: '{{workflow.input.path}}' }",
    "          ]",
    "        } } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-intent-action-postconditions')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft intent with action-level postconditions.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraftIntent', args: {",
    "          id: 'agent-draft-intent-action-postconditions',",
    "          name: 'Agent draft intent action postconditions',",
    "          writes: [",
    "            { path: 'intent-action-postconditions.txt', content: 'action postconditions content' }",
    "          ]",
    "        }, postconditions: [",
    "          { type: 'fileExists', path: 'intent-action-postconditions.txt' },",
    "          { type: 'fileContains', path: 'intent-action-postconditions.txt', contains: 'action postconditions content' }",
    "        ] }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-intent-both-postconditions')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft intent with duplicate postcondition locations.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraftIntent', args: {",
    "          id: 'agent-draft-intent-both-postconditions',",
    "          name: 'Agent draft intent both postconditions',",
    "          writes: [",
    "            { path: 'intent-both-postconditions.txt', content: 'both postconditions content' }",
    "          ],",
    "          postconditions: [",
    "            { type: 'fileExists', path: 'intent-both-postconditions.txt' }",
    "          ]",
    "        }, postconditions: [",
    "          { type: 'fileExists', path: 'intent-both-postconditions.txt' },",
    "          { type: 'fileContains', path: 'intent-both-postconditions.txt', contains: 'both postconditions content' }",
    "        ] }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-intent-action-note')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft intent with unsupported action-level note.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraftIntent', args: {",
    "          id: 'agent-draft-intent-action-note',",
    "          name: 'Agent draft intent action note',",
    "          writes: [",
    "            { path: 'intent-action-note.txt', content: 'action note content' }",
    "          ],",
    "          postconditions: [",
    "            { type: 'fileExists', path: 'intent-action-note.txt' }",
    "          ]",
    "        }, note: 'unsupported' }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-intent-numeric-id')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft intent with numeric id.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraftIntent', args: {",
    "          id: '12345',",
    "          name: 'Numeric id draft intent',",
    "          writes: [",
    "            { path: 'numeric-intent-summary.txt', content: 'numeric intent summary content' }",
    "          ],",
    "          postconditions: [",
    "            { type: 'fileExists', path: 'numeric-intent-summary.txt' },",
    "            { type: 'fileContains', path: 'numeric-intent-summary.txt', contains: 'numeric intent summary content' }",
    "          ]",
    "        } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-intent')) {",
    "    return okResponse({",
    "      message: 'Creating workflow draft from intent.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraftIntent', args: {",
    "          id: 'agent-draft-intent',",
    "          name: 'Agent draft intent',",
    "          writes: [",
    "            { path: 'intent-summary.txt', content: 'intent summary content' }",
    "          ],",
    "          postconditions: [",
    "            { type: 'fileExists', path: 'intent-summary.txt' },",
    "            { type: 'fileContains', path: 'intent-summary.txt', contains: 'intent summary content' }",
    "          ]",
    "        } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-branching-unsupported')) {",
    "    return okResponse({",
    "      message: 'Branching workflow drafts are not available to normal agents with the allowed operations.',",
    "      actions: [],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('handoff-valid')) {",
    "    return okResponse({",
    "      message: 'Creating bounded handoff task for Mike.',",
    "      actions: [",
    "        { operation: 'createHandoffTask', args: {",
    "          executor: 'Mike',",
    "          operation: 'writeFile',",
    "          args: { path: 'handoff-note.md', content: 'handoff content' }",
    "        } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('handoff-invalid-path')) {",
    "    return okResponse({",
    "      message: 'Creating invalid handoff task.',",
    "      actions: [",
    "        { operation: 'createHandoffTask', args: {",
    "          executor: 'Mike',",
    "          operation: 'writeFile',",
    "          args: { path: '/tmp/handoff-note.md', content: 'bad path' }",
    "        } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('handoff-unknown-executor')) {",
    "    return okResponse({",
    "      message: 'Creating handoff task for unknown executor.',",
    "      actions: [",
    "        { operation: 'createHandoffTask', args: {",
    "          executor: 'MissingAgent',",
    "          operation: 'writeFile',",
    "          args: { path: 'handoff-note.md', content: 'unknown executor' }",
    "        } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('workflow-draft-invalid')) {",
    "    return okResponse({",
    "      message: 'Creating invalid workflow draft.',",
    "      actions: [",
    "        { operation: 'createWorkflowDraft', args: { workflow: {",
    "          id: 'agent-draft-invalid',",
    "          name: 'Agent draft invalid',",
    "          inputSchema: { path: 'string' },",
    "          actions: [",
    "            { id: 'write', action: 'writeFile', input: { path: '{{workflow.input.path}}', content: 'x' }, next: 'done' },",
    "            { id: 'done', action: 'stop', input: {} }",
    "          ]",
    "        } } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  return okResponse({ message: 'default', actions: [], complete: true });",
    "};",
    ""
  ].join('\n');

  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function runAllScenarios({ store, preloadPath, agent, mike, runScenario, getWorkflow, request, waitForEvent, waitForStoredTicket, waitForStoredRun, assert, workspaceRoot }) {
  // The scenarios assert real filesystem effects against the harness workspace.
  const WORKSPACE_ROOT = workspaceRoot;

  try {
    // 1. folder+file creation finalizes automatically once satisfied
    await runScenario(
      preloadPath,
      agent,
      `postcondition-create-folder-file ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 2. repeated identical write does not continue forever
    await runScenario(
      preloadPath,
      agent,
      `postcondition-repeated-write ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 3. provider timeout avoided after verified completion (low step limit, but still completes)
    await runScenario(
      preloadPath,
      agent,
      `postcondition-repeated-write timeout-avoided ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '2000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 4. blocked/failed operations do not trigger completion
    await runScenario(
      preloadPath,
      agent,
      `postcondition-failed-op ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true
      }
    );

    // 5. non-obvious tasks (mixed read + write) still require model completion
    await runScenario(
      preloadPath,
      agent,
      `postcondition-mixed-read ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        expectStepsAtLeast: 2
      }
    );

    // 6. direct write objectives complete from successful mutation evidence
    await runScenario(
      preloadPath,
      agent,
      `workspace-objective-satisfied write workspace-objective-note.md ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(snapshot.parsedModelPlans.length === 1, 'Workspace objective complete:false should not trigger a second model turn');
          assert(snapshot.parsedModelPlans[0].complete === false, 'Regression should cover direct workspace complete:false');
          assert(snapshot.events.some(event => event.type === 'workspace.objective_satisfied'), 'Replay should record workspace objective satisfaction');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed', 'Ticket should complete after successful direct workspace objective');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should still be recorded');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should still be recorded');
          assert(storedRun.runEvaluation.efficiency.modelResponses === 2, 'Run evaluation should record compiler + execution model responses');
          assert(storedRun.runConsequence.created.some(item => item.path === 'workspace-objective-note.md'), 'Run consequence should record created note');
        }
      }
    );

    // 7. workspace-root-prefixed objective paths match runtime-relative write paths
    await runScenario(
      preloadPath,
      agent,
      `workspace-root-objective-satisfied write workspace-root/mike-repair-recommendation.md ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        verify: async ({ run, snapshot }) => {
          assert(snapshot.parsedModelPlans.length === 1, 'workspace-root objective should not trigger a second model turn');
          assert(snapshot.parsedModelPlans[0].complete === false, 'Regression should cover complete:false with workspace-root objective path');
          assert(snapshot.events.some(event => event.type === 'workspace.objective_satisfied'), 'Replay should record workspace objective satisfaction');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed', 'Ticket should complete after workspace-root path objective is satisfied');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should be recorded for workspace-root path objective');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should be recorded for workspace-root path objective');
          assert(storedRun.runEvaluation.efficiency.modelResponses === 2, 'Run evaluation should record compiler + execution model responses');
          assert(storedRun.runConsequence.created.some(item => item.path === 'mike-repair-recommendation.md'), 'Run consequence should record created recommendation file');
        }
      }
    );

    // 8. once all meaningful mutations are done, redundant no-op batch auto-completes
    await runScenario(
      preloadPath,
      agent,
      `postcondition-non-obvious ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 8. agent-created workflow drafts are saved disabled and exposed in workflow data
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-valid ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot, cookie }) => {
          const draft = await getWorkflow( 'agent-draft-valid');
          assert(draft, 'Agent-created workflow draft was not saved');
          assert(draft.enabled === false, 'Agent-created workflow draft should be disabled');
          assert(draft.createdByType === 'agent', 'Agent-created workflow draft should persist createdByType');
          assert(draft.createdByAgentId === agent.id, 'Agent-created workflow draft should persist createdByAgentId');
          assert(draft.createdByRunId === run.id, 'Agent-created workflow draft should persist createdByRunId');
          assert(Array.isArray(draft.postconditions) && draft.postconditions.length === 1, 'Agent-created mutating workflow draft should persist postconditions');
          assert(snapshot.workflowDrafts.some(item => item.workflowId === 'agent-draft-valid' && item.enabled === false), 'Replay should record workflow draft creation');
          const draftEvent = await waitForEvent(event => event.type === 'workflow.draft_created' && event.runId === run.id);
          assert(draftEvent, 'workflow.draft_created event missing');
          const enableResponse = await request('POST', '/admin/workflows/agent-draft-valid', {
            cookie,
            form: {
              expectedRevision: String(draft.revision),
              definition: JSON.stringify({
                ...draft,
                enabled: true,
                updatedAt: new Date().toISOString()
              }, null, 2)
            }
          });
          assert(enableResponse.statusCode === 302, `Operator enable workflow draft returned HTTP ${enableResponse.statusCode}`);
          const enabledDraft = await getWorkflow( 'agent-draft-valid');
          assert(enabledDraft.enabled === true, 'Operator should be able to enable agent-created draft through admin workflow path');
        }
      }
    );

    // 9. agent-created workflow draft intent compiles to valid disabled workflow draft
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-intent ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          const draft = await getWorkflow( 'agent-draft-intent');
          assert(draft, 'Agent-created workflow draft intent was not saved');
          assert(draft.enabled === false, 'Agent-created workflow draft intent should be disabled');
          assert(draft.createdByType === 'agent', 'Intent-created workflow draft should persist createdByType');
          assert(draft.createdByAgentId === agent.id, 'Intent-created workflow draft should persist createdByAgentId');
          assert(draft.createdByRunId === run.id, 'Intent-created workflow draft should persist createdByRunId');
          assert(Array.isArray(draft.actions) && draft.actions.length === 2, 'Intent should compile one write step and one stop step');
          assert(draft.actions[0].action === 'writeFile', 'Intent write should compile to writeFile workflow action');
          assert(draft.actions[0].next === 'stop', 'Intent write step should point to stop step');
          assert(draft.actions[1].action === 'stop', 'Intent should compile a stop workflow action');
          assert(Array.isArray(draft.postconditions) && draft.postconditions.length === 2, 'Intent postconditions should compile to workflow.postconditions');
          assert(snapshot.workflowDraftIntents.some(item => item.compiledWorkflowId === 'agent-draft-intent'), 'Replay should record workflow draft intent compilation');
          assert(snapshot.workflowDrafts.some(item => item.workflowId === 'agent-draft-intent' && item.enabled === false), 'Replay should record compiled workflow draft creation');
          assert(snapshot.parsedModelPlans.length === 1, 'Workflow draft intent complete:false should not trigger a second model turn');
          assert(snapshot.parsedModelPlans[0].complete === false, 'Regression should cover model complete:false');
          assert(snapshot.events.some(event => event.type === 'workflow.draft_objective_satisfied'), 'Replay should record workflow draft objective satisfaction');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed', 'Ticket should complete after successful workflow draft intent');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should still be recorded');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should still be recorded');
        }
      }
    );

    // 10. action-level workflow draft intent postconditions are normalized when args.postconditions is absent
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-intent-action-postconditions ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          const draft = await getWorkflow( 'agent-draft-intent-action-postconditions');
          assert(draft, 'Action-level postconditions intent should create a workflow draft');
          assert(draft.enabled === false, 'Action-level postconditions draft should be disabled');
          assert(draft.createdByRunId === run.id, 'Action-level postconditions draft should preserve createdByRunId');
          assert(Array.isArray(draft.postconditions) && draft.postconditions.length === 2, 'Action-level postconditions should normalize into workflow.postconditions');
          assert(snapshot.workflowDraftIntents.some(item => item.compiledWorkflowId === 'agent-draft-intent-action-postconditions'), 'Replay should record normalized workflow draft intent compilation');
          assert(snapshot.workflowDrafts.some(item => item.workflowId === 'agent-draft-intent-action-postconditions'), 'Replay should record normalized workflow draft creation');
        }
      }
    );

    // 11. args.postconditions plus action-level postconditions remains rejected deterministically
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-intent-both-postconditions ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'Agent action includes unsupported field: postconditions', 'Both postcondition locations should reject action-level postconditions');
          assert(snapshot.failureReason === run.error, 'Both postcondition locations should preserve failure reason');
          const draft = await getWorkflow( 'agent-draft-intent-both-postconditions');
          assert(!draft, 'Both postcondition locations should not create a workflow draft');
        }
      }
    );

    // 12. unrelated action-level fields are still rejected
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-intent-action-note ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'Agent action includes unsupported field: note', 'Unrelated action-level field should remain rejected');
          assert(snapshot.failureReason === run.error, 'Unrelated action-level field should preserve failure reason');
          const draft = await getWorkflow( 'agent-draft-intent-action-note');
          assert(!draft, 'Unrelated action-level field should not create a workflow draft');
        }
      }
    );

    // 13. workflow draft intent rejects bare numeric ids with a clear terminal error
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-intent-numeric-id ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          const expectedError = 'createWorkflowDraftIntent.id must be a descriptive non-numeric id such as draft-summary-file-123 or draft-verified-output-123';
          assert(run.error === expectedError, 'Numeric workflow draft intent id should preserve clear validation error');
          assert(snapshot.failureReason === expectedError, 'Numeric workflow draft intent id should preserve failure reason');
          assert(snapshot.parsedModelPlans.length === 1, 'Numeric id validation should not retry or recover');
          assert(snapshot.workflowDraftIntents.length === 0, 'Invalid numeric id intent should not record compiled workflow intent');
          assert(snapshot.workflowDrafts.length === 0, 'Invalid numeric id intent should not create a workflow draft');
          const draft = await getWorkflow( '12345');
          assert(!draft, 'Invalid numeric id should not create a workflow under the numeric id');
        }
      }
    );

    // 11. unsupported workflow draft objectives fail terminally without retrying until timeout
    await runScenario(
      preloadPath,
      agent,
      `workflow-branching-unsupported ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'Branching workflow drafts are not available to normal agents with the allowed operations.', 'Unsupported objective message should be preserved as run error');
          assert(snapshot.failureReason === run.error, 'Unsupported objective message should be preserved as failure reason');
          assert(snapshot.parsedModelPlans.length === 1, 'Unsupported objective should not trigger a second model turn');
          assert(snapshot.providerRequests.length === 2, 'Unsupported objective should record compiler + execution provider requests');
          assert(snapshot.modelResponses.length === 2, 'Unsupported objective should record compiler + execution model responses');
          assert(snapshot.workflowDrafts.length === 0, 'Unsupported objective should not create a workflow draft');
          assert(snapshot.workspaceOperations.length === 0, 'Unsupported objective should not mutate workspace');
          assert(snapshot.events.some(event => event.type === 'model:unsupported_objective'), 'Replay should record unsupported objective event');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Run evaluation should still be recorded');
          assert(storedRun && storedRun.runConsequence, 'Run consequence should still be recorded');
        }
      }
    );

    // 11. structured handoff task executes one writeFile through executor identity without executor model call
    await runScenario(
      preloadPath,
      agent,
      `handoff-valid ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(snapshot.providerRequests.length === 2, 'Handoff planner should record compiler + execution provider requests');
          assert(snapshot.modelResponses.length === 2, 'Handoff planner should record compiler + execution model responses');
          assert(snapshot.handoffTasks && snapshot.handoffTasks.some(item => item.status === 'validated' && item.executorAgentId === mike.id), 'Handoff validation evidence missing');
          assert(snapshot.handoffTasks.some(item => item.status === 'executed' && item.executorAgentId === mike.id), 'Handoff execution evidence missing');
          assert(snapshot.workspaceOperations.length === 1, 'Handoff should record one workspace operation');
          assert(snapshot.workspaceOperations[0].operation.operation === 'writeFile', 'Handoff should execute writeFile');
          assert(snapshot.workspaceOperations[0].operation.args.path === 'handoff-note.md', 'Handoff write path mismatch');
          assert(snapshot.authorityChecks.some(item => item.status === 'allowed' && item.actor === `agent:${mike.id}` && item.path === 'handoff-note.md'), 'Handoff authority should use executor identity');
          assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'handoff-note.md'), 'utf8') === 'handoff content', 'Handoff should write exact content');
          const storedRun = await waitForStoredRun(run.id, item => item.runEvaluation && item.runConsequence);
          assert(storedRun && storedRun.runEvaluation, 'Handoff run evaluation should be recorded');
          assert(storedRun && storedRun.runConsequence, 'Handoff run consequence should be recorded');
          assert(storedRun.runConsequence.created.some(item => item.path === 'handoff-note.md'), 'Handoff consequence should record created file');
        }
      }
    );

    // 12. handoff invalid paths are rejected before execution
    await runScenario(
      preloadPath,
      agent,
      `handoff-invalid-path ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'createHandoffTask args.path must be a relative workspace path', 'Invalid handoff path should preserve validation error');
          assert(!snapshot.workspaceOperations.length, 'Invalid handoff path should not execute workspace operation');
          assert(!fs.existsSync('/tmp/handoff-note.md'), 'Invalid handoff path should not write outside workspace');
        }
      }
    );

    // 13. handoff unknown executor is rejected before execution
    await runScenario(
      preloadPath,
      agent,
      `handoff-unknown-executor ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async ({ run, snapshot }) => {
          assert(run.error === 'createHandoffTask executor not found: MissingAgent', 'Unknown executor should preserve validation error');
          assert(!snapshot.workspaceOperations.length, 'Unknown executor handoff should not execute workspace operation');
        }
      }
    );

    // 14. invalid agent-created mutating workflow without postconditions is rejected
    await runScenario(
      preloadPath,
      agent,
      `workflow-draft-invalid ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'failed',
        expectNoPostcondition: true,
        verify: async () => {
          const draft = await getWorkflow( 'agent-draft-invalid');
          assert(!draft, 'Invalid workflow draft should not be saved');
        }
      }
    );

    // 15. a model complete:true cannot bypass unsatisfied compiled postconditions
    await runScenario(
      preloadPath,
      agent,
      `compiled-partial-completion ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '5000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtLeast: 2,
        verify: async ({ run, snapshot }) => {
          assert(fs.statSync(path.join(WORKSPACE_ROOT, 'compiled-A')).isDirectory(), 'First compiled target was not created');
          assert(fs.statSync(path.join(WORKSPACE_ROOT, 'compiled-B')).isDirectory(), 'Second compiled target was not created');
          assert(snapshot.parsedModelPlans.length === 2, 'Partial complete:true should require a second execution turn');
          assert(snapshot.events.some(event => event.type === 'run:contract_completion_deferred'), 'Deferred compiled completion evidence missing');
          const persistedEvent = await waitForEvent(event => event.type === 'run.contract_completion_deferred' && event.runId === run.id);
          assert(persistedEvent && persistedEvent.payload.pendingPostconditions.some(check => check.path === 'compiled-B'), 'Persisted deferred completion evidence missing pending target');
        }
      }
    );

    console.log(JSON.stringify({
      folderFileAutoComplete: true,
      repeatedWriteAutoComplete: true,
      timeoutAvoided: true,
      failedOpNoAutoComplete: true,
      mixedReadNoAutoComplete: true,
      workspaceObjectiveSatisfied: true,
      partialMutationHandled: true,
      workflowDraftCreated: true,
      workflowDraftIntentCreated: true,
      workflowDraftIntentNumericIdRejected: true,
      workflowDraftIntentActionPostconditionsNormalized: true,
      workflowDraftIntentBothPostconditionsRejected: true,
      workflowDraftIntentUnrelatedActionFieldRejected: true,
      unsupportedObjectiveFailed: true,
      handoffTaskExecuted: true,
      handoffInvalidPathRejected: true,
      handoffUnknownExecutorRejected: true,
      invalidWorkflowDraftRejected: true,
      compiledPartialCompletionDeferred: true
    }));
  } finally {
    // Workspace and schema cleanup belong to the shared harness; only the
    // generated provider preload is owned by this suite.
    try { require('fs').unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

async function main() {
  await withHarness('postcondition completion', async ({ store, workspaceRoot, startServer }) => {
    const preloadPath = createFakeOpenAIPreload();

    const agent = (await store.createConfiguredAgent({
      value: { name: `PostconditionAgent-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-postcondition' },
      groupIds: [], changedBy: 'postcondition-completion-test'
    })).agent;

    // Handoff scenarios name "Mike" as the executor; it must exist as a real agent.
    const mike = (await store.createConfiguredAgent({
      value: { name: 'Mike', provider: 'ollama', model: 'gemma3:latest', apiKey: '' },
      groupIds: [], changedBy: 'postcondition-completion-test'
    })).agent;

    const getWorkflow = async workflowId => store.getWorkflowById(workflowId);

    // Store-backed replacements for the JSON-era pollers. Timeouts are widened
    // from the original 1s: PostgreSQL round-trips are slower than a local file
    // read, and the assertions are about eventual durability, not latency.
    const waitForEvent = async (predicate, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const page = await store.listRuns({ limit: 100 });
        for (const run of page.runs || []) {
          const events = await store.listRunEvents(run.id, { afterSeq: -1, limit: 300 });
          const found = (events || []).find(predicate);
          if (found) return found;
        }
        await sleep(120);
      }
      return null;
    };

    // The JSON-era store kept runEvaluation and runConsequence inline on the run
    // record. PostgreSQL keeps them in their own tables, so the "stored run" the
    // scenarios assert against is composed from the run plus those two reads.
    const waitForStoredRun = async (runId, predicate, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      let composed = null;
      while (Date.now() < deadline) {
        const run = await store.getRun(runId);
        if (run) {
          // Both accessors return a row wrapper; the scenarios assert against the
          // documents themselves, which is what the JSON-era run record inlined.
          const [evaluationRow, consequenceRow] = await Promise.all([
            store.getRunEvaluation(runId),
            store.getRunConsequence(runId)
          ]);
          composed = {
            ...run,
            runEvaluation: evaluationRow ? evaluationRow.evaluation : null,
            runConsequence: consequenceRow ? consequenceRow.consequence : null
          };
          if (predicate(composed)) return composed;
        }
        await sleep(120);
      }
      return composed;
    };

    const waitForStoredTicket = async (ticketId, predicate, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ticket = await store.getTicket(ticketId);
        if (ticket && predicate(ticket)) return ticket;
        await sleep(120);
      }
      return store.getTicket(ticketId);
    };

    // Scenario isolation is the contract: every scenario restarts the server
    // with its own budget, creates its ticket, and asserts against that run alone.
    let activeRequest = null;
    const request = (method, urlPath, options = {}) => activeRequest(method, urlPath, options);

    const seenRunIds = new Set();

    async function runScenario(preload, scenarioAgent, objective, envOverrides, expectations) {
      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preload}`,
        AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1',
        ENABLE_MODEL_CONTRACT_COMPILER: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        ...envOverrides
      } });
      activeRequest = server.request;
      try {
        const cookie = await server.login();
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: {
            objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: String(scenarioAgent.id),
            assignmentMode: 'individual'
          }
        });
        if (created.statusCode !== 302) {
          throw new Error(`${objective}: ticket create returned HTTP ${created.statusCode}`);
        }

        const run = await (async () => {
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            const page = await store.listRuns({ limit: 200 });
            const candidate = (page.runs || [])
              .find(r => r.agentId === scenarioAgent.id && !seenRunIds.has(r.id));
            if (candidate) {
              const current = await store.getRun(candidate.id);
              if (current && ['completed', 'failed', 'interrupted'].includes(current.status)) {
                seenRunIds.add(current.id);
                return current;
              }
            }
            await sleep(150);
          }
          const page = await store.listRuns({ limit: 200 });
          const cand = (page.runs || []).filter(r => !seenRunIds.has(r.id));
          const diag = [];
          for (const c of cand) {
            const cur = await store.getRun(c.id);
            diag.push(`run#${cur.id} agent=${cur.agentId} status=${cur.status} err=${cur.error || '-'}`);
          }
          throw new Error(`${objective}: timed out waiting for a terminal run [${diag.join(' | ') || 'no candidate runs'}]`);
        })();

        const replay = await store.readRunReplay(run.id);
        const snapshot = replay ? replay.snapshot : null;
        const ticket = await store.getTicket(run.ticketId);

        assert(run.status === expectations.expectedStatus,
          `${objective}: run status ${run.status} === ${expectations.expectedStatus}`);

        const events = (snapshot && Array.isArray(snapshot.events)) ? snapshot.events : [];
        const plans = (snapshot && Array.isArray(snapshot.parsedModelPlans)) ? snapshot.parsedModelPlans : [];

        if (expectations.expectPostconditionCompleted) {
          assert(events.some(e => e.type === 'run:postcondition_completed'),
            `${objective}: run:postcondition_completed was recorded`);
        }
        if (expectations.expectNoPostcondition) {
          assert(!events.some(e => e.type === 'run:postcondition_completed'),
            `${objective}: no run:postcondition_completed was recorded`);
        }
        if (expectations.expectStepsAtMost !== undefined) {
          assert(plans.length <= expectations.expectStepsAtMost,
            `${objective}: used ${plans.length} steps, at most ${expectations.expectStepsAtMost}`);
        }
        if (expectations.expectStepsAtLeast !== undefined) {
          assert(plans.length >= expectations.expectStepsAtLeast,
            `${objective}: used ${plans.length} steps, at least ${expectations.expectStepsAtLeast}`);
        }
        if (typeof expectations.verify === 'function') {
          await expectations.verify({ run, ticket, snapshot, cookie });
        }
        return run;
      } finally {
        await server.stop();
        activeRequest = null;
      }
    }

    await runAllScenarios({
      store, preloadPath, agent, mike, runScenario, getWorkflow, request,
      waitForEvent, waitForStoredTicket, waitForStoredRun, assert, workspaceRoot
    });

    console.log(`\nPASS: postcondition completion, workflow drafts, and handoffs — ${assert.count()} assertions (PostgreSQL-native, 20 scenarios)`);
  });
}


main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
