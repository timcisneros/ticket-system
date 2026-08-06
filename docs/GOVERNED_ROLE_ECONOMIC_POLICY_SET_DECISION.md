# Governed Role-Keyed Economic Policy Set — Decision Record

**Status:** ACCEPTED and implemented. Approved 2026-08-05.
**Scope:** the governed policy-source container and the role authority read from it.
**Supersedes:** the "GOVERNED POLICY CONTAINER FUNDS ONE ROLE — DECISION REQUIRED
(2026-08-06)" entry in `docs/ARCHITECTURAL_DECISIONS_PENDING.md`.

## 1. Why one singular role policy was insufficient

The governed policy container carried three closed subdocuments:
`roleRoutingPolicy`, `economicPolicy`, `pricingCatalog`. The economic
subdocument recorded **exactly one** `role`, and `readGovernedPolicySource`
refused unless that role equalled the requested one:

```js
if (economicPolicy.role !== role) refuse('governed_policy_role_absent', …);
```

Meanwhile `loadGovernedPlannerPolicyContainer` refused when **more than one**
active container carried governed configuration
(`GOVERNED_PLANNER_POLICY_AMBIGUOUS`).

Those two rules together made the structured path unconfigurable. The structured
plan-to-leaf flow needs both canonical roles — `structured_planner` to plan and
`structured_leaf_executor` to work — but a deployment could fund only one, and
could not add a second container to fund the other. Leaf admission therefore
refused with `leaf_governed_authority_unavailable`. That refusal was **correct**:
no worker economics existed anywhere. The configuration model, not the refusal,
was the defect.

This survived a full release checkpoint because test fixtures never exercised
it: `seedGovernedStructuredTicket` passed a worker-role policy source **straight
to the store**, bypassing the loader entirely. It is the same blind spot that let
the missing-`governedLeafCapture` defect survive — a fixture that skips the
production seam cannot fail when that seam is broken.

## 2. Why multiple active containers were rejected

Permitting a second active container would have been the smallest code change
and the worst outcome. "Which policy funds this role" would have two possible
answers, and answering it would require a selection rule — by name, by creation
order, by role — that nobody has authorized. Container ambiguity is precisely
what `GOVERNED_PLANNER_POLICY_AMBIGUOUS` exists to refuse. The active container
remains **one atomic policy revision**.

## 3. Why a separate worker loader alone was insufficient

A dedicated worker-policy loader would have removed the immediate block while
creating two independent policy systems that could drift: two revisions, two
edit histories, and no single answer to "what economics were in force when this
Ticket ran". Routing and pricing are already **shared** authority across roles;
splitting economics away from them would let a worker be funded against a
catalog the planner never saw.

## 4. What is authoritative: one role-keyed set in one active container

The container remains one immutable aggregate with its **existing three
authority categories**. The economic category gains a second, versioned *shape*:

| Version | Key | Meaning |
|---|---|---|
| 1 | `economicPolicy` | historical singular policy, funding exactly its recorded role |
| 2 | `economicPolicies` | closed, role-keyed set funding one or more canonical roles |

Exactly one shape may appear. Declaring both refuses with
`governed_policy_economic_shape_ambiguous` rather than resolving to either.

**`economicPolicies` is not a fourth subdocument.** It is the version-2
representation of the economic authority category that `economicPolicy`
represents at version 1. `GOVERNED_SUBDOCUMENTS` still names exactly three
categories, and the suites assert that length.

Entry shape — the role is an explicit **key beside** the policy, so a policy
filed under one role while claiming another is a detectable contradiction:

```json
"economicPolicies": [
  { "role": "structured_planner",       "policy": { … } },
  { "role": "structured_leaf_executor", "policy": { … } }
]
```

### Invariants (`runtime/governed-policy-source.js`)

- at most one entry per canonical role; a duplicate refuses;
- unknown (non-canonical) role refuses;
- an entry whose embedded `policy.role` disagrees with its key refuses;
- an empty set refuses — a container funding no role cannot govern;
- each entry is built by the **existing** `buildEconomicPolicy` and keeps its own
  `policyHash`;
