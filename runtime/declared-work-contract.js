'use strict';

const crypto = require('crypto');

const DECLARED_WORK_VERSION = 1;
const DECLARED_WORK_PROVENANCE = Object.freeze([
  'ticket-authored',
  'workflow-defined',
  'deterministic-objective-contract',
  'validated-model-contract',
  'legacy-compatibility',
  'absent'
]);
const DECLARED_WORK_SOURCE_PRECEDENCE = Object.freeze([
  'ticket-authored',
  'workflow-defined',
  'deterministic-objective-contract',
  'validated-model-contract',
  'legacy-compatibility',
  'absent'
]);
const DECLARED_WORK_AVAILABILITY = Object.freeze([
  'available',
  'historical-unavailable'
]);
const TOP_LEVEL_FIELDS = Object.freeze([
  'version',
  'objective',
  'expectedOutputs',
  'successCriteria',
  'evidenceRequirements',
  'contractHash'
]);
const OBJECTIVE_FIELDS = Object.freeze(['text', 'provenance']);
const EXPECTED_OUTPUT_FIELDS = Object.freeze(['kind', 'declaration', 'provenance']);
const TEXT_CRITERION_FIELDS = Object.freeze(['kind', 'declaration', 'provenance']);
const TYPED_CRITERION_FIELDS = Object.freeze([
  'kind',
  'criterionType',
  'declaration',
  'criterionHash',
  'provenance'
]);
const EVIDENCE_REQUIREMENT_FIELDS = Object.freeze([
  'kind',
  'criterionHash',
  'evidenceType',
  'provenance'
]);
const SUPPORTED_POSTCONDITION_FIELDS = Object.freeze({
  folder_exists: ['type', 'path'],
  path_absent: ['type', 'path'],
  file_content_equals: ['type', 'path', 'contentSha256'],
  fileExists: ['id', 'type', 'path'],
  fileContains: ['id', 'type', 'path', 'contains'],
  jsonPathEquals: ['id', 'type', 'path', 'jsonPath', 'equals'],
  outputFieldEquals: ['id', 'type', 'field', 'equals'],
  processOperationExists: ['id', 'type', 'operationIdentity'],
  processTerminalOutcomeEquals: ['id', 'type', 'operationIdentity', 'terminalOutcome'],
  processArtifactEquals: [
    'id',
    'type',
    'operationIdentity',
    'stream',
    'byteCount',
    'sha256'
  ]
});
const MAX_OBJECTIVE_LENGTH = 20_000;
const MAX_DECLARATION_LENGTH = 20_000;
const MAX_DECLARATIONS = 64;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

class DeclaredWorkContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeclaredWorkContractError';
    this.code = code;
  }
}

function fail(message, code = 'DECLARED_WORK_SNAPSHOT_INVALID') {
  throw new DeclaredWorkContractError(code, message);
}

