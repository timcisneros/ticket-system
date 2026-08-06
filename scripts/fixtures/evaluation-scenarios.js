'use strict';

// Tranche 6 — the canonical scenario catalog.
//
// A scenario states, up front and independently of any product record, what
// work is asked for and what raw end state would mean it was actually done.
// Nothing here treats a product completion answer as truth: the oracle contract
// is expressed purely as filesystem expectations plus, for family 4, the
// fixture-owned access log.
//
// ARM-INDEPENDENT BY CONSTRUCTION. A scenario supplies one objective, one
// declared-work document and one set of fixture responses keyed by logical
// task. Which of those requests a given arm actually issues is the product's
// behaviour and the thing being measured; the scenario never varies its content
// by arm.
//
// `allowedArms` exists for a different reason: some scenarios are only
// meaningful where the path can express them at all. A sibling-dependency
// scenario still RUNS on an arm without sibling authority — a truthful block or
// failure there is valid trial data, not a scenario error — so family 3 allows
// every arm. Family 7's churn controls, by contrast, need governed progress
// control to exist, so they are limited to the structured arms and say why.

const crypto = require('node:crypto');
const {
  buildScenarioExpectation
} = require('./evaluation-oracle');
const {
  expectedProducerBytes
} = require('./evaluation-coupling-oracle');

const PROTOCOL_VERSION = 1;
const ALL_ARMS = Object.freeze(['A', 'A2a', 'A2b', 'B', 'C']);
const STRUCTURED_ARMS = Object.freeze(['B', 'C']);

class EvaluationScenarioError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EvaluationScenarioError';
    this.detail = detail;
  }
}

// A worker response body is the execution JSON the agent loop parses. Built
// here so every scenario emits the same shape and a typo cannot silently become
// an unparseable response that looks like a model failure.
function workerPlan({ message, actions = [], complete = false }) {
  return JSON.stringify({ message, actions, complete });
}

function createFolder(pathValue) {
  return { operation: 'createFolder', args: { path: pathValue } };
}

function writeFile(pathValue, content) {
  return { operation: 'writeFile', args: { path: pathValue, content } };
}

// A REAL read through the production workspace operation.
//
// Families 3 and 4 ask whether a dependent task genuinely consumed a sibling's
// output. Previously the staged consumer response only WROTE a summary already
// containing the producer hash, so no read ever happened and there was nothing
// to observe. The consumer now issues a real `readFile`, which production
// executes through the workspace provider — and which the shared observation
// sink sees returning the exact bytes.
function readFile(pathValue) {
  return { operation: 'readFile', args: { path: pathValue } };
}

// THE MODEL-OWNED PROPOSAL, and only the model-owned parts.
//
// `normalizePlannerProposal` accepts exactly `version`, `sharedConstraints` and
// `items`, and each item exactly `assignedAgentId`, `objective`,
// `expectedOutputs`, `successCriteria` and `evidenceRequirements` — the last of
// which must be EMPTY, because evidence identities are runtime-bound. Owned
// output paths are deliberately absent: production assigns them, which is
// precisely why one proposal serves both the allocated and dynamic arms.
//
// `assignedAgentId` is a real agent id created per trial, so a proposal cannot
// be frozen in the catalog; it is materialized from the planning request's own
// candidate agents. That keeps response selection keyed by scenario, task,
// seed, role and ordinal — never by the arm.
function plannerProposal(items) {
  return JSON.stringify({
    version: 1,
    sharedConstraints: [
      { kind: 'text', declaration: 'Write only inside your own allocated path' }
    ],
    items
  });
}

function proposalItem({ assignedAgentId, objective, output, criterion }) {
  return {
    assignedAgentId,
    objective,
    expectedOutputs: [{ kind: 'text', declaration: output }],
    successCriteria: [{ kind: 'text', declaration: criterion }],
    evidenceRequirements: []
  };
}

