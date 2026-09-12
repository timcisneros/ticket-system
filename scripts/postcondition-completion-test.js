#!/usr/bin/env node
'use strict';
// Postcondition-based completion, workflow-draft intents, and handoff tasks —
// PostgreSQL-native (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Scenarios 1-20 are ported one-for-one from the JSON-era original against the
// inventory recorded in A10. Each keeps its own server restart, its own runtime
// budget, its own objective and provider-response branch, and the exact negative
// regression it guards. They are deliberately NOT collapsed into shared
// assertions: scenarios 1-8 cover postcondition completion, 9-15 cover workflow
// draft intents, 16-18 cover handoff tasks, 19 covers draft rejection, and 20
// covers compiled partial completion.
//
// P3-R1 (bounded declared-postcondition continuation) extends this owner with
// the M-matrix it authorizes: scenario 22 now proves the bounded declared
// continuation (wrong first write + advisory complete:true -> one corrective
// bounded turn -> deterministic satisfied stop exactly once), and scenarios
// 23, 25-27 plus the crafted M5 control pin the deferred seam, the shared
// stalled-response bound, the blanket redundant-operation exclusion for
// declared Runs (observed-negative AND unavailable/mixed state), and the
// receipt-policy shortcut eligibility decided only by the immutable
// completion-authority snapshot.
//
// Repaired, not rewritten. The provider preload (objective branches) and the
// scenario bodies are preserved from the original; only the storage layer
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
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const {
  buildCompletionAuthoritySnapshot,
  normalizeCompletionAuthoritySnapshot
} = require('../runtime/completion-decision-contract');

const STAMP = Date.now();

