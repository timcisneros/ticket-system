// Objective contract — pure, side-effect-free objective interpretation.
//
// This module is the future consolidation surface described in
// docs/objective-semantics-consolidation-plan.md. It converts a ticket objective
// string into a structured contract WITHOUT touching the workspace, events, runs,
// or any global state. It performs no I/O and makes no completion decisions.
//
// server.js delegates deterministic objective interpretation here. The optional
// model compiler may also build a contract, but it is default-off and must remain
// in exact operation/target parity with the deterministic runtime guardrails.

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

  if (/\b(?:for|named|called|with|inside|containing|write|file|note|summary|report|then|after|before|into|under|to|through|need|older|than|each|all|every|some|many|few|several|various|multiple|workspace|project|layout|quarter|quarters|setup|set\s+up|organize|standard)\b/i.test(listText)) {
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

// Expand a single-letter alphabetical range such as "A" to "Z" or "a" to "z".
// Returns an array of single-character folder names, or null if unsafe.
function expandSingleLetterRange(start, end) {
  const startCode = start.charCodeAt(0);
  const endCode = end.charCodeAt(0);
  if (startCode > endCode) return null;

  const startUpper = start === start.toUpperCase();
  const endUpper = end === end.toUpperCase();
  if (startUpper !== endUpper) return null;

  const result = [];
  for (let code = startCode; code <= endCode; code += 1) {
    const ch = String.fromCharCode(code);
    if (startUpper && (ch < 'A' || ch > 'Z')) return null;
    if (!startUpper && (ch < 'a' || ch > 'z')) return null;
    result.push(ch);
  }
  return result;
}

// Expand a path token like "A-Z" into [A, B, ..., Z]. Returns null for non-ranges.
function expandFolderRangeToken(token) {
  const match = String(token || '').match(/^([A-Za-z])-([A-Za-z])$/);
  if (!match) return null;
  return expandSingleLetterRange(match[1], match[2]);
}

// Recognize safe explicit create-folder ranges:
//   Create folders A-Z
//   Create folders A through Z
//   Create folders A to Z
function parseCreateFolderRangeObjective(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^(?:please\s+)?create\s+folders?\s+([A-Za-z])\s*(?:-|–|to|through)\s*([A-Za-z])\s*\.?$/i);
  if (!match) return null;

  const [, start, end] = match;
  if (start === end) return [start];
  const expanded = expandSingleLetterRange(start, end);
  return expanded || null;
}