const SCENARIOS = Object.freeze({

  // ── FAMILY 1 — the five-arm smoke control ────────────────────────────────
  //
  // Deliberately the smallest thing that is still real work: two declared
  // folders under the group's owned roots. Every arm can attempt it without
  // changing the substantive expected raw result, which is what makes it a
  // routing and harness-integrity probe rather than a comparison.
  'family-1-simple': Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: 'family-1-simple',
    version: 1,
    family: 1,
    objective: 'Create folders reports/alpha and reports/beta',
    // THREE top-level folders, and none is decoration: dynamic allocation
    // refuses a ticket with fewer usable top-level directories than the group
    // has agents, and the structured dynamic arm carries a planner in the group
    // as well as two workers. The initial state is identical for every arm, so
    // it remains a controlled variable rather than an arm-specific setup.
    initialState: Object.freeze({
      folders: Object.freeze(['reports', 'reports-b', 'reports-c'])
    }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/alpha and reports/beta',
      expectedOutputs: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'One folder per declared path' })
      ]),
      successCriteria: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'Both declared folders exist' })
      ]),
      evidenceRequirements: Object.freeze([])
    }),
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports-b/beta/' }),
    logicalTasks: Object.freeze(['alpha', 'beta']),
    plannerResponseTemplate: Object.freeze({
      role: 'planner', logicalTaskId: 'plan', ordinal: 1,
      inputTokens: 400, outputTokens: 120,
      itemObjectives: Object.freeze([
        'Create the alpha report folder inside your allocated path',
        'Create the beta report folder inside your allocated path'
      ])
    }),
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Creating the alpha folder.',
          actions: [createFolder('reports/alpha')], complete: true
        })
      }),
      Object.freeze({
        role: 'worker', logicalTaskId: 'beta', ordinal: 1,
        match: 'reports-b/beta', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Creating the beta folder.',
          actions: [createFolder('reports-b/beta')], complete: true
        })
      }),
      // Any additional captured candidate — the planner agent is a group member
      // and therefore receives an allocation item of its own. Its output is not
      // part of the objective, so the oracle does not expect it.
      Object.freeze({
        role: 'worker', logicalTaskId: 'extra', ordinal: 1,
        match: 'reports/agent-', inputTokens: 260, outputTokens: 50,
        body: workerPlan({
          message: 'Creating the allocated folder.',
          actions: [createFolder('reports/agent-2/output')], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([]),
    allowedArms: ALL_ARMS,
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({ kind: 'folder_exists', path: 'reports/alpha' }),
        Object.freeze({ kind: 'folder_exists', path: 'reports-b/beta' })
      ])
    }),
    expectedQuiescence: 'quiescent',
    isolation: 'fresh workspace, fresh fixture namespace, fresh Ticket per trial'
  }),

  // ── FAMILY 3 — legitimate sibling dependency ─────────────────────────────
  //
  // The consumer must read the producer's exact seed-derived artifact and bind
  // its hash. Runs on every arm on purpose: an arm without sibling authority
  // producing a truthful block or failure is valid trial data, and rewriting
  // the scenario so every arm succeeds would delete the thing being measured.
  'family-3-sibling-dependency': Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: 'family-3-sibling-dependency',
    version: 1,
    family: 3,
    objective: 'Create folders reports/producer/out and reports/consumer/out',
    // THREE top-level folders, matching family 1.
    //
    // Dynamic allocation derives one owned root PER AGENT from the usable
    // top-level workspace directories and refuses when there are fewer
    // directories than agents. A single `reports` folder therefore makes every
    // dynamic arm unreachable — the trial would fail at ticket creation rather
    // than exercising the scenario. The extra roots are fixture setup only; no
    // oracle expectation reads them.
    initialState: Object.freeze({
      folders: Object.freeze(['reports', 'reports-b', 'reports-c'])
    }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/producer/out and reports/consumer/out',
      expectedOutputs: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'A producer artifact and a bound consumer summary' })
      ]),
      successCriteria: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'The consumer summary binds the producer artifact' })
      ]),
      evidenceRequirements: Object.freeze([])
    }),
    ownedOutputPaths: Object.freeze({
      producer: 'reports/producer/', consumer: 'reports/consumer/'
    }),
    logicalTasks: Object.freeze(['producer', 'consumer']),
    // ONE ITEM PER CAPTURED CANDIDATE, bound to REAL agent ids.
    //
    // A frozen proposal cannot name the agents a trial actually created, and
    // lowering refuses a proposal that omits any captured candidate — so a
    // static proposal made every structured arm refuse the plan before any leaf
    // Run existed. The template is expanded against the planning request's own
    // candidate list, exactly as family 1 does.
    plannerResponseTemplate: Object.freeze({
      role: 'planner', logicalTaskId: 'plan', ordinal: 1,
      inputTokens: 400, outputTokens: 120,
      itemObjectives: Object.freeze([
        'Produce the artifact in your allocated path',
        'Consume the produced artifact in your allocated path'
      ])
    }),
    // The producer body is seed-dependent, so it is generated per trial by
    // `materializeResponses` rather than frozen here.
    // The planner agent is a group member and receives an allocation item of
    // its own. Its output is not part of the coupling question, and the oracle
    // does not read it.
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'extra', ordinal: 1,
        match: 'reports/agent-', inputTokens: 260, outputTokens: 50,
        body: workerPlan({
          message: 'Creating the allocated folder.',
          actions: [createFolder('reports/agent-2/output')], complete: true
        })
      })
    ]),
    workerResponseTemplates: Object.freeze([
      Object.freeze({ role: 'worker', logicalTaskId: 'producer', ordinal: 1,
        match: 'reports/producer', kind: 'produce_seeded_artifact' }),
      Object.freeze({ role: 'worker', logicalTaskId: 'consumer', ordinal: 1,
        match: 'reports/consumer', kind: 'consume_and_bind' })
    ]),
    externalEffects: Object.freeze(['consumer reads the producer artifact']),
    allowedArms: ALL_ARMS,
    oracle: Object.freeze({
      kind: 'coupling',
      producerPath: 'reports/producer/artifact.txt',
      consumerPath: 'reports/consumer/summary.md',
      consumerReaderId: 'consumer'
    }),
    expectedQuiescence: 'quiescent',
    isolation: 'fresh workspace, fresh fixture namespace, fresh Ticket per trial'
  }),

  // ── FAMILY 4 — apparently separable, actually coupled ────────────────────
  //
  // Same mechanism as family 3, but the objective deliberately *looks*
  // separable. The coupling oracle is what tells a correct run from a lucky
  // one; see the protocol §4a.
  'family-4-coupled': Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: 'family-4-coupled',
    version: 1,
    family: 4,
    objective: 'Create folders reports/left/out and reports/right/out',
    // THREE top-level folders, matching family 1.
    //
    // Dynamic allocation derives one owned root PER AGENT from the usable
    // top-level workspace directories and refuses when there are fewer
    // directories than agents. A single `reports` folder therefore makes every
    // dynamic arm unreachable — the trial would fail at ticket creation rather
    // than exercising the scenario. The extra roots are fixture setup only; no
    // oracle expectation reads them.
    initialState: Object.freeze({
      folders: Object.freeze(['reports', 'reports-b', 'reports-c'])
    }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/left/out and reports/right/out',
      expectedOutputs: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'Two apparently independent outputs' })
      ]),
      successCriteria: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'The right output binds the left artifact' })
      ]),
      evidenceRequirements: Object.freeze([])
    }),
    ownedOutputPaths: Object.freeze({ left: 'reports/left/', right: 'reports/right/' }),
    logicalTasks: Object.freeze(['left', 'right']),
    // ONE ITEM PER CAPTURED CANDIDATE, bound to REAL agent ids.
    //
    // A frozen proposal cannot name the agents a trial actually created, and
    // lowering refuses a proposal that omits any captured candidate — so a
    // static proposal made every structured arm refuse the plan before any leaf
    // Run existed. The template is expanded against the planning request's own
    // candidate list, exactly as family 1 does.
    plannerResponseTemplate: Object.freeze({
      role: 'planner', logicalTaskId: 'plan', ordinal: 1,
      inputTokens: 400, outputTokens: 120,
      itemObjectives: Object.freeze([
        'Produce the left artifact in your allocated path',
        'Produce the right summary in your allocated path'
      ])
    }),
    // The planner agent is a group member and receives an allocation item of
    // its own. Its output is not part of the coupling question, and the oracle
    // does not read it.
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'extra', ordinal: 1,
        match: 'reports/agent-', inputTokens: 260, outputTokens: 50,
        body: workerPlan({
          message: 'Creating the allocated folder.',
          actions: [createFolder('reports/agent-2/output')], complete: true
        })
      })
    ]),
    workerResponseTemplates: Object.freeze([
      Object.freeze({ role: 'worker', logicalTaskId: 'left', ordinal: 1,
        match: 'reports/left', kind: 'produce_seeded_artifact' }),
      Object.freeze({ role: 'worker', logicalTaskId: 'right', ordinal: 1,
        match: 'reports/right', kind: 'consume_and_bind' })
    ]),
    externalEffects: Object.freeze(['right reads the left artifact']),
    allowedArms: ALL_ARMS,
    oracle: Object.freeze({
      kind: 'coupling',
      producerPath: 'reports/left/artifact.txt',
      consumerPath: 'reports/right/summary.md',
      consumerReaderId: 'right'
    }),
    expectedQuiescence: 'quiescent',
    isolation: 'fresh workspace, fresh fixture namespace, fresh Ticket per trial'
  }),

  // ── FAMILY 7 — genuine churn and its neighbouring controls ───────────────
  //
  // Structured arms only, and the reason is stated rather than implied: churn
  // control does not exist on the direct and legacy paths, so those arms cannot
  // express the distinction this family measures.
  'family-7-no-progress': Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: 'family-7-no-progress',
    version: 1,
    family: 7,
    objective: 'Create folders reports/alpha/done and reports-b/beta/done',
    // THREE top-level folders, matching family 1.
    //
    // Dynamic allocation derives one owned root PER AGENT from the usable
    // top-level workspace directories and refuses when there are fewer
    // directories than agents. A single `reports` folder therefore makes every
    // dynamic arm unreachable — the trial would fail at ticket creation rather
    // than exercising the scenario. The extra roots are fixture setup only; no
    // oracle expectation reads them.
    initialState: Object.freeze({
      folders: Object.freeze(['reports', 'reports-b', 'reports-c'])
    }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/alpha/done and reports-b/beta/done',
      expectedOutputs: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'One folder per declared path' })
      ]),
      successCriteria: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'Both declared folders exist' })
      ]),
      evidenceRequirements: Object.freeze([])
    }),
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    // ONE ITEM PER CAPTURED CANDIDATE, bound to REAL agent ids.
    //
    // A frozen proposal cannot name the agents a trial actually created, and
    // lowering refuses a proposal that omits any captured candidate — so a
    // static proposal made every structured arm refuse the plan before any leaf
    // Run existed. The template is expanded against the planning request's own
    // candidate list, exactly as family 1 does.
    plannerResponseTemplate: Object.freeze({
      role: 'planner', logicalTaskId: 'plan', ordinal: 1,
      inputTokens: 400, outputTokens: 120,
      itemObjectives: Object.freeze([
        'Create your allocated report folder'
      ])
    }),
    // Honest work that advances no ADMITTED fact: it creates a real folder
    // nobody declared. Delivered to execution, receipts and evidence complete —
    // therefore genuinely churn-eligible.
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Creating a scratch folder.',
          actions: [createFolder('reports/alpha/scratch')], complete: false
        })
      }),
      // Any additional captured candidate. The planner agent is itself a group
      // member and receives an allocation item, so a proposal that covers every
      // candidate needs a response for it too. Its output is not part of the
      // objective, and no oracle expectation reads it.
      Object.freeze({
        role: 'worker', logicalTaskId: 'extra', ordinal: 1,
        match: 'reports/agent-', inputTokens: 260, outputTokens: 50,
        body: workerPlan({
          message: 'Creating the allocated folder.',
          actions: [createFolder('reports/agent-2/output')], complete: true
        })
      })
    ]),
    // The neighbouring controls, named so a reader can see what is NOT churn.
    controls: Object.freeze({
      durable_but_undelivered: 'after_transport_before_response',
      incomplete_evidence: 'receipts committed, evidence set withheld',
      verified_progress: 'creates the admitted folder and is credited'
    }),
    // EXECUTABLE VARIANTS. Each one is a distinct trial with its own staged
    // responses; the runner selects exactly one. `7A` is the canonical variant
    // and is what the bare scenario already stages.
    defaultVariant: '7A',
    variants: Object.freeze({
      '7A': Object.freeze({
        variantId: '7A',
        label: 'fully evaluated no progress — churn-eligible',
        // Honest work that advances no ADMITTED fact. Delivered, receipts and
        // evidence complete, so it is genuinely a no-progress window.
        expectation: Object.freeze({
          durableResponse: true, deliveredToExecution: true,
          evidenceComplete: true, newlySatisfiedFacts: 0, churnEligible: true
        })
      }),
      '7B': Object.freeze({
        variantId: '7B',
        label: 'durable but not delivered — NOT churn',
        // The bytes reach the provider and no response comes back. Nothing was
        // delivered to execution, so no window may be judged at all.
        failureBoundary: 'after_transport_before_response',
        expectation: Object.freeze({
          durableResponse: false, deliveredToExecution: false,
          evidenceComplete: false, newlySatisfiedFacts: 0, churnEligible: false
        })
      }),
      '7C': Object.freeze({
        variantId: '7C',
        label: 'incomplete evidence — refuses rather than scoring zero progress',
        // A response that proposes work the evidence boundary cannot complete.
        // The transition reader must refuse rather than read it as zero
        // progress, because "not evaluable" and "evaluated as none" are
        // different facts.
        workerResponses: Object.freeze([
          Object.freeze({
            role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
            match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
            body: workerPlan({
              message: 'Reporting without a completable evidence boundary.',
              actions: [], complete: false
            })
          })
        ]),
        expectation: Object.freeze({
          durableResponse: true, deliveredToExecution: true,
          evidenceComplete: false, newlySatisfiedFacts: 0, churnEligible: false
        })
      }),
      '7D': Object.freeze({
        variantId: '7D',
        label: 'verified progress — credited exactly once',
        // Creates the ADMITTED folder, so exactly one admitted fact becomes
        // newly satisfied. Repeating the same truth later must not be credited
        // again.
        workerResponses: Object.freeze([
          Object.freeze({
            role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
            match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
            body: workerPlan({
              message: 'Creating the admitted output.',
              actions: [createFolder('reports/alpha/done')], complete: true
            })
          })
        ]),
        // Inside the owned path, for the same reason as families 8 and 9: the
        // owned path itself is pre-created and would pass before any work.
        oracle: Object.freeze({
          kind: 'raw_state',
          expectations: Object.freeze([
            Object.freeze({ kind: 'folder_exists', path: 'reports/alpha/done' })
          ])
        }),
        expectation: Object.freeze({
          durableResponse: true, deliveredToExecution: true,
          evidenceComplete: true, newlySatisfiedFacts: 1, churnEligible: false
        })
      })
    }),
    externalEffects: Object.freeze([]),
    allowedArms: STRUCTURED_ARMS,
    allowedArmsReason:
      'churn control exists only on the governed structured path; the direct and ' +
      'legacy arms cannot express a no-progress window at all',
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        // The declared folder is NOT created, so the objective is genuinely
        // unmet. That is the point: the product should stop, and the oracle
        // should agree the work was not done.
        Object.freeze({ kind: 'path_absent', path: 'reports/alpha/alpha' }),
        Object.freeze({ kind: 'folder_exists', path: 'reports/alpha/scratch' })
      ])
    }),
    expectedQuiescence: 'quiescent',
    isolation: 'fresh workspace, fresh fixture namespace, fresh Ticket per trial'
  }),

  // ── FAMILY 8 — partial failure and recovery ──────────────────────────────
  'family-8-recovery': Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: 'family-8-recovery',
    version: 1,
    family: 8,
    objective: 'Create folders reports/alpha/done and reports-b/beta/done',
    // THREE top-level folders, matching family 1.
    //
    // Dynamic allocation derives one owned root PER AGENT from the usable
    // top-level workspace directories and refuses when there are fewer
    // directories than agents. A single `reports` folder therefore makes every
    // dynamic arm unreachable — the trial would fail at ticket creation rather
    // than exercising the scenario. The extra roots are fixture setup only; no
    // oracle expectation reads them.
    initialState: Object.freeze({
      folders: Object.freeze(['reports', 'reports-b', 'reports-c'])
    }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/alpha/done and reports-b/beta/done',
      expectedOutputs: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'One folder per declared path' })
      ]),
      successCriteria: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'Both declared folders exist' })
      ]),
      evidenceRequirements: Object.freeze([])
    }),
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    // ONE ITEM PER CAPTURED CANDIDATE, bound to REAL agent ids.
    //
    // A frozen proposal cannot name the agents a trial actually created, and
    // lowering refuses a proposal that omits any captured candidate — so a
    // static proposal made every structured arm refuse the plan before any leaf
    // Run existed. The template is expanded against the planning request's own
    // candidate list, exactly as family 1 does.
    plannerResponseTemplate: Object.freeze({
      role: 'planner', logicalTaskId: 'plan', ordinal: 1,
      inputTokens: 400, outputTokens: 120,
      itemObjectives: Object.freeze([
        'Create your allocated report folder'
      ])
    }),
    // Each boundary is its own trial variant; the runner selects one.
    boundaryVariants: Object.freeze({
      pre_transport: 'before_transport',
      uncertain_delivery: 'after_transport_before_response',
      durable_response: 'after_response',
      committed_effect: 'after_response'
    }),
    defaultVariant: '8C',
    variants: Object.freeze({
      '8A': Object.freeze({
        variantId: '8A',
        label: 'failure before transport — no bytes, no effect',
        failureBoundary: 'before_transport',
        expectation: Object.freeze({
          servedCalls: 0, durableResponse: false, committedEffects: 0,
          duplicateEffects: 0
        })
      }),
      '8B': Object.freeze({
        variantId: '8B',
        label: 'bytes sent, no durable response — delivery uncertain',
        failureBoundary: 'after_transport_before_response',
        expectation: Object.freeze({
          // EXACTLY one. A second served call would be a retransmission of an
          // uncertainly delivered request, which is the failure this variant
          // exists to rule out.
          servedCalls: 1, durableResponse: false, committedEffects: 0,
          duplicateEffects: 0
        })
      }),
      '8C': Object.freeze({
        variantId: '8C',
        label: 'durable response before downstream processing — reused, not resent',
        failureBoundary: 'none',
        expectation: Object.freeze({
          servedCalls: 1, durableResponse: true, committedEffects: 1,
          duplicateEffects: 0
        })
      }),
      '8D': Object.freeze({
        variantId: '8D',
        label: 'committed effect before later failure — never duplicated',
        failureBoundary: 'none',
        // The same single effect, observed for duplication rather than for
        // success. Recovery must not apply it twice.
        expectation: Object.freeze({
          servedCalls: 1, durableResponse: true, committedEffects: 1,
          duplicateEffects: 0
        })
      })
    }),
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Committing the alpha effect.',
          actions: [createFolder('reports/alpha/done')], complete: true
        })
      }),
      // Any additional captured candidate. The planner agent is itself a group
      // member and receives an allocation item, so a proposal that covers every
      // candidate needs a response for it too. Its output is not part of the
      // objective, and no oracle expectation reads it.
      Object.freeze({
        role: 'worker', logicalTaskId: 'extra', ordinal: 1,
        match: 'reports/agent-', inputTokens: 260, outputTokens: 50,
        body: workerPlan({
          message: 'Creating the allocated folder.',
          actions: [createFolder('reports/agent-2/output')], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([
      'fixture transcript distinguishes zero calls, one uncertain call, ' +
      'a reused durable response, one committed effect and a duplicate effect'
    ]),
    allowedArms: ALL_ARMS,
    // THE EFFECT IS OBSERVED INSIDE THE OWNED PATH, NOT THE OWNED PATH ITSELF.
    //
    // Production requires every owned output path to exist before a Run starts,
    // so the harness pre-creates `reports/alpha/`. An expectation of
    // `folder_exists reports/alpha` would therefore be satisfied before any work
    // happened — a trivially passing oracle that would report a pre-transport
    // failure as a success. The observed effect is a path only the worker's own
    // action creates.
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({ kind: 'folder_exists', path: 'reports/alpha/done' })
      ])
    }),
    expectedQuiescence: 'quiescent_or_truthful_failure',
    isolation: 'fresh workspace, fresh fixture namespace, fresh Ticket per trial'
  }),

  // ── FAMILY 9 — truthfulness and oracle ambiguity ─────────────────────────
  //
  // The model CLAIMS completion while doing nothing that satisfies the
  // objective. Production is expected to reject the claim; the oracle
  // independently reports the objective is unmet. No completion row is
  // corrupted to manufacture a false positive.
  'family-9-false-claim': Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: 'family-9-false-claim',
    version: 1,
    family: 9,
    objective: 'Create folders reports/alpha/done and reports-b/beta/done',
    // THREE top-level folders, matching family 1.
    //
    // Dynamic allocation derives one owned root PER AGENT from the usable
    // top-level workspace directories and refuses when there are fewer
    // directories than agents. A single `reports` folder therefore makes every
    // dynamic arm unreachable — the trial would fail at ticket creation rather
    // than exercising the scenario. The extra roots are fixture setup only; no
    // oracle expectation reads them.
    initialState: Object.freeze({
      folders: Object.freeze(['reports', 'reports-b', 'reports-c'])
    }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/alpha/done and reports-b/beta/done',
      expectedOutputs: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'One folder per declared path' })
      ]),
      successCriteria: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'Both declared folders exist' })
      ]),
      evidenceRequirements: Object.freeze([])
    }),
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    // ONE ITEM PER CAPTURED CANDIDATE, bound to REAL agent ids.
    //
    // A frozen proposal cannot name the agents a trial actually created, and
    // lowering refuses a proposal that omits any captured candidate — so a
    // static proposal made every structured arm refuse the plan before any leaf
    // Run existed. The template is expanded against the planning request's own
    // candidate list, exactly as family 1 does.
    plannerResponseTemplate: Object.freeze({
      role: 'planner', logicalTaskId: 'plan', ordinal: 1,
      inputTokens: 400, outputTokens: 120,
      itemObjectives: Object.freeze([
        'Create your allocated report folder'
      ])
    }),
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 280, outputTokens: 40,
        body: workerPlan({
          message: 'All declared work is complete.',
          actions: [], complete: true
        })
      }),
      // Any additional captured candidate. The planner agent is itself a group
      // member and receives an allocation item, so a proposal that covers every
      // candidate needs a response for it too. Its output is not part of the
      // objective, and no oracle expectation reads it.
      Object.freeze({
        role: 'worker', logicalTaskId: 'extra', ordinal: 1,
        match: 'reports/agent-', inputTokens: 260, outputTokens: 50,
        body: workerPlan({
          message: 'Creating the allocated folder.',
          actions: [createFolder('reports/agent-2/output')], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([]),
    allowedArms: ALL_ARMS,
    // Observed INSIDE the owned path. `reports/alpha/` is pre-created because
    // production requires owned paths to exist, so expecting it would make this
    // scenario pass without any work — exactly the false positive the family
    // exists to detect.
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({ kind: 'folder_exists', path: 'reports/alpha/summary' })
      ])
    }),
    expectedQuiescence: 'quiescent',
    isolation: 'fresh workspace, fresh fixture namespace, fresh Ticket per trial'
  }),

  // Raw state genuinely cannot decide: the declared output is a path whose kind
  // the oracle cannot determine, so it must REFUSE rather than guess.
  'family-9-oracle-refusal': Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: 'family-9-oracle-refusal',
    version: 2,
    family: 9,
    objective: 'Create folders reports/alpha/done and reports-b/beta/done',
    // THREE top-level folders, matching family 1.
    //
    // Dynamic allocation derives one owned root PER AGENT from the usable
    // top-level workspace directories and refuses when there are fewer
    // directories than agents. A single `reports` folder therefore makes every
    // dynamic arm unreachable — the trial would fail at ticket creation rather
    // than exercising the scenario. The extra roots are fixture setup only; no
    // oracle expectation reads them.
    initialState: Object.freeze({
      folders: Object.freeze(['reports', 'reports-b', 'reports-c']),
      // See the oracle note below: a FIFO is the undecidable observation.
      undecidablePaths: Object.freeze(['reports-c/undecidable'])
    }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/alpha/done and reports-b/beta/done',
      expectedOutputs: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'One folder per declared path' })
      ]),
      successCriteria: Object.freeze([
        Object.freeze({ kind: 'text', declaration: 'Both declared folders exist' })
      ]),
      evidenceRequirements: Object.freeze([])
    }),
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    // ONE ITEM PER CAPTURED CANDIDATE, bound to REAL agent ids.
    //
    // A frozen proposal cannot name the agents a trial actually created, and
    // lowering refuses a proposal that omits any captured candidate — so a
    // static proposal made every structured arm refuse the plan before any leaf
    // Run existed. The template is expanded against the planning request's own
    // candidate list, exactly as family 1 does.
    plannerResponseTemplate: Object.freeze({
      role: 'planner', logicalTaskId: 'plan', ordinal: 1,
      inputTokens: 400, outputTokens: 120,
      itemObjectives: Object.freeze([
        'Create your allocated report folder'
      ])
    }),
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Creating the alpha folder.',
          actions: [createFolder('reports/alpha')], complete: true
        })
      }),
      // Any additional captured candidate. The planner agent is itself a group
      // member and receives an allocation item, so a proposal that covers every
      // candidate needs a response for it too. Its output is not part of the
      // objective, and no oracle expectation reads it.
      Object.freeze({
        role: 'worker', logicalTaskId: 'extra', ordinal: 1,
        match: 'reports/agent-', inputTokens: 260, outputTokens: 50,
        body: workerPlan({
          message: 'Creating the allocated folder.',
          actions: [createFolder('reports/agent-2/output')], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([]),
    allowedArms: ALL_ARMS,
    // A path that is NEITHER a regular file nor a directory.
    //
    // The earlier definition expected a file at a directory path, which the
    // oracle correctly reports as a truthful FAIL rather than a refusal: the
    // file really is absent, and raw state can say so. A genuinely undecidable
    // observation needs a path whose KIND the oracle cannot interpret at all,
    // which a FIFO is — and unlike an unreadable file, it does not depend on the
    // uid the harness happens to run as.
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({
          kind: 'file_contains', path: 'reports-c/undecidable', contains: 'x'
        })
      ]),
      expectRefusal: true
    }),
    expectedQuiescence: 'quiescent',
    isolation: 'fresh workspace, fresh fixture namespace, fresh Ticket per trial'
  })
});

