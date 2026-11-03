'use strict';

// Canonical executable environment/configuration registry (P6-S2).
//
// Authority: P6 deployment/operations design freeze (register record
// "P6 — DEPLOYMENT / OPERATIONS — semantic design freeze", §10; the operated
// restatement in docs/DEPLOYMENT_CONTRACT.md §8). ONE machine-readable owner
// of supported application/deployment environment settings. It drives or
// parity-validates `.env.example`, `dev:doctor`, setup guidance, and
// documentation parity, and it replaces scattered hand-maintained ownership.
// NO second prose master list is created.
//
// Non-disclosure: the registry classifies secrets and NEVER exposes secret
// VALUES. Validation failures name the setting; they never echo, print,
// serialize, or log the value (including DATABASE_URL, which embeds
// credentials). Health/config diagnostics may identify the NAME of a missing
// or invalid setting only.
//
// Classification categories, exactly the ones the freeze names:
//   application  — supported deployment configuration (server + dev tooling)
//   secret       — secret-bearing configuration; values are never surfaced
//   provider     — model-provider/browser engine configuration
//   development  — development tooling only; not server deployment config
//   test-only    — internal test hooks; NEVER in .env.example and never
//                  promoted to supported deployment configuration
//
// Every entry carries the frozen minimum fields:
//   name — the exact environment variable name;
//   classification — one of the categories above;
//   category — the owning subsystem;
//   required — 'always' (boot refuses when absent) | 'never' |
//              'bootstrap-only' (creation-only; ignored once the admin exists);
//   validation — the deterministic validation semantics;
//   developmentDefault / productionBehavior — the explicit development and
//              production default semantics;
//   canonicalDefault — the machine-verifiable owner default value (null when
//              the setting has no fixed default or a derived owner value);
//   flagValue — the exact enabling value for default-off feature gates;
//   secret — boolean classification in addition to the category.
//
// OWNERSHIP classification (P6-S2 defect C — one executable owner, no fourth
// category). Every supported setting is exactly one of:
//   DRIVER        — runtime parsing/default/validation consumes a canonical
//                   value or parser EXPORTED by this registry:
//                   SESSION_SECRET, DATABASE_URL (boot + tooling),
//                   ADMIN_BOOTSTRAP_PASSWORD (tooling; creation-only),
//                   PUBLIC_BASE_URL (validateHttpOrigin at boot), the
//                   readiness-configuration diagnosis (validateEnvironment),
//                   .env.example/parity, and the WORKSPACE_ROOT/ARTIFACT_ROOT
//                   usability boundary (effectRootReadiness).
//   PARITY-BOUND — a specialized existing owner remains the runtime authority
//                   and the owning parity test mechanically compares this
//                   metadata (canonicalDefault / flagValue / semantics) to
//                   that owner's actual values. The registry is never a second
//                   runtime authority for these.
//   NOT REGISTRY-OWNED — there is no fourth category here: no supported
//                   setting is "prose-recorded, human-synchronized". The
//                   owning parity test (p6-s2-health-readiness-contract-test)
//                   fails on any drift, including a forged default.

const { resolveMutationAdmissionOptions } = require('./mutation-admission');

const CLASSIFICATIONS = Object.freeze([
  'application',
  'secret',
  'provider',
  'development',
  'test-only'
]);

const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_ADMIN_PASSWORD_LENGTH = 12;
const PLACEHOLDER_PASSWORD = 'replace-with-a-local-development-password';

const MUTATION_ADMISSION_DEFAULTS = resolveMutationAdmissionOptions({});

