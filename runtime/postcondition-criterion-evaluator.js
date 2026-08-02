'use strict';

// Tranche 5 — the ONE rule for "is this admitted criterion satisfied".
//
// THE DEFECT THIS CLOSES. Two evaluators already answered that question with
// subtly different semantics:
//
//   execution time  `inspectObjectiveContractPostconditions` (server.js) read
//                   the LIVE filesystem, supported folder_exists and
//                   path_absent only, and was all-or-nothing: one unsatisfied
//                   postcondition made the whole check return null.
//
//   completion time `directPostconditionResult` (completion-decision-contract)
//                   read RECORDED claims, supported folder_exists, path_absent
//                   AND file_content_equals, and decided each postcondition
//                   separately.
//
// Two authorities answering one question is the failure mode Tranche 5 exists to
// prevent, and the first time they disagreed the disagreement would be silent —
// execution would record progress the completion decision would not honour, or
// the reverse.
//
// The split here is deliberate and minimal:
//
//   OBSERVATION  each path keeps its own evidence gathering, because they
//                genuinely observe different things — one looks at the
//                filesystem, the other at what was durably recorded.
//   RULE         both normalize to the same observation shape and call the same
//                pure function to decide. The rule lives here and nowhere else.
//
// This module reads nothing. No filesystem, no clock, no database.

const crypto = require('node:crypto');

const CRITERION_EVALUATOR_IDENTITY = 'objective_contract';
const CRITERION_EVALUATOR_VERSION = 1;

// The criterion classes a deterministic observation can decide. Anything else
// is reported as unsupported rather than quietly failing, so an unrecognized
// criterion can never be recorded as "unsatisfied".
const EVALUABLE_CRITERION_TYPES = Object.freeze([
  'folder_exists',
  'path_absent',
  'file_content_equals'
]);

// What an observation may say about one path. `absent` is a positive statement
// that nothing is there — not "we did not look".
const OBSERVED_PATH_KINDS = Object.freeze(['folder', 'file', 'absent']);

const REASON_PASSED = 'POSTCONDITION_PASSED';
const REASON_FAILED = 'POSTCONDITION_EVALUATION_FAILED';
const REASON_UNAVAILABLE = 'POSTCONDITION_EVIDENCE_UNAVAILABLE';
const REASON_UNSUPPORTED = 'POSTCONDITION_UNSUPPORTED';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// A normalized observation of one path. Both call sites build this; neither
// interprets it.
function observedPath({ path, kind, contentSha256 = null }) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (!OBSERVED_PATH_KINDS.includes(kind)) return null;
  return Object.freeze({
    path,
    kind,
    contentSha256: typeof contentSha256 === 'string' ? contentSha256 : null
  });
}

// Convenience for the execution-time caller, which holds a path-info record
// rather than a normalized observation.
function observationFromPathInfo(path, info) {
  if (!info || info.exists !== true) return observedPath({ path, kind: 'absent' });
  if (info.type === 'directory') return observedPath({ path, kind: 'folder' });
  return observedPath({
    path,
    kind: 'file',
    contentSha256: typeof info.contentSha256 === 'string'
      ? info.contentSha256
      : (typeof info.content === 'string' ? sha256(info.content) : null)
  });
}

// Convenience for the completion-time caller, which holds recorded claims whose
// vocabulary is already `folder` / `absent` / `file`.
function observationFromCheckedPath(checked) {
  if (!isPlainObject(checked)) return null;
  const kind = checked.type;
  if (!OBSERVED_PATH_KINDS.includes(kind)) return null;
  return observedPath({
    path: checked.path,
    kind,
    contentSha256: typeof checked.expectedContent === 'string'
      ? sha256(checked.expectedContent)
      : (typeof checked.contentSha256 === 'string' ? checked.contentSha256 : null)
  });
}

// ── THE RULE ────────────────────────────────────────────────────────────────
//
// Given one admitted criterion and the observations available, decide. Three
// outcomes, and the distinction between the last two matters:
//
//   passed: true    the criterion is satisfied
//   passed: false   it was observed and is NOT satisfied
//   passed: null    nothing relevant was observed — which is not the same as
//                   unsatisfied, and must never be recorded as evidence
function evaluateCriterion(criterion, observations = []) {
  if (!isPlainObject(criterion) || typeof criterion.type !== 'string') {
    return Object.freeze({
      type: null,
      authority: CRITERION_EVALUATOR_IDENTITY,
      passed: null,
      reasonCode: REASON_UNSUPPORTED
    });
  }
  if (!EVALUABLE_CRITERION_TYPES.includes(criterion.type)) {
    return Object.freeze({
      type: criterion.type,
      authority: CRITERION_EVALUATOR_IDENTITY,
      path: criterion.path || null,
      passed: null,
      reasonCode: REASON_UNSUPPORTED
    });
  }

  const relevant = (observations || [])
    .filter(Boolean)
    .filter(observation => observation.path === criterion.path);

  if (relevant.length === 0) {
    return Object.freeze({
      type: criterion.type,
      authority: CRITERION_EVALUATOR_IDENTITY,
      path: criterion.path || null,
      passed: null,
      reasonCode: REASON_UNAVAILABLE
    });
  }

  const satisfied = relevant.some(observation => {
    if (criterion.type === 'folder_exists') return observation.kind === 'folder';
    if (criterion.type === 'path_absent') return observation.kind === 'absent';
    // file_content_equals: the file must exist AND its content hash must match
    // the admitted hash. A file whose content is unknown is not a match.
    return observation.kind === 'file' &&
      typeof observation.contentSha256 === 'string' &&
      observation.contentSha256 === criterion.contentSha256;
  });

  return Object.freeze({
    type: criterion.type,
    authority: CRITERION_EVALUATOR_IDENTITY,
    path: criterion.path || null,
    passed: satisfied,
    reasonCode: satisfied ? REASON_PASSED : REASON_FAILED
  });
}

module.exports = {
  CRITERION_EVALUATOR_IDENTITY,
  CRITERION_EVALUATOR_VERSION,
  EVALUABLE_CRITERION_TYPES,
  OBSERVED_PATH_KINDS,
  evaluateCriterion,
  observationFromCheckedPath,
  observationFromPathInfo,
  observedPath
};