const SCENARIO_IDS = Object.freeze(Object.keys(SCENARIOS));

function getScenario(scenarioId) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) {
    throw new EvaluationScenarioError(
      `unknown scenario ${scenarioId}; known: ${SCENARIO_IDS.join(', ')}`);
  }
  return scenario;
}

function assertArmAllowed(scenario, armId) {
  if (!scenario.allowedArms.includes(armId)) {
    throw new EvaluationScenarioError(
      `scenario ${scenario.scenarioId} does not allow arm ${armId}` +
      (scenario.allowedArmsReason ? ` — ${scenario.allowedArmsReason}` : ''),
      { scenarioId: scenario.scenarioId, armId });
  }
  return true;
}

// Turn a scenario's response definitions into the staged table for one trial.
// Seed-dependent bodies are generated here, which is what stops a staged
// response from hard-coding the family 3/4 answer.
function materializeResponses(scenario, seed, { candidateAgentIds = [] } = {}) {
  if (typeof seed !== 'string' || !seed) {
    throw new EvaluationScenarioError('a trial seed is required');
  }
  const staged = [...(scenario.plannerResponses || []).map(response => ({
    ...response, protocolVersion: scenario.protocolVersion,
    scenarioId: scenario.scenarioId, seed
  }))];

  // The planner proposal binds real agent ids, so it is built from the
  // planning request's own candidates rather than frozen in the catalog.
  const template = scenario.plannerResponseTemplate;
  if (template && candidateAgentIds.length > 0) {
    // ONE ITEM PER CAPTURED CANDIDATE. Lowering refuses a proposal that omits
    // any candidate the planning authority captured — and the planner agent is
    // itself a group member, so it is a candidate too. Covering every candidate
    // is the contract, not a convenience.
    const items = candidateAgentIds.map((agentId, index) => proposalItem({
      assignedAgentId: agentId,
      objective: template.itemObjectives[index] ||
        `Create your allocated report folder (candidate ${index + 1})`,
      output: 'One declared folder',
      criterion: 'The declared folder exists'
    }));
    staged.push({
      protocolVersion: scenario.protocolVersion, scenarioId: scenario.scenarioId,
      seed, role: template.role, logicalTaskId: template.logicalTaskId,
      ordinal: template.ordinal, inputTokens: template.inputTokens,
      outputTokens: template.outputTokens, body: plannerProposal(items)
    });
  }

  for (const response of scenario.workerResponses || []) {
    staged.push({
      ...response, protocolVersion: scenario.protocolVersion,
      scenarioId: scenario.scenarioId, seed,
      // A variant's failure boundary applies to the WORKER request UNDER TEST —
      // the scenario's own declared logical task — and to nothing else.
      //
      // A structured trial also stages a filler response for the extra captured
      // candidate (the planner agent receives an allocation item of its own).
      // Applying the boundary to that too produced TWO injected refusals where
      // the variant declares one, which would read as a retransmission or as a
      // second failure the scenario never staged. An explicit boundary on the
      // response itself still wins, so a scenario can stage a mixed set.
      failureBoundary: response.failureBoundary ||
        (scenario.failureBoundary && scenario.failureBoundary !== 'none' &&
          (scenario.logicalTasks || []).includes(response.logicalTaskId)
          ? scenario.failureBoundary : undefined)
    });
  }

  for (const template of scenario.workerResponseTemplates || []) {
    const producerBytes = expectedProducerBytes(seed);
    const producerHash = crypto.createHash('sha256')
      .update(producerBytes).digest('hex');
    const base = {
      protocolVersion: scenario.protocolVersion, scenarioId: scenario.scenarioId,
      seed, role: template.role, logicalTaskId: template.logicalTaskId,
      ordinal: template.ordinal, match: template.match,
      producerPath: scenario.oracle.producerPath,
      inputTokens: 320, outputTokens: 90
    };
    if (template.kind === 'produce_seeded_artifact') {
      staged.push({
        ...base,
        body: workerPlan({
          message: 'Producing the seeded artifact.',
          actions: [
            createFolder(scenario.oracle.producerPath.replace(/\/[^/]+$/, '')),
            // THE DECLARED OBJECTIVE FOLDER.
            //
            // A governed leaf item is admitted only when it carries at least one
            // EXECUTION-EVALUABLE declared fact, and the evaluable criterion
            // types are folder_exists, path_absent and file_content_equals. The
            // objective therefore names folders, and the work creates them —
            // otherwise the item admits a fact the work never satisfies.
            createFolder(`${scenario.oracle.producerPath.replace(/\/[^/]+$/, '')}/out`),
            writeFile(scenario.oracle.producerPath, producerBytes)
          ],
          complete: true
        })
      });
    } else if (template.kind === 'consume_and_bind') {
      staged.push({
        ...base,
        body: workerPlan({
          message: 'Reading and binding the produced artifact.',
          actions: [
            // THE READ COMES FIRST, and it is a real production operation.
            // Without it the binding below would be a claim about an artifact
            // nothing ever opened.
            readFile(scenario.oracle.producerPath),
            createFolder(scenario.oracle.consumerPath.replace(/\/[^/]+$/, '')),
            createFolder(`${scenario.oracle.consumerPath.replace(/\/[^/]+$/, '')}/out`),
            writeFile(scenario.oracle.consumerPath, `derived from ${producerHash}\n`)
          ],
          complete: true
        })
      });
    } else {
      throw new EvaluationScenarioError(
        `unsupported worker response template kind: ${template.kind}`);
    }
  }
  return staged;
}