function parsePositiveInteger(value) {
  const parsed = parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// Shared validation semantics. These functions own the exact failure messages
// used by the server boot surface and the development tooling surface so the
// two cannot drift. They never render the offending VALUE.
//
// Owner-fallback vs STRICT integer semantics — two distinct parser doctrines,
// never conflated:
//
// - OWNER-FALLBACK (`parsePositiveInteger` above) mirrors owners that
//   deliberately keep leading-decimal fallback parsing (`getPositiveIntegerEnv`
//   in server.js and `positiveInteger` in runtime/mutation-admission.js). A
//   value such as `12abc` keeps the canonical default there — it NEVER refuses
//   and never becomes a deployment refusal. Only the settings declared with
//   that owner-fallback semantics consume it.
// - STRICT validation helpers are for settings whose DECLARED contract is
//   that the supported value itself must be a canonical form (the port-like
//   settings). The WHOLE value must be that supported form: a partial numeric
//   prefix never becomes one (`3099junk` is never port 3099, `5432junk` is
//   never port 5432), and PORT additionally carries the repository-owned
//   authority rule recorded with `parseCanonicalPort` below — the registry,
//   NOT the ambient HTTP transport, defines which environment values are
//   supported configuration.
//
// Positive-integer overrides NEVER refuse at boot: the canonical owners
// (`getPositiveIntegerEnv` in server.js and `positiveInteger` in
// runtime/mutation-admission.js) parse the leading decimal value and keep the
// canonical default for anything unparsable or non-positive. The registry
// metadata mirrors that owner semantics exactly — it must not invent
// fail-closed behavior the runtime does not have.

// CANONICAL PORT grammar — repository-owned (P6-S2 review-B defect 1).
//
// Authority direction: Node/Fastify remains the low-level HTTP transport.
// server.js keeps `const PORT = process.env.PORT || 3099;` and forwards the
// bound value to `fastify.listen({ port: PORT, host: '0.0.0.0' })`. The
// repository's canonical configuration registry — NOT the transport — defines
// which environment values are SUPPORTED configuration before transport
// invocation: only the canonical decimal PORT syntax is allowed through boot
// validation. Incidental coercions Node/Fastify may happen to perform during
// listen (sign/exponent/hexadecimal/radix forms, padded text, fractional
// decimals) are outside the supported configuration contract. That exclusion
// is deliberate; the registry must not restate ambient transport coercion as
// the canonical contract.
//
// The canonical grammar is a full-string rule. The WHOLE value must consist of
// ASCII base-10 decimal digits (`^[0-9]+$`; leading decimal zeroes are the
// same supported integer, e.g. `03099`), followed by safe-integer/range
// validation. No sign, no ASCII whitespace, no underscore separators, no
// radix prefix, no fractional part, and no exponent form is part of the
// supported grammar; non-ASCII digit lookalikes are refused by the same rule.
// The supported range is 1 through 65535 (port 0 binds an OS-assigned
// ephemeral port and is outside the supported grammar).
function parseCanonicalPort(value) {
  const text = String(value ?? '');
  if (!/^[0-9]+$/.test(text)) return null;
  const parsed = Number(text);
  // Safe-integer validation guards extremely long digit strings (Number
  // coercion / non-safe values are outside the supported range) without ever
  // becoming the grammar itself: the digits rule above is canonical.
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

// TICKET_SYSTEM_POSTGRES_PORT owner semantics (recovered exactly):
// scripts/dev-environment.js `resolveDevelopmentDatabaseTarget` consumes the
// configured value through `String(env.TICKET_SYSTEM_POSTGRES_PORT || '').trim()`
// and throws `TICKET_SYSTEM_POSTGRES_PORT must be an integer from 1 through
// 65535` unless the WHOLE trimmed value is decimal digits (`/^\d+$/`), a safe
// integer, and within [1, 65535]. The owner consumes the value already
// trimmed, so a whitespace-only value is unset (the bundled default), exactly
// like absence — while '+5432', '5432.5', and trailing junk ('5432junk') are
// refused: a partial numeric prefix never becomes the port. This helper
// mirrors that owner rule exactly (full-value, never a partial prefix).
function parseStrictDecimalBoundedInteger(value, min, max) {
  const text = String(value ?? '').trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}


function validatePostgresUrl(value) {
  const text = String(value || '').trim();
  if (!text) return 'DATABASE_URL is required';
  try {
    const parsed = new URL(text);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      return 'DATABASE_URL must use postgres:// or postgresql://';
    }
    if (!parsed.pathname || parsed.pathname === '/') return 'DATABASE_URL must name a database';
  } catch (_) {
    return 'DATABASE_URL must be a valid PostgreSQL URL';
  }
  return null;
}

function validateSessionSecret(value) {
  const text = String(value || '');
  if (!text) return 'SESSION_SECRET is required';
  if (text === 'replace-with-at-least-32-random-characters') {
    return 'SESSION_SECRET is still the example placeholder';
  }
  // THE one canonical supported rule, consumed identically by the server boot
  // surface (server.js resolveSessionSecret), the development tooling
  // (dev:doctor / dev:setup) and the health/readiness diagnosis: the secret is
  // REQUIRED, its value must be at least 32 characters, and the example
  // placeholder is refused. Refusals name the rule; they never echo the value.
  if (text.length < MIN_SESSION_SECRET_LENGTH) {
    return `SESSION_SECRET must contain at least ${MIN_SESSION_SECRET_LENGTH} characters`;
  }
  return null;
}

function validateAdminPassword(value, { required = false } = {}) {
  const text = String(value || '');
  if (!text) return required ? 'ADMIN_BOOTSTRAP_PASSWORD is required to create the first admin' : null;
  if (text === PLACEHOLDER_PASSWORD) return 'ADMIN_BOOTSTRAP_PASSWORD is still the example placeholder';
  if (text.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `ADMIN_BOOTSTRAP_PASSWORD must contain at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

// http-origin semantics moved verbatim from server.js resolvePublicOrigin so
// one owner serves the server boot rule and the doctor/registry parity rule.
function validateHttpOrigin(value) {
  const configured = String(value || '').trim();
  if (!configured) return null;
  let parsed;
  try {
    parsed = new URL(configured);
  } catch (_) {
    return 'PUBLIC_BASE_URL must be a valid absolute HTTP(S) origin';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== configured.replace(/\/$/, '')) {
    return 'PUBLIC_BASE_URL must be an exact HTTP(S) origin without a path, credentials, query, or fragment';
  }
  return null;
}

function validatePort(value) {
  // Canonical repository-owned grammar (see parseCanonicalPort above): the
  // WHOLE explicit value must be ASCII base-10 decimal digits within 1..65535.
  // The registry defines the supported configuration BEFORE the transport is
  // ever invoked; it does not mirror the HTTP transport's permissive runtime
  // coercion, and port 0 is simply outside the supported range 1..65535.
  const parsed = parseCanonicalPort(value);
  if (parsed === null) return 'PORT must be an integer from 1 through 65535';
  return null;
}

function validateEnum(value, allowed, name) {
  const text = String(value || '').trim();
  if (!allowed.includes(text)) return `${name} must be one of ${allowed.join(', ')}`;
  return null;
}

// ── POSITIVE-INTEGER TEMPLATE ──────────────────────────────────────────────
// `canonicalDefault` is the machine-verifiable owner default (null when the
// setting has no fixed default or a derived owner value); the owning parity
// test compares it against the actual executable owner literal.

function positiveIntegerSetting(name, extra = {}) {
  return {
    name,
    classification: 'application',
    category: extra.category || 'runtime-limit',
    exposure: extra.exposure === true,
    required: 'never',
    validation: 'positive-integer-fallback: when set, the canonical owner accepts only a positive integer parse; any unparsable or non-positive value keeps the canonical default and never refuses startup',
    canonicalDefault: extra.canonicalDefault === undefined ? null : extra.canonicalDefault,
    developmentDefault: extra.developmentDefault,
    productionBehavior: 'same default as development when unset; a numeric value overrides it',
    secret: false,
    ...extra
  };
}

function booleanTrueFlag(name, extra = {}) {
  const flagValue = extra.flagValue === undefined ? 'true' : extra.flagValue;
  return {
    name,
    classification: 'application',
    category: extra.category || 'feature-gate',
    exposure: extra.exposure === true,
    required: 'never',
    validation: `exact "${flagValue}" enables it; absence or any other value (commonly "false") leaves the feature in its default state and NEVER refuses startup (exact owner semantics)`,
    canonicalDefault: null,
    flagValue,
    developmentDefault: `disabled (${flagValue} enables; commonly given "false" keeps it disabled)`,
    productionBehavior: 'same default as development when unset; the exact flag value enables it',
    secret: false,
    ...extra
  };
}

// ── SUPPORTED APPLICATION / DEPLOYMENT SETTINGS ────────────────────────────
//
// Each entry is derived from the owning seam (repository bytes are
// authoritative): server.js boot reads, persistence/runtime-backend.js,
// runtime/mutation-admission.js, runtime/process-execution-contract.js, the
// process client default constants, dev-environment.js, dev-doctor.js, and
// dev-agent-config.js. Defaults are cross-checked by the owning contract test
// against the importable constants where an importable owner exists.

const SETTINGS = Object.freeze([
  // ── Persistence / PostgreSQL ────────────────────────────────────────────
  {
    name: 'DATABASE_URL',
    classification: 'secret',
    category: 'persistence',
    exposure: true,
    required: 'always',
    validation: 'non-empty postgres:// or postgresql:// URL that names a database; never echoed, printed, or serialized',
    canonicalDefault: null,
    developmentDefault: 'bundled development database URL; TICKET_SYSTEM_POSTGRES_PORT may override the bundled port (scripts/dev-environment.js)',
    productionBehavior: 'required; startup refuses when absent (fail-closed)',
    secret: true
  },
  {
    name: 'POSTGRES_SCHEMA',
    classification: 'application',
    category: 'persistence',
    exposure: true,
    required: 'never',
    validation: 'non-empty PostgreSQL schema name; non-empty text is stored trimmed',
    canonicalDefault: 'ticket_system',
    developmentDefault: 'ticket_system',
    productionBehavior: 'same default as development when unset ("ticket_system")',
    secret: false
  },
  positiveIntegerSetting('POSTGRES_POOL_MAX', {
    category: 'persistence',
    canonicalDefault: 16,
    developmentDefault: '16 (pool size of the canonical PostgreSQL runtime store)',
    productionBehavior: 'same default as development when unset (16)'
  }),
  positiveIntegerSetting('POSTGRES_CONNECTION_TIMEOUT_MS', {
    category: 'persistence',
    canonicalDefault: 5000,
    developmentDefault: '5000 (connection timeout milliseconds)',
    productionBehavior: 'same default as development when unset (5000)'
  }),
  positiveIntegerSetting('POSTGRES_STATEMENT_TIMEOUT_MS', {
    category: 'persistence',
    canonicalDefault: 30000,
    developmentDefault: '30000 (statement timeout milliseconds)',
    productionBehavior: 'same default as development when unset (30000)'
  }),
  positiveIntegerSetting('POSTGRES_LOCK_TIMEOUT_MS', {
    category: 'persistence',
    canonicalDefault: 5000,
    developmentDefault: '5000 (Advisory/row lock timeout milliseconds)',
    productionBehavior: 'same default as development when unset (5000)'
  }),
  {
    name: 'PERSISTENCE_BACKEND',
    classification: 'application',
    category: 'persistence',
    exposure: false,
    required: 'never',
    validation: 'when set, the value is trimmed, lowercased, and must equal "postgres" (the exact canonical runtime-backend owner semantics); any other value is refused by that owner at boot',
    canonicalDefault: null,
    developmentDefault: 'postgres (the only supported runtime backend)',
    productionBehavior: 'same default as development; a non-postgres value is refused',
    secret: false
  },

  // ── HTTP surface ───────────────────────────────────────────────────────
  {
    name: 'PORT',
    classification: 'application',
    category: 'http',
    exposure: true,
    required: 'never',
    validation: 'when set, the WHOLE value must be ASCII base-10 decimal digits whose integer value is within 1..65535 (canonical owner: the registry validatePort consumed by the server boot surface; Node/Fastify remains the low-level HTTP transport, and incidental transport coercions are outside the supported configuration contract). Port 0 is outside the supported grammar (1..65535); absence keeps the canonical default',
    canonicalDefault: 3099,
    developmentDefault: '3099 (HTTP listen port)',
    productionBehavior: 'same default as development when unset (3099)',
    secret: false
  },
  {
    name: 'TRUST_PROXY',
    classification: 'application',
    category: 'http',
    exposure: false,
    required: 'never',
    validation: 'exact "true" enables Fastify trustProxy; any other value means not trusted',
    canonicalDefault: null,
    flagValue: 'true',
    developmentDefault: 'disabled (proxy headers are not trusted)',
    productionBehavior: 'same default as development; "true" trusts proxy headers (needed behind a reverse proxy)',
    secret: false
  },
  {
    name: 'PUBLIC_BASE_URL',
    classification: 'application',
    category: 'http',
    exposure: false,
    required: 'never',
    validation: 'when set, must be a valid absolute HTTP(S) origin without a path, credentials, query, or fragment (canonical owner: the registry validateHttpOrigin consumed by the server boot surface)',
    canonicalDefault: null,
    developmentDefault: 'unset (no public origin; session cookies follow the served origin)',
    productionBehavior: 'when set, drives CSRF origin comparison and HTTPS "secure" session cookies; invalid values refuse startup',
    secret: false
  },

  // ── Sessions ───────────────────────────────────────────────────────────
  {
    name: 'SESSION_SECRET',    classification: 'secret',
    category: 'sessions',
    exposure: true,
    required: 'always',
    validation: 'non-empty stable high-entropy value; the ONE canonical supported rule (32 characters minimum, placeholder refused) is consumed by the server boot surface, the development tooling, and the health/readiness diagnosis; the value is never echoed, printed, or serialized',
    canonicalDefault: null,
    developmentDefault: 'generated 64-hex-character value when interactive setup creates .env.local',
    productionBehavior: 'required; startup refuses when absent or below the canonical minimum (fail-closed)',
    secret: true
  },
  positiveIntegerSetting('SESSION_PURGE_INTERVAL_MS', {
    category: 'sessions',
    exposure: true,
    canonicalDefault: 60000,
    developmentDefault: '60000 (expired-session purge interval)',
    productionBehavior: 'same default as development when unset (60000)'
  }),
  positiveIntegerSetting('SESSION_PURGE_BATCH_SIZE', {
    category: 'sessions',
    exposure: true,
    canonicalDefault: 1000,
    developmentDefault: '1000 (batch size, also the current repository maximum)',
    productionBehavior: 'same default as development when unset (1000)'
  }),

  // ── Bootstrap / secrets ────────────────────────────────────────────────
  {
    name: 'ADMIN_BOOTSTRAP_PASSWORD',
    classification: 'secret',
    category: 'bootstrap',
    exposure: true,
    required: 'bootstrap-only',
    validation: 'creation-only, minimum 12 characters; ignored completely once the initial admin exists; the placeholder value is refused; the value is never echoed, printed, or serialized',
    canonicalDefault: null,
    developmentDefault: 'unset; interactive setup prompts securely instead of storing it',
    productionBehavior: 'required to create the FIRST admin when none exists (startup refuses otherwise, fail-closed); ignored after the admin exists',
    secret: true
  },

  // ── Host-local effect roots ────────────────────────────────────────────
  {
    name: 'WORKSPACE_ROOT',
    classification: 'application',
    category: 'effect-root',
    exposure: true,
    required: 'never',
    validation: 'existing-or-creatable filesystem path usable as the host-local workspace root (directory-boundary semantics owned by runtime/health-readiness.js)',
    canonicalDefault: 'workspace-root',
    developmentDefault: 'workspace-root (resolved under the repository root; one canonical default shared by server and dev tooling)',
    productionBehavior: 'same relative default ("workspace-root") resolved under the deployment working directory',
    secret: false
  },
  {
    name: 'ARTIFACT_ROOT',
    classification: 'application',
    category: 'effect-root',
    exposure: true,
    required: 'never',
    validation: 'existing-or-creatable absolute-capable filesystem path usable as the artifact root (directory-boundary semantics owned by runtime/health-readiness.js)',
    canonicalDefault: '.local-artifacts',
    developmentDefault: '.local-artifacts (resolved under the repository root)',
    productionBehavior: 'same relative default (".local-artifacts") resolved under the deployment working directory',
    secret: false
  },

  // ── Run admission / deployment work capacity (CAPACITY, not readiness) ──
  positiveIntegerSetting('MAX_ACTIVE_RUNS', {
    category: 'work-capacity',
    exposure: true,
    canonicalDefault: 32,
    developmentDefault: '32 (deployment-wide default inherited into runtime_limit_config)',
    productionBehavior: 'same default as development when unset (32); the administrator-configurable value stays bounded by MAX_ACTIVE_RUNS_CAP'
  }),
  positiveIntegerSetting('MAX_ACTIVE_RUNS_CAP', {
    category: 'work-capacity',
    exposure: true,
    canonicalDefault: 4096,
    developmentDefault: '4096 (absolute ceiling the admin surface may raise MAX_ACTIVE_RUNS to)',
    productionBehavior: 'same default as development when unset (4096)'
  }),
  positiveIntegerSetting('LOCAL_MODEL_CONCURRENCY', {
    category: 'work-capacity',
    exposure: true,
    canonicalDefault: 1,
    developmentDefault: '1 (deployment-wide default inherited into runtime_limit_config)',
    productionBehavior: 'same default as development when unset (1); ceiling is MAX_LOCAL_MODEL_CONCURRENCY'
  }),
  positiveIntegerSetting('MAX_LOCAL_MODEL_CONCURRENCY', {
    category: 'work-capacity',
    exposure: true,
    canonicalDefault: 32,
    developmentDefault: '32 (absolute ceiling for local model concurrency)',
    productionBehavior: 'same default as development when unset (32)'
  }),
  {
    name: 'MUTATION_ADMISSION_MAX_OUTSTANDING',
    classification: 'application',
    category: 'work-capacity',
    exposure: false,
    required: 'never',
    validation: 'when set, the canonical owner runtime/mutation-admission.js accepts only a positive integer parse; anything else keeps the canonical default (never a startup refusal)',
    canonicalDefault: MUTATION_ADMISSION_DEFAULTS.maxOutstanding,
    developmentDefault: `256 (process-local outstanding mutation reservation slots)`,
    productionBehavior: 'same default as development when unset (256; canonical owner runtime/mutation-admission.js)',
    secret: false
  },
  {
    name: 'MUTATION_ADMISSION_MAX_RESERVATION_BYTES',
    classification: 'application',
    category: 'work-capacity',
    exposure: false,
    required: 'never',
    validation: 'when set, the canonical owner runtime/mutation-admission.js accepts only a positive integer parse; anything else keeps the canonical default (never a startup refusal)',
    canonicalDefault: MUTATION_ADMISSION_DEFAULTS.maxReservationBytes,
    developmentDefault: `2 MiB (${MUTATION_ADMISSION_DEFAULTS.maxReservationBytes} bytes; per-record event reservation ceiling)`,
    productionBehavior: 'same default as development when unset (2 MiB; canonical owner runtime/mutation-admission.js)',
    secret: false
  },
  {
    name: 'MUTATION_ADMISSION_MAX_OUTSTANDING_BYTES',
    classification: 'application',
    category: 'work-capacity',
    exposure: false,
    required: 'never',
    validation: 'when set, the canonical owner runtime/mutation-admission.js accepts only a positive integer parse; anything else keeps the derived owner default (never a startup refusal)',
    canonicalDefault: null,
    developmentDefault: `derived (${MUTATION_ADMISSION_DEFAULTS.maxOutstandingBytes} bytes by default: MaxOutstanding x MaxReservationBytes)`,
    productionBehavior: 'derived from the two settings above when unset; canonical owner runtime/mutation-admission.js',
    secret: false
  },

  // ── Scheduler / leases ─────────────────────────────────────────────────
  positiveIntegerSetting('RUNTIME_SCHEDULER_INTERVAL_MS', {
    category: 'scheduler',
    canonicalDefault: 500,
    developmentDefault: '500 (runtime scheduler polling interval)',
    productionBehavior: 'same default as development when unset (500)'
  }),
  positiveIntegerSetting('RUNTIME_SCHEDULER_CANDIDATE_LIMIT', {
    category: 'scheduler',
    canonicalDefault: 1000,
    developmentDefault: '1000 (bounded candidate read size and store query row cap)',
    productionBehavior: 'same default as development when unset (1000)'
  }),
  positiveIntegerSetting('PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS', {
    category: 'scheduler',
    canonicalDefault: 60000,
    developmentDefault: '60000 (process template scheduler interval)',
    productionBehavior: 'same default as development when unset (60000)'
  }),
  positiveIntegerSetting('RUN_LEASE_DURATION_MS', {
    category: 'scheduler',
    canonicalDefault: null,
    developmentDefault: 'unset (lease duration stays governed by the deployment runtime policy rather than the environment; the server owner keeps its DEFAULT_RUN_LEASE_DURATION_MS)',
    productionBehavior: 'when set, overrides the runtime-policy lease duration for newly admitted runs'
  }),
  positiveIntegerSetting('SHUTDOWN_RUN_DRAIN_TIMEOUT_MS', {
    category: 'scheduler',
    canonicalDefault: 120000,
    developmentDefault: '120000 (bounded shutdown drain deadline)',
    productionBehavior: 'same default as development when unset (120000)'
  }),

  // ── Runtime limits (deployment defaults for the administrator surface) ──
  positiveIntegerSetting('AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE', {
    category: 'runtime-limit',
    canonicalDefault: 2,
    developmentDefault: '2 (mutating actions accepted per model response)',
    productionBehavior: 'same default as development when unset (2)'
  }),
  positiveIntegerSetting('AGENT_MAX_ATTEMPTS', {
    category: 'runtime-limit',
    canonicalDefault: 3,
    developmentDefault: '3 (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxAttempts; the administrator surface stays the runtime authority for these values)',
    productionBehavior: 'same default as development when unset (3)'
  }),
  positiveIntegerSetting('AGENT_MAX_EXECUTION_STEPS', {
    category: 'runtime-limit',
    canonicalDefault: 4,
    developmentDefault: '4 (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxExecutionSteps)',
    productionBehavior: 'same default as development when unset (4)'
  }),
  positiveIntegerSetting('AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN', {
    category: 'runtime-limit',
    canonicalDefault: 32,
    developmentDefault: '32 (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxWorkspaceOperationsPerRun)',
    productionBehavior: 'same default as development when unset (32)'
  }),
  positiveIntegerSetting('AGENT_MAX_MODEL_REQUESTS_PER_RUN', {
    category: 'runtime-limit',
    canonicalDefault: 4,
    developmentDefault: '4 (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxModelRequestsPerRun)',
    productionBehavior: 'same default as development when unset (4)'
  }),
  positiveIntegerSetting('AGENT_MAX_PROCESS_OPERATIONS_PER_RUN', {
    category: 'runtime-limit',
    canonicalDefault: 4,
    developmentDefault: '4 (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxProcessOperationsPerRun)',
    productionBehavior: 'same default as development when unset (4)'
  }),
  positiveIntegerSetting('AGENT_MAX_BROWSER_OPERATIONS_PER_RUN', {
    category: 'runtime-limit',
    canonicalDefault: 32,
    developmentDefault: '32 (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxBrowserOperationsPerRun)',
    productionBehavior: 'same default as development when unset (32)'
  }),
  positiveIntegerSetting('AGENT_MAX_RUNTIME_DURATION_MS', {
    category: 'runtime-limit',
    canonicalDefault: 120000,
    developmentDefault: '120000 (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxRuntimeDurationMs)',
    productionBehavior: 'same default as development when unset (120000)'
  }),
  positiveIntegerSetting('AGENT_MAX_OUTPUT_ARTIFACT_BYTES_PER_RUN', {
    category: 'runtime-limit',
    canonicalDefault: 16777216,
    developmentDefault: '16 MiB (server owner DEFAULT_AGENT_RUNTIME_LIMITS.maxOutputArtifactBytesPerRun)',
    productionBehavior: 'same default as development when unset (16777216)'
  }),
  positiveIntegerSetting('WORKFLOW_MAX_TRANSITIONS', {
    category: 'runtime-limit',
    canonicalDefault: 16,
    developmentDefault: '16 (workflow transition budget per execution)',
    productionBehavior: 'same default as development when unset (16)'
  }),
  positiveIntegerSetting('WORKFLOW_MAX_LOOP_ITERATIONS', {
    category: 'runtime-limit',
    canonicalDefault: 3,
    developmentDefault: '3 (workflow loop-iteration cap)',
    productionBehavior: 'same default as development when unset (3)'
  }),
  positiveIntegerSetting('WORKFLOW_MAX_MUTATIONS', {
    category: 'runtime-limit',
    canonicalDefault: null,
    developmentDefault: 'derived (defaults to AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE)',
    productionBehavior: 'derived from AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE when unset'
  }),
  positiveIntegerSetting('STRUCTURED_PLANNER_REQUEST_TIMEOUT_MS', {
    category: 'runtime-limit',
    canonicalDefault: 120000,
    developmentDefault: '120000 (structured-allocation planner request timeout; owner runtime/structured-allocation-planning-contract.js PLANNER_REQUEST_LIMITS.timeoutMs)',
    productionBehavior: 'same default as development when unset (120000)'
  }),

  // ── Feature gates (default-off) ────────────────────────────────────────
  booleanTrueFlag('ENABLE_PROCESS_EXECUTION_CONTRACT', { category: 'feature-gate', exposure: true }),
  booleanTrueFlag('AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT', {
    category: 'feature-gate',
    flagValue: '1',
    developmentDefault: 'disabled ("1" enables)',
    exposure: false
  }),
  booleanTrueFlag('ENABLE_MODEL_CONTRACT_COMPILER', { category: 'feature-gate', exposure: true }),
  booleanTrueFlag('ENABLE_PREFIX_TRUNCATION', { category: 'feature-gate', exposure: false }),

  // ── Process execution (release-gated; default OFF) ──────────────────────
  {
    name: 'PROCESS_EXECUTION_SOURCE_REVISION',
    classification: 'application',
    category: 'process-execution',
    exposure: true,
    required: 'never',
    validation: 'trimmed text; supplied by a production release as the exact committed source revision',
    canonicalDefault: null,
    developmentDefault: 'unset (process execution stays uninstalled unless the contract is enabled)',
    productionBehavior: 'a production release supplies its exact committed revision; the release contract binds admission authority to it',
    secret: false
  },
  booleanTrueFlag('PROCESS_EXECUTION_DEPLOYMENT_VALIDATED', {
    category: 'process-execution',
    developmentDefault: 'disabled (deployment validation is asserted only after the checked-in multi-UID/deployment gate has passed)',
    exposure: true
  }),
  {
    name: 'PROCESS_TARGET_CATALOG_FILE',
    classification: 'application',
    category: 'process-execution',
    exposure: false,
    required: 'never',
    validation: 'filesystem path to the trusted process target catalog; validated once at startup',
    canonicalDefault: 'config/process-targets.json',
    developmentDefault: 'config/process-targets.json (repository-owned catalog)',
    productionBehavior: 'same default as development when unset (repository catalog)',
    secret: false
  },
  {
    name: 'PROCESS_MATERIALIZER_SOCKET_PATH',
    classification: 'application',
    category: 'process-execution',
    exposure: false,
    required: 'never',
    validation: 'Unix socket path of the process materializer service',
    canonicalDefault: null,
    developmentDefault: 'runtime/process-materializer-contract.js PROCESS_MATERIALIZER_DEFAULT_SOCKET_PATH',
    productionBehavior: 'same default as development when unset',
    secret: false
  },
  positiveIntegerSetting('PROCESS_MATERIALIZER_TIMEOUT_MS', {
    category: 'process-execution',
    canonicalDefault: 120000,
    developmentDefault: '120000 (runtime/process-materializer-contract.js PROCESS_MATERIALIZER_DEFAULT_TIMEOUT_MS)',
    productionBehavior: 'same default as development when unset'
  }),
  {
    name: 'PROCESS_LAUNCHER_SOCKET_PATH',
    classification: 'application',
    category: 'process-execution',
    exposure: false,
    required: 'never',
    validation: 'Unix socket path of the process launcher foundation service',
    canonicalDefault: null,
    developmentDefault: 'runtime/process-launcher-foundation-contract.js PROCESS_LAUNCHER_FOUNDATION_DEFAULT_SOCKET_PATH',
    productionBehavior: 'same default as development when unset',
    secret: false
  },
  positiveIntegerSetting('PROCESS_LAUNCHER_TIMEOUT_MS', {
    category: 'process-execution',
    canonicalDefault: 300000,
    developmentDefault: '300000 (runtime/process-launcher-foundation-contract.js PROCESS_LAUNCHER_FOUNDATION_MAX_TIMEOUT_MS)',
    productionBehavior: 'same default as development when unset'
  }),
  {
    name: 'PROCESS_WORKSPACE_ALLOCATION_ID',
    classification: 'application',
    category: 'process-execution',
    exposure: false,
    required: 'never',
    validation: 'trimmed allocation identifier for the materializer workspace allocation',
    canonicalDefault: 'primary-workspace',
    developmentDefault: 'primary-workspace',
    productionBehavior: 'same default as development when unset ("primary-workspace")',
    secret: false
  },

  // ── Browser engine ─────────────────────────────────────────────────────
  {
    name: 'BROWSER_ENGINE_EXECUTABLE',
    classification: 'provider',
    category: 'browser',
    exposure: false,
    required: 'never',
    validation: 'filesystem path to the local browser engine executable; absence falls back to the engine-owning default',
    canonicalDefault: null,
    developmentDefault: 'runtime/browser-engine.js default resolution order',
    productionBehavior: 'explicit executable path overrides the engine default',
    secret: false
  },

  // ── Ambient deployment mode ─────────────────────────────────────────────
  {
    name: 'NODE_ENV',
    classification: 'application',
    category: 'deployment-mode',
    exposure: false,
    required: 'never',
    validation: 'Node ambient deployment mode; the repository semantics recognize "production" (fail-closed admin bootstrap, secure-origin cookies, test hooks disarmed) and "test" (the only mode where internal test hooks have any effect)',
    canonicalDefault: null,
    developmentDefault: 'unset/development',
    productionBehavior: '"production" arms the fail-closed behaviors recorded above',
    secret: false
  },
  {
    name: 'TZ',
    classification: 'application',
    category: 'deployment-mode',
    exposure: false,
    required: 'never',
    validation: 'ambient OS timezone override consumed as a fall-back for run timezone observation',
    canonicalDefault: null,
    developmentDefault: 'host timezone resolution',
    productionBehavior: 'same fall-back as development',
    secret: false
  }
]);

// ── PROVIDER SETTINGS ─────────────────────────────────────────────────────

const PROVIDER_SETTINGS = Object.freeze([
  {
    name: 'OPENAI_API_KEY',
    classification: 'secret',
    category: 'provider-credential',
    exposure: true,
    required: 'never',
    validation: 'optional OpenAI credential; used as a fallback for runnable-agent readiness and live dispatch; never echoed, printed, or serialized',
    canonicalDefault: null,
    developmentDefault: 'unset (the credential configured on the agent takes precedence)',
    productionBehavior: 'same fallback as development; no startup refusal',
    secret: true
  },
  {
    name: 'OPENAI_MODEL',
    classification: 'provider',
    category: 'provider-model',
    exposure: true,
    required: 'never',
    validation: 'optional OpenAI model fallback when the agent does not carry its own model (owner seams: server.js provider dispatch and scripts/dev-agent-config.js, whose initial-agent default is DEFAULT_OPENAI_MODEL)',
    canonicalDefault: null,
    developmentDefault: 'unset for the runtime fallback; interactive/first-agent development default is derived by scripts/dev-agent-config.js DEFAULT_OPENAI_MODEL',
    productionBehavior: 'same fallback as development',
    secret: false
  },
  {
    name: 'OLLAMA_MODEL',
    classification: 'provider',
    category: 'provider-model',
    exposure: true,
    required: 'never',
    validation: 'optional Ollama model fallback when the agent does not carry its own model',
    canonicalDefault: null,
    developmentDefault: 'unset (the local installation is expected at OLLAMA_BASE_URL)',
    productionBehavior: 'same fallback as development',
    secret: false
  },
  {
    name: 'OLLAMA_BASE_URL',
    classification: 'provider',
    category: 'provider-model',
    exposure: true,
    required: 'never',
    validation: 'optional Ollama base URL; trailing slashes are normalized',
    canonicalDefault: 'http://127.0.0.1:11434',
    developmentDefault: 'http://127.0.0.1:11434',
    productionBehavior: 'same default as development when unset (http://127.0.0.1:11434)',
    secret: false
  }
]);

// ── DEVELOPMENT-ONLY SETTINGS ──────────────────────────────────────────────

const DEVELOPMENT_SETTINGS = Object.freeze([
  {
    name: 'TICKET_SYSTEM_POSTGRES_PORT',
    classification: 'development',
    category: 'dev-database',
    exposure: false,
    required: 'never',
    validation: 'integer from 1 through 65535; configures the BUNDLED development database and is refused when combined with an external DATABASE_URL',
    canonicalDefault: 5432,
    developmentDefault: '5432 (bundled compose port)',
    productionBehavior: 'not deployment configuration; has no production effect',
    secret: false
  },
  {
    name: 'DEV_AGENT_PROVIDER',
    classification: 'development',
    category: 'dev-setup',
    exposure: true,
    required: 'never',
    validation: 'when set, must be "openai" or "ollama"',
    canonicalDefault: null,
    developmentDefault: 'derived from the available provider configuration',
    productionBehavior: 'not deployment configuration; has no production effect',
    secret: false
  },
  {
    name: 'DEV_AGENT_NAME',
    classification: 'development',
    category: 'dev-setup',
    exposure: true,
    required: 'never',
    validation: 'optional initial agent display name',
    canonicalDefault: 'Developer Agent',
    developmentDefault: 'Developer Agent',
    productionBehavior: 'not deployment configuration; has no production effect',
    secret: false
  }
]);

// ── INTERNAL TEST HOOKS ────────────────────────────────────────────────────
//
// NEVER in .env.example; never promoted to supported deployment configuration.
// Listed explicitly so the parity test can prove the exclusion is deliberate.

const TEST_ONLY_SETTINGS = Object.freeze([
  {
    name: 'TEST_INTERRUPTION_POINT',
    classification: 'test-only',
    category: 'internal-test-hook',
    exposure: false,
    required: 'never',
    canonicalDefault: null,
    validation: 'interruption checkpoint name for runtime fault-injection tests',
    developmentDefault: 'unset (no interruption)',
    productionBehavior: 'internal test hook; must have no production effect',
    secret: false
  },
  {
    name: 'TEST_SKIP_STARTUP_RUN_RECOVERY',
    classification: 'test-only',
    category: 'internal-test-hook',
    exposure: false,
    required: 'never',
    canonicalDefault: null,
    validation: 'exact "true" WITH NODE_ENV=test only; skips startup run recovery in test servers',
    developmentDefault: 'unset',
    productionBehavior: 'internal test hook; must have no production effect',
    secret: false
  },
  {
    name: 'TEST_INTERRUPT_AFTER_AGENT_PROVIDER_RESPONSE_PERSISTED',
    classification: 'test-only',
    category: 'internal-test-hook',
    exposure: false,
    required: 'never',
    canonicalDefault: null,
    validation: 'exact "true" WITH NODE_ENV=test only',
    developmentDefault: 'unset',
    productionBehavior: 'internal test hook; must have no production effect',
    secret: false
  },
  {
    name: 'TEST_INTERRUPT_AFTER_OPERATOR_RECOVERY_EFFECT',
    classification: 'test-only',
    category: 'internal-test-hook',
    exposure: false,
    required: 'never',
    canonicalDefault: null,
    validation: 'exact "true" WITH NODE_ENV=test only',
    developmentDefault: 'unset',
    productionBehavior: 'internal test hook; must have no production effect',
    secret: false
  },
  {
    name: 'TEST_COMPOSITION_READ_ADVENT',
    classification: 'test-only',
    category: 'internal-test-hook',
    exposure: false,
    required: 'never',
    canonicalDefault: null,
    validation: 'test-scoped composition interruption key',
    developmentDefault: 'unset',
    productionBehavior: 'internal test hook; must have no production effect',
    secret: false
  },
  {
    name: 'EVALUATION_FIXTURE_NAMESPACE',
    classification: 'test-only',
    category: 'internal-test-hook',
    exposure: false,
    required: 'never',
    canonicalDefault: null,
    validation: 'non-empty WITH NODE_ENV=test only; enables the controlled evaluation fixture namespace',
    developmentDefault: 'unset (an ordinary server never inherits it; the test harness strips it at the spawn boundary)',
    productionBehavior: 'internal test hook; must have no production effect',
    secret: false
  },
  {
    name: 'TTS_TEST_ROUTE_INVENTORY_FILE',
    classification: 'test-only',
    category: 'internal-test-hook',
    exposure: false,
    required: 'never',
    canonicalDefault: null,
    validation: 'output file for the route-table inventory dump at startup; never set in ordinary operation',
    developmentDefault: 'unset',
    productionBehavior: 'internal test hook; must have no production effect',
    secret: false
  }
]);

// ── REGISTRY API ───────────────────────────────────────────────────────────

const ALL_SETTINGS = Object.freeze([...SETTINGS, ...PROVIDER_SETTINGS, ...DEVELOPMENT_SETTINGS, ...TEST_ONLY_SETTINGS]);
const SETTING_BY_NAME = new Map(ALL_SETTINGS.map(setting => [setting.name, setting]));

function settingByName(name) {
  return SETTING_BY_NAME.get(name) || null;
}

function supportedSettingNames() {
  return ALL_SETTINGS.map(setting => setting.name);
}

function isSupportedSetting(name) {
  return SETTING_BY_NAME.has(name);
}

function settingSecret(name) {
  const setting = SETTING_BY_NAME.get(name);
  return Boolean(setting && setting.secret);
}

// Settings the operator-facing `.env.example` documents, in registry-declared
// order. Parity is enforced by the owning contract test: exactly these names,
// and no test-only or unexposed setting, appear in the example file.
function operatorExposedSettings() {
  return ALL_SETTINGS.filter(setting => setting.exposure === true);
}

function operatorExposedSettingNames() {
  return operatorExposedSettings().map(setting => setting.name);
}

// Validate ONE supported setting's declared rule against an environment map.
// Returns null when the value is acceptable and a failure object otherwise.
// Failure objects carry the setting NAME and a message that never contains
// the setting's value.
function individualFailure(setting, env) {
  const { name } = setting;
  const raw = env === undefined || env === null ? undefined : env[name];
  const text = raw === undefined || raw === null ? '' : String(raw);
  switch (name) {
    case 'DATABASE_URL': {
      const problem = validatePostgresUrl(text);
      return problem ? { name, message: problem, code: 'invalid_postgres_url' } : null;
    }
    case 'SESSION_SECRET': {
      const problem = validateSessionSecret(text);
      return problem ? { name, message: problem, code: text ? 'invalid_session_secret' : 'missing_required_secret' } : null;
    }
    case 'ADMIN_BOOTSTRAP_PASSWORD': {
      // Registry rule: creation-only. Absent is always acceptable (the
      // fail-closed first-admin production rule is enforced at the bootstrap
      // seam, not treated here as a standing requirement).
      if (!text) return null;
      const problem = validateAdminPassword(text, { required: false });
      return problem ? { name, message: problem, code: 'invalid_bootstrap_password' } : null;
    }
    case 'POSTGRES_SCHEMA':
      if (!text) return { name, message: `${name} must not be empty when set`, code: 'invalid_schema' };
      return null;
    case 'PORT':
      if (!text) return null;
      {
        const problem = validatePort(text);
        return problem ? { name, message: problem, code: 'invalid_port' } : null;
      }
    case 'TRUST_PROXY':
      if (!text) return null;
      return text === 'true' ? null : { name, message: 'TRUST_PROXY must be exactly "true" when set', code: 'invalid_flag' };
    case 'PUBLIC_BASE_URL': {
      const problem = validateHttpOrigin(text);
      return problem ? { name, message: problem, code: 'invalid_origin' } : null;
    }
    case 'PERSISTENCE_BACKEND':
      if (!text) return null;
      // Exact canonical owner semantics (persistence/runtime-backend.js:
      // resolveRuntimePersistenceBackend trims, lowercases, and requires the
      // exact value "postgres").
      return text.trim().toLowerCase() === 'postgres'
        ? null
        : { name, message: 'PERSISTENCE_BACKEND must be "postgres"', code: 'unsupported_backend' };
    case 'TICKET_SYSTEM_POSTGRES_PORT':
      {
        // Exact owner consumption (scripts/dev-environment.js): the owner
        // reads `String(env.TICKET_SYSTEM_POSTGRES_PORT || '').trim()`, so
        // trailing whitespace never reaches its digits rule and a
        // whitespace-only value is unset (the bundled default), exactly like
        // absence.
        const configured = text.trim();
        if (!configured) return null;
        // Exact owner rule: the WHOLE trimmed value must be decimal digits
        // within [1, 65535] (resolveDevelopmentDatabaseTarget throws the
        // canonical message otherwise; see parseStrictDecimalBoundedInteger
        // above). A partial prefix ('5432junk', '12abc') is never an
        // owner-accepted port.
        const parsed = parseStrictDecimalBoundedInteger(configured, 1, 65535);
        if (parsed === null) {
          return { name, message: 'TICKET_SYSTEM_POSTGRES_PORT must be an integer from 1 through 65535', code: 'invalid_port_range' };
        }
        return null;
      }
    case 'DEV_AGENT_PROVIDER':
      if (!text) return null;
      {
        const problem = validateEnum(text, ['openai', 'ollama'], name);
        return problem ? { name, message: problem, code: 'invalid_provider' } : null;
      }
    default:
      break;
  }
  if (setting.validation.startsWith('positive-integer-fallback:')) {
    // Exact canonical owner semantics (server.js getPositiveIntegerEnv and
    // runtime/mutation-admission.js positiveInteger): the owner parses the
    // leading decimal value and keeps the canonical default for anything
    // unparsable or non-positive. The runtime NEVER refuses, so this registry
    // never reports a failure either — parity, not invention.
    return null;
  }
  if (setting.flagValue !== undefined) {
    // Exact owner semantics of the default-off gates (`=== '<flagValue>'`
    // comparisons): the exact flag value enables, EVERYTHING ELSE leaves the
    // feature in its default state. A non-enabling value is a valid
    // configuration, never a refusal.
    return null;
  }
  return null;
}

// Deterministic environment validation. context:
//   'boot'    — validates the ALWAYS-required settings plus every set optional
//               value's declared rule. This is the health/readiness-relevant
//               subset: absence of a required setting fails; creation-only
//               settings are validated only when present.
//   'doctor'  — identical rules; the development doctor renders the failures.
function validateEnvironment(env = process.env, { context = 'boot' } = {}) {
  if (!['boot', 'doctor'].includes(context)) throw new TypeError(`validateEnvironment: unsupported context ${context}`);
  const failures = [];
  for (const setting of ALL_SETTINGS) {
    const present = env ? Object.prototype.hasOwnProperty.call(env, setting.name) && env[setting.name] !== undefined : false;
    if (setting.classification === 'test-only' ||
        setting.classification === 'development' && context === 'boot') {
      // Test hooks and development-only settings are never boot configuration.
      continue;
    }
    if (setting.required === 'bootstrap-only') {
      // Creation-only discipline: the value is bound at the bootstrap seam
      // (first-admin creation) and is completely ignored afterwards; it is
      // never treated as standing configuration for health/readiness.
      continue;
    }
    if (!present && setting.required === 'always') {
      failures.push({
        name: setting.name,
        code: 'missing_required_setting',
        message: `${setting.name} is required`
      });
      continue;
    }
    if (!present) continue;
    const failure = individualFailure(setting, env);
    if (failure) failures.push(failure);
  }
  return Object.freeze({
    ok: failures.length === 0,
    context,
    failures: Object.freeze(failures)
  });
}

module.exports = {
  CLASSIFICATIONS,
  DEVELOPMENT_SETTINGS,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_SESSION_SECRET_LENGTH,
  PROVIDER_SETTINGS,
  SETTINGS,
  TEST_ONLY_SETTINGS,
  isSupportedSetting,
  operatorExposedSettingNames,
  operatorExposedSettings,
  settingByName,
  settingSecret,
  supportedSettingNames,
  validateAdminPassword,
  validateEnvironment,
  validateHttpOrigin,
  validatePort,
  validatePostgresUrl,
  validateSessionSecret
};
