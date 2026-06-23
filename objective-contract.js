// Objective contract (v0.1.27) — pure, side-effect-free objective interpretation.
//
// This module is the future consolidation surface described in
// docs/objective-semantics-consolidation-plan.md. It converts a ticket objective
// string into a structured contract WITHOUT touching the workspace, events, runs,
// or any global state. It performs no I/O and makes no completion decisions.
//
// IMPORTANT (v0.1.27): this module is NOT wired into the runtime. server.js still
// uses its existing helpers. The grammar here mirrors those helpers exactly so a
// later slice can switch the runtime to consume this contract with zero behavior
// change. The regexes below are copied verbatim from server.js
// (extractSimpleDeleteTargets, buildObviousPostconditionChecks ensure-folder match,
// parseSimpleFolderListObjective, isReportObjective) and must stay in parity.

'use strict';

// Mirror of server.js cleanObjectivePath.
function cleanObjectivePath(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`,.]+$/g, '')
    .replace(/^\/+/, '');
}

// Mirror of server.js parseSimpleFolderListObjective (conservative list form).
function parseSimpleFolderListObjective(text, command) {
  const match = String(text || '').match(new RegExp(`^\\s*${command}\\s+folders?\\s+(.+?)\\s*[.!?]?\\s*$`, 'i'));
  if (!match) return null;

  let listText = match[1].trim();
  if (!listText) return null;

  if (command === 'ensure') {
    listText = listText.replace(/\s+exists?\s*$/i, '').trim();
  }
  if (!listText) return null;

  if (/\b(?:for|named|called|with|inside|containing|write|file|note|summary|report|then|after|before|into|under)\b/i.test(listText)) {
    return null;
  }

  const normalized = listText
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+and\s+/gi, ' ')
    .trim();

  if (!normalized || /[^A-Za-z0-9._/\-\s]/.test(normalized)) return null;

  const paths = normalized
    .split(/\s+/)
    .map(cleanObjectivePath)
    .filter(Boolean);

  return paths.length > 0 ? paths : null;
}

// Mirror of server.js extractSimpleDeleteTargets.
function extractDeleteTargets(text) {
  const match = text.match(/^(?:please\s+)?(?:delete|remove)\s+(?:the\s+)?(?:file|folder|directory|path)?\s*([A-Za-z0-9._/-]+)\s*\.?$/i);
  if (!match) return null;
  const target = cleanObjectivePath(match[1]);
  return target ? [target] : null;
}

// Mirror of server.js isReportObjective.
function isReportObjective(text) {
  return /\b(report|summary|synthesis|overview|analysis|status|audit)\b/i.test(text);
}

function unsupportedContract(notes) {
  return {
    source: 'objective-contract',
    recognized: false,
    intent: 'model_driven',
    targetPath: null,
    postconditions: [],
    allowedMutations: [],
    completionPolicy: 'model_required',
    scopeHints: [],
    runtimeProfile: null,
    notes: notes || ['unsupported_objective_form']
  };
}

// Convert a ticket objective string into a deterministic contract. Only the
// currently documented deterministic forms are recognized; everything else returns
// recognized:false / intent:model_driven so the runtime keeps the normal model path.
// Precedence: most specific deterministic form first (delete → ensure_folder →
// create_folder), then the softer report profile classifier, then model_driven.
function buildObjectiveContract(objective) {
  const text = String(objective || '').replace(/\s+/g, ' ').trim();
  if (!text) return unsupportedContract(['empty_objective']);

  // 1. Simple exact delete.
  const deleteTargets = extractDeleteTargets(text);
  if (deleteTargets) {
    const targetPath = deleteTargets[0];
    return {
      source: 'objective-contract',
      recognized: true,
      intent: 'delete',
      targetPath,
      postconditions: [{ type: 'path_absent', path: targetPath }],
      allowedMutations: [{ operation: 'deletePath', path: targetPath }],
      completionPolicy: 'idempotent_if_already_satisfied',
      scopeHints: [],
      runtimeProfile: null,
      notes: []
    };
  }

  // 2. Ensure folder(s) exist: "ensure folder X exists" (single) or "ensure folders X Y".
  let ensurePaths = null;
  const ensureSingle = text.match(/\bensure folder\s+([A-Za-z0-9._/-]+)\s+exists\b/i);
  if (ensureSingle) {
    ensurePaths = [cleanObjectivePath(ensureSingle[1])].filter(Boolean);
  } else {
    ensurePaths = parseSimpleFolderListObjective(text, 'ensure');
  }
  if (ensurePaths && ensurePaths.length > 0) {
    return {
      source: 'objective-contract',
      recognized: true,
      intent: 'ensure_folder',
      targetPath: ensurePaths.length === 1 ? ensurePaths[0] : null,
      postconditions: ensurePaths.map(p => ({ type: 'folder_exists', path: p })),
      allowedMutations: ensurePaths.map(p => ({ operation: 'createFolder', path: p })),
      completionPolicy: 'idempotent_if_already_satisfied',
      scopeHints: [],
      runtimeProfile: null,
      notes: []
    };
  }

  // 3. Create folder(s): "create folder X" / "create folders X Y".
  const createPaths = parseSimpleFolderListObjective(text, 'create');
  if (createPaths && createPaths.length > 0) {
    return {
      source: 'objective-contract',
      recognized: true,
      intent: 'create_folder',
      targetPath: createPaths.length === 1 ? createPaths[0] : null,
      postconditions: createPaths.map(p => ({ type: 'folder_exists', path: p })),
      allowedMutations: createPaths.map(p => ({ operation: 'createFolder', path: p })),
      completionPolicy: 'idempotent_if_already_satisfied',
      scopeHints: [],
      runtimeProfile: null,
      notes: []
    };
  }

  // 4. Report/summary profile (softer classifier; still model-driven, just bounded).
  if (isReportObjective(text)) {
    return {
      source: 'objective-contract',
      recognized: true,
      intent: 'report',
      targetPath: null,
      postconditions: [],
      allowedMutations: [],
      completionPolicy: 'model_required',
      scopeHints: [],
      runtimeProfile: 'report',
      notes: []
    };
  }

  // 5. Unsupported / free-form → normal model path.
  return unsupportedContract(['unsupported_objective_form']);
}

module.exports = {
  buildObjectiveContract
};