// ── Variant resolution ──────────────────────────────────────────────────────
//
// A variant is a COMPLETE trial definition, not a modifier applied at run time:
// resolution produces a frozen scenario object that the rest of the harness
// consumes exactly as it consumes a single-variant scenario. That keeps one
// code path for staging, oracles and artifacts, so a variant cannot
// accidentally take a different route through the runner than family 1 does.
//
// Scenarios with one canonical variant need no `--variant`, and asking for one
// they do not define refuses rather than falling back to the default.
function resolveScenarioVariant(scenario, variantId = null) {
  const variants = scenario.variants || null;
  if (!variants) {
    if (variantId) {
      throw new EvaluationScenarioError(
        `scenario ${scenario.scenarioId} defines no variants, but ${variantId} was requested`,
        { scenarioId: scenario.scenarioId, variantId });
    }
    return Object.freeze({ ...scenario, variantId: null });
  }
  const selected = variantId || scenario.defaultVariant;
  if (!selected) {
    throw new EvaluationScenarioError(
      `scenario ${scenario.scenarioId} requires an explicit variant`,
      { scenarioId: scenario.scenarioId });
  }
  const variant = variants[selected];
  if (!variant) {
    throw new EvaluationScenarioError(
      `scenario ${scenario.scenarioId} defines no variant ${selected} ` +
      `(known: ${Object.keys(variants).sort().join(', ')})`,
      { scenarioId: scenario.scenarioId, variantId: selected });
  }
  // The variant may replace the staged worker responses and the oracle; it may
  // NOT change the objective, declared work, ownership or allowed arms, because
  // those define the experimental cell rather than the trial.
  const resolved = {
    ...scenario,
    variantId: variant.variantId,
    variantLabel: variant.label,
    variantExpectation: variant.expectation || null,
    failureBoundary: variant.failureBoundary || 'none'
  };
  if (variant.workerResponses) resolved.workerResponses = variant.workerResponses;
  if (variant.oracle) resolved.oracle = variant.oracle;
  delete resolved.variants;
  return Object.freeze(resolved);
}