function compareCanonicalText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, label = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalValue(item, `${label}[${index}]`));
  }
  if (!isPlainObject(value)) fail(`${label} must contain only canonical JSON values`);
  return Object.fromEntries(Object.keys(value)
    .sort(compareCanonicalText)
    .map(key => [key, canonicalValue(value[key], `${label}.${key}`)]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256(canonicalJson(value));
}

function exactFields(value, fields, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(field => !fields.includes(field));
  const missing = fields.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length > 0) fail(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  if (missing.length > 0) fail(`${label} is missing field(s): ${missing.join(', ')}`);
}

function boundedText(value, label, maximum = MAX_DECLARATION_LENGTH) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) fail(`${label} must not be empty`);
  if (normalized.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function provenance(value, label) {
  if (!DECLARED_WORK_PROVENANCE.includes(value)) {
    fail(`${label} has unsupported provenance: ${String(value)}`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function normalizeObjective(value) {
  exactFields(value, OBJECTIVE_FIELDS, 'declaredWorkSnapshot.objective');
  return {
    text: boundedText(value.text, 'declaredWorkSnapshot.objective.text', MAX_OBJECTIVE_LENGTH),
    provenance: provenance(
      value.provenance,
      'declaredWorkSnapshot.objective.provenance'
    )
  };
}

function normalizeExpectedOutput(value, index) {
  const label = `declaredWorkSnapshot.expectedOutputs[${index}]`;
  exactFields(value, EXPECTED_OUTPUT_FIELDS, label);
  if (!['text', 'workflow-artifact'].includes(value.kind)) {
    fail(`${label}.kind is unsupported: ${String(value.kind)}`);
  }
  return {
    kind: value.kind,
    declaration: boundedText(value.declaration, `${label}.declaration`),
    provenance: provenance(value.provenance, `${label}.provenance`)
  };
}

function normalizeTextCriterion(value, index) {
  const label = `declaredWorkSnapshot.successCriteria[${index}]`;
  exactFields(value, TEXT_CRITERION_FIELDS, label);
  if (value.kind !== 'text') fail(`${label}.kind must be text`);
  return {
    kind: 'text',
    declaration: boundedText(value.declaration, `${label}.declaration`),
    provenance: provenance(value.provenance, `${label}.provenance`)
  };
}

function normalizeTypedCriterion(value, index) {
  const label = `declaredWorkSnapshot.successCriteria[${index}]`;
  exactFields(value, TYPED_CRITERION_FIELDS, label);
  if (value.kind !== 'typed-postcondition') {
    fail(`${label}.kind must be typed-postcondition`);
  }
  const criterionType = boundedText(value.criterionType, `${label}.criterionType`, 128);
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_POSTCONDITION_FIELDS, criterionType)) {
    fail(`${label}.criterionType is unsupported: ${criterionType}`);
  }
  const declaration = boundedText(value.declaration, `${label}.declaration`);
  let parsed;
  try {
    parsed = JSON.parse(declaration);
  } catch (_) {
    fail(`${label}.declaration must be canonical JSON`);
  }
  const normalizedDeclaration = normalizePostcondition(parsed, label);
  const canonicalDeclaration = canonicalJson(normalizedDeclaration);
  if (canonicalDeclaration !== declaration) {
    fail(`${label}.declaration must use canonical serialization`);
  }
  if (normalizedDeclaration.type !== criterionType) {
    fail(`${label}.criterionType does not match its declaration`);
  }
  const criterionHash = hash(value.criterionHash, `${label}.criterionHash`);
  if (criterionHash !== sha256(canonicalDeclaration)) {
    fail(`${label}.criterionHash does not match its declaration`);
  }
  return {
    kind: 'typed-postcondition',
    criterionType,
    declaration: canonicalDeclaration,
    criterionHash,
    provenance: provenance(value.provenance, `${label}.provenance`)
  };
}

function normalizeSuccessCriterion(value, index) {
  if (!isPlainObject(value)) {
    fail(`declaredWorkSnapshot.successCriteria[${index}] must be an object`);
  }
  return value.kind === 'text'
    ? normalizeTextCriterion(value, index)
    : normalizeTypedCriterion(value, index);
}

function normalizeEvidenceRequirement(value, index) {
  const label = `declaredWorkSnapshot.evidenceRequirements[${index}]`;
  exactFields(value, EVIDENCE_REQUIREMENT_FIELDS, label);
  if (value.kind !== 'postcondition-evidence') {
    fail(`${label}.kind must be postcondition-evidence`);
  }
  if (value.evidenceType !== 'deterministic-postcondition-result') {
    fail(`${label}.evidenceType is unsupported: ${String(value.evidenceType)}`);
  }
  return {
    kind: 'postcondition-evidence',
    criterionHash: hash(value.criterionHash, `${label}.criterionHash`),
    evidenceType: 'deterministic-postcondition-result',
    provenance: provenance(value.provenance, `${label}.provenance`)
  };
}

function normalizeArray(value, label, normalizer) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > MAX_DECLARATIONS) {
    fail(`${label} exceeds ${MAX_DECLARATIONS} entries`);
  }
  const normalized = value.map(normalizer);
  const sorted = normalized
    .map(item => ({ item, identity: canonicalJson(item) }))
    .sort((left, right) => compareCanonicalText(left.identity, right.identity));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].identity === sorted[index].identity) {
      fail(`${label} must not contain duplicate declarations`);
    }
  }
  return sorted.map(item => item.item);
}

