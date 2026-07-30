'use strict';

// Projection helpers only. These functions read the existing generic operation
// receipts and preserve each operation family's vocabulary; they are not an
// operation router or a new receipt/evidence authority.

const BROWSER_OPERATIONS = Object.freeze([
  'navigate',
  'observe',
  'readPageText',
  'screenshot',
  'wait'
]);
const BROWSER_OPERATION_SET = new Set(BROWSER_OPERATIONS);
const WORKSPACE_OPERATIONS = Object.freeze([
  'listDirectory',
  'readFile',
  'createFolder',
  'writeFile',
  'renamePath',
  'deletePath'
]);
const WORKSPACE_OPERATION_SET = new Set(WORKSPACE_OPERATIONS);
const BROWSER_OUTCOMES = new Set(['succeeded', 'failed', 'refused']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function compareCanonicalText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function browserProjectionError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function boundedString(value, label, maxLength = 512) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw browserProjectionError('BROWSER_CONSEQUENCE_RECEIPT_INVALID', `${label} is invalid`);
  }
  return value;
}

function optionalBoundedString(value, label, maxLength = 512) {
  if (value === undefined || value === null) return null;
  return boundedString(value, label, maxLength);
}

function optionalSafeInteger(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw browserProjectionError('BROWSER_CONSEQUENCE_RECEIPT_INVALID', `${label} is invalid`);
  }
  return value;
}

function optionalHash(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw browserProjectionError('BROWSER_CONSEQUENCE_RECEIPT_INVALID', `${label} is invalid`);
  }
  return value;
}

function compactObject(fields) {
  return Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined));
}

function assertNestedBrowserReceiptAgreement(record, operation, targetId) {
  const receipt = record.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return;
  if (receipt.operation !== undefined && receipt.operation !== operation) {
    throw browserProjectionError(
      'BROWSER_CONSEQUENCE_RECEIPT_CONFLICT',
      'browser receipt operation contradicts its durable envelope'
    );
  }
  if (receipt.targetId !== undefined && receipt.targetId !== targetId) {
    throw browserProjectionError(
      'BROWSER_CONSEQUENCE_RECEIPT_CONFLICT',
      'browser receipt target identity contradicts its durable envelope'
    );
  }
  if (receipt.outcome !== undefined && receipt.outcome !== record.outcome) {
    throw browserProjectionError(
      'BROWSER_CONSEQUENCE_RECEIPT_CONFLICT',
      'browser receipt outcome contradicts its durable envelope'
    );
  }
}

function projectBrowserEvidenceMetadata(operation, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (operation === 'navigate') {
    const status = optionalSafeInteger(metadata.status, 'browser navigate status');
    const pageStateHash = optionalBoundedString(metadata.pageStateHash, 'browser page-state hash', 256);
    return status === null && pageStateHash === null ? null : compactObject({ status, pageStateHash });
  }
  if (operation === 'observe') {
    const elementCount = optionalSafeInteger(metadata.elementCount, 'browser element count');
    const pageStateHash = optionalBoundedString(metadata.pageStateHash, 'browser page-state hash', 256);
    return elementCount === null && pageStateHash === null
      ? null
      : compactObject({ elementCount, pageStateHash });
  }
  if (operation === 'readPageText') {
    const byteCount = optionalSafeInteger(metadata.bytes, 'browser text byte count');
    const fullByteCount = optionalSafeInteger(metadata.fullBytes, 'browser full-text byte count');
    const contentHash = optionalBoundedString(metadata.contentHash, 'browser content hash', 256);
    const pageStateHash = optionalBoundedString(metadata.pageStateHash, 'browser page-state hash', 256);
    return byteCount === null && fullByteCount === null && contentHash === null && pageStateHash === null
      ? null
      : compactObject({ byteCount, fullByteCount, contentHash, pageStateHash });
  }
  if (operation === 'screenshot') {
    const pageStateHash = optionalBoundedString(metadata.pageStateHash, 'browser page-state hash', 256);
    return pageStateHash === null ? null : { pageStateHash };
  }
  if (operation === 'wait') {
    const requestedMs = optionalSafeInteger(metadata.requestedMs, 'browser requested wait');
    const waitedMs = optionalSafeInteger(metadata.waitedMs, 'browser actual wait');
    return requestedMs === null && waitedMs === null
      ? null
      : compactObject({ requestedMs, waitedMs });
  }
  return null;
}

function projectBrowserScreenshotArtifact(record, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (record.operation !== 'screenshot' || record.outcome !== 'succeeded') return null;
  const id = optionalBoundedString(metadata.artifactPath, 'browser screenshot artifact identity', 1024);
  const byteCount = optionalSafeInteger(metadata.bytes, 'browser screenshot byte count');
  const sha256 = optionalHash(metadata.sha256, 'browser screenshot digest');
  if (id === null && byteCount === null && sha256 === null) return null;
  if (id === null || byteCount === null || sha256 === null) {
    throw browserProjectionError(
      'BROWSER_CONSEQUENCE_RECEIPT_INVALID',
      'browser screenshot artifact metadata is incomplete'
    );
  }
  return { id, kind: 'screenshot', byteCount, sha256 };
}