// Mirror of server.js extractSimpleDeleteTargets. Supports a single exact target
// ("delete file X") or a conservative list ("delete files X, Y, Z" / "delete X and Y").
// The list form requires an explicit enumerator (comma or "and") so vague objectives
// like "delete files older than 30 days" are not misclassified as an enumeration.
function extractDeleteTargets(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();

  // List form: triggered only when an explicit enumerator (comma or "and") is present
  // so vague objectives like "delete files older than 30 days" are not misclassified.
  if (/,|\band\b/i.test(normalized)) {
    const listMatch = normalized.match(/^(?:please\s+)?(?:delete|remove)\s+(?:the\s+)?(?:files?|folders?|directories?|paths?)?\s*(.+?)\s*[.!?]?$/i);
    if (listMatch) {
      let listText = listMatch[1].trim();
      if (!listText) return null;

      // Reject phrases that indicate additional instructions or generative naming.
      if (/\b(?:for|named|called|with|inside|containing|write|note|summary|report|then|after|before|into|under|each)\b/i.test(listText)) {
        return null;
      }

      const cleaned = listText
        .replace(/\s*,\s*/g, ' ')
        .replace(/\s+and\s+/gi, ' ')
        .trim();

      if (!cleaned || /[^A-Za-z0-9._/\-\s]/.test(cleaned)) return null;

      const paths = cleaned
        .split(/\s+/)
        .map(cleanObjectivePath)
        .filter(Boolean);

      if (paths.length === 0) return null;
      if (paths.some(p => !/^[A-Za-z0-9._/-]+$/.test(p))) return null;
      return Array.from(new Set(paths));
    }
  }

  // Single exact target.
  const singleMatch = normalized.match(/^(?:please\s+)?(?:delete|remove)\s+(?:the\s+)?(?:file|folder|directory|path)?\s*([A-Za-z0-9._/-]+)\s*\.?$/i);
  if (singleMatch) {
    const target = cleanObjectivePath(singleMatch[1]);
    return target ? [target] : null;
  }

  return null;
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

  // 1. Simple delete (single target or conservative list).
  const deleteTargets = extractDeleteTargets(text);
  if (deleteTargets) {
    if (deleteTargets.length === 1) {
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

    return {
      source: 'objective-contract',
      recognized: true,
      intent: 'delete',
      targetPath: null,
      postconditions: deleteTargets.map(p => ({ type: 'path_absent', path: p })),
      allowedMutations: deleteTargets.map(p => ({ operation: 'deletePath', path: p })),
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

  // 3. Create folder(s): explicit range, list, or single folder.
  let createPaths = parseCreateFolderRangeObjective(text);
  let createPathsFromList = false;
  if (!createPaths) {
    createPaths = parseSimpleFolderListObjective(text, 'create');
    createPathsFromList = createPaths && createPaths.length > 0;
  }
  // Multi-token list forms must use an explicit enumerator (comma or "and") so
  // vague space-separated phrases like "create folders I need" stay model-driven.
  if (createPathsFromList && createPaths.length > 1 && !/,/.test(text) && !/\band\b/i.test(text)) {
    createPaths = null;
  }
  if (createPaths && createPaths.length > 0) {
    // Expand any single-letter range tokens inside a list (e.g. "create folders A, C-Z").
    createPaths = Array.from(new Set(createPaths.flatMap(p => expandFolderRangeToken(p) || [p])));
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

  // 2. Narrow ambiguity: quantified category folder creation.
  //    Catches "Create <N> <descriptor> folders" where the descriptor is a
  //    category/source phrase (e.g. "Michael Jackson songs") rather than
  //    explicit artifact names. Excludes descriptors containing list
  //    separators (commas, quotes, semicolons) that would indicate explicit
  //    enumeration. This pattern is intentionally narrow; it is better to
  //    miss some ambiguous cases than block normal tickets.
  const hasQuantifiedCategoryFolders = /^create\s+\d+\s+.+\s+(?:folders?|files?)\s*$/i.test(text);
  const hasListSeparators = /["',;]/.test(text);

  if (hasQuantifiedCategoryFolders && !hasListSeparators) {
    return {
      verdict: 'ambiguous',
      reasonCode: 'objective_ambiguous',
      requiredDecision: 'clarify_objective',
      summary: 'The objective asks to create a specific number of folders based on a category but does not provide the exact folder names.',
      ambiguityPatterns: ['quantified_category_folder_creation'],
      expectedArtifacts: null,
      canExecuteWithoutClarification: false,
      evidenceRefs: ['objective-contract:gate', 'objective-contract:ambiguous'],
      allowedActions: ['edit_objective', 'clarify_ticket'],
      prohibitedActions: ['mutate_workspace_without_clarification', 'start_run_without_clarification']
    };
  }

  // 3. Narrow ambiguity: quantified folder creation with generative naming.
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

  // 4. No ambiguity detected.
  return {
    verdict: 'clear',
    canExecuteWithoutClarification: true,
    expectedArtifacts: null
  };
}

// Compiled contract intents produced by the model-assisted preflight compiler.
const COMPILED_INTENTS = Object.freeze([
  'create_folders',
  'ensure_folders',
  'delete_paths',
  'model_driven'
]);

function isSafeCompiledPathSegment(value) {
  const segment = String(value || '').trim();
  if (!segment) return false;
  if (segment === '.') return false;
  if (segment.startsWith('.')) return false;
  if (segment.includes('..')) return false;
  if (segment.includes('/')) return false;
  if (segment.includes('\\')) return false;
  if (/[\0\x00-\x1f]/.test(segment)) return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}

function normalizeCompiledTargetRoot(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith('\\')) return null;
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return '';
  if (normalized.split('/').some(segment => !isSafeCompiledPathSegment(segment))) return null;
  return normalized;
}

function joinTargetRoot(root, target) {
  if (!root) return target;
  return `${root}/${target}`;
}

function isSafeCompiledRelativePath(value) {
  const relativePath = String(value || '').trim();
  if (!relativePath || relativePath.startsWith('/') || relativePath.endsWith('/')) return false;
  return relativePath.split('/').every(isSafeCompiledPathSegment);
}

// Validate a model-produced compiled contract and convert it into the standard
// objective-contract shape so the existing feasibility gate can consume it.
function buildObjectiveContractFromCompiled(compiled) {
  if (!compiled || typeof compiled !== 'object' || Array.isArray(compiled)) {
    return unsupportedContract(['compiled_contract_not_an_object']);
  }

  const allowedFields = new Set(['intent', 'targetRoot', 'targets']);
  const unknownFields = Object.keys(compiled).filter(field => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    return unsupportedContract(['compiled_contract_unknown_fields', ...unknownFields.sort()]);
  }

  const intent = String(compiled.intent || '').trim();
  if (!COMPILED_INTENTS.includes(intent)) {
    return unsupportedContract(['compiled_contract_unknown_intent', intent]);
  }

  if (intent === 'model_driven') {
    return unsupportedContract(['compiled_contract_model_driven']);
  }

  const targetRoot = normalizeCompiledTargetRoot(compiled.targetRoot);
  if (targetRoot === null) {
    return unsupportedContract(['compiled_contract_unsafe_target_root']);
  }

  const rawTargets = Array.isArray(compiled.targets) ? compiled.targets : [];
  if (rawTargets.length === 0) {
    return unsupportedContract(['compiled_contract_empty_targets']);
  }

  const normalizedTargets = [];
  for (const raw of rawTargets) {
    const segment = String(raw || '').trim();
    if (!isSafeCompiledPathSegment(segment)) {
      return unsupportedContract(['compiled_contract_unsafe_target', segment]);
    }
    const fullPath = joinTargetRoot(targetRoot, segment);
    if (!isSafeCompiledRelativePath(fullPath)) {
      return unsupportedContract(['compiled_contract_unsafe_target', fullPath]);
    }
    normalizedTargets.push(fullPath);
  }

  const uniqueTargets = Array.from(new Set(normalizedTargets));

  switch (intent) {
    case 'create_folders':
      return {
        source: 'objective-contract',
        recognized: true,
        intent: 'create_folder',
        targetPath: uniqueTargets.length === 1 ? uniqueTargets[0] : null,
        postconditions: uniqueTargets.map(p => ({ type: 'folder_exists', path: p })),
        allowedMutations: uniqueTargets.map(p => ({ operation: 'createFolder', path: p })),
        completionPolicy: 'idempotent_if_already_satisfied',
        scopeHints: [],
        runtimeProfile: null,
        notes: ['compiled_contract']
      };
    case 'ensure_folders':
      return {
        source: 'objective-contract',
        recognized: true,
        intent: 'ensure_folder',
        targetPath: uniqueTargets.length === 1 ? uniqueTargets[0] : null,
        postconditions: uniqueTargets.map(p => ({ type: 'folder_exists', path: p })),
        allowedMutations: uniqueTargets.map(p => ({ operation: 'createFolder', path: p })),
        completionPolicy: 'idempotent_if_already_satisfied',
        scopeHints: [],
        runtimeProfile: null,
        notes: ['compiled_contract']
      };
    case 'delete_paths':
      return {
        source: 'objective-contract',
        recognized: true,
        intent: 'delete',
        targetPath: uniqueTargets.length === 1 ? uniqueTargets[0] : null,
        postconditions: uniqueTargets.map(p => ({ type: 'path_absent', path: p })),
        allowedMutations: uniqueTargets.map(p => ({ operation: 'deletePath', path: p })),
        completionPolicy: 'idempotent_if_already_satisfied',
        scopeHints: [],
        runtimeProfile: null,
        notes: ['compiled_contract']
      };
    default:
      return unsupportedContract(['compiled_contract_unsupported_intent', intent]);
  }
}

module.exports = {
  buildObjectiveContract,
  parseSimpleFolderListObjective,
  isReportObjective,
  getReportRuntimeLimits,
  runObjectiveClarificationGate,
  COMPILED_INTENTS,
  buildObjectiveContractFromCompiled
};
