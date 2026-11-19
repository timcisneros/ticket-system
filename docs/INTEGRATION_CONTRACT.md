# Integration Contract

Canonical P7 integration authority for the ticket system, frozen by the P7-S1 integration
authority design freeze (canonical record: `ARCHITECTURAL_DECISIONS_PENDING.md`, "P7 —
INTEGRATIONS — P7-S1 AUTHORITY DESIGN-FREEZE CANDIDATE"). This document is the ONE living
normative owner of P7 integration semantics. It carries design authority only; per that
register record it does NOT authorize P7-S2, P7-S3, or any P7 runtime implementation.
Authoring this freeze does not by itself authorize implementation.

Specialized owners remain canonical for their subsystems and are referenced, not copied:

- Existing connector CRUD, catalog, and standalone connector receipt mechanics →
  `LOCAL_CONNECTOR_CONTRACT.md`
- Provider-neutral target evidence shape (currently the local workspace provider) →
  `TARGET_PROVIDER_CONTRACT.md`
- Operator roles and the forbidden-boundary doctrine → `OPERATOR_CONTRACT.md`
- Deployment posture and operational authority boundary → `DEPLOYMENT_CONTRACT.md`
- Ticket/Run/attempt identity, immutable Run membership, settlement →
  `TICKET_ATTEMPT_AUTHORITY.md`
- Run evidence and completion authority map → `RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md`
- Post-T10 product roadmap, P-phase identity, sequencing, and design authority →
  `ARCHITECTURAL_DECISIONS_PENDING.md`

No competing connector/integration contract, duplicate receipt schema, copied generic
provider rulebook, or provider-specific rule inside generic authority documentation may be
created (§26).

## 1. Product stage

P7 — Integrations — extends the governed-effect perimeter to external business systems ONE
reviewed provider kind at a time.

It is NOT:

- a plugin framework;
- a generic API tool;
- arbitrary HTTP;
- a second execution graph;
- a new Ticket lifecycle;
- a replacement for browser automation.

**Central invariant: connector availability, provider capability, credential possession,
and model intent are never authority.** A bounded agent proposes; only frozen authority,
current liveness, and current budget admit. Provider success responses never widen a Run.

## 2. Reused authority chain

P7 adds no new lifecycle authority. Every integration effect travels the existing chain:

```
Ticket authority
→ Run/attempt
→ immutable execution policy
→ mutation admission
→ operation authority
→ runtime budget
→ prepared external intent
→ provider transport
→ reconciliation/result evidence
→ completion/consequence.
```

External side-effect doctrine: `OPERATOR_CONTRACT.md` already requires that a tool able to
cause irreversible effects record its attempted request before execution and its
result/failure separately. The prepared-intent state machine (§13) is the P7 realization of
exactly that doctrine.

### 2.1 Ontology reuse map

Reused unchanged (owners unchanged):

| Concept | Existing owner |
|---|---|
| Ticket, Run, attempt, immutable Run membership | `TICKET_ATTEMPT_AUTHORITY.md` |
| `executionPolicySnapshot`, `runtimeBudgetSnapshot` | admission snapshots (`server.js` `normalizeExecutionPolicy`, `runtime/runtime-budget-contract.js`) |
| Work Context (active/archived) | `work_contexts` authority (migration `015`) |
| Connector record, status/revision | `LOCAL_CONNECTOR_CONTRACT.md`, migration `022` |
| Mutation admission | `runtime/mutation-admission.js` |
| Authority checks / operation receipts / events / replay | run evidence authority (`RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md`) |
| Completion authority / consequence authority | published P2 record, `runtime/completion-decision-contract.js` |
| Target evidence shape | `TARGET_PROVIDER_CONTRACT.md` |
| Operator recourse | `OPERATOR_CONTRACT.md`, existing operator surfaces |
| PostgreSQL recovery authority | `POSTGRES_CUTOVER.md`, `DEPLOYMENT_CONTRACT.md` scheduler/recovery model |

Genuinely new semantic surface — ONLY:

1. immutable integration authorization inside the execution-policy snapshot;
2. provider-kind operation catalog;
3. integration operation family in the existing run loop;
4. integration external target kind;
5. durable integration-operation intent/state relation;
6. integration runtime-budget dimension plus a mutating sub-bound;
7. narrow provider-neutral credential-alias resolver (one resolver, closed alias
   registry).

No other lifecycle object and no second execution graph is introduced.

## 3. Immutable integration authorization

A default-off immutable integration authorization is carried inside the admitted Run's
execution-policy snapshot. Exact canonical field name and shape:

- Field name: `executionPolicy.integrations`.
- Value `null` (or absent) — **NOT authorized**. Absent/invalid means off, never a
  permissive fallback (same pattern as `allowBrowserInteractions` / `allowWorkflowInvocation`).
- Value present — exactly this closed shape (`version: 1`):

```text
integration {
  version: 1,
  connectorId: <positive safe integer, an existing connector repository id>,
  providerKind: <provider-kind token, v1 exactly "github">,
  authorizedOperations: [ <operationId> ... ]   // finite, deduped, each in the provider
                                                // kind's catalog; empty refuses
  resources: [ <canonicalRepositoryIdentity> ... ]  // nonempty exact identities (§5);
                                                    // empty refuses, deduped, no wildcards
  credentialRef: <alias identity>,              // exact alias string, v1 exactly "github"
  workContextId: <positive safe integer>        // MUST equal the bound connector's
                                                // workContextId; mismatch refuses
}
```

Authorization properties, all mandatory:

- operator-authored, permissioned at Ticket creation/configuration: creating or configuring a
  Ticket that carries an integration authorization requires the user permission
  **`integration:authorize`** (exact canonical user permission identity; single reference for
  the gate, named on the `connector:*` / `browser:*` precedent). The durable permission row is
  created by implementation (§25.3), not by this freeze;
- default off — a Run without this field has zero integration surface and the integration
  operation family is never advertised to or accepted from its agent;
- immutable once admitted — the admitted Run reads only its frozen
  `executionPolicySnapshot.integrations`; later Ticket/config edits cannot retroactively
  expand an admitted Run;
- hash-bound through the existing execution-policy/runtime-budget snapshot authority
  (`runtimeBudgetSnapshot.executionPolicyHash` binds the normalized policy exactly as it
  binds every other execution-policy field);
- no migration is authored or authorized by this S1 freeze (§25).

## 4. Immutable Run authority versus mutable connector state

This rule is mandatory and stated unambiguously.

### 4.1 Admission-time immutable authority

The following are frozen into the admitted Run at admission and are NEVER widened by later
connector mutation:

- `connectorId`;
- `providerKind`;
- the authorized operation set;
- the resource bounds;
- the `credentialRef` alias identity;
- the `workContextId`.

### 4.2 Dispatch-time mutable liveness

Every dispatch re-checks liveness against current state:

1. the connector still exists and still has the frozen `providerKind`;
2. the connector status is `active`;
3. the bound Work Context is `active`;
4. the frozen credential alias currently resolves (§6).

Any failure refuses the dispatch fail-closed before any network effect.

### 4.3 Effective authority by direction (exact connector-field mapping)

The existing connector record already carries the current authority-reduction fields
(`LOCAL_CONNECTOR_CONTRACT.md`: `status`, `allowedScopes(read|write)`, `sourceRoots`,
`targetRoots`, `workContextId`, `credentialRef`, `kind`). P7 v1 reuses exactly those fields —
no duplicate bound is invented. Exact per-direction freezes:

```
effectiveReadResources     = frozenRunResources ∩ currentConnector.sourceRoots
effectiveMutationResources = frozenRunResources ∩ currentConnector.targetRoots
```

Both sides are canonical exact resource identity sets under the §5 grammar. (The canonical
repository-form evaluation applies to the `github` provider kind; the path-string semantics
of the `local_mock` kind stay untouched for that kind. This is the repository-truth field
mapping: reads are bounded by `sourceRoots`, writes by `targetRoots`.)

Direction requirements, checked against CURRENT values on every dispatch:

- a read operation requires `read` in the current connector `allowedScopes`, and dispatches
  only against `effectiveReadResources`;
- a MUTATION requires BOTH `read` AND `write` in the current connector `allowedScopes`
  (P7's reconciliation/safety authority depends on the provider's read path — §10) AND the
  exact resource inside BOTH effective bounds: it dispatches only against
  `effectiveMutationResources` and cannot start unless the resource also belongs to
  `effectiveReadResources` (§10 `canStartV1Mutation`).

Current connector state reduces admitted authority through ALL of:

- connector `status` (§4.2);
- Work Context status (§4.2);
- `allowedScopes` — a current scope removal stops matching future dispatches from
  already-admitted Runs;
- provider `kind` (§4.2);
- credential resolvability (§4.2, §6);
- provider resource bounds (`sourceRoots` for reads, `targetRoots` for writes — above).

Consequences, all frozen:

- later connector widening is inert (it can never increase admitted authority);
- later connector narrowing takes effect immediately;
- an empty intersection refuses;
- current connector state can reduce authority but never increase it.

### 4.4 credentialRef mutation

A connector's later `credentialRef` change MUST NOT re-point an already admitted Run. The
frozen alias remains controlling. This prevents connector-management authority
(`connector:manage`) from amplifying an admitted Run's authority.

## 5. Resource bounds: exact canonical repository identities (v1 rule)

P7 v1 uses ONE mechanically precise rule: **exact GitHub repository identities only — no
wildcard resource authority.** Patterns/globs are excluded; "exact resources" and
"patterns/globs" are not competing descriptions.

Canonical owner/repository identity grammar (exact):

- the canonical form is `owner/repository`;
- `owner`: 1–39 characters of `A-Z a-z 0-9 -`, no leading hyphen, no trailing hyphen, no
  consecutive hyphens;
- `repository`: 1–100 characters of `A-Z a-z 0-9 . _ -`, at least one `A-Z a-z 0-9` byte;
- normalization: trim surrounding ASCII whitespace; any other whitespace/pattern metacharacter
  (`*`, `?`, `[`, `]`, `{`, `}`, `\`) refuses; the canonical stored form is the
  **lowercased** identity (GitHub repository names are case-insensitively unique per owner;
  the canonical lowercase form prevents different-case spellings from evading either bound
  matching or cross-attempt identity equality);
- an authorization's `resources` set and a connector's current bound set are canonical
  exact-identity sets (deduped); bound membership is exact-string equality over canonical
  forms; no prefix/suffix/wildcard matching exists.

Issue-number operand grammar (exact): a positive safe integer, `1 ≤ issueNumber ≤ 999999999`,
referencing a repository inside the effective bounds.

Per-operation canonical external resource identity (v1, all THREE catalog operations): exactly
`repos/{owner}/{repository}/issues/{issueNumber}` using the canonical (§5) spelling and the
exact issue number (canonical decimal, zero-padding forbidden).

The frozen `resources` set and the connector's current per-direction bound sets
(`sourceRoots` / `targetRoots`, §4.3) are all evaluated ONLY over canonical forms; the
§4.3 intersections are exact-string equality over canonical identity sets.

## 6. Credential resolver boundary and closed-world alias registry

### 6.1 Resolver boundary

Provider modules have **NO ambient `process.env` access**. Exactly ONE repository-owned
credential resolver:

1. validates a frozen credential alias against the closed registry (§6.2);
2. resolves it to secret material;
3. passes exactly the resolved secret to the provider transport function as an explicit
   function argument.

Provider modules:

- receive secret material as an explicit function argument;
- may not enumerate environment variables;
- may not request another alias;
- may not read `process.env` at all.

Secret material must never enter:

- model context;
- prompts;
- logs;
- events;
- replay;
- evidence;
- receipts;
- operator responses;
- hashes/fingerprints of secret material.

Fingerprints of canonical operation args and canonical resource identities are secret-free
material and are explicitly permitted (§11); fingerprints of secret material are never taken.

Missing or revoked alias resolution fails closed BEFORE dispatch — a prepared intent whose
alias no longer resolves never leaves `prepared` toward the network. There is no cross-call
secret-material cache (each dispatch resolution happens at dispatch time; nothing memoizes
secret bytes).

### 6.2 v1 closed-world alias registry

Credential alias `github` resolves to exactly one secret-material slot backed by the
canonical environment setting **`GITHUB_TOKEN`**; there is exactly ONE GitHub credential slot
in P7 v1. Connector records reference the ALIAS (`credentialRef: "github"`), never arbitrary
environment-variable names. Unknown aliases
refuse — in connector validation, in execution-policy authorization validation, and at
resolution time. There is no arbitrary dynamic environment-variable naming, no DB-stored
secret, and no managed-secret service.

The backing variable `GITHUB_TOKEN` MUST be registered as a secret-classified canonical
environment-registry setting during implementation (S2), on the exact registry precedent of
`OPENAI_API_KEY` (classification `secret`, category `provider-credential`, `secret: true`,
never echoed, printed, or serialized).

**Future demand for multiple independent credentials:** STOP and take a registered extension
decision. If a future need chooses a bounded naming convention (for example alias-suffixed
slots such as `GITHUB_TOKEN_<alias>`), that convention must be justified in its own registry
as preserving THIS closed-world doctrine: enumerable, repository-declared aliases only, each
explicitly registered with its exact backing slot, no dynamic lookup by convention, no
declaration-by-presence. The current static registry does not already support arbitrary
dynamic aliases, and v1 must not pretend otherwise.

## 7. Provider-kind contract (provider-neutral)

Each provider kind defines, in one repository-owned registration, all of:

1. catalog version (the finite operation catalog is version-bound; semantics-changing adds
   bump the version identity);
2. fixed provider host (a single exact HTTPS host; no per-operation host selection);
3. a FINITE operation catalog (closed list of operation ids; no passthrough operation)
   together with the catalog-owned FIXED NON-SECRET request headers (§8: the pinned REST
   API-version header and the JSON media type);
4. read/mutate classification per operation;
5. semantic consequence class per operation (per the §17 taxonomy and §10 consequence
   classes);
6. a closed argument schema per operation (no open key/value bags; no header/URL body fields);
7. canonical external resource identity derivation per operation (§5 shape);
8. required connector scope (`read` / `write` against the existing connector
   `allowedScopes`);
9. required integration authorization coverage (the operation id must appear in the frozen
   `authorizedOperations`);
10. the operation timeout, not exceeding the universal ceiling (§18);
11. the idempotency class (§17 taxonomy);
12. the reconciliation read used for cross-attempt and recovery reconciliation;
13. the provider-error → universal-outcome mapping, never weaker than the universal minimum
    mapping (§16);
14. the normalized bounded result shape;
15. the result-size ceiling (never above the universal ceiling, §18);
16. the credential input contract (secret as explicit function argument, nothing else).

Authority split (exact): the runtime owns authority (§3–§6, §11–§19). Provider code owns
transport semantics ONLY. Provider code MUST NOT:

- decide Ticket authority;
- decide execution-policy authority;
- create its own budgets;
- weaken uncertainty rules;
- select arbitrary hosts;
- accept arbitrary methods, headers, or URLs;
- follow redirects automatically (§8);
- expose a passthrough operation.

Provider-specific error classification may refine EVIDENCE only when the evidence supports
it (for example, a definitive rate-limit rejection under §16 proves non-application; any 404
on a v1 mutation resolves ONLY through the §10 desired-state reconciliation rule, never by
status-code inference). It may never turn an ambiguous post-dispatch outcome into certainty.

Provider-neutral completion requirement: a second-provider design exercise must be expressible
WITHOUT changing Ticket/Run/attempt, authority, uncertainty, evidence, credential, or budget
semantics (§29 item 12); any change to those semantics by a provider kind is the registered
closure-blocking defect class (§29).

## 8. First provider: GitHub Issues REST (v1)

- Provider kind token: `github`.
- Principal surface: GitHub Issues REST over the FIXED host `api.github.com`, HTTPS only.
- Pinned protocol version (reproducible contract): every request sends the fixed non-secret
  header `X-GitHub-Api-Version: 2026-03-10` and the media type
  `Accept: application/vnd.github+json`. The catalog owns these fixed non-secret headers;
  GitHub's implicit default REST version is never relied upon. Changing the pinned API
  version is a provider-catalog semantic/version change and requires review appropriate to
  that catalog change.
- Credential: static personal access token through the registered `github` alias (§6).
- Token-scope least privilege — **operator configuration doctrine**, classified explicitly
  (this cannot be mechanically verified by the runtime and is therefore NOT a mechanical
  authority check): v1 SHOULD use a fine-grained GitHub PAT where supported; the operator
  SHOULD scope repository access to the intended repositories; the minimum provider
  permission required by the v1 mutation catalog is Issues read/write. Credential scope is
  defense in depth and NEVER substitutes for the ticket/connector authority checks (§3–§6).
- Resource class boundary (ordinary Issues only): GitHub's Issues API also represents pull
  requests as issue resources; P7 v1 does NOT leave this accidental. The narrow frozen
  baseline: P7 v1 operates on ordinary Issues ONLY — if the exact resource resolves to a
  pull request, the provider operation REFUSES BEFORE mutation (accidental PR mutation
  through the `/issues/{number}` surface is the defect this rule exists to prevent). The
  proof, budgeting, and evidence of that check are frozen in §10 (exactly one budgeted
  pre-dispatch exact-resource class verification read using the GitHub response's own
  structural marker).
- Transport containment (v1, frozen): automatic redirect following is DISABLED. Any 3xx
  response is handled as a provider response under the universal outcome/evidence rules —
  ambiguous under §16 → UNKNOWN; a definitive non-application refusal stays reportable only
  through the desired-state reconciliation rules. No transport may automatically follow a
  redirect to another host, another repository identity, another issue identity, or another
  operation path. A future redirect-following design would have to revalidate the
  redirected host and resource against frozen authority BEFORE contact; it is NOT baseline.
- Path construction (v1, frozen): every dynamic GitHub path component is encoded as exactly
  ONE URI path segment by provider transport code (never shell-style escaping). In
  particular the `github.issues.removeLabel` label is percent-encoded as a single path
  segment; no label value may create `/`, a query, a fragment, or an alternate route
  structure (§10).
- **Final path-containment invariant (exact; MEDIUM GITHUB-PROTOCOL-A correction).** For
  label path operands: grammar validation happens BEFORE encoding; a canonical label of
  exactly `.` or exactly `..` refuses (RFC 3986 dot-segment hazard; §10); percent-encoding
  then occurs as already frozen; and the final request construction may NOT normalize into
  a route outside the catalog-owned template. Automatic redirects remain disabled; there
  is no arbitrary URL/method/header path.
- Tests use a repository-owned loopback HTTP fixture double (same precedent as the browser
  interaction fixture: `http.createServer` bound to `127.0.0.1` on an ephemeral port) — the
  transport function is pointed at the fixture origin in test posture only; production
  authority always uses the frozen host.
- Real GitHub proof occurs ONLY through separately authorized live-provider verification.
- NOT baseline: GitHub Enterprise or any alternate host; OAuth; a second provider.

Rejected challengers (concordant with the one-kind-at-a-time doctrine):

- **Jira** — adds unnecessary object/workflow complexity first (projects, issue types,
  workflow transitions) before the minimal effect boundary is proven;
- **Slack** — begins with non-idempotent create semantics (message posts), which would have
  forced the create-with-fingerprint machinery into v1;
- **Google Drive** — forces OAuth, which would have put an OAuth flow inside v1 instead of
  the closed static alias model.

## 9. v1 read catalog

Exactly ONE read operation. It supports real useful inspection and the reconciliation of
every v1 mutation.

`github.issues.get` — exact-resource issue retrieval.

- Kind: read. Connector scope: `read`. Idempotency class: naturally idempotent (class 1,
  read-only).
- Arguments (closed): `{ repository: <canonicalRepositoryIdentity>, issueNumber: <issue
  number (§5)> }`. No other fields.
- Provider contact: `GET /repos/{owner}/{repository}/issues/{issueNumber}` on the frozen host,
  no query parameters.
- Normalized bounded result (exact fields):

```text
{ number, state: "open"|"closed",
  title: <string, kept up to 256 bytes, truncated marker when longer>,
  body:  <string, kept up to 32768 bytes, truncated marker when longer>,
  labels: [ <name, each ≤ 64 bytes> ] capped at 64 entries with an omitted-excess marker,
  updatedAt }
```

- Result-size ceiling: the normalized result never exceeds the §18 result-size ceiling; a
  provider response whose relevant fields exceed the ceiling is truncated at the bounded
  fields above (bounded normalization is authority-safe for reads: they mutate nothing).
- Agent-visible presentation versus authority evidence (exact): the normalized bounded
  result is AGENT-VISIBLE read content for the Ticket's work and follows the existing
  tool/result privacy boundary. Its truncation markers are PRESENTATION truncation for
  model consumption. Title/body are bounded agent-visible READ content only — useful for
  the Ticket, but NOT v1 mutation fields (§10). Reconciliation NEVER consumes truncated
  presentation: it derives exact, operation-specific predicates from the bounded provider
  response (§13.4) BEFORE presentation truncation, never concludes absence or non-equality
  from an omitted, truncated, or over-ceiling field, and stores durable predicate evidence —
  not full external content (§19).

No arbitrary GitHub API read exists in v1. No list/search operation is admitted — nothing in
the proving use case requires one.

## 10. v1 mutation catalog

Exactly the smallest naturally idempotent catalog — TWO label operations, and nothing else:

1. `github.issues.addLabel` — class 1, add ONE label.
   - Arguments (closed): `{ repository, issueNumber, label }` — label grammar: 1–64 UTF-8
     bytes; no byte below 0x20; no ASCII comma; no line-breaking characters; no
     leading/trailing ASCII whitespace (canonical form is the trimmed exact string;
     fingerprinting is case-sensitive and byte-exact); a label whose ENTIRE canonical
     string is exactly `.` or exactly `..` REFUSES — these exact strings are RFC 3986
     dot-segment hazards in a path parameter, and refusing them mechanically preserves the
     frozen one-path-segment route-containment claim (§8); provider labels outside this
     narrow v1 grammar are simply unsupported in P7 v1.
   - Provider contact: `POST /repos/{owner}/{repository}/issues/{issueNumber}/labels` with
     body `{ "labels": ["<label>"] }`; fixed host.
   - Semantics: crisp desired-state set (the label present); already-present label
     re-application converges.
2. `github.issues.removeLabel` — class 1, remove ONE label.
   - Same argument grammar as `addLabel` (including the exact `.` / `..` refusal).
   - Provider contact: `DELETE /repos/{owner}/{repository}/issues/{issueNumber}/labels/<label>`.
   - Semantics: crisp desired-state clear (the label absent); already-absent label
     re-removal converges.
   - **404 rule: a 404 response is NOT effect truth by itself.** ANY 404 from
     `github.issues.removeLabel` enters reconciliation (§15): `github.issues.get` must
     authoritatively read the exact issue, and the classification follows FULL desired-state
     predicate truth (§9, §13.4):
     1. the issue is readable AND the exact desired label is absent → `effect_applied`
        (the desired end state already holds);
     2. the issue is readable AND the label remains present → `effect_not_applied`;
     3. the issue/repository cannot be authoritatively read, or the read is ambiguous or
        truncated → `effect_unknown`.
     Absence is NEVER inferred from the status code alone: the mutation is defined by
     desired external state, not by whether this particular DELETE call performed the
     transition.

**Label-equivalence exposure gate (S2/S3; exact; MEDIUM LABEL-SEMANTICS-A correction).**
Because the current official GitHub REST contract does not authoritatively define
label-name case/Unicode equivalence, the following gate freezes the ONLY path to mutation
exposure: BEFORE the GitHub v1 MUTATION catalog may be exposed in P7-S3, separately
authorized live-provider verification MUST establish the provider's actual
label-equivalence behavior required by `github.issues.addLabel` and
`github.issues.removeLabel`. The live verification must test at minimum:

- case-only variants;
- representative non-ASCII / Unicode-normalization variants sufficient to determine
  whether normalization matters for the catalog;
- response spelling versus requested spelling;
- duplicate/add behavior under equivalent spellings;
- remove behavior under equivalent spellings.

The verified rule MUST be recorded in the versioned GitHub provider catalog. If the
provider behavior cannot be reduced to ONE deterministic mechanically enforceable rule:
STOP for registered design adjudication before mutation exposure.

**Safe behavior before equivalence is verified (exact).** Until the equivalence rule has
been independently verified and encoded in the provider catalog:

- the GitHub mutation catalog exposure remains CLOSED;
- `desiredLabelPresent` MUST NOT assume byte-exact equality;
- any reconciliation whose truth depends on unresolved label equivalence classifies
  `effect_unknown`;
- NO adoption/success may be inferred from byte-exact absence.

This is an S2/S3 implementation gate and requires NO live GitHub contact in this S1
correction task.

**`github.issues.updateFields` is REMOVED from v1 and recorded as DEFERRED**, pending a
separately reviewed concurrency/precondition contract. Reason (exact): P7 v1 has no frozen
provider-documented atomic lost-update protection for issue title/body mutation, and a
human may update title/body between observation and PATCH, so an unconditional absolute PATCH
could overwrite concurrent human work even though repeating the same PATCH is technically
idempotent. v1 does NOT invent unsupported ETag/If-Match semantics and does NOT add a
concurrency subsystem. All v1 references to title/body MUTATION (including
`titleMatches`/`bodyMatches` reconciliation predicates) are removed from the v1 catalog and
identity examples; `github.issues.get` remains the read/reconciliation operation, and
title/body remain bounded AGENT-VISIBLE READ content only (§9), not v1 mutation fields.

Explicitly EXCLUDED from v1 (and not deferred by silence): create issue; create comment;
close/reopen; milestone; assignee changes (no v1 justification); merge; publish; delete;
send/notification; payments; any destructive or irreversible class. Create-with-fingerprint
is DEFERRED — it is not needed to prove P7, and its design (including its own reviewed
cross-attempt identity rule) is a later registered decision.

Every cataloged mutation carries its §17 identity class, the `github.issues.get`
reconciliation read, and its consequence class (non-destructive, convergent desired-state,
reversible through a later NEW governed consequence — never a fake undo).

**Mutation reconciliation authority (exact).** P7's safety model depends on reconciliation
reads, so NO read-scope bypass exists for mutations. Every NEW v1 mutation dispatch requires
the CURRENT connector state to satisfy ALL of:

```text
canStartV1Mutation =
  'read' is in current connector allowedScopes
  AND 'write' is in current connector allowedScopes
  AND the exact resource belongs to effectiveReadResources
  AND the exact resource belongs to effectiveMutationResources
  AND every other frozen authority/liveness check passes (§4.2)
```

with the §4.3 directional bounds:

```text
effectiveReadResources     = frozenRunResources ∩ currentConnector.sourceRoots
effectiveMutationResources = frozenRunResources ∩ currentConnector.targetRoots
```

because the mutation's ordinary-Issue class verification, post-dispatch reconciliation, and
later uncertainty recovery all depend on the provider's read path.

**Pre-dispatch ordinary-Issue verification (exact).** The ordinary-Issues-only PR boundary
(§8) is enforced as a NORMAL READ-AUTHORIZED safety precondition:

- it uses the SAME exact resource as the proposed mutation;
- it requires the CURRENT connector `read` scope and the resource inside
  `effectiveReadResources`;
- it consumes the defined integration read charge — the safety-read unit of the mutation
  proposal's frozen three-reservation sequence (§18) — and its predicate evidence is
  stored (§13.4);
- it is NON-agent-visible unless the SAME result is otherwise the requested read;
- it records ONLY the minimum predicate: `resourceClass = issue|pull_request|unknown`.

Outcomes:

- `pull_request` → the mutation intent is `released` BEFORE mutation dispatch (the
  MUTATING request never began; durable release evidence records the class refusal; the
  mutating operation itself never entered `dispatch_started`);
- `unknown` or unreadable/truncated → the mutation intent is `released`/refused BEFORE
  mutation dispatch;
- ordinary `issue` → the mutation may continue if every other authority check passes.

The class proof derives from the GitHub response's own structural marker (a non-empty
`pull_request` member of the issue-resource response); a mutation response is never used to
infer resource class after the fact. This safety read is DISTINCT from the
cross-attempt/current-state reconciliation of §12, which decides whether a NEW mutation
intent is necessary at all; the design freeze does NOT merge the two reads (§12) — a later
merge would require proof that one observation can safely satisfy both temporal authority
positions.

**Provider-neutral implications (exact).** The immutable-historical-evidence rule (§13.2)
is provider-neutral — it is generic integration-runtime semantics. The label-only narrowing
of the v1 mutation catalog is PROVIDER-SPECIFIC catalog content for the `github` kind.
Nothing about labels, Issues, or GitHub operation ids may leak into the generic
integration authority/runtime core; the closure-blocking defect class (§29) is unchanged.

## 11. Operation identity: two roles, one runtime

Two identity roles exist; they are NOT interchangeable.

### 11.1 Same-Run operation key (Run-scoped — unchanged)

The existing Run-scoped target-operation key semantics are preserved EXACTLY for resume,
process restart, and same-Run exactly-once behavior. The derivation stays
`run:{runId}:slot:{slotHash}:input:{inputHash}` (slot hash and canonical-input hash as
owned by the existing operation-key authority; integration operations simply use it with
their operation id and closed args). It is NOT used for cross-attempt deduplication.

### 11.2 Ticket-scoped logical integration identity (new, cross-attempt)

Freeze, for the v1 naturally idempotent catalog:

```
integration:{ticketId}:connector:{connectorId}:provider:{providerKind}:op:{operationId}:resource:{resourceSha256}:args:{argsSha256}
```

- `ticketId`, `connectorId` — exact repository ids as decimal integers;
- `providerKind` — the exact provider-kind token (`github` in v1);
- `operationId` — the exact catalog operation id;
- `resourceSha256` — lowercase SHA-256 hex of the UTF-8 canonical resource identity string
  (§5);
- `argsSha256` — lowercase SHA-256 hex of the exact existing canonicalizer output for
  `{ operation: <operationId>, args }` (sorted keys, no whitespace, undefined-filtered,
  arrays order-preserving, UTF-8). Compact form bound: the logical identity never exceeds
  512 characters (compatible with the existing idempotency-key storage bound).

Canonicalization is exactly this: closed schema-validated canonical values (no transient
data), the existing canonicalizer's byte-exact output, and the canonical lowercase resource
form. No transient execution ordinal, no random per-attempt key, and no provider response
identity are sources of the logical identity.

Determinism examples (each provable from the frozen fields):

- same label + same issue + same Ticket → SAME logical identity (fingerprints equal);
- different label → different identity (args fingerprint differs);
- different issue → different identity (resource hash differs);
- `github.issues.addLabel` and `github.issues.removeLabel` of the SAME label on the SAME
  issue are DIFFERENT logical identities (different operation id → different identity);
- different connector → different identity (connector id differs); a different
  providerKind would also differ.

A future NON-idempotent operation class MUST define a separately reviewed logical-identity
rule (create-with-fingerprint or equivalent) BEFORE it is exposed. None is authorized in v1.

Provider-equivalence note (exact): the byte-exact label argument fingerprint REMAINS the
frozen logical identity — it is intentionally conservative and may UNDER-MERGE
provider-equivalent spellings. Under-merging can cause an EXTRA current-state
reconciliation; it must NEVER cause a false desired-state success (desired-state
reconciliation uses the provider-verified equivalence of §10/§13.4). If later
implementation evidence shows byte-exact logical identity itself creates a safety defect:
STOP for registered design adjudication rather than silently changing it.

## 12. Reconcile-before-dispatch / adoption: historical truth vs current desired-state truth (exact)

**The two facts are different and are never collapsed:**

- **Historical intent classification** answers: "what could that Run durably establish at
  its settlement boundary?" It is immutable intent-local historical truth (§13.2).
- **Current reconciliation** answers: "does the desired external state hold NOW?" It is
  the CURRENT Run's own bounded observation under current connector authority.

Worked example frozen to fix the rule: attempt 1 `addLabel("urgent")` →
`effect_applied`; a human later removes `urgent`; attempt 2 proposes the same logical
`addLabel("urgent")`. Attempt 1's historical `effect_applied` is truthful for attempt 1
but does NOT prove `urgent` is present NOW. The inverse applies to historical
`effect_not_applied`. Historical truth never independently decides a NEW proposal.

### Case A. Same Run + same operationKey = REPLAY ONLY

Replay/resume of the SAME operation execution; the existing Run-scoped exactly-once
semantics continue unchanged. If durable terminal evidence already exists for that same
operation key, the runtime replays the durable result; it does NOT redispatch; it does
NOT create a new logical operation; NO new current-state reconciliation is required
merely to replay historical execution evidence. This is historical replay semantics —
not a decision about current desired state.

### Case B. Any NEW operation proposal with the same ticket-scoped logical identity

This includes a later attempt AND a later distinct operation slot in the same Run. Before
suppressing OR permitting mutation dispatch because of a prior matching logical identity,
the runtime MUST establish CURRENT desired-state truth through a fresh bounded
reconciliation read. Historical `effect_applied` / `effect_not_applied` / `released` is
evidence about the OLD Run only; it is NEVER sufficient by itself to decide the new
proposal, because a human or another authorized actor may have changed the external
state since.

Exact sequence for a NEW proposal whose ticket-scoped logical identity already exists
historically:

1. inspect the matching immutable prior intent(s) — never rewritten (§13.2);
2. perform a CURRENT bounded reconciliation read under CURRENT connector authority:
   connector active; Work Context active; current `read` scope present; the exact
   resource inside `effectiveReadResources`; the frozen credential alias resolving
   (current state — never the frozen authority alone);
3. append reconciliation evidence owned by the CURRENT observing Run on the existing
   append-only event-chain owner (§13.2), referencing the relevant prior intent and
   identity;
4. classify CURRENT desired-state truth by the §13.4 predicate and act on it:

   - **CURRENT desired state HOLDS** (addLabel: `desiredLabelPresent == true`;
     removeLabel: `desiredLabelPresent == false`): record adoption/satisfaction evidence
     for the CURRENT proposal (§12.1); dispatch NO mutation; rewrite NO prior intent;
     the current Run may use this current reconciliation fact as authority for its own
     work;
   - **CURRENT desired state does NOT hold** (addLabel: `desiredLabelPresent == false`;
     removeLabel: `desiredLabelPresent == true`): the historical prior classification does
     not block current work; create a NEW prepared intent for the mutation ONLY through
     the normal admission/reservation gates (both charges, §18); NO automatic retry
     semantics exist;
   - **CURRENT truth remains unknown**: dispatch NO mutation; create NO new mutation
     intent; append the unknown reconciliation evidence (append-only, owned by the
     current Run); terminate/block honestly through the existing non-success path (§20);
     operator recourse remains required (§21).

### 12.1 Adoption semantics (exact)

Adoption does NOT mean "the prior intent once said effect_applied." Adoption means: a
CURRENT reconciliation observation proves the desired external state presently holds, and
that observation is linked to the matching historical logical effect. The prior intent is
immutable historical evidence; the current Run's reconciliation/adoption evidence is
current authority. Never collapse the two concepts.

- Historical `effect_not_applied` NEVER authorizes dispatch by itself: the desired state
  may have been established since. CURRENT reconciliation always decides.
- Historical `effect_applied` NEVER suppresses dispatch by itself: the external state may
  have been reversed since. CURRENT reconciliation always decides.
- A historical `released` intent proves only that the old mutation request never began;
  it grants NO current desired-state truth and is never treated as current effect
  evidence. A later NEW proposal follows its normal current authority path, and its
  mandatory pre-dispatch safety read (§10) remains free to establish the current desired
  label state if the implementation reuses the same response predicate.

**Cross-attempt reconciliation is NOT the pre-dispatch safety read (exact).** Their
purposes stay distinct in the design freeze:

- cross-attempt/current-state reconciliation: determine whether a historically matching
  logical desired state holds NOW; occurs BEFORE deciding whether a new mutation intent
  is necessary at all;
- the new-mutation pre-dispatch safety read: for an ALREADY-ADMITTED NEW mutation,
  revalidate ordinary Issue class and current read authority/containment immediately
  before mutation dispatch (§10; it remains the frozen charged safety read under the
  three-reservation reservation model, §18).

Premature optimization that merges them into one read is NOT frozen: a later
implementation would need proof that the same observation can safely satisfy both
temporal authority positions.

**Charging (exact).** Cross-attempt/current-state reconciliation before an
adoption/dispatch decision is RECOVERY/ADOPTION RECONCILIATION, governed by the
separately bounded reconciliation authority — NOT an ordinary `integration_operation`
charge (§18). It still requires CURRENT connector active, Work Context active, current
`read` scope, the resource inside `effectiveReadResources`, and the frozen alias
resolving; it NEVER mints connector scope or credentials. If reconciliation proves the
current desired state does NOT hold and a NEW mutation is then proposed, that NEW
mutation follows the normal current authority/budget path — including its own reserved
THREE-reservation safety-read + mutation sequence (§18). In that case two reads occur; S1
preserves simple truthful authority over read-count optimization.

**Concurrency expectation (exact).** P7 v1 label operations provide CONVERGENT
desired-state behavior — not a global lock against external human changes. The system
establishes current truth at its reconciliation/safety boundaries; a human may still
modify the provider after any observation; the system must never claim more than the
durable observation proves. No distributed lock with the provider is claimed.

## 13. Durable integration-intent state machine

The semantic relation (frozen BEFORE any migration is authored; the SQL realization is
implementation work under §25):

- canonical relation name: `integration_operation_intents`;
- ONE row per `(runId, operationKey)` (the same-Run key of §11.1);
- each row additionally carries the ticket-scoped logical identity (§11.2) used for
  cross-attempt reconciliation; the relation is NOT unique on logical identity alone, because
  each attempt owns its own intent row — instead the reconcile-before-dispatch gate (§12)
  plus the transition guard below prevents divergent parallel truth for one logical identity.

Required durable facts on every row:

- `ticketId`; attempt identity (`ticketAttemptId`); `runId`; the same-Run `operationKey`;
  the ticket-scoped logical identity; `connectorId`; `providerKind`; `workContextId`;
  credential ALIAS identity; canonical resource identity; operation id; canonical/redacted
  args fingerprint; authority-decision reference (a bounded replay-addressable reference to
  the Run's existing authority-decision evidence for the proposed operation); budget
  reservation linkage (a bounded reference into the Run's existing runtime-budget
  accounting, with the charging class of §18); dispatch state; authority-safe response
  evidence facts; reconciliation metadata (attempts, reads, timestamps, classification
  evidence class); effect classification (immutable after reconciliation, §13.2);
  creation/dispatch/persistence/
  reconciliation timestamps.

Authority-safe response evidence facts are exactly what durable integration evidence
requires (§19): request identity, resource identity, size/hash facts, provider status,
exact reconciliation predicates, classified outcome, and bounded safe metadata — NEVER full
external business content. Agent-visible external content follows the existing tool-result
privacy boundary and is owned elsewhere (§9, §19).

NO secret material and NO unrestricted provider payload enter the relation — only bounded
authority-safe evidence at the §18 result-size ceiling.

### 13.1 State vocabulary (exact)

```text
prepared
dispatch_started
response_persisted
reconciled
released
```

### 13.2 Terminal effect classification (exact)

```text
effect_applied
effect_not_applied
effect_unknown
```

The effect classification is recorded ONLY in the `reconciled` state. No other state may
carry or imply a terminal effect classification. `released` is a separate terminal
PRE-DISPATCH state and carries NO effect classification at all (§13.3).

**Intent-local historical truth (immutable after reconciliation).** Once an integration
intent reaches `reconciled` — with `effect_applied`, `effect_not_applied`, or
`effect_unknown` — that classification is IMMUTABLE forever for that intent. It records
what the owning Run could durably establish at its settlement boundary. No later Run or
attempt may rewrite it. There is NO in-place refinement of a prior intent row — no
`effect_unknown -> effect_applied` and no `effect_unknown -> effect_not_applied` on a
historical row. A prior intent row remains `reconciled(effect_unknown)` forever while
later knowledge lives in append-only reconciliation facts owned by later observing Runs.

**Later reconciliation of a prior logical effect (append-only; owned by the observing
Run).** A later operator-authorized attempt may establish NEW knowledge about the same
ticket-scoped logical external effect — for a prior intent that is `effect_unknown`, or a
prior `effect_applied`/`effect_not_applied` whose CURRENT desired-state truth a NEW
proposal must re-establish (§12). That knowledge is append-only evidence owned by the
CURRENT observing Run — never an edit of the prior row — and references EXACTLY:

- `priorIntentId` (the prior intent's durable identity, when applicable);
- the ticket-scoped logical integration identity (§11.2);
- the prior Run/attempt identity;
- the current observing Run/attempt identity;
- the reconciliation resource (canonical resource identity, §5);
- the desired label;
- `desiredLabelPresent` as observed (the CURRENT desired-state truth predicate, §13.4);
- the bounded reconciliation evidence (§13.4);
- the classification of CURRENT desired-state truth (holds / does not hold / remains
  unknown, §12) and the OBSERVED classification (`effect_applied`, `effect_not_applied`,
  or an irreducible `effect_unknown`);
- the observation timestamp.

ONE existing append-only owner owns this fact: the repository's per-Run hash-chained event
chain (`events` + `run_event_chain_tips`; database-enforced append-only; integrity owner
`runtime/event-integrity.js`), attached to the OBSERVING Run; Run-visible receipt material
continues through the existing append-only `operation_receipts` owner. No new history
ledger is created. The system may PROJECT a logical external effect as later-resolved
from those append-only reconciliation facts (and adoption decisions, §12), but that
projection NEVER rewrites historical Run truth: the prior row stays
`reconciled(effect_unknown)` forever.

`effect_unknown` is terminal FOR THE OWNING RUN'S CURRENT CONSEQUENCE DETERMINATION: it can
never support successful completion, and a Run whose unresolved intents remain
`effect_unknown` at its terminalization seam terminates honestly in a non-success
disposition with the uncertainty evidence recorded — the Ticket/attempt topology does not
deadlock, because later operator-authorized attempts can establish NEW knowledge about the
same logical effect through append-only reconciliation facts owned by the observing Run
(§12, §15, §20) without rewriting historical intent truth. An `effect_unknown`
classification NEVER grants permission to redispatch.

### 13.3 Permissible transitions (exact)

| From | To | Guard |
|---|---|---|
| `prepared` | `released` | pre-dispatch ONLY — more precisely: the MUTATING external-effect request owned by THIS intent never began dispatch (no byte of the actual mutating provider request was sent; preceding bounded READ-ONLY safety traffic — resource-class verification, reconciliation/safety probes, authority/liveness checks — does NOT make this intent `dispatch_started`); the guard writes a DURABLE release reason/evidence stating why mutation dispatch never began; `released` is terminal FOR THE INTENT, carries NO effect classification, and satisfies settlement because there is provably no external consequence from THIS intent (§20) |
| `prepared` | `dispatch_started` | authority + budget + liveness (§4.2, §4.3) + reconcile-before-dispatch (§12) all pass; for mutations the §10 pre-dispatch ordinary-Issue class verification also passes; the FIRST byte of the actual mutating provider request is the boundary; exactly ONE dispatch attempt per intent in v1 |
| `dispatch_started` | `response_persisted` | durable authority-safe response evidence facts written (§13, §19) |
| `dispatch_started` | `reconciled` | recovery reconciliation completes first when no durable response exists (§15) |
| `response_persisted` | `reconciled` | reconciliation stamps the classification (§16, §13.4) |

No other transitions and no backward state movement. There is NO in-place change to a
`reconciled` or `released` row: state and classification are immutable intent-local
historical truth (§13.2); later knowledge about the same logical effect is append-only
evidence owned by the OBSERVING Run that references the prior intent without rewriting it
(§12). A Run settlement (§20) requires every
integration intent it created to be `released` (with durable release evidence) or
`reconciled` (with its immutable classification). Nonterminal states
(`prepared`, `dispatch_started`, `response_persisted`) block settlement until the intent
reaches `released` or `reconciled`. No state transition may invent certainty: an intent
without recorded classification evidence is never treated as applied or not-applied beyond
that evidence.

### 13.4 Reconciliation evidence predicates (exact)

Reconciliation classifies against FULL desired-state truth, never against truncated
agent-visible presentation (§9). The v1 mutation catalog is label-only (§10), so the exact
mutation predicate is:

```text
desiredLabelPresent: true|false
```

- `github.issues.addLabel`: readable, COMPLETE issue state AND the desired label present →
  `effect_applied`; readable complete state AND the desired label absent →
  `effect_not_applied`; incomplete or ambiguous or unreadable → `effect_unknown`.
- `github.issues.removeLabel`: readable, COMPLETE issue state AND the desired label absent
  → `effect_applied`; readable complete state AND the label present → `effect_not_applied`;
  incomplete or ambiguous or unreadable → `effect_unknown`.

No status code alone establishes desired-state truth; label data that is omitted,
truncated, or beyond the safe bound proves NOTHING either way.

**Provider-true label equivalence (exact; MEDIUM LABEL-SEMANTICS-A correction).**
`desiredLabelPresent` MUST be evaluated under the provider's VERIFIED TRUE
label-equivalence semantics for the cataloged operations. The GENERIC integration runtime
MUST NOT hardcode any label-name equality rule — case-sensitive equality, lowercase
equality, Unicode normalization, or locale-specific folding are PROVIDER semantics, and
the official GitHub REST contract does not authoritatively define label-name case/Unicode
equivalence. Byte-exact comparison therefore CANNOT be assumed to equal provider identity
semantics; the exposure gate and pre-verification fallback are frozen in §10.

Frozen mechanics:

- provider transport may produce bounded AGENT-VISIBLE read content for the Ticket's work;
  that content follows the existing tool/result privacy boundary and is NOT the intent
  relation's evidence (§19; the §14 in-memory rule unchanged: in-memory observation is not
  authority);
- reconciliation derives the exact label predicate from a bounded provider response or
  from an already-durable normalized success response, BEFORE presentation truncation, and
  stores ONLY the minimum secret-safe predicate evidence: `desiredLabelPresent` for
  mutations, and `resourceClass = issue|pull_request|unknown` for the §10 pre-dispatch
  ordinary-Issue verification. External issue title/body is bounded agent-visible read
  content for the Ticket (§9) — never mutation state, never intent-relation durability,
  and never persisted merely to prove a predicate;
- response-derived reconciliation: definitive success responses for the v1 catalog already
  carry the desired-state facts, so the `response_persisted → reconciled` seam may classify
  DIRECTLY from those durable predicates WITHOUT a new network contact (no extra budget
  item — §18); an INCOMPLETE/ambiguous response forces the §15 reconciliation-read path;
- if exact predicate truth cannot be established within the response/result bounds, the
  classification is `effect_unknown` (§16).

## 14. Kill-point matrix (required recovery truth)

| Kill point | Required truth |
|---|---|
| Process dies before the mutating external-effect request of an intent can begin | The durable `prepared` intent exists; the PROVABLE truth is that its MUTATING request never began (bounded read-only safety traffic — class verification, reconciliation probes, liveness checks — does not move the intent past `prepared`); it may be `released` (durable evidence that mutation dispatch never began) or may later win the `dispatch_started` transition under full authority |
| Process dies after the mutating request begins, before a durable response | The intent is `dispatch_started`; the outcome is UNKNOWN; reconciliation is mandatory and dispatch is forbidden |
| Provider applies the effect before the response reaches durable state | UNKNOWN until reconciliation proves the desired state; nothing may claim applied |
| The response reaches the process but the process dies before persistence | Still UNKNOWN — in-memory observation is not authority; reconciliation re-establishes truth |

## 15. Reconciliation triggers (exactly three)

Exactly three automatic reconciliation seams exist:

1. resume/recovery of the owning Run;
2. the owning Run's terminalization seam, before settlement (§20);
3. a later attempt's reconcile-before-dispatch/adoption for the same logical identity (§12),
   which establishes NEW knowledge about the same logical effect through append-only
   evidence owned by the observing Run — it never rewrites the prior intent (§13.2).

There is NO background reconciliation scheduler, NO polling daemon, NO webhook, and NO T9
authority in P7. Recovery reconciliation is NOT external work: it completes an existing
authorized obligation (establishing truth for an already-proposed, already-authorized
operation) and is bounded per §18; it is distinct from T9 event triggering, which remains
EMPTY/DEFERRED authority.

**Current-authority containment of reconciliation (exact).** A mutation already in
`dispatch_started` (or an intent whose reconciliation is pending) still obeys CURRENT
connector authority at any subsequent reconciliation seam. If the connector is
paused/archived, the current `read` scope was removed, `sourceRoots` no longer contains
the resource, or the frozen credential alias no longer resolves, then reconciliation:

- does NOT bypass current connector authority;
- does NOT redispatch;
- does NOT mint connector scope from recovery authority and does NOT resurrect a revoked
  credential — recovery authority exempts reconciliation from ordinary
  `integration_operation` budget charging ONLY (§18) and grants nothing beyond it;
- preserves or produces `effect_unknown` when the truth cannot be re-established (§16,
  §20); the immutable prior intent row never changes (§13.2);
- surfaces operator reconciliation/recourse (§21).

## 16. Universal uncertainty / retry doctrine

**Never blindly redispatch an uncertain external mutation.** Classifications may be no
stronger than evidence. Universal minimum mapping (providers may refine ONLY where evidence
supports it, and may never turn an ambiguous outcome into certainty):

| Post-dispatch observation | Classification |
|---|---|
| Proven pre-dispatch failure (the mutating request never began) | NO external-effect classification — the intent is `released` with durable release evidence; preceding read-only safety traffic does not change this |
| Post-write with no response | UNKNOWN |
| Timeout | UNKNOWN |
| 429 with definitive provider rejection | effect NOT applied (definitive refusal) |
| Ambiguous 5xx | UNKNOWN |
| Malformed / oversized / empty mutation response | UNKNOWN unless evidence proves otherwise |
| Definitive success response observed and lost before durability | UNKNOWN (in-memory observation is not authority) |
| Process death after dispatch began | UNKNOWN |

Provider mappings may NOT weaken these rules. A status code alone is never definitive v1
effect evidence: a definitive rate-limit rejection (429) proves non-application; any 404 on
a v1 mutation is classified ONLY through the §10 desired-state reconciliation rule (never
by status-code inference).

There is NO runtime automatic retry in P7 v1 — not on error, not on uncertainty, not on
budget exhaustions. Explicit redispatch after a NOT-applied classification requires a NEW
explicit operation proposal and the normal authority/budget admission path (§12). An
`effect_unknown` classification never grants permission to redispatch and never supports
successful completion (§13.2, §20); later knowledge about the same logical effect is
append-only evidence owned by the observing Run — the historical intent row never changes
(§12, §13.2).

## 17. Idempotency taxonomy

Exactly six classes:

1. naturally idempotent (convergent desired-state);
2. provider idempotency key;
3. conditional / etag preconditions;
4. provider-native dedup;
5. reconciliation-only;
6. unsupported for unattended mutation.

Every cataloged mutation MUST define: identity class; reconciliation read; consequence class.
All three v1 mutations are class 1 with `github.issues.get` as reconciliation read. A class-6
mutation is NOT exposable without a later registered design (and the §11.2 rule requires its
own reviewed logical-identity rule first).

## 18. Budget model

New runtime-budget dimension: `integration_operation`, with a mutating sub-bound
`integration_operation.mutating`. Exact numerical semantics (no TBD):

| Quantity | Exact value |
|---|---|
| Runtime default `maxIntegrationOperationsPerRun` | `8` |
| Runtime default mutating sub-bound `maxIntegrationMutatingOperationsPerRun` | `4` |
| Hard cap (admissible admission-time total) | `64` |
| Hard cap (admissible admission-time mutating) | `32` |
| Omission behavior (per-Ticket override unset/invalid) | runtime default applies (existing `null → runtime default` per-field pattern); authorization ABSENT ⇒ the dimension is inert at zero for that Run |
| Admission validation | mutating sub-bound must be ≤ the total bound at admission; both must be ≤ their hard caps; otherwise the admission REFUSES |
| Per-Run semantics | immutable per admitted Run like every other budget dimension; resumption/continuation re-uses the same frozen numbers |
| Request payload limit (canonical args, post-validation, pre-transport) | `16384` bytes (16 KiB); larger refuses AFTER authority checks and records the refusal |
| Result-size ceiling (authority-safe response/reconciliation evidence stored per intent) | `65536` bytes (64 KiB) |
| Operation timeout ceiling | `30000` ms per dispatch; each catalog operation defines its own timeout ≤ the ceiling (the v1 catalog fixes `15000` ms); no configuration surface may raise the ceiling |
| Recovery reconciliation bound | per unresolved intent, ≤ `3` reconciliation attempts per reconciliation-seam invocation; each attempt ≤ `30000` ms with the result-size ceiling; a durable per-intent attempts counter; per-intent hard bound `24`; exhaustion leaves the intent `reconciled` with classification `effect_unknown` (it never invents certainty) — accounted per the TWO-CASE reconciliation-attempt accounting below |

**Reconciliation-attempt accounting (two cases, exact; LOW reconciliation-counter
clarification).** No later attempt ever mutates a settled prior intent row to count its
reconciliation attempts. Two accounting cases exist:

- **Case A — owning-Run reconciliation of its OWN nonterminal intent.** The intent-local
  owning Run uses the already-frozen limits: max `3` reconciliation attempts per
  reconciliation-seam invocation, max `24` owning-Run reconciliation attempts for that
  intent BEFORE its own terminal classification. Its durable reconciliation metadata may
  record its own pre-settlement count because the row is not yet terminal.
- **Case B — later observing-Run adoption/current-state reconciliation.** Once the
  historical intent is terminal and immutable, later reconciliation attempts are owned by
  the CURRENT observing Run and are counted from THAT observing Run's append-only
  reconciliation-attempt events for the matching ticket-scoped logical identity: max `3`
  per reconciliation-seam invocation; max `24` adoption/current-state reconciliation
  attempts per observing Run per ticket-scoped logical identity. The bound is derivable
  from append-only evidence and does NOT mutate the prior terminal intent; a NEW later Run
  gets its own bound under its own authorization, while the existing Ticket attempt
  ceiling and execution-step/runtime ceilings remain additional system bounds. No global
  forever-counter is added; no free unbounded read channel exists.

The minimal reconciliation-attempt event fact (owned by the EXISTING append-only event
authority — the observing Run's hash-chained event chain; no new history ledger):
observing Run id; observing attempt identity; ticket-scoped logical integration identity;
`priorIntentId` when applicable; canonical resource; reconciliation seam; the observing
Run's attempt ordinal for that Run/logical identity; observation timestamp; result
classification or transport outcome.

These values follow repository precedent (process tier `4`/Run, workspace tier `32`/Run,
2-minute runtime ceiling, 16 MiB artifact ceiling): every integration operation crosses the
governed-effect perimeter, so the total tier sits between the process tier and the workspace
tier, and the mutating default `4` is exactly HALF of the total default `8` (the hard cap
`32` is likewise exactly half of `64`). Nothing is "unlimited".

**Critical charging rule (exact):**

- Recovery reconciliation of an ALREADY-DISPATCHED prepared intent does NOT consume ordinary
  `integration_operation` budget. It is recovery authority needed to establish truth, and it
  remains separately bounded by the explicit reconciliation-attempt/time/result bound above;
  recovery authority NEVER mints connector scope (§4.3) and NEVER resurrects a revoked
  credential (§4.4).
- Ordinary reads (v1 `github.issues.get` as a normal inspection/verification operation) and
  pre-dispatch safety reads DO consume `integration_operation` budget — including EXACTLY
  ONE ordinary read charge per mutation for the §10 pre-dispatch ordinary-Issue
  verification.
- **Three-reservation mutation coherence (exact; HIGH TWO-CHARGE-A correction).** Every
  NEW v1 mutation proposal reserves THREE deterministic rows in the repository's existing
  budget reservation authority (`run_budget_charges`: identity
  `(run_id, dimension, source_identity)`, states `reserved`/`committed`/`released`) BEFORE
  the safety read begins. With `K` = the mutation's existing same-Run `operationKey`, the
  exact source-identity derivations and reservation tuples are:

  ```text
  integrationSafetyReadSource = K + ":integration-safety-read"
  integrationMutationSource   = K + ":integration-mutation"

  (integration_operation,          integrationSafetyReadSource)  amount 1
  (integration_operation,          integrationMutationSource)    amount 1
  (integration_operation.mutating, integrationMutationSource)    amount 1
  ```

  (The mutating reservation may reuse the mutation source string because the
  `(run_id, dimension, source_identity)` tuple keeps the rows distinct.) All THREE
  reservations must succeed BEFORE the safety read begins; on ANY reservation failure the
  runtime performs NO safety read, creates NO mutation intent, releases every reservation
  already obtained for this proposal through the existing release authority, and refuses
  through the existing budget authority. A prepared mutation intent can therefore never
  exist lacking its already-reserved read+mutation capacity.
- **Exact commit/release semantics (repository-true; verified against
  `persistence/postgres/runtime-budget-methods.js` and migration `030`).** The repository
  truth frozen for these rows: a budget row is keyed `(run_id, dimension,
  source_identity)`; exactly ONE `reserved -> committed` transition exists per row;
  committing LESS than reserved automatically releases the unused remainder (`unused
  reservation` release event); a second commit against an already-committed row with the
  same amount is an idempotent no-op; a COMMITTED row can never later be released;
  re-reserving the same source identity with a different amount refuses
  (`RUN_BUDGET_RESERVATION_CONFLICT`); a released source identity cannot be reused.
  Consequences, frozen exactly:

  - the safety read completes durably → commit EXACTLY
    `(integration_operation, K + ":integration-safety-read")` amount `1`. NEVER commit the
    mutation charge at that point;
  - the safety read causes refusal/release (PR resource; resource class unknown; a
    connector narrowed below the mutation path; authority no longer valid before mutation
    dispatch; any other frozen pre-effect refusal) → the safety-read row REMAINS committed
    because the read actually occurred; RELEASE the uncommitted mutation reservation
    `(integration_operation, K + ":integration-mutation")` and the uncommitted mutating
    reservation `(integration_operation.mutating, K + ":integration-mutation")`; the
    mutation intent may reach `released` under the already-frozen rule if it exists at
    that point; the mutating request never begins;
  - the mutation reaches its actual dispatch charge point → commit EXACTLY
    `(integration_operation, K + ":integration-mutation")` amount `1` AND
    `(integration_operation.mutating, K + ":integration-mutation")` amount `1`, at the
    existing frozen dispatch charging boundary. NO single budget row is partially
    committed twice; NO committed reservation is later released.
- **Crash/recovery budget truth (exact).** Before the safety read: all three rows
  reserved; process crash recovery uses the EXISTING budget-reservation reconciliation
  authority; no effect occurred. After the safety read is durably recorded: the safety row
  is committed and the mutation rows remain reserved until the mutation dispatch/refusal
  truth resolves. After the mutation dispatch charge point: all applicable rows are
  committed. The budget evidence must be reconstructable from the existing
  reservation/commit/release authority and its appended events — no additional budget
  mechanism is invented; implementation later uses the existing repository owners.
- **Cross-attempt adoption reconciliation (exact).** The current-state reconciliation a
  NEW proposal performs before any adoption/dispatch decision over a historically
  matching logical identity is RECOVERY/ADOPTION RECONCILIATION: governed by the
  separately bounded reconciliation authority, NOT an ordinary `integration_operation`
  charge. It requires CURRENT connector active, Work Context active, current `read`
  scope, the resource inside `effectiveReadResources`, and the frozen alias resolving;
  recovery/adoption authority NEVER mints connector scope or credentials (§15). If it
  proves the CURRENT desired state does NOT hold and a NEW mutation is proposed, that
  NEW mutation then performs/reserves its normal three-reservation safety-read + mutation
  path exactly as frozen above — two reads in that case is the preferred simple truthful
  authority posture in S1 (§12).
- Mutating operations consume the mutating sub-bound as well as the total.
- Response-derived reconciliation (§13.4: classifying from already-durable success-response
  predicates) performs NO new network contact and consumes NO additional budget item;
  recording a `released` refusal/release evidence consumes no budget item.
- No charging occurs without the frozen immutable integration authorization; the dimension is
  inert for Runs without it.

## 19. Evidence ownership (one canonical owner per fact)

| Fact | Owner |
|---|---|
| Prepared intent | integration-intent relation |
| Dispatch lifecycle | integration-intent relation |
| Provider response authority facts (bounded, agent-content-free: request identity, resource identity, size/hash facts, provider status, exact reconciliation predicates, classified outcome) | integration-intent relation |
| Reconciliation facts (bounded predicate/read evidence) | the intent row, for facts its OWNING Run establishes about its OWN intents before settlement; a LATER Run's reconciliation observations of a prior intent are append-only evidence owned by the OBSERVING Run on the existing per-Run hash-chained event chain (`events` + `run_event_chain_tips`; integrity owner `runtime/event-integrity.js`), referencing the prior intent without rewriting it (§13.2) |
| Terminal effect classification (immutable after reconciliation) | integration-intent relation — measured at the owning Run's settlement boundary and NEVER rewritten; later observed classifications are append-only facts owned by observing Runs (§13.2) |
| External resource identity | integration-intent relation + final Run receipt reference |
| Run-visible immutable receipt | existing operation receipt |
| Event/replay visibility (incl. every reconciliation observation) | existing event/replay system |
| Agent-visible external business content (e.g., read-operation issue title/body presented to the model) | the existing tool-result/replay/run-output surface (`RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md`), wherever that surface durably records it — the intent relation LINKS to it and never duplicates it |
| Connector view | read-only projection by `connectorId` |

Full external business content (whole issue body, full label sets beyond the bounded
fields) is NEVER persisted into the integration-intent relation merely because the agent
was allowed to read it; existing product evidence requirements are not weakened — wherever
another canonical owner already durably stores action output, that owner keeps ownership
and the intent relation references it.

There is NO second connector-receipt ledger for Run-integrated effects. The existing
standalone connector receipt semantics (migration `022`, `LOCAL_CONNECTOR_CONTRACT.md`) remain
exactly as they are for their existing surface (standalone connector reads/refused writes); P7
Run-integrated evidence does not flow through that ledger.

Run-integrated evidence must be: bounded; secret-free; replayable; reference/hash-linked; and
sufficient for P2 completion truth (the completion authority consumes existing receipts and
reconciliation metadata through the existing evidence owners — no new completion path).

## 20. Completion / settlement rule (exact)

A Run may settle — through the existing canonical settlement authority — ONLY when every
integration intent the Run created is in exactly one of:

- **A. `released`** — the MUTATING external-effect request owned by THIS intent provably
  never began dispatch, with durable release reason/evidence (§13.3). There is NO external
  consequence from this intent to reconcile, so NO effect classification exists or is
  claimed. Settlement may proceed.
- **B. `reconciled`** — with its immutable measured classification:
  - `effect_applied` → usable external-effect truth;
  - `effect_not_applied` → usable non-application truth;
  - `effect_unknown` → terminal uncertainty evidence sufficient for honest NON-SUCCESS Run
    termination (through the existing non-success Run dispositions; the Ticket/attempt
    topology does not deadlock), but NEVER completion/success authority and NEVER
    permission to redispatch (§13.2, §16). Later operator-authorized attempts may establish
    new knowledge about the same logical effect through append-only evidence owned by the
    observing Run (§12) — without rewriting this intent's historical truth.

Any nonterminal state (`prepared`, `dispatch_started`, `response_persisted`) blocks
settlement until the intent reaches `released` or `reconciled`. An unresolved external
effect is NOT success, NOT an ordinary (fabricated-clean) failure, and NOT "probably
applied": a Run whose unresolved intents remain `effect_unknown` terminates honestly in a
non-success disposition with the uncertainty evidence recorded, the Ticket stays open for
operator recourse (§21), and a later attempt can establish new knowledge about the same
logical effect through the §12 seam (append-only, without rewriting historical truth).
Missing or partial integration evidence remains an integrity/uncertainty condition. This
remains compatible with the canonical one-unsettled-attempt rule (max one unsettled attempt
per Ticket; retry/rerun = NEW attempt; resume = same Run). P2/P5 completion authority
remains unchanged — an `effect_unknown` outcome can never complete a Ticket, and no
integration fact creates completion certainty by itself.

## 21. Operator visibility and recourse

Pre-action visibility (before any integration effect):

- connector identity;
- provider kind;
- authorized operations;
- exact resource bounds;
- credential alias identity (and, where useful, the canonical backing slot NAME — never slot
  values);
- Work Context.

Post-action visibility:

- external resource identity;
- operation;
- effect classification;
- transport/result classification;
- intent/receipt/evidence references;
- uncertainty/reconciliation history.

Never secret material.

Recourse available to the operator:

- pause or archive the connector;
- remove or revoke the credential backing the alias;
- cancel the Ticket;
- later, a separately authorized compensating action.

There is NO fake undo. A compensating action is a NEW governed consequence through the full
existing chain (new proposal, new authority, new budget), never a retraction of prior
evidence and never an unlogged write.

## 22. Destructive-action boundary

Consequence classification is semantic, NEVER derived from the HTTP method alone. P7 v1
excludes unattended: send; submit; publish; merge; delete-resource; payment; irrevocable
notification; and equivalent destructive/irreversible actions. Any future inclusion requires
its own registered design with its own uncertainty doctrine and operator recourse.

## 23. Composition boundary

P7 v1 integration operations are:

- agent-loop-only;
- NOT workflow-usable (the existing `isWorkflowUsableAction` exclusion carries; they never
  appear as workflow steps);
- NOT delegable.

Delegated children: inherit NO integration authority; cannot receive connector/resource
authority from parents; remain default-off independently (the P5 non-amplification rule
continues: a parent may cause admission and narrow authority, never mint it). Workflows
cannot mint integration authority from any path. No target-diverse composition is opened.
Future composition over integration targets requires a separately registered design and
continues to obey the P5 non-amplification rule.

## 24. Triggering/background boundary

P7 baseline is request/Run-driven ONLY. There is NO: webhook; inbound external trigger;
polling daemon; background sync; automatic sync; background reconciliation scheduler; or new
scheduler authority. T9 external triggering remains EMPTY/DEFERRED authority; recovery
reconciliation (§15) is NOT triggering — it is the bounded completion of an existing
authorized obligation.

## 25. Persistence/schema semantics (semantic freeze only; NO migration in S1)

This freeze does NOT create a migration number, does NOT write SQL, and does NOT authorize
migration 044. It freezes that later implementation (S2/S3, under their own authorities) WILL
require exactly:

1. a new `integration_operation_intents` relation with the §13 semantics (uniqueness
   `(runId, operationKey)`; identity fields; state vocabulary; effect classification;
   transition guards; foreign-key ownership into the existing Ticket/Run/attempt identity
   chain; evidence linkage into the existing receipt/replay surface; and append/update
   authority semantics — the intent row may transition state ONLY while owned by its
   ORIGINAL Run; once `reconciled` or `released`, the row's terminal historical facts
   (state AND classification) are IMMUTABLE forever (§13.2) and no future attempt updates
   its classification; later reconciliation/adoption facts reference the prior intent
   through the EXISTING append-only event authority (§13.2) and MUST carry exactly the
   §13.2 reference fields (`priorIntentId`; ticket-scoped logical identity; prior Run/
   attempt; observing Run/attempt; reconciliation resource; reconciliation evidence;
   observed classification; timestamp); every other in-place rewrite refuses — no new
   history ledger exists);
2. a `connectors.kind` extension beyond `local_mock` (the fixed `local_mock`-only CHECK and
   its surrounding contract loosen to admit the reviewed provider-kind token `github`, with
   the existing record fields — including `credentialRef` as an ALIAS — preserved);
3. ONE canonical permission registration for integration-capable Ticket authorization
   (`integration:authorize`, §3), migration-owned like every access-catalog permission row;
4. a runtime-budget snapshot version change that admits the `integration_operation`
   dimension and its mutating sub-bound (historically stored snapshots remain readable
   through the existing historical-read rules; nothing is rewritten).

Migration 044 remains unrelated and `NOT_AUTHORIZED`. Nothing in this freeze executes or
authorizes it.

## 26. Documentation hermeticity / ownership

This document is the ONE living normative owner of P7 integration semantics. It is forbidden
to create: another competing connector/integration contract; a duplicated receipt schema;
generic provider rules copied into multiple documents; or provider-specific rules inside
generic authority documentation. `LOCAL_CONNECTOR_CONTRACT.md` stays the owner of existing
connector CRUD/standalone-receipt mechanics (its mock-only `kind` statement may require a
banner update during S2 implementation as current-authority truth, NOT in this docs-only
freeze); `TARGET_PROVIDER_CONTRACT.md` stays the owner of provider-neutral target evidence;
`OPERATOR_CONTRACT.md` stays the owner of operator role/forbidden-boundary doctrine;
`DEPLOYMENT_CONTRACT.md` stays the owner of deployment posture; the register stays the owner
of roadmap identity and the canonical P7-S1 record.

## 27. Stop conditions

Implementation MUST STOP rather than expand architecture if it discovers a need for:

- Ticket lifecycle semantic change;
- Run/attempt semantic change;
- completion-authority semantic change;
- a second execution graph;
- arbitrary HTTP;
- provider-selected authority;
- managed-secret infrastructure as a prerequisite;
- dynamic provider plugin loading;
- a destructive baseline operation;
- target-diverse composition;
- delegated integration authority;
- workflow integration operations;
- T9 event triggering;
- background sync;
- Browser Phase 3 dependency;
- migration 044 dependency;
- a generic multi-provider abstraction beyond the reviewed provider-kind contract.

## 28. Authorization state (current, as of this freeze)

- P6 deployment/operations: `CLOSED / PUBLISHED` (publication commit
  `a7ef4ffb734a96d018d6cd48112fde09ebb5ca39`, "Close P6 deployment and operations").
- P7 Integrations: accepted as the correct next product stage (P7-REVIEW-A), subject to the
  corrections encoded in the canonical register record.
- P7-S1: `DESIGN-FREEZE CANDIDATE` (this document + the register record).
- P7 runtime implementation: `NOT AUTHORIZED` until the P7-S1 freeze is independently
  accepted and published. Authoring this freeze does not itself authorize implementation.
- P7-S2: `NOT AUTHORIZED`.
- P7-S3: `NOT AUTHORIZED`.
- Browser Phase 3: `NOT AUTHORIZED`.
- Migration 044: operationally unapplied / `NOT_AUTHORIZED`.

## 29. P7 completion condition (canonical)

P7 must NOT close merely because GitHub works. Completion requires ALL of:

1. the provider-neutral authority model is proven (not only the GitHub wheel);
2. the credential boundary is proven (resolver-only access, secret-confined, alias-frozen);
3. real Run-integrated external reads executed live;
4. real governed non-destructive consequences executed live;
5. uncertainty/reconciliation proven across the kill-point matrix;
6. no blind redispatch is possible (doctrine mechanically enforced);
7. cross-attempt adoption provably prevents duplicate effect;
8. budget/size/time bounds enforced exactly as frozen;
9. operator visibility and recourse complete;
10. all exclusions hold (§10, §22, §23, §24);
11. the implementation core contains no GitHub-specific authority semantics;
12. a second-provider design exercise can be expressed WITHOUT changing Ticket/Run/attempt,
    authority, uncertainty, evidence, credential, or budget semantics;
13. one combined independent review passes;
14. one full canonical release checkpoint passes on the exact final bytes.

Freeze as a closure-blocking defect class: **GitHub-specific semantics appearing in the
generic integration authority/runtime core.**