function buildBrowserConsequenceFromHistory(record) {
  if (!record || record.targetKind !== 'browser') return null;
  const operation = boundedString(record.operation, 'browser operation', 128);
  if (!BROWSER_OPERATION_SET.has(operation)) {
    throw browserProjectionError(
      'BROWSER_CONSEQUENCE_RECEIPT_INVALID',
      `unsupported browser receipt operation: ${operation}`
    );
  }
  const operationIdentity = boundedString(
    record.operationKey || record.idempotencyKey,
    'browser operation identity'
  );
  const targetId = boundedString(record.targetId, 'browser target identity', 256);
  if (!BROWSER_OUTCOMES.has(record.outcome)) {
    throw browserProjectionError('BROWSER_CONSEQUENCE_RECEIPT_INVALID', 'browser receipt outcome is invalid');
  }
  assertNestedBrowserReceiptAgreement(record, operation, targetId);

  const receiptId = Number.isSafeInteger(record.id) && record.id > 0
    ? `operation:${record.id}`
    : null;
  const metadata = record.metadata && typeof record.metadata === 'object'
    ? record.metadata
    : record.receipt && typeof record.receipt === 'object'
      ? record.receipt.metadata
      : null;
  const evidenceMetadata = projectBrowserEvidenceMetadata(operation, metadata);
  const partial = typeof record.partial === 'boolean'
    ? record.partial
    : record.receipt && typeof record.receipt.partial === 'boolean'
      ? record.receipt.partial
      : null;
  const truncated = typeof record.truncated === 'boolean'
    ? record.truncated
    : record.receipt && typeof record.receipt.truncated === 'boolean'
      ? record.receipt.truncated
      : null;
  const evidence = receiptId === null && evidenceMetadata === null && partial === null && truncated === null
    ? null
    : compactObject({
        receiptId,
        type: operation,
        partial,
        truncated,
        metadata: evidenceMetadata
      });
  const artifact = projectBrowserScreenshotArtifact(record, metadata);

  return {
    operationIdentity,
    operation,
    targetId,
    outcome: record.outcome,
    evidence,
    artifact
  };
}

function canonicalProjection(value) {
  return JSON.stringify(value);
}

function buildBrowserConsequences(records = []) {
  const byIdentity = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const projected = buildBrowserConsequenceFromHistory(record);
    if (!projected) continue;
    const prior = byIdentity.get(projected.operationIdentity);
    if (prior && canonicalProjection(prior) !== canonicalProjection(projected)) {
      throw browserProjectionError(
        'BROWSER_CONSEQUENCE_RECEIPT_CONFLICT',
        `conflicting browser receipts share operation identity ${projected.operationIdentity}`
      );
    }
    if (!prior) byIdentity.set(projected.operationIdentity, projected);
  }
  return [...byIdentity.values()].sort((left, right) =>
    compareCanonicalText(left.operationIdentity, right.operationIdentity));
}

function isProcessOperation(record) {
  return Boolean(record && (record.operation === 'runProcess' || record.targetKind === 'process'));
}

function isBrowserOperation(record) {
  return Boolean(record && record.targetKind === 'browser' && BROWSER_OPERATION_SET.has(record.operation));
}

function isWorkspaceOperation(record) {
  return Boolean(record && WORKSPACE_OPERATION_SET.has(record.operation) &&
    record.targetKind !== 'browser' && record.targetKind !== 'process');
}

function deriveOperationFamilyCounts(records = []) {
  const operations = Array.isArray(records) ? records : [];
  return {
    workspaceOperations: operations.filter(isWorkspaceOperation).length,
    workspaceMutations: operations.filter(record =>
      isWorkspaceOperation(record) &&
      ['createFolder', 'writeFile', 'renamePath', 'deletePath'].includes(record.operation) &&
      !record.error &&
      (record.outcome === undefined || record.outcome === null || record.outcome === 'succeeded')
    ).length,
    browserOperations: operations.filter(isBrowserOperation).length,
    processOperations: operations.filter(isProcessOperation).length
  };
}

function dedupeAndSort(items, keyFor) {
  const unique = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) =>
    compareCanonicalText(keyFor(left), keyFor(right)));
}

function summarizeTypedOperationConsequences(consequence) {
  const browserOperations = consequence && Array.isArray(consequence.browserOperations)
    ? consequence.browserOperations
    : [];
  const processOperations = consequence && Array.isArray(consequence.processOperations)
    ? consequence.processOperations
    : [];
  const lines = [];
  if (browserOperations.length > 0) {
    lines.push(`Browser operations (${browserOperations.length}): ${browserOperations
      .map(item => `${item.operation} ${item.outcome}`)
      .slice(0, 10)
      .join(', ')}`);
  }
  if (processOperations.length > 0) {
    lines.push(`Process operations (${processOperations.length}): ${processOperations
      .map(item => `${item.profileId} ${item.terminalOutcome}`)
      .slice(0, 10)
      .join(', ')}`);
  }
  return {
    lines,
    browserOperationCount: browserOperations.length,
    processOperationCount: processOperations.length
  };
}

module.exports = {
  BROWSER_OPERATIONS,
  WORKSPACE_OPERATIONS,
  buildBrowserConsequenceFromHistory,
  buildBrowserConsequences,
  compareCanonicalText,
  deriveOperationFamilyCounts,
  dedupeAndSort,
  isBrowserOperation,
  isProcessOperation,
  isWorkspaceOperation,
  summarizeTypedOperationConsequences
};