function normalizePostcondition(value, label = 'postcondition') {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const type = boundedText(value.type, `${label}.type`, 128);
  const fields = SUPPORTED_POSTCONDITION_FIELDS[type];
  if (!fields) fail(`${label}.type is unsupported: ${type}`);
  const unknown = Object.keys(value).filter(field => !fields.includes(field));
  const required = fields.filter(field => field !== 'id');
  const missing = required.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length > 0) fail(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  if (missing.length > 0) fail(`${label} is missing field(s): ${missing.join(', ')}`);
  return canonicalValue(value, label);
}

function postconditionIdentity(postcondition, provenanceValue) {
  if (typeof postcondition.id === 'string' && postcondition.id.trim()) {
    return `${provenanceValue}:id:${postcondition.id.trim()}`;
  }
  if (typeof postcondition.path === 'string' &&
      ['folder_exists', 'path_absent', 'file_content_equals'].includes(postcondition.type)) {
    return `${provenanceValue}:path:${postcondition.type}:${postcondition.path}`;
  }
  return `${provenanceValue}:declaration:${canonicalJson(postcondition)}`;
}

function typedCriterion(postcondition, provenanceValue) {
  const normalized = normalizePostcondition(postcondition);
  const declaration = canonicalJson(normalized);
  return {
    kind: 'typed-postcondition',
    criterionType: normalized.type,
    declaration,
    criterionHash: sha256(declaration),
    provenance: provenanceValue
  };
}

function collectTypedCriteria(entries) {
  const byIdentity = new Map();
  for (const entry of entries) {
    const normalized = normalizePostcondition(entry.postcondition);
    const identity = postconditionIdentity(normalized, entry.provenance);
    const candidate = typedCriterion(normalized, entry.provenance);
    const existing = byIdentity.get(identity);
    if (existing && existing.criterionHash !== candidate.criterionHash) {
      fail(
        `Equal-authority declared criteria contradict at ${identity}`,
        'DECLARED_WORK_AUTHORITY_CONFLICT'
      );
    }
    if (!existing) byIdentity.set(identity, candidate);
  }
  return [...byIdentity.values()];
}

function dedupeBuiltItems(items) {
  const byIdentity = new Map();
  for (const item of items) {
    const identity = canonicalJson(item);
    if (!byIdentity.has(identity)) byIdentity.set(identity, item);
  }
  return [...byIdentity.values()];
}

function buildDeclaredWorkSnapshot({
  ticket,
  workflow = null,
  completionAuthoritySnapshot = null
}) {
  const objectiveText = ticket && typeof ticket.objective === 'string'
    ? ticket.objective.trim()
    : '';
  if (!objectiveText) fail('A ticket-authored objective is required at run admission');

  const expectedOutputs = [];
  const successCriteria = [];
  const typedCriteria = [];

  const acceptanceCriteria = ticket && typeof ticket.acceptanceCriteria === 'string'
    ? ticket.acceptanceCriteria.trim()
    : '';
  if (acceptanceCriteria) {
    successCriteria.push({
      kind: 'text',
      declaration: acceptanceCriteria,
      provenance: 'ticket-authored'
    });
  }

  if (workflow) {
    const expectedArtifacts = workflow.verifierContract &&
      Array.isArray(workflow.verifierContract.expectedArtifacts)
      ? workflow.verifierContract.expectedArtifacts
      : [];
    for (const declaration of expectedArtifacts) {
      const text = typeof declaration === 'string' ? declaration.trim() : '';
      if (!text) continue;
      expectedOutputs.push({
        kind: 'workflow-artifact',
        declaration: text,
        provenance: 'workflow-defined'
      });
    }
    for (const postcondition of Array.isArray(workflow.postconditions)
      ? workflow.postconditions
      : []) {
      typedCriteria.push({
        postcondition,
        provenance: 'workflow-defined'
      });
    }
  } else if (completionAuthoritySnapshot &&
      completionAuthoritySnapshot.objectiveContract &&
      Array.isArray(completionAuthoritySnapshot.objectiveContract.directPostconditions)) {
    for (const postcondition of completionAuthoritySnapshot.objectiveContract.directPostconditions) {
      typedCriteria.push({
        postcondition,
        provenance: 'deterministic-objective-contract'
      });
    }
  }

  const normalizedTypedCriteria = collectTypedCriteria(typedCriteria);
  successCriteria.push(...normalizedTypedCriteria);
  const evidenceRequirements = normalizedTypedCriteria.map(criterion => ({
    kind: 'postcondition-evidence',
    criterionHash: criterion.criterionHash,
    evidenceType: 'deterministic-postcondition-result',
    provenance: criterion.provenance
  }));

  return normalizeDeclaredWorkSnapshot({
    version: DECLARED_WORK_VERSION,
    objective: {
      text: objectiveText,
      provenance: 'ticket-authored'
    },
    expectedOutputs: dedupeBuiltItems(expectedOutputs),
    successCriteria: dedupeBuiltItems(successCriteria),
    evidenceRequirements: dedupeBuiltItems(evidenceRequirements),
    contractHash: '0'.repeat(64)
  }, { build: true });
}

