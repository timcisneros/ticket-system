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

// The planner proposal shape for the structured arms. Only B and C ever request
// it; the legacy and direct arms never issue a planner request at all.
function plannerProposal(items) {
  return JSON.stringify({ items });
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
    initialState: Object.freeze({ folders: Object.freeze(['reports']) }),
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
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha', 'beta']),
    plannerResponses: Object.freeze([
      Object.freeze({
        role: 'planner', logicalTaskId: 'plan', ordinal: 1,
        inputTokens: 400, outputTokens: 120,
        body: plannerProposal([
          { subtask: 'Create reports/alpha', ownedOutputPaths: ['reports/alpha/'] },
          { subtask: 'Create reports/beta', ownedOutputPaths: ['reports/beta/'] }
        ])
      })
    ]),
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
        match: 'reports/beta', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Creating the beta folder.',
          actions: [createFolder('reports/beta')], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([]),
    allowedArms: ALL_ARMS,
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({ kind: 'folder_exists', path: 'reports/alpha' }),
        Object.freeze({ kind: 'folder_exists', path: 'reports/beta' })
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
    objective: 'Create folders reports/producer and reports/consumer',
    initialState: Object.freeze({ folders: Object.freeze(['reports']) }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/producer and reports/consumer',
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
    plannerResponses: Object.freeze([
      Object.freeze({
        role: 'planner', logicalTaskId: 'plan', ordinal: 1,
        inputTokens: 420, outputTokens: 140,
        body: plannerProposal([
          { subtask: 'Produce the artifact', ownedOutputPaths: ['reports/producer/'] },
          { subtask: 'Consume the artifact', ownedOutputPaths: ['reports/consumer/'] }
        ])
      })
    ]),
    // The producer body is seed-dependent, so it is generated per trial by
    // `materializeResponses` rather than frozen here.
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
    objective: 'Create folders reports/left and reports/right',
    initialState: Object.freeze({ folders: Object.freeze(['reports']) }),
    declaredWork: Object.freeze({
      objective: 'Create folders reports/left and reports/right',
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
    plannerResponses: Object.freeze([
      Object.freeze({
        role: 'planner', logicalTaskId: 'plan', ordinal: 1,
        inputTokens: 410, outputTokens: 130,
        body: plannerProposal([
          { subtask: 'Produce the left artifact', ownedOutputPaths: ['reports/left/'] },
          { subtask: 'Produce the right summary', ownedOutputPaths: ['reports/right/'] }
        ])
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
    objective: 'Create folders reports/alpha and reports/beta',
    initialState: Object.freeze({ folders: Object.freeze(['reports']) }),
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
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    plannerResponses: Object.freeze([
      Object.freeze({
        role: 'planner', logicalTaskId: 'plan', ordinal: 1,
        inputTokens: 400, outputTokens: 120,
        body: plannerProposal([
          { subtask: 'Create reports/alpha', ownedOutputPaths: ['reports/alpha/'] }
        ])
      })
    ]),
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
      })
    ]),
    // The neighbouring controls, named so a reader can see what is NOT churn.
    controls: Object.freeze({
      durable_but_undelivered: 'after_transport_before_response',
      incomplete_evidence: 'receipts committed, evidence set withheld',
      verified_progress: 'creates the admitted folder and is credited'
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
    objective: 'Create folders reports/alpha and reports/beta',
    initialState: Object.freeze({ folders: Object.freeze(['reports']) }),
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
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    plannerResponses: Object.freeze([
      Object.freeze({
        role: 'planner', logicalTaskId: 'plan', ordinal: 1,
        inputTokens: 400, outputTokens: 120,
        body: plannerProposal([
          { subtask: 'Create reports/alpha', ownedOutputPaths: ['reports/alpha/'] }
        ])
      })
    ]),
    // Each boundary is its own trial variant; the runner selects one.
    boundaryVariants: Object.freeze({
      pre_transport: 'before_transport',
      uncertain_delivery: 'after_transport_before_response',
      durable_response: 'after_response',
      committed_effect: 'after_response'
    }),
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Creating the alpha folder.',
          actions: [createFolder('reports/alpha')], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([
      'fixture transcript distinguishes zero calls, one uncertain call, ' +
      'a reused durable response, one committed effect and a duplicate effect'
    ]),
    allowedArms: ALL_ARMS,
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({ kind: 'folder_exists', path: 'reports/alpha' })
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
    objective: 'Create folders reports/alpha and reports/beta',
    initialState: Object.freeze({ folders: Object.freeze(['reports']) }),
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
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    plannerResponses: Object.freeze([
      Object.freeze({
        role: 'planner', logicalTaskId: 'plan', ordinal: 1,
        inputTokens: 400, outputTokens: 120,
        body: plannerProposal([
          { subtask: 'Create reports/alpha', ownedOutputPaths: ['reports/alpha/'] }
        ])
      })
    ]),
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 280, outputTokens: 40,
        body: workerPlan({
          message: 'All declared work is complete.',
          actions: [], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([]),
    allowedArms: ALL_ARMS,
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({ kind: 'folder_exists', path: 'reports/alpha' })
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
    version: 1,
    family: 9,
    objective: 'Create folders reports/alpha and reports/beta',
    initialState: Object.freeze({ folders: Object.freeze(['reports']) }),
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
    ownedOutputPaths: Object.freeze({ alpha: 'reports/alpha/', beta: 'reports/beta/' }),
    logicalTasks: Object.freeze(['alpha']),
    plannerResponses: Object.freeze([
      Object.freeze({
        role: 'planner', logicalTaskId: 'plan', ordinal: 1,
        inputTokens: 400, outputTokens: 120,
        body: plannerProposal([
          { subtask: 'Create reports/alpha', ownedOutputPaths: ['reports/alpha/'] }
        ])
      })
    ]),
    workerResponses: Object.freeze([
      Object.freeze({
        role: 'worker', logicalTaskId: 'alpha', ordinal: 1,
        match: 'reports/alpha', inputTokens: 300, outputTokens: 60,
        body: workerPlan({
          message: 'Creating the alpha folder.',
          actions: [createFolder('reports/alpha')], complete: true
        })
      })
    ]),
    externalEffects: Object.freeze([]),
    allowedArms: ALL_ARMS,
    // A directory where a FILE is expected: the observation is genuinely
    // undecidable as a file check, so the oracle refuses.
    oracle: Object.freeze({
      kind: 'raw_state',
      expectations: Object.freeze([
        Object.freeze({ kind: 'file_contains', path: 'reports/alpha', contains: 'x' })
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
function materializeResponses(scenario, seed) {
  if (typeof seed !== 'string' || !seed) {
    throw new EvaluationScenarioError('a trial seed is required');
  }
  const staged = [...(scenario.plannerResponses || []).map(response => ({
    ...response, protocolVersion: scenario.protocolVersion,
    scenarioId: scenario.scenarioId, seed
  }))];

  for (const response of scenario.workerResponses || []) {
    staged.push({
      ...response, protocolVersion: scenario.protocolVersion,
      scenarioId: scenario.scenarioId, seed
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
      inputTokens: 320, outputTokens: 90
    };
    if (template.kind === 'produce_seeded_artifact') {
      staged.push({
        ...base,
        body: workerPlan({
          message: 'Producing the seeded artifact.',
          actions: [
            createFolder(scenario.oracle.producerPath.replace(/\/[^/]+$/, '')),
            writeFile(scenario.oracle.producerPath, producerBytes)
          ],
          complete: true
        })
      });
    } else if (template.kind === 'consume_and_bind') {
      staged.push({
        ...base,
        body: workerPlan({
          message: 'Binding the produced artifact.',
          actions: [
            createFolder(scenario.oracle.consumerPath.replace(/\/[^/]+$/, '')),
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
  assertArmAllowed,
  materializeResponses,
  buildOracleFor,
  validateScenario,
  workerPlan
};
