'use strict';

// Tranche 6 — the INDEPENDENT postcondition oracle.
//
// WHY THIS EXISTS AND WHY IT IS DELIBERATELY PRIMITIVE.
//
// The evaluation scores completion TRUTHFULNESS: how often the product's
// completion authority says "done" when the objective is actually done, and —
// the outcome that matters most — how often it says "done" when it is not.
//
// Scoring that with the product's own completion decision would be circular.
// `completionDecision`, `deriveLeafItemDisposition`, the Ticket/Run projections
// and `postcondition-criterion-evaluator` are the very authorities under
// evaluation; asking them whether they were right guarantees agreement and
// proves nothing. So this module answers the question from RAW OBSERVABLE STATE
// and nothing else.
//
// WHAT IT MAY READ
//
//   * the filesystem under the scenario workspace root — existence, kind, and
//     bytes it parses itself;
//   * values the scenario declared up front, before any arm ran.
//
// WHAT IT MAY NEVER READ, and what the accompanying suite proves it does not
// even import:
//
//   * completionDecision or any completion-decision contract;
//   * Ticket or Run projected completion / status;
//   * deriveLeafItemDisposition;
//   * the production postcondition evaluator;
//   * allocation plans, items, governed blocks, or any model claim.
//
// It takes no store, no repository, no Run and no Ticket. It cannot consult
// them because it is never given them — that is a structural guarantee, not a
// convention.
//
// ARM-BLIND BY CONSTRUCTION. The oracle receives a scenario expectation and a
// workspace root. It is not told which arm produced the state, and there is no
// parameter through which it could learn.
//
// REFUSAL IS A FIRST-CLASS RESULT. When observable state cannot decide the
// question, the oracle returns `refused` rather than guessing. A guess would
// silently become a false-positive or false-negative in the truthfulness score,
// which is the one number this evaluation cannot afford to get wrong.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ORACLE_VERDICTS = Object.freeze(['pass', 'fail', 'refused']);

// The closed vocabulary of raw expectations. Each is answerable from the
// filesystem alone. Adding a kind that needs product authority is a contract
// violation, not a feature.
const EXPECTATION_KINDS = Object.freeze([
  // A directory exists at this exact relative path.
  'folder_exists',
  // A regular file exists at this exact relative path.
  'file_exists',
  // Nothing exists at this exact relative path.
  'path_absent',
  // A regular file exists AND its bytes contain this exact literal substring.
  // The oracle parses the bytes itself; it never asks anything to interpret
  // them.
  'file_contains',
  // A regular file exists AND its bytes are exactly this many bytes or more.
  'file_min_bytes'
]);

class EvaluationOracleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvaluationOracleError';
  }
}

function assertRelativePath(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new EvaluationOracleError(`${label} must be a non-empty exact string`);
  }
  if (path.isAbsolute(value) || value.includes('\0')) {
    throw new EvaluationOracleError(`${label} must be workspace-relative`);
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized.split('/').some(segment => segment === '..')) {
    throw new EvaluationOracleError(`${label} must not escape the workspace root`);
  }
  return normalized.replace(/\/+$/, '');
}

// One scenario's independently declared expected end state. Frozen so a trial
// cannot mutate what it is being judged against.
function buildScenarioExpectation({ scenarioId, version, expectations }) {
  if (typeof scenarioId !== 'string' || !scenarioId.trim()) {
    throw new EvaluationOracleError('scenarioId is required');
  }
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new EvaluationOracleError('version must be a positive integer');
  }
  if (!Array.isArray(expectations) || expectations.length === 0) {
    throw new EvaluationOracleError('at least one expectation is required');
  }
  const normalized = expectations.map((expectation, index) => {
    const label = `expectations[${index}]`;
    if (!expectation || typeof expectation !== 'object') {
      throw new EvaluationOracleError(`${label} must be an object`);
    }
    if (!EXPECTATION_KINDS.includes(expectation.kind)) {
      throw new EvaluationOracleError(
        `${label}.kind must be one of ${EXPECTATION_KINDS.join(', ')}`);
    }
    const record = {
      kind: expectation.kind,
      path: assertRelativePath(expectation.path, `${label}.path`)
    };
    if (expectation.kind === 'file_contains') {
      if (typeof expectation.contains !== 'string' || expectation.contains.length === 0) {
        throw new EvaluationOracleError(`${label}.contains must be a non-empty string`);
      }
      record.contains = expectation.contains;
    }
    if (expectation.kind === 'file_min_bytes') {
      if (!Number.isSafeInteger(expectation.minBytes) || expectation.minBytes < 0) {
        throw new EvaluationOracleError(`${label}.minBytes must be a non-negative integer`);
      }
      record.minBytes = expectation.minBytes;
    }
    return Object.freeze(record);
  });
  const document = {
    scenarioId,
    version,
    expectations: Object.freeze(normalized)
  };
  document.expectationHash = crypto.createHash('sha256')
    .update(JSON.stringify(document)).digest('hex');
  return Object.freeze(document);
}