// Brace-balanced extraction of one top-level function from server.js source,
// same discipline as scripts/evidence-truthfulness-contract-test.js. Used only
// to execute an existing production helper against the REAL canonical
// normalizer in tests — it adds no production instrumentation.
function extractServerFunction(code, name) {
  const match = code.match(new RegExp(`function ${name}\\s*\\(`));
  if (!match) throw new Error(`could not locate function ${name} in server.js`);
  const start = match.index;
  let i = start + match[0].length;
  let parens = 1;
  while (i < code.length && parens > 0) {
    if (code[i] === '(') parens += 1;
    else if (code[i] === ')') parens -= 1;
    i += 1;
  }
  const bodyStart = code.indexOf('{', i);
  if (bodyStart === -1) throw new Error(`could not locate body of ${name}`);
  let depth = 0;
  let j = bodyStart;
  while (j < code.length) {
    if (code[j] === '{') depth += 1;
    else if (code[j] === '}') depth -= 1;
    j += 1;
    if (depth === 0) break;
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting ${name}`);
  return code.slice(start, j);
}
const assert = createAsserter();

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `postcondition-openai-${process.pid}-${Date.now()}.js`);
  const source = [
    "const responseCounts = new Map();",
    "const stamp = '" + STAMP + "';",
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
    "  if (combined.includes('r2-summary-' + stamp + '.md containing R2MARKER')) {",
    "    return okResponse({",
    "      message: 'Writing the requested summary.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'r2-summary-' + stamp + '.md', content: 'the payload includes R2MARKER and more' } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('r2-refused-' + stamp + '.md containing R2MARKER')) {",
    "    // P3-R1 M1: the first execution turn writes the WRONG content and claims",
    "    // complete:true; the admitted declared criterion is observably false, so",
    "    // completion is deferred and the same Run continues one corrective bounded",
    "    // turn that satisfies it.",
    "    const count = nextCount('r2-refused');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Writing something unrelated.',",
    "        actions: [",
    "          { operation: 'writeFile', args: { path: 'r2-refused-' + stamp + '.md', content: 'an unrelated body without the marker' } }",
    "        ],",
    "        complete: true",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Correcting the requested summary.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'r2-refused-' + stamp + '.md', content: 'the payload includes R2MARKER and more' } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('p3-stall-' + stamp + '.md containing P3STALL')) {",
    "    // P3-R1 M2: repeated zero-action deferred completion. The model never",
    "    // mutates and always claims complete:true while the admitted criterion is",
    "    // observably false; the shared stalled-response bound must terminalize",
    "    // honestly.",
    "    return okResponse({ message: 'Nothing to do.', actions: [], complete: true });",
    "  }",
    "",
    "  if (combined.includes('p3-declared-false-' + stamp + '.md containing P3FALSE')) {",
    "    // P3-R1 M3: wrong write with complete:false. Neither the receipt shortcut",
    "    // nor the redundant-operation heuristic may claim the declared Run; it",
    "    // continues while bounded instead.",
    "    return okResponse({",
    "      message: 'Writing wrong content.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'p3-declared-false-' + stamp + '.md', content: 'wrong content without the marker' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('p3-persistent-' + stamp + '.md containing P3PERSIST')) {",
    "    // P3-R1 M7: persistent unsatisfied work with complete:true stays bounded",
    "    // by the existing execution limits; no infinite continuation.",
    "    return okResponse({",
    "      message: 'Writing wrong content again.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'p3-persistent-' + stamp + '.md', content: 'wrong content without the marker' } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('p3-mixed-unavailable-' + stamp + '.md containing P3MIXED')) {",
    "    // P3-R1 blanket redundant-operation exclusion, unavailable/mixed case:",
    "    // the model's mutation is a redundant no-op on an unrelated path while",
    "    // the admitted criterion is structurally unobservable (directory at",
    "    // path). The heuristic must never claim the declared Run, and the",
    "    // unavailable criterion must not become a continuation hinge either.",
    "    return okResponse({",
    "      message: 'Rewriting the other file identically.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'p3-mixed-other-' + stamp + '.md', content: 'mixed baseline' } }",
    "      ],",
    "      complete: true",
    "    });",
    "  }",
    "",
    "  if (combined.includes('write note p3-shortcut-receipt-' + stamp)) {",
    "    // P3-R1 M5 crafted positive control: a direct-write Run whose admitted",
    "    // snapshot proves the workspace_objective_receipt policy. The provider",
    "    // writes the objective path and claims complete:false, which trips the",
    "    // successful-mutation shortcut exactly as in the predecessor.",
    "    return okResponse({",
    "      message: 'Writing the requested note.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'p3-shortcut-receipt-' + stamp + '.md', content: 'crafted shortcut control content' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('write note p3-shortcut-withhold-' + stamp)) {",
    "    // P3-R1 M5 crafted withhold control: the same behavior for a Run admitted",
    "    // WITHOUT a completion-authority snapshot. The shortcut must be withheld",
    "    // fail-closed and the Run continues while bounded instead.",
    "    return okResponse({",
    "      message: 'Writing the requested note.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'p3-shortcut-withhold-' + stamp + '.md', content: 'crafted shortcut control content' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('write note p3-shortcut-corrupt-' + stamp)) {",
    "    // P3-R1 M5 crafted corrupt control (F1): the same behavior for a Run",
    "    // whose completion-authority snapshot is PRESENT but fails canonical",
    "    // normalization. If any path defaulted the unreadable authority to the",
    "    // receipt policy, this shortcut-shaped response would be consumed and",
    "    // workspace.objective_satisfied would fire; the control exists so that",
    "    // regression is deterministic.",
    "    return okResponse({",
    "      message: 'Writing the requested note.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'p3-shortcut-corrupt-' + stamp + '.md', content: 'crafted shortcut control content' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  if (combined.includes('r2-busy-' + stamp + '.md containing R2MARKER')) {",
    "    return okResponse({ message: 'Nothing to do.', actions: [], complete: true });",
    "  }",
    "",
    "  if (combined.includes('r2-amb-a.md')) {",
    "    return okResponse({",
    "      message: 'Writing the first requested file.',",
    "      actions: [",
    "        { operation: 'writeFile', args: { path: 'r2-amb-a.md', content: 'hello' } }",
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
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
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
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'completed',
        expectPostconditionCompleted: true,
        expectStepsAtMost: 2
      }
    );

    // 3. run-duration timeout avoided by verified completion (low step limit, but still completes)
    // The durable runtime budget starts when the Run is claimed
    // (runtimeBudgetStartedAt is stamped in startClaimedRun) and includes
    // post-claim setup, compiler/model work, database round trips, and action
    // processing. Two full agent turns measure roughly 2-4 seconds depending on
    // host and database latency, so a 2000ms ceiling raced the completion
    // authority itself and failed nondeterministically
    // (RUN_RUNTIME_DURATION_EXCEEDED at clean HEAD too). 10000ms preserves the
    // invariant under test — verified redundant-write completion terminalizes
    // within the configured budget and step ceiling — without betting on
    // wall-clock. Scenarios 1, 2, 8, and 15 share this same two-turn shape and
    // use the same non-semantic headroom value.
    await runScenario(
      preloadPath,
      agent,
      `postcondition-repeated-write timeout-avoided ${STAMP}`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
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
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
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
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
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

    // ── P2-R2 end-to-end: deterministic fileContains completion authority ────
    // 21. admitted criterion satisfied: observed positive completes the chain.
    await runScenario(
      preloadPath,
      agent,
      `create file r2-summary-${STAMP}.md containing R2MARKER`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'completed',
        verify: async ({ run, snapshot }) => {
          const observationEvents = snapshot.events.filter(e => e.type === 'run:direct_postcondition_observed');
          assert(observationEvents.length >= 1, 'R2-E2E-A: criterion-bound observation was recorded');
          const lastObservation = observationEvents[observationEvents.length - 1];
          const lastEntry = lastObservation.observations && lastObservation.observations[0];
          assert(lastEntry && lastEntry.path === 'r2-summary-' + STAMP + '.md' && lastEntry.present === true,
            'R2-E2E-A: the latest observation is bound to the admitted path and positively observed');
          assert(lastObservation.observations[0].containsSha256.length === 64,
            'R2-E2E-A: the observation binds the exact expected-substring digest');
          assert(!lastObservation.observations[0].hasOwnProperty('content') &&
            !lastObservation.observations[0].hasOwnProperty('contains'),
            'R2-E2E-A: no raw file content or substring is stored in the observation');
          const storedRun = await waitForStoredRun(run.id, item => item.runConsequence);
          const decision = storedRun.runConsequence.completionDecision;
          assert(decision && decision.completionDisposition === 'completed' &&
            decision.reasonCode === 'OBJECTIVE_COMPLETED',
            'R2-E2E-A: completion decision is completed under observed criterion truth');
          const evaluated = (decision.evaluatedPostconditions || []).find(item => item.type === 'fileContains');
          assert(evaluated && evaluated.passed === true &&
            evaluated.reasonCode === 'POSTCONDITION_PASSED',
            'R2-E2E-A: the canonical evaluator decided the admitted criterion from durable observation');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed',
            'R2-E2E-A: Ticket projects COMPLETED through the existing chain');
          assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'r2-summary-' + STAMP + '.md')) &&
            fs.readFileSync(path.join(WORKSPACE_ROOT, 'r2-summary-' + STAMP + '.md'), 'utf8').includes('R2MARKER'),
            'R2-E2E-A: the required substring is really in the workspace file');
        }
      }
    );

    // 22. P3-R1 M1: bounded declared continuation. The first turn writes the
    // WRONG content and claims complete:true while the admitted criterion is
    // observably false, so completion is DEFERRED (existing deferral seam,
    // non-authoritative history) and the same Run continues one corrective
    // bounded turn. The corrective write satisfies the criterion; the existing
    // deterministic declared-direct check then owns the satisfied stop, and the
    // Run settles exactly once. P2 truth pins preserved: the criterion-bound
    // observation channel still records both states, no raw content is stored,
    // and completion authority stays with the canonical decision.
    await runScenario(
      preloadPath,
      agent,
      `create file r2-refused-${STAMP}.md containing R2MARKER`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'completed',
        verify: async ({ run, snapshot }) => {
          const observationEvents = snapshot.events.filter(e => e.type === 'run:direct_postcondition_observed');
          assert(observationEvents.length >= 2, 'M1: the wrong-write turn durably recorded the observed negative and the corrective turn the positive');
          const lastEntry = observationEvents[observationEvents.length - 1].observations[0];
          assert(lastEntry && lastEntry.path === 'r2-refused-' + STAMP + '.md' && lastEntry.present === true,
            'M1: the latest observation is bound to the admitted path and positively observed');
          assert(snapshot.parsedModelPlans.length === 2, 'M1: the premature complete:true must continue exactly one corrective bounded turn');
          const deferredEvents = snapshot.events.filter(e => e.type === 'run:contract_completion_deferred');
          assert(deferredEvents.length === 1, `M1: completion deferred exactly once before the corrective turn (got ${deferredEvents.length})`);
          assert(deferredEvents[0].pendingPostconditions &&
            deferredEvents[0].pendingPostconditions.some(check =>
              check.type === 'fileContains' && check.path === 'r2-refused-' + STAMP + '.md'),
            'M1: the deferral names the deterministic unsatisfied declared criterion');
          const persistedDeferred = await waitForEvent(event =>
            event.type === 'run.contract_completion_deferred' && event.runId === run.id);
          assert(persistedDeferred && persistedDeferred.payload &&
            persistedDeferred.payload.pendingPostconditions.some(check =>
              check.path === 'r2-refused-' + STAMP + '.md'),
            'M1: the durable deferral evidence carries the pending declared criterion');
          assert(!snapshot.events.some(event => event.type === 'workspace.objective_satisfied'),
            'M1: the successful-mutation shortcut never terminates a declared-postcondition Run');
          assert(!snapshot.events.some(event =>
            event.type === 'run:postcondition_completed' && event.source === 'redundant_operation'),
            'M1: the redundant-operation heuristic never claims a declared-postcondition Run');
          const storedRun = await waitForStoredRun(run.id, item => item.runConsequence);
          const decision = storedRun.runConsequence.completionDecision;
          assert(decision && decision.completionDisposition === 'completed' &&
            decision.reasonCode === 'OBJECTIVE_COMPLETED',
            'M1: the corrected criterion completes through the canonical decision');
          const evaluated = (decision.evaluatedPostconditions || []).find(item => item.type === 'fileContains');
          assert(evaluated && evaluated.passed === true &&
            evaluated.reasonCode === 'POSTCONDITION_PASSED',
            'M1: the canonical evaluator decided the admitted criterion from durable observation');
          const storedTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(storedTicket && storedTicket.status === 'completed',
            'M1: the Ticket completes exactly once');
          assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'r2-refused-' + STAMP + '.md')) &&
            fs.readFileSync(path.join(WORKSPACE_ROOT, 'r2-refused-' + STAMP + '.md'), 'utf8').includes('R2MARKER'),
            'M1: the corrected content is really in the workspace file');
        }
      }
    );

    // 23. admitted criterion unobservable (directory at path): unavailable, never
    // an observed negative, never completion; no observation event at all.
    fs.mkdirSync(path.join(WORKSPACE_ROOT, `r2-busy-${STAMP}.md`), { recursive: true });
    await runScenario(
      preloadPath,
      agent,
      `create file r2-busy-${STAMP}.md containing R2MARKER`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'completed',
        verify: async ({ run, snapshot }) => {
          assert(!snapshot.events.some(e => e.type === 'run:direct_postcondition_observed'),
            'R2-E2E-C: an unobservable path records NO observation');
          assert(!snapshot.events.some(e => e.type === 'run:contract_completion_deferred'),
            'M4: unavailable criterion state is never used as an observed-negative continuation hinge');
          assert(snapshot.parsedModelPlans.length === 1,
            'M4: model complete:true with unavailable criteria keeps the existing single-turn stop');
          const storedRun = await waitForStoredRun(run.id, item => item.runConsequence);
          const decision = storedRun.runConsequence.completionDecision;
          assert(decision && decision.completionDisposition === 'blocked' &&
            decision.reasonCode === 'VERIFICATION_UNAVAILABLE',
            'R2-E2E-C: unavailable criterion evidence fails closed as blocked');
          const evaluated = (decision.evaluatedPostconditions || []).find(item => item.type === 'fileContains');
          assert(evaluated && evaluated.passed === null &&
            evaluated.reasonCode === 'POSTCONDITION_EVIDENCE_UNAVAILABLE',
            'R2-E2E-C: unavailable is null, never an observed negative');
          const finalTicket = await store.getTicket(run.ticketId);
          assert(finalTicket.status !== 'completed',
            `R2-E2E-C: Ticket must not project COMPLETED on unavailable evidence (got ${finalTicket.status})`);
        }
      }
    );

    // 24. ambiguous two-target objective: NO fileContains admission; the
    // objective falls through to the existing honest receipt policy.
    await runScenario(
      preloadPath,
      agent,
      `create file r2-amb-a.md containing hello and create file r2-amb-b.md containing world`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'completed',
        verify: async ({ run, snapshot }) => {
          const storedRun = await waitForStoredRun(run.id, item => item.runConsequence);
          const authority = storedRun.completionAuthoritySnapshot;
          const direct = authority && authority.objectiveContract
            ? authority.objectiveContract.directPostconditions : [];
          assert(!direct.some(item => item.type === 'fileContains'),
            'R2-E2E-D: an ambiguous two-target objective admits NO fileContains criterion');
          assert(direct.length === 0,
            'R2-E2E-D: the ambiguous objective falls through with an empty direct set');
          const finalTicket = await waitForStoredTicket(run.ticketId, item => item.status === 'completed');
          assert(finalTicket && finalTicket.status === 'completed',
            'R2-E2E-D: the ambiguous objective still completes under its honest existing policy');
        }
      }
    );

    // 25. P3-R1 M2: repeated zero-action deferred completion is bounded by the
    // EXISTING shared stalled-response threshold. The model never mutates and
    // always claims complete:true while the admitted criterion is observably
    // false, so completion is deferred each turn; the second zero-action
    // deferral trips the stalled bound and terminalizes honestly.
    await runScenario(
      preloadPath,
      agent,
      `create file p3-stall-${STAMP}.md containing P3STALL`,
      {
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'failed',
        verify: async ({ run, snapshot }) => {
          assert(run.error && /Model stalled twice with no workspace actions/.test(run.error),
            `M2: the terminal error names the shared stalled-response bound honestly (got ${run.error})`);
          assert(snapshot.failure && snapshot.failure.code === 'RUN_LIMIT_EXCEEDED' &&
            snapshot.failure.kind === 'budget_exhausted' &&
            snapshot.failure.detail && snapshot.failure.detail.limitType === 'step',
            'M2: the stall bound terminalizes with RUN_LIMIT_EXCEEDED (step_limit)');
          const observationEvents = snapshot.events.filter(e => e.type === 'run:direct_postcondition_observed');
          assert(observationEvents.length >= 1, 'M2: the absent criterion path is a durable observed negative, not unavailable');
          const lastEntry = observationEvents[observationEvents.length - 1].observations[0];
          assert(lastEntry && lastEntry.path === 'p3-stall-' + STAMP + '.md' && lastEntry.present === false,
            'M2: the latest observation is the bound deterministic negative');
          const deferredEvents = snapshot.events.filter(e => e.type === 'run:contract_completion_deferred');
          assert(deferredEvents.length === 2, `M2: both zero-action deferrals were recorded before the bound tripped (got ${deferredEvents.length})`);
          assert(deferredEvents.every(event =>
            event.pendingPostconditions &&
            event.pendingPostconditions.some(check =>
              check.type === 'fileContains' && check.path === 'p3-stall-' + STAMP + '.md')),
            'M2: every deferral names the deterministic unsatisfied declared criterion');
          assert(!snapshot.events.some(event => event.type === 'run:completed_noop'),
            'M2: a deferred declared completion is not recorded as a satisfied no-op completion');
          const durableDeferred = (await store.listRunEvents(run.id, { afterSeq: -1, limit: 300 }))
            .filter(event => event.type === 'run.contract_completion_deferred');
          assert(durableDeferred.length === 2,
            `M2: the durable journal carries both deferrals (got ${durableDeferred.length})`);
          const storedRun = await waitForStoredRun(run.id, item => item.runConsequence);
          const decision = storedRun.runConsequence.completionDecision;
          assert(decision && decision.completionDisposition === 'incomplete' &&
            decision.reasonCode === 'RUN_BUDGET_EXHAUSTED',
            'M2: the honest terminal decision remains incomplete under the exhausted budget');
          const evaluated = (decision.evaluatedPostconditions || []).find(item => item.type === 'fileContains');
          assert(evaluated && evaluated.passed === false &&
            evaluated.reasonCode === 'POSTCONDITION_EVALUATION_FAILED',
            'M2: the negative is still represented as observed-unsatisfied, never unavailable');
          const finalTicket = await store.getTicket(run.ticketId);
          assert(finalTicket.status !== 'completed',
            `M2: Ticket must not project COMPLETED on a bounded stall (got ${finalTicket.status})`);
          assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'p3-stall-' + STAMP + '.md')),
            'M2: no workspace mutation was ever committed');
        }
      }
    );

    // 26. P3-R1 M3: wrong write with complete:false. The declared Run must NOT
    // stop through the successful-mutation shortcut or the redundant-operation
    // heuristic, the negative criterion observation stays durable, and the same
    // Run continues a bounded turn. The contract compiler is disabled so the
    // final-step incomplete-mutation budget guard stays out of the way and the
    // plain execution step limit owns the bound.
    await runScenario(
      preloadPath,
      agent,
      `create file p3-declared-false-${STAMP}.md containing P3FALSE`,
      {
        ENABLE_MODEL_CONTRACT_COMPILER: 'false',
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'failed',
        verify: async ({ run, snapshot }) => {
          assert(snapshot.failure && (snapshot.failure.code === 'RUN_BUDGET_EXHAUSTED' ||
            snapshot.failure.code === 'RUN_LIMIT_EXCEEDED'),
            `M3: bounded continuation terminalizes at an execution budget limit (got ${snapshot.failure && snapshot.failure.code})`);
          const observationEvents = snapshot.events.filter(e => e.type === 'run:direct_postcondition_observed');
          assert(observationEvents.length >= 1, 'M3: the post-batch negative criterion evidence is durable');
          const lastEntry = observationEvents[observationEvents.length - 1].observations[0];
          assert(lastEntry && lastEntry.path === 'p3-declared-false-' + STAMP + '.md' && lastEntry.present === false,
            'M3: the latest observation is the bound deterministic negative');
          assert(snapshot.parsedModelPlans.length === 3,
            'M3: the same Run continued past the first wrong write instead of stopping');
          assert(!snapshot.events.some(event => event.type === 'workspace.objective_satisfied'),
            'M3: no receipt shortcut fires for the declared policy');
          assert(!snapshot.events.some(event => event.type === 'run:postcondition_completed'),
            'M3: neither the redundant-operation heuristic nor any other shortcut claims the declared Run');
          assert(!snapshot.events.some(event => event.type === 'run:contract_completion_deferred'),
            'M3: complete:false responses do not enter the deferred declared completion seam');
          const storedRun = await waitForStoredRun(run.id, item => item.runConsequence);
          const decision = storedRun.runConsequence.completionDecision;
          assert(decision && decision.completionDisposition === 'incomplete',
            'M3: the bounded terminal decision stays incomplete');
          const evaluated = (decision.evaluatedPostconditions || []).find(item => item.type === 'fileContains');
          assert(evaluated && evaluated.passed === false &&
            evaluated.reasonCode === 'POSTCONDITION_EVALUATION_FAILED',
            'M3: the durable negative stays observed-unsatisfied, never unavailable');
          const finalTicket = await store.getTicket(run.ticketId);
          assert(finalTicket.status !== 'completed',
            `M3: Ticket must not project COMPLETED on the negative (got ${finalTicket.status})`);
        }
      }
    );

    // 26. P3-R1 M7: persistent unsatisfied work with complete:true stays
    // bounded by the existing execution limits; no infinite keep-trying loop.
    // The contract compiler is disabled so the bound is owned by the plain
    // execution step limit deterministically.
    await runScenario(
      preloadPath,
      agent,
      `create file p3-persistent-${STAMP}.md containing P3PERSIST`,
      {
        ENABLE_MODEL_CONTRACT_COMPILER: 'false',
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'failed',
        verify: async ({ run, snapshot }) => {
          assert(snapshot.failure && (snapshot.failure.code === 'RUN_BUDGET_EXHAUSTED' ||
            snapshot.failure.code === 'RUN_LIMIT_EXCEEDED'),
            `M7: persistent unsatisfied work stops at an execution budget limit (got ${snapshot.failure && snapshot.failure.code})`);
          assert(snapshot.parsedModelPlans.length === 3,
            'M7: exactly the bounded number of turns ran, then the limit terminalized');
          const deferredEvents = snapshot.events.filter(e => e.type === 'run:contract_completion_deferred');
          assert(deferredEvents.length === 3,
            `M7: every premature complete:true with a false criterion was deferred (got ${deferredEvents.length})`);
          assert(!snapshot.events.some(event => event.type === 'workspace.objective_satisfied'),
            'M7: no receipt shortcut fires for the declared policy');
          const finalTicket = await store.getTicket(run.ticketId);
          assert(finalTicket.status !== 'completed',
            `M7: Ticket must not project COMPLETED on persistently unsatisfied work (got ${finalTicket.status})`);
          const workspaceOperations = (snapshot.workspaceOperations || [])
            .filter(item => item && item.operation && item.operation.operation === 'writeFile' &&
              item.operation.args.path === 'p3-persistent-' + STAMP + '.md' && !item.error);
          assert(workspaceOperations.length === 3,
            `M7: each bounded turn's wrong write was committed and bounded (got ${workspaceOperations.length})`);
        }
      }
    );

    // 27. P3-R1 blanket redundant-operation exclusion, unavailable/mixed state:
    // a declared Run whose mutation is a redundant no-op on an unrelated path
    // while the admitted criterion is structurally unobservable. The heuristic
    // must never claim the Run, and the unavailable criterion must not become
    // a continuation hinge; the existing plain stop and canonical blocked
    // decision remain.
    fs.mkdirSync(path.join(WORKSPACE_ROOT, `p3-mixed-unavailable-${STAMP}.md`), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_ROOT, `p3-mixed-other-${STAMP}.md`), 'mixed baseline');
    await runScenario(
      preloadPath,
      agent,
      `create file p3-mixed-unavailable-${STAMP}.md containing P3MIXED`,
      {
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      {
        expectedStatus: 'completed',
        verify: async ({ run, snapshot }) => {
          assert(!snapshot.events.some(event => event.type === 'run:postcondition_completed'),
            'M5b: the redundant-operation heuristic never claims a declared-postcondition Run, even with unavailable criteria');
          assert(!snapshot.events.some(event => event.type === 'run:contract_completion_deferred'),
            'M5b: unavailable criterion state never becomes a deferred continuation hinge');
          assert(snapshot.parsedModelPlans.length === 1,
            'M5b: the Run settled on the existing plain completion stop in one bounded turn');
          assert(fs.readFileSync(path.join(WORKSPACE_ROOT, `p3-mixed-other-${STAMP}.md`), 'utf8') === 'mixed baseline',
            'M5b: the redundant identical write stayed a no-op');
          const storedRun = await waitForStoredRun(run.id, item => item.runConsequence);
          const decision = storedRun.runConsequence.completionDecision;
          assert(decision && decision.completionDisposition === 'blocked' &&
            decision.reasonCode === 'VERIFICATION_UNAVAILABLE',
            'M5b: the canonical decision stays fail-closed blocked on the unavailable criterion');
          const finalTicket = await waitForStoredTicket(run.ticketId, item => item.status !== 'in_progress');
          assert(finalTicket && finalTicket.status !== 'completed',
            `M5b: Ticket must not project COMPLETED on the unavailable criterion (got ${finalTicket && finalTicket.status})`);
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
      compiledPartialCompletionDeferred: true,
      r2ContainsPresentCompleted: true,
      declaredContinuationCorrectedOnce: true,
      r2ContainsUnavailableBlocked: true,
      declaredZeroActionDeferredStallBounded: true,
      declaredFalseContinuedBounded: true,
      declaredPersistentBounded: true,
      declaredMixedUnavailableExclusion: true,
      r2AmbiguousNotAdmitted: true
    }));
  } finally {
    // Workspace and schema cleanup belong to the shared harness. The generated
    // provider preload stays until the suite is fully done (main() unlinks it
    // after the crafted controls below), so a later block can still start a
    // server with it.
  }
}