function normalizeDeclaredWorkSnapshot(value, options = {}) {
  exactFields(value, TOP_LEVEL_FIELDS, 'declaredWorkSnapshot');
  if (value.version !== DECLARED_WORK_VERSION) {
    fail(`Unsupported declaredWorkSnapshot version: ${String(value.version)}`);
  }
  const withoutHash = {
    version: DECLARED_WORK_VERSION,
    objective: normalizeObjective(value.objective),
    expectedOutputs: normalizeArray(
      value.expectedOutputs,
      'declaredWorkSnapshot.expectedOutputs',
      normalizeExpectedOutput
    ),
    successCriteria: normalizeArray(
      value.successCriteria,
      'declaredWorkSnapshot.successCriteria',
      normalizeSuccessCriterion
    ),
    evidenceRequirements: normalizeArray(
      value.evidenceRequirements,
      'declaredWorkSnapshot.evidenceRequirements',
      normalizeEvidenceRequirement
    )
  };
  const contractHash = options.build === true
    ? hashCanonical(withoutHash)
    : hash(value.contractHash, 'declaredWorkSnapshot.contractHash');
  if (contractHash !== hashCanonical(withoutHash)) {
    fail(
      'declaredWorkSnapshot.contractHash does not match its admitted authority',
      'DECLARED_WORK_SNAPSHOT_CONFLICT'
    );
  }
  return deepFreeze({ ...withoutHash, contractHash });
}

function projectDeclaredWorkForRun(run) {
  if (!run || !Object.prototype.hasOwnProperty.call(run, 'declaredWorkSnapshot') ||
      run.declaredWorkSnapshot === null || run.declaredWorkSnapshot === undefined) {
    return deepFreeze({
      availability: 'historical-unavailable',
      snapshot: null
    });
  }
  return deepFreeze({
    availability: 'available',
    snapshot: normalizeDeclaredWorkSnapshot(run.declaredWorkSnapshot)
  });
}

function projectDeclaredWorkForModel(value) {
  const snapshot = normalizeDeclaredWorkSnapshot(value);
  return deepFreeze({
    objective: snapshot.objective,
    expectedOutputs: snapshot.expectedOutputs,
    successCriteria: snapshot.successCriteria,
    evidenceRequirements: snapshot.evidenceRequirements
  });
}

module.exports = {
  DECLARED_WORK_AVAILABILITY,
  DECLARED_WORK_PROVENANCE,
  DECLARED_WORK_SOURCE_PRECEDENCE,
  DECLARED_WORK_VERSION,
  DeclaredWorkContractError,
  buildDeclaredWorkSnapshot,
  canonicalJson,
  compareCanonicalText,
  hashCanonical,
  normalizeDeclaredWorkSnapshot,
  projectDeclaredWorkForModel,
  projectDeclaredWorkForRun
};