// Observe one expectation from raw filesystem state.
//
// `refused` is returned — never `fail` — when the filesystem itself cannot
// answer: an unreadable entry, or a path whose kind cannot be determined. "We
// could not look" and "it is not there" are different facts, and collapsing
// them would manufacture false negatives.
function observeExpectation(workspaceRoot, expectation) {
  const target = path.join(workspaceRoot, expectation.path);
  let stat = null;
  let statError = null;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') stat = null;
    else statError = error;
  }
  if (statError) {
    return {
      kind: expectation.kind,
      path: expectation.path,
      verdict: 'refused',
      observed: null,
      reason: `state could not be observed (${statError.code || 'unknown'})`
    };
  }

  const observedKind = stat === null
    ? 'absent'
    : (stat.isDirectory() ? 'folder' : (stat.isFile() ? 'file' : 'other'));

  if (observedKind === 'other') {
    return {
      kind: expectation.kind,
      path: expectation.path,
      verdict: 'refused',
      observed: observedKind,
      reason: 'path exists but is neither a regular file nor a directory'
    };
  }

  if (expectation.kind === 'folder_exists') {
    return verdictFor(expectation, observedKind === 'folder', observedKind);
  }
  if (expectation.kind === 'path_absent') {
    return verdictFor(expectation, observedKind === 'absent', observedKind);
  }
  if (expectation.kind === 'file_exists') {
    return verdictFor(expectation, observedKind === 'file', observedKind);
  }

  // The two byte-reading kinds. A missing file is a truthful `fail`; a file
  // that exists but cannot be read is a `refused`.
  if (observedKind !== 'file') {
    return verdictFor(expectation, false, observedKind);
  }
  let bytes = null;
  try {
    bytes = fs.readFileSync(target);
  } catch (error) {
    return {
      kind: expectation.kind,
      path: expectation.path,
      verdict: 'refused',
      observed: 'file',
      reason: `file exists but could not be read (${error.code || 'unknown'})`
    };
  }
  if (expectation.kind === 'file_min_bytes') {
    return verdictFor(expectation, bytes.length >= expectation.minBytes,
      `file:${bytes.length}b`);
  }
  // file_contains — the oracle parses the bytes itself.
  return verdictFor(expectation,
    bytes.toString('utf8').includes(expectation.contains), `file:${bytes.length}b`);
}

function verdictFor(expectation, satisfied, observed) {
  return {
    kind: expectation.kind,
    path: expectation.path,
    verdict: satisfied ? 'pass' : 'fail',
    observed,
    reason: satisfied ? null : 'observed state does not match the declared expectation'
  };
}

// THE ORACLE.
//
// Signature is deliberately narrow: a workspace root and a frozen expectation.
// There is no store, no run, no ticket and no arm identifier — so it cannot
// consult product authority and cannot behave differently per arm.
function evaluateScenarioOutcome({ workspaceRoot, expectation }) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) {
    throw new EvaluationOracleError('workspaceRoot is required');
  }
  if (!expectation || typeof expectation !== 'object' ||
      !Array.isArray(expectation.expectations)) {
    throw new EvaluationOracleError('a built scenario expectation is required');
  }
  const observations = expectation.expectations.map(
    item => observeExpectation(workspaceRoot, item));

  // Refusal dominates. If any single expectation could not be observed, the
  // objective's truth is unknown and the oracle says so rather than reporting a
  // pass or fail it cannot support.
  const refused = observations.filter(o => o.verdict === 'refused');
  const failed = observations.filter(o => o.verdict === 'fail');
  const verdict = refused.length > 0 ? 'refused' : (failed.length > 0 ? 'fail' : 'pass');

  return Object.freeze({
    scenarioId: expectation.scenarioId,
    scenarioVersion: expectation.version,
    expectationHash: expectation.expectationHash,
    verdict,
    observations: Object.freeze(observations),
    refusedCount: refused.length,
    failedCount: failed.length,
    // Named so a reader cannot mistake this for product authority.
    authority: 'independent_raw_state_observation'
  });
}

// TRUTHFULNESS CLASSIFICATION.
//
// Combines the oracle verdict with the PRODUCT's completion claim. The product
// claim is supplied by the caller as a plain boolean that the caller derived
// from product authority; this module never derives it, so the oracle half of
// the comparison stays independent.
//
// A false positive — product claims success, raw state says otherwise — is the
// outcome the whole evaluation is weighted around.
const TRUTHFULNESS_CLASSES = Object.freeze([
  'true_positive_completion',
  'false_positive_completion',
  'false_negative_completion',
  'true_negative_completion',
  'oracle_refused'
]);

function classifyTruthfulness({ productClaimsCompleted, oracleResult }) {
  if (typeof productClaimsCompleted !== 'boolean') {
    throw new EvaluationOracleError(
      'productClaimsCompleted must be a boolean derived by the caller from product authority');
  }
  if (!oracleResult || !ORACLE_VERDICTS.includes(oracleResult.verdict)) {
    throw new EvaluationOracleError('a completed oracle result is required');
  }
  if (oracleResult.verdict === 'refused') return 'oracle_refused';
  const objectiveActuallyDone = oracleResult.verdict === 'pass';
  if (productClaimsCompleted && objectiveActuallyDone) return 'true_positive_completion';
  if (productClaimsCompleted && !objectiveActuallyDone) return 'false_positive_completion';
  if (!productClaimsCompleted && objectiveActuallyDone) return 'false_negative_completion';
  return 'true_negative_completion';
}

module.exports = {
  EXPECTATION_KINDS,
  ORACLE_VERDICTS,
  TRUTHFULNESS_CLASSES,
  EvaluationOracleError,
  buildScenarioExpectation,
  evaluateScenarioOutcome,
  classifyTruthfulness
};
