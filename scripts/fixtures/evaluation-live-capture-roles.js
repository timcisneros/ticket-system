'use strict';

// Tranche 6 — which PROVIDER ROLE a captured outbound request belongs to.
//
// WHY THIS IS A MODULE AND NOT A LINE IN A TEST. A readiness verdict once
// claimed three roles on two captured requests. The classification that would
// have caught it lived inside the suite that made the claim, so nothing else
// could contradict it. Here it is ordinary code with its own proof, and the
// acceptance suite imports it rather than restating it.
//
// CLASSIFICATION IS FROM THE REQUEST ITSELF. The transport separates governed
// from ungoverned, and the planner contract's own system prompt identifies a
// planning request. Nothing consults the arm that produced the request: an arm
// label is what the harness asked for, not what production did.

// The planner contract's opening line, quoted from
// structured-allocation-planning-contract.js.
const PLANNER_MARKER = 'You are an allocation planner';

const ROLES = Object.freeze([
  'ungoverned_worker',
  'structured_planner',
  'governed_leaf_worker'
]);

class CaptureRoleError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CaptureRoleError';
    this.code = detail.code || 'CAPTURE_ROLE_INVALID';
    this.detail = detail;
  }
}

function bodyLooksLikePlanner(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return false; }
  const input = Array.isArray(parsed.input) ? parsed.input : [];
  return input.some(message => typeof message.content === 'string' &&
    message.content.includes(PLANNER_MARKER));
}

// The recorded `role` is the capture's own reading; the BODY is the evidence.
// They must agree, because a capture that mislabelled a request would make the
// three-role proof a statement about its own bookkeeping.
function classifyCapturedRole(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new CaptureRoleError('a captured request record is required');
  }
  if (entry.transport === 'ungoverned') return 'ungoverned_worker';
  if (entry.transport !== 'governed') {
    throw new CaptureRoleError(
      `unknown transport ${String(entry.transport)}`,
      { code: 'CAPTURE_ROLE_TRANSPORT_UNKNOWN', transport: entry.transport });
  }
  const planner = bodyLooksLikePlanner(entry.body);
  if (entry.role === 'planner' && !planner) {
    throw new CaptureRoleError(
      'a request recorded as the planner does not carry the planner contract',
      { code: 'CAPTURE_ROLE_DISAGREEMENT' });
  }
  return planner ? 'structured_planner' : 'governed_leaf_worker';
}

function countCapturedRoles(entries) {
  const counts = Object.fromEntries(ROLES.map(role => [role, 0]));
  for (const entry of entries) counts[classifyCapturedRole(entry)] += 1;
  return counts;
}

// THE THREE-ROLE PROOF. Every role needs its own actual request instance —
// "both transports covered" is two mechanisms, not three role paths.
function assertEveryRoleDispatched(entries) {
  const counts = countCapturedRoles(entries);
  const missing = ROLES.filter(role => counts[role] < 1);
  if (missing.length > 0) {
    throw new CaptureRoleError(
      `no outbound request was captured for: ${missing.join(', ')}`,
      { code: 'CAPTURE_ROLE_NOT_DISPATCHED', missing, counts });
  }
  return counts;
}

module.exports = {
  CaptureRoleError,
  PLANNER_MARKER,
  ROLES,
  assertEveryRoleDispatched,
  classifyCapturedRole,
  countCapturedRoles
};