- ordering is canonicalized to `CANONICAL_ROLES`, so input order cannot change
  any hash;
- `economicPolicySetHash` binds the set version and every `(role, policyHash)`
  pair, so changing **either** role's policy changes it;
- every entry — not only the selected one — must cite the configured pricing
  catalog;
- a malformed sibling entry refuses the whole container, because the container is
  one aggregate.

### Role selection

`readGovernedPolicySource(container, { role })` returns the **shared** authority
(routing, pricing) plus the **selected** role's economic policy. There is no
first-entry rule, no default to the planner, and no inference from the caller's
model. A requested role the container does not fund fails closed with
`governed_policy_role_absent`.

**Role selection reads the container; it never changes it.**
`economicPolicySetHash`, `roleRoutingPolicyHash` and `pricingCatalogHash` are
identical for every role; only `economicPolicy` / `economicPolicyHash` differ.

## 5. Versioning and historical compatibility

`GOVERNED_POLICY_SOURCE_VERSION` is now `2`. `economicPolicySetVersion` records
which shape the container was actually read from.

A historical singular container remains readable **forever, for exactly the role
it recorded**. Reading it for any other role refuses — it never lends its one
policy to a second role. A version-1 single-entry set and a version-2
single-entry set hash **differently**, because the version participates in the
set hash; the two shapes are never conflated.

**No stored container is rewritten.** Existing rows stay exactly as they are.

## 6. Migration verdict

**VERSIONED BODY CHANGE — NO MIGRATION REQUIRED.**

Source proof: `model_routing_policies.body` is open `JSONB` with only
`CHECK (jsonb_typeof(body) = 'object')`
(`021_model_routing_policy_authority.sql`). The repository layer stores it via
`assertJsonRecord` and spreads it back on read; no column, constraint, generated
column or index references `governedExecution`, `economicPolicy` or any economic
field. The role-keyed set round-trips through the existing body unchanged, and
the Postgres suite asserts that round trip.

## 6b. Cross-role parent policy revision binding (2026-08-05, follow-up)

### Why selected role-policy hashes were insufficient

A planner authority captures `economicPolicyHash` for the planner; a leaf Run
captures `economicPolicyHash` for the worker. Together those prove:

> this exact worker policy funded this Run

They do **not** prove:

> the planner policy and the worker policy came from the same immutable active
> policy revision

An administrator can replace the active container between planning and leaf
admission with one whose **worker entry is byte-identical** and whose planner
entry differs. Every previously captured hash still matches, and the two roles
are now funded by two different revisions with nothing recording it. Shared
routing and pricing hashes narrow this but do not close it: they say nothing
about the sibling role's economics.

### The parent policy reference

```
{
  version: 1,
  policyContainerId,        // model_routing_policies row id
  policyContainerRevision,  // the row's enforced revision counter
  policyContainerHash,      // governed CONTENT identity
  economicPolicySetVersion,
  economicPolicySetHash
}
```

`policyContainerHash` covers governed content only — the shared routing and
pricing hashes plus the economic set identity. It deliberately excludes the row's
legacy sibling fields, which governed execution never reads. `policyContainerRevision`
is carried separately and does count every edit; the two answer different
questions and both are recorded.

A container read outside the loader has no row identity, and
`buildParentPolicyReference` **refuses** rather than inventing one. An authority
never claims a revision binding it cannot support.

### Envelope versioning

| Envelope | Versions | Version 2 adds |
|---|---|---|
| planning attempt `governedExecution` | 1, 2 | `parentPolicyReference` |
| `governedRunAuthority` | 1, 2 | `parentPolicyReference` |

Each version selects its own exact field list, and the hash payload iterates the
list its own version declares — so a version-1 envelope reproduces the identical
hash it was written with. Historical captures validate under their original
rules, are never rewritten, and are never silently upgraded. What a version-1
envelope may **not** do is claim cross-role revision parity: it never recorded the
identity that would establish it, and leaf admission refuses rather than
crediting it with one.

