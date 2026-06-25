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

  if (paths.length === 0) return null;
  if (paths.some(folderPath => !/^[A-Za-z0-9._/-]+$/.test(folderPath))) return null;
  return Array.from(new Set(paths));
}

// Mirror of server.js extractSimpleDeleteTargets.
function extractDeleteTargets(text) {
  const match = text.match(/^(?:please\s+)?(?:delete|remove)\s+(?:the\s+)?(?:file|folder|directory|path)?\s*([A-Za-z0-9._/-]+)\s*\.?$/i);
  if (!match) return null;
  const target = cleanObjectivePath(match[1]);
  return target ? [target] : null;
}

// Mirror of server.js isReportObjective: standalone report-keyword detector (no
// intent precedence). Case-insensitive keyword test, identical result to the
// historical server.js helper for every input.
function isReportObjective(text) {
  return /\b(report|summary|synthesis|overview|analysis|status|audit)\b/i.test(text);
}

// Mirror of server.js getReportRuntimeLimits: pure runtime-limit shaping for report
// objectives. Verbatim from server.js to preserve exact behavior.
function getReportRuntimeLimits(baseLimits) {
  return {
    ...baseLimits,
    maxExecutionSteps: Math.min(baseLimits.maxExecutionSteps, 12),
    maxModelRequestsPerRun: Math.min(baseLimits.maxModelRequestsPerRun, 8),
    maxListDirectoryPerRun: 3,
    maxReadFilePerRun: 8
  };
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

// Objective clarification gate — pre-execution ambiguity check.
//
// Accepts objective string and optional ticket context. For workflow-mode
// tickets the gate always returns clear (workflows have declared postconditions).
// For direct-action tickets the gate first tries the deterministic contract
// parser; if the objective is recognized with explicit targets it returns clear.
// If the objective is not recognized as a deterministic form, the gate checks
// for narrow patterns indicating quantified folder creation where the folder
// names will be generated by the model rather than specified by the user.
function runObjectiveClarificationGate(objective, ticket) {
  // Workflow-mode tickets have declared postconditions; skip the gate.
  if (ticket && ticket.executionMode === 'workflow') {
    return { verdict: 'clear', canExecuteWithoutClarification: true, expectedArtifacts: null };
  }

  const text = String(objective || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return { verdict: 'clear', canExecuteWithoutClarification: true, expectedArtifacts: null };
  }

  // 1. Deterministic form with explicit paths → clear.
  const contract = buildObjectiveContract(objective);
  if (contract.recognized && contract.allowedMutations.length > 0) {
    const paths = contract.allowedMutations
      .filter(m => m.operation !== 'deletePath')
      .map(m => m.path)
      .filter(Boolean);
    return {
      verdict: 'clear',
      canExecuteWithoutClarification: true,
      expectedArtifacts: paths.length > 0 ? paths : null
    };
  }

  // 2. Narrow ambiguity: quantified folder creation with generative naming.
  //    Check two independent patterns:
  //    a. quantified folder creation: "create <N> folders"
  //    b. generative naming signal: "each named", "each called", "named after"
  //    Both must be present for ambiguity. The separate checks avoid regex
  //    backtracking issues with greedy quantifiers before alternation groups.
  const hasQuantifiedFolders = /^create\s+\d+\s+folders?\b/i.test(text);
  const hasGenerativeNaming = /\b(each\s+(named|called)|named\s+after)\b/i.test(text);

  if (hasQuantifiedFolders && hasGenerativeNaming) {
    return {
      verdict: 'ambiguous',
      reasonCode: 'objective_ambiguous',
      requiredDecision: 'clarify_objective',
      summary: 'The objective asks to create a specific number of folders with generated names but does not provide the exact folder names.',
      ambiguityPatterns: ['quantified_generated_folder_names'],
      expectedArtifacts: null,
      canExecuteWithoutClarification: false,
      evidenceRefs: ['objective-contract:gate', 'objective-contract:ambiguous'],
      allowedActions: ['edit_objective', 'clarify_ticket'],
      prohibitedActions: ['mutate_workspace_without_clarification', 'start_run_without_clarification']
    };
  }

  // 3. No ambiguity detected.
  return {
    verdict: 'clear',
    canExecuteWithoutClarification: true,
    expectedArtifacts: null
  };
}

module.exports = {
  buildObjectiveContract,
  parseSimpleFolderListObjective,
  isReportObjective,
  getReportRuntimeLimits,
  runObjectiveClarificationGate
};
