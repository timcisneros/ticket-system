'use strict';

const fs = require('fs');

const WORK_TYPE_FIELDS = Object.freeze([
  'id',
  'name',
  'description',
  'status',
  'allowedTargetKinds'
]);
const WORK_TYPE_SNAPSHOT_FIELDS = Object.freeze([...WORK_TYPE_FIELDS, 'capturedAt']);
const WORK_TYPE_STATUSES = Object.freeze(['active', 'inactive']);
const WORK_TYPE_TARGET_KINDS = Object.freeze(['workspace', 'browser']);
const WORK_TYPE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class WorkTypeCatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkTypeCatalogError';
    this.code = 'WORK_TYPE_CATALOG_INVALID';
  }
}

function assertExactFields(value, allowedFields, label) {
  const unknownFields = Object.keys(value).filter(field => !allowedFields.includes(field));
  if (unknownFields.length > 0) {
    throw new WorkTypeCatalogError(`${label} contains unknown field(s): ${unknownFields.join(', ')}`);
  }
}

function validateWorkType(value, label = 'Work Type') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkTypeCatalogError(`${label} must be an object`);
  }
  assertExactFields(value, WORK_TYPE_FIELDS, label);

  if (typeof value.id !== 'string' || !WORK_TYPE_ID_PATTERN.test(value.id)) {
    throw new WorkTypeCatalogError(`${label} id must be a lowercase hyphen-separated slug`);
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new WorkTypeCatalogError(`${label} name must be a non-empty string`);
  }
  if (typeof value.description !== 'string' || !value.description.trim()) {
    throw new WorkTypeCatalogError(`${label} description must be a non-empty string`);
  }
  if (!WORK_TYPE_STATUSES.includes(value.status)) {
    throw new WorkTypeCatalogError(`${label} status must be active or inactive`);
  }
  if (!Array.isArray(value.allowedTargetKinds) || value.allowedTargetKinds.length === 0) {
    throw new WorkTypeCatalogError(`${label} allowedTargetKinds must be a non-empty array`);
  }
  if (value.allowedTargetKinds.some(kind => !WORK_TYPE_TARGET_KINDS.includes(kind))) {
    throw new WorkTypeCatalogError(`${label} allowedTargetKinds may contain only workspace or browser`);
  }
  if (new Set(value.allowedTargetKinds).size !== value.allowedTargetKinds.length) {
    throw new WorkTypeCatalogError(`${label} allowedTargetKinds must not contain duplicates`);
  }

  return {
    id: value.id,
    name: value.name.trim(),
    description: value.description.trim(),
    status: value.status,
    allowedTargetKinds: [...value.allowedTargetKinds]
  };
}

function validateWorkTypeCatalog(value) {
  if (!Array.isArray(value)) {
    throw new WorkTypeCatalogError('Work Type catalog must be a JSON array');
  }

  const ids = new Set();
  return value.map((item, index) => {
    const workType = validateWorkType(item, `Work Type at index ${index}`);
    if (ids.has(workType.id)) {
      throw new WorkTypeCatalogError(`Work Type catalog contains duplicate id: ${workType.id}`);
    }
    ids.add(workType.id);
    return workType;
  });
}

function readWorkTypeCatalog(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new WorkTypeCatalogError(`Work Type catalog could not be read: ${error.message}`);
  }
  return validateWorkTypeCatalog(parsed);
}

function snapshotWorkType(workType, capturedAt = new Date().toISOString()) {
  const validated = validateWorkType(workType);
  if (typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt))) {
    throw new WorkTypeCatalogError('Work Type snapshot capturedAt must be an ISO timestamp');
  }
  return { ...validated, allowedTargetKinds: [...validated.allowedTargetKinds], capturedAt };
}

function normalizeWorkTypeSnapshot(snapshot) {
  if (snapshot == null) return null;
  try {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    assertExactFields(snapshot, WORK_TYPE_SNAPSHOT_FIELDS, 'Work Type snapshot');
    const { capturedAt, ...workType } = snapshot;
    return snapshotWorkType(workType, capturedAt);
  } catch (_) {
    return null;
  }
}

function copyWorkTypeSnapshot(snapshot) {
  const normalized = normalizeWorkTypeSnapshot(snapshot);
  return normalized ? { ...normalized, allowedTargetKinds: [...normalized.allowedTargetKinds] } : null;
}

module.exports = {
  WORK_TYPE_FIELDS,
  WORK_TYPE_TARGET_KINDS,
  WorkTypeCatalogError,
  validateWorkTypeCatalog,
  readWorkTypeCatalog,
  snapshotWorkType,
  normalizeWorkTypeSnapshot,
  copyWorkTypeSnapshot
};