### Ordering enforced at leaf admission

```
planner reads container, captures parent reference
  → plan admitted under that revision
  → leaf admission reads the worker role, builds its own reference
  → the two must be EQUAL, field for field
  → leaf Runs commit (all, or none)
```

`assertSameParentPolicyRevision` compares every field: a partial match is a
mismatch, because the point is that one revision funded both roles. The refusal
happens **before** the store call, so no partial leaf Run can commit.

### Deliberate over-strictness, stated plainly

`policyContainerRevision` increments on **any** edit to the row, including edits
to legacy fields governed execution ignores (`maxCost`, `preferredModel`, …). So
editing a legacy field between planning and leaf admission **will refuse leaf
admission**, even though no governed authority changed.

That is deliberate. The alternative is deciding which edits "do not count", and
that inference is exactly how a real governance change slips through
unnoticed. The refusal is truthful, fails closed, and is recoverable by
re-planning. If it proves operationally costly, the fix is an explicit decision
to narrow the comparison — not a silent relaxation.

## 7. Capture and recovery behaviour

A captured governed leaf Run retains:

- the **parent** container identity — the shared `roleRoutingPolicyHash` and
  `pricingCatalogHash`, which are identical for every role read from that
  container; and
- the **exact selected** role identity — `economicPolicyHash`, which differs per
  role.

**RESOLVED (see §6b).** The limitation recorded below has been closed:
`economicPolicySetHash` is now carried inside `parentPolicyReference` on BOTH
version-2 authority envelopes, with version 1 kept readable under its original
rules rather than rewritten. The original reasoning is retained for the record.

~~**Deliberate limitation, recorded rather than hidden.** `economicPolicySetHash`
is bound at the policy-source contract layer and is **not** added to the
`governedRunAuthority` envelope.~~ Adding a field there would change
`GOVERNED_RUN_AUTHORITY_FIELDS` and the envelope hash, and
`normalizeGovernedRunAuthority` validates an exact field list — so every
historically captured Run would fail normalization. The standing constraint is
that historical Runs remain unchanged and are never rewritten. Parent identity is
therefore carried by the shared routing and pricing hashes, which already
distinguish containers, and the set-hash binding is proved at the reader.
Persisting the set hash in the Run envelope would require an explicit
`GOVERNED_RUN_AUTHORITY_VERSION` bump with a dual-version normalizer; that is a
separate, unapproved decision.

Recovery: the Postgres suite proves planner and leaf-executor authority survive a
**fresh connection and pool** byte-for-byte, that repeated selection is stable,
and that editing the current container changes current identity while leaving an
unedited sibling role's identity exactly as it was.

## 8. What remains forbidden

- no fourth policy-source subdocument;
- no second active policy container;
- no cross-role fallback, in either direction;
- no separate worker policy system;
- no reservation that crosses roles — the five-arm milestone asserts exactly two
  role accounts, one per canonical role.

## 9. Role-specific economic semantics

Planner and leaf-executor economics are stated **separately**, per role, even
where a bound is currently equal. The planner issues one bounded planning
request (`maximumProviderRequests: 1`); a leaf executor's work is iterative
(`maximumProviderRequests: 3`). Where values coincide they are still two
entries with two identities: **equality of values must never erase role
identity**, because reservations, accounts and settlements all bind the role.
The suite asserts that equal numeric bounds still produce two distinct
identities.

## 10. Proof

- `scripts/governed-role-economic-policy-set-test.js` — 35 assertions covering
  all sixteen required contract proofs plus failure classification.
- `scripts/governed-role-policy-container-postgres-test.js` — 20 assertions
  against real persistence, restart and container replacement.
- `scripts/structured-allocation-evaluation-runner-postgres-test.js` — 122
  assertions; family-1 arms B and C now admit and **execute** governed leaf Runs
  through the production loader, with role-correct reservations.