async function main() {
  const preloadPath = createFakeOpenAIPreload();
  try {
    await withHarness('postcondition completion', async ({ store, workspaceRoot, startServer }) => {

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
          `${objective}: run status ${run.status} === ${expectations.expectedStatus} (run error: ${run.error || 'none'})`);

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

    // ── P3-R1 M5: receipt-policy shortcut eligibility is decided ONLY by the
    // Run's immutable completion-authority snapshot. Two crafted direct-write
    // Runs with identical objectives and identical provider behavior differ
    // only in the admitted snapshot: a Run whose proven policy is
    // workspace_objective_receipt keeps the predecessor successful-mutation
    // shortcut, while a Run admitted WITHOUT the snapshot withholds it
    // fail-closed — never defaulted on. ────────────────────────────────────────
    {
      const now = () => new Date().toISOString();
      const m5Server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        ENABLE_MODEL_CONTRACT_COMPILER: 'false',
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200'
      } });
      try {
        const makeCraftedRun = async (objective, completionAuthoritySnapshot) => {
          const ticket = (await store.createTicketWithEvent({
            ticket: {
              objective, acceptanceCriteria: null,
              assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
              ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
              workflowId: null, workflowInput: null,
              capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
              executionPolicy: {
                mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
                maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
                allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
              },
              workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
              status: 'open', createdBy: 'postcondition-completion-test', changedBy: 'postcondition-completion-test',
              changedAt: now(), createdAt: now(), updatedAt: now()
            },
            eventPayload: { source: 'postcondition-completion-test' }
          })).ticket;
          return store.createRun({
            ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
            runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot({
              maxExecutionSteps: 3,
              maxModelRequestsPerRun: 3,
              maxWorkspaceOperationsPerRun: 10,
              maxRuntimeDurationMs: 10000
            }),
            executionPolicySnapshot: { requireVerification: 'when_declared' },
            ...(completionAuthoritySnapshot ? { completionAuthoritySnapshot } : {}),
            status: 'pending'
          });
        };
        const waitForCraftedTerminal = async (runId, label) => {
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            const current = await store.getRun(runId);
            if (current && ['completed', 'failed', 'interrupted'].includes(current.status)) return current;
            await sleep(200);
          }
          throw new Error(`timed out waiting for the ${label} crafted run to terminalize`);
        };
        const replayEventsOf = async runId => {
          const replay = await store.readRunReplay(runId);
          return replay && replay.snapshot && Array.isArray(replay.snapshot.events)
            ? replay.snapshot.events : [];
        };

        // Positive control: the proven receipt policy keeps the shortcut.
        const receiptObjective = `write note p3-shortcut-receipt-${STAMP}.md`;
        const receiptAuthority = buildCompletionAuthoritySnapshot({
          objective: receiptObjective,
          kind: 'deterministic',
          recognized: true,
          intent: 'direct_write',
          completionPolicy: 'workspace_objective_receipt',
          directPostconditions: [],
          verificationPolicy: 'when_declared',
          capturedAt: now()
        });
        const receiptRun = await makeCraftedRun(receiptObjective, receiptAuthority);
        const receiptTerminal = await waitForCraftedTerminal(receiptRun.id, 'receipt-policy');
        const receiptEvents = await replayEventsOf(receiptRun.id);
        assert(receiptTerminal.status === 'completed',
          `M5: the proven receipt-policy Run settles completed (got ${receiptTerminal.status})`);
        assert(receiptEvents.some(event =>
          event.type === 'workspace.objective_satisfied' &&
          Array.isArray(event.objectivePaths) &&
          event.objectivePaths.includes(`p3-shortcut-receipt-${STAMP}.md`)),
          'M5: the predecessor successful-mutation shortcut still fires where the receipt policy is proven from the snapshot');
        assert(receiptEvents.filter(event => event.parsedModelPlans || event.type === 'model:stalled').length === 0,
          'M5: the receipt-policy Run needed no further model turn');

        // Fail-closed control: no snapshot withholds the shortcut entirely. The
        // Run continues past the first turn (the predecessor would have stopped
        // there through the shortcut) and only then settles through the
        // unchanged redundant-operation heuristic, which stays eligible for
        // non-declared policies.
        const withheldObjective = `write note p3-shortcut-withhold-${STAMP}.md`;
        const withheldRun = await makeCraftedRun(withheldObjective, null);
        const withheldTerminal = await waitForCraftedTerminal(withheldRun.id, 'snapshot-withhold');
        const withheldEvents = await replayEventsOf(withheldRun.id);
        assert(withheldTerminal.status === 'completed',
          `M5: the snapshot-less Run continues while bounded and settles through the unchanged heuristic ` +
          `(got status=${withheldTerminal.status} error=${withheldTerminal.error} ` +
          `events=${JSON.stringify((withheldEvents || []).map(e => e.type))})`);
        assert(withheldEvents.some(event => event.type === 'workspace.objective_satisfied') === false,
          'M5: the successful-mutation shortcut is WITHHELD when the admitted policy cannot be proven');
        assert(withheldEvents.filter(event => event.type === 'model:action_contract_passed').length === 2,
          'M5: the withheld Run continued exactly one more bounded turn instead of shortcut-stopping');
        const withheldClaim = withheldEvents.find(event =>
          event.type === 'run:postcondition_completed');
        assert(withheldClaim && withheldClaim.source === 'redundant_operation',
          'M5: the unchanged redundant-operation heuristic remains eligible for the non-declared policy');

        // ── F1: the PRESENT-but-unreadable completion-authority control ──────
        //
        // The third fail-closed input state. The snapshot is PRESENT and
        // structurally recognizable but fails the SAME canonical
        // normalization the production gate calls (its immutable snapshotHash
        // integrity field is tampered), so no admitted policy can be proven
        // from it. The shortcut must be withheld exactly like the
        // missing-snapshot control above, no path may default the unreadable
        // authority to workspace_objective_receipt, and the canonical
        // completion-authority path keeps owning the integrity failure.
        const corruptObjective = `write note p3-shortcut-corrupt-${STAMP}.md`;
        const corruptSource = buildCompletionAuthoritySnapshot({
          objective: corruptObjective,
          kind: 'deterministic',
          recognized: true,
          intent: 'direct_write',
          completionPolicy: 'workspace_objective_receipt',
          directPostconditions: [],
          verificationPolicy: 'when_declared',
          capturedAt: now()
        });
        const corruptSnapshot = JSON.parse(JSON.stringify(corruptSource));
        const corruptedHash = 'f'.repeat(64);
        corruptSnapshot.snapshotHash = corruptedHash;

        // F1-F: the corruption is a NORMALIZATION FAILURE, not absence. The
        // same canonical normalizer the gate calls rejects the tampered
        // snapshot on integrity grounds while accepting the untouched
        // authority it was cloned from.
        let corruptionRejection = null;
        try { normalizeCompletionAuthoritySnapshot(corruptSnapshot); }
        catch (error) { corruptionRejection = error; }
        assert(corruptionRejection && corruptionRejection.code === 'COMPLETION_DECISION_CONFLICT',
          `F1: the crafted snapshot is PRESENT but rejected by canonical normalization ` +
          `(got ${corruptionRejection && corruptionRejection.code})`);
        assert(normalizeCompletionAuthoritySnapshot(corruptSource)
            .objectiveContract.completionPolicy === 'workspace_objective_receipt',
          'F1: the intact authority the corruption was cloned from remains a valid receipt snapshot');

        const corruptRun = await makeCraftedRun(corruptObjective, corruptSnapshot);
        const corruptRunRow = await store.getRun(corruptRun.id);
        // F1-A: the snapshot is PRESENT on the crafted Run, structurally
        // recognizable, and carries the corrupted integrity hash rather than
        // the canonical one.
        assert(corruptRunRow && corruptRunRow.completionAuthoritySnapshot &&
          corruptRunRow.completionAuthoritySnapshot.snapshotHash === corruptedHash &&
          corruptRunRow.completionAuthoritySnapshot.snapshotHash !== corruptSource.snapshotHash &&
          corruptRunRow.completionAuthoritySnapshot.objectiveContract &&
          corruptRunRow.completionAuthoritySnapshot.objectiveContract.completionPolicy ===
            'workspace_objective_receipt',
          'F1: the crafted Run retains a PRESENT, structurally recognizable completion-authority snapshot whose corrupted hash differs from the canonical valid snapshot');

        const readCraftedJournal = async runId => {
          const journal = [];
          let afterSeq = -1;
          for (;;) {
            const page = await store.listRunEvents(runId, { afterSeq, limit: 300 });
            if (!Array.isArray(page) || page.length === 0) break;
            journal.push(...page);
            afterSeq = page[page.length - 1].seq;
          }
          return journal;
        };
        const waitForCraftedJournalEvent = async (runId, predicate, timeoutMs, label) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const hit = (await readCraftedJournal(runId)).find(predicate);
            if (hit) return hit;
            await sleep(200);
          }
          throw new Error(`timed out waiting for ${label}`);
        };

        await waitForCraftedJournalEvent(corruptRun.id, event => event.type === 'run.started',
          30000, 'the corrupt-snapshot Run to be dispatched');
        // The integrity boundary fails before any execution; a bounded
        // stabilization window observes the stable fail-closed state (the
        // default lease keeps the pre-existing reclaim alarm out of this
        // window).
        await sleep(2500);
        const corruptJournal = await readCraftedJournal(corruptRun.id);
        const corruptTypes = corruptJournal.map(event => event.type);
        // F1-B: the shortcut is withheld for the unreadable authority.
        assert(corruptTypes.includes('workspace.objective_satisfied') === false,
          `F1: the successful-mutation shortcut is WITHHELD for the present-but-unreadable authority (journal=${JSON.stringify(corruptTypes)})`);
        // F1-C: no mutation ever executes, so the predecessor shortcut point is
        // deterministically never reached and cannot terminalize the Run — the
        // fail-closed response happens strictly earlier, at the canonical
        // run-start authority capture.
        assert(corruptTypes.every(type =>
          ['run.lease_acquired', 'scheduler.run_selected', 'run.started',
            'scheduler.run_skipped', 'run.recovery_claimed', 'run.resumed'].includes(type)),
          `F1: the corrupt-authority Run executes nothing — the shortcut point is never reached (journal=${JSON.stringify(corruptTypes)})`);
        // F1-D: no path defaults the unreadable authority to the receipt
        // policy: no receipt-shaped settlement, no postcondition claim, no
        // fabricated terminalization.
        assert(corruptTypes.includes('run.terminalized') === false &&
          corruptTypes.includes('run:postcondition_completed') === false,
          'F1: no path interpreted the corrupt snapshot as workspace_objective_receipt or settled the Run under it');
        const corruptCurrent = await store.getRun(corruptRun.id);
        assert(!['completed', 'failed', 'interrupted'].includes(corruptCurrent.status),
          `F1: the corrupt-authority Run does not shortcut-terminalize (status=${corruptCurrent.status})`);
        assert(!(await store.readRunReplay(corruptRun.id)),
          'F1: the canonical authority path refused the run-start capture before fabricating any replay evidence');
        // F1-E: the pre-existing run-start integrity refusal is observed intact:
        // dispatch starts, the canonical completion-authority capture refuses the
        // corrupt snapshot before any work, and the Run remains unsettled under
        // the existing recovery machinery. P3-R1 neither changed nor widened that
        // behavior.
        assert(corruptTypes.includes('run.started'),
          'F1: the pre-existing run-start integrity refusal is observed intact — dispatch starts, the canonical completion-authority capture refuses the corrupt snapshot before work, and the Run remains unsettled under the existing recovery machinery; P3-R1 neither changed nor widened that behavior');
        assert(fs.existsSync(path.join(workspaceRoot, `p3-shortcut-corrupt-${STAMP}.md`)) === false,
          'F1: the corrupt-authority Run committed no workspace mutation');

        // F1-F gate-level: the unreadable branch of the production gate is
        // exercised directly. The actual gate source is executed against the
        // REAL canonical normalizer, so the assertion pins the intended
        // behavior itself: absent OR normalization-invalid authority yields no
        // admitted policy, and the exact shortcut-site condition therefore
        // withholds instead of defaulting to the receipt policy.
        const gateSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const gatePolicy = new Function('normalizeCompletionAuthoritySnapshot',
          `${extractServerFunction(gateSource, 'getRunAdmittedCompletionPolicy')}\n` +
          'return getRunAdmittedCompletionPolicy;')(
          normalizeCompletionAuthoritySnapshot);
        assert(gatePolicy({ completionAuthoritySnapshot: corruptSource }) ===
          'workspace_objective_receipt',
          'F1: the gate provenance is real — the intact receipt authority reads as the receipt policy through the same helper');
        assert(gatePolicy({}) === null,
          'F1: the gate helper yields no admitted policy for an absent snapshot');
        assert(gatePolicy({ completionAuthoritySnapshot: corruptSnapshot }) === null &&
          gatePolicy({ completionAuthoritySnapshot: corruptSnapshot }) !== 'workspace_objective_receipt',
          'F1: the gate helper yields no admitted policy for the PRESENT-but-normalization-invalid snapshot and never defaults to the receipt policy');
      } finally {
        await m5Server.stop();
      }
    }

    console.log(`\nPASS: postcondition completion, workflow drafts, and handoffs — ${assert.count()} assertions (PostgreSQL-native, 25 scenarios)`);
  });
  } finally {
    // The generated provider preload is owned by this suite and outlives the
    // harness body so every block can start servers with it.
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}


main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
