# Run Decision Map

A live, read-only lane-graph visualization of a run's recorded evidence: what the model
proposed, what the runtime allowed, what actually executed, and how the run was verified.
Page: `/runs/:id/map` (linked from the run hero). API: `GET /api/runs/:id/decision-graph`.
CLI: `oquery run-graph <id>` (parity rule). Permission: `ticket:read`, same as the run page.

## Design principle: the truth hierarchy as swimlanes

Four fixed lanes, time flowing left→right by execution step:

| Lane | Layer (`docs/DIRECTION.md`) | Contents |
|---|---|---|
| MODEL | inference | provider requests; parsed plans with the model's message **verbatim** and its `complete` claim |
| AUTHORITY | guards | per-operation allow/block decisions with recorded refusal reasons; cap-dropped and unexecuted proposals; runtime events (limits, truncation, no-progress) |
| TARGET | facts | executed workspace/browser/workflow operations with outcome status (created/ok/noop/blocked/error) |
| OUTCOME | verified facts | verification result, terminal status + failure reason, triage state |

Reading a column top-to-bottom answers: what did the model *want*, what did the runtime
*decide*, what *happened*, and was it *verified*. The vertical gaps are the insight: a plan
action that never reaches the target lane is a cap-drop or guard block, rendered dashed/red as
a first-class node — the divergence between model intent and substrate reality made spatial.

## Honesty rules (binding)

- **Projection only.** `runtime/run-decision-graph.js` is pure: (run, snapshot, runEvents,
  operationHistory) → `{nodes, edges, cursor}`. It writes nothing and creates no ledger —
  same contract as the ticket timeline.
- **Evidence-linked edges only.** Linkage comes from recorded structure: plan `step` numbers,
  `historyId` → operation-history `step`, chronological array order for deterministic chains
  (workflow actions). No edge is drawn that the evidence does not assert; operations without
  recorded step linkage render unlinked rather than guessed into place.
- **Every node cites its evidence** (`evidenceRef`, e.g. `parsedModelPlans[2].actions[0]`) and
  carries a compact `detail`; full payloads stay on the run page — the map is a navigation
  layer over the evidence, not a rival summary.
- **Proposed-vs-executed divergence is first-class.** Mutating plan actions with no matching
  executed operation render as `cap_dropped` (when a truncation event exists for the run) or
  `unexecuted_proposal` (labeled "proposed; no recorded execution") — never smoothed over.
- **Model messages are verbatim** (the inbox authorship rule); the map shows the model's
  *stated* reasoning and its consequences, not internal cognition, and says so on the page.
- **No interpretation.** The engine must not infer intent, collapse "boring" steps, or add
  model-generated summaries. If labeled inference overlays are ever added they are a separate
  lane governed by `decision-memo-objective-interpretation-direction.md`.
- **Visibility only** — no controls on the map (the `/ops` rule).

## Live updates

Full-fetch with cursor gating, no delta protocol: the graph is bounded by run limits
(steps × actions), so refetching `GET /api/runs/:id/decision-graph` is cheap. The page
re-renders only when `cursor` (a digest of evidence-array counts + run status + triage
resolution) changes. While the run is `pending`/`running`, the page listens to the existing
`/api/events` SSE (`run:status-changed`) and polls every 3s as fallback; both stop at a
terminal cursor. Evidence arrays are append-only, so the picture only ever grows — matching
the immutability of what it renders.

## Rendering

Hand-rolled SVG, no dependencies (CSP is `default-src 'self'`; the graph is a comb, not a
general DAG — spine of steps, small per-step fan-outs, four fixed lanes; ~100 lines of layout
in `views/run-map.ejs`). Node click opens a detail panel with the compact fields and the
evidence reference. Model-lane nodes render dashed (inference); blocked/dropped nodes red;
outcome nodes carry the standard status palette.

## Tests

- `scripts/run-decision-graph-projection-test.js` — golden-fixture unit test of the pure
  module (checkpoint-registered): lane structure, verbatim messages, historyId step linkage,
  blocked/dropped first-class nodes, outcome chain, deterministic cursor, and the
  bare-run/no-invented-edges property.
- `operator-visibility-test` — page + API render, lane order, verbatim plan message,
  evidence citations, 404 path.
- `oquery-parity-test` — `run-graph` text and `--json` output.

## Future phases (not implemented)

- Replay scrubbing: a time cursor over the same projection for finished runs.
- Ticket-level map: chaining run graphs across attempts.
- Labeled inference overlays (memo-governed, separate lane, default off).
