# Model / Provider Routing

The current model/provider routing primitive is **dispatch policy + an immutable
per-run routing snapshot**. Routing decides
**which provider/model a run is recorded as dispatched to** — it does **not** change which provider
actually executes (the agent's own provider/model remains the backend), and it is not a provider
integration.

## Routing policy

Routing policies are accessed through one repository contract. The active JSON adapter persists the
current-format catalog in `data/model-routing-policies.json`; migration 021 supplies the PostgreSQL
authority. A record is:
`{ id, name, status(active|archived), workContextId, capabilityId, allowedProviders,
preferredProvider, preferredModel, fallbackProviders, maxCost, maxLatency, riskClass,
toolRequirements, targetRequirements, verificationRequirement, triageOnNoRoute, revision,
createdBy, createdAt, updatedBy, updatedAt }`. Incomplete old development records are rejected rather
than normalized or imported.

- **Empty `allowedProviders` means no restriction.** `preferredProvider`/`preferredModel` are hints.
- An **archived policy is never selected** for new runs.
- A policy **grants no authority**, **changes no target access**, and **creates no ticket/run** by
  itself. CRUD is inert.
- Management API (gated by `modelRouting:manage`): `GET/POST /api/model-routing-policies`,
  `POST /api/model-routing-policies/:id`, `GET /api/model-routing-policies/:id`; minimal UI at
  `/model-routing-policies` and `/model-routing-policies/:id`. Collection reads use bounded ID cursors;
  updates require the rendered/current revision and reject stale writes.

## Run routing snapshot

Every **new** run carries an immutable `run.routingSnapshot`:
`{ policyId, selectedProvider, selectedModel, reason, capabilityId, workContextId, fallbackUsed,
rejectedProviders, constraints, decidedAt }`.

- Current-format runs persist the snapshot at admission; run records predating that shape are reset rather than backfilled or imported.
- `selectedProvider` / `selectedModel` are the **agent's own** provider/model — execution is
  unchanged. The snapshot is **supporting metadata, not a new ledger**, and is never rewritten.

## Routing decision (deterministic)

`resolveModelRouteForRun` picks the most specific **active** policy in this order (ties → lowest id):
1. explicit policy id (`ticket.routingPolicyId`) if valid → `explicit_override`;
2. Work Context **+** capability match;
3. Work Context match;
4. capability match;
5. default (no Work Context, no capability) → `policy_preferred`;
6. none → `no_policy` (agent default).

It then validates the **agent's provider** against the policy:
- unrestricted, or provider in `allowedProviders` → `policy_preferred`;
- provider not allowed but explicitly listed in `fallbackProviders` → `fallback_allowed`
  (`fallbackUsed: true`) — **fallback only when explicitly allowed**;
- otherwise → **refusal**.

Routing **never calls a model API**, never evaluates provider quality dynamically, and never infers
hidden capabilities.

## Refusal / triage

If no provider is permitted, the run is **not created**; the ticket is **refused into triage**
using the existing triage vocabulary (`authority_blocked` / `change_scope`), with the
routing-specific signal in the summary, `evidenceRefs` (`model-routing:no_route`), a
`ticket.blocked` event (`reasonCode: no_model_route`), and a `ticket:no_model_route` log. There is
**no hidden fallback** and **no provider hopping**. When no policy applies, behavior is exactly as
before.

## Timeline

The decision is shown as a projection-only `run.routing` timeline entry (provider/model, policyId,
reason, fallbackUsed, rejectedProviders) **only for runs that carry a snapshot**. No new timeline
ledger; source precedence is unchanged; provider outputs are not stored in the routing entry.

## Boundaries

No provider integration changes, no external model API changes, no API keys, no connector behavior,
no watcher execution change, no authority widening, no target-provider behavior change, no
scheduler/scheduled-token change, no process-template/version/durability change, no handoff-protocol
change, no Work Context execution change, no verification/triage/auto-retry semantics change. Current
ticket/run/evidence records are not rewritten; no development-data importer or backfill is added.

> **Framing:** existing agent provider/model config remains the actual execution backend; routing
> only records and constrains the choice. Demo fixtures are test/demo only.