function variantIdsOf(scenario) {
  return scenario.variants ? Object.freeze(Object.keys(scenario.variants).sort()) : Object.freeze([]);
}

// The oracle contract for a trial, built from raw declarations only.
function buildOracleFor(scenario) {
  if (scenario.oracle.kind === 'raw_state') {
    return buildScenarioExpectation({
      scenarioId: scenario.scenarioId,
      version: scenario.version,
      expectations: scenario.oracle.expectations.map(item => ({ ...item }))
    });
  }
  if (scenario.oracle.kind === 'coupling') return scenario.oracle;
  throw new EvaluationScenarioError(
    `unsupported oracle kind: ${scenario.oracle.kind}`);
}

// Structural validation, run by the focused suite over every catalog entry.
function validateScenario(scenario) {
  const required = ['protocolVersion', 'scenarioId', 'version', 'family',
    'objective', 'initialState', 'declaredWork', 'logicalTasks', 'allowedArms',
    'oracle', 'expectedQuiescence', 'isolation'];
  for (const field of required) {
    if (scenario[field] === undefined || scenario[field] === null) {
      throw new EvaluationScenarioError(
        `scenario ${scenario.scenarioId} is missing ${field}`);
    }
  }
  if (scenario.protocolVersion !== PROTOCOL_VERSION) {
    throw new EvaluationScenarioError(
      `scenario ${scenario.scenarioId} declares protocol ${scenario.protocolVersion}`);
  }
  if (scenario.declaredWork.objective !== scenario.objective) {
    throw new EvaluationScenarioError(
      `scenario ${scenario.scenarioId} declaredWork.objective must equal the ` +
      'ticket objective — production refuses otherwise');
  }
  if (!Array.isArray(scenario.allowedArms) || scenario.allowedArms.length === 0) {
    throw new EvaluationScenarioError(
      `scenario ${scenario.scenarioId} allows no arms`);
  }
  if (scenario.allowedArms.length < ALL_ARMS.length && !scenario.allowedArmsReason) {
    throw new EvaluationScenarioError(
      `scenario ${scenario.scenarioId} restricts arms without stating why`);
  }
  return true;
}

module.exports = {
  PROTOCOL_VERSION,
  ALL_ARMS,
  STRUCTURED_ARMS,
  SCENARIOS,
  SCENARIO_IDS,
  EvaluationScenarioError,
  getScenario,
  resolveScenarioVariant,
  variantIdsOf,
  assertArmAllowed,
  materializeResponses,
  buildOracleFor,
  validateScenario,
  workerPlan,
  plannerProposal,
  proposalItem
};
