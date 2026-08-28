## Execution-semantics provenance fixture shared Ticket-attempt authority (2026-08-17)

**Status: RESOLVED IN SOURCE — independent pre-semantics provenance cases now
use independent current singleton Ticket attempts.**

The canonical checkpoint at exact source `b9bc02b` stopped at owner 134,
`execution-semantics-persistence-test.js`, when its second `seedLegacyRun` call
asked the current low-level `createRun` seam to mint another singleton attempt
for a Ticket whose first pending singleton attempt remained unsettled. The
retained `TICKET_ATTEMPT_UNSETTLED` message printed the existing attempt's
status as `undefined` because Ticket attempts expose `disposition`, not
`status`; the row existed at ordinal 1 with one pending member and null
disposition/settlement.

History and source classify this as **A. STALE CURRENT-SEMANTICS FIXTURE**.
Commit `a1143e6` introduced the owner to prove immutable execution-semantics
snapshot persistence and two explicitly labelled fallback presentations for
Runs that predate the `runtimeLimitsSnapshot.semantics` field. It does not test
pre-039 rows, Ticket-attempt migration, retry, resume, or multi-Run grouping.
The two fallback rows are independent provenance cases—one with a recorded
runtime envelope and one with no recorded envelope—not one execution wave.

The corrected fixture retains the current `createRun` contract: one low-level
persistence/test call creates one kernel-owned singleton Ticket attempt. Each
provenance case now has its own fresh Ticket, singleton attempt, and immutable
Run identity with its persisted replay record. The original restart assertions
still falsify any loss of the recorded run-start semantics, substitution of
changed live defaults for recorded authority, or failure to label unrecorded
fallback values. No runtime, migration, admission, settlement, retry, resume,
or projection authority changed.

---

## PostgreSQL runtime-cutover capacity fixture used overlapping singleton attempts (2026-08-17)

**Status: RESOLVED IN SOURCE — the shared-runtime capacity contract is unchanged;
its fixture now uses one canonical atomic multi-Run Ticket attempt.**

The canonical checkpoint at exact source `c18c098b` stopped at owner 117,
`postgres-runtime-cutover-test.js`, when the owner called the low-level
`createRun` seam twice for one open Ticket. Before Ticket-attempt authority,
those two independently inserted pending Runs were convenient contenders for
the deployment-wide and local-provider concurrency checks. They were never a
JSON import, restart, recovery, retry, or migration-039 fixture.

Current `createRun` correctly mints a singleton attempt under the Ticket lock.
The first contender therefore leaves one pending member in an unsettled
attempt; the second call is a request for an overlapping new attempt and is
refused with `TICKET_ATTEMPT_UNSETTLED`. The generic transition-error formatter
prints that attempt as status `undefined` because a Ticket attempt exposes a
`disposition`, not a `status`; the retained error does not mean the row was
missing. Source reproduction found the exact row at ordinal 1, member count 1,
null disposition and null settlement, with its sole Run pending and no terminal
evidence.

History and source classify the failure as **A. STALE PRE-ATTEMPT TEST
FIXTURE**. The corrected fixture admits each pair of capacity contenders in one
atomic two-member attempt through `createRunsAndStartTicket`, then retains the
original cross-store claim, deployment-capacity, provider-capacity, automatic
reopening, and reset assertions. It neither weakens one-unsettled-attempt
authority nor changes retry, resume, recovery, settlement, or projection code.

---

## Ticket-attempt authority retires a pre-cutover evaluation timing class (2026-08-12)

**Status: RESOLVED IN SOURCE — current reachability follows exact Ticket-attempt
membership; frozen Tranche 6 decision evidence and scoring semantics are unchanged.**

The first canonical checkpoint after Ticket-attempt cutover stopped at owner 109,
`evaluation-live-artifact-domain-postgres-test.js`, because its controlled
`terminal_ticket_before_later_progress_block` class waited for a terminal parent
Ticket before releasing two held leaf responses. The retained checkpoint is
immutable at `.local-artifacts/release-checkpoint-results/`
`20260812T005441027Z-7e2aeba4-7251-4f7d-b434-5cfe4dabffde`.

Source and provider-free history reconstruction classify this as **A. STALE
CURRENT-PRODUCT TEMPORAL CLASS**. At exact pre-cutover source `39dd6ad2`, the
controlled slot `01-033-family-2_2A-C` admitted structured v2 Runs 65–67 under
plan 25. Run 67 terminalized failed at event position 2550; the topology-aware
projector set the parent Ticket failed at position 2552 while Runs 65 and 66
remained pending. Run 66 later persisted `run.progress_blocked` at position
2578, and the frozen latency reader correctly derived `withheldMs:1710` from
that block to Run 65's later authorized request. Commit `857d7c47` introduced
the class to prove that *if* this ordering occurred, the frozen block-to-next-
request latency metric stayed total. Neither the frozen protocol nor the test
made premature parent terminalization a required product behavior.

Current Ticket-attempt authority intentionally makes that ordering unreachable:
the three exact members share one immutable attempt, one failed member leaves
the attempt unsettled and the Ticket `in_progress`, and only the complete
terminal member set may produce the attempt disposition and Ticket projection.
The current runner proof therefore exercises the topology-neutral ordering:
one member terminalizes; the exact attempt remains unsettled with at least one
nonterminal member; a later member persists its progress block; all exact
members terminalize; the attempt settles; then the Ticket projects. The shared
metric-domain/scorer still accepts only defined nonnegative-or-null latency and
the frozen `withheldMs` derivation is unchanged.

This reconciliation changes no Ticket-attempt production code, LIVE manifest,
fixture-v2 bytes, completed REAL corpus/report, scoring rule, metric meaning, or
historical artifact. Git history remains the explicit compatibility boundary
for reproducing the old product lifecycle; current product execution cannot
acquire it.

---

## REAL LIVE-V3 still reaches an undefined five-metric candidate (2026-08-11)

**Status: RESOLVED IN SOURCE — the run remains permanently
`ABORTED — NOT DECISION EVIDENCE`; the authorized diagnostic was used only for
structural classification and never to patch, score, or resume that run.**

The newly authorized REAL LIVE-V3 run used exact executable source
`e3a4a23c4a4d84e38e553fa8e63c2ba3958627bd`, manifest hash
`18508f5a94cd3b7667037e77154f83e7327ed3ca368fe0c4d308e6aa0b9f245c`,
fixture-v2, and configured-agent ID 1 / revision 2 / provider `openai`. Its
immutable run-header hash is
`2965176eb1742f7e59678c7972a43f23c45d3483bdfbd76b53f7e096fe0e87ce`.

After 36 artifacts were accepted in frozen order, assigned slot
`01-037-family-5_5A-C` reached `product_terminal_or_stable` and the shared
candidate-domain owner returned `LIVE_SCORING_METRIC_EVIDENCE_MISSING` before
artifact acceptance. There were no infrastructure exclusions. Source freeze
therefore required whole-run abort; no scorer or production report was invoked.

Unlike the prior abort, diagnostic preservation succeeded. The mode-0600,
write-once record is labelled `DIAGNOSTIC — NOT ACCEPTED PRODUCT EVIDENCE`, has
file SHA-256
`5b32cc58c5b4673a330cfbf50d193295d37413549eb67ca50a3320b3e017030a`,
and internal record hash
`455289b93dfa9305159da3fd88b2a6c8d4aa8a505f0bbc3e61f94a3c0c10805e`.
It remains outside the corpus and exclusion domains. Its per-metric detail was
not interpreted under this authorization.

The later source-only authorization verified both hashes before reading the
complete diagnostic. Exactly one metric was undefined: latency, reason
`LIVE_LATENCY_INPUT_MISSING`, missing field `withheldMs`. The candidate was a
quiescent `product_blocked` Ticket with terminal Runs `completed, failed,
failed`, raw-state oracle pass, unavailable capture observation, false-negative
completion claim, four durable governed-worker responses, one persisted
progress block, no recovery/interruption, and otherwise defined allocation,
truthfulness, normalized-cost and churn inputs. Its projected `withheldMs` was
`-3556`.

This is **A. PROJECTION IMPLEMENTATION DEFECT**. Section 5.3 of the frozen
protocol already defines withheld time as persisted progress block to the next
authorized request, and the frozen metric table already defines null as the
unavailable/non-applicable duration. `deriveLatency` instead subtracted the
first terminal parent-Ticket event. Structured leaves settle independently, so
one leaf can terminalize the parent before a later sibling persists its progress
block; the parent status event is neither a request nor a valid interval end.
The corrected projection uses the earliest subsequent
`provider.request.persisted` or `ticket.economic_request_started`, otherwise
null, and refuses negative/invalid timestamp arithmetic.

The previous rehearsal varied broad terminal classes but not the cross-leaf
temporal order of parent Ticket terminalization, later sibling progress block,
and next-request existence. The replacement proof binds a source-owned
reachability registry to actual `runTrial` cases, expands every finite/nullable
metric input into meaningful equivalence classes, and independently forces the
parent-terminal-before-later-block class through PostgreSQL and the production
report path. Unknown future states still fail closed and persist their exact
metric reason before refusal. LIVE-V3 semantics and bytes are unchanged; v4 is
not required.

Persistent quarantine:
`.local-artifacts/structured-allocation-live-v3/real-e3a4a23-20260811-oXmXm0n7`;
abort-record SHA-256
`8ce2a7c4842be020adbaf1c8622c13940fdfc132a0965cde806172f66229c991`;
42-payload bundle hash
`210239917d6240ee1747763690a662de0d11063d4be4f707f0e281af473bc26b`;
structural partial-prefix hash
`1d823933c7240d8b6adb8a2ebf14bad342a0c2013192bcb452aa30c51bf36368`.
The permanent-abort registry enforces the identity at all three scoring doors.

---

## Tranche 6 LIVE-V3 metric-domain refusal loses the rejected shape (2026-08-10)

**Status: RESOLVED IN SOURCE — the authorized run remains permanently
`ABORTED — NOT DECISION EVIDENCE`; do not resume, score, import, adapt, or use
its prefix to tune a later experiment.**

The authorized REAL LIVE-V3 evaluation ran against exact trial source
`af4edb0beeb6ecd47ed7c018b6ebb836aaeeb404`, manifest hash
`18508f5a94cd3b7667037e77154f83e7327ed3ca368fe0c4d308e6aa0b9f245c`,
the repository-owned fixture-v2 authority, and configured-agent credential
authority ID 1 / revision 2 / provider `openai`. The one authenticated
preflight used the pinned `gpt-4o-mini-2024-07-18` Responses contract, used 20
input and 9 output tokens, and cost 9 micro-USD separately from experiment
evidence. The immutable real run-header hash is
`7297f3dd7d3ec98e563c1474a6163fc14d06612824091b7ac76838cfc364e47f`.

The first 66 assigned slots produced accepted artifacts in frozen order with
zero infrastructure exclusions, replacements, or reused slots. Assigned slot
67, `02-027-family-3_3A-C`, reached the product-terminal-or-stable boundary but
produced no accepted artifact. `runTrial` refused the candidate shape with the
source-owned `LIVE_SCORING_METRIC_EVIDENCE_MISSING` disposition: one or more of
allocation quality, truthfulness, latency, normalized cost, or churn lacked a
mechanically defined input. The live executor then correctly stopped because
that no-artifact outcome was product data rather than an infrastructure
exclusion.

The rejected candidate and its per-metric validity detail were not persisted,
and the isolated harness schema was truthfully removed during cleanup. The
terminal error therefore proves the shared metric-domain refusal but does not
retain enough evidence to identify which metric projection was absent. This is
the open diagnostic owner. It must be source-audited separately; the failed
trial must not be retransmitted to recover the missing detail.

The read-only corpus gate returned `LIVE CORPUS INCONSISTENT` and
`LIVE SCORING INPUT DOMAIN INCOMPLETE`: 120 assigned, 66 accounted artifacts,
0 exclusions, and 54 unaccounted slots. Its partial-prefix hash is
`1a60292dc0f8af02470202aefd7102db74e21e68f1f94ecd817ffc9749df1df9`.
The production report owner and scorer were not invoked. No five-arm metrics,
family metrics, hard-disqualifier state, ordinary LIVE decision, combined
decision, JSON/Markdown report, or report hash exists. Fixture-v2 remains
unchanged with conclusion **FIXTURE EVIDENCE SUPPORTS STOP**, but it was not
combined with this aborted prefix.

The ledger committed 9,928,494 micro-USD of maximum liability. The 66 retained
artifacts account for 286 metered requests (26 planner and 260 worker/leaf),
504,950 input and 23,557 output tokens, and an observable experiment-cost lower
bound of 90,115 micro-USD. Trial 67 retained no artifact/accounting projection,
so total actual experiment spend is **UNKNOWN**. The retained prefix's 90,115
micro-USD normalized cost is not actual billing and is not decision evidence.

Preserved evidence root:
`/tmp/ticket-system-structured-evaluation-live-v3/real-af4edb0-I2ZoAyEsG3A8`.
The abort-record hash is
`bc0a981f29bf0c83411dc3e826193a18a5b745f3a2a9e15428063f70f5e35619`;
the 71-payload-file aborted-bundle hash is
`780447943201f976c6406997d2a025ae523fe915cf1a082bcdeee4d632652098`.
The run-header identity is now in the permanent aborted-run quarantine owner.
Every historical aborted corpus remains unchanged and independently
quarantined.

The source-only audit classified the gap as **A. PROJECTION IMPLEMENTATION
DEFECT**, not a new metric-policy decision. The frozen contract already says:
unmetered provider-bearing requests use their captured authorized maximum;
unanswered requests are not churn windows; nullable latency is distinct from
zero; interrupted Runs return an owned Ticket to recoverable `open`; and raw
state and coupling oracles retain their separate completeness rules. The
implementation failed to materialize all of those existing facts at one shared
candidate boundary.

The correction makes `evaluation-live-artifact-domain` the shared five-metric
projection for runner acceptance, corpus integrity and production scoring. It
adds per-metric missing-field/reason detail, projects started/unsettled governed
requests at captured authorized maximum, retains transport-versus-response
counts without calling an unanswered request churn, and recognizes the exact
recoverable shape `Ticket open + all Runs interrupted`. Unknown future shapes
still fail with `LIVE_SCORING_METRIC_EVIDENCE_MISSING`.

Before that refusal is thrown, the REAL runner now writes a mode-0600,
write-once record under
`.local-artifacts/structured-allocation-live-diagnostics/<run-header-hash>/`.
It carries the candidate projection, oracle and observation states, every
metric's defined/missing reason and a reproducible record hash, and is labelled
`DIAGNOSTIC — NOT ACCEPTED PRODUCT EVIDENCE`. It is outside `trials/` and
`exclusions/`, satisfies no slot, and is never scored.

No LIVE-V3 metric semantic changed. `LIVE_ARTIFACT_DOMAIN_VERSION` remains 1;
the live-v3 manifest and fixture-v2 bytes therefore remain the historical
authority they already were. A future run header must bind the new executable
source commit, as it always does.

---

## TRANCHE 6 LIVE-V3 CORPUS ABORTED BY ACCEPTED/SCORABLE OBSERVATION CONTRADICTION (2026-08-09)

**Status: RESOLVED IN SOURCE 2026-08-09 — the run remains permanently
`ABORTED — NOT DECISION EVIDENCE`; do not resume, score, import, adapt, or use
it to tune a later experiment.**

The authorized REAL LIVE-V3 evaluation ran against exact executable source
`015f5ec04fab291e4f560b46887b2b9edabcd94e`, live-manifest v3 hash
`18508f5a94cd3b7667037e77154f83e7327ed3ca368fe0c4d308e6aa0b9f245c`,
repository-owned fixture-v2 authority, and configured-agent credential
authority ID 1 / revision 2 / provider `openai`. The one authenticated
preflight used the exact pinned model and controls, used 20 input and 9 output
tokens, and cost 9 micro-USD separately from the experiment.

All 120 assigned slots executed once and were accepted, with zero exclusions,
replacements, interruptions, resumes, or reused slots. The disk corpus gate
returned `LIVE CORPUS COMPLETE AND INTERNALLY CONSISTENT`; run-header hash
`ced9446747f0e98c11228e3732e9d704395df0d002ec08bbaada8abf9e88714f`
and pre-abort disk-corpus hash
`5f977c7ba47f330aff5dcd84f1661274c2a2417b9ed28b9857d726c547120097`
identify the preserved corpus.

The exact production report command then refused before aggregation with
`LIVE_SCORING_ORACLE_INCOMPLETE` at assigned trial identity
`01-001-family-2_2A-A`. The executor had accepted an artifact whose
`observationCompleteness` was not `complete`, while the artifact's oracle
verdict was not `refused`; the scorer's then-current blanket observation rule
refused that combination. Source authority establishes that the shared
fixture/capture observation sink is independent of a raw-state oracle, while a
coupling oracle may decide only from a complete access-observation stream. The
structural defect was the missing end-to-end contract between product-artifact
acceptance and that authority-sensitive scorer input domain. Provider-free
dress rehearsals exercised controlled terminal shapes but did not prove that
every legitimate product-failure artifact accepted by the REAL executor was
also a valid scorer input. This was a post-dispatch scoring-integration defect,
so source freeze forbids patching, retrying, or rescoring this corpus.

Future exact-source runs use one shared, versioned REAL artifact-domain owner
before artifact write/slot acceptance, at disk-corpus integrity, and at live
scoring. Raw-state pass/fail/refusal remains scorable when the fixture sink is
unavailable; coupling pass/fail requires complete access observation and
otherwise refuses before product-evidence acceptance. Frozen product timeouts
remain data but carry oracle refusal rather than a pre-quiescence guess. REAL
churn comes from the durable Ticket report, not the fixture-only sink. A
canonical runner/PostgreSQL regression now feeds non-ideal product outcomes
through the actual production report command, and release coverage owns the
closed artifact-domain gate. This resolution does not score or reinterpret the
preserved aborted run.

No five-arm or family metric, hard-disqualifier state, ordinary live decision,
final decision, or live report hash was produced. Fixture-v2 remains immutable
and **FIXTURE EVIDENCE SUPPORTS STOP**, but it was not combined with this
aborted corpus.

The ledger committed exactly 17,160,360 micro-USD, the v3 matrix maximum and
2,839,640 below the 20,000,000 micro-USD experiment ceiling. The preserved
structural economic record contains 488 canonical metered requests, including
48 planner and 440 worker/leaf requests, with 855,064 input and 39,392 output
tokens and observable metered experiment cost of 152,306 micro-USD. Including
preflight, observable provider cost was 152,315 micro-USD. Normalized cost has
the same numeric value because all canonical requests were metered, but it is
not actual-billing authority and the abort keeps it out of decision evidence.

Preserved evidence root:
`/tmp/ticket-system-structured-evaluation-live-v3/real-015f5ec-073f722193e157d0`.
The abort-record hash is
`39ff58a7208514cdf2666c525af5fa91d54a0be159e0bcab591a8d114afdcbf8`;
the 125-file aborted-bundle hash is
`35ee2e0c9bec4704e716de3557df4ab4d7a583ef2049e2a7adbc1424a559c61b`.
Every earlier aborted real corpus remains independently quarantined.

---

## TRANCHE 6 LIVE-V2 CORPUS ABORTED BY MISSING IMMUTABLE FIXTURE INPUT (2026-08-09)

**Status: RESOLVED IN SOURCE 2026-08-09 — the run remains permanently
`ABORTED — NOT DECISION EVIDENCE`; do not resume, score, import, adapt, or use
it to tune a later experiment.**

The authorized REAL LIVE-V2 evaluation ran against exact executable source
`bf7a932f8ea9b61087a189c51be1f383b8dc5960`, live-manifest v2 hash
`634963b5581a57449e0c45ffb7973f86a3ff0b6bd6b708d4fc06b9969c8c76b6`,
and configured-agent credential authority ID 1 / revision 2 / provider
`openai`. The minimum authenticated preflight used the exact frozen model and
request controls, made one provider call, used 20 input and 9 output tokens,
and cost 9 micro-USD. Its evidence remains separate from the experiment.

All 120 assigned slots executed once and were accepted with zero exclusions,
replacements, interruptions, or resumes. The canonical pre-abort corpus gate
returned `LIVE CORPUS COMPLETE AND INTERNALLY CONSISTENT`; its immutable
run-header hash is
`ad677632d187a791f885869f69dbd7232caab1d170ceb9fee7357f515871aed6`
and its pre-abort corpus hash is
`191e4aea91be4c825e27385f21bb6462c59b3b6570fe184bd7a81eb495138a68`.

Before aggregation, the repository-owned live report path exposed a missing
input authority. `scripts/structured-allocation-evaluation-report-live.js`
requires `--fixture-report <immutable-fixture-report.json>` and loads that
file at its scoring boundary. The original immutable fixture report artifact
is neither committed nor retained at the canonical fixture artifact root;
only its documented identities and conclusion remain. Constructing a new JSON
capsule that merely asserts those hashes would not be the original immutable
fixture evidence and would bypass the input-provenance contract. This is a
post-dispatch scoring-integration defect, so source freeze forbids patching the
path and scoring this corpus afterward.

The run was stopped before metric aggregation. No five-arm metrics, hard-
disqualifier states, live ordinary decision, final decision, or live report
hash was produced. The durable ledger committed the canonical 17,160,360
micro-USD matrix maximum, below the 20,000,000 micro-USD global ceiling by
2,839,640 micro-USD. The preserved structural cost record contains 500
production transport invocations and 500 canonical metered requests, including
48 planner and 452 worker/leaf requests. Observable metered experiment cost is
156,585 micro-USD; normalized cost has the same value because all canonical
requests were metered, but the abort keeps it out of product-decision evidence.

Preserved evidence root:
`/tmp/ticket-system-structured-evaluation-live-v2/real-bf7a932-06c13773d86978fa`.
The abort-record hash is
`1293528292ca56275316b6ad53891a2630b2b7748cb04f58db716ebac60d384e`;
the 125-file aborted-bundle hash is
`293cd76a5f77fb9a63356b646e3555664b951e560db45364408ce8baca13881b`.
Historical live-v1 manifests and every earlier aborted real corpus remain
unchanged.

The provenance gap is closed for future authorization by a new, versioned
authority rather than by recreating or summarizing fixture-v1. Fixture-v2 was
executed provider-free against source
`ca2cd188a6e10a41eb4bd36ee7eb10504b41978c`; the repository retains its
complete 200-trial corpus, journal, run header, scored JSON/Markdown, and a
registry that separately validates canonical identities and raw-file SHA-256
values under `evidence/structured-allocation-evaluation/fixture-v2/`. Its
manifest, run-header, corpus and canonical report identities are respectively
`3521079e6924abd2d546bad2a6a5bfda342b9d64f1578675af6a52a35a43d490`,
`0529783aac957828ec6f012d3131d681f7f5a986d67e2cf113bae324d6be4a2e`,
`be18c7e405efabedf135b5d88c46cbca207446093fc1fbbf60c25852b6769324`,
and `24b672e6946aab780eb0662bbaacbe698e66b36f9ec0dbe07c38b5448dd5df22`.
Its independently reproduced conclusion remains **FIXTURE EVIDENCE SUPPORTS
STOP**.

Live-v3 preserves the exact decision-evaluable v2 topology/economics but binds
the complete fixture-v2 registry and retained bytes. Its manifest hash is
`18508f5a94cd3b7667037e77154f83e7327ed3ca368fe0c4d308e6aa0b9f245c`.
The production live report command now resolves that authority itself; an
operator path or in-memory report-shaped capsule is insufficient. A mandatory
provider-free production-command rehearsal proves the whole post-corpus path,
and REAL preflight is gated on opening the same retained evidence. Live-v3 is
candidate authority only: no provider authorization or real corpus is implied
by this resolution.

---

## TRANCHE 6 REAL-LIVE CORPUS ABORTED BY MISSING LIVE SCORER ADAPTER (2026-08-08)

**Status: RESOLVED IN SOURCE 2026-08-08 — the run remains permanently
`ABORTED — NOT DECISION EVIDENCE`; do not resume, score, adapt, or import it.**

The newly authorized real-live evaluation ran against exact executable source
`fd5ff21602a221dd5e769b2afe9f967a35736e56`, canonical live-manifest hash
`792d228f939d597891da25bd4d779d76999940c2040e7e846afaf81fc35530b6`,
configured-agent credential authority ID 1 / revision 2 / provider `openai`,
and immutable run-header hash
`1cb2332d782b9478454d329dfd5ebd95e195acb6289ffd57b9e1255045d95022`.
The minimum authenticated preflight succeeded against the exact pinned model
and frozen Responses controls. It used 20 input and 9 output tokens and cost 9
micro-USD; it is separate from experiment evidence.

All 120 assigned slots executed once in frozen order and were accepted with
zero infrastructure exclusions, duplicates, replacements, interruptions, or
resumes. Before scoring, the canonical live corpus gate returned
`LIVE CORPUS COMPLETE AND INTERNALLY CONSISTENT`: 120 accounted for, 120
artifacts, zero failures, and pre-abort integrity hash
`930e288a4b1f438c7abb5278848e67f12ead982edcbb780c93584bd5810edc3b`.

The frozen scorer then failed before aggregation with
`Cannot read properties of undefined (reading 'length')`. The exact
contradiction is structural:

- the canonical live manifest enumerates assigned evidence as
  `manifest.slots`;
- `scripts/structured-allocation-evaluation-scorer.js:assertCorpusIntegrity`
  unconditionally reads `manifest.trials.length` and later iterates
  `manifest.trials`;
- the only repository-owned scored report command loads the fixture manifest
  and emits fixture-branded reports;
- no repository-owned live-manifest-to-scorer/report adapter exists.

Creating an ad-hoc manifest projection or changing scorer/report source after
real dispatch would violate the frozen-source contract. The run was therefore
stopped and permanently marked `ABORTED — NOT DECISION EVIDENCE`. No five-arm
metric table, hard-disqualifier state, live ordinary decision, report hash, or
final RETAIN / REVISE / STOP decision was produced. The pre-abort integrity
hash names preserved abort evidence; it is not a scoreable live result.

The durable ledger committed the canonical 18,140,952 micro-USD matrix maximum,
remaining below the absolute 20,000,000 micro-USD ceiling by 1,859,048
micro-USD. Durable evidence records 561 production transport invocations and
501 persisted responses. Of 501 normalized request records, 233 carry metered
usage (434,941 input and 17,950 output tokens) with an observable actual-cost
lower bound of 76,204 micro-USD; 268 use the authorized-maximum fallback, and
60 additional planner transport invocations are outside the normalized request
projection. Total actual experiment spend is therefore **UNKNOWN**. The
727,176 micro-USD normalized scoring cost and 18,140,952 micro-USD committed
liability are not actual billing.

Preserved read-only evidence root:
`/tmp/ticket-system-structured-evaluation-live/real-fd5ff216-qqJwYxWD`.
Its 125-file abort bundle hash is
`5d8d7d243df9b83f1ba986881548a1a22aa09a4c2040138d3989616225d2c343`;
the abort-record hash is
`77b040bbae0924a9bb379d825456adfcfb1617333cacc6740e9fa2b74a252e86`.

The repository now owns an explicit, validated live-slot scoring projection,
a REAL-live scorer/report path, planner-inclusive normalized economics, the
family-scoped hard-disqualifier rules, and the complete frozen ordinary
decision contract. A deterministic provider-free dress rehearsal traverses
all five metrics, all hard disqualifiers, fixture/live combination, and
immutable JSON/Markdown reporting before a paid dispatch can be authorized.
The correction still requires exact-source release proof and an entirely fresh
live authorization. This 120-artifact run may never be retrofitted into product
decision evidence. The immutable fixture conclusion remains **FIXTURE EVIDENCE
SUPPORTS STOP**, and the earlier historical aborted run
`b2b59ad2b9d9fafc8ac860838b0530cb8f90bc02907b36a3a230b560bece2eef`
is unchanged.

---

## TRANCHE 6 REAL-LIVE CORPUS ABORTED BY REPORT ZERO-DRIFT VIOLATION (2026-08-08)

**Status: OPEN — exact causal owner not yet diagnosed. The run is permanently
`ABORTED — NOT DECISION EVIDENCE`; do not resume, score, or import it.**

The newly authorized real-live evaluation started from exact source
`e5dcbcad89728f5281efda0851ccfd29a9c7fdfa`, live-manifest hash
`792d228f939d597891da25bd4d779d76999940c2040e7e846afaf81fc35530b6`,
and immutable run-header hash
`986249cebdf2239c93b37ed7340aedbebbb85df5e134f4f848264dd5c1916359`.
The minimum authenticated preflight succeeded against the exact pinned model and
frozen Responses controls. It used 17 input and 9 output tokens and cost 9
micro-USD; it is recorded separately from experiment evidence.

After 86 accepted live artifacts, the 87th started trial,
`03-007-family-7_7A-B`, reached the product-terminal-or-stable boundary but
produced no artifact. Two nominally read-only report collections were unequal,
so the zero-drift guard in
`scripts/structured-allocation-evaluation-runner.js` refused the trial with
`the read-only report changed durable state`. The live executor then correctly
refused a no-artifact outcome that was not classified as an infrastructure
exclusion. This is a harness/executor integrity defect discovered after provider
dispatch, so the source-freeze contract required an immediate permanent abort.
No source correction and no resume occurred.

The canonical corpus audit reports `LIVE CORPUS INCONSISTENT`: 120 assigned, 86
accounted for, 86 artifacts, 0 exclusions, and 34
`SLOT_NOT_ACCOUNTED_FOR` failures. The scorer door returns
`LIVE_CORPUS_INCONSISTENT`; no five-metric arm scores, hard-disqualifier result,
live corpus hash, or final RETAIN/REVISE/STOP decision exists.

The append-only economic ledger contains 87 committed reservations totaling
13,197,134 micro-USD, leaving 6,802,866 micro-USD below the absolute 20,000,000
micro-USD ceiling. Actual matrix provider spend is **UNKNOWN** because the
failed trial retained no token usage and the accepted artifacts mark provider
requests unmetered. The 629,111 micro-USD normalized cost and the 67,638
micro-USD governed durable-settlement lower bound are not substitutes for
actual spend.

Preserved evidence root:
`/tmp/ticket-system-structured-evaluation-live/real-e5dcbca-8csZai5w`.
Its read-only aborted-bundle manifest covers 91 files and has bundle hash
`741f11356b8e2b490af3398e97e232f4bbc8df921a213b4296d104da9779a74d`.
The abort record hash is
`cabd732b3227219cd5e61eb9bb09aed57e0e3d33a6786bac9bac8cb5daeae056`.

The unresolved question is why the second report collection changed durable
state after the canonical stable/quiescent boundary. That owner must be
diagnosed and corrected under a separate authorization, followed by a new
exact-source proof and an entirely new live run. The 86-artifact prefix must
never be used as product evidence. The earlier historical aborted run
`b2b59ad2b9d9fafc8ac860838b0530cb8f90bc02907b36a3a230b560bece2eef`
is unchanged and remains independently unscorable.

---

## LOAD-SENSITIVE CONCURRENCY LIVENESS OBSERVATION (2026-08-07)

**Status: OPEN — not attributed to the Tranche-6 live-evaluation diff, and not
dismissed. Worth separate investigation.**

The first complete release checkpoint against commit `a9f8c0ca` **failed** at
the concurrency-conflict suite:

```
permitted cross-ticket delete: NOT_PROVEN — owner run did not complete (null)
FAIL: concurrency conflict — 16 scenarios, 1 hard failure(s),
      0 observed-unsafe, 1 not-proven (PostgreSQL-native)
```

Liveness diagnostics captured at the failure:

- the owner Run's **lease expired**;
- **recovery claimed** it (`run.recovery_claimed`);
- it then reached **`budget.exhausted`**, twice, and never completed;
- the scheduler was running, one active Run, one expired lease;
- health additionally reported `PROCESS_RELEASE_CONTRACT_INVALID`
  (`processExecutionRelease.state = blocked`).

### Why it is not presently attributed to the live-evaluation work

- the diff between the previously passing 209/209 checkpoint (`c5449e3c`) and
  `a9f8c0ca` touches **only** the live-evaluation harness: the live manifest
  config, `evaluation-live-*` fixtures and two of their tests. **No production
  source, no runtime, no scheduler, no store;**
- the concurrency-conflict suite **loads none of those files**;
- run **in isolation the suite passed 16/16**, with 0 hard failures and 0
  not-proven;
- a **second complete checkpoint against the identical source passed 209/209**.

### Why it is still recorded

The failure was observed on a machine that had been running heavy PostgreSQL
suites back to back for hours. That is a plausible explanation, but "the machine
was busy" is a description of the conditions, **not a diagnosis**. A scheduler
liveness path where a lease expires, recovery claims the Run and the Run then
exhausts its budget instead of completing is a real product-behaviour question
under sustained load, and calling it environmental noise would be a conclusion
the evidence does not support.

Deliberately **not** labelled flaky-and-ignorable. What is not yet known: whether
the lease expiry is the cause or a symptom, whether the budget exhaustion is
correct behaviour for a recovery-claimed Run, and whether
`PROCESS_RELEASE_CONTRACT_INVALID` is incidental to this environment or
contributory.

No production behaviour was changed in response, and none should be until the
question above is answered on an idle machine.

---

## LIVE READINESS AUDIT FINDINGS — CLOSED (2026-08-06)

The eight-audit repeat blocked live readiness on three proven defects: the
governed leaf executor had no captured outbound request; ungoverned requests
carried no output cap while being priced as if they did; and the ledger reserved
one request's liability for a whole trial. All three are closed and proved
without a network — see `docs/STRUCTURED_ALLOCATION_CONTROLLED_EVALUATION.md`
§3p. Recomputed worst case at the time 18,140,774.4 of 20,000,000 micro-USD —
**superseded**; the canonical integer authority is 18,140,952, see §3q and the
entry immediately below. $0.00 spent.

---

## LIVE RUN HALTED BEFORE TRIAL 1 — NO DISPATCH PATH, SAMPLING NOT WIRED (2026-08-06)

**Status: CLOSED 2026-08-06 by the corrections below. $0.00 was ever spent.**

**RESOLUTION.** All five prerequisites listed at the end of this entry are built
and proved without touching a network:

1. **live trial path** — `runTrial({ mode: 'live' })` spawns the server without
   the hermetic preload, without the fixture namespace and without any staged
   response table, preserving governed role authority, economics, quiescence,
   oracle, zero-drift and immutable artifacts;
2. **sampling threaded** — `runtime/provider-sampling-authority.js` is the single
   canonical reader, consulted by the governed planner, the governed leaf and
   the ungoverned worker. `buildOpenAiResponsesBody` takes `sampling` as an
   explicit input with **no default**, so fixture bodies stay byte-identical and
   a malformed live value throws instead of silently defaulting;
3. **global budget enforced at dispatch** —
   `scripts/fixtures/evaluation-live-budget-ledger.js` commits a trial's entire
   authorized worst case to an fsynced append-only ledger *before* the process
   that could reach the provider is spawned. Release requires the proof
   `pre_delivery_refusal_no_provider_contact`; ambiguous delivery is never
   released;
4. **readiness items that fail when 1 or 2 is missing** — eight mandatory facts,
   read from source and manifest rather than declared;
5. **single-trial validation before the corpus** — the authorized live run must
   still begin with one trial; that rule is unchanged and remains a term of any
   new authorization.

Proved by `scripts/structured-allocation-live-dispatch-postgres-test.js` (29
assertions, 2 outbound requests captured at the replaced final hop, **external
provider calls: 0**) and `scripts/evaluation-live-budget-test.js` (33
assertions). Full narrative:
`docs/STRUCTURED_ALLOCATION_CONTROLLED_EVALUATION.md` §3o.

**The authorization bound to commit `78e4158d…` EXPIRED UNUSED.** It does not
carry over. A new authorization must name the corrected commit.

The original finding is preserved below unedited, because a readiness verdict
that was wrong once is the reason the audit now has items that can fail.

---

**Original finding (2026-08-06). Status at the time: OPEN. No money was spent.**

Execution of the frozen 120-trial live matrix was explicitly authorized up to
$20.00 against commit `78e4158d…` and manifest
`9cbb38e5d9e6f665b8025efb08fe135e25ee86810e4953e704e9451dd621c43a`. Both were
verified correct at the opening gate: hash matches, 40 cells / 3 repetitions /
120 slots, worst case 15 934 464 <= 20 000 000 micro-USD, all focused gates
green, credential present.

The run was **halted before trial 1** on two source-proven contradictions.

### 1. No live dispatch path exists

- `executeScoredRun` **refuses** any manifest whose mode is `live`;
- `preflightLiveRun` stops at `provider_dispatch` **by design** — it is a dry
  run and contains no transport;
- `runTrial` begins `assertMode('fixture')` and always loads the hermetic
  preload, which guarantees zero network;
- the runner's own CLI refuses `--mode live` outright.

Nothing in the repository can issue a scored live provider request.

### 2. The frozen sampling reaches no production request

`buildOpenAiResponsesBody` accepts a `sampling` option, but **no caller passes
it** — not the planner (`structured-planner-governance.js:150`), not the
governed leaf (`server.js:12184`), not the ungoverned worker
(`server.js:17755`). A planner body today serializes exactly:

```
model, input, text, max_output_tokens, truncation
```

with `temperature` and `top_p` absent, so every live request would inherit
provider defaults. The authorization names `temperature: 0` and `top_p: 1` as
frozen parameters, so a run today would violate its own terms while appearing
to succeed.

### Why this was not caught

The previous session certified **TRANCHE 6 LIVE-MODEL EVALUATION READY**. That
verdict verified the manifest, classifier, evidence contract, economic cap and a
dry run that "stopped before dispatch" — and never verified that a dispatch path
existed beyond that stop, nor that sampling reached a real request. The
readiness audit had no item for either. **The READY verdict was overstated**, and
the audit is the thing that must change: readiness may not be claimed again
without an item that fails when no live transport exists.

### What must be built before the authorization can be honoured

1. a live trial path that spawns the server **without** the hermetic preload and
   with real credentials, preserving governed role authority, economics,
   quiescence, oracle, zero-drift and immutable artifacts;
2. sampling threaded into all three request builders so `temperature 0` /
   `top_p 1` appear in the canonical body of every planner and worker request;
3. per-dispatch global budget enforcement against the $20 ceiling;
4. readiness items that fail when either 1 or 2 is missing;
5. at minimum one **single-trial** live validation before committing the full
   120, so an executor defect costs one trial rather than an aborted corpus.

Building an unproven executor and immediately spending the full authorization
would risk exactly the outcome the freeze rule exists to prevent: a defect found
after trial 1 aborts the corpus, and the money is gone.

---

## LIVE-MODEL EVALUATION PHASE IS NOT FROZEN (2026-08-06)

**Status: RESOLVED 2026-08-06.** All eight decisions were approved before any
live result existed and are now encoded and derived from
`config/structured-allocation-evaluation-live-v1.json` (hash `9cbb38e5d9e6f665b8025efb08fe135e25ee86810e4953e704e9451dd621c43a`): 40 derived
cells x 3 repetitions = 120 slots; temperature 0 / top_p 1 for every role; no
provider seed (source-proven absent from the production Responses body); a hard
20 000 000 micro-USD cap against a recomputed 15 927 620 micro-USD worst case;
the three-class failure predicate; outage/resume preservation; the fixture veto
and reversal contract; and a MANDATORY live phase.

Verdict: **TRANCHE 6 LIVE-MODEL EVALUATION READY**. No provider call was made.
The original problem statement is retained below.

---

**Original status (now resolved): OPEN. Eight product decisions block any live
run.**

The fixture matrix executed and its evidence is immutable. The LIVE phase is
not frozen, and eight values that shape it — or authorize money — are absent:

1. live matrix membership (scenarios / variants / arms);
2. sampling parameters (temperature, top-p or equivalent);
3. provider seed support and values;
4. **live economic ceiling** — no monetary authorization exists;
5. provider failure classification (429, 5xx, network, timeout, malformed
   response, model refusal, context-length rejection, auth failure) as PRODUCT
   DATA versus INFRASTRUCTURE-ONLY EXCLUSION;
6. rate-limit, outage and resume handling;
7. how fixture and live evidence combine into a final decision, whether a
   fixture disqualifier can independently STOP, and the exact condition under
   which live evidence could reverse a fixture STOP;
8. **whether the live phase is mandatory at all** — the evaluation document
   calls live confirmation optional (§10.7) while the scorer emits
   `REQUIRES LIVE-MODEL MATRIX` for fixture-mode reports. Both cannot be
   authoritative.

None was chosen during the audit. Choosing a sampling parameter or a spend
ceiling to let execution proceed would be inventing product authority, and
inheriting silence as permission would be spending money nobody approved.

Worst-case liability, calculated from the frozen bound method so an
authorization can be judged: 0.0204 USD per request; 0.061 USD per direct or
legacy trial; 0.204 USD per structured trial; 15.93 USD if the live matrix
mirrored the fixture cells at the frozen 3 repetitions. This authorizes nothing.

Enforced by `scripts/fixtures/evaluation-live-readiness.js`
(`assertLiveExecutionPermitted`) and proved by
`scripts/evaluation-live-readiness-test.js`.

---

## TIMELINE DETERMINISM ASSERTION IS LOAD-SENSITIVE (2026-08-06)

**Status: OPEN. Pre-existing; not caused by the evaluation work.**

`timeline-authority-evidence-test.js` §4 asserts that projecting the same
timeline twice yields identical entries in identical order. It failed once
inside a full release checkpoint and passes reliably in isolation (3/3
immediately afterwards). The suite is untouched by this branch — no commit
since `master` modifies it.

**Mechanism.** The assertion is made against a Ticket whose Run has FAILED, but
the suite does not first establish that the Ticket is quiescent. Under checkpoint
concurrency, background terminalization and consequence writing can still be in
flight, so the second projection legitimately contains an entry the first did
not. The projection is deterministic *given stable state*; the suite asserts
determinism without establishing stable state.

So this is a test-design weakness, not a product non-determinism defect: nothing
here shows the projection reordering or rewriting anything.

**Fix:** wait for canonical quiescence — the same contract the evaluation harness
uses — before the second projection, so the assertion compares two reads of a
settled Ticket.

Recorded rather than resolved by re-running: a later pass does not explain a
failure, and the explanation is what makes the definitive checkpoint meaningful.

---

## AGGREGATE RECONCILIATION WAS INFERRED, NOT OBSERVED (2026-08-06)

**Status: RESOLVED 2026-08-06.**

`aggregateReconciliationObserved` derived its value from the Ticket's status: a
settled status was read as "the aggregate reconciler ran". That is a stronger
historical claim than the evidence supported, and completion truthfulness is an
authorized Tranche-6 metric, so the overstatement would have corrupted the thing
being measured.

A durable authority already existed — `ticket.allocation_leaf_items_reconciled`,
journalled in the same transaction as the aggregate write. The field is now
bound to it, and the inferred fact is retained under its own name
(`aggregateSettled`) beside the exact `ticketResultStatus`. Terminal Run status
and quiescence can no longer set the reconciliation field, and the direct and
legacy arms assert the divergent case directly.

---

## GOVERNED WORKER RESPONSES ARE NOT STAGED FOR THE GOVERNED TRANSPORT (2026-08-06)

**Status: RESOLVED 2026-08-06.** Every staged response — planner and worker,
with its match string, role, ordinal and failure boundary — is written to the
governed staged table from the same materialized set the ungoverned fixture
uses. All forty required cells execute, and both previously surviving
governed-transport mutations are now reachable. Retained as the record of why a
refusal for want of staging may never be credited as a declared boundary.

Only PLANNER responses are written to `HERMETIC_TRANSPORT_RESPONSE`. Families 7
and 8 inject their boundaries on the WORKER request, so on the structured arms
the governed transport refuses for want of a staged worker response — which is
`refused_before_transport`, not the `bytes_sent` boundary the variant declares.
Recording it as the declared boundary would credit a variant with a boundary it
never reached.

**Fix:** write worker responses, with their failure boundaries, into the governed
staged table from the same materialized set the ungoverned fetch fixture uses.

**Second, related symptom, measured rather than inferred.** On families 3, 4 and
9 the structured arms (B, C) make ZERO provider requests: the plan is refused
before any governed request is issued. So the governed transport is not
exercised by any currently required cell, and two focused mutations survive as a
direct consequence:

- removing the governed transport's durable-response observation;
- making an unexpected governed request record success instead of a refusal.

Both are real coverage gaps and neither was papered over. They cannot be closed
by a better assertion — nothing currently drives a governed request to
completion in these scenarios — so they close when the governed worker staging
above is fixed and the structured arms reach the transport. The equivalent
UNGOVERNED mutations are killed today, which is what shows the sink itself
reports correctly.

This is a STAGING gap, not an observation gap. The shared observation sink is
proved working by families 3 and 4, which execute with complete observation and
record actual consumer reads.

---

## EVALUATION FIXTURE OBSERVATION DOES NOT REACH THE SPAWNED SERVER (2026-08-06)

**Status: RESOLVED 2026-08-06 by the shared observation sink
(`scripts/fixtures/evaluation-observation-sink.js`). Retained as the record of
what was wrong and why an empty stream may never be read as a negative
finding — a rule the sink now enforces through its completeness contract.**

Scenario families 3, 4, 7 and 8 depend on fixture-owned external observation:
the consumer access log (coupling) and the served-call transcript (churn and
recovery). Neither reaches a spawned server.

The governed path is served by `hermetic-governed-transport-preload`, which
carries its own staged-response mechanism and writes `governed-capture.jsonl`.
It never writes the evaluation namespace's `transcript.jsonl` or
`access-log.jsonl`. Every namespace produced by a real-server trial therefore
has an empty transcript and no access log at all.

**Why this cannot be worked around by reading the empty file.** A coupling
verdict computed from an empty access log says "the consumer demonstrably did
not read the producer" when the truth is "the observer never ran" — an inverted
finding, not a weak one. A zero served-call count would likewise report a
pre-transport refusal or an undelivered response when no transport was observed.

**Fix:** derive the read observation and the transport facts from the channel the
spawned server actually writes (`governed-capture.jsonl` for governed arms), or
route the governed preload through the shared evaluation namespace.

Recorded in `scripts/fixtures/evaluation-execution-matrix.js` as
`OBSERVATION_BLOCKED`, and pinned by `structured-allocation-evaluation-test.js`
so the pin fails when the channel is connected.

---

## GOVERNED POLICY CONTAINER FUNDS ONE ROLE — RESOLVED (2026-08-05)

**Status: CLOSED. Approved and implemented — see
`docs/GOVERNED_ROLE_ECONOMIC_POLICY_SET_DECISION.md`.**

The approved resolution keeps exactly ONE active governed container and changes
its economic authority from a singular role policy into a closed, role-keyed set
(`economicPolicies`, version 2), so one immutable container funds both
`structured_planner` and `structured_leaf_executor`. No fourth subdocument, no
second active container, no cross-role fallback, no separate worker policy
system, and no migration — `model_routing_policies.body` is open JSONB.

Family-1 arms B and C now admit AND execute governed leaf Runs through the
production loader with role-correct reservations.

**Follow-up also CLOSED (2026-08-05):** the parent policy container revision and
economic-set identity are now durably bound to both the planner authority and
every governed leaf Run (`parentPolicyReference`, authority envelope version 2).
Leaf admission refuses when the active container changed after the plan was
admitted. See §6b of the decision record.

The original problem statement is retained below as the record of what was wrong.

---

**Original status (now resolved): OPEN. Newly exposed once the leaf-capture
wiring was corrected.**

With `governedLeafCapture` supplied and the false-conflict classification fixed,
structured leaf admission now refuses **truthfully** with
`leaf_governed_authority_unavailable` instead of a fabricated concurrency race.
The remaining cause is a configuration-model gap, not a wiring omission:

* `runtime/governed-policy-source.js` refuses unless `economicPolicy.role`
  equals the requested role — **one container funds exactly one role**, and its
  comment explains why: "a routing policy that authorizes a role the economic
  policy does not fund would reach the point of reservation and refuse there";
* `server.js loadGovernedPlannerPolicyContainer` refuses when more than one
  active governed policy exists (`GOVERNED_PLANNER_POLICY_AMBIGUOUS`).

**Therefore a deployment cannot fund both `structured_planner` and
`structured_leaf_executor` at the same time.** The planner needs one container;
governed leaf execution needs another; only one may be active.

Test fixtures never hit this because `seedGovernedStructuredTicket` passes a
worker-role `policySource` straight to the store, bypassing the loader
entirely — the same reason the missing-capture defect survived the release
checkpoint.

### Candidate resolutions, for whoever authorizes one

1. **Role-keyed economic policies in one container** — replace the single
   `economicPolicy` with a per-role map, keeping the "both documents must
   govern the role" rule intact. Smallest change; touches a closed contract.
2. **Role-scoped container selection** — permit one active governed policy *per
   role* and select by role instead of requiring a single global one. Changes
   the ambiguity rule, which exists to stop two policies silently competing.
3. **A distinct worker-role loader** reading a separately designated container.
   Most explicit, largest surface.

Option 1 looks smallest, but the choice is a product decision about how
governed economics is configured and is deliberately not made here.

**Tranche 6 remains blocked on this**: structured leaf Runs cannot be admitted
until a deployment can fund the leaf-executor role.

---

## STRUCTURED LEAF PROGRESS POLICY AUTHORITY — OPTION B ACCEPTED, VALUES REQUIRED (2026-08-06)

**Status: Option B accepted. Implementation BLOCKED on five undecided numbers.**

**Phase 1 scope verdict: ALL LEAVES SHARE ONE POLICY-RELEVANT EXECUTION
SNAPSHOT**, proved from source — `buildRuntimeBudgetSnapshot` takes only the
Ticket's runtime limits and execution policy, and neither the assigned agent nor
the allocation item participates. One canonical capture per plan admission is
therefore correct. Runtime equality must still be verified across drafts rather
than assumed, because `resolveAgentRuntimeLimits` re-reads current configuration
per draft.

**BLOCKED: the five churn tolerance values were never decided.** The decision
memo fixed the duration derivation and `resourceDimensions` but stated the
tolerances only as "declared explicitly in the contract". The implementing brief
forbids inventing them, so implementation stopped rather than choosing silently
— each value changes when a Run stops and therefore what it spends. A
recommended set is proposed in the memo §6b for approval: the values the test
fixture has used throughout Tranches 4-5, which keeps existing governed suite
behaviour unchanged. The fixture's duration value is explicitly NOT adopted; it
is a harness convenience, not product authority.

**Original status, retained:**

**Status: DECISION REQUIRED. Not closed, not implemented.**

Full memo: `docs/STRUCTURED_LEAF_PROGRESS_POLICY_AUTHORITY_DECISION.md`.

Structured leaf admission is blocked because `governedLeafCapture` requires a
`progressControlPolicy` and production has no source for one. The previous
session framed the owners too narrowly; this audit corrects that.

**The earlier claim that only three owners existed was wrong.** A fourth exists
and is preferred: a repository-owned, versioned policy captured with the Run
through the execution-policy authority that already travels with it.

**Field audit.** Of the seven progress-policy fields, exactly one has existing
authority — `maximumCumulativeExecutionDurationMs` maps to
`runtimeBudgetSnapshot.maxRuntimeDurationMs`, a required positive integer on an
immutable, hashed, Run-scoped snapshot that is already present on every leaf
draft. One (`resourceDimensions`) is a repository-owned choice from a closed
vocabulary. **Five are genuine product decisions with no existing home**, and
deriving them from request or step limits would be fabrication: "how many
requests may this Run make" and "how many wasted windows may it burn" are
different questions.

**Recommendation: Option B with Option A for duration.** Progress control is a
versioned runtime execution policy captured with the Run — not a model claim,
and not part of provider-routing or economic policy. No operator surface, no
migration (`runs.body` already carries every comparable snapshot), historical
Runs unaffected, evolution by explicit version bump.

**Rejected:** Option A alone (insufficient — five fields unfilled); Option C
(configurability without demonstrated need, though Option B does not preclude
it); Option D (the policy-source container states a fourth subdocument is a
configuration error, and routing/economics answer a different question than
termination); Option E (restores ungoverned leaf admission and forfeits the
Tranche 5 block-hash binding, replayable churn decisions and the A3 duration
bound).

A **separate** correction is specified for truthful failure classification —
real conflict, known authority failure, unexpected internal failure — and must
not be bundled with the capture wiring merely because both touch one catch
block.

**Tranche 6 remains blocked until this decision is taken and implemented.**

---

## PRODUCTION DEFECT — structured leaf admission is unreachable (2026-08-06)

**Status: OPEN. NOT a wiring omission. It cannot be corrected without a product
decision, and the correction was therefore not attempted.**

### Phase 1 verdict (2026-08-06, second audit)

**NEITHER of the offered verdicts is right.** Not "server omitted an
already-captured governed authority", and not "server must derive the capture
from the admitted policy snapshot" — because **no such authority exists to
capture or derive from.**

Supplying `governedLeafCapture` requires `{ policySource, progressControlPolicy }`.
The policy source could be read the same way the planner's already is. The
progress-control policy cannot, and three independent facts establish that:

1. **`buildProgressControlPolicy` has no production caller.** Its only callers
   are the contract that defines it, its own contract test, and
   `scripts/governed-structured-fixture.js`. Production never builds one.
2. **The governed policy container cannot carry one.**
   `runtime/governed-policy-source.js` admits exactly three subdocuments —
   `roleRoutingPolicy`, `economicPolicy`, `pricingCatalog` — and its own comment
   states that "a fourth is a configuration error, not an extension point."
3. **No migration defines a durable progress-control policy.** There is no
   configuration surface, operator or otherwise, from which one could be read.

So structured leaf admission is unreachable **by construction**. Only test
fixtures have ever supplied the capture the store requires.

### Why the correction was not made

The brief instructed: *"Do not invent policySource or progress-control values
merely to satisfy the store."* Any wiring change would have to invent a
progress-control policy — choosing churn tolerances, duration bounds and
resource dimensions that no operator granted — and bind it as immutable
governance authority to every structured Run. That is a product decision about
where governed progress policy lives and who sets it, not a bounded correction,
and inventing a default would be exactly the "silent reinterpretation" the
policy-source contract exists to prevent.

**The failure-classification correction was also deferred**, because it is only
reachable through the same code path and shipping it alone would produce a
production change requiring the full checkpoint and mutation gate while leaving
the substantive defect open.

### The smallest correct fix, for whoever authorizes it

One of:

* extend the governed policy source to a fourth subdocument carrying the
  progress-control policy, accepting that this reverses an explicit contract
  decision; or
* add a separate durable progress-policy configuration surface with its own
  migration, admission and immutability rules, read at leaf admission; or
* decide that governed leaf execution requires no progress control and relax
  the store's requirement — which would reopen the Tranche 5 verified-progress
  guarantees and should not be done casually.

All three are architecture decisions. None belongs in an evaluation branch.

### Original entry, retained

**Status: OPEN. Not repaired here — it needs its own authorization.**

**Every structured Allocation Plan v2 that reaches leaf admission is refused,
and the refusal is mislabelled as a concurrency loss.** The structured execution
path cannot admit governed leaf Runs at all.

### The raw exception, captured below the catch-all

```
code     GOVERNED_LEAF_CAPTURE_REQUIRED
message  structured leaf admission requires governed leaf capture; ungoverned
         structured leaf admission was removed by the Tranche 4 cutover
at       PostgresRuntimeStore._captureGovernedLeafAuthority  (store.js:4433)
```

### Canonical owner and smallest semantic correction

`persistence/postgres/store.js` `_captureGovernedLeafAuthority` requires a
`governedLeafCapture` argument carrying `{ policySource, progressControlPolicy }`
— the Tranche 4 cutover made ungoverned structured leaf admission impossible.

`server.js` `admitStructuredAllocationLeafRuns` makes the only production call
to that method and **passes no `governedLeafCapture`**. The identifier appears
nowhere in `server.js`. `getStructuredAllocationLeafExecutionRepository()`
returns the store itself, so nothing injects it downstream.

The smallest correction is for the leaf-admission orchestrator to resolve the
worker-role governed policy source and progress-control policy — as
`scripts/governed-structured-fixture.js` already does for admission in tests —
and pass them as `governedLeafCapture`. That is a structured-execution lifecycle
change and is deliberately NOT made under the evaluation brief.

### A second, independent defect: the refusal is mislabelled

`server.js:17078`:

```js
} catch (error) {
  if (error instanceof StructuredAllocationLeafRunError && error.reason) {
    return refuse(error.reason, error.message);
  }
  return refuse('leaf_admission_conflict', error.message);
}
```

Any exception that is not a `StructuredAllocationLeafRunError` becomes
`leaf_admission_conflict` — a concurrency verdict — and `refuse()` renders the
fixed vocabulary message rather than `error.message`. The real cause therefore
reaches neither the block payload, the diagnostic log, nor stdout, and an
operator sees "lost a concurrent race for this allocation plan" for a failure
that involves no concurrency at all.

Recommended bounded correction, when authorized: keep known
`StructuredAllocationLeafRunError` codes unchanged, keep genuine revision or
serialization conflicts mapping to `leaf_admission_conflict`, and give
everything else a distinct class such as `leaf_admission_internal_failure`
carrying a sanitized `causeCode` (application code or SQLSTATE) — never raw
message text in user-visible output.

### How it was found

The public reason was untrustworthy, so the exception was captured **below** the
catch-all with an opt-in, test-only wrapper on the canonical store method
(`scripts/fixtures/evaluation-preload.js`,
`EVALUATION_CAPTURE_LEAF_ADMISSION=1`). It rethrows unchanged, so production
behaviour is identical whether or not it is enabled. No plan, Run, evidence or
constraint was manufactured, and no production file was modified.

### Pinned, not silently carried

`scripts/structured-allocation-evaluation-test.js` §13 asserts both halves —
that `server.js` supplies no `governedLeafCapture`, and that the catch-all maps
unexpected errors to `leaf_admission_conflict`. Those assertions fail the moment
either is fixed, so the defect cannot close unnoticed and the pin must then be
replaced by an execution proof.

### Consequence for Tranche 6

The structured arms cannot execute governed leaf Runs until this is repaired, so
the controlled evaluation cannot measure governed execution, governed economics,
verified-progress control or aggregate structured completion. **Prerequisite 3
remains PARTIALLY CLOSED**, and the quiescence correction stays deferred: this
refusal is currently terminal, but it is terminal because of a defect rather
than a product decision, so encoding it as a legitimate terminal state would
record the bug as intended behaviour.

---

## Tranche 6 Controlled Evaluation: LEAF ADMISSION REFUSES (2026-08-06)

**Session 7. Goal NOT met.** B and C still produce zero leaf Runs.

**Verdict: LEAF MATERIALIZATION ATTEMPT REFUSED.** Leaf admission is reached
synchronously after plan admission and refuses with `leaf_admission_conflict`
at stage `leaf_admission`, `workerRunsCreated: 0`. The admitted plan is well
formed — version 2, three items, distinct agents, distinct non-overlapping owned
paths.

**The reported reason is almost certainly not the real one.** `server.js:17078`
reports ANY non-`StructuredAllocationLeafRunError` as `leaf_admission_conflict`,
and `refuse()` renders the vocabulary message rather than `error.message`, so the
underlying cause reaches neither the block payload, the diagnostic log, nor
stdout. Raising the scheduler interval tenfold changed nothing, and a genuine
race would have left the winner's leaf Runs behind; zero exist.

**Recorded as a diagnosability gap:** a leaf-admission failure of any kind is
currently indistinguishable from a concurrency conflict and its cause is
unrecoverable from durable state. Closing it needs either a bounded production
diagnostics change or an in-process reproduction of
`admitStructuredAllocationLeafRuns` against the admitted plan — the first task of
the next session. No production file was changed here.

**Quiescence correction deferred, deliberately.** Plan-admitted /
leaf-unmaterialized is currently treated as quiescent, which is wrong for a
recoverable continuation but right for a terminal refusal — and the present
block is of unknown kind, so the rule cannot be written truthfully yet.

**PREREQUISITE 3 REMAINS PARTIALLY CLOSED — EVALUATION MAY NOT RUN.**

**Previous session record, retained:**

## Tranche 6 Controlled Evaluation: B AND C ADMIT PLAN v2 (2026-08-06)

**Session 6.** The structured arms previously failed planning outright. Four
distinct refusal causes were identified from durable authority and corrected at
the harness — **no production file changed** — and B and C now admit Allocation
Plan v2: missing governed routing policy, missing `economicPolicy.capturedAt`, a
planner body that was not a v2 proposal, and a proposal omitting the planner
agent as a captured candidate. A fifth defect was harness-only: seeding a
routing policy per trial made the second structured trial fail, because exactly
one active governed policy may exist.

`planVersion` was being derived from leaf Runs and reported a genuinely admitted
v2 plan as v1 whenever leaf admission had not run; it now derives from how the
plan was admitted.

**The session goal is NOT fully met.** Leaf-Run admission is still unobserved, so
governed execution, governed economics, verified-progress controls and aggregate
structured completion remain unexercised. The runner now reports
`planningAttempted`, `planAdmitted`, `leafRunsAdmitted` and
`governedLeafExecutionObserved` as separate facts so a planning attempt can never
be read as executed governed work.

**PREREQUISITE 3 REMAINS PARTIALLY CLOSED — EVALUATION MAY NOT RUN.**

**Previous session record, retained:**

## Tranche 6 Controlled Evaluation: RUNNER EXECUTES ALL FIVE ARMS (2026-08-05)

**Session 5.** The executable runner exists and family 1 has run through all
five production configurations, resolving to exactly three distinct durable
paths. 85 smoke assertions; artifacts under
`/tmp/ticket-system-structured-evaluation-smoke/<commit>/fixture/`.

Durable path proof rests on `runs.body` leaf bindings and governed envelopes,
`allocation_plans`, `ticket.structured_planning*` events and `structured_planner`
reservations — never the arm label. A trial whose durable facts belong to
another path is refused as invalid rather than relabelled.

**B and C reached structured planning and were blocked before admitting a
plan.** That is a truthful product result and valid trial data, but the
structured arms have not yet been observed executing leaf Runs. Resolving the
planning refusal is the first task of the next session.

Report zero drift proved for all five arms: the read-only report was invoked
twice after quiescence and the durable fingerprint was identical before, between
and after.

**PREREQUISITE 3 REMAINS PARTIALLY CLOSED — EVALUATION MAY NOT RUN.** Families
3, 4, 7, 8 and 9 have executable definitions but have not been executed, and the
structured arms have not yet admitted a plan.

**Previous session record, retained:**

## Tranche 6 Controlled Evaluation: FIXTURE SEAMS BUILT (2026-08-05)

**Session 3.** The complete release checkpoint was run against
`bf06a1a75d1a0a8386ab197fc58efea2283006ba` before any edit, as the previous
session had registered a required suite without running it: **197/197 passed**,
and `structured-allocation-evaluation-test.js` genuinely executed.

**Closed this session:** the hermetic provider fixture (one response table keyed
by protocol/scenario/task/seed/role/ordinal and never by the arm; refusal rather
than generic success for an unexpected request; three controlled failure
boundaries; per-trial namespaces that refuse reuse; transcript and external
access log exposed outside product authority); **family 4's missing
observation**, which is no longer observation-blocked; the nine-condition
read-only quiescence contract; and the write-once, mode-validated trial artifact
with dual fixture/live separation.

**Family 4 closure is the substantive result.** A seed-derived producer nonce, a
fixture-owned access log recording the consumer read by hash, and an output that
binds the producer hash together distinguish genuine coupling from a lucky final
state — including a fully self-consistent forgery, which fails on the seed
derivation alone. Two mutations survived their first pass because every other
case was caught by a later check; the isolating cases were added rather than the
mutations re-aimed. 12/12 focused mutations now caught.

**STILL OPEN — EVALUATION MAY NOT RUN.** The scenario fixture definitions for
families 3, 7, 8 and 9 are not authored as data, and the trial runner with its
five arm adapters is not built. No smoke run was performed and none is claimed.
No scored or live evaluation ran, and no RETAIN / REVISE / STOP verdict exists.

**Previous session record, retained:**

## Tranche 6 Controlled Evaluation: HARNESS BUILT (2026-08-05)

**Status:** prerequisites resolved and the read-only harness built. The scored
evaluation has NOT run, and no RETAIN / REVISE / STOP verdict exists. No
production change in either session.

**Five of six execution prerequisites are CLOSED with repository proof.**
Priced-cost reader, Ticket-scoped aggregation reader, fixed planner model,
independent postcondition oracle, and the governed-single-Run product decision.
Proofs live in `scripts/structured-allocation-evaluation-test.js` (72
assertions, registered required and deterministic) and were mutation-tested
15/15.

**Prerequisite 3 remains OPEN — EVALUATION MAY NOT RUN.** Hermetic scenario
fixtures for families 3, 4, 7, 8 and 9 are not authored, and the deterministic
trial runner with its five arm adapters is not built. No smoke run was
performed, and none is claimed.

**The governance confounder is CLOSED as a product decision, not by silence.**
The primary unit is the shipped bundle: governance, verified progress, bounded
economics, structured completion and coordination are part of the structured
path as it ships. No governed single-Run arm is built, because no equivalent
existing production path exists and inventing one would evaluate a product that
does not exist. The recorded causal limitation is that the evaluation can
determine whether the integrated structured path earns its total complexity but
cannot attribute every difference to planning alone; arms A2a/A2b control for
much of the multi-agent and ownership benefit. A later ablation is proposed only
if the main result is RETAIN or REVISE and identifying the valuable component
would change the decision.

**Family 4 stays BLOCKED rather than weakened.** Raw final state cannot
distinguish correct handling of coupling from a lucky execution order, and an
oracle that guessed would manufacture exactly the truthfulness error the
evaluation exists to measure.

**Original session-1 audit, retained:**

Protocol: `docs/STRUCTURED_ALLOCATION_CONTROLLED_EVALUATION.md`.

**Phase 1 verdict: TRANCHE 6 REQUIRES A CONTROLLED-EVALUATION PROTOCOL.** The
roadmap's Tranche 6 section is four sentences fixing five dimensions and three
outcomes; it defines no baseline, arm, threshold, repetition rule or decision
rule. The existing `*-experiment.js` / `*-benchmark.js` scripts are ad-hoc
research harnesses, several JSON-era, none classified by
`scripts/test-manifest.js` (which governs `scripts/*-test.js` only). They are not
authority for this evaluation.

**Phase 8 verdict: MINIMAL EVALUATION INSTRUMENTATION REQUIRED** — two read-only
gaps. `settled_micro_usd` exists only on governed runs, so the direct arms have
no durable money figure and their token usage must be priced from the same
captured pricing catalog and reported as derived; and no Ticket-scoped
cross-arm aggregation reader exists. Neither requires an execution-semantics
change, a new column or a new event.

**A third existing baseline was found and is required, not optional.** A group
ticket in `allocated` or `dynamic` mode WITHOUT `declaredWork` does not reach the
Tranche 1-5 machinery: it takes the legacy v1 `buildAllocatedOwnershipPlan` path
with a generic subtask and no planner call. It is multi-agent but ungoverned, so
it isolates parallelism from planner-plus-governance. Without it, any structured
advantage could be attributed to parallelism alone.

**Recorded confounder, not resolved:** governed execution is entangled with the
structured path. No governed single-Run arm exists today. Either governance is
accepted as part of "the structured path" and stated, or the arm is built. This
is prerequisite 6 and must not be resolved by silence.

**Six prerequisites block execution**, listed in the protocol. The most important
is an independent postcondition oracle: scoring completion truthfulness with the
same completion authority under evaluation would guarantee agreement and prove
nothing.

---

## Tranche 5 Register: CLOSED (2026-08-05)

Final closure audit. Every Tranche 5 entry in this register now ends in exactly
one truthful state. No entry reads "partially proved", "mostly closed",
"source-audited only", "pending matrix", "future mutation" or "known gap".

**CLOSED — with canonical owner and proving suite**

| Entry | Canonical owner | Proving suite |
|---|---|---|
| Terminal reader parity (five-row matrix) | reader surfaces + `deriveLeafItemDisposition` | `docs/TERMINAL_PROJECTION_READER_CONTRACTS.md` §11; blocked-restart, sibling-dependency, replay-corruption suites |
| Governed block CLI normalization | `scripts/oquery.js` via `normalizeGovernedProgressBlock` | `governed-blocked-restart-postgres-test`, `governed-sibling-dependency-postgres-test` |
| `oquery replay` governed payload contract | `scripts/oquery.js` | same |
| CLI applicability for rows 3 and 4 | reader matrix | same |
| Completion-authority projection parity | `transitionTicketAfterRun`, `deriveLeafItemDisposition` | `structured-allocation-leaf-run-postgres-test`, `completion-decision-postgres-test` |
| `projectedStatus` non-success mapping | `persistence/postgres/store.js` | `structured-allocation-leaf-run-postgres-test` |
| Delivery uncertainty vs concurrent duplicate | `classifyGovernedRequestRecovery` | `governed-leaf-production-path-postgres-test`, `governed-pre-transport-restart-postgres-test` |
| Governed claim ownership | `markEconomicRequestStarted` | `governed-leaf-production-path-postgres-test` |
| Duplicate-dispatch outcome anomaly | `resolveStartedRequest` | same |
| Transport attribution / deterministic fixtures | hermetic transport preload | restart suites |
| Governed progress block-hash ownership | `governed-progress-block-contract.js` | `verified-progress-terminal-mapping-test` |
| Sibling refusal `failureKind` | sibling-read preflight | `governed-sibling-dependency-postgres-test` |
| Blocked-projection mutation sensitivity | `verified-progress-projection.js` | `verified-progress-terminal-mapping-test` |
| Stale foreign-authority expectations | leaf reconciliation | `structured-allocation-leaf-run-postgres-test` |
| Completion evidence owed only by a completion claim | `_recordCompletionDecisionEvidence` | `malformed-completion-projection-postgres-test` |
| Run-State API reader contract | `/api/runs/:id/state` | terminal reader fixtures |
| suite-mutation-test stale anchor | `scripts/suite-mutation-test.js` | itself, 54/54 |
| Required-persistence matrix | 24 inventoried writes | `governed-required-persistence-postgres-test` |
| Unconsumed-response false churn | `isChurnEligibleWindow`, `readGovernedRunProgressState` | `governed-required-persistence-postgres-test` row 5.4; `governed-no-progress-withholding-postgres-test` |
| Startup-repair persistence proofs | `repairRunTerminalization` | `governed-required-persistence-postgres-test` Phases 11-12 |

**SUPERSEDED**

* "Verified progress has no durable evidence substrate (2026-08-02)" in
  `docs/DECISION_LOG.md` — superseded 2026-08-05 by the substrate that entry
  named as its prerequisite (migrations 035-037). The entry is retained unaltered
  as a dated record.
* "Terminal Reader Parity: five-row matrix complete except the CLI cell" —
  superseded by the CLOSED entry above.

**RETAINED OUTSIDE TRANCHE 5**

* *Governed Response-Hash Tamper Has No Scenario* — a coverage gap on the Tranche
  4 governed response-rehydration guard, with its exact reason recorded at that
  entry. Not a Tranche 5 completion criterion and not a known defect.
* *Structured Allocation Leaf-Run Retry Boundary*, *complete:true Under
  Per-Response Action Caps*, *Workspace Operation Error Handling*, *Event Log
  Stream Semantics*, *Process-execution GA release blockers*, *Execution-Governance
  Audit* — pre-existing entries owned by other tranches or workstreams.

**OPEN MERGE BLOCKERS**

None.

**A3 scope, restated unchanged.** A3 is CLOSED FOR GOVERNED STRUCTURED LEAF
RESOURCE ACCOUNTING only. The repository-wide remainder remains open. This
closure does not broaden it.

---

## Governed Required-Persistence Matrix: CLOSED (2026-08-05)

**Status:** CLOSED. No row remains DEFECT, UNTESTED, SOURCE-ONLY or PENDING.

Full proof matrix: `docs/GOVERNED_REQUIRED_PERSISTENCE_MATRIX.md`.
Canonical suite: `scripts/governed-required-persistence-postgres-test.js`
(315 assertions). Seam: `scripts/fixtures/persistence-fault-repository.js`,
entirely outside production source.

Twenty-four durable writes inventoried and classified by tracing consumers and
recovery role. Every required write is failure-injected at its canonical owner
or proved structurally impossible to observe partially because PostgreSQL
commits it with its dependent transition. The three items left open when the
matrix was first published are now closed.

### CLOSED — false churn attribution for unconsumed durable responses

`evaluateGovernedRunProgress` scored a window as no-progress on
`hasDurableResponse` alone. When settlement — or any required write between the
response marker and the worker — failed, the answer was durable but execution
never saw it, and the window was charged against the model's churn tolerance
anyway; at a tolerance of one the paid-for answer became permanently unreachable
behind a block.

**Phase 1 verdict: PROGRESS EVALUATION LACKS A RESPONSE-CONSUMED WINDOW
BOUNDARY.** Ordering was not the defect and was not changed — a persisted block
is still consulted first, and a delivery-uncertain request is still never
retransmitted.

**The correction**, at two canonical owners with one shared definition:

* `persistence/postgres/store.js` — `readGovernedRunProgressState` now groups
  `run_budget_charges` by `source_identity` and reports, per window, whether the
  answer was delivered to execution. Read under the EXISTING `budgetCutoff`, so
  the cutoff shape and every stored block hash are unchanged. No new column,
  table or event.
* `runtime/governed-progress-evaluation.js` — `isChurnEligibleWindow` is the one
  definition of a churn-eligible window: durable response AND delivery not
  explicitly absent.

The committed `model_request` budget charge is the boundary because production
commits it in exactly one place — immediately before the response envelope is
handed to the worker loop — under the identity the reservation already carries,
and it exists even for a turn that proposed no actions, so ordinary churn stays
countable.

**Fail-safe, not fail-open.** `runtimeBudgetController` is a no-op for a Run with
no runtime budget snapshot, so delivery is a tri-state: `true`, `false`, or
`null` when the Run keeps no ledger. Only an explicit `false` withholds
eligibility; `null` falls back to the previous rule, so churn control can never
be silently disabled.

Legitimate churn is unchanged and independently confirmed through a real server
by `governed-no-progress-withholding-postgres-test`.

### CLOSED — startup repair and consequence reconstruction

Both previously-retained rows are now failure-injected rather than source-audited
(matrix §6a). Repair refuses closed on absent execution evidence, on duplicated
or contradictory evidence, and on a conflicting completion decision; it invents
no consequence and no completion decision; it reuses a durable consequence
verbatim instead of rebuilding over it; and a failure at any of
`writeReplaySnapshot`, `recordRunEvaluation`, `recordRunConsequence`,
`_recordCompletionDecisionEvidence` or `_listRunOperationsOn` rolls the entire
repair back, with a later repair succeeding exactly once.

### Retained

Nothing from this matrix. Remaining Tranche 5 work is unrelated to it: final
broad documentation reconciliation, the complete release checkpoint, and the
final merge-readiness audit.

---

## Terminal Reader Parity: five-row matrix CLOSED (2026-08-05)

All five rows and every reader cell are asserted, classified RAW HISTORY ONLY,
proved a closed refusal, or proved NOT APPLICABLE from source. No cell reads
PARTIAL, NOT ASSERTED, UNFILLED or BLOCKED BY DEFECT.

The last gap was the CLI's governed-block reader trusting raw durable state. It
now consumes `normalizeGovernedProgressBlock` — the canonical contract
`projectBlock` uses — and refuses closed on a block canonical projection would
reject: an edited reason under a stale hash, a malformed hash, or a
verified-progress block carrying sibling authority. Details and the full
five-row matrix are in `docs/TERMINAL_PROJECTION_READER_CONTRACTS.md` §4c, §11.

**Closed:** malformed governed request handling; canonical CLI block
normalization; progress-block CLI cell; sibling-dependency CLI cell; terminal
five-row reader matrix; terminal reader-parity register entry.

**Retained:** required-persistence failure matrix; final projection/
documentation reconciliation; complete release checkpoint; final
merge-readiness audit. Tranche 5 is not complete.

## `oquery replay` Governed Payload Contract: repaired 2026-08-05

Supersedes the entry recording the crash as an open blocker.

**Verdict: OQUERY CONSUMED OPTIONAL GOVERNED FIELDS AS REQUIRED** — the server
serializer omitted nothing; `cmdReplay` read a governed shape that does not
exist. Three CLI-side mismatches, all repaired in `scripts/oquery.js`:

* `governed.requests` was never a field on the authority envelope — iterating it
  threw and killed the command before the block section. Absence is now
  truthful and silent; a PRESENT non-array refuses loudly rather than being
  coerced with `|| []`, which would report "no requests" for a payload that
  might describe several.
* the flat names `authorizedRouteReference`, `economicAuthorityHash`,
  `pricingEntryHash`, `workerAccountId` rendered `undefined`; the envelope
  carries `roleRoutingPolicyHash`, `economicPolicyHash`, `pricingCatalogHash`,
  `economicAccountId` and `governedExecutionHash`.
* `run.verifiedProgress` is a PROJECTION the `/api/export?domain=runs` payload
  never returns; that payload carries the durable `governedProgressBlock`. The
  block now renders from either source, so terminal block authority no longer
  depends on an unrelated projection or on the request/pricing sections.

Rows 3 and 4 are **APPLICABLE — ASSERTED** through `oquery replay <runId>`, with
exact reason, blockHash, blockedAt, cutoffIdentity, churn and policy hashes
compared against the persisted block and Run-state, target-Run selection proved
against neighbours, and zero durable drift including Run revisions. The sibling
RUN id is not printed and is recorded as not exposed rather than added.

**Open:** two CLI mutations remain unaimed — a malformed non-array `requests`
(no fixture supplies one) and a progress block inventing sibling authority (the
obvious mutation is vacuous because a progress block's `siblingDependency` is
null). Recorded rather than claimed.

## CLI Applicability Was Misclassified for Rows 3 and 4 (corrected 2026-08-05)

Closing the CLI cell surfaced an error in my own §4 audit.

**Row 1 is now APPLICABLE — ASSERTED.** Executed through the real command path,
`node scripts/oquery.js run-state <runId>`, against the cold process, with
`OPERC_URL` and `OPERC_COOKIE_PATH`. Asserted: exit 0, exact Run, exact Ticket,
and the three durable dispositions. The decision HASH is not asserted because
`run-state` does not print it — requiring it would demand a field this reader
does not emit.

**Rows 3 and 4 were misclassified NOT APPLICABLE.** `cmdReplay`
(oquery.js:679-691) prints `progress.block.reason`, `blockHash`, `blockedAt`,
`cutoff.cutoffIdentity`, `churnDecisionHash`, `progressPolicyHash`, and
`block.siblingDependency.requestedPath` / `siblingAllocationItemId`. The grep
behind the original claim searched for `governedProgressBlock`, which is not the
payload's field name — the CLI reaches the block through
`verifiedProgress.block`. Corrected to **APPLICABLE — NOT ASSERTED**.

Rows 2 and 5 remain NOT APPLICABLE, now proved by four symbols that are genuinely
absent from the whole file: `integrityFailureCode`, `replayAvailability`,
`POSTGRES_REPLAY_INTEGRITY_FAILURE`, `readTicketVerifiedProgressProjection`.

A source contract pins both directions and parses the matrix row itself, so
re-marking rows 3 or 4 NOT APPLICABLE, or marking rows 2 or 5 applicable, now
fails.

**The terminal five-row matrix is therefore NOT complete.** Two CLI cells are
classified but unasserted. The previous entry claiming one remaining cell is
superseded.

## Terminal Reader Parity: five-row matrix complete except the CLI cell (2026-08-05)

Closed this session:

* **Ticket timeline classified for all five rows** — APPLICABLE — RAW HISTORY
  ONLY. It owns `entries` and a `sourceSummary` of durable record counts and
  repeats no reconciliation reason, item status, block authority or replay
  availability. Asserted for the history it owns, and asserted NOT to carry the
  other readers' vocabulary, so it can never be used as their evidence.
* **Semantic page sections for rows 1, 3 and 4** — via a `pageSection(html,
  label)` helper that reads one `<dt>`/`<dd>` pair. This is what separates a
  completed Run's historical "Churn decision" text from its terminal authority;
  a page-wide substring check cannot. Row 4's Final Blocking Reason renders the
  operator-facing refusal, which names the requested path and sibling item
  directly — richer than the machine code, and asserted as such.
* **Rows 2 and 5 complete no-side-effect matrices** — 16 counters including
  integrity containment events and per-Run revisions, captured with the Ticket
  quiescent around every applicable read. Exact values recorded in
  `docs/TERMINAL_PROJECTION_READER_CONTRACTS.md` §11; zero drift, and for row 5
  `runRevisions` byte-identical, proving the refusals terminalize, repair and
  reclaim nothing.

**Still open — one cell.** The CLI valid-completion row is classified
APPLICABLE in §4 but was not executed. Rows 2-5 remain NOT APPLICABLE with their
source-backed reasons. That is the only unfilled cell in the matrix.

## Stale Foreign-Authority Expectations: closed 2026-08-05

Supersedes the entry that recorded this as an open regression. Both the
diagnosis and the framing in that entry needed correcting.

**Production was never wrong.** The authority validation added by `da5af60` is
correct and unchanged. What was stale were two expectations in
`structured-allocation-leaf-run-postgres-test`.

**The fixture is also not stale.** It builds two decisions DELIBERATELY against
a foreign objective contract — `terminalGateCase({ foreignAuthority: true })`
uses the sibling item's authority, and the forged-run case asserts outright that
its decision hash differs from the Run's admitted one. Those are intentional
negative fixtures and are kept exactly as they were. An earlier handoff
described the fixture as accidentally substituting an authority; that was wrong.

**What actually changed.** Before `da5af60`, Ticket projection passed `null` as
the expected authority, compared nothing, and merely declined to advance; only
reconciliation caught the mismatch. Now both readers compare the Run's own
admitted authority, so the transition REFUSES with
`COMPLETION_EVIDENCE_MISSING` / `completion_authority_mismatch`. The two readers
agreeing is precisely what that correction was for. Three expectations that
predicted "gated, unchanged" now assert the refusal, its code, its exact reason,
and that the parent Ticket is not advanced.

**Verified consistent, not assumed:** the completing scenario's Runs 5 and 6
have stored authority hash, hash recomputed from the stored contract, and
decision authority hash all identical. Only the deliberately foreign cases
differ.

### Why it stayed invisible — SUITE IS REGISTERED BUT MANUAL GATE LISTS OMITTED IT

| Location | Present? |
|---|---|
| `scripts/test-manifest.js:321` | yes — `status: "required"` |
| `scripts/release-checkpoint.js:133` | yes |
| release-checkpoint coverage enforcement | yes — removing it is caught |
| package scripts | not referenced individually |

The repository always required this suite, and the release checkpoint would have
caught the failure. It was omitted only from the hand-maintained per-session
gate and containment lists, and the complete release checkpoint has been
deliberately deferred for many sessions. **This is not a repository
registration gap.**

The durable correction is behavioural, not another list: when
completion-authority projection changes, the suites that must run are those
naming `runCompletionAuthorityHash` or `evaluateRunCompletionEvidence` — a
source-derivable set — and `structured-allocation-leaf-run-postgres-test` is in
it. Recorded in `docs/TERMINAL_PROJECTION_READER_CONTRACTS.md`.

## Completion Evidence Is Owed Only by a Completion Claim (closed 2026-08-05)

`deriveLeafItemDisposition` reported `completion_decision_missing` for any
terminal non-success Run with no decision — a claim that successful completion
evidence was required and absent, made about Runs that never claimed completion
and therefore owed none. A replay-integrity-failed leaf was described as lacking
proof it was never required to produce, competing with the integrity authority
that actually explained it. A source comment acknowledged the string was kept
for consumer compatibility.

Corrected to `completion_unsuccessful`; the missing decision stays visible via a
null `completionDecisionHash`. Strict malformed-success handling is unchanged —
a COMPLETED Run with no decision still reports `completion_decision_missing`,
which is the one case that legitimately makes that claim.

Recorded as still unowned: `projectedStatus`'s `not_applicable` branch has no
suite that executes it.

## Terminal Reader Parity: Both Production Defects Closed (2026-08-05)

Supersedes the entry recording them as blockers. Both are corrected, with
production proof and 9/9 focused mutations at their canonical owners; details in
`docs/TERMINAL_PROJECTION_READER_CONTRACTS.md` §10.

1. **Governed block authority reached reconciliation.** The store now passes
   `run.governedProgressBlock` to `deriveLeafItemDisposition`, which reports
   `governed_progress_blocked` or `governed_sibling_dependency_blocked`.
   `completion_blocked` was NOT reused — production already emits it for
   `VERIFICATION_UNAVAILABLE` and infrastructure failure, so an earlier claim
   in this register that a blocked disposition was synthetic-only was wrong.

2. **Historical churn no longer classifies terminal Runs.** The Ticket
   verified-progress fallback is restricted to nonterminal Runs; a terminal Run
   groups only from its persisted block. Live churn reporting for executing Runs
   is retained.

The broader terminal reader matrix remains OPEN: rows 2 and 5 reader cells, the
CLI row, page semantic sections and the per-row quiescent no-drift reads are
still unimplemented.

## Run-State API Reader Contract (corrected 2026-08-05)

**Supersedes the entry titled "Run-State API Does Not Own Block or Integrity
Authority", which was wrong.**

That entry concluded `GET /api/runs/:id/state` carries no block authority
because no top-level `governedProgressBlock` key exists. The reader DOES carry
the complete per-Run governed block — at `verifiedProgress.block`, including
`blockHash`, `reason`, `churnDecisionHash` and `siblingDependency`. The earlier
conclusion searched for the wrong key name and recorded absence as a contract.

What IS absent from that route is `replayAvailability`; replay availability is
a Run-page concern. `replaySummary` is `null` when the replay cannot be read.

The definitive, payload-verified audit of every terminal reader — ownership
table, actual field paths, five-row applicability matrix, CLI applicability,
page semantic sections, existing fixture map, mutation-owner map and the
enumerated remaining checklist (24 reader cells, 9 mutation cases) — is:

**`docs/TERMINAL_PROJECTION_READER_CONTRACTS.md`**

Terminal reader-parity register entries below remain OPEN; that document is the
blueprint for closing them, not a claim that they are closed.

# Architectural Decisions Pending

This is the **canonical register of open integrity defects, deferred work, and pending
architectural decisions**. It is the single authoritative record: nothing required to
understand, operate, audit, recover, or continue this project may exist only in agent
memory, chat transcripts, scratchpads, or private notes. A defect or decision discovered
during work must be recorded here before that work ends, or the work must state explicitly
that it was not recorded because repository scope was not authorized.

Secondary documents link here rather than restating an entry. Where an entry names a
governing design memo, that memo holds the rationale and this register holds the status.

---

### A27. The ticket-simulation provider call is unbounded

| Field | Value |
|-------|-------|
| **Status** | **Open.** Found during the Tranche 2B provider-seam audit; not fixed there because it is outside that tranche's scope |
| **Severity** | **Medium** — an operator-triggered endpoint can hold a request open indefinitely against a hung provider |
| **Discovered by** | Auditing every `callModelProvider` call site for Tranche 2B reuse |

`POST /api/tickets/:id/simulate` (`server.js`, the `includeModelPlan` branch) calls:

```js
modelResponse = await callModelProvider(agent, input, { simulation: true, timeout: 30000 });
```

`callModelProvider` reads only `options.signal` and `options.onRequest`. Both
`simulation` and `timeout` are silently ignored, so this call has **no timeout and no
abort path at all**. For `ollama` it goes through `providerHttpJsonRequest`, which is
documented as having no implicit timeout by design because the run's `AbortController`
is meant to be the sole budget — and here there is no controller. For `openai` it
inherits only undici's default header timeout.

Every other provider call site passes a real `AbortSignal`
(`callModelProviderWithRunTimeout` for runs; a dedicated `AbortController` for the
Tranche 2B planner request). This endpoint is the only one that does not.

**Why it was not fixed in Tranche 2B.** The tranche's authorized surface is structured
allocation planning. Changing simulation-endpoint timeout behavior is an unrelated
runtime policy change with its own operator-visible effect, and folding it into a
planner-admission commit would hide it. Tranche 2B instead constructs its own
`AbortController` and does not reuse the simulation call's option shape.

**Decision needed.** Either give the simulation endpoint an explicit
`AbortController` with a documented bound, or delete the two dead options so the
absence of a timeout is visible in the source rather than implied by them.

---

## Process-execution GA release blockers (2026-07-29)

| Field | Value |
|-------|-------|
| **Status** | **Resolved 2026-07-29 — patched production graph and clean authorized external audits; final GA validation remains in progress** |
| **Scope** | Tranche 8 GA release evidence |
| **Original code** | `PROCESS_RELEASE_VULNERABILITIES_FOUND` |

The prior backup/restore and bounded-soak scripts were not valid GA evidence: the
former rebuilt the same fixture in a new empty schema and the latter printed
hard-coded zero-leak/no-duplicate claims. Both have been replaced. The bounded
soak passes with measured PostgreSQL, launcher, artifact, receipt, completion,
capacity, cancellation, restart, and compaction observations. The backup test
passes through an actual `pg_dump` custom archive plus `pg_restore` into a
separate schema, paired with a separately restored artifact tree and no
reseeding.

The authorized external audit ran on 2026-07-29. `pnpm` 11.8.0 reported three
high-severity advisories in the shipped production Fastify dependency graph:

- `GHSA-v2hh-gcrm-f6hx`: `fast-uri` 3.1.2, fixed in 3.1.4 or later;
- `GHSA-4c8g-83qw-93j6`: `fast-uri` 3.1.2, fixed in 3.1.3 or later
  (3.1.4 therefore satisfies both `fast-uri` advisories);
- `GHSA-c96f-x56v-gq3h`: `find-my-way` 9.6.0, fixed in 9.6.1 or later.

`fast-uri` and `find-my-way` are transitive production dependencies beneath the
direct shipped dependency `fastify` 5.8.5, not development-only packages. The
locked RustSec audit tool `cargo-audit` 0.22.2 found zero advisories across 22
locked dependencies in each of the launcher and materializer components, using
RustSec database commit `7c7ccac53056b87f69ac677f15ea2d9a98a6f8e2`.

The authorized remediation updated the direct Fastify v5 dependency from
5.8.5 to 5.10.0 and refreshed only its required production subtree.
`find-my-way` moved from 9.6.0 to 9.7.0. The former `fast-uri` 3.1.2 paths
now resolve to 3.1.4 through AJV and to 4.1.1 through
`fast-json-stringify`. No override, advisory allowlist, automatic fix,
Cargo-lock change, registry change, Git dependency, or local-filesystem
dependency was introduced.

The authorized external gate was rerun on 2026-07-29 with `pnpm` 11.8.0 and
`cargo-audit` 0.22.2:

```sh
PROCESS_RELEASE_NETWORK_AUDIT=1 npm run release:security
```

The production Node report contained zero critical, high, moderate, low, or
informational vulnerabilities across 83 dependencies. Each native lockfile
contained 22 dependencies and reported zero RustSec vulnerabilities using
database commit `7c7ccac53056b87f69ac677f15ea2d9a98a6f8e2`.

The dependency blocker is resolved, but this record does not by itself close
Tranche 8. The final candidate checkpoint and the complete GA command must
still pass from the exact clean committed source. The GA command remains
fail-closed and cannot print `PROCESS EXECUTION GA RELEASE PASSED` if a
mandatory gate is skipped, unavailable, or inconclusive.

---

## Execution-Governance Audit (2026-07-25)

A read-only execution-governance integrity audit was performed against run #8 (ticket #3,
objective `create folders A-Z in the workspace`, agent Mike / `gemma3:latest`), which failed
as `MODEL_RESPONSE_CONTRACT_VIOLATION` with zero mutations. The audit examined every
mechanism that can admit or reject a run, restrict model visibility, limit budgets, truncate
or reject model output, detect stalls, terminate a run, change behavior after recovery, or
alter completion eligibility.

Commit `a1143e6` ("Make execution semantics reconstructable") fixed the **evidence
truthfulness and reconstructability** findings only. Everything below was audited,
confirmed against source, and deliberately left unfixed. Severity is stated in terms of what
the defect can cause, not how hard it is to fix.

### Status summary

| # | Defect | Severity | Status | Class |
|---|--------|----------|--------|-------|
| A1 | Workspace-snapshot failure truthfulness (E4) | **High** | **Implemented** `ee44369` + `3f6d4ac` — entry retained for the record | Correctness |
| A2 | Live-state vs immutable-snapshot mutation counting (E5) | Medium | Open | Correctness |
| A3 | Wall-clock and progress-counter recovery resets | **High** | Closed for governed structured leaf execution; open elsewhere | Bounds integrity |
| A4 | Enforcement gates bypass the immutable policy snapshot | Medium | Open | Architecture |
| A5 | Workload-profile re-resolution | Low | Open | Architecture |
| A6 | Gate ordering vs prefix truncation | Medium | **Governance decision required** | Policy |
| A7 | Objective-grammar anchoring | Medium | **Governance decision required** | Policy |
| A8 | Dead `allow*` policy fields | Low | Open | Dead contract |
| A9 | Latency-aware feasibility | Medium | Open | Feasibility |
| A10 | Orphaned PostgreSQL-era test harnesses | **High** | **Resolved for the inventoried 14** — see entry; wider orphan population newly recorded | Verification gap |
| A11 | `truncated:true` disclosed to the model but never explained | Low | Open — split from A1 | Prompt policy |
| A12 | Bounded workspace-snapshot recovery policy | Medium | **Open — decision required** — residual of A1 | Policy |
| A13 | Tests asserting removed commit-idempotency helpers | Medium | **Resolved 2026-07-26** — five retired, two contracts re-expressed behaviorally; one residual `verifyBatchOperation` gap | Verification gap |
| A14 | Redundant-mutation postcondition shortcut does not fire | **High** | **Implemented** — see entry | Correctness |
| A15 | Postcondition telemetry names a source the event never reaches | Low | **Open — decision required** | Documentation / telemetry |
| A16 | Run consequence records no committed mutations | **High** | **Implemented** — see entry | Correctness |
| A17 | Delegated handoff logging crashes the server process | **Critical** | **Open — implementation required** | Correctness / availability |
| A20 | Repository-wide PostgreSQL-cutover test-orphan population | **High** | **Open** — inventory complete, anti-rot implemented; 81 orphans remain | Verification gap |
| A21 | Ticket reassignment silently discarded; audit trail asserts otherwise | **High** | **Implemented 2026-07-26** — see entry | Correctness / truthfulness |
| A22 | Resume after a committed workspace operation fails on an idempotency conflict | **High** | **Implemented 2026-07-26** — see entry | Correctness / recovery |
| A23 | Deterministic crash-seam coverage was incomplete | Medium | **Closed 2026-07-26** — all nine seams driven | Verification gap |
| A24 | Absolute host filesystem paths disclosed to the model provider | **High** | **Implemented 2026-07-27** — see entry | Privacy / disclosure |
| A25 | Bounded automatic retry never executed — `ReferenceError` swallowed | **High** | **Implemented 2026-07-27** — see entry | Correctness / dead feature |
| A26 | `countRunMutatingOperations` always returns 0; the mutated-run retry guard is inert | **High** | **Implemented 2026-07-27** — see entry | Correctness / safety |

### Sequencing

1. **A10 first.** Until the orphaned harnesses are repaired or replaced, there is no working
   feasibility or postcondition coverage in the release checkpoint, so A1/A2/A9 cannot be
   validated through their natural suites.
2. **A1 (implemented), then A2.** A1 changed when a run stops; A2 changes what the feasibility
   gate counts. A1 shipped with purpose-built coverage because A10 leaves no working
   feasibility/postcondition suite to host it.
3. **A3 and A12 together.** A3 tightens an effective limit and will fail runs that previously
   passed, so it needs its own observation window; A12's retry bound depends on whether A3's
   per-attempt wall-clock reset is fixed. Deciding either alone changes the other's behavior.
4. **A6 and A7** are governance decisions, not defects to fix unilaterally. Do not implement
   either without a recorded decision.
5. **A4, A5, A8, A9** may follow in any order.

---

### A1. Workspace-snapshot failure truthfulness (E4)

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-25** in `ee44369` (representation, classification) and `3f6d4ac` (recovery lifecycle correction); entry retained as the decision record |
| **Severity** | High — converts an infrastructure failure into confident model action |
| **Evidence** | `server.js` `captureRunWorkspaceRootSnapshot`; capture sites at run start and per step |
| **Decision** | Fail closed at both capture sites; representation must never encode failure as an empty listing |

**Description:**

When the root workspace listing throws, the catch path returns a snapshot with
`entries: []`, `truncated: false`, `entryCount: 0`, plus an `error` key. A listing *failure*
is therefore indistinguishable from a legitimately *empty* workspace in every field the
model is instructed to read. The system prompt never mentions `error` or `truncated`, so a
model receiving this reasonably concludes the workspace is empty and may create the full
target state from scratch, or treat pre-existing artifacts as absent.

The failure is also recorded as evidence: the run-start snapshot is persisted to
`replaySnapshot.targetSnapshots` and emits `target.snapshot.captured`. Encoding failure as an
empty listing therefore makes the *diagnostic record* assert a clean empty workspace for a run
that never managed to read it — independent of any model.

**Why fail closed rather than flag and continue.** A thrown listing can never mean "the
workspace does not exist yet": `resolveInside` calls `ensureRoot()` (`mkdirSync` recursive)
before every operation, so a missing root is created and yields an empty listing. Every
reachable cause of a throw is abnormal — mkdir failure (EACCES/EROFS/ENOSPC, or the root path
occupied by a file), a containment rejection from `assertRealPathInside`, or `readdirSync`
failing with EACCES/EIO. `docs/SYSTEM_STATUS.md` already states the house rule: *"Fatal
persistence/integrity failures fail closed so mutation work never proceeds without its
required evidence."* The run-start snapshot is required evidence — it anchors relative
objectives.

**Why the per-step site also stops.** `initialWorkspaceSnapshot` plus `mutationsByThisRun` is
durable reconstruction evidence, but it is **not** authoritative current workspace state. It
cannot exclude external changes, partial or unexpected filesystem effects, changed
permissions, containment changes, or divergence between recorded results and present reality.
Continuing on reconstruction alone would let the model act on a workspace nobody can currently
observe.

### Decided shape

**Representation — every capture site, success and failure:**

- `available: false` on failure, `available: true` on success
- `entries: null`, `entryCount: null`, `truncated: null` on failure — never `[]`, `0`, `false`
- sanitized structured error classification
- failure is never encoded as a successful empty listing

**Run-start capture failure:**

- emit durable replay and journal evidence
- terminate before the first model request
- permit no mutations
- classify as an environment/integrity failure — not a model or provider failure

**Per-step capture failure:**

- preserve all mutations and evidence already committed by the run
- stop before another model request or mutation
- place the run into a recoverable state; stopping is **not** rollback, and completed
  mutations are **not** automatically redone
- resume only after recovery successfully captures a fresh current-workspace snapshot

*Mechanism (corrected in `3f6d4ac`):* stop without terminalizing and **retain** the lease.
`failAgentRun` is not called, so no terminal event, triage, or status transition is written.
The lease is deliberately not released: releasing it nulls `lease_owner`, which
`listRecoverableRuns` matches immediately — making the run reclaimable while the invocation is
still unwinding, and collapsing the stop into a single instant retry. Heartbeats stop with the
invocation, so the lease simply expires, and only then does the architecture's existing
lease-expiry recovery claim the run and re-enter `runAgentTicket`. Retry cadence is therefore
bounded to one attempt per lease duration. No new recovery machinery.

*Verified while deciding this:* run statuses are `pending`, `running`, `completed`, `failed`,
`interrupted`, with the last three in `TERMINAL_RUN_STATUSES`; `interruptAgentRun`
terminalizes; and both recovery modes in `listRecoverableRuns` gate on
`status = 'running' AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())`. No
stable recoverable-stopped state exists to adopt, so lease retention plus a state-aware guard
is the smallest truthful mechanism.

**Recovery:**

- record the previous capture failure
- attempt a new capture on re-entry
- a failed recovery capture **remains recoverably stopped** — it does not terminalize; only a
  first failure on a run with no unresolved prior failure terminalizes
- resume only once some later capture succeeds, which records recovery exactly once

*Availability is a transition, not an existence check* (`runtime/workspace-snapshot-availability.js`):
the latest ordered transition between `workspace:snapshot_unavailable` and
`workspace:snapshot_recovered` decides both whether a failure terminalizes or stops
recoverably, and whether a successful capture records recovery. Existence-based logic
re-emitted recovery on every later entry and could not distinguish a first failure from a
failure during recovery.

**Residual, unresolved:** A1 decided *that* a failed capture stops recoverably; it did not
decide how long that may continue. The resulting indefinite lease-cadence retry is **not an
approved behavior** — it is the current behavior pending a policy decision, tracked separately
as **A12**. Do not read A1's implemented status as approval of unbounded retry.

**Classification — distinct codes, shared fail-closed plumbing:**

| Code | Cause | Significance |
|------|-------|--------------|
| `WORKSPACE_CONTAINMENT_VIOLATION` | `assertRealPathInside` rejection (symlink escape) | Security-relevant; must stay distinguishable in triage |
| `WORKSPACE_SNAPSHOT_UNAVAILABLE` | I/O or availability failure (EACCES, EIO, ENOSPC, ENOTDIR, mkdir failure) | Environment fault; ordinarily retryable |

**Explicitly out of scope for A1:** no model-prompt changes. Under this decision the model
never receives `available: false` — the run stops first. Guidance for `truncated: true`
affects healthy runs and is split out as **A11**.

### A1 blockers — all resolved in `3f6d4ac`

Raised 2026-07-25 against `ee44369`; all five resolved in `3f6d4ac`. Representation
(`available:false`, null counts) and classification (two distinct codes) were accepted as
landed. The recovery implementation was not, and the suite did not catch it. Retained because
B5 is a standing lesson about how these tests can pass while proving the wrong thing.

**B1 — "recoverable stop" was one automatic retry, then terminalization.** The per-step stop
released the lease, which made the run immediately reclaimable; the recovery sweep re-entered
at once and, if the fresh capture also failed, the run-start guard *terminalized* it. The
decided behavior requires the run to remain recoverably stopped and to resume only after a
later successful capture. An immediately-expired running lease is not a stable recoverable
state.

**B2 — no stable recoverable-stopped state exists in the architecture.** Verified: run
statuses are `pending`, `running`, `completed`, `failed`, `interrupted`, with the last three
in `TERMINAL_RUN_STATUSES`. `interruptAgentRun` terminalizes, so it does not provide these
semantics. `listRecoverableRuns` gates **both** recovery modes on the identical condition —
`status = 'running' AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())` — so a
released lease is claimed immediately and there is no "stopped, awaiting recovery, not yet
retryable" state to adopt.

**B3 — claim race.** Releasing the lease inside the `catch` made the run reclaimable while the
original `runAgentTicket` invocation was still unwinding its `finally`.

**B4 — recovery evidence was existence-based, not transition-based.** The acknowledgement
fired whenever *any* historical `workspace:snapshot_unavailable` event existed, so a later
clean re-entry would emit a duplicate recovery event for an already-resolved failure.

**B5 — the suite proved the wrong thing.** The assertion labelled *"failed recovery capture
cannot resume — the only post-guard path throws"* tested `recoverableStop: false` in the
run-start guard. That is the terminalizing behavior, i.e. the defect. The assertion was
written to match the implementation rather than the requirement, and passing it was reported
as covering scenario 7 ("failed recovery capture remaining stopped"). Source-level assertions
cannot establish lifecycle behavior; that scenario needs real store/server coverage.

**Implementation (`ee44369`, recovery lifecycle superseded by `3f6d4ac`):**
`classifyWorkspaceSnapshotFailure`,
`isWorkspaceSnapshotUnavailable`, `createWorkspaceSnapshotFailureError`, and
`recordWorkspaceSnapshotFailure` in `server.js`; guards at both capture sites; recoverable-stop
branch in the `runAgentTicket` catch; recovery acknowledgement
(`workspace:snapshot_recovered` / `workspace.snapshot_recovered`) emitted after a successful
re-capture. Coverage is split by what each suite can honestly establish:
`scripts/workspace-snapshot-availability-test.js` (93 checks) covers representation,
classification, and transition logic; `scripts/workspace-snapshot-recovery-test.js`
(34 checks) proves the recovery lifecycle against a real server, a real store, and a real
EACCES fault induced with `chmod 000` — all twelve lifecycle scenarios. Both are registered in
the release checkpoint. Purpose-built rather than routed through the orphaned suites — see A10.

`isWorkspaceSnapshotUnavailable` treats only an explicit `available: false` as failure, so
snapshots persisted before this change are read as available rather than retroactively
appearing unreadable.

---

### A2. Live-state vs immutable-snapshot mutation counting (E5)

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Medium — understates required mutations on reruns |
| **Evidence** | `server.js` `countRequiredContractMutations` |
| **Decision required** | Whether feasibility counts against run-start state or live state |

**Description:**

`countRequiredContractMutations(contract, initialWorkspaceSnapshot)` accepts the run-start
snapshot as a parameter and **never reads it**. The body queries live filesystem state
through the module-global `workspaceProvider.getPathInfo`, contradicting two of its own
comments that claim it uses the initial snapshot. On a rerun, artifacts created by a prior
attempt are counted as pre-existing, so the required-mutation count — and therefore the
feasibility projection recorded in `run.feasibility_decision` — understates the real work.

It also reads the module-global provider rather than the run's own provider, which is
questionable for owned-scope runs.

**Constraint:** changing this changes run admission. Separate tranche, with tests.

---

### A3. Wall-clock and progress-counter recovery resets

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | High — no mechanism bounds total run cost across recoveries |
| **Evidence** | `server.js` `runAgentTicket` loop-entry initialization and resume block |
| **Decision required** | Whether these limits are per-run or per-attempt, and which counters must be durable |

**Description:**

At execution-loop entry the runtime rehydrates some state from durable evidence and resets
the rest. Restored: workspace-operation count, model-request count (recomputed from durable
evidence), listed directory paths, current phase, and the action-contract violation streak.
**Not restored:** the run-start timestamp used for the wall-clock check, the `listDirectory`
and `readFile` counters, the stalled-response counter, and the inspection-no-progress counter.

Consequences:

- `maxRuntimeDurationMs` is enforced per loop entry, not per run. A run that recovers N times
  receives N × the configured wall-clock budget. There is no persisted run-start timestamp.
- `maxListDirectoryPerRun` and `maxReadFilePerRun` are named `PerRun` but are enforced per
  loop entry.
- The stall and inspection-no-progress termination counters reset on recovery, while the
  action-contract streak was deliberately made restart-durable (see
  `runtime/action-contract-streak.js`, which documents why). A model can evade the two
  reset counters indefinitely across recovery cycles by exactly the mechanism the streak
  design was built to prevent. `server.js` carries an acknowledging comment
  ("We don't track stalled across restarts").

**Constraint:** fixing the wall clock tightens an effective limit and will fail runs that
previously passed. Stage behind observation.

#### Verdict after Tranche 5 (2026-08-02): CLOSED FOR GOVERNED STRUCTURED LEAF EXECUTION

A3 is now closed for governed structured leaf execution, and remains open outside it. The
boundary is stated precisely because the two halves were closed in different sessions and
it would be easy to over-read the result.

**Closed — governed structured leaf Runs.** For this execution family, every quantity A3
names survives recovery, because every one of them is reconstructed from durable rows
rather than carried in memory:

- cumulative requests survive recovery;
- cumulative operations survive recovery;
- cumulative economic consumption survives recovery;
- no-progress history survives recovery;
- cumulative execution duration survives recovery;
- persisted stops survive recovery.

The duration half — the part left open by the previous verdict — is enforced by
`maximumCumulativeExecutionDurationMs`, a closed progress-policy field captured immutably
on the Run at leaf admission and covered by the policy hash. Elapsed time is derived in
exactly one place, `elapsedExecutionDurationMs`, as the interval between the immutable
execution epoch (the earliest append-only `run.lease_acquired` event) and an evaluation
instant read from the DATABASE clock in the same statement and snapshot that captures the
receipt, reservation and budget cutoffs. Reaching the limit blocks at the pre-reservation
gate, before any provider call, economic reservation or model-request budget charge, and
the stop is persisted as a cutoff-bound block with its own closed reason,
`cumulative_execution_duration_exhausted`.

Two properties are worth stating explicitly because they are what make this a bound rather
than a suggestion. Verified progress resets the consecutive no-progress streak but does
NOT reset cumulative duration — tolerance can be earned back, consumption cannot. And
scheduler queue time is not execution time: a Run that has never been leased has no epoch
and therefore zero duration, so a long wait in the queue cannot exhaust a bound the Run
never began spending.

**Open — every other execution family.** Tranche 5 deliberately did not touch direct, v1,
workflow, browser, process, simulation, or compiler execution. Those families still use
attempt-local counters and per-loop-entry duration behavior: `server.js` `runAgentTicket`
still carries `const stalledResponses = 0; // We don't track stalled across restarts`, and
`maxRuntimeDurationMs`, `maxListDirectoryPerRun` and `maxReadFilePerRun` remain enforced
per loop entry there. A run on those paths that recovers N times still receives N budgets.

**Remaining decision.** Whether to migrate the other execution families onto governed
evaluation or to bound them separately. The staging constraint above still applies to
them: tightening their wall clock will fail runs that previously passed.

#### Verified progress is not credited on the production path (2026-08-02)

| Field | Value |
|-------|-------|
| **Status** | Open — BLOCKS Tranche 5 merge |
| **Severity** | High — verified-progress accounting is a core Tranche 5 behaviour and is absent in production |
| **Evidence** | `persistence/postgres/store.js` `prepareAndReserveNextGovernedRunRequest` passes `satisfiedFactIdentitiesByReceiptId: null`; no production caller supplies it |
| **Decision required** | Where the receipt-to-declared-fact derivation lives, and whether the stop reason should distinguish "no progress" from "progress not measured" |

`evaluateGovernedRunProgress` accepts a mapping from durable receipt identities to the
declared-work facts they newly satisfy. The classification, the four levels and the
tolerance arithmetic all consume it correctly. Nothing in production builds it.

Consequences on the governed structured leaf path:

- `verifiedProgressCount` is always 0;
- the consecutive no-progress streak grows on every governed window;
- a Run stops at `maximumConsecutiveNoProgressWindows` with reason
  `verified_progress_exhausted` regardless of whether it advanced declared work;
- the Ticket projection always reports `totalVerifiedProgressFacts: 0`.

This is not an economic safety defect: the error is conservative, stopping earlier than
the captured policy intends and never permitting extra spend. It is a truthfulness
defect in the explanation given to an operator, which is why it is recorded here rather
than treated as acceptable rounding.

**Reclassified 2026-08-02 after merge-readiness audit.** This was first recorded as a
non-blocking documented boundary. That was wrong: false blocking is incorrect execution
authority, and a persisted stop reason that can be untrue is not made acceptable by
erring toward less spend. It blocks merge.

**Why it cannot be wired inside Tranche 5.** The audit traced every candidate authority.
An evaluator exists (`directPostconditionResult`), an identity rule exists (typed
`criterionHash`), and an objective compiler exists (`buildObjectiveContract`). The
DURABLE SUBSTRATE does not. `run:postcondition_completed` claims are written by
`recordRunEvent` into `replay_snapshots` — one mutable row per run (`run_id PRIMARY KEY`,
`revision` counter), items stamped `capturedAt: new Date()` (process clock), no per-item
monotonic id. The append-only path `buildRunPostconditionEvidence` returns `null` unless
`executionMode === 'workflow'`; governed leaf Runs are `agent`. No migration defines a
postcondition table or column.

That substrate admits no cutoff (`id <= N` is not expressible), would make the process
clock the ordering authority, and is rewritten in place. Feeding it into governed
progress evaluation would break the stable-cutoff proof, the database-time proof, and the
A3 closure that rests on both. Deriving satisfaction from `operation_receipts` instead
would require a second independent postcondition evaluator, which is precisely the second
authority this tranche exists to avoid.

**Prerequisite to close.** A durable, append-only, database-ordered postcondition-result
record — a typed-evidence seam writing deterministic postcondition results to an ordered
table with a monotonic id and a database timestamp, as `operation_receipts` and `events`
already do. Owner: the typed-evidence work, not churn control.

**Do not**, while this is open: weaken the contract to call candidate progress verified;
describe `verified_progress_exhausted` as proof that no declared work advanced; or merge
Tranche 5 as feature-complete. A3's persistence closure is scoped separately and is
unaffected — see the A3 verdict above.

#### Tranche 5 coordination scope deliberately NOT implemented (2026-08-02)

Recorded here so no later reader infers these were overlooked rather than declined.
None is a defect, and none is planned as part of Tranche 5:

- **dependency DAGs** — structured siblings have no ordering and no graph;
- **sibling waiting or ordering** — an unverified sibling read is refused and the
  reading Run stops; waiting would be a dependency by another name;
- **shared-decision registry** — no generic decision-claim store exists;
- **advisory review Workflow steps**;
- **automatic retry**, **automatic replanning**, **automatic rerouting** — the churn
  decision vocabulary is exactly `continue | blocked`;
- **automatic unblocking** — a persisted block is the decision of record and is never
  reopened by the runtime;
- **generic coordination messaging** between Runs;
- **Tranche 6 behavior** — controlled evaluation and the product decision.

A separately authorized retry Run is unaffected by any of the above: it receives its own
execution epoch, its own captured policy and its own duration authority. What does not
happen is the runtime creating one on its own.

**Interacts with A12.** Because each recovery re-entry restarts the wall clock, no runtime
limit currently bounds A12's indefinite snapshot-recovery cycling. Fixing A3 alone would
silently impose a bound there; the two must be decided consistently.

---

### A4. Enforcement gates bypass the immutable policy snapshot

| Field | Value |
|-------|-------|
| **Status** | Open — partially addressed by `a1143e6` |
| **Severity** | Medium — split-brain policy resolution |
| **Evidence** | `runtime/execution-semantics.js`; per-response ceilings in `server.js` |
| **Decision required** | Whether a single resolved policy envelope should be the only input to enforcement |

**Description:**

A real immutable envelope exists and is written before dispatch (`run.runtimeLimitsSnapshot`,
`run.executionPolicySnapshot`, `run.routingSnapshot`, `replaySnapshot.runtimeEnvelope`).
Roughly half the enforcement gates read it; the rest independently re-read process constants,
environment flags, and live regex evaluation of ticket text at the moment they fire.

`a1143e6` made the semantic controls **recordable and reconstructable** — every run now
persists `runtimeLimitsSnapshot.semantics` — but deliberately did **not** change which values
the gates consume. The record is descriptive only; no gate branches on it.

The candidate direction is a single `resolvedExecutionPolicy` produced before dispatch, with
enforcement consuming only that. Two constraints if it is pursued: the process constants must
become *unreachable* from gate code (otherwise this adds a third source of truth rather than
removing the second), and regex-derived values must be resolved once at dispatch. Adding
per-key provenance (`value` + `source: default|env|ui|profile|ticket`) is cheap and directly
answers "why was this limit this value".

---

### A5. Workload-profile re-resolution

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Low — requires an objective edit mid-flight to manifest |
| **Evidence** | `server.js` `detectWorkloadProfile` call sites: run creation and runtime-envelope construction |
| **Decision required** | Whether the profile is resolved once at dispatch |

**Description:**

`detectWorkloadProfile` runs twice against different inputs at different times: once at run
creation, where its result is snapshotted into the runtime-limits snapshot, and again on
every runtime-envelope build against the **live** `ticket.objective`. Ticket objectives are
mutable. Editing an objective between run creation and execution makes the model's envelope
disagree with the limits actually enforced, and nothing detects the divergence.

Note also that the profile is *inferred from objective text by regex*, not selected by an
operator, and that profile matching can only tighten step/request/operation limits
(`Math.min`) while it sets the `listDirectory`/`readFile` limits outright.

---

### A6. Gate ordering vs prefix truncation

| Field | Value |
|-------|-------|
| **Status** | **Governance decision required** — do not implement unilaterally |
| **Severity** | Medium |
| **Evidence** | Run #8; total-action and mutating-action gates in `server.js` |
| **Governing memo** | `decision-record-truthfulness-over-boundedness.md` (status: *Governance decision pending*) |
| **Decision required** | Whether an over-limit response is salvaged or rejected whole |

**Description:**

Two per-response gates run in order. The total-action gate (>`MAX_AGENT_ACTIONS_PER_RESPONSE`)
rejects the whole response and returns. The mutating-action gate
(>`MAX_MUTATING_ACTIONS_PER_RESPONSE`) has a prefix-truncation path behind
`ENABLE_PREFIX_TRUNCATION` that executes the first N mutations and continues.

Because the total gate returns first, a response exceeding the total ceiling can never reach
truncation **regardless of the flag**. Prefix truncation is therefore live only in the narrow
band of ≤8 total but >2 mutating actions — never for the failure shape it was built for.
Run #8 (26 actions, twice) is exactly that shape and terminated with zero mutations.

**Do not "fix" this as a bug.** Making the total gate salvage rather than reject is the
truthfulness-vs-boundedness tradeoff whose decision record is still pending. Note also that
for run #8 the current behavior produced the *better* outcome: truncation would have made
partial mutations and then died on the wall clock, replacing a clean, correctly classified
contract failure with a partial-mutation timeout.

**Prerequisite:** `ENABLE_PREFIX_TRUNCATION` is now recorded per run (`a1143e6`), so any
change here is observable in evidence. It was not before.

---

### A7. Objective-grammar anchoring

| Field | Value |
|-------|-------|
| **Status** | **Governance decision required** — do not implement unilaterally |
| **Severity** | Medium |
| **Evidence** | `objective-contract.js` create-range recognizer |
| **Governing memo** | `decision-memo-objective-interpretation-direction.md` — read before touching objective parsing |
| **Decision required** | Whether recognizers tolerate trailing locative phrases |

**Description:**

The create-range recognizer is anchored with `$`, so a trailing prepositional phrase defeats
recognition. Verified empirically:

```
"create folders A-Z in the workspace" -> recognized: false, intent: model_driven, 0 mutations
"Create folders A-Z"                  -> recognized: true,  26 mutations
"create folders A through Z"          -> recognized: true,  26 mutations
```

For run #8 this silently disabled the feasibility gate entirely: with no enumerable contract,
`countRequiredContractMutations` returned null and the gate skipped. As of `a1143e6` that skip
is no longer silent — it emits `run:feasibility_decision` with
`outcome: skipped_unrecognized_objective` — but the recognition behavior itself is unchanged.

The governing memo freezes the deterministic grammar at its current scope, with existing
recognizers to be *audited* rather than grandfathered. This entry is that audit finding.

---

### A8. Remaining dead `allow*` policy fields

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Low — the UI is already honest about it |
| **Evidence** | `server.js` `copyExecutionPolicy`; `views/run-detail.ejs`, `views/ticket-detail.ejs`; Tranche 5 `runtimeBudgetSnapshot` |
| **Decision required** | Implement enforcement or formally retire the fields |

**Description:**

`executionPolicy.allowWorkspaceWrites` and `allowChildTickets` remain normalized,
snapshotted intent fields without their own implementation. The UI labels them as recorded
intent, and labels child-ticket creation explicitly as not implemented.

Tranche 5 resolved the other items that used to be grouped here. `allowParallelRuns` is
captured in `runtimeBudgetSnapshot` and enforced by scheduler admission. Nullable numeric
budget overrides — including attempts, execution steps, runtime, model, workspace,
process, browser, and aggregate output-artifact limits — resolve to concrete immutable
values at admission and are enforced. `maxAttempts` bounds manual and enabled automatic
retry admission; a null override inherits the runtime default rather than disabling retry
or granting unlimited attempts. Historical runs without a runtime-budget snapshot retain
an explicitly historical advisory display.

---

### A9. Latency-aware feasibility

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Medium |
| **Evidence** | `server.js` `assertRuntimeBudgetFeasible`; run #8 timings |
| **Decision required** | Which budget dimensions feasibility must consider before dispatch |

**Description:**

The feasibility gate checks exactly one relation: projected steps against
`maxExecutionSteps`. It does not consider the model-request budget (each step costs roughly
one request), the wall clock, observed provider latency, the workspace-operation budget, or
whether the workspace snapshot was truncated beyond the model's visibility.

Run #8 illustrates the gap: 24 required mutations at a cap of 2 project to 12 steps against a
limit of 32 — comfortably "feasible" — while the observed 113–169 s per model call put the
real cost at roughly 1400–2000 s against a 400 s ceiling. Provider and model are already known
at dispatch (`run.routingSnapshot`), so latency is available and unused.

As of `a1143e6` the gate's decision and its resolved inputs are durable on every path
(`run:feasibility_decision` / `run.feasibility_decision`), so any added dimension is
measurable against existing evidence. **What the gate enforces was deliberately not widened.**

---

### A10. Orphaned PostgreSQL-era test harnesses

| Field | Value |
|-------|-------|
| **Status** | **Resolved for the inventoried 14.** All fourteen are migrated, individually green, registered in the release checkpoint, and pinned as mandatory. A wider orphan population found during the tranche is recorded below and is **not** resolved |
| **Severity** | High — the release checkpoint had no working feasibility or postcondition coverage |
| **Evidence** | Baselined at commit `3a73a13` in a detached worktree; failure strings identical to current HEAD |
| **Decision required** | Repair, port, or retire each harness — **decided per suite below** |

**Description:**

These suites fail at HEAD. They are legacy JSON-era harnesses orphaned by the PostgreSQL
cutover: each spawns a server without setting `DATABASE_URL` and dies with
`Error: DATABASE_URL is required for the PostgreSQL runtime`.

- `scripts/runtime-feasibility-test.js`
- `scripts/ticket-feasibility-gate-test.js`
- `scripts/postcondition-completion-test.js`
- `scripts/direct-folder-postcondition-completeness-test.js`
- `scripts/resume-obvious-postcondition-test.js`
- `scripts/recovery-regression-test.js`
- `scripts/startup-data-integrity-test.js`
- `scripts/run-diagnostics-bundle-test.js`
- `scripts/run-detail-evidence-clarity-test.js`
- `scripts/bounded-transition-test.js`
- `scripts/replay-snapshot-storage-test.js`
- `scripts/runtime-limits-config-test.js`
- `scripts/runtime-limits-ui-test.js`
- `scripts/renamepath-runtime-regression-test.js` *(added 2026-07-25: same JSON-era cause —
  9 `DATA_DIR` references and the identical `DATABASE_URL is required` failure. Missed by the
  original inventory.)*

`scripts/execution-semantics-test.js` fails for a *different* reason — it asserts helpers that
no longer exist — and is **not** part of this storage migration. It is tracked separately as
**A13**, together with four sibling scripts that fail the same way. It is unrelated to
`scripts/execution-semantics-snapshot-test.js`, which is current and passing.

None are registered in `CHECKPOINT_TEST_SCRIPTS` or `POSTGRES_INTEGRATION_SCRIPTS`, so
`npm run checkpoint:release` stays green while they rot.

This gap is why `a1143e6` wrote feasibility coverage as executed code inside
`scripts/evidence-truthfulness-contract-test.js` (all six outcome paths against stubs) and
`scripts/execution-semantics-persistence-test.js` (the `passed` path through real dispatch),
rather than extending `runtime-feasibility-test.js`.

**Method note for whoever picks this up:** before treating any suite failure as a regression,
baseline it at the relevant commit in a detached worktree and compare failure strings. Most
failures in this list are pre-existing.

### Audit findings (2026-07-25) — repair is a migration, not a configuration fix

Re-audited against clean `master` (`c062af6`); all fourteen still fail. The missing
`DATABASE_URL` is the *first* error each hits, but it is **not** the only defect:

1. **`DATA_DIR` is read nowhere.** `grep -c 'process.env.DATA_DIR' server.js` returns **0**.
   Every one of these harnesses seeds `data/*.json` into a temporary `DATA_DIR` and then
   asserts by re-reading those files. The PostgreSQL server ignores that directory entirely,
   so simply supplying `DATABASE_URL` would let the server boot and then fail every assertion,
   because the seeded fixtures would not exist and the asserted state would never be written
   there. Repair therefore requires migrating **seeding and assertions** onto the store, not
   just adding an environment variable.

2. **All thirteen server-based harnesses are JSON-era.** None references
   `PostgresRuntimeStore`; all spawn a server and use `DATA_DIR` plus JSON reads
   (~4,750 lines total). Each also carries its own copy of the same ~90 lines of scaffolding
   (HTTP client, readiness poll, login, spawn, cleanup), which is why the cutover orphaned
   them all simultaneously.

3. **The startup data-integrity contract no longer exists.** `validateUniqueIntegerIds`
   (`server.js`) is **defined but never called** — its only occurrence is its own definition.
   The JSON-era startup refusal it powered (duplicate ids, malformed flat-file records) was
   removed by the cutover, and PostgreSQL enforces that class of integrity structurally through
   primary keys and constraints. `scripts/startup-data-integrity-test.js` therefore asserts a
   behavior the runtime no longer has. The dead helper is a small residual defect in its own
   right and should be removed or re-wired by whoever decides that contract's future.

### Final disposition (complete)

**Restoration count: 14 of 14.** A suite counts as restored only when its migrated test
executes and passes its intended behavioral assertions. Neither a scenario inventory nor an
audit plan counts as restoration.

All fourteen are registered in `POSTGRES_INTEGRATION_SCRIPTS` and pinned as mandatory by
`scripts/release-checkpoint-coverage-test.js`, so dropping one now fails the checkpoint. That
pin is the actual fix for the original defect: the suites did not rot because they were hard
to maintain, they rotted because nothing failed when they were absent.

**570 assertions across the fourteen suites.**

| Harness | Disposition | Status |
|---------|-------------|--------|
| `ticket-feasibility-gate-test.js` | Repair and retain | ✅ Migrated — 22 assertions |
| `resume-obvious-postcondition-test.js` | Repair and retain | ✅ Migrated — 15 assertions |
| `direct-folder-postcondition-completeness-test.js` | Repair and retain | ✅ Migrated — 14 assertions |
| `runtime-feasibility-test.js` | Repair and retain | ✅ Migrated — 76 assertions |
| `recovery-regression-test.js` | Repair and retain | ✅ Migrated — 47 assertions |
| `postcondition-completion-test.js` | Repair and retain | ✅ Migrated — 140 assertions, 20/20 scenarios |
| `startup-data-integrity-test.js` | **Replace** — the JSON `DATA_DIR` refusal mechanism no longer exists | ✅ Migrated — 14 assertions; **was vacuous, repaired** (below) |
| `run-diagnostics-bundle-test.js` | Repair and retain | ✅ Migrated — 35 assertions |
| `run-detail-evidence-clarity-test.js` | Repair and retain | ✅ Migrated — 15 assertions |
| `bounded-transition-test.js` | **Repair, two scenarios re-expressed** — the phase gate and the action-contract streak superseded them | ✅ Migrated — 31 assertions |
| `replay-snapshot-storage-test.js` | **Repair with the extraction-helper third retired** — separation is now structural | ✅ Migrated — 17 assertions |
| `runtime-limits-config-test.js` | Repair and retain | ✅ Migrated — 88 assertions |
| `runtime-limits-ui-test.js` | Repair and retain | ✅ Migrated — 34 assertions |
| `renamepath-runtime-regression-test.js` | Repair and retain | ✅ Migrated — 22 assertions |
| `execution-semantics-test.js` | **Not in A10** — see A13 | Tracked separately |

### `startup-data-integrity-test.js` passed while asserting nothing (found and fixed 2026-07-25)

Recorded prominently because it is the most transferable lesson in this tranche, and
because the suite had already been counted as restored.

The migrated suite spawned the server with only `DATABASE_URL`, `POSTGRES_SCHEMA`,
`WORKSPACE_ROOT`, `NODE_ENV` and `PORT`. It supplied no `SESSION_SECRET`, so **both**
scenarios died at `resolveSessionSecret` before reaching any storage code. Every
assertion — non-zero exit, no default admin in the output, no leaked bootstrap
password — held trivially, because a process that dies on line 122 satisfies all
three. It also passed `DATABASE_SCHEMA`, which nothing reads (`server.js` reads
`POSTGRES_SCHEMA`), so its "structurally unusable schema" scenario never pointed the
server at the schema it had corrupted.

Three changes, and the assertion count went 8 → 14:

1. `POSTGRES_SCHEMA`, plus `SESSION_SECRET` and a per-run random
   `ADMIN_BOOTSTRAP_PASSWORD`, so the server reaches storage and the leak assertion is
   about *this run's* secret rather than the historical `admin123` literal.
2. **A positive control (scenario 0).** The same binary and the same environment
   against an intact migrated schema must reach `/health` ready and must print
   `Default admin user created`. This is what makes the refusals attributable: only
   the injected fault differs between scenario 0 and scenarios 1–2, and the control
   proves the bootstrap line appears when bootstrap actually runs — so its absence in
   the refusal scenarios is evidence rather than an accident.
3. Each refusal must name its cause (`expectedCause` regex), so a refusal for an
   unrelated reason no longer counts.

**The general rule this establishes: a refusal test is worthless without a positive
control.** "Exit code was non-zero" is satisfied by every crash, including the ones
that never reach the behavior under test.

### Dead JSON-era behavior that was retired rather than ported

Repair was not mechanical everywhere. Where the runtime had moved, the retired
assertion is recorded here so a future reader can tell a deliberate retirement from an
accidental omission.

**`bounded-transition-test.js` — two scenarios re-expressed.**

- The suite expected a *mixed* inspection+mutation batch to execute and record four
  workspace operations. That batch shape is now rejected by the **execution phase
  gate** (`execution.phase_violation`, "actions belong to different execution phases"),
  which did not exist when the suite was written; nothing is executed. The scenario now
  proves the two gates are DISTINCT — the mutating cap accepts the batch
  (`model:action_contract_passed`) and the phase gate then rejects it — and a new
  at-cap same-phase scenario covers the boundary the old assertion was reaching for.
  (The ordering of those two gates is A6's open governance question; this suite only
  records the current behavior, it does not endorse it.)
- The suite pinned the failure to the string *"Model repeatedly proposed too many
  mutating actions; no workspace mutations were executed."* and to a
  `run:mutating_action_limit` event. Neither exists: the mutating-action gate was
  folded into the unified action-contract streak (`runtime/action-contract-streak.js`),
  which terminates through `MODEL_RESPONSE_CONTRACT_VIOLATION` and records
  `model:no_progress`. The live structured classification is asserted instead. Streak
  *semantics* stay with `model-contract-violation-test.js`; this suite owns only that
  the mutating cap was the gate that fired.

**`replay-snapshot-storage-test.js` — the extraction helper retired.** A third of the
suite drove `scripts/extract-replay-snapshots.js`, a one-shot JSON-era migration that
lifted an inline `run.replaySnapshot` out of `runs.json` into
`data/replay-snapshots/run-N.json` and left a `replaySnapshotPath` pointer. It reads
`DATA_DIR`; separation is now structural (a `replay_snapshots` table keyed by run id)
rather than the product of a migration step. The suite now asserts the PROPERTY that
migration existed to establish: the run row holds no snapshot payload, the snapshot
round-trips through its own record, and both consumers — run detail and the `oquery`
CLI — hydrate it from there.

**`runtime-limits-config-test.js` / `runtime-limits-ui-test.js` — renamed surfaces.**
`concurrencyLimits.process` and `concurrencyLimits.activeProcessRuns` no longer exist;
the status payload now distinguishes the deployment-scoped cap (`maxActiveRuns`) from
this process's occupancy (`localProcess.admittedRuns`), and both are asserted. The
admin form label "Max active runs in this **process**" is now "in this **deployment**".

**Residual JSON-era artifacts, not fixed here.** `scripts/extract-replay-snapshots.js`
is dead (reads `DATA_DIR`, produces a layout that no longer exists), as is
`validateUniqueIntegerIds` in `server.js` (defined, never called — already noted in the
audit findings above). Both are small disposition decisions in their own right and are
deliberately left alone by a test-only tranche.

### Two migration hazards worth knowing

- **Crashed-run leases.** `TEST_INTERRUPTION_POINT` SIGKILLs the process, so the run keeps a
  lease nobody can renew and recovery cannot claim it until that lease expires. A resume test
  must shorten `RUN_LEASE_DURATION_MS` in its own environment or it will appear to hang for the
  default 180s. This is a test-environment knob only.
- **`jsonb` does not preserve key insertion order.** Assertions ported from the JSON era that
  compared payloads with `JSON.stringify` fail for that reason alone. Compare structurally;
  element order is usually part of the contract, key order never is.

### Mutation testing: proving the restored suites are not vacuous

`scripts/suite-mutation-test.js` breaks one runtime contract at a time and requires
the corresponding suite to FAIL. It exists because `startup-data-integrity-test.js`
demonstrated that green and vacuous are not mutually exclusive, and "the migrated suite
passes" is therefore not evidence that it still catches anything.

Run it explicitly — it is **deliberately not in the release checkpoint** because it
edits tracked source in place:

```
TEST_DATABASE_URL='postgresql://...' node scripts/suite-mutation-test.js
```

It refuses to start if any file it would mutate has uncommitted changes, restores every
file in a `finally` and on SIGINT/SIGTERM, and verifies the restore by SHA-256.

| Mutation | Contract removed | Suite | Result |
|----------|------------------|-------|--------|
| `startup-fails-open` | a startup guard failure exits non-zero | `startup-data-integrity-test.js` | killed |
| `mutating-action-cap` | a response may propose at most 2 mutating actions | `bounded-transition-test.js` | killed |
| `renamepath-conflict-carveout` | renamePath may consume a path this run created | `renamepath-runtime-regression-test.js` | killed |
| `diagnostic-count-wording` | count wording is status-aware | `run-diagnostics-bundle-test.js` | killed |

**Two lessons from building it, both recorded in the script itself.**

- *A surviving mutation means one of two different things.* The first aim at the
  startup suite removed `access_users` from the required-relation list and SURVIVED —
  not because the suite was vacuous, but because dropping that table also breaks
  bootstrap, which fails closed independently. Defense in depth means removing one
  layer does not remove the contract. The mutation was re-aimed at the exit code.
- *A kill can be false.* The first renamePath mutation deleted only the carve-out
  clause and left `$5`/`$6` bound, so the query failed to parse. The suite failed —
  proving nothing. A mutation must yield a runtime that is **wrong**, not one that is
  **broken**.

### `postcondition-completion-test.js` scenario inventory

Recorded before migration, per the A10 discipline. Retained as the contract record; the
suite is now migrated and passing at 140 assertions across all 20 scenarios.

 20 scenarios across 1,266 lines, driven by a
shared `runScenario(preloadPath, agent, objective, envOverrides, expectations)` helper and a
single `global.fetch` preload that branches on the objective string. Each scenario restarts the
server with its own budget overrides, so per-scenario limits are part of the contract.

Only the first eight concern postcondition completion directly. Scenarios 9–19 use the same
harness to cover **workflow draft intents and handoff tasks** — they assert
`expectNoPostcondition` plus scenario-specific verification, and are distinct regressions that
must not be collapsed together.

| # | Objective shape | Budget (steps/reqs) | Expected outcome | Negative condition guarded |
|---|-----------------|---------------------|------------------|----------------------------|
| 1 | `postcondition-create-folder-file` | 4/4 | completed, postcondition fired, ≤N steps | completion must not need extra model turns |
| 2 | `postcondition-repeated-write` | 4/4 | completed, postcondition fired, ≤N steps | repeated identical write must not loop |
| 3 | `postcondition-repeated-write` (tight) | 3/3 | completed, postcondition fired, ≤N steps | must complete before exhausting a tighter budget |
| 4 | `postcondition-failed-op` | 4/4 | **no** postcondition | a failed operation must never satisfy a postcondition |
| 5 | `postcondition-mixed-read` | 4/4 | no postcondition, ≥N steps | inspection mixed with mutation must not shortcut |
| 6 | `workspace-objective-satisfied` (write note) | 3/3 | no postcondition | workspace-satisfied path must not fire the postcondition path |
| 7 | `workspace-root-objective-satisfied` | 3/3 | terminal status only | root-scoped objective resolves without shortcut |
| 8 | `postcondition-non-obvious` | 4/4 | completed, postcondition fired, ≤N steps | non-obvious objectives still complete deterministically |
| 9 | `workflow-draft-valid` | 3/3 | no postcondition, `expectedRevision` | a valid draft persists at the expected revision |
| 10 | `workflow-draft-intent` | 3/3 | no postcondition | draft intent recorded, not executed |
| 11 | `workflow-draft-intent-action-postconditions` | 3/3 | no postcondition | action-level postconditions captured on the intent |
| 12 | `workflow-draft-intent-both-postconditions` | 3/3 | no postcondition | both draft- and action-level postconditions captured |
| 13 | `workflow-draft-intent-action-note` | 3/3 | no postcondition | action notes preserved |
| 14 | `workflow-draft-intent-numeric-id` | 3/3 | no postcondition | numeric ids normalized rather than rejected |
| 15 | `workflow-branching-unsupported` | 3/3 | no postcondition | branching objectives are not misfiled as draft-intent failures |
| 16 | `handoff-valid` | 3/3 | no postcondition | a valid handoff task is created |
| 17 | `handoff-invalid-path` | 3/3 | no postcondition | an out-of-scope handoff path is rejected |
| 18 | `handoff-unknown-executor` | 3/3 | no postcondition | an unknown executor is rejected |
| 19 | `workflow-draft-invalid` | 3/3 | no postcondition | an invalid draft is rejected, not silently stored |
| 20 | `compiled-partial-completion` | 3/4 | completed, postcondition fired, ≥N steps | a compiled contract must not complete on partial state |

**Mapping to current runtime.** All 20 objective shapes still route through live code paths:
`checkPostconditionCompletion`, `checkObjectiveContractPostcondition`, the workflow
draft-intent surface, and `createHandoffTask`. Nothing in the inventory asserts a removed
helper, so this suite is a **repair**, not a replacement or retirement.

**Established port mappings** (verified against the current store while inventorying, so the
next porter does not re-derive them):

| JSON-era access | PostgreSQL replacement |
|-----------------|------------------------|
| `run.replaySnapshot` | `(await store.readRunReplay(runId)).snapshot` |
| `readJson('runs.json')` lookup | `store.listRuns({ limit })` then `store.getRun(id)` |
| `readJson('tickets.json')` | `store.listTickets({ limit })` / `store.getTicket(id)` |
| `readJson('workflows.json')` | workflow-catalog store methods (`persistence/postgres/workflow-catalog-methods.js`) |
| `readJson('operation-history.json')` | `store.listRunOperations(runId, { limit })` |
| `readJson('logs.json')` | `store.listLogs({ types, runId, ticketId, limit })` |
| `events.jsonl` filtered by run | `store.listRunEvents(runId, { afterSeq: -1, limit })` |
| `waitForEvent(predicate)` | poll `store.listRunEvents` for the predicate |
| seeded `agents.json` entry | `store.createConfiguredAgent({ value, groupIds, changedBy })` |
| seeded group / membership | `store.createGroup({ value, changedBy })` + agent `groupIds` |

`runScenario(preloadPath, agent, objective, envOverrides, expectations)` ports cleanly: its
`startServer(preloadPath, envOverrides)` becomes the harness `startServer({ NODE_OPTIONS,
...envOverrides })`, and its `expectations.verify({ run, ticket, snapshot, cookie })` callback
keeps the same shape with `snapshot` sourced from `readRunReplay`. The helper's structure is
worth preserving rather than flattening — it is what keeps the twenty scenarios independent.

**Port note.** The per-scenario server restart is intrinsic to the contract (each scenario
asserts behavior under its own budget), so the migrated suite must keep restarting the server
per scenario through the shared harness rather than sharing one server.

### Repair mechanism

`scripts/postgres-test-harness.js` — one shared bootstrap the orphaned suites migrate onto,
rather than thirteen independent patches. It provides an explicit test database URL with loud
failure when absent, one isolated `tstharness_*` schema per test process, deterministic
migration, deterministic cleanup on success *and* failure, age-based reaping of schemas left by
interrupted runs, and a real server spawn with readiness polling and login. It has no JSON or
in-memory fallback: these suites must exercise the PostgreSQL runtime because that is what
production uses. It deliberately does not abstract what any suite asserts.

### A10's inventory of fourteen badly understates the orphan population (found 2026-07-25)

**This is the one part of A10 that is NOT resolved, and it is larger than what was
fixed.** While migrating the last six suites, two more JSON-era orphans surfaced that
drive the *same* cross-ticket-delete contract as `run-diagnostics-bundle-test.js`:

- `scripts/concurrency-conflict-test.js` (12 `DATA_DIR` references)
- `scripts/run-detail-permissioned-delete-audit-test.js` (9 `DATA_DIR` references)

Neither references `PostgresRuntimeStore` or the shared harness, and neither is
registered in the checkpoint. Sweeping for the general shape — a script under
`scripts/` matching `*-test.js` that references `DATA_DIR` and references neither
`postgres-test-harness` nor `PostgresRuntimeStore` — returns **96 files**:

```
for f in scripts/*-test.js; do
  if grep -q "DATA_DIR" "$f" && ! grep -q "postgres-test-harness\|PostgresRuntimeStore" "$f";
  then echo "$f"; fi
done | wc -l
```

**What this count does and does not establish.** It is a *candidate* list, not 96
confirmed failures. It certainly includes false positives — suites that only mention
`DATA_DIR` in a comment, and deliberately-skipped live-provider suites such as
`live-openai-test.js` and `allocated-live-openai-test.js`. The two named above were
individually confirmed to be genuine JSON-era orphans. The rest have **not** been
executed or triaged.

**Why it matters anyway.** A10's framing — "fourteen suites" — implied the orphaned
population was bounded and now cleared. It is not. The fourteen were the ones somebody
happened to notice; the cutover orphaned suites in bulk and nothing detected it,
because the checkpoint never ran any of them. Closing A10's inventory without recording
this would leave the next reader believing the verification gap is closed when the
majority of it has not even been measured.

**Not done here, deliberately.** Triaging ~96 candidate scripts is a tranche of its own
and is not test-migration work that can ride along with fourteen suites. It needs its
own inventory pass: execute each, classify (genuine orphan / false positive /
intentionally-excluded live-provider suite), then repair, replace, or retire with the
reason recorded — the same discipline this entry established.

**Recommended next step:** open a successor entry scoped to that sweep, with
`concurrency-conflict-test.js` and `run-detail-permissioned-delete-audit-test.js` as
its confirmed seed set, since both guard the cross-ticket-delete authority contract
that only `run-diagnostics-bundle-test.js` currently covers.

**Done — see A20.** The sweep was executed rather than inferred. The real orphan count
is **83**, not ~96: all 96 candidates do reference `DATA_DIR` in executable code (there
were no comment-only false positives, contrary to the caution recorded above), but 13
are legitimately excluded rather than orphaned. Both seed suites are repaired and
registered. A20 also found seven orphans that **exit zero while asserting nothing**, a
class no grep sweep could have surfaced.

---

### A17. Delegated handoff logging crashes the server process

| Field | Value |
|-------|-------|
| **Status** | **Open — implementation required** |
| **Severity** | **Critical** — one diagnostic-log identity mismatch terminates the entire Node process |
| **Scope** | Production runtime defect. Surfaced by A10; **not** an A10 test-migration issue |
| **Evidence** | Read-only probe against `master` `f0a18be`; stack, events, and receipts below |
| **Decision required** | Separate the run's owner identity from the acting executor, and contain run-log failures |

**Proven behavior.**

A valid handoff task — planner delegates one `writeFile` to an existing executor agent — kills
the server. Observed stack:

```
Error: run 1 was not found with the supplied ticket and agent authority
    at PostgresRuntimeStore.appendRunLog (persistence/postgres/store.js:2125)
  code: 'POSTGRES_RECORD_NOT_FOUND'
```

**Mechanism.** `appendRunLog` resolves the run row with an identity predicate that includes the
acting agent:

```sql
FROM runs WHERE id = $1 AND ticket_id = $2 AND agent_id = $3
```

`agentId` is read from the passed run object (`persistence/postgres/store.js`, `appendRunLog`;
entered from `server.js` `appendRunLog(run, type, message, workspaceAction, extraFields)`).
During handoff execution the runtime acts as the **executor**, while the run is owned by the
**planner**. The predicate therefore matches no row, `rowCount === 0`, and the method throws.
The rejection is unhandled and the process exits.

**Identities in the observed run:** run owner / planner `agentId = 1`; delegated executor
(`Mike`) `agentId = 2`.

**The delegated work itself is correct.** Authority was evaluated and granted under the executor
identity, and the mutation committed durably:

```
authorityChecks: [{ actor: "agent:2", status: "allowed", path: "handoff-note.md" }]
receipts:        ["writeFile:succeeded"]
handoffTasks:    [{ status: "validated", plannerAgentId: 1, executorAgentId: 2 }]
```

**Last durable events** (journal, in order):

```
… handoff.task_validated, authority.allowed, workspace.operation_prepared, workspace.operation
```

**First expected evidence that never occurs:** the handoff task's transition to `executed`, and
any terminal evidence. `lastHeartbeatAt` freezes at the moment of the workspace operation.

**Process and run aftermath.** The server process exits (`/health` → `ECONNREFUSED`, non-null
`exitCode`). The run is left **falsely `running`** with a live lease and **no terminal error**,
so nothing distinguishes it from healthy in-flight work until the lease expires. Every other
concurrent run in that process is abandoned the same way.

**Impact.** The capability documented in `server.js` — *"Planner may create one validated
writeFile handoff to one existing executor agent; runtime executes directly through workspace
authority"* — is unreachable in practice: any valid handoff reproduces this. A single
diagnostic-log identity mismatch is amplified into a process-wide outage.

**Natural blocked regression.** `postcondition-completion-test.js` scenario 16 (`handoff-valid`)
times out waiting for a terminal run, because the server that would terminalize it is gone. The
scenario is **unchanged and remains blocked**; it is the contract this entry protects.

**Ruled out.** Not mutation-admission starvation — nothing was waiting; `waitForAdmissionChange`
is not implicated. Not an A10 fixture defect — the executor agent resolved, authority was
granted, and the mutation succeeded. Not a runtime-duration defect — the process died rather
than overrunning a budget.

**Two defects, to be proven separately.** (1) Delegated execution substitutes the executor for
the run's owner in the log identity predicate. (2) A failed run-log append becomes an unhandled
rejection that terminates the process rather than failing that run closed.


**Outside-`runAgentTicket` caller classification (complete).** The rule: a required
log inside an execution path with a guaranteed later drain may use tracked
`appendRunLog`; outside such a path it must use `appendRequiredRunLog` or an
explicit settle boundary before the guarded transition returns success; only the
five listed terminal echoes may be best effort after authoritative terminal state.
A marker with no consumer is invalid.

| Caller | Log type | Class | Boundary | Guarded transition | Failure outcome | Cleanup |
|---|---|---|---|---|---|---|
| `runAgentTicket` | `run:started` | Required | `appendRequiredRunLog` — rejection propagates | run start | run fails closed | `commitRunTerminalization` |
| `runAgentTicket` (27 exec-phase sites) | model/workspace/postcondition events | Required | Loop gate drains before next model request or mutation | step + action execution | run fails closed, `EVIDENCE_PERSISTENCE_FAILED` | `commitRunTerminalization` |
| `completeAgentRunUnlocked` | `run:completed`, `run:verification_failed` | **Best effort** | none needed — post-terminal echo | none | logged to stderr, run unaffected | n/a (never marked) |
| `failAgentRunUnlocked` | `run:failed`, `run:failed_auto_retried` | **Best effort** | none needed — post-terminal echo | none | stderr, run unaffected | n/a |
| `interruptAgentRunUnlocked` | `run:interrupted` | **Best effort** | none needed — post-terminal echo | none | stderr, run unaffected | n/a |
| `reconcileTerminalRunUnlocked` | `run:reconciled` | Required | `settleTerminalRunEvidence` → `recordRequiredReplayEvent` | terminal reconciliation | durable `run.reconciliation_evidence_failed` | `releaseRunEvidenceTracking` |
| `interruptStaleRunsOnStartup` | `run:terminalized` | Required | `settleTerminalRunEvidence` | startup terminal repair | durable replay evidence | `releaseRunEvidenceTracking` |
| `interruptStaleRunsOnStartup` / `expireStaleRunLeases` | `run:resumed` | Required | Case 1 — resumed run re-enters `runAgentTicket`, whose first gate drains | resumption | run fails closed at the gate | `commitRunTerminalization` |
| `reconcileUnfinalizedTicketsOnStartup` | `run:ticket_finalized` | Required | `settleTerminalRunEvidence` | ticket finalization | durable replay evidence | `releaseRunEvidenceTracking` |

**Best-effort set is exactly five types** and is asserted for exact membership in
`scripts/run-evidence-drain-test.js`; adding a sixth fails the suite. Each is emitted
only after `commitRunTerminalization` has made the runs row, replay snapshot,
terminal bundle, evaluation, and consequence durable, so losing one cannot change
reconstruction, terminal classification, authority attribution, recovery safety,
operator truth, or compliance evidence.

**Verification coverage map (audited 2026-07-25 against the committed suites).**

| Guarantee | Covered? | Test / assertion |
|---|---|---|
| Containment does not recurse into the failing log path | **Yes** | `delegated-run-logging-containment-test.js:309` "containment did not recurse into the failing log path"; `reconciliation-evidence-failure-test.js:286` "no recursive diagnostic-log attempt occurred: exactly one per fixture" |
| Terminalization clears pending-write and failure-marker state | **Yes** | `run-evidence-drain-test.js:183` "terminalization clears the failure marker"; `:185` "terminalization clears pending-write state"; `:274`/`:276` no marker or pending-write entries leak after release |
| A later run id inherits no stale state | **Yes** | `run-evidence-drain-test.js` "a later run with a different id does not inherit stale failure state" |
| Post-mutation and final-step failure positions | **Yes** | `delegated-run-logging-containment-test.js`, mutation-proven via completion-drain removal |
| **Resumed-run initial evidence drain** | **No** | *(open follow-up A17-V1)* |
| **Required-log failure strictly before action execution** | **No** | *(open follow-up A17-V2)* |
| **Cleanup asserted end-to-end across recovery/startup-reconciled paths** | **Partial** | proven at unit level in `run-evidence-drain-test.js`; not asserted through a live recovery run *(A17-V3)* |

**Open verification follow-ups (A17-V1..V3).** These are *missing proofs*, not known
defects. The production paths they would exercise are implemented and reasoned:
`run:resumed` is classified under caller-rule case 1 because the resumed run re-enters
`runAgentTicket`, whose first gate drains before any model request or mutation; the
before-mutation position is guarded by the same gate that the post-mutation case
proves. No incorrect production behavior is known or implied. They are recorded here
so no future reader mistakes reasoned coverage for tested coverage.

**Tests.** `scripts/delegated-run-logging-containment-test.js` (37),
`scripts/run-evidence-drain-test.js` (40),
`scripts/reconciliation-evidence-failure-test.js` (18).

**Mutation proofs.** Ownership overwrite → focused identity test and natural
scenario 16; containment removal → process death; single-snapshot drain → nested
write test; completion drain removal → false `completed`; `logType`→`type` →
required-log propagation; settle boundary removal at both startup sites → missing
durable evidence.

---

### A23. Deterministic crash-seam coverage was incomplete

| Field | Value |
|-------|-------|
| **Status** | **Closed 2026-07-26.** All nine seams are driven by registered suites |
| **Severity** | Medium — recovery was largely asserted by construction rather than demonstrated |
| **Scope** | Verification gap in its own right. Opened separately from A20, which is scoped to test ORPHANS; these three seams were driven by no suite at all, orphaned or otherwise |
| **Evidence** | Seam map rebuilt from the repository after A22 and after the reconciliation repair |

**Description:**

The runtime exposes nine deterministic crash seams (`maybeTestInterrupt`). They exist
because the recovery contract is hard to prove any other way. A20 found only two were
ever driven; A22 took that to five and the reconciliation repair to six. The last three
were driven by nothing, and — unlike everything in A20 — no orphaned suite guarded them
either, so repairing an orphan could never have closed the gap.

| Seam | Driver |
|------|--------|
| `after_action_contract_violation` | `model-contract-violation-recovery-test.js` |
| `after_first_authority.allowed` | `resumable-execution-test.js` |
| `after_first_workspace.operation` | `resume-obvious-postcondition-test.js`, `resumable-execution-test.js` |
| `after_run.started` | `resumable-execution-test.js` |
| `before_run.snapshot_finalized` | `resumable-execution-test.js` |
| `after_first_workspace_target_effect` | `target-operation-reconciliation-test.js` |
| `after_run.created` | **`terminalization-boundary-recovery-test.js`** |
| `before_run.consequence_recorded` | **`terminalization-boundary-recovery-test.js`** |
| `after_run.snapshot_finalized` | **`terminalization-boundary-recovery-test.js`** |

### The seam names no longer describe the states they were coined for

Writing the suite surfaced a correction worth recording.
`before_run.snapshot_finalized` and `before_run.consequence_recorded` fire **back to
back at the same point**, and `server.js` says why:

> The old interruption points now sit before the repository boundary. They can abort
> before the bundle, but cannot create a partially committed PostgreSQL terminal state
> between its constituent records.

Terminalization is a single transaction. A crash at `before_run.consequence_recorded`
therefore leaves the run **non-terminal** — not "terminal with a missing consequence",
which is the state the seam name implies and which the current runtime **cannot
produce**. The suite asserts what is reachable and additionally proves the unreachable
state stays unreachable, rather than encoding a shape that no longer exists.

That leaves three materially different recovery contracts, which is why one suite with
three scenarios was the right shape:

| Seam | Durable state at death | What recovery must do |
|------|------------------------|-----------------------|
| `after_run.created` | run row only | claim and execute it; no duplicate run |
| `before_run.consequence_recorded` | run still running, bundle aborted | terminalize once, recording the consequence |
| `after_run.snapshot_finalized` | bundle committed, terminal | add nothing, contradict nothing |

**`terminalization-boundary-recovery-test.js` — 56 assertions, 3 seams, registered.**
Every scenario proves the hook fired, the process died, and the run was in the expected
incomplete durable state at death, so none can pass by never crashing. A shared
convergence check then requires: one run (no duplicate), original ownership and
assignment intact, no stale lease, exactly one finalized snapshot agreeing with the
run's terminal status, a recorded consequence, at most one `run.terminalized` and one
`run.consequence_recorded` event, and at most one successful mutation receipt. The
consequence is cross-checked against the receipts rather than merely asserted present —
that is the A16 property, and a consequence claiming no mutations while receipts say
otherwise is the failure that matters.

**Mutation-verified, and one needed re-aiming.**

| Mutation | Contract removed | Result |
|----------|------------------|--------|
| `crashed-runs-never-reclaimed` | a run abandoned by a dead process is reclaimed once its lease expires | killed |
| `terminalization-not-atomic` | a run reaching terminalization records its consequence | killed |

The first was initially aimed at `interruptStaleRunsOnStartup` and **survived**: a run
abandoned by a dead process is reclaimed when its **lease expires**, which the scheduler
does on its own interval, not by startup recovery. Re-aimed at the recoverable-run scan,
it kills. Fifth instance in this effort of a surviving mutation meaning defense in depth
rather than a coverage hole — the rule now has enough evidence to state plainly: **when
a mutation survives, identify which layer actually executes before concluding anything
about the suite.**

---

### A22. Resume after a committed workspace operation fails on an idempotency conflict

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-26.** Canonical prepared-intent projection; `resumable-execution-test.js` reinstated as required (35 assertions, 4 crash seams); mutation-verified |
| **Severity** | **High** — a crash after a committed mutation makes the run unrecoverable |
| **Scope** | Production runtime/persistence. Found by A20 while migrating `resumable-execution-test.js` |
| **Evidence** | `scripts/resumable-execution-test.js` scenario 2, against `940c32a` |
| **Decision required** | Confirmed: neither. The two write paths source `preState` from different places. See the diagnosis |

**Description:**

Kill the runtime at `after_first_workspace.operation` — after a `writeFile` has
committed but before the run finishes — then restart. Recovery claims the run and the
resume **fails**:

```
Operation receipt idempotency key conflicts for run 2:
run:2:slot:ed5dcf36…:input:e7484052…
```

The mutation is **not** duplicated, so the safety property holds. But the run does not
complete either: it terminalizes as `failed`. A crash at this seam therefore makes the
run unrecoverable rather than resumable, which is the opposite of what the seam exists
to support.

**Where it comes from.** `persistence/postgres/store.js` raises
`IdempotencyConflictError` when a resumed run re-emits evidence under a key that already
exists and the stored event differs from the re-derived one:

```js
if (storedEvent.type !== eventType || storedEvent.stepId !== eventStepId ||
    canonicalJson(storedEvent.payload) !== canonicalJson(eventPayload)) {
  throw new IdempotencyConflictError(id, key);
}
```

The guard itself is right — silently overwriting divergent evidence would be worse. The
open question is **why the re-derived payload differs at all**. Two possibilities, and
they have opposite fixes:

1. **Legitimate nondeterminism.** If the payload carries a duration, timestamp or other
   per-attempt field, the comparison is too strict and should exclude it. The guard
   should compare the evidence's *meaning*, not fields that cannot survive a replay.
2. **A genuine mismatch.** If the resumed run reconstructs materially different
   evidence, the conflict is correctly reporting a real reconstruction defect and the
   bug is upstream of the guard.

### Diagnosis (2026-07-26) — field-level

The conflict is raised at the **operation receipt** insert (`persistence/postgres/store.js`,
the `matches` comparison in the receipt writer), not at the replay-item or event
comparison. Every scalar column matches; only the `receipt` JSON document differs.

Instrumenting the comparison and diffing the two documents gives exactly three
differences, and one of them is an artefact of the diagnostic:

| Field | Stored (first pass) | Rebuilt (resume) | Real? |
|-------|--------------------|------------------|-------|
| `before` | *absent* | `{"existed": false}` | **yes** |
| `createdResources` | `[]` | `["resume-afterop-….txt"]` | **yes** |
| `targetScope` | `{root, type}` | `{type, root}` | **no** — key order only; `canonicalJson` sorts keys recursively, so this cannot contribute |

**Both real differences reduce to one cause.** `buildTargetMutationReceipt` derives
`before` directly from `preState`, and `buildMutationResourceChanges` derives
`createdResources` from `preState.existed === false && postState.existed`. A single
missing `preState` produces both.

**The two write paths source `preState` from different places:**

```js
// first pass — server.js, the writeFile execute path
const prepared = await beginWorkspaceMutation(...);
const preState = prepared.preState;          // ← empty on this run
… completeWorkspaceMutationEvidence({ …, preState, postState, … })

// resume — server.js, beginWorkspaceMutation's reconciliation branch
await completeWorkspaceMutationEvidence({
  …, preState: state.receipt.preState,        // ← populated, from the durable receipt
})
```

The durable target-operation receipt records a populated `preState`; the value
`beginWorkspaceMutation` hands back to the caller for the first pass does not. The two
therefore build **different receipt documents for the same logical operation**, and the
disagreement is invisible until a resume compares them.

**Classification, against the four cases this entry had to distinguish:**

- ~~transient/attempt-local metadata treated as semantic identity~~ — no; `before` and
  `createdResources` are semantic, and no timestamp or duration is involved
- **canonical payload construction differs across restart** — **yes, this one**
- ~~resume reconstructs a materially different operation~~ — no; same path, same content,
  same fingerprint, and every scalar column matches
- ~~the guard is right and an upstream recovery defect produces the mismatch~~ — the guard
  is right, but the defect is not in recovery: it is that the *first* pass writes an
  under-populated receipt

**The guard is correct and must not be weakened.** Excluding `before` or
`createdResources` from the comparison would let genuinely divergent evidence overwrite
committed evidence — precisely what the idempotency key exists to prevent. The fix
belongs at the earliest layer: **`beginWorkspaceMutation` must return the same
`preState` it persisted to the target-operation receipt**, so both passes build an
identical document and the resume compares equal.

### Implementation (2026-07-26)

**One line of cause, one place to fix it.** `targetOperationIntentFromRow` returned only
the row shape, leaving the persisted intent document nested at `.intent`. Four runtime
readers treat that record AS the document:

```js
classifyPreparedWorkspaceMutation(provider, intent)   // intent.args, intent.preState
beginWorkspaceMutation → return { preState: prepared.intent.preState }
reconcileWorkspaceOperation                            // intent.target, intent.args
```

Every one of those reads landed **one level too shallow** and silently produced
`undefined`. `intent.operation` appeared to work only because `operation` is also a
column — which is exactly why this survived so long.

So the first execution built its receipt with `preState === undefined`, giving no
`before` and an empty `createdResources`. Recovery rebuilt the same receipt through
`targetOperationReceiptProjection`, which *does* dig into the document
(`intent.preState`), and got both. Two projections of one operation disagreed, and the
disagreement was invisible until a resume compared them.

**The fix spreads the persisted document onto the record**, so the durable and
in-memory projections are the same values by construction rather than by two
independently-written readers agreeing. `intent` is kept nested so the prepare-conflict
comparison (`canonicalJson(current.intent.intent)`) and
`targetOperationReceiptProjection` continue to read the raw document unchanged.

**Nothing was weakened.** `before` and `createdResources` remain in the receipt
comparison; the idempotency guard is untouched; resume accepts no conflicting evidence;
no pre-state is recomputed after the mutation. The fix makes logically identical work
*compare equal*, which is what the guard always intended.

**Proof — `scripts/resumable-execution-test.js`, 35 assertions across 4 crash seams**,
all now passing. Every scenario proves its seam actually fired, the process actually
died, and the run was genuinely unfinished before resume — so a scenario cannot pass by
never crashing. The committed-operation case additionally proves:

- the first mutation committed and the file holds its intended contents
- exactly one successful mutation receipt exists
- the resume produced **no** idempotency conflict, in neither the run error nor the log
- the stored receipt document records `before` and names the created resource, so first
  pass and resume project identically
- the run **completes** rather than merely avoiding duplication — the distinction that
  matters, because the defect produced no duplicate either; it failed the run instead

**Mutation-verified.** `prepared-prestate-not-propagated` removes the document spread
and restores A22 exactly. Worth noting what it does *not* do: it produces no duplicate
mutation, so a suite that only checked "the mutation did not run twice" would have
stayed green through the entire defect.

**Why this went unnoticed.** `after_first_workspace.operation` is one of only two crash
seams any registered suite drives, and the suite that drives it
(`resume-obvious-postcondition-test.js`) asserts a postcondition outcome rather than
resume-to-completion. The seven other seams are driven by nothing. See A20's note on
crash-seam coverage.

**Coverage.** `scripts/resumable-execution-test.js` is migrated, PostgreSQL-native, and
reproduces this deterministically as scenario 2. It is classified `excluded` /
`blocked-by-defect` — correct suite, broken production — exactly as
`assignment-audit-test.js` was before A21. Scenario 1 (crash *before* the operation,
resume executes it exactly once) is **verified green**, so the migration and the resume
path itself are sound; scenarios 3 and 4 are unverified because the suite aborts at 2.

---

### A21. Ticket reassignment is silently discarded, and the audit trail says otherwise

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-26.** `reassignTicket` store writer; `assignment-audit-test.js` reinstated as required (31 assertions); mutation-verified |
| **Severity** | **High** — an audit record asserted a change that did not happen |
| **Scope** | Production runtime/persistence defect. Found by A20 tranche 2; **not** a test-migration issue |
| **Evidence** | Reproduced against `d29b3c5` by `scripts/assignment-audit-test.js`; root cause below |
| **Decision required** | Whether `transitionTicket` should patch the assignment columns, or whether reassignment needs its own store method |

**Description:**

`PATCH /api/tickets/:id/assignment` answers **HTTP 200**, advances the ticket revision,
sets `changedBy`/`changedAt`, appends a `ticket:assignment_change` audit log naming the
old and new agent, and emits `ticket.updated` — **while leaving the ticket assigned to
the original agent.**

```
agents a=1 b=2   ticket target=1
PATCH /api/tickets/1/assignment  { agentId: 2 }   → HTTP 200
after target=1   changedBy=admin
```

**Root cause.** `assignment_target_type` and `assignment_target_id` are real columns on
`tickets` (`persistence/postgres/migrations/001_runtime_core.sql`). `ticketFromRow`
reads them **from the columns**, overriding whatever the JSON `body` holds:

```js
assignmentTargetId: nullablePositiveSafeInteger(row.assignment_target_id, 'ticket.assignmentTargetId'),
```

`transitionTicket` — the only update path the endpoint uses — writes just two things:

```sql
SET status = $4,
    body = ticket.body || $5::jsonb,
```

So the endpoint's patch lands in `body`, where the column immediately shadows it.
Grepping `assignment_target_id` in `persistence/postgres/store.js` confirms it is
written **only at INSERT** (`createTicket`, `createTicketWithEvent`). **No update path
anywhere writes those columns.** A ticket's assignment is effectively immutable after
creation, and every surface that claims to change it is lying.

**Why this is High rather than Medium.** The failure is not "reassignment doesn't
work" — a visibly broken button is recoverable. It is that the system **records a
false audit fact**: the log says the ticket moved from agent 1 to agent 2, the
`ticket.updated` event payload says the same, and the ticket did not move. Anyone
reconstructing who was responsible for work at a given time gets a wrong answer from
the durable record. `docs/SYSTEM_STATUS.md`'s truthfulness rule applies directly here.

There is a second-order effect: the endpoint then calls `createRunsForTicket(ticket)`,
so the run it dispatches goes to the **old** agent while the audit trail attributes the
work to the new one.

**Coverage.** `scripts/assignment-audit-test.js` is repaired, PostgreSQL-native, and
correctly **fails** on this. It is classified `excluded` / `blocked-by-defect` in
`scripts/test-manifest.js` — not weakened to pass, and not deleted. It reverts to
`required` the moment this entry is implemented, and it already asserts the exact
property that must hold:

```js
assert(auditLog.nextAssignment.assignmentTargetId === reassigned.assignmentTargetId,
  'the audit log agrees with the ticket it describes');
```

### Implementation (2026-07-26)

**A dedicated store writer, not a widened primitive.** `transitionTicket` has eleven
callers and none of them changes an assignment. Teaching it to write the assignment
columns would have made *every* status transition capable of moving a ticket between
principals — a much larger blast radius than the defect. `PostgresRuntimeStore.reassignTicket`
was added instead, and `transitionTicket` is untouched, so the other callers are correct
by construction rather than by review.

`reassignTicket` writes the two authoritative COLUMNS and the body's `assignmentMode` in
a single UPDATE, under the same optimistic revision guard and status guard the other
transitions use, and it appends **both** the `ticket.updated` event and the
`ticket:assignment_change` audit log **inside the same transaction**. The endpoint
previously appended the audit log after the commit, so a failure between the two left a
reassignment with no audit record; now the evidence and the change commit together or
not at all.

The prior assignment is read `FOR UPDATE` inside that transaction rather than taken from
the caller's snapshot, so a concurrent writer cannot make the recorded "previous" value
a lie. The event and log payloads are both built from the row that was actually written.

**Proof — `scripts/assignment-audit-test.js`, 31 assertions**, one per guarantee:

| Guarantee | How it is proved |
|-----------|------------------|
| the ticket acquires the requested assignment | `store.getTicket` reports the new agent |
| assignment fields stay internally consistent | target type, target id and mode asserted together |
| the returned ticket reflects persistence | the HTTP body's ticket is compared to the stored row |
| the audit log matches ticket state | `nextAssignment` compared to the ticket, not to the request |
| the event agrees with the persisted ticket | payload assignment, `previousAssignment`, and the revision it produced |
| the run is dispatched on the NEW assignment | every dispatched run targets the new agent and none the old |
| a no-op is inert | revision, timestamps, log, event and run count all unchanged |
| stale writes cannot overwrite | a stale-revision `reassignTicket` is rejected, the ticket does not move back, and no audit evidence is left |

Two of those needed care to state truthfully: dispatching a run emits its own
`ticket.updated` immediately after the reassignment, so the assignment event is selected
by its `previousAssignment` marker rather than by being last, and the revision asserted
is the one the reassignment produced rather than the ticket's current one.

**Mutation-verified.** `assignment-column-divergence` in `scripts/suite-mutation-test.js`
restores the exact defect — the assignment lands in the JSON body where the column read
shadows it — and the suite fails. The endpoint still answers 200 and still writes its
evidence under that mutation, which is precisely why a suite that checked only the HTTP
status or only the log's existence would have stayed green.

---

### A20. Repository-wide PostgreSQL-cutover test-orphan population

| Field | Value |
|-------|-------|
| **Status** | **Open — inventory complete and authoritative; repair backlog of 83 remains.** Anti-rot mechanism implemented; two confirmed orphans repaired |
| **Severity** | **High** — 83 suites guard live contracts and none of them can run |
| **Scope** | Successor to A10, which inventoried 14 of them |
| **Evidence** | Every unregistered suite executed at `e1d05a7`; results in the classification below |
| **Decision required** | Repair, replace, or retire each of the 83, in priority order |

**Description:**

A10 restored fourteen orphaned harnesses and recorded a suspicion that the population was
larger. It is. Executing every unregistered suite establishes the real numbers:

| Classification | Count |
|----------------|-------|
| **required** — must run in the release checkpoint | 75 |
| **orphaned** — genuine cutover orphan, cannot run | 75 (one split; its injection half still open) |
| **excluded** — deliberately outside the checkpoint | 20 |
| **total `scripts/*-test.js`** | **162** |

The A10 entry guessed ~96 candidates and cautioned that the list "includes false positives,
comments, and intentionally excluded live-provider tests." **That caution was wrong in one
direction and right in another.** All 96 reference `DATA_DIR` in executable code, not
comments — there were no comment-only false positives. But 13 of them are legitimately
excluded (live-provider, manual-demo) rather than orphaned, so the true orphan count is 83.

### The inventory is execution-backed, not grep-backed

Every one of the 111 unregistered suites was executed. Grep established candidates; execution
established categories, and it moved suites between them:

- **70** die on `DATABASE_URL is required for the PostgreSQL runtime` — the loud A10 shape.
- **11** present as `Timed out waiting for server ready`. Same root cause: they spawn a server
  with no database URL, and their own readiness poll masks the child's death.
- **7** were the reason this had to be executed rather than inferred. See below.
- **14** PASS. Six are genuinely runnable and were simply never registered.
- **4** fail on missing helper symbols — the A13 population.
- **12** fail for assorted separate reasons (live-provider guards, manual-demo prerequisites,
  two more source-coupled suites).

### Seven suites exit ZERO while asserting nothing

The most serious finding, and the one a grep sweep could never have produced: these suites
report success while executing no assertions at all.

```
assignment-audit-test.js              15s, exit 0, ZERO bytes of output
conditional-workflow-prompt-test.js   15s, exit 0, ZERO bytes of output
status-transition-evidence-test.js    15s, exit 0, ZERO bytes of output
workflow-composition-test.js          15s, exit 0, ZERO bytes of output
operational-abuse-test.js             exit 0, "Total: 0 | Passed: 0 | Failed: 0"
resumable-execution-test.js           exit 0, "Total: 0 | Passed: 0 | Failed: 0"
scheduler-integrity-abuse-test.js     exit 0, "Total: 0 | Passed: 0 | Failed: 0"
```

**Mechanism, confirmed in the source.** Each has a cleanup block of the form:

```js
} finally {
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));   // no guard
}
```

When the server dies at startup — which is the orphan condition — the child has **already**
exited, so `child.once('exit')` never fires again and the promise never settles. The `finally`
hangs, `main().catch(...)` never runs, the event loop drains, and node exits **0** with the
error never printed. `waitForReady()` did throw; nobody ever saw it.

Contrast the correct form, present in the suites that fail loudly:

```js
if (child.exitCode !== null || child.killed) return resolve();
```

**Why this is worse than a loud orphan.** A loud orphan is a known gap. A silent one is
indistinguishable from working coverage — and if anyone had "helpfully" registered these to
raise the checkpoint count, they would have been permanently green while asserting nothing.
They are classified `cutover-orphan-silent` and must have this defect fixed as part of any
repair, not merely be pointed at PostgreSQL.

### Anti-rot: `scripts/test-manifest.js`

The gap A10 left is that its guard is a hand-maintained list of fourteen filenames. It cannot
notice a *new* suite nobody registers — which is exactly how the cutover orphaned suites in
bulk without anything going red.

The manifest is now the authority. Every `scripts/*-test.js` file carries a status
(`required` / `orphaned` / `excluded`) and, when not required, a reason from a documented
vocabulary. `scripts/release-checkpoint-coverage-test.js` enforces six rules:

1. every test file appears in the manifest — **an unclassified new test fails the checkpoint**;
2. no manifest entry points at a file that no longer exists;
3. every `required` suite is registered in the checkpoint;
4. every registered suite is classified `required` — nothing orphaned or excluded runs;
5. every non-required entry carries a reason from the documented vocabulary;
6. the three statuses partition the manifest exactly.

**Why a manifest rather than another filename heuristic.** Rule 3 is the anti-rot rule, but it
only works if exclusions are legitimate and explicit. "Every `*-test.js` must be registered"
would be false — live-provider suites need an API key or a running Ollama, the mutation tool
edits tracked source, and the manual-demo runners expect a developer server. A heuristic would
have to encode those exceptions by filename and would drift. The manifest states them.

`node scripts/test-manifest.js` prints the inventory, so the repository answers *what tests
exist, which are required, which are excluded, why, and where each runs* without depending on
anyone's memory.

### Exclusions, and one that is not merely a preference

| Reason | Count | Basis |
|--------|-------|-------|
| `live-provider` | 4 | Needs a real OpenAI key or a running Ollama |
| `manual-demo` | 8 | Operator demo/stress runners, not regression suites |
| `mutation-tool` | 1 | `suite-mutation-test.js` edits tracked source by design |
| `source-coupled-other` | 2 | `operator-workflow-test.js`, `report-generation-test.js` — same extraction coupling, outside A13's scope; needs its own disposition |

**`manual-demo` is a safety classification, not a taste one — demonstrated accidentally.** The
inventory sweep executed them, and several write into the repository working tree: they set
`DATA_DIR = path.join(ROOT, 'data')` and `WORKSPACE_ROOT = path.join(ROOT, 'workspace-root')`.
The sweep left six tracked `data/*.json` files modified (`data/tickets.json` lost 869 lines)
and created a stray `workspace-root/`. All were restored, but the lesson stands: these must
never run unattended, and the manifest is where that is now written down.

### Repaired in this tranche

| Suite | Contract | Result |
|-------|----------|--------|
| `concurrency-conflict-test.js` | Concurrent overlapping/non-overlapping workspace mutation; cross-ticket delete authority | 16 scenarios, 0 not-proven |
| `run-detail-permissioned-delete-audit-test.js` | Run detail displays permissioned cross-ticket delete provenance — **and only when the permission was used** | 16 assertions |

**A strengthening that was a precondition for registering the first one.**
`concurrency-conflict-test.js` treated `NOT_PROVEN` as a neutral discovery outcome, and every
scenario had a `NOT_PROVEN` escape ("owner run did not complete"). A run of it in which nothing
worked would have exited **0**. That is the same green-but-vacuous shape as the seven silent
suites, just with a tidier report. `NOT_PROVEN` is now a hard failure: against a real store
driven by a deterministic model-free stub, a scenario that cannot reach its own preconditions
means the harness is broken, not that reality is ambiguous.

Its JSON-corruption assertions (`jsonParsesOrNull`) were retired: they guarded against a torn
concurrent write to a flat file, which PostgreSQL cannot produce. The surviving property —
concurrent writers lose and duplicate no records — is asserted directly through record counts
and per-run receipt isolation.

`OBSERVED_SAFE`/`OBSERVED_UNSAFE` is kept for the two parent/child probes, because the
vocabulary still records *how* the guard fired rather than only that it did.

### Also registered: six suites that were passing and unwatched

`telemetry-test.js`, `workload-profile-test.js`, `archive-local-events-test.js`,
`mutating-limit-context-regression-test.js` (deterministic) and `operator-visibility-test.js`,
`oquery-parity-test.js` (already PostgreSQL-native). Nothing was wrong with any of them.
Nothing ran them either — the same gap, in its quietest form.

### Mutation coverage

`scripts/suite-mutation-test.js` (renamed from `a10-suite-mutation-test.js`, which now covers
A10 and A20) gained two mutations for the repaired suites, both killed:

| Mutation | Contract removed | Suite |
|----------|------------------|-------|
| `cross-ticket-delete-gate` | a cross-ticket delete requires the permission | `concurrency-conflict-test.js` |
| `permissioned-delete-block-unconditional` | the audit block renders only when the permission was used | `run-detail-permissioned-delete-audit-test.js` |

The second is worth noting: only the suite's **negative** half catches it. A block that always
renders would attest to an authorization that never happened, and a suite asserting only the
happy path would have stayed green.

### Tranche 2 (2026-07-26) — the silent orphans

Started with the seven `cutover-orphan-silent` suites, per this entry's own sequencing.

**The shared fix.** `scripts/child-process-settlement.js` replaces the unguarded
`child.once('exit')` pattern once rather than seven times:

- `settleChild(child, { timeoutMs })` — resolves whether the child exited before or
  after the call, and **rejects rather than hangs** if it does neither
- `stopChild(child, { graceMs, killMs })` — SIGTERM → SIGKILL, always settles
- `assertScenariosExecuted({ assertions, scenarios, minAssertions })` — the vacuity
  floor, because "zero assertions ran" is never a valid successful outcome

`scripts/child-process-settlement-test.js` (23 assertions, registered) demonstrates all
six required cases: child still running, child already exited, normal exit codes,
forced termination, a child that never exits reaching the caller as a rejection, and no
successful zero-assertion exit. The already-exited case asserts the helper returns in
under a second — the old pattern waited forever there.

**Dispositions this tranche:**

| Suite | Disposition | Result |
|-------|-------------|--------|
| `status-transition-evidence-test.js` | Repair and retain → **required** | ✅ 22 assertions |
| `assignment-audit-test.js` | Repair and retain → **excluded / blocked-by-defect** | ✅ repaired; **fails on a real production defect — see A21** |
| `conditional-workflow-prompt-test.js` | Still `cutover-orphan-silent` | Not reached |
| `workflow-composition-test.js` | Still `cutover-orphan-silent` | Not reached |
| `operational-abuse-test.js` | Still `cutover-orphan-silent` | Not reached |
| `resumable-execution-test.js` | **Migrated** → `excluded / blocked-by-defect` | Scenario 1 verified green; scenario 2 reproduces **A22** |
| `scheduler-integrity-abuse-test.js` | Still `cutover-orphan-silent` | Not reached |

**The tranche found a High-severity production defect, which is the point.**
`assignment-audit-test.js`, once it could actually fail, immediately exposed **A21**:
`PATCH /api/tickets/:id/assignment` returns 200 and writes an audit record claiming the
ticket moved between agents, while the assignment columns are never updated by any
update path. That defect had been sitting behind a suite that exited 0 in silence.

It is classified `blocked-by-defect` rather than weakened to pass. A new exclusion
reason was added for exactly this case: **the suite is correct and production is
broken.** Excluding it keeps the checkpoint honest; adjusting the assertion until it
went green would have re-hidden the defect the suite exists to catch.

**Note for whoever takes the remaining five.** Two things learned here that will save
time:

- The scheduler must be parked (`RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'`) for any
  suite that measures ticket state, or it dispatches a run and mutates the fields under
  test mid-assertion.
- Reopening a ticket synchronously calls `createRunsForTicket`, so a ticket asserted as
  `open` may legitimately already be `in_progress`. Assert what the transition
  guarantees (it left `blocked`), not an exact resting status.

**`resumable-execution-test.js` — hypothesis tested and REJECTED. Disposition: repair
and retain.**

A preliminary read suggested its five scenarios might already be covered by
`recovery-state-reconstruction-test.js`, `lease-renewal-resume-safety-test.js` and
`postgres-startup-recovery-test.js`. That hypothesis was recorded rather than acted on,
and checking it showed it is **materially wrong**.

The runtime exposes **nine** deterministic crash seams:

```
after_action_contract_violation      after_run.created
after_first_authority.allowed        after_run.snapshot_finalized
after_first_workspace.operation      after_run.started
after_first_workspace_target_effect  before_run.consequence_recorded
before_run.snapshot_finalized
```

Across the **entire registered checkpoint**, only **two** are ever driven:
`after_first_workspace.operation` (`resume-obvious-postcondition-test.js`) and
`after_action_contract_violation` (`model-contract-violation-recovery-test.js`).

`resumable-execution-test.js` drives **four**:

| Interruption point | Covered by a registered suite? |
|--------------------|-------------------------------|
| `after_first_authority.allowed` | **No** |
| `after_run.started` | **No** |
| `before_run.snapshot_finalized` | **No** |
| `after_first_workspace.operation` | Yes |

`recovery-state-reconstruction-test.js` does not close this: it is a **pure classifier
test** over synthetic snapshots and never crashes a real server, so it cannot show that
the runtime reaches the same conclusion the classifier does. Three of the four crash
points here have **no live crash-recovery coverage anywhere in the repository**.

Retiring this suite would therefore have deleted unique coverage of exactly the
contract A20 ranks highest — recovery and terminal-state integrity. It is
**repair and retain**, and it should lead the next tranche.

**Wider finding worth its own attention:** 7 of 9 crash seams are exercised by nothing
in the checkpoint. The seams exist because the recovery contract is hard to prove any
other way; leaving most of them unused means recovery is largely asserted by
construction rather than demonstrated. That is a coverage gap independent of the orphan
backlog and is worth a decision of its own.

### The last four silent orphans — coverage analysis (2026-07-26)

Partial. Each finding below is stated with the evidence that supports it, and what is
**not** yet verified is marked as such rather than rounded up to a disposition.

**`conditional-workflow-prompt-test.js` — REPAIR, not retire. Earlier recommendation
withdrawn (inventory 2026-07-26).**

The previous entry recommended retiring it on the strength of the dead
`replaySnapshotPath` coupling. Reading the rest of the suite shows that was the wrong
call, and the correction is worth stating plainly: **a dead mechanism in one helper is
not evidence that the properties are dead.**

The `replaySnapshotPath` coupling is confined to a **single three-line helper**
(`readSnapshot`), which falls back to it only when an inline snapshot is absent. That
helper is dead storage-layout coupling and must not be ported. It is not the suite.

What the suite actually guards is **prompt composition**, asserted against the prompt
the model received — the recording-provider shape, already built. It carries **34
negative assertions** of the form *"ordinary prompt should not include …"*, which is
exactly the leak protection that matters here:

| Property | Assertion style |
|----------|-----------------|
| workflow guidance appears only for workflow runs | positive on workflow prompt |
| branching guidance, example and intent warning excluded from ordinary runs | **negative** |
| workflow-draft-intent prose, example, id guidance, nested-field and postcondition guidance excluded from ordinary runs | **negative** |
| handoff prose and args reminder excluded from ordinary runs | **negative** |
| `allowedOperations` still lists `createHandoffTask` / `createWorkflowDraftIntent` on ordinary runs | positive control — capability is present even when its guidance is not |
| branching directs away from `createWorkflowDraftIntent` | positive |
| allocated runs carry populated `allocationPlanId`, `allocationItemId`, `allocationItem`, `allocationSubtask`, `ownedOutputPaths` | positive |

`postcondition-completion-test.js` covers draft-intent and handoff **behavior** —
whether an intent is recorded, whether a handoff is created. It asserts nothing about
what the model was **told**, so it is not a successor for any of the above. **No
registered suite asserts prompt content at all.**

**Recommended shape.** Port it as `workflow-prompt-composition-test.js` against the
harness, keeping the negative assertions verbatim, sourcing prompts from a recording
provider (the pattern in `rerun-mode-evidence-test.js`), and dropping `readSnapshot`
entirely — nothing in the prompt contract needs a replay snapshot. Required additions:
a non-workflow run must receive no workflow-only instruction, an unrelated workflow must
not leak context, and zero captured prompts must fail rather than pass vacuously.

**`operational-abuse-test.js` — SPLIT AND CLOSED (2026-07-26).** Every one of its 15
scenarios now has a named end-state, so none is left ambiguous:

| Scenario | End state |
|----------|-----------|
| `testTooManyActions`, `testTooManyMutatingActions` | covered — `bounded-transition-test.js` |
| `testStalledResponses`, `testMultiStepStallThenRecover` | covered — `model-contract-violation-test.js` |
| `testLeaseExpiryRecovery` | covered — `lease-renewal-resume-safety-test.js` |
| `testRunInterruption` | covered — `resumable-execution-test.js` (A22) |
| `testConcurrentAgentRuns` | covered — `concurrency-conflict-test.js` |
| `testReplayEventConsistency` | covered — `required-replay-evidence-test.js`, `replay-snapshot-storage-test.js` |
| `testInvalidRuntimeConfig` | covered — `runtime-limits-config-test.js` |
| `testMalformedHandoff`, `testInvalidDraftIntent`, `testHandoffExecutorMismatch` | covered — `postcondition-completion-test.js` scenarios 9–19 |
| `testProtectedPathWrite`, `testAgentDirectOperationAccess` | **migrated** → `workspace-authority-gate-test.js` |
| `testDisabledOperationGate` | **left open — A8.** See below |

The suite is `excluded / superseded`: retained on disk so the mapping can be re-checked,
not run, and no coverage lost.

**`testDisabledOperationGate` is left open deliberately, and it is not a test defect.**
The scenario seeds an agent with `runtimeConfig: { allowWorkflowDraftIntent: false }`,
observes whether the restriction is enforced, and then returns `passed: true`
**regardless** — logging a "FINDING" that the flag "is declared but not enforced". So
the historical suite already knew the gate does not exist and chose to report rather
than fail. That is **A8 (dead `allow*` policy fields)**, an open governance item: whether
those flags become enforced or are removed is a product decision, not something a test
tranche may settle by picking one. Migrating the scenario now would mean either encoding
the broken behavior as correct or shipping a red suite for a decision nobody has made.

### `workspace-authority-gate-test.js` — the migrated residue

17 assertions, 3 scenarios, registered. What it proves that nothing did before:

- a `writeFile` to `.env` (in `config/protected-paths.json`) fails the run, records an
  `authority.denied` event carrying the structured `rule: 'protected_path'` and the
  refused path, creates no file, and leaves **no receipt claiming a successful write**
- a path escaping the workspace root is refused on the same terms
- **positive control:** the same agent, same run shape, an ordinary path — succeeds,
  writes exactly one receipt, and records no denial

The control is load-bearing. Without it, both refusal scenarios would also pass against
a runtime that refused every mutation or never dispatched a run at all.

**Why this was genuinely uncovered.** `protected_path` appeared in the registered
checkpoint only inside `workspace-snapshot-availability-test.js`, and only as a pure
classifier check — `classifyWorkspaceSnapshotFailure({ kind: 'protected_path' })`.
Nothing drove a real run at a protected path. A classifier agreeing with itself is not
evidence that the gate fires, which the `protected-path-gate-disabled` mutation
confirms.

**Aiming that mutation taught something worth keeping.** The first attempt neutered
`blockProtectedWorkspaceOperation` alone and **survived** — a second, independent
authority check (`createWorkspaceViolationItem`) also matches protected paths, so
removing one layer left the contract intact. Re-aimed at the shared matcher
`getProtectedWorkspacePathMatch`, which both gates consult, it kills the suite. And the
kill exposed a **third** layer: with protected-path matching gone, `.env` is still
refused — by the hidden/system-path rule ("Hidden and system paths are not allowed").

So protected paths are defended three deep. That is good news for the runtime and a
warning for testing it: a suite asserting only "the run failed" would have stayed green
through the removal of two independent gates. The assertion that actually caught it is
the one requiring the failure to **name the protected-path rule**, which is why the
suite checks the structured `rule` and the refused path rather than just the outcome.
This is the third time in A20 that a surviving mutation meant defense in depth rather
than a coverage hole.

**Superseded scenario mapping (retained for re-checking):** of its 15 scenarios,
at least five have registered successors:

| Scenario | Covered by |
|----------|-----------|
| `testTooManyActions`, `testTooManyMutatingActions` | `bounded-transition-test.js` |
| `testStalledResponses`, `testMultiStepStallThenRecover` | `model-contract-violation-test.js` |
| `testLeaseExpiryRecovery` | `lease-renewal-resume-safety-test.js` |
| `testRunInterruption` | `resumable-execution-test.js` (registered under A22) |

The residue is authority and gate coverage — `testProtectedPathWrite`,
`testDisabledOperationGate`, `testAgentDirectOperationAccess`, `testMalformedHandoff`,
`testHandoffExecutorMismatch`, `testInvalidDraftIntent` — and that is where the value
is. Port the residue; retire the rest with the mapping above recorded.

**`scheduler-integrity-abuse-test.js` — CLOSED (2026-07-26).** Checked scenario by
scenario rather than assumed. Every one of its 13 has a named end state, and unlike
`operational-abuse-test.js` the residue produced no migration: it is covered, obsolete,
or vacuous by construction.

| Scenario | End state |
|----------|-----------|
| `testRunResumptionAfterCrash` | covered — `resumable-execution-test.js` (A22) |
| `testLeaseExpiryDuringRun`, `testStaleLeaseCleanup`, `testDoubleLeaseAcquisition`, `testConcurrentRunClaims` | covered — `lease-renewal-resume-safety-test.js`, `scheduler-observability-test.js` |
| `testDuplicateReplayAppend`, `testReplayOrdering` | covered — `required-replay-evidence-test.js`, `replay-snapshot-storage-test.js` |
| `testConcurrentWorkspaceMutation` | covered — `concurrency-conflict-test.js` |
| `testEvaluationConsequenceOrdering` | covered — `run-consequence-mutation-test.js` (A16) |
| `testExecutorRunOrphaning` | covered — `concurrency-conflict-test.js` asserts `stuckRunning === 0` after concurrent stop+rerun, the same no-orphan property under strictly harder conditions |
| `testInterruptedExecutorHandoff` | covered — `resumable-execution-test.js` (terminal convergence incl. `interrupted`) and `delegated-run-logging-containment-test.js` |
| `testPartialWriteInterruption` | **retired — mechanism and property both obsolete.** It asserts `dataValid`, meaning a flat JSON file was not left torn by an interrupted write. PostgreSQL cannot produce that state; the same reasoning retired `jsonParsesOrNull` from `concurrency-conflict-test.js` |
| `testStalledProviderRecovery` | **retired — vacuous by construction.** It returns `passed: true` unconditionally. Stall recovery is covered by `model-contract-violation-recovery-test.js` |

**Ten of its 13 scenarios return `passed: true` literally**, so the suite could not have
failed on those regardless of runtime behavior. That is worth recording as a caution
about the whole `*-abuse-test.js` family: they were written as *exploratory probes* that
report findings, not as regressions that gate. Reading their names as coverage would
overstate what they ever guaranteed.

**Superseded mapping detail (retained for re-checking):** At least seven of its 13
scenarios map onto registered suites: crash resumption to `resumable-execution-test.js`;
lease expiry, stale-lease cleanup, double acquisition and concurrent claims to
`lease-renewal-resume-safety-test.js` and `scheduler-observability-test.js`; duplicate
replay append and replay ordering to `required-replay-evidence-test.js` and
`replay-snapshot-storage-test.js`; concurrent workspace mutation to
`concurrency-conflict-test.js`; evaluation/consequence ordering to
`run-consequence-mutation-test.js` (A16). The residue is executor orphaning and partial
write interruption. *Unverified:* whether the registered successors assert the same
properties or merely touch the same mechanism. Check scenario by scenario before
retiring anything — A20 already rejected one overlap hypothesis that looked stronger
than these.

**`workflow-composition-test.js` — REPAIR, and it is the most valuable orphan left
(inventory 2026-07-26).**

Structure first, because it changes how the file must be handled: there are **no
discrete scenarios**. `main()` is one 1,275-line sequence carrying **~340 inline
assertions** and ending in a single JSON emission. It cannot be split by lifting
scenario functions the way `operational-abuse-test.js` was; the contracts have to be
read out of the assertions.

Contract groups, from the assertion inventory:

| Group | Registered successor? |
|-------|----------------------|
| `executeActionPlan` — proposed / accepted / executed / rejected action evidence, `workflowActionPlans` | **NONE** |
| `executeTicketPlan` — child ticket creation, `workflowTicketPlans`, parent ticket/run/step/plan linkage, parent-scoped spawn idempotency, "v1 must not auto-run children" | **NONE** |
| Workflow branch execution (true and false paths, invalid `trueNext` rejection) | **NONE** |
| Workflow mutation budgets — `maxMutations`, exact-cap stop, over-cap deterministic rejection | Partial — `bounded-transition-test.js` covers per-response caps, not per-workflow budgets |
| Execution-policy normalization for legacy tickets (assisted mode, null maxAttempts, `when_declared`, shared scope, policy-change must not mutate replay evidence) | **NONE** |
| Failing postcondition → `run.verification_failed`, `run.triage_created`, failed effectiveness, "completed status alone must not report 100% objective success" | Mostly — `postcondition-completion-test.js` |
| Run lifecycle event completeness (~20 event types) | Partial — `operator-visibility-test.js`, `event-integrity-negative-test.js` |

**The headline: `executeActionPlan`, `executeTicketPlan`, `workflowActionPlans` and
`workflowTicketPlans` appear in NO registered suite.** Workflow composition — the
runtime path that spawns child tickets and executes planned actions — is guarded by
this orphan and by nothing else. `spawnIdempotencyKey` has store-level coverage in
`postgres-persistence-integration-test.js`, but the runtime path that produces it does
not.

That makes this the **highest-value repair remaining in A20**, ahead of the 76 loud
orphans: it is the only coverage of a whole subsystem, and it has been dead since the
cutover.

**Recommended shape.** Do not port the monolith. Extract focused PostgreSQL-native
suites along the group boundaries above, starting with the two that have no successor
at all:

1. `workflow-action-plan-test.js` — proposed/accepted/executed/rejected evidence, and
   that rejection is deterministic and does not fail the workflow
2. `workflow-ticket-plan-test.js` — child ticket creation and full parent linkage,
   parent-scoped spawn idempotency (duplicate plan steps create one child), and that v1
   does not auto-run children

Both need negative controls: an invalid plan must record the proposal AND the rejection
while executing nothing, and an over-cap plan must reject **all** proposed actions
rather than a prefix.

**A caution that has now been earned twice.** Both suites repaired in the previous
tranche found production defects the moment they could fail (A21, A22), and A20's own
overlap hypothesis about `resumable-execution-test.js` was wrong. Apparent redundancy in
this list should be treated as a hypothesis to test, not a reason to delete.

### Silent orphans: closed (2026-07-26)

**`cutover-orphan-silent` is now zero.** All seven are dispositioned: two repaired in
tranche 2, two split against named successors, one repaired under A22, and the final two
replaced here.

**Workflow composition — the subsystem that had no coverage at all — is now guarded.**
The 1,275-line monolith is retired and replaced by two focused suites along the
primitive boundary, because `workflowActionPlans` and `workflowTicketPlans` are separate
evidence collections and the original conflated them behind one harness.

`workflow-action-plan-test.js` (31 assertions, 3 scenarios): a valid plan executes for
real and in order — proved from the workspace, not just the evidence — with the
proposed/accepted/rejected/executed quartet consistent and one durable operation receipt
per executed action; an action outside `allowedOperations` is rejected with a reason,
executes nothing, and **does not fail the workflow**; an over-cap plan rejects **every**
proposed action rather than a prefix, leaving no partial effect.

That last one matters most: partial acceptance would let a run claim a bounded plan
while having performed an unbounded fraction of it.

`workflow-ticket-plan-test.js` (31 assertions, 2 scenarios): planned children are
created with the requested workflow, objective and per-child workflow input, fully
attributable to parent ticket, run, workflow, step and plan instance, each carrying a
distinct parent-scoped spawn idempotency key; **v1 does not auto-run them** — they are
created blocked with zero runs; and a workflow outside `allowedWorkflowIds` is rejected
without creating anything or failing the parent.

`workflow-prompt-composition-test.js` (15 assertions) replaces the conditional-prompt
suite. It reads `systemInstructionSnapshot` from the durable replay snapshot — the
instruction the runtime actually sent, recorded by the runtime itself — so the dead
`replaySnapshotPath` helper is simply not ported. It proves branching, canonical,
draft-intent and handoff guidance stay out of an ordinary run, that a workflow-shaped
objective does receive them (the positive control), and that `allowedOperations` remains
truthful on the ordinary run even where the guidance is withheld. Guidance and
capability are asserted separately because they must be allowed to disagree.

**Three mutations added, all killed** — and two needed re-aiming, in ways worth keeping:

| Mutation | Note |
|----------|------|
| `action-plan-allowlist-ignored` | killed first try |
| `child-tickets-auto-run` | first attempt edited only the explanatory COMMENT above the code and survived. A mutation must change behavior, not prose. Re-aimed at the child's `status: 'blocked'` |
| `workflow-guidance-leaks-into-ordinary-prompt` | first attempt gated on `AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED`, which is **off by default**, so removing it changed nothing — and that also revealed the suite's canonical-marker assertions were vacuous until the flag was enabled. Re-aimed at the applicability predicate itself |

The second of those is the more useful lesson: a surviving mutation exposed that two of
the suite's own negative assertions could never have failed, because the guidance they
excluded was never emitted under the test's environment. Enabling
`AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT` made them real.

### Crash-seam coverage, remapped after A22 (2026-07-26)

Rebuilt from the repository, not carried forward from the pre-A22 count:

| Seam | Registered driver |
|------|-------------------|
| `after_action_contract_violation` | `model-contract-violation-recovery-test.js` |
| `after_first_authority.allowed` | `resumable-execution-test.js` |
| `after_first_workspace.operation` | `resume-obvious-postcondition-test.js`, `resumable-execution-test.js` |
| `after_run.started` | `resumable-execution-test.js` |
| `before_run.snapshot_finalized` | `resumable-execution-test.js` |
| `after_first_workspace_target_effect` | **`target-operation-reconciliation-test.js` (repaired here)** |
| `after_run.created` | none |
| `after_run.snapshot_finalized` | none |
| `before_run.consequence_recorded` | none |

A22 took this from 2 of 9 to 5; repairing the reconciliation suite makes it **6 of 9**.
The three still uncovered are all terminalization-boundary seams and are the natural
next recovery cluster.

**`target-operation-reconciliation-test.js` — repaired and registered (20 assertions).**
It was the only suite in the repository driving `after_first_workspace_target_effect`,
the window where the external effect has landed and its evidence has not. It proves both
outcomes: an APPLIED effect is reconciled into exactly one recovery-marked receipt
retaining its stable operation key, with one completion event and replay linkage and no
re-application; and an UNCERTAIN effect — where a third party changed the target while
the runtime was down — is REFUSED, manufacturing no successful receipt, leaving the
divergent state untouched, and emitting
`workspace.operation_reconciliation_required` for a human to decide.

The refusal half is the safety-critical one: reconciling under divergence would fabricate
evidence for an effect nobody can prove this run produced.

**The mutation needed two re-aims, and the reason is reusable.**
`reconciliation.status === 'uncertain'` appears at three sites on three different paths.
Cutting the in-run `beginWorkspaceMutation` branch **survived** — a crashed run is
reconciled by STARTUP recovery (`reconcilePreparedTargetOperation`), not by the in-run
begin path. Aimed there, it kills. When a mutation survives, check which layer actually
executes before concluding the suite is weak; this is the fourth time in A20 that a
surviving mutation meant defense in depth rather than a coverage hole.

### Authority cluster 1 — permission escalation (2026-07-26)

**`rbac-and-inline-data-security-test.js` — SPLIT.** It bundles two unrelated
contracts, and only one of them is an authority boundary:

| Half | Contract | Disposition |
|------|----------|-------------|
| privilege escalation | a partial admin cannot reach permissions it was not granted | **migrated** → `permission-escalation-boundary-test.js` |
| inline data security | hostile agent names are script-escaped, provider secrets are not rendered, client rows avoid HTML sinks | **still open** — an injection contract, not an authority one; needs its own home |

The historical file stays `orphaned` because half its contract has not moved yet.
Retiring it now would silently drop the injection half — thematic proximity to "security"
is not a successor relationship.

**`permission-escalation-boundary-test.js` — 17 assertions, 7 scenarios, registered.**

The escalation shape that matters is not "can a nobody do nothing" but "can a partial
admin promote itself", so the seeded principal holds a realistic bundle —
`user:create`, `user:read`, `user:update`, `group:create`, `group:update` — and is
refused when it tries to create an account already inside a privileged group, mint a
group carrying `user:delete`, reach workflow management on the strength of `user:read`,
or read the event stream without `ticket:read`.

**Both sides, and effect not just status.** Every refusal is paired with the nearest
action the same principal legitimately may take — an unassigned account, an empty group
— and with an administrator succeeding on the surface the limited principal was refused.
Refusals additionally assert the row was **not written**: a 403 that still created the
user would be worse than a 500, and status alone cannot distinguish them. A seventh
scenario pins the outer boundary, so the 403s above are known to be about permissions
rather than authentication.

One assertion was weakened deliberately and the reason recorded in the suite:
`/admin/users` and `/admin/groups` are POST-only, so an anonymous GET is a 404 rather
than a redirect. The property under test is that nothing is *served*, so those assert
"not 200", with `/admin/workflows` — which does have a GET — carrying the stricter
redirect/401/403 assertion.

**Mutation-verified.** `permission-grant-escalation-open` removes the
`permission:assign` check from group creation, letting a principal with `group:create`
mint a group carrying any permission and add itself. Killed. Note that every positive
control stays green under it — only the refusal half catches self-promotion.

### Authority cluster 2 — timeline authority evidence (2026-07-26)

**`ticket-timeline-authority-visibility-test.js` → `timeline-authority-evidence-test.js`**
(30 assertions, 5 scenarios, registered). The historical file stays `orphaned`: it also
carries read-receipt, provenance-versioning and triage-projection assertions that have
not moved yet.

The contract is that the timeline is a **truthful, deterministic, read-only** projection
of what authority decided. Proved: a protected-path refusal appears exactly once as an
`authority.denied` entry carrying the structured `rule` and the refused target, leaves
no filesystem effect and no successful receipt; an allowed mutation on the same agent
appears once as `target.mutation_committed` with an `authority.allowed` counterpart and
is never rendered as a denial; neither ticket's timeline carries an entry belonging to
the other's run or ticket; projecting twice is byte-identical; and projecting mutates no
run or ticket revision.

**Two of this suite's own assertions were vacuous until the mutation test caught them.**
Both are recorded because the pattern will recur:

1. *Folding.* The suite asserted that a blocked `workspace.operation` folds into the
   authority entry. Cutting the folding logic — both the key dedupe and the id set —
   **survived**, because a protected-path block throws *before* any
   `workspace.operation` event is written. There was never a duplicate to fold, so the
   assertion could not fail. It is retained as a real invariant with that limitation
   stated inline. **Fold coverage still needs a denial shape that does emit a blocked
   workspace event** — cross-ticket ownership is the candidate, and
   `concurrency-conflict-test.js` already drives it behaviorally.

2. *Rule attribution.* The suite matched `/protected/i` against the entry's details and
   summary. Stripping the structured `rule` field **survived**, because the summary
   prose still contains the word "protected". Re-expressed as
   `details.rule === 'protected_path'`, which is what the objective's "name the actual
   rule" requires — a substring of English is not attribution.

**Mutation status, stated precisely.** `authority-denial-loses-its-rule` is **killed**,
but by the determinism assertion rather than the attribution one: nulling the rule also
changes the projection between two reads. The suite therefore detects the regression,
which is the required proof, but the kill is not attributable to the assertion aimed at
it. Left as-is rather than tuned to produce a prettier attribution.

**`allocated-regression-test.js` — inventoried, split identified, not yet migrated.**
Its 1,372 lines carry **five separable contracts**, so it must be split rather than
ported:

| Contract | Nature |
|----------|--------|
| **scope admission** — overlapping, non-directory, absent or ambiguous owned scopes refused at creation and not persisted | authority |
| **owned-path enforcement** — an allocated run may mutate only inside its own scope | authority |
| **allocation attribution** — plan id, item id, subtask, agent, status, shared batch marker, one run per group agent | authority/provenance |
| **replay fidelity and secret redaction** — snapshot carries correct run/ticket/agent/allocation identity and exposes no API key or `Authorization` value | evidence + security |
| **retry / rerun / idempotency / stop / budget** lifecycle | lifecycle |

**Authority core migrated — `allocation-scope-authority-test.js`, 31 assertions,
7 scenarios, registered.**

**The recorded hypothesis about the blocker was WRONG, and the correction matters more
than the fix.** A20 guessed the embedded `#ACTIONS=` directive made the objective
infeasible. It does not. The real gate is `assertAllocatedObjectiveSupported`: an
allocated objective must contain an ADDITIVE noun (`file`, `folder`, `report`,
`document`, …) and must contain NO destructive verb (`delete`, `remove`, `rename`,
`move`, `edit`, `update existing`, …). The failing probe objective was "Write status
notes" — and *notes* is simply not in the additive vocabulary. The directive was never
the problem; three different objective shapes all failed identically, which is what
exposed the guess.

The fix is therefore not a workaround: the objectives are natural language that
genuinely describes additive independent outputs, and the provider stub keys off a
distinct MARKER WORD carried inside that objective rather than an encoded plan. The
feasibility gate runs for real — nothing bypassed, disabled or mocked.

**What it proves:** overlapping scopes, a non-directory scope and absent
`ownedOutputPaths` are each refused with HTTP 400 leaving no persisted ticket; a
well-formed allocated ticket is ADMITTED, is not blocked by feasibility, and produces
one run per allocated agent sharing one allocation plan with distinct items, each naming
its own owned path; the in-scope write completes and leaves exactly one successful
receipt; and an out-of-scope write — on a ticket that was *admitted*, so the refusal is
enforcement rather than admission — fails the run, leaves no file and no successful
receipt, and names both the ownership rule and the refused target.

**Mutation `owned-path-scope-broadened`** widens the containment check so every path
counts as owned. Admission still works and the in-scope control stays green; only the
out-of-scope scenario catches an allocated agent writing into a peer's territory.
Killed.

**Contracts 2 and 3 migrated — `allocation-attribution-redaction-test.js`, 50
assertions, 5 scenarios, registered.**

*Attribution* is asserted as a **bijection**, not merely as presence: two runs, two
distinct allocation items, one shared plan, each owning exactly the scope its agent was
allocated. The failure that matters is not missing attribution but WRONG attribution —
item B's receipt filed under item A is worse than no receipt, because it is confidently
false. Cross-contamination is checked directly: every receipt is filed under the run
that produced it, each item's receipts stay inside its own scope, and item A's event
stream never mentions item B's scope.

*Redaction* uses distinctive high-entropy fake keys, so absence means something, and
every absence assertion is paired with proof the snapshot is genuinely POPULATED —
allocation identity, owned scope, provider, model, actions, terminal status. Without
that pairing, deleting the replay snapshot entirely would make the suite greener.

**An honest limitation, found by the mutation test and recorded rather than papered
over.** Two mutations were aimed at redaction and both showed the same thing: the
agent's `apiKey` **never reaches the replay path at all**. Disabling
`sanitizeSnapshotValue`'s key redaction changed nothing, because the snapshot records
`assignedAgentId`, `provider` and `model` — not the agent record. Credentials are kept
out **by construction**, not by an active redaction step on this path. The assertions
are therefore a *regression guard on a leak that does not currently exist*. That is
worth having and worth not overstating, so no mutation was manufactured to make the
guard look load-bearing. The allocation cluster's mutation proof rests on
`owned-path-scope-broadened`, which is genuinely load-bearing.

**Contract 5 migrated — `allocation-lifecycle-isolation-test.js`, 31 assertions,
4 scenarios, registered.** All five contracts now have destinations.

Sibling items are made ASYMMETRIC on purpose — the ScopeA agent reaches into ScopeB and
is refused while the ScopeB agent does legitimate work — because coupling between
allocation items is invisible while everything succeeds and only appears when something
goes wrong. A sibling marked failed because its neighbour failed is a false accusation
against work that actually succeeded.

Proved: the out-of-scope item fails while its sibling COMPLETES with its file on disk,
its single receipt, a replay recording its own success, no failure reason, and no trace
of the neighbour's refused work; owned scope and plan/item identity survive the failure;
a rerun produces exactly one fresh run per agent under ONE new plan distinct from the
original, each keeping its agent's owned scope and allocation identity, with no run left
active and no runaway duplication of committed mutations.

**Two honest limitations, recorded rather than smoothed over.**

1. *Stop is tested against an already-terminal run.* By the time the rerun settles both
   runs are terminal, so the stop is REFUSED rather than executed. That refusal is
   itself a real contract — a finished run cannot be stopped — and the assertions prove
   a *rejected* lifecycle call touches neither the sibling nor its own target. They do
   **not** prove isolation of an in-flight stop. Forcing that needs a long-running run
   the deterministic stub cannot currently produce.

2. *No mutation is registered for this suite.* The intended mutation — stripping owned
   paths from the rerun draft — could not be aimed: `ownedOutputPaths:
   getRunOwnedOutputPaths(run),` occurs **nine** times in `server.js`, so the anchor is
   not unique, and no mutation was manufactured against a different contract to fill the
   slot. The allocation cluster's mutation proof rests on `owned-path-scope-broadened`.
   Aiming a lifecycle-specific mutation with a unique anchor is outstanding work.

### `allocated-regression-test.js` — RETIRED

All five recorded contracts have named destinations:

| Contract | Destination |
|----------|-------------|
| scope admission | `allocation-scope-authority-test.js` |
| owned-path enforcement | `allocation-scope-authority-test.js` |
| allocation attribution | `allocation-attribution-redaction-test.js` |
| replay fidelity and secret redaction | `allocation-attribution-redaction-test.js` |
| retry / rerun / stop lifecycle isolation | `allocation-lifecycle-isolation-test.js` |

Assertions not carried across were JSON-era mechanics — `operation-history.json` and
`runs.json` reads, `replaySnapshotPath` file hydration, `events.jsonl` string matching —
whose surviving properties are asserted through the store in the three replacements. The
historical file is deleted; 112 assertions became 112 across three focused suites with
positive controls the original lacked.

### `rbac-and-inline-data-security-test.js` — RETIRED (2026-07-26)

Both halves now have destinations, so the file is deleted:

| Half | Destination |
|------|-------------|
| privilege escalation | `permission-escalation-boundary-test.js` |
| inline data security | `inline-data-injection-test.js` |

**`inline-data-injection-test.js` — 23 assertions, 3 surfaces, registered.** The
boundaries were taken from the historical assertions rather than guessed:
`/process-templates`, the ticket-creation page's allocated-agent selector, and — added
here — the `/api/configured-agents` JSON surface, because escaping the HTML page would
not help if the API handed the same record to a client with its credential attached.
A20's instruction not to treat absence from one path as application-wide coverage is
what made that third boundary necessary.

The hostile payload closes a script block and injects markup, and includes quotes,
backslashes and an HTML entity so escaping is exercised on each. The credential is
distinctive so absence means something.

**The positive control is load-bearing.** "The raw payload is absent" is satisfied by a
page that renders no agents at all — a broken query, an empty list, a 500. The suite
requires the payload to be present in **script-context escaped** form
(`\u003c/script\u003e`) and a benign agent to render normally, which together prove the
data reached the page and was made safe rather than dropped.

**One assertion was deliberately NOT made, and the reason is recorded inline.** An early
version asserted the absence of the payload's `onerror=` text. That is wrong: once
`</script>` is escaped, the remainder is an inert JS string literal, and demanding its
absence would assert that the data had been DROPPED rather than escaped. The
vulnerability signature is raw block termination followed by markup, plus the payload
never landing as a real element.

**Mutations, both killed at the exact boundary each guards:**

| Mutation | Contract removed | Caught by |
|----------|------------------|-----------|
| `inline-script-escaping-removed` | `<` is escaped in inline script serialization | the hostile name lands as a real `<img>` element |
| `agents-api-leaks-provider-key` | the agents API returns the public projection | the API serializes provider keys |

Both leave the page rendering and every unrelated assertion green, which is why the
injection-specific checks are the ones that catch them.

**Not done in this tranche:** the allocation split above and the inline-data-security half of
`rbac-and-inline-data-security-test.js`, which remains explicitly open as an injection
contract: script-context escaping, provider-secret leakage, unsafe DOM sinks, inline
serialized-data safety.

### `concurrency-conflict-test.js` is load-sensitive (observed 2026-07-26)

Recorded because a flaky suite inside the gate erodes trust in the gate.

A clean-worktree checkpoint failed on it with a cascade — `bothOk=null`,
`statuses=[null,null]`, then seven consecutive `NOT_PROVEN` "run did not reach
terminal". Re-run in isolation on the same commit and database it passes with **16
scenarios, 0 hard failures, 0 not-proven**, and a second full checkpoint passed 77/77.
So the failure was contention, not a regression: the suite creates many concurrent runs
and stalls when the machine is already busy.

This is not harmless. The suite's `NOT_PROVEN`-is-fatal rule — added deliberately when
it was migrated — means load now surfaces as a hard checkpoint failure rather than a
silent pass, which is the right trade, but it makes the gate non-deterministic under
load.

### Investigation (2026-07-26) — cause NOT found; teardown hardened anyway

Candidates were tested rather than assumed, and most are **ruled out**:

| Candidate | Result |
|-----------|--------|
| PostgreSQL connection exhaustion | **Ruled out** — peak 9 of 100 connections |
| CPU contention | **Ruled out** — the suite passes with six CPU-saturating processes running alongside it |
| Stray server processes surviving a suite | **Not observed** at rest |
| Contention with other integration suites | Untested — the checkpoint runs suites serially via `spawnSync`, so overlap would require a leaked process |
| Test-internal concurrency exceeding its contract | Plausible but unconfirmed; the suite creates ~21 tickets against a default `MAX_ACTIVE_RUNS` of 32 |

**The incident did not reproduce**: not in isolation, not under artificial CPU load, not
on a repeat checkpoint. It is therefore recorded as **unexplained**, not as fixed. No
speculative cure was applied to the suite: `NOT_PROVEN` remains fatal, no retry was
added, no timeout was multiplied, and the suite stays in the checkpoint.

**One genuine latent defect was found and fixed on its own merits.**
`scripts/postgres-test-harness.js` `stop()` sent SIGKILL and returned **immediately**
without waiting for the child to exit, so `withHarness` could drop the schema — and the
checkpoint start the next suite — while a killed server was still unwinding its
connections and transactions. Across a ~50-suite checkpoint that is an unbounded number
of overlapping shutdowns. It now uses `stopChild` from
`scripts/child-process-settlement.js`, which escalates and **awaits actual exit**.

That is the same "signalled is not exited" distinction the settlement helper was written
for in the silent-orphan tranche, and it should have been applied to the harness then.
**It is not claimed as the cause.**

### Recurrence, and step two of the escalation (2026-07-26)

It recurred on a later checkpoint, so the recorded next step was taken: **bound the
suite's own concurrency**.

The suite's largest burst is scenario 1, which creates ten tickets at once and never
waits for their runs. Those are noop plans, but leaving them in flight meant every later
scenario competed with them for run admission — the suite carried its own peak load
forward through all sixteen scenarios. It now DRAINS that burst before continuing.

This costs no coverage. The contract scenario 1 asserts is that concurrent CREATION
loses and duplicates nothing, which the assertions have already proved by the time the
drain runs. What is removed is only the residual in-flight work, not any concurrency the
suite intends to exercise.

Checkpoint passed 81/81 after the change. **This is step two of the escalation, not a
confirmed cure** — the incident was never reproduced on demand, so a passing run is
consistent with the fix and also with the flake simply not firing. If it recurs again,
the escalation is exhausted and the next step is the recorded one: treat a runtime that
cannot drain under reasonable bounded load as a **production progress/liveness defect**,
not a harness problem.

### Terminal-state cluster — RETIRED `state-agreement-completion-test.js` (2026-07-26)

**The file is deleted.** It combined two related but distinct terminal-state contracts,
and both now have registered PostgreSQL-native destinations:

| Half | Contract | Destination |
|------|----------|-------------|
| completion admission | what an operator may manually mark completed | `completion-admission-test.js` — 25 assertions, 7 scenarios, registered |
| startup state convergence | a ticket whose run already terminalized converges to the matching status on restart | `startup-state-convergence-test.js` — 35 assertions, 10 scenarios, registered |
| immutable verification snapshot | reconciliation verifies from the run's captured contract (`contractSource: 'run_snapshot'`), never the live catalog | inherited by the named orphan `verification-contract-reconciliation-test.js`, which already asserts exactly this at its restart-recovery step — see the note below |

**`completion-admission-test.js`.** "Completed" is the strongest claim the system makes
about work and an operator can assert it directly, so this gate is the only thing
between a wish and a durable record. Refusals are proved for: no run at all, a failed
latest run, an interrupted latest run, unresolved triage, and declared-but-unverified
verification. Each refusal must EXPLAIN itself — an unexplained 409 tells an operator
nothing about what to fix — and each is checked for EFFECT: the ticket must be
unchanged, not merely un-completed. **The positive control is the whole test**: a ticket
whose run genuinely completed IS accepted and DOES persist, and a seventh check
re-attempts one refusal afterwards to rule out order-dependent behaviour.

**The verification refusal is RESOLVED — the assertion was real, the fixture was wrong,
twice.** It was previously recorded here as unreproducible. Reading
`isRunVerificationRequired` settled it: verification is required only when *all* of
  * ~~the run's policy snapshot says `when_declared`~~ — **this was wrong, see the
    verification-contract cluster below**: `normalizeExecutionPolicy` pins
    `requireVerification`, so that check can never fail and the policy value is
    irrelevant. The first fixture was accepted for the same reason as the second;
  * the run is a **workflow** run with a `workflowId`; and
  * `normalizeVerificationContractSnapshot` returns non-null, which requires the
    snapshot to carry its **own** `workflowId` — the second fixture omitted it, so the
    contract normalized to null and verification silently was not required.

The earlier conclusion ("the gate keys off recorded evaluation state") was wrong, and
the honest lesson is narrower than it looked: two plausible fixture shapes both produced
a 200 for two *different* reasons, and neither was visible without reading the predicate.
Guessing a third time would have been worse than the recorded gap.

*(A second fixture lesson: the gate reads the RUN's policy snapshot, not the ticket's
live policy — correctly, since editing a policy after the fact must not retroactively
change what a finished run proved.)*

*(The `'always'` note previously recorded here was wrong and is superseded by the
verification-contract cluster below: `'always'` is not a weaker mode, it is not a mode
at all.)*

**`startup-state-convergence-test.js`.** `run.terminalized` and the ticket's
finalization are separate durable steps; a process that dies between them leaves a
finished run and a ticket still claiming `in_progress` — a lie about live work that no
scheduler revisits. Covered: completed → completed, failed → failed (**never**
completed), interrupted → open; incomplete terminal evidence is completed and recorded
before convergence; no new runs; exactly one `run.terminalized` per run; ticket, run,
replay and timeline agree; a second restart changes nothing.

**Two reconcilers, not one — found by a failing negative control.** The suite was
written assuming `reconcileUnfinalizedTicketsOnStartup` was the only healer, so a
completed run *without* `run.terminalized` was seeded as a negative control that must
not converge. It converged. `interruptStaleRunsOnStartup` runs first and handles runs
whose **evidence** is incomplete (`readRunsNeedingTerminalReconciliation` →
`reconcileTerminalRun`); the second handles runs whose evidence is complete but whose
**ticket** is stuck. The scenario was re-aimed to the contract that actually matters
there: convergence is allowed, but startup must durably record the terminalization it
acted on rather than finalize a ticket on evidence that still does not exist. This is
the sixth time in A20 that a surprising result was defense-in-depth rather than a
coverage hole; the rule holds — **identify which layer executes before judging a suite.**

**Both directions are controlled.** Scenarios 1–4 demand real transitions, so a startup
that changes nothing fails. Scenarios 5–6 seed `in_progress` tickets that must NOT move
— one with a still-pending sibling run, one with no runs at all — so a startup that
converges everything also fails.

**The in-flight control had to be built deliberately to be load-bearing.** Its first
form put the pending run *newest*, and the mutation below survived: with a pending
latest run the healer stops at its terminal-status branch and the in-flight guard is
never reached. Reordering so the *completed* run is latest puts the guard on the only
path. The pending sibling is also created holding an unexpired lease, so the scheduler's
first tick cannot claim it and the scenario observes the healer rather than racing it.

**Mutations — all killed.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `startup-converges-failed-run-to-completed` | convergence finalizes to the run's ACTUAL terminal status | killed — a failed run's ticket no longer reaches `failed` |
| `startup-finalizes-ticket-with-live-run` | the pending/running guard | killed after the fixture was re-aimed |
| `completion-ignores-unresolved-triage` | the triage gate | killed |
| `completion-ignores-required-verification` | the declared-verification gate | killed |

**On the inherited assertion.** `verification-contract-reconciliation-test.js` asserts
`contractSource === 'run_snapshot'` at its restart-recovery step — the same contract the
retired suite checked for run 103, and more thoroughly. It is itself an A20 orphan, so
this is a **named successor that is not yet registered**, not proven coverage. Retiring
the historical file does not lose the contract, but it does not currently run either;
it is tracked in the orphan list below and must be repaired before A20 closes.

### Verification-contract cluster — RETIRED `verification-contract-reconciliation-test.js` (2026-07-26)

**Replaced by `verification-contract-authority-test.js` — 27 assertions, 6 scenarios,
registered.** The historical suite asserted the right contract against a runtime that no
longer exists: it copied `data/*.json` into a temp directory and read `runs.json` back.

**The contract.** When a run finishes, whose definition of "verified" applies — the
workflow as it exists now, or as it existed when the run started? It must be the latter.
A workflow is mutable operator configuration; a run is a durable claim about work that
already happened. If verification read live state, editing a workflow would retroactively
change what past runs proved, in **both** directions.

**The mechanism, carried over from the historical suite because it is the right one.**
Each scenario crashes at `before_run.snapshot_finalized` — after execution, before
terminalization — mutates the workflow while the process is down, then restarts. The
snapshot and the live catalog now disagree on purpose, so which one recovery used is
directly observable:

| Scenario | Live workflow becomes | Run must be | Reading live state would give |
|----------|----------------------|-------------|-------------------------------|
| relaxed | postconditions removed | **failed** (it violated the original) | passed — a laundered failure |
| stricter | a requirement the run never had | **completed** (it met the original) | failed — a retroactive conviction |

Neither a blanket pass nor a blanket fail satisfies both, which is what makes the pair a
control structure rather than two similar assertions.

#### `requireVerification` — SETTLED: not a defect, and not a switch

The open question from the previous tranche is closed by reading
`normalizeExecutionPolicy`, which **hardcodes** `requireVerification: 'when_declared'`
and never reads the caller's value.

* **Is `always` intended to require verification?** No. `'always'` is not a supported
  value and never was. Nothing in the repository outside test fixtures ever sets any
  other value; no UI field, API parameter, or document offers one. The value in my own
  earlier fixture was invented by the fixture.
* **Why does `when_declared` with a valid contract require verification while `always`
  does not?** It doesn't — that framing was wrong. Both normalize to the same constant.
  What actually governs is `isRunVerificationRequired`'s remaining conditions: a
  **workflow** run, with a `workflowId`, whose captured contract survives
  `normalizeVerificationContractSnapshot` (which requires the snapshot to carry its own
  `workflowId`) and declares at least one postcondition. Verification is required by
  **durable per-run evidence**, never by a policy string.
* **Classification: intended semantics, with a real but narrow naming/configuration
  trap.** The behavior is correct — letting a policy field force verification on or off
  would let mutable configuration override durable evidence, which is exactly what the
  reconciliation half of this suite exists to prevent. The trap is that the field *looks*
  configurable and is silently discarded.

**The correction that follows.** The previous tranche recorded that `'always'` returns
false from the policy check — wrong. The check `requireVerification !== 'when_declared'`
is **provably dead**, because its input is pinned. Both of my earlier fixtures failed for
the same single reason: no valid captured contract. That is now corrected above.

**Production change (isolated, behavior-preserving except at one boundary).**
`SUPPORTED_REQUIRE_VERIFICATION` names the constant, `normalizeExecutionPolicy`
documents that it pins rather than derives, and `assertSupportedRequireVerification`
**refuses** any other value at the two surfaces that store a raw, unnormalized policy —
process-template create and draft. Those are the only places an author can express a
verification preference, and until now they would be silently downgraded to something
weaker than they asked for and never told. Everywhere else is untouched, so reading
historical snapshots cannot break.

**What the suite now makes the repository answer.**

| Question | Answer, pinned by |
|----------|-------------------|
| when is verification required | scenarios 3-5: a captured contract with ≥1 postcondition, nothing else |
| which durable snapshot governs | `run.verificationContractSnapshot`, asserted captured **before** the crash |
| snapshot or mutable current state | scenarios 1-2, in both directions |
| absent / empty / identity-less snapshot | scenarios 4-5: all three mean *not required* |
| manual completion while unresolved | scenario 3: refused, with verification named |
| startup convergence while unresolved | scenarios 1-2: reconciled to the snapshot's verdict, not deferred |
| what records the outcome | `run.postconditions_checked` carrying `contractSource: 'run_snapshot'`, plus `run.verification_passed` / `run.verification_failed`, and the replay snapshot |

**Controls.** Scenario 3 is the positive control for the gate — without it, 4 and 5
would be satisfied by a runtime that never requires verification at all. Scenario 6
pairs its refusal with two acceptances (the supported value, and omission), so a guard
that broke the endpoint outright would fail.

**Mutations — both killed.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `verification-honours-relaxed-live-contract` | verifying from the captured postconditions | killed — the relaxed scenario reconciles as passing |
| `template-policy-silently-downgraded` | the raw-policy boundary guard | killed — the unsupported value is accepted |

*(Note the first mutation is aimed at the semantics, not the field: it leaves
`contractSource: 'run_snapshot'` in place and still lies. A suite that only checked the
label would not have caught it.)*

### Event-journal record limits — RETIRED `event-journal-record-rejection-test.js` (2026-07-26)

**Replaced by `event-record-limit-containment-test.js` — 29 assertions, 5 scenarios,
registered.** The historical names are all gone (`EVENT_JOURNAL_MAX_RECORD_BYTES`,
`EVENT_RECORD_TOO_LARGE`, `event.record_rejected`, `oversizedRejections`) but the
contract survived under PostgreSQL names, so this is a replacement. A name search alone
would have retired a live contract.

**The load-bearing distinction.** Two failures look alike and demand opposite responses:

| | Cause | Correct response | Wrong response would mean |
|-|-------|------------------|---------------------------|
| Request-scoped rejection | caller sent an unstorable record | fail the request, keep running | any client can degrade the deployment |
| Internal evidence-persistence failure | system cannot record what it is doing | latch, stop schedulers, refuse work | the runtime mutates the world unable to record it |

Scenarios 4 and 5 are the **same server surface with opposite containment**, which is
what makes either meaningful: a runtime that never latches passes 4 and fails 5; one
that latches on anything passes 5 and fails 4. Scenario 5 injects the failure narrowly —
a trigger on one standalone evidence append, the path that runs through the server's own
`appendEvent` wrapper where the latch lives — so it proves containment rather than
merely breaking the database. Observed: `/health` → 503 `degraded`, later work refused
503, and the refused work verified absent rather than silently performed.

#### Configuration-seam decision — recorded, NOT hidden in the migration

`maxJsonRecordBytes` (2 MiB) is a `PostgresRuntimeStore` option `server.js` does not
expose. The previous tranche recommended adding an env option. **That recommendation is
withdrawn: no production configuration surface was added.** The real default is
exercisable directly through the store, so the convenience knob was never needed, and
adding a production surface only to make a test convenient is the wrong trade.

**But the investigation found something the knob would have hidden.** Fastify's default
body limit is **1 MiB — below** the store's 2 MiB. So:

* an oversized request body is refused as `FST_ERR_CTP_BODY_TOO_LARGE`, **not**
  `POSTGRES_RECORD_TOO_LARGE`; the two 413s come from different layers;
* `appendEvent`'s `POSTGRES_RECORD_TOO_LARGE` → 413 mapping is **unreachable from any
  request-body path**. It is live only for records the server accumulates server-side
  (evaluation, consequence, replay documents);
* the historical suite set the record limit to 1024 bytes so the store rule fired first.
  Today's ordering inverts that, which is why the contract could not be migrated as
  written.

The suite asserts the HTTP boundary for what it actually is rather than pretending it
reaches the store rule, and covers the store rule directly where it is truthfully
observable. **Consequence for coverage, stated plainly:** a mutation collapsing
`appendEvent`'s request-scoped branch into the latching branch SURVIVES this suite,
because no reachable HTTP path delivers an oversized record to that wrapper. It was
removed rather than left in the registry as a false claim. Closing it honestly requires
driving a server-accumulated >2 MiB evidence document — worth doing, not done here.

**Mutations — two killed, both on active layers.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `oversized-record-partially-persisted` | the size check's rejection | killed — the oversized record is stored |
| `evidence-failure-treated-as-client-error` | the latch on a genuine failure | killed — the process reports itself merely `starting`, never `degraded` |

#### OPEN DEFECT — rejected records leave no durable evidence

`docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md` promised that an individual oversized
event is "represented by compact `event.record_rejected` evidence". **PostgreSQL
implements no such thing.** A rejected record rolls back completely and leaves no trace;
the `oversizedRejections` metric on `/api/runtime/status` no longer exists either.

Scenario 3 proves the rollback is clean — no partial write, no consumed chain position —
which is correct as far as it goes. What is missing is the *positive* half: an operator
cannot discover that a record was ever refused. Evidence of refusal is exactly the kind
of thing this repository treats as load-bearing everywhere else (`authority.denied`,
`action.rejected`, `run.verification_failed` all exist precisely so a refusal is
visible).

**Not silently rewritten as though it never existed**, per the governance rule: the
promise is recorded here and the document now points at this entry. Deciding whether to
reinstate the evidence or formally withdraw the promise is a separate decision — it is
an evidence-completeness question, not a test-migration question.

#### Documentation truthfulness — `RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md` reconciled

The document described the JSON journal as current throughout, including the flatly
false "PostgreSQL ... is not yet the active server backend". Reconciled: the authority
table now names PostgreSQL relations instead of `data/*.json` paths; the durable
acknowledgement boundary is transaction commit rather than `FileHandle.sync()`; the two
failure classes above are stated explicitly with their codes and status codes; the limit
ordering is documented; and the storage-boundary section no longer describes a local
append-only file as the shared-storage limitation. The one promise PostgreSQL does not
implement is flagged in place and linked to the open defect above rather than deleted.

*(Worth noting how close this came to a wrong disposition: the cluster was queued as a
retirement on a name search, and the document that would have "confirmed" the mechanism
was gone was itself stale. Two independent stale sources agreeing is not corroboration.)*

### RESOLVED — runtime progress/liveness: admitted runs fail to reach terminal (2026-07-27)

**Status: OPEN and UNRESOLVED. No cause is claimed.** It has not reproduced since, but
nothing was changed that is known to address it, so this stays open.

**The incident.** During clean-worktree validation of `8638c51`,
`concurrency-conflict-test.js` failed with **10 hard failures and 7 not-proven across 16
scenarios** — escalation step 3, after the bounded-burst drain in `25fd221` (never
claimed as a cure, and definitively not one).

```
✗ double rerun: FAIL — newRuns=2 stillRunning=0 r1=200 r2=200
✗ stop vs rerun: NOT_PROVEN — base run did not reach terminal
✗ allocated/dynamic non-overlap: FAIL — bothOk=null filesOk=false noFalseConflict=true
✗ same-agent same-file conflict blocked: FAIL — statuses=[null,null] attributed=false cleanWrites=0
✗ same-agent failure isolation: NOT_PROVEN — owner setup run did not complete (null)
✗ permitted cross-ticket delete: NOT_PROVEN — owner run did not complete (null)
✗ non-cross-ticket delete allowed without permission: NOT_PROVEN — run did not reach terminal
```

The signature is **progress, not correctness**: runs do not reach a terminal status at
all (`statuses=[null,null]`, `did not complete (null)`). The suite is not observing wrong
conflict decisions; it is observing no decision, because the work never finishes.

**CORRECTION (2026-07-26, later the same day): the mechanism IS the evidence-persistence
latch.** The first occurrence was recorded here as "no deadlock, degraded-health or 503
signature explained it". That rule-out was **absence of evidence, not evidence of
absence** — the suite printed no health state at all, so a latch could never have shown
up in its output. The very first run with the new diagnostics armed caught it:

```
scheduler:  {"running":false,"intervalMs":200}
health:     {"status":"degraded","ready":false}
counts:     {"active":1,"pending":1,"running":0,"expiredLeases":0}
run 23: status=pending phase=planning revision=1 ticket=21 lease=none heartbeat=n/a
        ticketStatus=in_progress lastEvents=run.created
```

`evidencePersistenceFailure` is latched, **both schedulers are stopped**, and the run
therefore sits `pending` and unclaimed forever with no lease. Every downstream
`NOT_PROVEN — did not reach terminal` follows from that single fact. The scenarios were
never racing; they were waiting on a scheduler that had been shut down.

This retroactively explains the whole incident class, including the original occurrence:
the symptom "admitted runs never reach terminal" is what a latched deployment looks like
from the outside.

**What is still unknown: WHAT latches it.** The 40P01 deadlock fixed in `85f0802` was one
route into the latch, and it is closed — this recurrence proves it was not the only one.
The server's stderr is not captured in the checkpoint log, so the underlying error is not
yet in evidence. The diagnostics now additionally issue one evidence-dependent request
when health is degraded and record the resulting 503 body, which carries
`Event persistence is unavailable: <cause>` — the single missing fact.

**Latch provenance is now armed (`f60d00e`).** `recordEvidencePersistenceLatch` captures
the FIRST failure only — timestamp, channel, operation, event type, run and ticket id,
PostgreSQL code, routine, constraint, a bounded sanitized message, and a classification
of transient (serialization / deadlock / lock_not_available / statement timeout /
connection / too-many-connections) versus permanent (integrity / data exception /
syntax-access / application validation). Later failures are counted separately rather
than overwriting it. Exposed at `/api/runtime/status` as `eventPersistence` and printed
by the liveness diagnostics. Verified end to end against an injected failure. Codes and
ids only — no payload contents, no secrets.

#### ROOT CAUSE CAPTURED AND FIXED (2026-07-27)

The armed provenance caught it on a clean-worktree checkpoint:

```json
{"latched":true,"firstFailure":{
  "channel":"event_append","operation":"appendEvent",
  "eventType":"scheduler.run_skipped","runId":22,"ticketId":21,
  "code":"40P01","message":"deadlock detected","routine":"DeadLockReport",
  "kind":"deadlock_detected","retryable":true},"subsequentFailures":0}
```

**A routine deadlock was taking the whole deployment down.** `40P01` aborts one
transaction and PostgreSQL expects the loser to retry. Nothing retried it, so it reached
the server's `appendEvent`, which cannot classify it as request-scoped and therefore
latched `evidencePersistenceFailure`, stopped both schedulers, and left every pending run
unleased until restart. One transient conflict, one dead deployment.

Note this is a **different** deadlock from the chain-tip inversion fixed in `85f0802` —
that fix was correct and remains, but it was never the whole story. The general defect was
never the specific lock pair; it was that a retryable condition was treated as permanent.

**The fix: bounded retry where the transaction is provably replayable.**
`PostgresRuntimeStore.appendEvent` retries `40001`, `40P01` and `55P03` with exponential
backoff and jitter — **only when it owns the transaction**. A caller-supplied `client`
means the caller owns it and its earlier statements are not ours to replay, so that path
is never retried. Because these codes abort the entire transaction, nothing committed and
a replay appends the event exactly once.

Deliberately **not** retried: statement timeout (`57014`) and connection failures, which
signal genuine overload or loss rather than a resolvable conflict — retrying those
compounds the problem. On exhaustion the original error is rethrown, so a persistent
inability to record evidence still fails closed exactly as before.

**Validation.** `event-append-lock-order-test.js` scenario 5 forces a real deadlock with
`store.appendEvent` as a participant and requires it to succeed; scenario 1 independently
proves that interleaving genuinely deadlocks at the SQL level, so a pass is a retry and
not an absent conflict. Mutation `transient-conflict-not-retried` removes the retry and is
killed with the captured error verbatim — `(40P01: deadlock detected)`. Fail-closed
behaviour is unchanged: `evidence-failure-treated-as-client-error` still kills against
`event-record-limit-containment-test.js`.

**The fix broke a mutation, and that mattered.** Adding the retry made
`event-append-restores-lock-inversion` SURVIVE: the retry absorbed the very deadlock the
lock-order guard prevents, so removing the guard failed nothing — the append still
succeeded. Genuine defense-in-depth, but it left the ordering contract unobservable.

`PostgresRuntimeStore.transientConflictRetries` now counts absorbed retries, which
separates the two contracts:

| Layer | Contract | Assertion |
|-------|----------|-----------|
| lock ordering | conflicts must not ARISE | scenario 2 requires **zero** absorbed conflicts from the correctly ordered interleaving |
| transient retry | conflicts that arise must be ABSORBED | scenario 5 requires the count to **rise**, proving its success is recovery and not an absent conflict |

Both mutations kill again. The generalizable point: **when a recovery layer is added
above a prevention layer, the prevention layer stops being observable through outcomes
alone.** Something has to count the recoveries, or the older guard silently becomes
untested while still appearing green.

**The instrumentation is what solved this.** Three hypotheses preceded it and all three
were wrong — including one previously recorded here as ruled out. The incident only moved
once the repository could state which operation failed and how PostgreSQL classified it.

#### Hunt log (superseded by the capture above)

**Hunt status (2026-07-27): the cause had NOT yet been captured at this point.** The latch did not recur
across the checkpoints run after the instrumentation landed. Two other intermittent
failures surfaced during the hunt and were separated out rather than confused with it:

| Observed | Disposition |
|----------|-------------|
| `timeline-authority-evidence-test.js` — determinism assertion | **My fixture defect**, fixed in `f60d00e`. It demanded identical entry lists across repeated reads while terminal evidence was still landing, so legitimate projection GROWTH read as nondeterminism. Now asserts the real contract: already-reported entries are never rewritten or dropped. |
| `delegated-run-logging-containment-test.js` — "the run:completed echo insert was attempted and rejected" | **New, unexplained, load-dependent.** Passes 3/3 standalone. Recorded here so it is not mistaken for the latch; it has its own signature and no evidence links it. |
| `mutation-admission-contract-test.js` | Not a flake — it correctly caught the provenance refactor moving the inline `evidencePersistenceFailure = error` assignment it pins in source. Restructured so the assignment stays at the call site. |

**Known candidate, explicitly NOT acted on.** The pool sets `statement_timeout` to 30s and
there is no global `lock_timeout`. Since `85f0802` converted the chain-tip deadlock into a
lock WAIT, a sufficiently contended append could now exceed the statement timeout and
raise `57014` — a transient condition that `appendEvent` would latch on, because its
non-latching branch covers only `POSTGRES_RECORD_TOO_LARGE`/`TypeError`/`RangeError`.
That is a plausible route into the latch and the classification table above would mark it
`retryable: true`. **It remains a hypothesis.** The previous two hypotheses in this
incident were both wrong, so nothing is being changed until provenance names the code.

**Do not treat this as fixed, and do not widen `appendEvent`'s non-latching branch.** The
latch is behaving exactly as designed; something is legitimately failing to persist
evidence, and the correct fix is at whatever is failing, not at the containment that
reports it.

**Validation evidence since the port and deadlock fixes** (recorded as evidence, *not* as
a cure — see below):

| Round | Result | `concurrency-conflict` |
|-------|--------|------------------------|
| in-tree checkpoint (port fix) | 84/84 PASSED | 0 hard failures |
| in-tree checkpoint (deadlock fix) | 85/85 PASSED | 0 hard failures |
| clean worktree × 4 | 85/85 PASSED each | 0 hard failures each |

**Why the quiet period meant nothing.** Six consecutive green runs did not establish a
cause, and the failure recurred on the very next checkpoint after they were recorded —
vindicating the decision not to claim a cure. Treating a quiet period as a fix would have
been the `25fd221` mistake a second time.

**What changed instead: the next occurrence will be diagnosable.** The suite reported
that a run "did not reach terminal" while saying nothing about what the run was doing —
that gap is what made one occurrence undiagnosable. It now captures, on the **first** hard
failure only (later scenarios inherit the same broken state):

* scheduler ownership, running flag and cadence; deployment and local-process concurrency
  limits; admitted/starting run counts (including local-model slots);
* pending / running / expired-lease counts and the expired-lease run ids;
* `/health`, so a latched evidence failure is distinguished immediately;
* for every non-terminal run: status, phase, revision, ticket id, lease owner, lease
  expiry, last heartbeat, owning ticket status, and its last six event types — enough to
  tell queued from leased from executing from blocked-on-evidence from abandoned.

Verified by forcing a hard failure and confirming the block emits, then reverting. **This
is diagnostics only** — it never changes a verdict, never retries, and never extends a
timeout.

**Still forbidden:** retries, softening `NOT_PROVEN`, broad timeout increases, or moving
the suite out of the checkpoint. Four tranches have now been tempted by each.

### RESOLVED — a PostgreSQL deadlock degraded the whole process (2026-07-26)

Found during clean-worktree validation of `8638c51`, and it matters precisely because of
what that same tranche just documented.

**Observed.** `run-diagnostics-bundle-test.js` failed with `error: deadlock detected`,
thrown from `PostgresRuntimeStore._appendEvent` inside `withTransaction`, while the
suite's own server was running against the same schema. Not reproducible standalone (3
clean runs); it needs the checkpoint's concurrency, like the
`concurrency-conflict-test.js` flake. **Unlike that one, the mechanism is identified.**

**Mechanism.** `_appendEvent` takes `run_event_chain_tips` (`INSERT ... ON CONFLICT DO
NOTHING`, then `SELECT ... FOR UPDATE`) inside a transaction that has usually already
locked the `runs` row via `transitionRun`. Two concurrent evidence-writing transactions
acquiring the run row and the chain tip in opposite orders deadlock. PostgreSQL resolves
this the normal way: it aborts one side with SQLSTATE `40P01`.

**Why this is a defect and not just a flake.** A deadlock is a *routine, retryable*
condition in PostgreSQL — the aborted transaction is expected to be retried. This
runtime does not retry it, and worse, `40P01` is a generic `Error`: it is neither
`POSTGRES_RECORD_TOO_LARGE` nor a `TypeError`/`RangeError`, so in server-level
`appendEvent` it falls through to the **latching** branch. Per the containment contract
just pinned by `event-record-limit-containment-test.js`, that means it sets
`evidencePersistenceFailure`, clears readiness, stops both schedulers, and refuses all
further evidence-dependent work with 503.

So a transient, self-resolving database condition takes the deployment into
fail-closed degraded state requiring a restart. The fail-closed behaviour is correct for
a genuine inability to persist evidence; a deadlock is not that.

**Not fixed here.** The fix is a real production change with design choices —
bounded retry on `40P01` at the store transaction boundary, and/or a consistent lock
order between `runs` and `run_event_chain_tips` — and it needs its own validation under
load. Recording it beats a hasty fix at the end of a session.

**Do not classify deadlock as request-scoped to make this go away.** Widening
`appendEvent`'s non-latching branch to swallow generic errors would break the exact
distinction the tranche above exists to protect. The retry belongs at the transaction
boundary, below the latch.

**Tranche 8 clean-commit addendum (2026-07-29).** The independent GA checkpoint exposed
two more concrete lock-order cycles in the operator process-cancellation public seam:
`appendRunEvidence` took `replay_snapshots` before `_appendEvent` acquired its run-row
foreign-key lock, while terminalization takes `runs` before replay; separately,
`transitionTicketAfterRun` took the ticket before its run batch, while process evidence
takes a run before its event insert obtains the ticket foreign-key lock. Both surfaced
as `40P01`, and neither was accepted as a flaky pass. The canonical store now orders
these boundaries as `runs → replay_snapshots → event chain` and `run batch → ticket`.
`event-append-lock-order-test.js` scenarios 6 and 7 close the exact former cycles and
prove the bundled evidence and ticket projection each commit once without retry or
hash-chain damage. `process-supervision-postgres-test.js` then proves the real public
cancellation route converges. No failure was downgraded and no duplicate evidence path
was introduced.

### RESOLVED — surviving mutation `authority-denial-loses-its-rule` (2026-07-26)

Surfaced by the first full 32-mutation run of the session (earlier tranches ran targeted
subsets). **The suite was correct; the mutation was aimed at the wrong evidence channel.**

**The traced path.** `timeline-authority-evidence-test.js` asserts `details.rule` on the
timeline's `authority.denied` entry. That value comes from exactly one place:

```
buildAuthorityEvidence(run, operation, path, 'denied', 'protected_path', …)   server.js 12302
  → recordAuthorityEvidence → durable `authority.denied` event, payload = evidence
    → timeline folding: details.rule = payload.rule || null              server.js 8233
```

The mutation had been stripping `rule: 'protected_path'` from
`createWorkspaceViolationItem` (~6528). That function feeds `run.violation_detected`
(6580) — **a different evidence channel that the authority entry never consults.** So the
mutation changed a real, live layer and the projection was legitimately unaffected. Not
defense-in-depth over one field, and not a fallback inference: two separate channels, one
of which the assertion does not read.

**No inference was found.** The timeline does not reconstruct the rule from prose,
operation type, or path shape — `payload.rule || null` is the whole derivation, so the
evidence-authority contract is intact and nothing needed fixing in production.

**Disposition: re-aimed at the layer responsible for the projection.** The mutation now
nulls the rule at 12302. The denial still occurs and the entry still appears; only the
structured attribution is lost. It is killed **by the attribution assertion itself** —
`1: the entry names the protected-path rule structurally (got null)` — not by a
neighbouring field or a determinism check changing.

**Three properties, now independently falsifiable.** The suite previously carried the
distinction only as a comment, which no run could check:

| Property | Assertion |
|----------|-----------|
| exact structured attribution | `details.rule === 'protected_path'`, identity not substring, plus a type check |
| prose is not attribution | the entry independently carries human-readable text mentioning the refusal, and the rule is asserted to be a discrete token rather than that prose reused |
| deterministic projection | the rule and the full entry list are identical across repeated reads |

The prose assertion is the point: because the summary genuinely contains "protected", a
substring check over the entry would pass with the structured rule stripped. Asserting
both separately keeps that trap visible instead of relying on a comment.

**Mutation baseline is now 32/32 killed** — fully green for the first time this session.

*(Eighth instance of the standing lesson, with a twist worth keeping: the surprise was
not a second source for one field but a second CHANNEL for one concept. "Which layer
executes?" had to become "which layer does the assertion actually read?")*

### Harness defect — RESOLVED: pid-modulo test ports collide (2026-07-26)

Found while validating the event-record-limit tranche. The checkpoint failed once on
`lease-renewal-resume-safety-test.js` with `server did not start`, then passed on a
rerun and passes standalone. **Unlike the `concurrency-conflict-test.js` flake, this one
has an identified mechanism** and should not be filed alongside it.

Eight suites derive a fixed port from their own pid, and the ranges **overlap heavily**:

| Suite | Range |
|-------|-------|
| `page-render-regression-test.js` | 3400–4399 — spans every other range |
| `lease-renewal-resume-safety-test.js` | 3600–3799 |
| `postgres-startup-recovery-test.js` | 3620–3769 |
| `provider-response-recovery-postgres-test.js` | 3660–3779 |
| `model-contract-violation-test.js` | 3680–3799 |
| `model-contract-violation-recovery-test.js` | 3700–3799 |
| `execution-semantics-persistence-test.js` | 3810–3929 |
| `workspace-snapshot-recovery-test.js` | 3940–3989 |

`process.pid % N` is not collision-free, pids of sequentially spawned suites are
adjacent, and a previous suite's server child can still hold its port while the next
suite starts — the failure observed was `provider-response-recovery` immediately
followed by `lease-renewal`, whose ranges overlap. The symptom is misleading: the suite
reports "server did not start" when the server started fine and could not bind.

**FIXED** in `b85cd53`. `scripts/test-port.js` replaces the arithmetic with the
allocator the OS already provides: bind port 0, ask what you got. Two concurrent probes
cannot receive the same port. Callers needing several ports get them from one call so the
probes are open simultaneously and cannot alias — the old `PORT_1 + 1` scheme assumed the
neighbouring port was free. `release-checkpoint-coverage-test.js` now fails if any
checkpoint suite reintroduces pid-modulo or a hard-coded base/listen port, and exercises
the facility itself so the guard cannot point at something broken; verified it catches a
deliberate reintroduction. Validated by running all eight affected suites concurrently
three times (24/24), which is exactly the contention the old scheme lost.

**Do not "fix" this with retries or by widening timeouts** — the same standing rule as
the concurrency escalation. The cause is known; suppressing the symptom would discard a
real diagnosis.

### Admission cluster — RETIRED `event-journal-admission-recovery-test.js` (2026-07-27)

**Replaced by `mutation-admission-backpressure-test.js` — 27 assertions, 6 scenarios,
registered.** The historical suite drove a `.sync-control` file to stall
`FileHandle.sync()` on `events.jsonl`. That mechanism is gone; the contract survived
under PostgreSQL names — `EVENT_ADMISSION_BACKPRESSURED` became
`MUTATION_ADMISSION_BACKPRESSURED`, and the journal metrics became
`mutationAdmission.getMetrics()` (`backend: 'postgres'`).

**The load-bearing distinction, and it mirrors the record-limit cluster on the admission
side rather than the append side.** Two refusals share HTTP 503 and mean opposites:

| Refusal | Code | Retry-After | Meaning |
|---------|------|-------------|---------|
| backpressure | `MUTATION_ADMISSION_BACKPRESSURED` | `1` | healthy, momentarily full; capacity returns by itself |
| latched failure | `EVENT_PERSISTENCE_UNAVAILABLE` | none | cannot record evidence; retrying is futile |

Telling an operator to retry in one second when the deployment needs a restart is the
failure this prevents; the reverse — treating momentary fullness as fatal — would take
down a healthy system under load. The runtime checks the fatal condition **first**, and
scenario 6 pins that precedence explicitly.

**Covered:** refusal happens in the `onRequest` hook, so refused work leaves no state at
all (checked per objective, not in aggregate); admitted work is not lost to the pressure;
capacity recovers automatically with no restart; only routes declaring
`config.mutationAdmission` are gated, so session login and read-only diagnostics survive
pressure — an operator must not lose the ability to log in and inspect a system exactly
when it is loaded; and the latch records provenance naming the operation that caused it.

**Scenario 1 is the positive control.** Every other scenario asserts a refusal, and a
server refusing all mutations would satisfy them all.

**No configuration surface was added.** `MUTATION_ADMISSION_MAX_OUTSTANDING` is already
production-configurable, so capacity 1 makes backpressure reachable natively — the
opposite of the record-size limit, which is not env-configurable and is therefore covered
directly at the store.

*(Fixture lesson: scenario 6 first ran its latch server at capacity 1 too, and the health
probe caught `backpressured` before the latch landed — the exact confusion the scenario
exists to rule out. The latch server now runs at default capacity and the probe waits for
`degraded` specifically rather than "any non-200".)*

**Mutations — both killed.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `backpressure-reported-as-fatal` | the recoverable code on a full queue | killed — transient fullness reported as a persistence failure |
| `backpressure-omits-retry-after` | the retry signal | killed — a recoverable refusal gives the caller nothing to act on |

### Transparency cluster — RETIRED `operational-transparency-test.js` (2026-07-27)

**Replaced by `operational-summary-readonly-test.js` — 38 assertions, 5 scenarios,
registered.** The historical suite seeded `data/*.json` and diffed those files to prove
nothing was written. `/ops` and `/api/ops/summary` are live and unchanged in intent.

**Two properties make the broadest read in the system safe**, and both are covered:

1. **Permission-gated on `ops:read`, on BOTH surfaces.** The negative control is a
   principal holding a *different* permission (`ticket:create`), which is what proves the
   gate keys off `ops:read` specifically rather than "is authenticated" or "has any
   permission". Anonymous access is checked too, and neither refusal leaks the state it
   withheld.
2. **Reading writes nothing.** This is the hard one and the reason the suite exists:
   read-only is not enforced by any type or route flag — it is a property of what
   `buildOperationalSummary` happens to call. A future contributor adding a repository
   call that records an access log, touches a projection, or lazily materializes a cache
   would break it **silently**, because the response would look identical.

The proof is a durable census (tickets, runs, events, logs with ids, statuses, revisions
and sequences) taken across four repeated reads of both surfaces, as a dashboard poll
would. Refused reads are censused separately — a rejected request that logged an access
record would still be a write on an observability path.

**Two controls make the stillness meaningful.** A census that never changes proves
nothing if the census is blind: scenario 4 performs a real mutation and requires both the
census and the summary's own counters to move. Scenario 3 additionally proves the census
is stable with **no reads at all** before attributing any later change to the reads.
Scenario 5 pins that the summary is a projection rather than a new ledger — reading it
emits no events and records no summary artefact.

*(Fixture lesson, and it is the same trap as the startup-convergence suite: the first run
failed the read-only assertion because the seeded PENDING run was executed by the
scheduler's first tick, so ticket and run reached terminal states mid-suite and the census
attributed that background progress to the reads. `RUNTIME_SCHEDULER_INTERVAL_MS` does not
suppress the first tick. The run now holds an unexpired lease so it cannot be claimed.
Reading a "read-only violated" failure at face value would have produced a fabricated
production defect.)*

**Mutation `ops-summary-permission-open`** removes the `ops:read` check. The endpoint
still answers with correct data, so only the principal-without-permission scenario
notices. Killed.

### Evidence-carry cluster — RETIRED `tm2-evidence-preservation-test.js` (2026-07-27)

**Replaced by `carried-evidence-preservation-test.js` — 43 assertions, 8 scenarios,
registered.** A replacement, not a retirement: `previousActionResults` and
`model:no_progress` are live production mechanisms and that orphan was the only file in
the repository referencing either.

**The contract: what a later model turn is told about earlier turns must be TRUE.** A run
is a conversation. If the account of what just happened is missing, stale, or belongs to
another run, the model re-does completed work and loops until a runtime limit kills it,
and replay gives no explanation.

**The provider is driven by prompt state, not a call counter, and that IS the positive
control.** Each response is chosen by inspecting the `previousActionResults` it just
received:

| Prior evidence seen | Response |
|---|---|
| none | listDirectory on a MISSING path **and** on the real one |
| a listing, no warning | listDirectory on the real path again (redundant) |
| a `model:no_progress` warning | writeFile, complete |

A counter-driven stub would advance regardless and pass against a runtime carrying
nothing. Here turn 3 is **unreachable** unless the warning was genuinely delivered, so a
runtime that drops carried evidence cannot finish the run at all — the suite fails hard
rather than passing vacuously. The mutation confirms it: with the carry removed, the run
dies at the no-progress threshold.

**Outcomes are pinned as the runtime actually represents them**, discovered rather than
assumed: an unsuccessful inspection is carried as `result.status: 'not_found'` with empty
entries — **not** an `error` field, which is what the JSON-era suite implied. Turn 1
inspects a missing and a real path in one response, so a single carried set contains an
unsuccessful and a successful outcome differing only in their recorded result. Turn 2
repeats a path, which is what lets the runtime name the repetition in
`repeatedListPaths`.

**Three runtime facts learned by failing, each now recorded in the suite:**

1. **Phase separation is enforced.** A response mixing inspection and mutation is refused
   as `execution.phase_violation` and executes **nothing**. The first fixture emitted
   `createFolder + listDirectory` and looped to its step limit having performed no
   operation — the carried evidence contained only the violation warning.
2. **`previousActionResults` means the PREVIOUS turn, not a transcript.** `actionResults`
   is reset per turn (`server.js` ~19293). Pinned explicitly so a future change to
   cumulative history is a deliberate decision rather than silent drift.
3. **`recordRunEvent` writes to the REPLAY SNAPSHOT and the run log, not the ticket
   journal.** The durable no-progress decision lives in `snapshot.events`.

**Cross-run isolation is scoped correctly.** A concurrent decoy run on another ticket
executes throughout. The leak assertion covers *carried evidence*, not the raw prompt:
both runs share one workspace, so the decoy's file legitimately appears in the subject's
workspace snapshot — that is the filesystem described truthfully. Leakage would be the
decoy's operation records appearing in the subject's `previousActionResults`. The first
version asserted on the raw body and failed for that reason; taking it at face value
would have produced a fabricated isolation defect.

**Mutation `carried-evidence-dropped-from-prompt`** removes the composition that carries
prior results into the next request. The first turn's operations still execute, replay
still records them, and later model calls still occur — only the model's knowledge is
gone. Killed, with the run failing to converge exactly as the contract predicts.

### Correction — timeline determinism assertion was over-strict, twice (2026-07-27)

An assertion I added in `fb93128` failed under checkpoint load a second time, in a second
way. Recorded because the pattern is the point.

* **First over-reach:** it required identical entry LISTS across repeated reads. The
  projection legitimately GROWS as terminal evidence lands, so it failed on growth.
  Narrowed to "already-reported entries are never rewritten".
* **Second over-reach:** that narrowed form still failed, because `addEntry` deliberately
  ENRICHES an existing entry when a higher-priority source arrives for the same dedupe
  key, merging details and keeping the stronger source. Designed behaviour — and the same
  mechanism the receipt tranche relies on.

Now scoped to the authority entry this suite owns: its identity, decision, and structured
`rule` must not drift. Growth and enrichment elsewhere are permitted because they are what
the projection is designed to do. The attribution mutation still kills.

**The lesson:** "deterministic projection" is not "byte-identical output". A projection
that merges evidence from several durable sources is deterministic *given the same
inputs*, and its inputs keep arriving. Two failures were needed to state that precisely,
and both were my assertion being wrong rather than the runtime.

**Follow-up correction (2026-08-18) — the original scenario-4 assertion still crossed
the unfrozen source boundary.** The two corrections above narrowed the authority-entry
assertions, but an older byte-equality assertion at the end of the same owner continued
to compare the first denial projection with a later read. A controlled writer-order
reproduction held `transitionTicketAfterRun` after the Run terminal bundle. The first
projection then saw Ticket `in_progress`, an unsettled Ticket attempt, and 18 entries;
after the legitimate transition settled the attempt, projected the Ticket to `failed`,
and appended `ticket.updated`, the later projection had 19 entries and a changed
`ticket:state`. The Run, replay, evaluation, consequence, and receipts did not change.

This is **in-flight evidence / test quiescence**, not projector nondeterminism. The owner
now waits for the canonical terminal Ticket projection — the source-owned boundary after
exact attempt settlement — and compares two adjacent reads taken after that boundary.
It still requires identical canonical entries/order for an unchanged source set and
still verifies that reading changes neither Run nor Ticket revision. The production
projector and Ticket-attempt semantics are unchanged.

### OPEN — model-contract mutating cap resolves to 8 instead of 2 (2026-07-27)

**The armed diagnostics named it on the first recurrence.** `model-contract-violation-test.js`
failed a third time during clean-worktree validation of `49092e3`, and this time the
suite reported its own inputs:

```
captured OVERSIZED requests: 2
run status: failed error: ... rejected by the per-response action limits (8 total / 8 mutating) ...
violation events: 2 streak: 2
[request 1] feedbackMatches=["... at most 8 total action(s) and at most 8 mutating action(s) ..."]
health: 200 {"status":"ok","ready":true}
```

**It is NOT a missing request** — the hypothesis the previous entry called most likely.
Two requests were captured and the second DOES carry corrective feedback. The feedback is
simply wrong: it states **8 mutating** where the suite expects **2**, and the run's own
failure message agrees (`8 total / 8 mutating`). Health is clean, so no latch or
backpressure is involved.

**What is established:**

* `MAX_AGENT_ACTIONS_PER_RESPONSE` is hard-coded 8; `MAX_MUTATING_ACTIONS_PER_RESPONSE`
  is `env AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || 2`.
* That variable is set **nowhere** — not in `.env`, not in the shell, not in the suite's
  child env. So the process constant is 2.
* Yet the enforced and reported mutating cap was 8, equal to the total. The mutating
  ceiling collapsed onto the total.
* `resolveRunActionCaps` prefers what the RUN RECORDED (`run_semantics_snapshot`) over the
  live constants — deliberately, so changing the environment cannot retroactively rewrite
  a historical run's authority. So the run's recorded execution-semantics snapshot
  carried mutating = 8.

**CORRECTION (2026-07-27, later): the durable snapshot is NOT implicated.** Tracing the
message to its source settles it — `createModelResponseContractViolationError`
(`server.js` ~10600) renders the PROCESS CONSTANTS directly:

```js
`(${MAX_AGENT_ACTIONS_PER_RESPONSE} total / ${MAX_MUTATING_ACTIONS_PER_RESPONSE} mutating)`
```

It never consults the run, `runtimeLimitsSnapshot.semantics`, hydration, or
`resolveRunActionCaps`. So "8 mutating" in that message means
`MAX_MUTATING_ACTIONS_PER_RESPONSE` was literally **8 in the server process**, and the
corrective-feedback text agreeing with it is a consequence, not corroboration of a
snapshot fault. My earlier entry inferred a `run_semantics_snapshot` divergence from the
two agreeing; that inference was wrong, and any fix aimed at the snapshot or at
`resolveRunActionCaps` would have been aimed at a layer this evidence does not implicate.

**What that leaves.** The constant is `env AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || 2`,
so the server process saw that variable set to `8`. Repository search finds it set in
exactly two places, neither of which can reach this suite:

| Site | Why it cannot be the source |
|------|-----------------------------|
| `agent-regression-test.js:1374` sets `'8'` | orphaned — not in the checkpoint |
| `execution-semantics-persistence-test.js:133` sets a per-case value | runs AFTER this suite in `POSTGRES_INTEGRATION_SCRIPTS` |

Both set it only in a spawned child's `env`, which cannot affect a sibling suite's
process. No `.env` entry, no shell export.

**Not reproduced on demand.** Three rounds of the suite under deliberate concurrent load
from its checkpoint neighbours all passed. All three real failures occurred in a
clean-worktree checkpoint; in-tree checkpoints have not shown it.

**Boundary capture extended** so the next occurrence is decisive rather than inferential.
On failure the suite now additionally reports the env this test process saw, the env it
passed to the server, and the admitted run's RECORDED semantics — which separates the
four candidates (ambient env, env propagation, recorded snapshot, rendering) in one line
each.

**No production change was made, and no regression suite was written.** The requested
regression would pin snapshot-integrity properties that this evidence shows are not
where the defect lives; writing it would create the appearance of a fix without one.
Confirming the real mechanism needs one more captured occurrence — which the extended
capture now makes self-describing.

**Nothing was changed.** Per the standing rule the failure was diagnosed, not weakened —
no retry, no relaxed assertion, no widened timeout. The suite passes standalone and on
checkpoint reruns, so it is not blocking, and its diagnostics now make each occurrence
self-describing.

*(This is the second time armed first-failure capture converted an "intermittent,
unexplainable" suite into a specific claim about production state — and the second time
the leading hypothesis beforehand was wrong.)*

### OPEN — load-dependent suite failures under checkpoint (2026-07-27)

### OPEN — load-dependent suite failures under checkpoint (2026-07-27)

Two suites have now each failed **once** under checkpoint load and passed repeatedly
standalone. Recorded together because they share a shape, and kept separate from the
resolved liveness defect because **neither shows a latch signature** — no `degraded`
health, no `Evidence persistence latched` line, no `EVENT_PERSISTENCE_UNAVAILABLE`.

| Suite | Symptom | Standalone |
|-------|---------|-----------|
| `delegated-run-logging-containment-test.js` | "the run:completed echo insert was attempted and rejected" | 3/3 pass |
| `model-contract-violation-test.js` | "corrective feedback must state both the total (8) and mutating (2) limits" | 3/3 pass; **RECURRED 2026-07-27** |

**What they have in common:** both drive real agent runs against a model stub and assert
on the CONTENT of runtime-generated feedback at a particular turn. That is the class most
sensitive to timing — a turn arriving in a different order, or a run settling later than
the assertion expects, changes the observed text without any contract being violated.

**Do not preemptively weaken either.** No retries, no softened assertions, no widened
timeouts — the same standing rule as the liveness escalation, which was vindicated when
the "quiet period" there turned out not to be a fix. If either recurs, apply the
first-failure discipline that solved the liveness incident: capture the state at the
moment of failure rather than reasoning from the summary line. Neither currently reports
what the run was doing when the assertion failed, which is precisely the gap that made
the liveness incident undiagnosable for three tranches.

**`model-contract-violation-test.js` has now RECURRED** — same suite, same assertion
(line ~214), on the clean-worktree validation of `a853eaf`, with no latch signature
again. Per the standing rule it was diagnosed rather than weakened, and the first thing
diagnosis needed was inputs the suite did not record.

**What the assertion actually reads:** `provider.requestBodies(OVERSIZED)[1]` — the
SECOND provider request for that scenario, defaulting to `''` when absent. So the summary
line cannot distinguish two very different causes:

* the corrective feedback genuinely changed or lost a limit; or
* the second request was never captured, in which case the empty default fails both
  regexes and the message blames the feedback.

The immediately preceding assertions pass (`oversizedViolations.length === 2`, streak 2),
which means two model responses WERE processed — so the second cause is the more likely
one and the message is actively misleading.

**First-failure capture added (diagnostics only — no retry, no timeout change, no
weakened condition).** On failure the suite now records: how many requests were captured,
the run's status and error, the violation count and reconstructed streak, per-request
byte length and every `at most …` fragment found, and a `/health` snapshot so a latched
or backpressured deployment is ruled in or out. The assertion message now also states the
captured count.

This is the same discipline that resolved the evidence-latch defect after three wrong
hypotheses: make the repository able to state which input failed before theorising about
why.

### Timeline cluster COMPLETE — RETIRED `ticket-timeline-authority-visibility-test.js` (2026-07-27)

Its authority half moved to `timeline-authority-evidence-test.js` in an earlier tranche;
the remaining half is now `timeline-receipt-projection-test.js` — **32 assertions, 6
scenarios, registered**. Every live assertion has a destination, so the historical file
is deleted.

**The central contract is DEDUPLICATION**, and it exists because the same operation is
durably recorded in TWO places: the append-only `workspace.operation` event and the run's
replay snapshot `workspaceOperations`. Both survive a crash and both are authoritative
for different questions. If the fold breaks, the timeline double-reports every operation
— an operator auditing what an agent touched sees twice the activity that occurred, with
no indication which half is real.

| Scenario | Contract |
|----------|----------|
| 1 | one operation in both sources renders exactly once, keeping its receipt identity |
| 2 | **positive control** — four genuinely distinct reads render as four entries, including one that exists ONLY in replay |
| 3 | source labels are DERIVED: a receipted read is `embedded_receipt`, an unreceipted one is not, and receipt metadata (hash, size) survives |
| 4 | a committed mutation projects one `operation_history` entry carrying the durable `historyId` linking back to the ledger |
| 5 | triage projects at ticket and run level, and resolution states `statusUnchangedByResolution` — a reviewed failure is still a failure |
| 6 | provenance names template version, id and exact trigger; fabricated provenance is refused by referential integrity |

**`legacyUnversioned` is retired as obsolete, with evidence.** The historical suite
asserted that an unversioned template source "renders safely". That state is no longer
reachable: the runtime throws a data-integrity error for a `process_template` source
missing `templateVersion`, and the store enforces a foreign key from the ticket to the
trigger that produced it. Scenario 6 pins the replacement behaviour — fabricated
provenance is refused at the data layer, not judged at render time — so the retirement
rests on what the runtime does rather than on the assertion's absence.

**The mutation took three aims, and the first two survived for the same reason.** This is
the ninth instance of the standing lesson and the most instructive so far:

1. Removing the replay pass's `workspaceEventKeys` guard — **survived**. `addEntry` still
   folded the duplicate, because both entries derive the same `dedupeKey`.
2. Making the replay entry's `dedupeKey` unique — **survived**. The `workspaceEventKeys`
   guard skipped the item before `addEntry` ever saw it.
3. Changing how the replay side COMPUTES `evidenceKey` — **killed**. Both guards key off
   that one value, so altering it defeats both at once.

Neither guard is redundant and neither is sufficient alone to expose the regression
through outcomes: they are two layers over a single shared key. **The mutation had to
target the key, not either consumer of it.** Tuning the assertions after the first
survival would have produced a suite that fails for the wrong reason.

*(Fixture facts learned by failing, each now recorded in the suite: operation receipts are
written with `recordOperationReceipt` and outcomes are `succeeded`/`failed`/`refused`, not
`committed`; workspace receipts require a `mutationFingerprint`; the returned shape is
`{record, event, inserted}`; and the projection's durable link is `details.historyId`,
derived from the record, rather than `receipt.operationId`, which is only whatever the
caller placed in the receipt document.)*

### Preflight cluster — RETIRED `invalid-action-preflight-recovery-test.js` (2026-07-27)

**Replaced by `action-batch-preflight-test.js` — 23 assertions, 6 scenarios, registered.**

**The contract is ATOMICITY OF ADMISSION:** the entire action batch is validated before
any action executes, so one invalid argument rejects the whole batch. If validation ran
per action during execution, `[createFolder ok, createFolder ""]` would create the first
folder and only then reject the second — leaving a workspace half-modified by a batch the
runtime calls *rejected*, with no receipt explaining the leftover. "Rejected" would mean
"partially applied", which is worse for an operator than either executing or refusing
cleanly.

| Scenario | Contract |
|----------|----------|
| 0 | the VALID action preceding the invalid one leaves no filesystem effect, no receipt, no replay execution |
| 1 | hard floor: all three state-driven turns were reached and the run recovered to completion |
| 2 | `workspace.invalid_action_args` names the operation, the action INDEX (1, not the valid 0), the reason, and `rejectedBatch`/`executed:false` — in both replay and the append-only journal |
| 3 | the next turn is told the batch was rejected, that nothing ran, and which action to fix |
| 4 | mixed-phase batches are refused via `execution.phase_violation` with no mutation and no receipt |
| 5 | **positive control** — the corrected single-phase batch executes and is the run's ONLY receipt |

**The provider is state-driven.** Each branch is reachable only if the runtime delivered
the matching corrective evidence, so a runtime that rejects silently cannot finish the
run and the suite fails hard rather than passing vacuously.

**Mutation `preflight-executes-valid-prefix`** narrows preflight to the first action only,
so a batch whose invalid action comes later passes admission and executes its prefix.
Killed.

*(Assertion-ordering lesson: the hard floor originally ran first, so the mutation failed
with "the run didn't reach three turns" — true, but naming the symptom rather than the
defect. The leftover prefix is observable however the run ended, so it is checked FIRST
and the failure now names the actual contract. Worth noting the mutation also collapses
the conversation, because corrective evidence is what drives the provider's next branch —
that coupling is inherent to a state-driven stub and is a strength, but it means the
ordering of assertions determines which truth gets reported.)*

### Browser-evidence cluster — RETIRED `browser-evidence-audit-test.js` (2026-07-27)

The analysis below was recorded before the tranche was built and is retained because it
is the runtime semantics record. The disposition is at the end of this section: the
replacement is `browser-evidence-verdict-test.js`, registered, and **the test-only
terminalization seam this analysis concluded was necessary turned out not to be.**

Disposition: **REPLACE**. `classifyBrowserEvidence` (`server.js` ~6206) is live and has no
registered coverage. Full semantics recorded here so the next tranche starts from the
runtime rather than from the historical suite.

**Gate:** `isBrowserRun(run)` requires `run.targetRef.kind === 'browser'` AND
`run.browserTargetSnapshot`. Anything else → `not_applicable`.

**Inputs:** `snapshot.browserOperations` and `snapshot.parsedModelPlans` only.

**Decision order (first match wins):**

| # | Condition | Status |
|---|-----------|--------|
| 1 | `browserOperations` empty | `objective_unverified` |
| 2 | any `navigate` whose `receipt.metadata.finalUrl` contains `/sorry/`, `/captcha`, `/login`, `/signin`, `/403`, `/blocked` | `target_blocked_or_redirected` |
| 3 | `readPageText` with `status==='ok'` and `receipt.metadata.bytes > 0`, **or** `observe` with `receipt.metadata.elementCount >= 3`, **or** `screenshot` with `status==='ok'` | `evidence_available` |
| 4 | otherwise | `browser_evidence_insufficient` (detail differs when a plan had `complete: true`) |

**The load-bearing property** is that step 3 requires REAL captured content. `complete:
true` alone lands in step 4, and a bare `navigate` record does not satisfy step 3 — the
model claiming success cannot manufacture evidence. Note `objective_unverified` is
reached only via step 1 (no operations at all), so a suite must not expect it from a
run that navigated but captured nothing; that case is `browser_evidence_insufficient`.

**Durable path:** the verdict flows into `buildRunEvaluation` (~6169) → the run's
`runEvaluation`, and `buildFinalizedRunReplayState` (~11661) → the finalized replay. Both
are observable from the store after terminalization, so the suite can assert the DURABLE
classification rather than calling the classifier directly.

**Privacy contract respected by construction:** `evidence_available` is reachable through
`readPageText` bytes or `observe` elementCount ≥ 3 — no screenshot fixture is needed or
permitted. A negative assertion that no screenshot material appears keeps read-only text/DOM
evidence distinct from forbidden image evidence.

**Fixture route — the startup-convergence idea was TRIED AND DOES NOT WORK.** Seeding a
browser-target run, terminalizing it with `store.transitionRun`, attaching a crafted
replay snapshot and letting startup convergence finalize it leaves `run.runEvaluation`
**unset**: convergence calls `finalizeTicketForRun`, which settles the TICKET, and never
runs the run's terminal evaluation builders. A suite written that way times out waiting
for an evaluation that is never built.

The verdict is written by `buildRunEvaluation` (~6169) and `buildFinalizedRunReplayState`
(~11661), both invoked on the runtime's own terminalization path. So the next attempt must
either (a) drive a real run to terminalization through the runtime with a stubbed provider
— the pattern `carried-evidence-preservation-test.js` uses — while giving the ticket a
browser `targetRef`, or (b) find an operator-reachable route that re-derives the
evaluation. Option (a) is the known-good shape; the open question is whether a browser
run can be driven without a live browser process, since `isBrowserRun` needs
`targetRef.kind === 'browser'` AND `browserTargetSnapshot` on the RUN, which the runtime
populates from the ticket's target.

**FIXTURE SEAM PROBE — RESULT (2026-07-27).** The two boundaries are now traced:

* **`browserTargetSnapshot`** is set on the run at creation from the ticket's browser
  target (`server.js` ~14084, `normalizeBrowserTargetSnapshot`). A run only satisfies
  `isBrowserRun` if it carries BOTH that snapshot and `targetRef.kind === 'browser'`.
* **`browserOperations`** are not written by the suite anywhere in production — they are
  appended during execution through the non-terminal evidence repository:
  `completeActionReceipt({ …, replayKey: 'browserOperations', replayItem: evidence })`
  (`server.js` ~17051). That is a real repository path a fixture could use.

**But the public path cannot construct this fixture without a live browser.** Once
`isBrowserRun(run)` is true, execution routes to the browser path, and
`getOrCreateBrowserSession` (~17066) requires `run.browserTargetSnapshot.status === 'active'`
and then calls `createBrowserSession(...)` — an actual browser process. A stub *provider*
does not help: the provider is the model, not the browser. So:

> A run cannot both satisfy `isBrowserRun` and reach the runtime's terminalization
> builders unless a real browser session is created.

That is the finding, recorded rather than worked around. The three routes the objective
allowed resolve as: (a) preferred — real agent run with stub provider — **not possible**,
because the browser branch demands a session; (b) local browser-target harness against a
deterministic page — possible in principle, but requires a browser process in the test
environment, which has not been established here; (c) a narrow test-only seam invoking
normal terminalization with persisted browser evidence — the remaining option, and it
should be justified by (a) being impossible rather than by convenience.

**ENVIRONMENT VERIFICATION — RESULT (2026-07-27). Route (c) is justified.**

| Check | Result |
|-------|--------|
| chromium on PATH | present at `/usr/bin/chromium-browser` |
| `BROWSER_ENGINE_EXECUTABLE` set | **no** |
| runtime auto-discovery of a system chromium | **none** — `configuredExecutable()` reads only that env var |
| `getEngineStatus()` as the runtime sees it | `{configured:false, executableExists:false, available:false, version:null}` |
| browser suites registered in the release checkpoint | **none** |

So although a chromium binary exists on this machine, the runtime reports the engine
**unavailable**, and no checkpoint suite launches it. Route (b) would require setting
`BROWSER_ENGINE_EXECUTABLE` in the checkpoint environment — a deployment/config change
that a test must not silently depend on, and one no existing registered suite establishes
as reliable. **That is the reason the public path cannot be used in the checkpoint
environment**, recorded here as the objective requires.

**Therefore route (c):** a narrow test-only seam that triggers normal terminal evaluation
for a persisted browser run. Its constraints, restated so the next tranche cannot drift:
persist browser operations through `completeActionReceipt` with `replayKey:
'browserOperations'` — the production write path — and let `buildRunEvaluation` /
`buildFinalizedRunReplayState` produce the verdict. Only the ACT of initiating
terminalization may be test-specific. Never call `classifyBrowserEvidence` directly as the
primary proof, never write the verdict, never build operations in memory only.

*(If `BROWSER_ENGINE_EXECUTABLE` is later configured for the checkpoint and a registered
browser suite demonstrates reliable launch, route (b) becomes preferable and this seam
should be revisited.)*

**Scenario matrix (already designed, reusable):** no ops → `objective_unverified`;
blocked navigate carrying text+DOM evidence → `target_blocked_or_redirected`, which is the
precedence proof; `readPageText` bytes → `evidence_available`; `observe` elementCount 3 →
`evidence_available`; navigate + `observe` 2 + `complete: true` → `browser_evidence_insufficient`,
which is the "a claim is not evidence" proof; non-browser run → `not_applicable`. Assert
BOTH `runEvaluation.browserEvidence.status` and the finalized replay's
`browserEvidenceStatus`.

**Mutation target:** the step-3 predicate (`hasContentEvidence`), e.g. treating a bare
navigate as content. That leaves the run and replay structurally valid and changes only
the verdict, which is what the objective requires.

**Not built here:** the session's context budget ran out at this point. Recording the
runtime semantics is the expensive part of this cluster and it is done; the fixture is a
short hop from the startup-convergence pattern.

### BUILT — `browser-evidence-verdict-test.js` (13 scenarios, 181 assertions), 2026-07-27

Registered. `browser-evidence-audit-test.js` is retired from disk; the manifest orphan
count falls to 64.

**CORRECTION — the terminal-evaluation seam is NOT needed, and was not shipped.**

Everything above about the environment stands: chromium exists on this machine, the
runtime reports the engine unavailable, and no checkpoint suite launches one. What was
wrong is the inference drawn from it — that reaching `buildRunEvaluation` therefore
required a test-only route into terminalization. It does not. The reasoning missed a
state the runtime passes through on every run:

> A run held at its **first model call** is `running`, its replay snapshot is already
> initialized (`createRunReplaySnapshot` runs before the provider call), and it has
> captured nothing yet. That is precisely the state browser evidence needs to be
> attached to — and the run then terminalizes **through its own normal path**.

So the fixture holds each run there with a provider stub that blocks until the suite
releases it by name, persists that run's operations through `completeActionReceipt`
with `replayKey: 'browserOperations'` — the same repository call
`recordBrowserOperationEvidence` makes — and releases the gate. The runtime completes
the run and writes both verdicts itself. **No production source changed.**

The seam *was* built first (a doubly-gated `POST /__test__/runs/:id/terminal-evaluation`
calling `commitRunTerminalization`), proved to work, and was then removed once the
gated-provider fixture showed it redundant. Recorded because the general lesson is worth
more than this cluster: *a seam justified by "the public path cannot reach X" should be
re-tested against the states the runtime already passes through on the way to X.* The
blocked branch was `getOrCreateBrowserSession`, which is reached only when the model
proposes a browser action — and a run that never gets a model response never proposes
one.

**Every live assertion of the retired suite is mapped:**

| Retired assertion | Successor |
|-------------------|-----------|
| non-browser run → `not_applicable`, and its replay gains no `browserOperations` | scenario 2 |
| `/sorry/` navigation → `target_blocked_or_redirected`, detail names the URL | scenario 4 |
| `readPageText` content → `evidence_available`, in run AND replay | scenario 6 |
| low `observe` → insufficient | scenario 8, tightened to the exact status |
| no browser operations → `objective_unverified` | scenario 3 |
| terminal status independent of the evidence verdict | scenario 1 (every run completes; four of the six verdicts are not `evidence_available`) |
| exactly five allowed browser operations, none mutating | scenario 11 |

Three of those were **weakened** in the original and are not ported that way. Its
low-observe and completion-versus-evidence checks accepted
`browser_evidence_insufficient` **or** `objective_unverified`, which is precisely the
distinction this classifier turns on; the replacement asserts one status. And the
original **skipped with exit 0** when no browser engine was found — which, in this
environment, is what it would always have done.

**What the replacement adds that the original had no way to assert:**

- **Precedence.** A run whose navigation was blocked *and* which carried page text and a
  7-element DOM inventory — evidence sufficient on its own — still reports
  `target_blocked_or_redirected`. A classifier checking content first would call that run
  verified while it never reached the target.
- **The two sufficiency branches, separated.** The page-text run carries no `observe`;
  the DOM run carries no `readPageText`. Either branch alone decides its run, which is
  what makes the two mutations below independently meaningful.
- **A claim is not evidence, stated as a runtime property.** The stub answers *every* run
  identically — "objective addressed; finishing", `complete: true` — so the only thing
  differing between scenarios is what was captured. Four of the six browser runs durably
  record that completion claim and do **not** report `evidence_available`.
- **Attribution.** A second browser target runs concurrently with sufficient evidence; the
  run with none stays `objective_unverified`. Each run carries exactly its own operations
  and receipts. And offering one run's evidence under another ticket's ownership is
  **refused by the production write path** — asserted before terminalization, so the
  refusal comes from the store's ownership check rather than from the finalized-snapshot
  guard that would refuse everything afterwards.
- **Hydration.** Both verdicts and both explanations are re-read after a full runtime
  restart, and the restarted runtime still serves the evaluation over the operator API.
- **The privacy contract.** No screenshot operation, no screenshot artifact material, and
  no verdict justified by one — `evidence_available` is reached twice, by text and by DOM,
  and never by an image.

**Two mutations, both killed, each on its own branch:**

| Mutation | Contract removed | Failed on |
|----------|------------------|-----------|
| `browser-page-text-not-evidence` | captured page text is sufficient on its own | scenario 6 — the page-text run reports insufficient |
| `browser-dom-observation-not-evidence` | a ≥3-element DOM observation is sufficient on its own | scenario 7 — the DOM run reports insufficient |

Both leave the run, the receipts, the terminalization and the finalized replay intact and
change only the durable verdict, which is the point: the suite fails because the record is
wrong, not because the fixture broke. Keeping the two sufficient runs disjoint is what
makes that true — a single run carrying both text and a DOM inventory would survive either
mutation on the strength of the other branch, which is the same defence-in-depth trap A20
has now hit four times.

### Workspace-error cluster — RETIRED five `er*` orphans (2026-07-27)

**Replaced by `workspace-error-containment-test.js` — 160 assertions, 10 scenarios,
registered.** Orphan backlog 64 → 59.

Retired together: `er1-readfile-recoverable-test.js`,
`er2-createfolder-existing-file-recoverable-test.js`,
`er2a-readfile-notafile-recoverable-test.js`,
`er2b-writefile-notafile-recoverable-test.js`,
`er2c-listdirectory-not-enoent-recoverable-test.js`.

**They were five suites for one property, and that is why all five rotted together.**
Each spawned its own server, seeded its own `DATA_DIR`, and asserted one shape of the
same contract. Nothing tied them to each other, so nothing noticed when the cutover
killed the whole family at once.

**THE CONTRACT — the runtime must tell two kinds of failure apart:**

| Class | `failureKind` | Required behavior |
|-------|---------------|-------------------|
| Environmental | `workspace_error` | run CONTINUES; failure recorded with `blocked: false`; reported back to the model |
| Policy | `protected_path` | run FAILS; recorded with `blocked: true`; **no further turn** |

The discriminator is one line in the action loop:
`if (error.failureKind !== 'workspace_error') throw error;` (`server.js` ~20015).

**It had no registered coverage of any kind.** Before this suite, no registered file in
the repository referenced `workspace_error`, `WORKSPACE_FS_ENOENT` or
`WORKSPACE_PATH_TYPE_CONFLICT` — only the five orphans did.

**Both directions are defects, and the second is the worse one.** Treating environmental
failure as terminal kills runs on a missing file the model could have worked around —
the regression the er* family was written for. Treating a policy refusal as recoverable
hands a refused request back to the model as ordinary feedback and lets it keep trying,
turning a containment boundary into a retry loop. `workspace-authority-gate-test.js`
proves protected paths are *refused*; nothing proved the refusal was **terminal**.

**Live shapes, verified against the runtime before anything was written:**

| Shape | Classification site | Contained? |
|-------|--------------------|-----------|
| `readFile` on a missing path | `createStructuredWorkspaceFsError` → `WORKSPACE_FS_ENOENT` | yes |
| `readFile` on a directory | `WORKSPACE_PATH_TYPE_CONFLICT` | yes |
| `writeFile` onto a directory | `WORKSPACE_PATH_TYPE_CONFLICT` | yes |
| `createFolder` where a file exists | `WORKSPACE_PATH_TYPE_CONFLICT` | yes |
| `listDirectory` on a file (ENOTDIR) | wrapped in the `listDirectory` catch | yes |
| `readFile` escaping the root | `WORKSPACE_PATH_TRAVERSAL` / `protected_path` | **no** |
| `writeFile` to a hidden path | `WORKSPACE_HIDDEN_PATH` / `protected_path` | **no** |

*(`listDirectory` on a missing path is not an error at all — it returns
`status: 'not_found'`, already covered by `carried-evidence-preservation-test.js`.)*

**Historical assertion mapping — every live property has a destination:**

| Retired assertion | Successor |
|-------------------|-----------|
| run completed / `terminalStatus` completed after a recoverable error | scenario 1, for all five shapes |
| exactly one failed operation of that shape, carrying an error | scenario 3 |
| `blocked === false` on a recoverable failure | scenario 3 |
| no `run:step_limit` event | scenario 1 |
| the follow-up action executed and its file exists | scenario 2 |
| traversal: run failed, `terminalStatus` failed, `blocked === true` | scenario 6 |

One historical assertion is **not** ported as written: er2/er2a/er2b/er2c each required the
recovery action to be a `listDirectory`. Which operation the model chooses next is
fixture detail, not contract; the live property is that a further action executed at all,
which scenario 2 asserts through its durable receipt and its filesystem effect.

**What the replacement adds that the originals could not:**

- **The failure is REPORTED, not merely survived.** Scenario 4 asserts the structured
  `previousActionResults` the runtime actually sent: the failed operation, the path it
  attempted, and a non-empty reason — and no `result` alongside it. The stub is
  state-driven, so a runtime that contains the error but says nothing cannot finish the
  run at all.
- **The refusal is terminal, proved by absence of both consequences.** Scenario 7
  requires the policy runs to have received exactly one model turn and to have left no
  follow-up file. A suite asserting only "the run failed" would survive the boundary
  being downgraded to feedback if the retry happened to fail too.
- **Containment reaches the filesystem.** Scenario 8 re-checks the workspace: the
  directory a `writeFile` targeted is still a directory with its contents intact, the
  file a `createFolder` targeted still holds its original bytes, the missing path was
  not created, the hidden path was never written, and nothing landed outside the root.
  "The run survived" is not the same as "nothing half-happened".
- **A positive control.** One case reads a file that exists. Without it every assertion
  above is satisfied by a runtime that fails every operation, because *contained* would
  be indistinguishable from *broken*.
- **No vacuous exit.** No skip path, no `NOT_PROVEN`, every wait throws on timeout, and
  `assertScenariosExecuted` enforces a floor. The historical suites had none of this.

**Three mutations, all killed, aimed at two different layers:**

| Mutation | Layer | Failed on |
|----------|-------|-----------|
| `recoverable-workspace-error-terminates-run` | the discriminator branch | scenario 1 — a missing file kills the run |
| `policy-refusal-treated-as-recoverable` | the same branch, inverted | scenario 6 — a path escape completes |
| `missing-file-classified-as-policy-refusal` | the CLASSIFIER below it | scenario 1 — the branch is still correct, it is told the wrong thing |

The third exists because the first two only prove the branch reads `failureKind`. It
leaves the branch untouched and mislabels ENOENT upstream, so the run dies *and* the
durable record calls a missing file "blocked" — which an operator would read as an
authorization decision that never happened.

**Assertion ordering was corrected, and the lesson is the same one the preflight tranche
recorded.** The first version asserted the exact model-turn count in the hard floor, so
two of the three mutations failed with *"expected 2 turns, got 1"* — true, and a
description of the symptom rather than of the defect. The run's terminal status is
observable however the conversation went, so it is checked first; the exact turn counts
moved to the scenarios where they are the property under test.

**Observation, recorded not fixed: the ENOENT message handed to the model contains the
absolute host path.** `previousActionResults` carries the raw `fs` message, e.g.
`ENOENT: no such file or directory, lstat '/tmp/tstharness-ws-69nVwM/absent.txt'`. The
model is given the workspace root's real filesystem location, and that text goes to the
external provider. Other surfaces redact deliberately — browser runs redact URLs and
model prose — so this is an inconsistency rather than an established position. It is out
of this cluster's scope and needs its own disposition: either the error is sanitized to
the workspace-relative path before it reaches the prompt, or the disclosure is stated as
intended. Not changed here, because the current text is what the retired suites and the
replacement both assert against, and changing it silently would move a contract while
claiming to cover it.

### Rerun-admission cluster — RETIRED three orphans (2026-07-27)

**Replaced by `rerun-admission-gate-test.js` — 65 assertions, 9 scenarios, registered.**
Orphan backlog 59 → 56.

Retired: `ticket-triage-rerun-hardening-test.js`, `manual-rerun-attempt-ceiling-test.js`,
`max-attempts-control-test.js`.

**THE CONTRACT — what may start new work after a ticket has stopped.** Two things may
refuse, and they are the only bounds on repeating failing work:

| Bound | Enforced in | Lifted by |
|-------|-------------|-----------|
| unresolved ticket triage | `hasUnresolvedTicketTriage`, consulted by rerun, retry and `createRunsForTicket` | resolving the triage |
| `executionPolicy.maxAttempts` | `validateManualRerun` — the ONLY site, counting runs that exist | raising or clearing the ceiling |

**Neither had registered coverage.** The refusal strings `Manual rerun rejected` and
`unresolved ticket-level triage`, and the ceiling-edit route, appeared only in the three
orphans.

**Every refusal is asserted twice — the status AND the run count read from the store.**
A gate that returns 409 and creates a run anyway is indistinguishable from a working gate
by its response alone, and that is the failure mode an operator would never see.

**THE MOST USEFUL FINDING: the triage gate is two layers deep, and only the outer layer
explains itself.**

The `triage-gate-never-fires` mutation makes `hasUnresolvedTicketTriage` return `false`
— disabling all three call sites at once. It is killed, but **not where it was aimed**.
The rerun is still refused, because the store's own `reopenTicket` raises
`TICKET_TRIAGE_REQUIRED` underneath the route, *with the identical message text*. So the
rerun scenario passes through the mutation, and what actually fails is the retry
scenario, where the surviving refusal degrades to a bare `409 Conflict`.

> The gate holds without the predicate. What does not hold is the refusal remaining
> **legible** — and an unexplained 409 is one an operator cannot act on.

A suite asserting only "the rerun was refused" would have stayed green through the
removal of the entire route-level gate. Every refusal in the replacement therefore
asserts the reason text, not just the status. This is the fourth time in A20 that a
mutation landing somewhere unexpected meant defence in depth rather than a coverage hole,
and the first time the surviving layer was materially *worse* than the one removed.

**Historical assertion mapping:**

| Retired assertion | Successor |
|-------------------|-----------|
| blocked ticket with unresolved triage: rerun 409 | scenario 6, on runtime-produced triage |
| retry on a run whose parent ticket has unresolved triage: 409 | scenario 8 |
| PATCH status → open on a triaged ticket creates no run | scenario 6 |
| resolved triage: rerun allowed again | scenario 7 |
| non-triaged ticket: rerun still works | scenario 1 (positive control) |
| below-ceiling rerun allowed, creating exactly one run | scenario 1 |
| rerun at `maxAttempts` rejected 409, creating no run | scenario 2 |
| unauthorized ceiling edit 403, policy unchanged | scenario 4 |
| ceiling edit preserves other policy fields, creates no run | scenario 4 |
| the rerun guard reads the updated ceiling | scenario 3 |

#### maxAttempts edit / Ticket-finalization concurrency defect (resolved 2026-08-10)

A later canonical checkpoint failed scenario 2 while setting `maxAttempts` to the
two attempts already consumed. That historical result established neither a product
nor a harness cause because its `/tmp` evidence did not survive the resumed forensic
session. The contract is nevertheless unambiguous: setting the ceiling to attempts
already consumed is legal, creates no Run, and closes the next admission at
`attemptCount >= maxAttempts`.

A provider-free controlled regression then forced the exact disputed ordering. It
terminalized Run 2, stopped before the parent Ticket projection, let the policy route
read Ticket revision 5 as `in_progress`, finalized the Ticket to revision 6 / `failed`,
and continued the policy write. The route returned HTTP 500 with
`STATE_TRANSITION_CONFLICT` (`ticket 1 is failed; expected in_progress`). Both existing
Run snapshots and the Run count remained unchanged. This proves a production
concurrency defect, not a settlement prerequisite: the public maxAttempts control is
not status-gated, but it used a same-status transition merely to persist a policy field.

`updateTicketMaxAttempts` is now the narrow authority. Under the Ticket row lock it
rebases over revision changes when the complete execution policy is unchanged, preserves
the current authoritative status and all other policy fields, and rejects a stale
policy snapshot with `OPTIMISTIC_CONCURRENCY_CONFLICT`. The controlled regression also
forces two policy writes from one snapshot and proves exactly one commits. Admitted Run
snapshots are never rewritten, no Run is created by the edit, and the next rerun remains
refused at 2/2. The `>=` admission guard is unchanged.

**Improved rather than ported literally.** The retired ceiling suite compared the policy
against a hard-coded field list, which silently stops covering any field the policy
gains. The replacement snapshots the policy **as the runtime normalized and stored it**
before the edit and diffs every key, plus asserts the key count is unchanged so the edit
cannot introduce a field either. (The first draft of this suite hard-coded field names
too, and failed against `verificationTiming` — a field that does not exist. That is the
same fragility, caught immediately.)

**Where the triage comes from.** Scenario 5 is fully public: an ambiguous objective makes
`createRunsForTicket` block the ticket through `blockTicketForObjectiveAmbiguity`, with
required triage and zero runs, no test involvement. Scenario 8 needs a state the public
API cannot reach in one step — a FAILED run whose parent ticket *also* carries unresolved
ticket-level triage — and seeds it through `transitionTicketState`, the same repository
call `blockTicketForNoModelRoute` makes, with the same patch and event type. The
triage-producing paths themselves are covered by `ticket-feasibility-gate-test.js` and
`runtime-feasibility-test.js`.

**Three mutations, three layers, all killed:**

| Mutation | Layer | Failed on |
|----------|-------|-----------|
| `triage-gate-never-fires` | the shared predicate, not one route | scenario 8 — the refusal loses its reason |
| `attempt-ceiling-off-by-one` | `validateManualRerun` | scenario 2 — one extra attempt is granted |
| `ceiling-edit-drops-other-policy-fields` | the ceiling-edit route | scenario 4 — every other policy field resets |

The second is an off-by-one rather than a deletion on purpose: the ceiling still exists,
still reports and still refuses eventually. A suite asserting "some rerun is eventually
refused" survives it; one asserting the exact boundary does not.

**`auto-retry-test.js` is deliberately NOT in this cluster, and here is where the next
tranche should start.** Bounded automatic retry is the *automatic* counterpart of the
same admission question and is live (`assessAutoRetryAfterFailureIfPolicyAllows`,
`runAutoRetryAfterFailureIfPolicyAllows`), gated on `autoRetry === true`, a finite
effective attempt limit (an explicit `maxAttempts` override or the inherited runtime
default), no ticket triage, an individual-agent ticket, `mutationCount === 0`, and a
prospective triage reason code of exactly `runtime_failed`.

That last condition is the blocker, and it is a real one rather than an omission.
`runtime_failed` is the **fallback** reason code (`buildRunTriage`: assigned only when no
structured `failureKind` matched), so inducing it deterministically means finding a
failure path that carries no failure kind at all. Every convenient failure does carry
one: traversal → `protected_path` → `authority_blocked`; provider faults →
`provider_error` → `provider_failed`; malformed model output →
`MODEL_RESPONSE_CONTRACT_VIOLATION` → `model_contract_failed`. Identifying a deterministic
`runtime_failed` producer is the first task of that tranche, not an afterthought inside
this one — driving the retry with the wrong reason code would exercise the *ineligible*
branch while appearing to cover the eligible one.

### The remaining 56 — sequencing

Not repaired here, and deliberately not batch-migrated. A10 established that mechanical
migration is wrong: `bounded-transition-test.js` needed two scenarios re-expressed because the
phase gate superseded them, and `replay-snapshot-storage-test.js` needed a third of itself
retired. Each of the 83 needs the same per-suite judgement about whether its contract is still
live.

Recommended order:

1. **The remaining 5 `cutover-orphan-silent` suites**, regardless of what they guard. Their
   failure mode is invisible, so they are the ones most likely to be mistaken for coverage.
   Use `scripts/child-process-settlement.js`; the unguarded pattern is now fixed in one place.
2. **Suites guarding authority, mutation and evidence contracts** — the ones whose regression
   would be a correctness or security defect rather than a display defect.
3. **Everything else**, retiring rather than porting wherever the mechanism is dead, with the
   reason recorded here.

The manifest makes progress measurable: `node scripts/test-manifest.js` reports the orphan
count directly, and it can only fall by a suite being repaired and registered, or retired with
a reason.

---

### A25. Bounded automatic retry never executed

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-27.** One-line correction; `auto-retry-bounds-test.js` registered (29 assertions, 7 scenarios) |
| **Severity** | **High** — an operator-enabled policy did nothing, and the record looked identical to the policy being off |
| **Discovered by** | Building the A20 replacement for `auto-retry-test.js` |
| **Evidence** | Read-only probe: eligible ticket, `{autoRetry: true, maxAttempts: 2}`, `runtime_failed`, no mutations → **1 run**, triaged |

**Proven behavior (before).** A ticket meeting every documented eligibility condition
produced exactly one run and fell into triage, indistinguishable from a ticket with
auto-retry switched off.

**Mechanism.** `runAutoRetryAfterFailureIfPolicyAllows(failedRun, assessment)` called:

```js
const created = await getTicketRunLifecycleRepository().createRetryRun({ … },
  options.persistence || options);
```

The function has **no `options` parameter**, and no `options` binding exists in its scope
(the only declarations in the file are locals inside unrelated route handlers). Every
eligible retry therefore threw `ReferenceError: options is not defined`, which the
surrounding `catch` swallowed into `{ retried: false, reason: 'retry_creation_failed' }`.
The caller then built triage after the fact, producing exactly the shape an ineligible
run produces.

`createRetryRun` accepts **one** argument; the second was never meaningful. Removing it is
the whole fix.

**Why nothing noticed.** The failure was caught, the run still terminalized correctly, the
triage was still written, and the only observable difference was a run that did not exist.
`auto-retry-test.js` — the one suite that counted runs per ticket — has been orphaned
since the PostgreSQL cutover. This is the **fifth** time in A20 that a suite exposed a
live production defect the moment it could run again.

**Behavior change.** Deployments with `executionPolicy.autoRetry: true` and remaining
effective attempt capacity will retry eligible runtime failures once per available
attempt. The bound may be an explicit ticket override or the runtime default resolved
into each newly admitted run.

---

### A26. `countRunMutatingOperations` always returns 0

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-27.** One authority for both consumers; `run-mutation-evidence-test.js` registered (55 assertions, 9 scenarios) |
| **Severity** | **High** — a run that mutated the workspace was automatically retried, and finalized replays recorded `no_mutations` for runs that mutated |
| **Discovered by** | A25's probe: a ticket whose run wrote a file and then failed on a step limit was retried |
| **Evidence** | Source, plus an observed retry of a run whose write landed on disk |

**Mechanism.**

```js
function countRunMutatingOperations(runId, history = null) {
  history = Array.isArray(history) ? history : [];   // null → []
  return history.filter(record => record.runId === runId && isActualWorkspaceMutation(record)).length;
}
```

Called with one argument it can only return **0**. It never loads history. Both live call
sites call it that way:

| Call site | Consequence of a constant 0 |
|-----------|------------------------------|
| `failAgentRun` | the `mutationCount === 0` half of auto-retry eligibility is inert, so **a run that already mutated the workspace is retried** |
| `buildFinalizedRunReplayState` | `mutationCount: 0` and `mutationOutcome: 'no_mutations'` are written into the finalized replay of runs that DID mutate |

**Observed.** A ticket whose run wrote `mutated-*.txt` and then failed on the execution
step limit produced a second, automatic run. The file was on disk; the guard that exists
to prevent exactly that retry did not fire.

**Why this is the dangerous half of A25.** Retrying an unmutated failure repeats nothing.
Retrying a run that already applied part of its intended change re-enters a workspace the
previous attempt left half-modified — which is the scenario `isAutoRetryableReason` was
written to exclude.

**It was worse than first recorded.** The inventory found **four** zero-argument call
sites, not two, and one more passing `suppliedOperations || undefined` (which defaults to
the same empty array). One of them is `completeAgentRun`, so **every COMPLETED run's
finalized replay also claimed `no_mutations`**, regardless of what it wrote — not only
failures.

**The authoritative source.** `readAllRunOperations` — the committed operation receipts,
the same records operation reconciliation, run consequence and the operator surfaces
already read. A probe confirmed the disagreement directly: a run that wrote `alpha.txt`
and created `beta-dir` had `runConsequence.mutations` listing both (A16's path, correct)
while the finalized replay said `mutationCount: 0, mutationOutcome: 'no_mutations'`. Two
durable authorities, one question, opposite answers.

Not inferred from the requested operation name, a planned action, a refused or failed
operation, a replay entry without a receipt, or the workspace itself — the last cannot
separate this run's changes from what was already there.

**The correction.**

- `resolveRunMutationEvidence(runId)` is **explicitly asynchronous** and returns
  `{ count, available }`. The optional-history parameter that silently defaulted to `[]`
  is gone from every production path.
- Both consumers — the retry assessment and `buildFinalizedRunReplayState` — derive from
  it, so they cannot disagree.
- **Fails closed.** When receipts cannot be read, `count` is `null` and `available` is
  `false`; the replay records `mutationOutcome: 'unknown'` (a truthful third state, not a
  degraded `no_mutations`) and `assessAutoRetryAfterFailureIfPolicyAllows` refuses with
  `mutation_evidence_unavailable`. "We could not tell" must never read as "it changed
  nothing", because both consumers treat 0 as permission.
- **One committed operation counts once**, de-duplicated by operation key, so a
  reconciled effect surfacing under the same key cannot inflate the total.

**Classification, as observed rather than assumed:**

| Class | Durable shape | Counted? |
|-------|---------------|----------|
| committed mutation | receipt, `outcome: succeeded` | yes, once |
| successful read | **no receipt** — reads are replay evidence, not a commit path | no |
| policy-refused mutation | **no receipt** — refused before the operation is prepared | no |
| mutation failing before its effect | receipt with a non-`succeeded` outcome AND an error | no |
| reconciled committed effect | same operation key | once |
| divergent duplicate | **refused by the store** with `IdempotencyConflictError` | cannot exist |

Two of those were corrections found while writing the suite: a policy refusal and a read
leave no receipt at all, so assertions written against "a receipt with a failed outcome"
were wrong about the mechanism even though right about the outcome.

**Mutations — and a defence-in-depth lesson that cost two re-aims.**

| Mutation | Result |
|----------|--------|
| `committed-mutations-ignored` (evidence boundary returns 0) | killed — scenario 1, the replay records 0 of 2 |
| `uncommitted-mutations-counted` (whole non-committed carve-out) | killed — scenario 4, the count inflates to 2 |
| `divergent-receipt-accepted-for-committed-key` (store idempotency guard) | killed — scenario 7 |

`uncommitted-mutations-counted` **survived twice** before landing. Removing the store's
`outcome` verdict alone survived; removing the recorded `error` alone survived too. A
receipt for a mutation that failed before its effect carries **both**, and either one
excludes it. That is defence in depth in the runtime and a warning for testing it: a
mutation removing one exclusion proves nothing about whether the exclusion is covered.
The fifth such finding in A20.

The de-duplication in the counting helper is likewise **defence in depth, not the
control**: the operation-receipt table cannot hold two rows for one key, so the layer that
actually prevents double counting is the store's idempotency guard — which is where the
third mutation is aimed and what scenario 7 asserts.

**Known gap, stated rather than assumed.** The `available: false` branch is fail-closed by
construction but is **not covered behaviorally**. Reaching it requires the receipt read to
fail, which no checkpoint-reachable condition produces; proving it would mean adding a
fault-injection seam to production source. That was judged not worth new production
surface (the A24 precedent), so it is recorded as an uncovered branch rather than counted
as tested.

**Consequence for A20 — `auto-retry-test.js` is still NOT retired, on ONE assertion.**

| Historical assertion | Destination |
|----------------------|-------------|
| default off; no finite ceiling; bounded single retry; provenance; policy snapshot; exhausted run triaged | `auto-retry-bounds-test.js` 2–4 |
| authority/protected never retries | `auto-retry-bounds-test.js` 5 |
| provider failure never retries | `auto-retry-bounds-test.js` 5b |
| ticket-level triage blocks auto-retry | `auto-retry-bounds-test.js` 5c |
| exactly one `ticket:auto_retry` audit entry | `auto-retry-bounds-test.js` 5d |
| startup must not retry old failures | `auto-retry-bounds-test.js` 6 |
| runtime failure WITH a mutation never retries | `run-mutation-evidence-test.js` 2 |
| **verification failure never retries** | **NONE** |

**Why the last one is still open, stated rather than papered over.** The property holds
*structurally* — a postcondition failure terminalizes through `completeAgentRun`, which
never reaches the retry hook in `failAgentRun` — but a fixture that actually produces a
`verification_failed` run was not found: an objective naming a folder, left undone,
**completed** rather than failing verification. Asserting the property against a fixture
that does not reproduce it would be worse than leaving it recorded, so it is recorded.

Closing it needs a deterministic postcondition failure. `postcondition-completion-test.js`
induces blocked-operation and completion-deferral shapes but not this one, so the first
task is establishing which objective or workflow shape reliably fails verification —
the same "find the truthful fixture first" discipline A25 needed for `runtime_failed`.

Retire `auto-retry-test.js` when that lands, not before.

---

### A24. Absolute host filesystem paths disclosed to the model provider

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-27.** Redaction at the provider-input boundary; `provider-input-privacy-test.js` registered (40 assertions, 8 scenarios) |
| **Severity** | **High** — every model request disclosed the host filesystem layout to an external provider |
| **Discovered by** | `workspace-error-containment-test.js` — the ENOENT message it asserts against carries the absolute path |
| **Evidence** | Read-only probe capturing complete provider request bodies, before and after |

**Description.**

The defect was reported as *recoverable filesystem errors carry the raw Node message,
including the absolute host path*. That is true, and it is the narrow case. Capturing
whole provider request bodies showed the disclosure was never confined to error text:

| Provider-bound field | When | Contains |
|----------------------|------|----------|
| `runtimeEnvelope.workspaceRoot` | every request | absolute host root |
| `runtimeEnvelope.mainWorkspaceRoot` | every request | absolute host root |
| `initialWorkspaceSnapshot.targetScope.root` | every request | absolute host root |
| `currentWorkspaceSnapshot.targetScope.root` | every request | absolute host root |
| `previousActionResults[].error` | after a filesystem failure | absolute host path of the attempted file |

**4 of 4 captured requests carried the absolute root, before any error occurred.**
Sanitizing the error message alone would have fixed one field of five and left the
disclosure fully intact — and the reported defect would have looked closed.

An off-machine model therefore received the deployment's filesystem layout: a developer
home directory, a temporary directory, or a production workspace path, on every turn of
every run.

**Decision — redact at the SEND boundary, not per field and not in the prompt builder.**

`callModelProviderWithRunEvidence` receives the assembled input for every provider call
— agent and browser alike — and is the last point before the wire.
`redactProviderInput` replaces every known host workspace root
(`run.workspaceRoot`, `run.mainWorkspaceRoot`, `workspaceProvider.root`) with the stable
token `<workspace-root>`.

Per-field redaction was rejected for a reason the evidence makes concrete: three of the
five disclosing fields are not error channels at all, and any prompt field added later
would reintroduce the disclosure by simply forgetting to opt in. A boundary cannot forget.

**Why the send path rather than the prompt builder — an implementation attempt that was
withdrawn.** The first version wrapped `buildAgentPrompt`, splitting the renderer into
`buildAgentPromptMessages`. That broke `organization-guidance-test.js`, which extracts
the `buildAgentPrompt` body from `server.js` as TEXT and greps it; two further registered
suites (`phase-gated-catalog-behavioral-test.js`,
`workspace-snapshot-availability-test.js`) couple to the same function by name or offset.
Rather than edit three source-coupled suites to accommodate a rename, the redaction moved
to the send path — which is a strictly better boundary anyway:

- it covers **every** provider call, including any future builder, not just this one;
- it is the same value the provider-request replay evidence is recorded from, so the
  durable record of what was sent matches what was actually sent, instead of attesting a
  payload that was never written to the wire.

The source-extraction coupling itself is pre-existing (the A13 family) and is left as it
is; it was the signal that pointed at the better boundary, not a problem this entry
opened.

**The placeholder is a token, not a deletion.** The prompt contract refers to
`runtimeEnvelope.workspaceRoot` by name when instructing the model never to use it in a
path; deleting the field would leave that instruction pointing at nothing.

**Meaning was strengthened, not traded away.** Carried failures now include `errorCode`
and `failureKind` alongside the message, which they did not before. After redaction the
prose is no longer the only thing distinguishing *the file is missing*
(`WORKSPACE_FS_ENOENT`) from *the path is the wrong type*
(`WORKSPACE_PATH_TYPE_CONFLICT`), and it must not become so. This mirrors the shape the
workspace-snapshot failure path already used — `error: failure.code` plus `errorKind` —
which was the in-repository precedent for what correct looks like here.

**Operator diagnostics are deliberately untouched.** Replay snapshots, run logs and
events keep the raw message and the real absolute root. That evidence is local, behind
the operator's session, and it is what someone diagnosing a path fault needs. Scenario 7
of the suite asserts the durable record still contains the real root and is NOT redacted
— a fix that quietly blinded the operator too would be a different defect, not a smaller
one.

**Scope: which channels were genuinely shared.**

| Channel | Finding | Action |
|---------|---------|--------|
| `previousActionResults[].error` | raw `fs` message, absolute path — the reported defect | covered by the boundary; `errorCode`/`failureKind` added |
| `runtimeEnvelope.workspaceRoot` / `mainWorkspaceRoot` | absolute, every request, by design | covered by the boundary |
| `initialWorkspaceSnapshot` / `currentWorkspaceSnapshot` `.targetScope.root` | absolute, every request | covered by the boundary |
| `priorFailureContext.reason` (`run.error` verbatim) | **same raw-message pattern**, provider-bound | covered by the boundary. No current failure path was shown to put an absolute path there — `workspace_error` never terminates a run, and the terminal `protected_path` messages carry no path — so it was NOT separately rewritten |
| workspace-snapshot failure `error` | already `failure.code` + `errorKind`, no message | unchanged; it is the precedent |
| browser runs | URLs already redacted through `redactBrowserUrl`; no filesystem paths | unchanged |

`priorFailureContext` is the case the instruction to avoid speculative broadening
applies to: the pattern is genuinely shared, but the disclosure is not demonstrable
today. The boundary covers it either way, which is the argument for putting the fix
there rather than in five places.

**Mutation.** `prompt-carries-raw-host-paths` makes the redaction return its input
unchanged. The runs still start, still fail recoverably, still carry evidence forward and
still complete; the suite fails on the disclosure assertion with everything else about
the run intact — which is what makes it a privacy regression rather than a broken run.

### A19. No canonical runtime replay-snapshot validator exists

| Field | Value |
|-------|-------|
| **Status** | **Open — decision required** |
| **Severity** | Medium — replay validity is asserted piecemeal, never centrally |
| **Found** | 2026-07-25, while proving A18 |

Replay snapshot creation and mutation are guarded by **distributed** shape checks:
`createReplaySnapshotBase` defines the creation contract, individual append helpers
guard their own keys, and test scripts carry their own expectations (for example
`assertReplayOrdering` in `scripts/scheduler-integrity-abuse-test.js`). No single
runtime validator establishes that a replay snapshot is complete, well-formed, and
reconstructable.

Consequence: code that creates or repairs a replay snapshot cannot ask the system
whether the result is valid. A18's strict evidence path therefore validates the
snapshots it initializes against `createReplaySnapshotBase` and normal
`readRunReplay` reader behavior in `scripts/required-replay-evidence-test.js`. That
is contract-and-reader validation, **not** formal runtime validation, and A18 does
not claim otherwise.

Whether to introduce a runtime replay validator — and whether it should run on
creation, on repair, or on read — is a governance decision outside A18's scope and
is deliberately left open here rather than resolved implicitly.

---

### A18. Required replay evidence is silently discarded when no snapshot exists

| Field | Value |
|-------|-------|
| **Status** | **Resolved — strict required-evidence replay path implemented and mutation-proven** |
| **Severity** | **High** — an evidence-of-last-resort channel reports success after writing nothing |
| **Found** | 2026-07-25, while proving A17 proof 8a (startup settle boundary) |
| **Blocks** | A17 proof 8a; A17 proofs 5 and 8b depend on the same fallback |

**Defect.** `settleTerminalRunEvidence` (`server.js`) uses `recordReplayEvent` as the
last authoritative channel after a *required* diagnostic log has already failed.
`recordReplayEvent` calls `appendRunReplaySnapshotItem`, which opens with:

```js
return updateRunReplaySnapshot(runId, snapshot => {
  if (!snapshot) return snapshot;   // silent success: nothing is written
  ...
```

When the run has no replay snapshot the append writes nothing, raises nothing, and
returns normally. The caller cannot distinguish "durably recorded" from "silently
discarded", so reconciliation and startup settlement may be treated as
evidence-complete when the required failure evidence was in fact lost. The
`try/catch` around the fallback is ineffective because no error is ever thrown.

**Proven symptom.** `scripts/reconciliation-evidence-failure-test.js` fails
deterministically at:

```
ok  the fixture run row reads running
ok  terminal evidence exists while the row still reads running
ok  the intended run:terminalized insert was attempted and rejected (1 fires)
FAIL timed out waiting for run.reconciliation_evidence_failed
```

The trigger firing proves the settle boundary is genuinely reached and the
rejection genuinely contained; only the durable evidence is missing.

**Fixture shape (startup Path B).** Terminal evidence committed while the run row
still reads `running` with an expired lease — created through store primitives
(`createRun` → `claimPendingRun` → `transitionRun` to `running` → append
`run.terminalized` → expire lease). This drives `interruptStaleRunsOnStartup` and
its `run:terminalized` log, not `run:reconciled`. A rejecting trigger on
`diagnostic_logs` proves firing via a sequence, whose increments survive the
rollback `RAISE EXCEPTION` causes.

**Unknown.** Whether ordinary crashed runs reaching startup repair usually *do*
possess a replay snapshot is **not established**. This fixture builds a run that
lacks one, so production frequency is unknown and must not be assumed low. The
behavior is defective regardless of frequency: this call site requires evidence,
not optional enrichment, and a silent success is wrong at any rate of occurrence.

**Resolution.** `appendRequiredRunReplaySnapshotItem` owns the whole required-evidence
sequence — identity/shape validation, canonical initialization via `initializeRunReplay`
(`ON CONFLICT DO NOTHING`, so idempotent and non-destructive), existing-identity
inspection, idempotency/conflict decision, append, and exact readback of identity +
type + payload. `recordRequiredReplayEvent` is a thin wrapper. The tolerant
`appendRunReplaySnapshotItem` is unchanged and remains documented as optional
enrichment.

Required evidence carries a **caller-supplied stable identity**, never derived from
type, message, timestamp, or serialized payload. Payload comparison is semantic
(`canonicalOperationJson`) because PostgreSQL `jsonb` does not preserve key order.
Failures are classified as `initialization_failure`, `append_failure`,
`readback_failure`, `event_missing_after_append`, `event_identity_conflict`, or
`malformed_replay`, each carrying `EVIDENCE_PERSISTENCE_FAILED`,
`failureKind: evidence_persistence`, `evidenceChannel: replay`, run id, event type,
evidence identity, store code where available, and internal `cause` linkage — never
replay contents.

`buildReconciliationEvidenceId(runId, revision, logType)` scopes one occurrence to
one reconciliation attempt against one run state. It is a named function rather than
an inline template precisely so the scoping is testable: an inline string passed
every test while silently collapsing occurrences.

**Proof.** `scripts/required-replay-evidence-test.js` — 56 assertions, PostgreSQL-native,
with the strict helper extracted from `server.js` source and driven against the real
replay store. Seven mutations each fail a named assertion:

| Mutation | Failing assertion |
|---|---|
| Silent return on missing event | `an append that writes nothing is detected, not trusted` |
| Canonical initialization removed | `initialization_failure` |
| Readback weakened to type-only | `event_identity_conflict` |
| Identity conflict check removed | `same identity with conflicting type fails` |
| Idempotency removed | `retrying the same occurrence appends no duplicate event` |
| Identity requirement removed | `required evidence without a stable identity is refused` |
| Identity reverted to `runId + logType` | `the occurrence identity embeds the persisted run revision` |

Revision scoping is proven against **real persisted revisions**: a retry reuses the
identity and appends nothing; a genuine `claimPendingRun` + `transitionRun` advances
the revision (1 → 3) and yields a distinct identity; both occurrences persist
separately. Snapshot validation is against `createReplaySnapshotBase` and normal
reader behavior — see [A19] for the absent canonical runtime validator.

**Caller classification (complete).** The tolerant helper has exactly two wrappers.
Absence of a replay snapshot is only *possible* at one of their call sites, which is
why this defect is narrow rather than pervasive.

| Wrapper / site | Event type(s) | Lifecycle phase | Snapshot guaranteed present? | Classification | API |
|---|---|---|---|---|---|
| `recordRunEvent` — 27 sites (`server.js` 10382, 10787, 17178, 18327, 18779, 18946, 19056, 19138, 19156, 19229, 19274, 19307, 19335, 19353, 19390, 19399, 19437, 19468, 19505, 19860, 19869, 19899, 19933, 19942, 19948, 19963) | feasibility, model-contract, workspace-contract, postcondition, phase-violation, snapshot-recovery | Active execution inside `runAgentTicket` | **Yes** — `createRunReplaySnapshot` runs `initializeRunReplay` at run start, before any step | Required evidence, but absence is unreachable | Tolerant (correct) |
| `recordReplayEvent` — `server.js` ~11681 | `run:interrupted` | Interrupted-run terminalization | **Yes** — `ensureInterruptedRunReplaySnapshot` calls `initializeRunReplay` immediately above it in the same function | Required evidence, absence unreachable **by construction** | Tolerant (correct — explicit decision, not left vague) |
| `recordReplayEvent` — `server.js` ~5118 (A17 settle boundary) | `run.reconciliation_evidence_failed` | Startup repair / terminal reconciliation | **No** — the run may never have had a snapshot | **Required evidence of last resort** | **Strict** (`recordRequiredReplayEvent`) |

Every execution-phase caller is preceded by initialization on its own path, so the
tolerant no-op is unreachable for them and switching them to the strict API would
add cost without changing behavior. The startup/reconciliation fallback is the sole
site where a snapshot may legitimately be absent, and it is the only site switched.
Direct `updateRunReplaySnapshot` callers (`server.js` 9957 artifact prediction,
19048 browser report text) are **optional enrichment**: both guard on `!snapshot`
deliberately, and both are meaningless without a snapshot. They stay tolerant.

**Required direction.** Do not globally make `appendRunReplaySnapshotItem` strict —
its missing-snapshot tolerance may be intentional for optional enrichment and for
historical runs. Instead inventory every caller of `appendRunReplaySnapshotItem`,
`recordReplayEvent`, and related helpers, classify each as required evidence,
optional enrichment, or historical-compatibility, and introduce an explicitly named
strict API (`appendRequiredRunReplaySnapshotItem` / `recordRequiredReplayEvent`)
whose contract is: append durably, or throw a structured evidence-persistence
error — never return success having written nothing. A17's reconciliation and
startup fallback must use the strict path. Where no snapshot can be validly
initialized, persist through another authoritative durable channel (such as the run
event journal) or return an explicit evidence-incomplete result. Do not fabricate a
partial replay snapshot to make the append succeed, and do not downgrade required
evidence to stderr.

---

### A16. Run consequence records no committed mutations

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-26.** Prospective correction + historical compatibility |
| **Severity** | **High** — a run's durable record of what it changed is empty even when it changed something |
| **Scope** | Separate production-runtime defect. **Not** an A10 test-migration issue |
| **Evidence** | Independent read-only probe against `master` `074526e` |
| **Decision required** | Diagnose the consequence path, then decide the smallest coherent correction |

**Proven behavior.**

A completed run holding a **succeeded** `writeFile` operation receipt persists an empty
consequence:

```
RUN status=completed
OPS=["writeFile:cons-note.md:succeeded"]
CONSEQUENCE.created=[]
CONSEQUENCE.mutations=[]
```

`runConsequence.created` is `[]` and `runConsequence.mutations` is `[]` despite the receipt
existing with `outcome: succeeded`.

**Operational impact.** The run surface and the diagnostic bundle render `runConsequence` as
what the run created, deleted, renamed, updated, and mutated. With these collections empty, both
surfaces **falsely report that the run changed nothing** — while the workspace and the operation
receipts show that it did. An operator triaging from either surface is told the opposite of what
happened.

**Natural test impact.** `postcondition-completion-test.js` scenario 6
(`workspace-objective-satisfied`) remains blocked. Its assertion —
`runConsequence.created` contains the written note — is **retained unchanged**; it is the
contract this entry exists to protect and must not be weakened to make the suite pass.

### Root cause — proven read-only, 2026-07-25

**Data is lost at write/finalization time. Not at persistence, and not at projection.**

`buildRunConsequence` (`server.js`) populates `mutations` and the category collections from
**one** source, with no fallback:

```js
(Array.isArray(suppliedOperations) ? suppliedOperations : []).forEach(record => {
  const mutation = buildMutationConsequenceFromHistory(record);
  if (!mutation) return;
  consequence.mutations.push(mutation.item);
  consequence[mutation.category].push(mutation.item);
});
```

If `operations` is not supplied, those collections are unconditionally empty. There are three
call sites and they disagree:

| Site | Path | Passes `operations`? | Result |
|------|------|----------------------|--------|
| `buildRunConsequence(projectedRun, …)` inside `commitRunTerminalization` | **normal terminalization** | **NO** — passes `snapshot`, `evaluation`, `events` only | **empty `created`/`mutations` persisted** |
| `buildRunConsequence({…}, { …, operations })` in the terminal-repair path | reconcile/repair | **YES** | populated |
| `run.runConsequence \|\| buildRunConsequence(run, { events, operations, evaluation })` | read-time reconstruction | YES | **never reached** |

The normal terminalization path — the one every ordinary run takes — omits the argument. The
terminal-repair path in the same file passes it, which is what proves the omission is a defect
rather than a narrower intended meaning.

The read-time fallback would have masked this, but cannot: it is guarded by
`run.runConsequence || …`, and an **empty-but-present** consequence is truthy, so the persisted
empty value wins and the reconstruction never runs.

**Answers to the diagnosis questions:**

- *Calculated during execution?* No — built once at terminalization.
- *Reconstructed on read?* Only when absent; an empty persisted consequence blocks it.
- *Projected differently between access paths?* No. The projection and the row are faithful to
  what was built; nothing is dropped on write to PostgreSQL or on read.
- *Did PostgreSQL persistence drop fields the JSON runtime wrote?* No. The row stores exactly the
  object `buildRunConsequence` returned.
- *Is the succeeded receipt visible to the builder?* Yes — receipts are committed before
  terminalization. The builder is simply never handed them.
- *Does something overwrite a populated consequence with an empty default?* No. It is never
  populated on this path.
- *Are `created`/`mutations` narrower concepts than the scenario assumes?* No —
  `buildMutationConsequenceFromHistory` exists specifically to classify a receipt into
  `created` / `updated` / `deleted` / `renamed` / `mutations`, and the repair path uses it that way.

**Affected operations and runs.** All mutating operations (`writeFile`, `createFolder`,
`renamePath`, `deletePath`) on **every run that terminalizes normally** — i.e. the common case.
Runs that go through terminal repair are unaffected.

**Is scenario 6's expectation still an intended contract? Yes.** Evidence, not inference:

- The terminal-repair call site passes `operations`, so the same codebase intends consequences to
  enumerate committed mutations.
- `buildMutationConsequenceFromHistory` exists only to build these entries.
- `views/run-detail.ejs` renders the consequence categories directly to the operator.
- `summarizeDeliverableConsequence` composes the run's terminal report from
  `consequence.created` and its siblings when the model left no message — so an empty consequence
  makes the run report "no recorded consequence".

**Relationship to A14: none established.** A14 was a read-path projection defect in
`getOperation`. This is a missing argument at a write-path call site. Different mechanism,
different layer. No shared cause is claimed.

### Correction (implemented)

**Prospective — receipts read inside the terminalization transaction.** The store now loads the
run's canonical projected receipts on the terminalization transaction's **own client**
(`_listRunOperationsOn(client, id, …)`) and passes them to the consequence callback, so the
consequence describes exactly the evidence committed under that boundary. `listRunOperations`
and the in-transaction reader share one body, so pooled and transactional reads cannot project
differently. No array loaded outside the transaction is used.

**Omission made impossible.** `buildRunConsequence` now requires an explicit `operations` array
and throws when it is missing; the silent `Array.isArray(...) ? ... : []` default is gone. All
three call sites — normal terminalization, terminal repair, read-time reconstruction — pass
deliberately. `[]` remains valid and meaningful for a genuinely non-mutating run.
`buildMutationConsequenceFromHistory` semantics are unchanged.

**Historical — one canonical presentation hydration.** Three sites attach `runConsequence` to a
run: `readRuntimeRunAuthority` (run detail and diagnostics), `buildTicketTimeline`
(ticket-level), and `buildRunDecisionGraphForRequest` (decision map). All three now hydrate
through `hydrateRunConsequenceForPresentation`, so no two surfaces can derive different
consequences.

Reconstruction applies only when the persisted consequence is materially empty **and** succeeded
mutating receipts exist. It preserves every non-mutation field, never replaces a non-empty
mutation consequence, never counts failed/refused/prepared operations, leaves a genuinely
non-mutating run empty and unmarked, and **never writes back** — reading does not mutate stored
evidence. Provenance is explicit: `mutationConsequenceSource: reconstructed_from_operation_receipts`,
surfaced in run detail ("Reconstructed, not originally persisted") and in the diagnostic bundle
("NOT the terminal record written at the time").

**Query discipline.** The hydration helper returns immediately when the mutation consequence is
materially non-empty, so normally populated runs perform **no** operation-history query. Receipts
are read only for the empty case. `buildTicketTimeline` and the decision-graph builder therefore
issue at most one extra query per historical run; batching was not available at these call sites,
so the bounded per-run read was kept. **Recorded concern:** a ticket with many historical
mutating runs will issue one receipt query per such run (N+1). This is bounded, affects only
pre-fix runs, and is a performance note rather than a correctness issue — worth revisiting if
durable backfill is chosen.

**No silent catch.** An earlier draft wrapped the receipt read in a swallowing `try/catch`; that
would have degraded every surface back to a false "changed nothing", the exact failure this entry
removes. It was deliberately removed so a reconstruction failure surfaces.

**Coverage.** `scripts/run-consequence-mutation-test.js` — **33 assertions**, registered in the
release checkpoint. Proves all four mutation categories at normal terminalization; refused
operations excluded; `already_exists_noop` follows existing builder semantics; non-mutating runs
empty and unmarked; consequence matches succeeded receipts one-for-one; missing `operations`
fails loudly; terminalization reads on its transaction client; historical reconstruction with and
without succeeded receipts; non-empty consequences preserved; non-mutation fields survived;
provenance reaching run detail **and** the diagnostic bundle; and run detail and bundle agreeing
on the reconstructed mutation.

**Natural validation.** The A10-migrated `postcondition-completion-test.js` scenario 6 passes
unchanged, reporting the `writeFile` in `runConsequence.created`. That suite reaches **106
assertions across scenarios 1–15** before an unrelated A10 port defect at scenario 16
(`handoff-valid` timeout), which is out of A16 scope.

**Mutation proofs.** Removing the transaction-local operations load fails the focused test
(*"createFolder is recorded in consequence.created"*) and fails scenario 6 (*"Run consequence
should record created note"*). Disabling historical reconstruction fails the provenance assertion
(*"run detail marks reconstructed data as not the originally persisted record"*). Both restored.

**Durable backfill remains open.** Historical runs are corrected **on read only**; their stored
consequences are still empty. Whether to backfill `run_consequences` durably is deliberately not
decided here — the table is append-only, so any backfill needs its own sanctioned mechanism.

**Reproduction.** Minimal single-turn agent writing one file, dispatched through the normal
ticket path, observed through the store only. Reproduced independently of the A10-migrated
harness, so it is not a porting artifact.

**Not repaired in A10.** Any correction is a runtime-semantic change, which the A10
test-infrastructure tranche forbids.

---

### A15. Postcondition telemetry names a source the event never reaches

| Field | Value |
|-------|-------|
| **Status** | **Open — decision required.** Discovered during A14; deliberately excluded from A14's implemented status |
| **Severity** | Low — a telemetry metric cannot be derived from its documented source |
| **Evidence** | `docs/OPERATIONAL_TELEMETRY.md`; `recordRunEvent` in `server.js`; commit `b7d1763` |
| **Decision required** | Correct the documented telemetry source, or add journal routing for the event |

**Description:**

`docs/OPERATIONAL_TELEMETRY.md` lists:

```
| Postcondition checks | events.jsonl | Count of `run.postcondition_completed` |
```

Production does not write that event to the journal. `run:postcondition_completed` is emitted
through `recordRunEvent`, which writes the **replay snapshot** and the **run log** only:

```js
async function recordRunEvent(run, type, message, details = {}) {
  appendRunLog(run, type, message);
  await appendRunReplaySnapshotItem(run.id, 'events', { type, message, ...details });
}
```

There is no `appendEvent` for this event type anywhere in `server.js`. The documented metric
therefore cannot be computed from its documented source. Note the naming also differs — the
document uses the journal-style `run.postcondition_completed`, while the emitted type is the
replay-style `run:postcondition_completed`.

**Surfaced by A14, not caused by it.** A14's focused regression test initially asserted journal
durability for this event; that assertion was wrong about production, not about the fix, and was
corrected to assert replay and run-log durability — where the event actually lands. A14 changed
no event routing, so this discrepancy predates it and survives it.

**Decision required — two coherent options, not to be chosen here:**

1. **Correct the documentation.** If replay + run log is the intended durability surface, update
   `docs/OPERATIONAL_TELEMETRY.md` to name that source and the correct event type. Cheapest, and
   changes no behavior.
2. **Add journal routing.** If postcondition completion genuinely belongs in the operational
   ledger alongside `run.violations_checked` and `run.violation_detected` — the two neighbouring
   rows in the same table, which *are* journalled — add an `appendEvent` call. This is a
   runtime-semantic change and would need its own tranche and evidence review.

The neighbouring rows being genuinely journalled is why this is a real ambiguity rather than an
obvious documentation typo: the table's other entries are accurate, so the intent behind this
row is not self-evident from the document alone.

**Not to be resolved inside A10.** A10 is test-infrastructure repair.

---

### A14. Redundant-mutation postcondition shortcut does not fire

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-25.** Surfaced by A10, fixed as its own isolated production tranche |
| **Severity** | High — a documented completion path appears inert |
| **Evidence** | Live probe against `master` `c062af6` + uncommitted A10 tree; operation receipts and replay events below |
| **Decision required** | Is the redundancy shortcut still intended? If so, why does it not fire; if not, the postcondition suite's scenarios 1-3 and 8 must be retired |

**Description:**

`checkPostconditionCompletion` (`server.js`) completes a run when every proposed mutation in a
response turns out to be redundant against current state — `already_exists_noop` for
`createFolder`, and for `writeFile` a `preState` that already exists with content identical to
what the action would write. Four scenarios in `postcondition-completion-test.js` depend on it
(inventory rows 1, 2, 3, 8).

**It does not fire, even though the persisted evidence satisfies every condition it checks.**

A minimal probe ran a two-turn agent that proposed the identical `createFolder pc-folder` +
`writeFile pc-folder/file.txt` batch twice. The second turn's receipts are exactly what the
check requires:

```
{"op":"createFolder","id":3,"preState":{"type":"directory","existed":true},"status":"already_exists_noop"}
{"op":"writeFile","id":4,"preState":{"type":"file","content":"hello","existed":true,"contentHash":"2cf24d…"}}
```

`already_exists_noop` is present; `preState.existed` is `true`; `preState.content` is `"hello"`,
identical to the action's content. Yet the run's replay events are only:

```
run:feasibility_decision, model:action_contract_passed, model:action_contract_passed
```

No `run:postcondition_completed`. The run instead completed through the model's own
`complete:true`.

**Ruled out as port artifacts.** The provider stub, workspace, and objective were reproduced in
an independent probe that does not use the migrated suite. `readFile` returns a string, so the
`preState.content !== action.args.content` comparison is comparing like with like. The
mutating-action cap is not implicated (two mutating actions, cap 2).

**Root cause — proven read-only, 2026-07-25.**

`checkPostconditionCompletion` resolves history with
`postgresRuntimeStore.getOperation(id)` and then requires `historyRecord.preState`:

```js
// server.js, checkPostconditionCompletion
const histories = await Promise.all(historyIds.map(id => postgresRuntimeStore.getOperation(id)));
...
const historyRecord = histories.find(h => h.id === ar.result.historyId);
if (!historyRecord || !historyRecord.preState) return null;   // ← BAILS HERE
if (!historyRecord.preState.existed) return null;
if (historyRecord.preState.content !== action.args.content) return null;
```

`getOperation` (`persistence/postgres/application-state-methods.js`, `async getOperation`)
returns the **raw receipt document** spread over envelope columns:

```js
return { ...(row.receipt || {}), id: ..., runId: ..., ticketId: ..., step: ..., operation: ... };
```

It does **not** apply the receipt projection that `listRunOperations` uses, and that projection
is where pre-state is resolved:

```js
// persistence/postgres/store.js — projection only
preState: document.preState || document.before || intent.preState || null,
```

Pre-state lives on the **intent**, not the receipt document. Probe output, same four receipts,
compared through both paths:

```
id=1 createFolder projection.preState={"existed":false}                    getOperation.preState=undefined  rawStateKeys=["after"]
id=2 writeFile    projection.preState={"existed":false}                    getOperation.preState=undefined  rawStateKeys=["after"]
id=3 createFolder projection.preState={"type":"directory","existed":true}  getOperation.preState=undefined  rawStateKeys=["after"]
id=4 writeFile    projection.preState={"type":"file","content":"hello",…}   getOperation.preState=undefined  rawStateKeys=["after"]
```

The receipt document carries only `after`. `historyRecord.preState` is therefore `undefined`
for **every** receipt, and the guard returns `null` before any content comparison runs.

**Failing comparison:** the `!historyRecord.preState` guard in `checkPostconditionCompletion`
(`server.js`), caused by `getOperation` (`persistence/postgres/application-state-methods.js`)
bypassing the projection at `persistence/postgres/store.js`. `historyId` is correct, present,
and resolves to the right receipt — the identifier is not the problem.

**Scope.** Only operations whose check needs the history lookup are affected — i.e. `writeFile`.
`createFolder` and `deletePath` redundancy is decided from `ar.result.status`
(`already_exists_noop` / `already_missing_noop`) and still fires correctly. That is why
`direct-folder-postcondition-completeness-test.js` passes while postcondition scenarios 1, 2, 3
and 8 do not.

**The shortcut is still an intended live contract.** Evidence, not inference:

- It is wired as the live fallback: `const postcondition = compiledPostcondition || … await checkPostconditionCompletion(…)`
  (`server.js`). The compiled-contract path is a *preference*, not a replacement — with the
  objective compiler off by default, the redundancy shortcut is the only postcondition path.
- Its event is consumed across the runtime: operational-outcome classification
  (`completed_with_verified_postcondition`), failure summary, run summary, log labelling, and
  the run-detail surface.
- It is a **documented telemetry metric** — `docs/OPERATIONAL_TELEMETRY.md`: *"Postcondition
  checks | events.jsonl | Count of `run.postcondition_completed`"*.
- It is referenced by the operator CLI (`scripts/oquery.js`) and seven test scripts.
- **No supersession is recorded anywhere.** A repository-wide search for supersession language
  near "postcondition" returns nothing. The newer contract-based mechanism was added alongside
  it, not in place of it.

Per the A14 discipline, supersession was NOT inferred from the mere existence of the
contract-based path.

### Correction (implemented)

**Shared projection at the repository boundary.** `projectOperationReceipt(envelope, intent)`
in `persistence/postgres/store.js` is now the single canonical way to turn a receipt envelope
into a projected operation record, selecting `targetOperationReceiptProjection` when a prepared
intent exists and `actionOperationReceiptProjection` otherwise. Both `listRunOperations` and
`getOperation` consume it, so the two access paths cannot drift again.

`getOperation` now joins `target_operation_intents` on `(run_id, operation_key)` and projects,
instead of spreading the raw receipt document. The projection's state resolution was widened to
the canonical form for both directions:

```js
preState:  document.preState || document.before || intent.preState || null,
postState: document.postState || document.after || null,
```

`document.preState` is accepted first so alternate/older receipt shapes normalize identically;
current receipts carry pre-state only on the intent.

**Caller audit.** `getOperation` had exactly two callers — `checkPostconditionCompletion` and
the rename verification path in `server.js`. Both want projected records; neither needs the raw
document. An explicitly named `getOperationRawReceipt` is retained as an escape hatch with no
current callers, so any future need for the stored document is explicit at the call site rather
than served accidentally by the normal accessor.

**Affected behavior.** Redundant-`writeFile` batches once again complete through the verified
postcondition path and emit `run:postcondition_completed`. `createFolder` and `deletePath`
redundancy is unchanged — those never used the history lookup.

**Focused regression coverage.** `scripts/operation-receipt-projection-test.js` (22 assertions,
registered in the release checkpoint) proves: pre-state persists on the intent and
`getOperation` resolves it; both access paths agree on `preState`, `postState`, receipt id,
operation identity, prepared-intent linkage, outcome, and recovery fields; a redundant write
emits the event; completion comes from the postcondition path and not from `complete:true`
(no model response in the fixture ever sets it); the event is durable in replay and run-log
evidence; the operational outcome is `completed_with_verified_postcondition`; a non-redundant
write never triggers the shortcut; repeated `createFolder` still reports
`already_exists_noop`; and a receipt storing state as `before`/`after` still normalizes.

**Natural validation.** The A10-migrated `postcondition-completion-test.js` now clears the
previously blocked scenarios with **unchanged expectations** — `postcondition-create-folder-file`,
`postcondition-repeated-write`, and `postcondition-repeated-write timeout-avoided` all record
`run:postcondition_completed` within their step budgets. That suite remains uncommitted A10 work
and still stops later on an unrelated A10 port gap (an unwired `waitForStoredRun` helper in a
workflow-draft scenario); that gap is A10's to close, not A14's.

**Mutation proof.** Restoring the raw `getOperation` behavior fails the focused test at
*"getOperation resolves preState for a prepared operation"* and fails the migrated postcondition
suite at *"run:postcondition_completed was recorded"*. Both detect the regression; the
correction was then restored.

**Adjacent discrepancy, not fixed here.** `docs/OPERATIONAL_TELEMETRY.md` lists *"Postcondition
checks | events.jsonl | Count of `run.postcondition_completed`"*, but this event is written by
`recordRunEvent` to the replay snapshot and run log only — there is no `appendEvent` for it
anywhere in `server.js`, so it has never reached the journal. Recorded here as documentation
drift for a separate decision; A14 changed no event routing.

**Why this was not repaired in A10.** Making it fire is a runtime-semantic change, which A10
explicitly forbids. A10's job was to restore the harness that reveals this — which it did. The
migrated `postcondition-completion-test.js` is fully ported (all 20 scenarios) and is blocked at
scenario 1 by this defect, not by a porting error.

**Decision required.** Either the shortcut is intended and is broken (fix it, then the suite
passes as ported), or the shortcut was deliberately superseded by contract-based completion and
inventory rows 1, 2, 3, and 8 must be retired with that reason recorded.

---

### A13. Tests asserting removed commit-idempotency helpers

| Field | Value |
|-------|-------|
| **Status** | **Resolved 2026-07-26.** All five retired; the two live contracts they guarded are re-expressed behaviorally, registered, and mutation-verified. One residual gap recorded below |
| **Severity** | Medium — five suites were dead; two of the contracts they guarded were NOT covered elsewhere |
| **Evidence** | Failures reproduced against `master` `c062af6`; symbol counts in `server.js` |
| **Decision required** | Retire each suite, or re-point it at the surviving PostgreSQL-enforced contract |

**Description:**

Five scripts fail because they extract and assert helper functions that production no longer
contains. This is **not** the A10 cause: they do not fail on `DATABASE_URL`, and repairing them
is not part of the PostgreSQL-storage migration. Investigation confirmed the causes do not
overlap, so per instruction they are tracked separately rather than folded into A10.

**Exact failures:**

| Script | Failure |
|--------|---------|
| `scripts/execution-semantics-test.js` | `computeMutationFingerprint should exist`; `findConflictingMutation should exist`; `findCommittedMutation should be called in executeWorkspaceOperation`; `rerun endpoint should pass mode to rerunTicketFromBeginning` (1 passed / 5 failed) |
| `scripts/renamepath-conflict-regression-test.js` | `ASSERTION FAILED` on the same extracted helpers |
| `scripts/observed-poststate-regression-test.js` | `buildTargetOperationKey is not defined` |
| `scripts/renamepath-preservation-regression-test.js` | `buildTargetOperationKey is not defined` |
| `scripts/verify-batch-operation-regression-test.js` | `buildTargetOperationKey is not defined` |

**Removed helpers.** `computeMutationFingerprint`, `findConflictingMutation`, and
`findCommittedMutation` each occur **0 times** in `server.js`. The suites extract them from
source text and execute them, so their absence fails the extraction rather than any behavior.
`buildTargetOperationKey` does exist in `server.js` but is not exported into the scope those
scripts build, which is the same class of defect: they depend on internal structure, not
behavior.

**The contract survives — in a different mechanism.** Commit idempotency and conflict rejection
moved from in-process JavaScript helpers to PostgreSQL enforcement: stable operation keys
(`buildTargetOperationKey` + `operationKey`), prepared intent, and the `operation_receipts`
table with its `operation_receipts_idempotency_unique` and `operation_receipts_append_only`
constraints.

**It is already covered.** `scripts/operation-batch-test.js` — in the release checkpoint and
**passing** — asserts exactly these contracts today:

- *"duplicate-commits-skipped: stable keys, prepared intent, receipt reuse, and reconciliation
  prevent repeated effects"*
- *"conflicting-operations-rejected: all four primitives use PostgreSQL receipt authority and
  target locks"*

So the runtime guarantee is not unprotected; only these five source-coupled suites are dead.

**Decision required:** for each of the five, either retire it with the overlap against
`operation-batch-test.js` recorded assertion-by-assertion, or re-point it at the surviving
receipt-based contract. Retirement must not be assumed — `execution-semantics-test.js` also
covers resume deduplication, retry hidden-context, and reassess evidence injection, and the
*reassess* assertion still passes today, so at least part of that file guards live behavior
that must be preserved somewhere before anything is deleted.

**Not to be repaired inside A10.** Investigation established the causes are disjoint.

### Finalized disposition (2026-07-25) — and a correction to this entry's premise

Re-verified by executing all five at HEAD and by counting every symbol in `server.js`.
All five still fail exactly as tabulated above.

**Symbol census — this is what splits the five into two groups:**

| Symbol | Occurrences in `server.js` | Consequence |
|--------|---------------------------|-------------|
| `computeMutationFingerprint` | 0 | genuinely removed |
| `findConflictingMutation` | 0 | genuinely removed |
| `findCommittedMutation` | 0 | genuinely removed |
| `buildTargetOperationKey` | 5 | **live** |
| `captureWorkspacePostState` | 12 | **live** |
| `verifyBatchOperation` | 2 | **live** |
| `rerunTicketFromBeginning` | 3 | **live** |

**The premise above is true for two of the five and false for three.** This entry
states that "the contract they guarded is covered elsewhere" and that "only these five
source-coupled suites are dead". That holds for the two commit-idempotency suites,
whose helpers are gone. It does **not** hold for the three `buildTargetOperationKey`
suites: the behavior they guard is still in the runtime, and retiring them would delete
coverage rather than delete dead weight.

| Suite | Contract it guards | Still live? | Covered elsewhere? | Disposition |
|-------|--------------------|-------------|--------------------|-------------|
| `execution-semantics-test.js` | commit idempotency, conflict rejection via removed helpers | **No** (0 occurrences) | Yes — `operation-batch-test.js` (receipt authority, target locks) | **Retire**, *after* relocating its one live assertion (below) |
| `renamepath-conflict-regression-test.js` | the renamePath conflict carve-out, by source extraction | **No** (extracts `findConflictingMutation`) | **Yes, and better** — `renamepath-runtime-regression-test.js` (A10) now drives all five carve-out cases end-to-end through the real runtime and the real receipt table, and its coverage is mutation-verified | **Retire** |
| `observed-poststate-regression-test.js` | `operation-history.postState` comes from filesystem observation, not from requested args | **Yes** (`captureWorkspacePostState`, 12) | **Partially** — `recovery-regression-test.js` asserts `preState.existed`/`postState.existed` on one operation; the divergence case (filesystem differs from args) is uncovered | **Re-point, do not retire** |
| `renamepath-preservation-regression-test.js` | `batch.verification_failed` emits exact checks when a renamePath destination's type or contentHash diverges | **Yes** (`verifyBatchOperation`, 2) | **No** — `operation-batch-test.js` only asserts the source text *contains* `'batch.verification_failed'`, which is a substring check, not a behavioral one | **Re-point, do not retire** |
| `verify-batch-operation-regression-test.js` | the remaining `batch.verification_failed` checks | **Yes** | **No** — same gap | **Re-point, do not retire** |

**The one live assertion inside `execution-semantics-test.js`.** Of its six, exactly one
passes today: *`reassess-explicit-evidence`: reassess mode injects structured failure
context*. It must land somewhere before that file is deleted. It is unrelated to commit
idempotency and does not belong with the receipt suites.

**Why this was not executed in the A10 tranche.** Retiring test suites, and rewriting
three that guard live-but-uncovered behavior, is a verification-scope decision this
entry itself marks *decision required* — and the third column above shows two contracts
with **no behavioral coverage at all** today. Acting on that unilaterally inside a
test-migration commit would be the wrong place to make it. What has changed is that the
decision is now evidence-backed rather than assumed: the coverage map is complete, the
false premise is corrected, and the sequencing constraint (relocate `reassess` first) is
explicit.

**Recommended sequence when A13 is picked up:**

1. Relocate `reassess-explicit-evidence` into a PostgreSQL-native suite.
2. Retire `execution-semantics-test.js` and `renamepath-conflict-regression-test.js`.
3. Re-point the three `verifyBatchOperation` / `captureWorkspacePostState` suites onto
   the real runtime via `scripts/postgres-test-harness.js`, following the A10 pattern —
   and register them, since the substring check in `operation-batch-test.js` is the only
   thing standing behind `batch.verification_failed` today.
4. Mutation-test the result. `scripts/suite-mutation-test.js` is the template.

### Executed 2026-07-26

All five suites are **retired**. Their coverage was not deleted: the two contracts that
were genuinely live, and genuinely uncovered, are now asserted behaviorally against the
real PostgreSQL runtime.

| Retired suite | Replacement | Why retirement does not reduce protection |
|---------------|-------------|-------------------------------------------|
| `execution-semantics-test.js` | `rerun-mode-evidence-test.js` (new) for its one live assertion; `operation-batch-test.js` for commit idempotency | Its commit-idempotency helpers are gone from `server.js` (0 occurrences), and receipt authority plus target locks are asserted by `operation-batch-test.js` |
| `renamepath-conflict-regression-test.js` | `renamepath-runtime-regression-test.js` (A10) | The replacement drives all five carve-out cases end-to-end through the real runtime and the real receipt table, and is mutation-verified — strictly stronger than extracting `findConflictingMutation` from source text |
| `observed-poststate-regression-test.js` | `operation-poststate-observation-test.js` (new) | Same property, asserted against receipts the running system wrote |
| `renamepath-preservation-regression-test.js` | `operation-poststate-observation-test.js` (new) | Preservation is asserted from the stored receipt's source pre-state vs destination post-state |
| `verify-batch-operation-regression-test.js` | `operation-poststate-observation-test.js` (new), partially — see the residual gap | The reachable half is covered; the unreachable half is recorded rather than pretended |

**What the two new suites assert, and why the negative halves carry the weight.**

`rerun-mode-evidence-test.js` (22 assertions) — a recording provider stub captures every
prompt, so *reassess injects structured prior-failure context* and *retry injects none*
are both asserted against what the model actually received. The retry half is the
load-bearing one: silently injecting a previous failure into every rerun would make
"retry" a different operation than it claims to be and would leak one run's evidence
into a run that never asked for it. **The retired suite could not express this at all** —
a substring match on `server.js` cannot tell whether a function is *called*.

`operation-poststate-observation-test.js` (27 assertions) — an operation receipt must
describe what the filesystem did, not what the model asked for. The discriminating case
is a **refused** mutation: on success the request and reality agree, so success alone
cannot distinguish an observing implementation from an echoing one. A refused
cross-ticket write is used, and no receipt may carry the content hash of bytes that
never reached disk.

**Residual gap, recorded rather than papered over.** `verifyBatchOperation` runs
immediately after each action inside the per-action loop (`server.js`), so its
DIVERGENCE branches — `content_mismatch`, `file_missing`, `destination_content_mismatch`,
`path_still_exists`, `source_still_exists`, `destination_missing`, `folder_missing` —
cannot be reached through the runtime's public surface: nothing can change the
filesystem between an action and its own verification. The new suite covers the
reachable half (verification runs and stays silent exactly when reality matches). Making
the divergence branches reachable requires a test seam in production code, which is a
production change and was out of scope for a test-only tranche. **This is a real gap in
`verifyBatchOperation` coverage and should be decided separately** — either add a
seam in the style of the existing `TEST_INTERRUPT_*` hooks, or accept that those
branches are verified only by inspection.

**Mutation-verified.** Two mutations added to `scripts/suite-mutation-test.js`, both
killed:

| Mutation | Contract removed | Caught by |
|----------|------------------|-----------|
| `reassess-context-always-injected` | prior-failure context is injected for reassess only | the retry half of `rerun-mode-evidence-test.js` |
| `poststate-echoes-request` | post-state is captured by observing the filesystem | `operation-poststate-observation-test.js` |

---

### A12. Bounded workspace-snapshot recovery policy

| Field | Value |
|-------|-------|
| **Status** | **Open — decision required.** Residual of A1; not solved and not approved |
| **Severity** | Medium |
| **Evidence** | A1 implementation (`3f6d4ac`): recoverable-stop branch in `runAgentTicket`, state-aware run-start guard, `runtime/workspace-snapshot-availability.js` |
| **Decision required** | Backoff, attempt cap, operator-attention state, terminal semantics, and manual recovery |

**Description:**

A1 decided that a workspace-snapshot capture failure stops the run recoverably rather than
terminalizing. It did **not** decide how long a run may remain in that state. The behavior
that shipped is therefore a default, not an approved policy.

**Current behavior:**

- One capture attempt per lease-expiry recovery cycle, repeated **indefinitely** for as long
  as the capture keeps failing.
- Cadence is bounded only by the run lease duration (`RUN_LEASE_DURATION_MS`, default 180000).
- While unavailable the run issues **no model request** and performs **no mutation**; committed
  mutations and their evidence are preserved untouched.
- Each cycle appends a `workspace:snapshot_unavailable` transition to the replay snapshot and a
  `workspace.snapshot_unavailable` event to the journal.

**Why this needs a decision:**

- **Unbounded scheduler activity.** A run whose workspace never becomes readable is re-claimed
  and re-entered forever. The work per cycle is small, but the cycles do not stop on their own.
- **Unbounded evidence growth.** Every cycle adds durable replay and journal events, so a
  permanently broken workspace grows a run's evidence without limit.
- **No operator signal.** The run stays `running` and is not surfaced as needing attention.
  Nothing distinguishes "recovering normally" from "stuck since yesterday".
- **Interaction with A3.** The per-attempt wall-clock reset means `maxRuntimeDurationMs` does
  not bound this either: each recovery re-entry starts a fresh clock, so no existing runtime
  limit terminates the cycle. A3 and A12 must be decided consistently — fixing A3 alone would
  silently impose a bound here, and deciding A12 alone leaves that bound dependent on A3.

**Decisions required:**

1. **Backoff** — should retry cadence remain flat at one attempt per lease duration, or grow?
2. **Attempt cap** — is there a maximum number of failed recovery captures, and is it counted
   durably (the counters in A3 reset per attempt, so a naive counter would not survive)?
3. **Operator-attention state** — should a run stuck unavailable become visibly blocked or
   triage-required rather than silently `running`?
4. **Terminal semantics** — if a cap exists, what terminal classification applies, and how does
   it stay distinguishable from the run-start environment/integrity failure?
5. **Manual recovery** — should an operator be able to force a capture retry, or to terminalize
   a stuck run explicitly, rather than waiting for an automatic cycle?

**Explicitly not solved in the A1 tranche.** A1 is marked implemented because the fail-closed
behavior, classification, evidence, and recovery lifecycle are complete and proven. This entry
carries the remaining policy question so that "implemented" is not mistaken for "unbounded
retry was approved".

---

### A11. `truncated:true` is disclosed to the model but never explained

| Field | Value |
|-------|-------|
| **Status** | Open — split out of A1 on 2026-07-25 |
| **Severity** | Low |
| **Evidence** | `RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES` in `server.js`; the agent system prompt |
| **Decision required** | Whether the system prompt should instruct the model on incomplete snapshots, and what it should then do |

**Description:**

The run-start and per-step workspace snapshots cap entries at
`RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES` (200) and set `truncated: true` beyond that. The flag
reaches the model in-band — a real strength — but no system-prompt line ever mentions it, so
the model has no instruction for what an incomplete view means or what to do about it. This
compounds with the workload-profile inspection limits (`maxListDirectory` of 2–3), which can
leave a capable model structurally unable to see a workspace root larger than 200 entries.

Split from A1 because it differs on both axes that matter: it concerns *successful* captures,
and any fix changes prompt text sent on **every healthy run**, not only on faults. It
therefore needs its own behavioral decision and its own tests rather than riding along with a
fail-closed change.

---

## Process Profile Phase Snapshot Representation

| Field | Value |
|-------|-------|
| **Status** | Resolved — explicit snapshotted runtime phases implemented by process-execution Tranche 1 on 2026-07-27 |
| **Boundary** | No longer blocks profile admission/advertising; later effect classification must not replace phase authority |
| **Evidence** | `docs/PROCESS_EXECUTION_CONTRACT.md`; `runtime/process-execution-contract.js`; `server.js` `PHASE_OPERATIONS` |
| **Decision** | Store a nonempty canonical `allowedPhases` array on each resolved version-2 profile; accepted values are `inspection`, `mutation`, and `verification` |

**Resolved rule:** a process profile declares its permitted runtime phase; the run
snapshot captures that declaration; the envelope advertises `runProcess` in a phase only
when a snapshotted profile permits that phase; and authorization rechecks the selected
profile against the current phase.

Version-2 snapshots store explicit, deduplicated, canonically ordered `allowedPhases`.
Envelope filtering and dispatch authorization use only that captured array. `runProcess`
remains absent from all global phase catalogs. Effect classification may later inform
sandbox or workspace permissions, but it cannot determine phase authority. Live target
configuration does not participate after admission. Version-1 historical reference
snapshots remain readable but receive no executable authority.

---

## Process Executable Authority and Launch-Plan Boundary

| Field | Value |
|-------|-------|
| **Status** | Resolved through Tranche 2B on 2026-07-28; original Tranche 2 is complete |
| **Boundary** | Authorized version-3 dispatch only through fresh runtime capability, durable PostgreSQL lifecycle, and the proven native launcher |
| **Evidence** | `docs/PROCESS_EXECUTION_CONTRACT.md`; `docs/PROCESS_INPUT_MATERIALIZER.md`; `docs/PROCESS_LAUNCHER_FOUNDATION.md`; `runtime/process-execution-contract.js`; `runtime/process-launch-plan.js`; `runtime/process-launcher-foundation-contract.js` |
| **Decision** | Only a complete version-3 authority snapshot can produce a private immutable launch plan; versions 1 and 2 are permanently executor-free |

**Why version 2 is not executable:** it records a host absolute executable path but no
executable content hash, immutable runtime-root identity, read-only materialized-input
identity, memory/CPU/FD/file/temp ceilings, or explicit immutable filesystem policy.
Interpreting it through later live deployment configuration would rewrite historical
authority. It remains readable and unchanged but can never produce a launch plan.

**Version-3 authority:** catalog version 2 resolves exact rootfs ID/manifest authority,
ELF path/content identity, arguments, working directory, replacement environment,
read-only materialized-input policy, all required resource ceilings, phases, and fixed
execution policy into the admitted run. Canonical JSON and the shared locale-independent
comparator govern snapshot and launch-plan hashes.

**Rootfs trust:** rootfs trees are root-owned, versioned, non-writable by the runtime and
launcher UID, manifest-verified before containment health, and retained while
referenced. Live host system directories and operator home directories cannot substitute.
An operator deployment mapping from rootfs ID to installed path is outside model input and
outside live dispatch authority.

**Execution input (implemented in Tranche 2A1):** no mutable host workspace path appears
in authority or launch plans. The Rust materializer holds the existing PostgreSQL
workspace-root advisory-lock boundary, copies only regular files with descriptor-relative
`openat2` traversal, rejects links and special files, applies a separate versioned
read-exclusion policy, enforces file/byte bounds, creates a service-owned sealed tree,
hashes the canonical output manifest, and rescans identity/type/size/content before
publication. Its canonical fsynced private registry binds the opaque descriptor to the
run, ticket, operation, policy hash, exact canonical filesystem-policy hash, allocation,
generation, manifest, and counts. Startup pins allocation, sealed-state, and socket
directories by descriptor without following symbolic or magic links. Allocation physical
identity affects the materializer generation; configured paths cannot redirect a live
generation. Sealed and socket roots are pre-provisioned through the checked-in
systemd/tmpfiles boundary. The fixed pre-authentication refusal uses `requestId: null`
and preserves `PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED`; one bounded frame is drained
without parsing after the refusal is sent so transport reset cannot replace the typed
result. The peer UID is never exposed.
`docs/PROCESS_INPUT_MATERIALIZER.md` is the governing design.

**Read-only first launch:** `inputMode` is `materialized_read_only`; writable roots are
empty and cannot be enabled. Writable process effects require a later independent
authority and bounded-copy-out decision.

**Network meaning:** `networkAccess: none` prohibits communication outside the operation
sandbox. Tranche 2A3 enforces a fresh network namespace, no host interfaces/socket
mounts/inherited sockets, and a pinned seccomp policy denying external socket creation.
Unnamed operation-local IPC such as Unix `socketpair` remains permitted.

**Launch-plan boundary:** the plan is private runtime-to-launcher material, derived only
from an immutable v3 run snapshot plus a trusted materialized-input descriptor. It is
closed, bounded, versioned, canonically hashed, deeply frozen, and absent from the model
envelope. Version 3 remains non-dispatchable until a future healthy sandbox capability
generation is an additional gate.

**Integrity correction:** absence from the model envelope is not itself
non-dispatchability. Version-3 resolution now fails closed as
`PROCESS_SANDBOX_UNAVAILABLE` with denied authority unless a closed, healthy, time-bounded
sandbox capability descriptor is supplied. The current runtime supplies none. Historical
version 2 retains only its executor-unavailable compatibility refusal.

The private builder now accepts a closed `{runId, ticketId, currentPhase,
processPolicySnapshot}` context, derives operation identity from `(runId, operationId)`,
and binds the workspace descriptor to the run, policy hash, and capability-approved
materializer generation. The launch hash also binds the launcher protocol, launcher,
sandbox backend, seccomp policy, rootfs-registry, and materializer generations. Tranche
2A1 now provides the trusted opaque-workspace registry and exact `getSnapshot`
revalidation; launch-plan construction remains disconnected from dispatch.

Launcher capacity is a pre-start `failed_to_start` cause and cannot be represented as
`resource_limit_exceeded`, which is reserved for enforcement against an established
process operation.

**Launcher protocol:** launcher-owned restricted Unix socket, `SO_PEERCRED`
validation against the exact service UID, closed bounded messages with a fixed maximum
size of 2,097,152 bytes, no client host mount paths, raw sandbox options, raw cgroup names,
or unsandboxed fallback. The mandatory barrier is create cgroup → set every limit → create blocked child
→ move and verify membership → release → execute.

**Cross-UID release gate:** sealed ownership is not proven by same-UID chmod. The
dedicated Linux test uses distinct launcher, materializer, runtime, trusted-rootfs, and
unauthorized identities and is mandatory whenever process execution is enabled. On
2026-07-28 the current host executed it successfully inside a systemd-delegated
subordinate-UID namespace; the active gate also proves durable interrupted-operation
replay after launcher restart.

**Tranche 2A2 resolution:** the materializer now holds a kernel lifetime lease before
any staging, registry, or socket mutation. A separate Rust launcher-foundation service
pins trusted rootfs/manifest/backend/seccomp/cgroup identities, validates a canonical
complete rootfs manifest, freshly verifies rootfs-internal ELF identities, and exposes
only authenticated `health`, `getRootfs`, and `verifyExecutable` operations. Its
rootfs-registry generation binds complete trusted configuration, launcher/backend/policy
bytes and physical identities, every rootfs manifest and physical identity, protocol,
and manifest schema. The runtime can form only a private, expiring
`prerequisites_verified` descriptor with `readyForExecution: false`; this descriptor is
deliberately incompatible with the healthy sandbox capability contract.
`docs/PROCESS_LAUNCHER_FOUNDATION.md` is the governing design.

**Tranche 2A3 resolution:** systemd `Delegate=cpu memory pids` supplies the actual
service cgroup; the launcher derives it from `/proc/self/cgroup`, proves controller
write/readback and blocked-child membership, and binds its physical identity into an
expiring active generation. The materializer passes the exact sealed tree and manifest
with launcher-only `SCM_RIGHTS`. A fixed Bubblewrap plan uses pinned rootfs/workspace
descriptors, fresh mount/PID/network/IPC/UTS/user/cgroup namespaces, a private bounded
tmpfs, a private `/proc` and `/dev`, cleared environment/capabilities, `/dev/null` stdin,
and the pinned installed seccomp policy. Operation cgroups enforce tasks, memory/swap,
and CPU rate; rlimits enforce descriptors/file size/core; streaming raw-byte monitors
enforce combined output and monotonic wall time. Cancellation, timeout, output, and
observed cgroup violations kill the whole tree and wait for `populated 0`.

The active fixture proves network/filesystem/process/seccomp/environment isolation,
process/thread/memory/output/time/resource limits, double-fork/session resistance,
launcher-crash descendant death, stale-cgroup restart cleanup, and the fixed
`/usr/bin/node --check /workspace/server.js` compatibility profile. CPU quota is
truthfully a throttle and no longer a terminal resource cause.
`docs/PROCESS_LAUNCHER_FOUNDATION.md` is the governing design.

The private generation is deliberately not assigned to a mutable
`CURRENT_PROCESS_SANDBOX_CAPABILITY`. Tranche 2B resolves fresh native health into a
closed `process-runtime-v1-<sha256>` generation only while the feature flag, migration
029 lifecycle schema, artifact store, materializer, containment, rootfs/ELF authority,
protocol versions, and mandatory release gates all match.

**Tranche 2B resolution:** `process_operations` binds one immutable launch plan to the
canonical run-scoped operation identity before any launcher call. PostgreSQL advisory
locks and revision-guarded state transitions enforce
`intent → active → finalizing → terminal`. The Rust launcher persists acceptance before
child release, preserves terminal tombstones across restart, and exposes bounded
terminal-only output chunks with cleanup acknowledgement. The runtime independently
verifies and atomically publishes raw stdout/stderr artifacts, records append-only
authority/terminal/artifact evidence and a generic operation receipt, and acknowledges
launcher output only after durable finalization. Interruption, lease expiry, startup,
Node crash, and launcher restart reconcile without duplicate execution or invented
terminal facts.

This completes the durable lifecycle and recovery capabilities originally expected from
Tranche 3 and the enforceable sandbox capabilities originally expected from Tranche 4.
They must not be reintroduced as parallel subsystems.

**Tranche 3 integrity completion:** the authoritative roadmap is now persisted in
`docs/PROCESS_EXECUTION_ROADMAP.md`. Scheduler lease-expiry recovery invokes the existing
durable process cancellation authority immediately after fencing the stale owner and
before ordinary reconciliation can resume the run. Accepted/active operations therefore
reach the launcher's one terminal result and finish artifacts, evidence, receipt, and
output acknowledgement before stale-run recovery completes; finalizing and terminal
operations only finish their existing idempotent obligations. A natural-completion race
preserves both the durable cancellation request and the launcher result. The real
PostgreSQL scheduler seam is covered by
`scripts/process-lease-expiry-cancellation-postgres-test.js`.

Generic `runProcess` receipts now also participate in ordinary run consequence
reconstruction through a closed `processOperations` projection. That projection records
only durable operation/target/profile/outcome/result-hash and bounded artifact metadata;
it cannot claim a workspace mutation, expose raw/private authority, or alter completion
semantics. Restart replay and unchanged workspace/browser behavior are covered by
`scripts/process-consequence-reconstruction-test.js`.

**Tranche 6 completion decision:** every newly admitted run now captures immutable
completion authority from the recognized objective contract, declared postconditions,
and admitted `when_declared` verification policy. The existing immutable
`run_consequences` record stores one canonical hashed completion decision with separate
execution, verification, and objective-completion dispositions. Required bounded
`run.completion_decided` evidence is appended in the existing PostgreSQL terminalization
transaction before the terminal lifecycle event and is repaired idempotently after
restart.

The evaluator consumes only durable facts, receipts, consequence projections, declared
postconditions, and admitted policy. Exact process-operation, process-terminal-outcome,
and process-artifact predicates reuse `processOperations` and existing process evidence;
workspace and browser verification retain their canonical paths. Missing or
contradictory authority fails closed, raw process output is not interpreted, and model
completion prose is retained only as a non-authoritative claim. Ticket projection for a
current run follows the persisted completion disposition rather than its overloaded run
status. Historical runs without admitted completion authority retain explicit
compatibility behavior.

Tranches 3, 4, 5, 6, and 7 are complete; Tranche 8 is next and remains not started.
Tranche 7 adds only the derived, bounded `processSupervision` projection on existing
run-detail/state/CLI surfaces and authorized delegation from the existing run stop route
to the canonical cancellation controller. Existing authority, materialization,
launcher, containment, lifecycle, budgets, scheduling, artifact, evidence,
cancellation, completion, consequence, receipt, supervision, and recovery systems are
mandatory reuse points, not subsystems to rebuild.

---

## Workspace Operation Error Handling

| Field | Value |
|-------|-------|
| **Status** | Unresolved inconsistency |
| **Documentation** | Recoverable |
| **Implementation** | Terminal |
| **Evidence** | See `docs/archive/DOCUMENTATION_IMPLEMENTATION_DIVERGENCE.md` |
| **Decision required** | Which behavior is authoritative? |

**Description:**

The documentation (`docs/OPERATIONS.md`, `docs/STATE_SURFACES.md`) claims that workspace operation failures are recoverable feedback returned to the model. The implementation (`server.js`) treats all filesystem errors (except `listDirectory` ENOENT) as terminal failures that immediately end the run. Both behaviors have co-existed since the initial commit on 2026-05-19. No reconciliation has occurred.

---

## Event Log Stream Semantics

| Field | Value |
|-------|-------|
| **Status** | Open questions; classification contract documented |
| **Classification authority** | `docs/EVIDENCE_VS_TELEMETRY.md` (intent: evidence only; practice: evidence + telemetry) |
| **Evidence** | `docs/archive/EVENT_LOG_INTENT_REVIEW.md`, `docs/archive/SCHEDULER_TICK_REVIEW.md` |
| **Decision required** | Whether and how to reconcile `events.jsonl` practice with the evidence-only intent (stream separation, filtering, retention) |

**Description:**

Open questions merged from `UNRESOLVED_EVENT_LOG_QUESTIONS.md` (recorded 2026-05-28; original preserved at `docs/archive/UNRESOLVED_EVENT_LOG_QUESTIONS.md`).

### 1. Should operational history contain telemetry?

`AGENTS.md` defines `events.jsonl` as "append-only operational history."

- Does "operational history" mean a record of operations the system performed, or does it include observations of system state?
- Is a `scheduler.tick` event (pendingRuns count every 500ms) an operation or an observation?
- Is `run.heartbeat` (lease metadata on every model request) an operation or an observation?
- If operational history includes observations, what observations are in scope and which are out of scope?
- If operational history excludes observations, what stream should observations use?

### 2. Should evidence and telemetry share a stream?

The same `events.jsonl` file is:
- A "source of truth" for projection rebuilders and replay reconstructors
- A "ledger" from which telemetry metrics are derived

- Is sharing a single append-only stream between state reconstruction and observational metrics intentional or incidental?
- If shared intentionally, is there a documented rationale?
- If shared incidentally, was a separation ever considered and rejected?
- What is the cost to projection rebuilders of scanning telemetry events that carry no reconstructive value?
- What is the cost to telemetry consumers if telemetry events are separated from the reconstructive stream?

### 3. What properties distinguish reconstructive events from observational events?

Currently, the distinction is implicit:
- `run.started`, `workspace.operation`, `execution.phase_transition` — consumed by replay/reconstruction
- `scheduler.tick` — not consumed by replay/reconstruction
- `run.heartbeat` — partially consumed (phase map, provider request proxy)

- Is the distinction defined by whether the event has a `runId`? (`scheduler.tick` has no `runId`; most reconstructive events do.)
- Is the distinction defined by whether the event is hashed/sequenced in the run event chain? (`scheduler.tick` is not sequenced; most run events are. `run.heartbeat` is sequenced.)
- Is the distinction defined by whether the event changes mutable state? (`scheduler.tick` does not mutate `runs.json`; most reconstructive events do.)
- Is the distinction defined by consumer usage? (If a new consumer starts using `scheduler.tick` for reconstruction, does it change categories?)
- Is there a formal taxonomy of event types that the substrate intends to maintain?

### 4. Should retention differ by category?

`events.jsonl` is append-only. No documented expiration or compaction exists.

- Should reconstructive events be retained indefinitely?
- Should observational events (e.g., `scheduler.tick` with `pendingRuns: 0`) be retained indefinitely?
- If observational events are not retained indefinitely, what is the minimum retention needed for telemetry accuracy?
- If observational events are compacted or expired, does the "append-only" contract apply uniformly or per-category?
- Does the telemetry system's determinism guarantee (same ledger → identical report) require all historical ticks, or only ticks during active runs?
- If retention differs by category, how does the system express that policy? (File-level? Event-type-level? Consumer-level?)

### 5. Should replay consumers ignore categories explicitly or implicitly?

Current behavior:
- `scripts/projection-rebuilder.js` ignores `scheduler.tick` (no `runId`, so it is not grouped by run)
- `scripts/replay-reconstructor.js` ignores `scheduler.tick` (not referenced in reconstruction logic)
- `scripts/event-chain-verify.js` counts `scheduler.tick` as `nonRunEvents` but does not flag it as an error

- Should replay/reconstruction tools explicitly filter out known observational event types?
- Should replay/reconstruction tools implicitly ignore events they do not recognize?
- If explicit filtering is preferred, where is the filter list maintained?
- If implicit ignoring is preferred, what prevents an observational event from being accidentally reconstructed into a run state?
- Should the event chain verifier treat non-run events as valid (current behavior) or as a warning?
- Should tests that assert event log contents (e.g., "events.jsonl should include scheduler.tick") be considered part of the contract, or are they implementation-detail assertions that could be removed without semantic impact?

### 6. Additional open questions

- Should `appendEvent` enforce any boundary on what event types may be emitted, or should it remain an unrestricted append surface?
- Should telemetry events carry the same forensic metadata (seq, prevHash) as run events, or is the absence of seq/prevHash on `scheduler.tick` a signal that it is not part of the reconstructive chain?
- Is the `OPERATIONAL_TELEMETRY.md` principle "Evidence-only" ("Every metric is computed from persisted ledger files") intended to mean "metrics are derived only from evidence," or "metrics are derived from whatever is in the ledger, including telemetry"?
- If the event log grows by ~120 lines/minute on an idle system, at what point does file size become an operational concern for append performance, read performance, or storage cost?

---

## complete:true Under Per-Response Action Caps

| Field | Value |
|-------|-------|
| **Status** | Substantially resolved in runtime (audited 2026-07-17); entry retained for the record |
| **Surfaced** | 2026-06-18, during live validation of the relative-objective anchoring fix (`83aead9`) |
| **Evidence** | Live gpt-4.1-mini run: first response proposed E/F/G with `complete:true`; the per-response mutation cap (`MAX_MUTATING_ACTIONS_PER_RESPONSE`, default 2) executed only E/F; later steps created G; net outcome correct |
| **Decision required** | Whether a capped, partially executed response may honor `complete:true` |

**Description:**

`complete:true` in a capped response does not mean the requested target state was
fully applied — it means "complete as proposed," while the runtime may have dropped
proposed actions beyond the cap. In the observed run the runtime continued and the
outcome was correct (this is NOT the moving-goalpost bug, which is fixed and
validated), but in other scenarios a capped + `complete:true` response could
terminate a run before the full target state is applied — a potential correctness
gap, not just display clarity.

Open questions for the diagnosis:

- Should the runtime ignore/override `complete:true` when any proposed actions were dropped by per-response caps?
- Should run detail surface "response proposed more actions than were executed"?
- Should the continuation prompt explicitly state that only the first N actions were executed and the rest were not applied?
- Should replay show capped/skipped proposed actions separately from executed actions?
- Is this a correctness gap anywhere in current behavior, or only a clarity gap? (Start in `runAgentTicket`: confirm how `complete:true` is honored when actions were truncated.)

**Resolution status (audited 2026-07-17):** the runtime now answers the first and third
questions directly — when per-response caps drop proposed actions, the continuation message
states how many executed, how many were dropped, and that "`complete:true` was not honored …
continue from the executed state and re-emit the remaining action(s)" (see the
`truncatedMessage` construction in `server.js`). The second and fourth are answered by the
run page's Parsed Model Plans section (per-plan complete flag and proposed actions,
comparable against Workspace Actions). No further diagnosis is pending; reopen only if the
cap-feedback path regresses.

---

## Structured Allocation Leaf-Run Retry Boundary

| Field | Value |
|-------|-------|
| **Status** | Deliberately deferred by Tranche 3 (2026-07-31); fail-closed, not a defect |
| **Surfaced** | 2026-07-31, implementing structured-allocation leaf-run admission |
| **Evidence** | `runtime/structured-allocation-leaf-run-contract.js`, `persistence/postgres/store.js` (`admitStructuredAllocationLeafRuns`, `reconcileStructuredAllocationLeafItems`), `scripts/structured-allocation-leaf-run-postgres-test.js` |
| **Decision required** | Whether, and how, a failed structured leaf Run may be retried while preserving the same immutable allocation-item authority |

**Description:**

Tranche 3 admits exactly ONE initial Run per immutable Allocation Plan v2 item. It
does not retry a failed leaf.

The existing retry seam cannot be reused as-is. `createRetryRun()` persists a run
draft built by `prepareAgentRunDraft()`, which does not carry a leaf binding — the
binding is derived by the store during leaf admission and hashes the
runtime-assigned Run ID, so a retry would need its own freshly derived binding for
the same allocation item. Separately, `assessAutoRetryAfterFailureIfPolicyAllows()`
already refuses every owned-scope ticket (`unsupported_ticket_shape`), so automatic
retry cannot reach a structured leaf today by either route.

The tranche therefore fails closed: a failed leaf item resolves to a `failed` item
and prevents aggregate completion, and there is no automatic second attempt. The
aggregate decision already represents a per-item `runLineage`, and
`reconcileStructuredAllocationLeafItems()` already decides an item from the most
recent Run bound to it, so a future retry that preserves the same allocation-item
authority is expressible without a schema change or a new primitive.

Open questions for the diagnosis:

- Should a structured leaf retry exist at all, or should a failed item require operator reopen?
- If it exists, must the retry Run carry a NEW binding over the same allocation item, and must the binding record its predecessor explicitly rather than only through `runLineage`?
- Should the per-item attempt ceiling come from the existing runtime budget (which currently counts one attempt per allocation plan, not per item), or from a new per-item bound?
- Does a retried leaf invalidate the item's prior completion-decision identity, or is the lineage's latest valid decision sufficient?
- Should partial retry of a multi-item plan be permitted while sibling items are still running?

## Governed Response-Hash Tamper Has No Scenario (recorded 2026-08-02)

**Status: RETAINED OUTSIDE TRANCHE 5** — test-coverage gap, not a known defect,
and not a Tranche 5 completion criterion.

**Exact reason for retention.** The guard is `rehydrateGovernedResponseText` in
`server.js`, which belongs to the Tranche 4 governed request/response contract:
it rehydrates a durable response and verifies it against the hash the reservation
recorded at dispatch. Tranche 5 added coordination and verified-progress control
on top of that contract and did not change the guard. The gap surfaced during
Tranche 5 work, which is why it is recorded here, but closing it proves a Tranche
4 rehydration invariant rather than any Tranche 5 criterion.

**What is established by source.** The guard exists and fails closed:
`GOVERNED_RESPONSE_REHYDRATION_CONFLICT` is raised with
`failureKind = 'resume_rejected'`, which `buildFailureMetadata` carries into the
terminal failure record as its `kind`. The earlier attempt also established
observationally that with the transcript tampered the Run executed nothing — no
injected action ran and no second request was issued.

**What remains unproven** is only the durable disposition: whether the conflict
terminalizes the attempt or is retried first. That was left UNRESOLVED rather
than guessed, and the scenario was removed rather than committed failing.

**What would close it**, unchanged: determine where a rehydration conflict lands
in the attempt lifecycle, assert the durable integrity signal alongside the
already-observed absence of effects, and mutation-test removal of the hash check
against it.

Governed recovery rehydrates request 1's transcript from canonical response
replay and verifies it against the response hash the reservation recorded at
dispatch. Removing that verification fails no test, because nothing constructs a
mismatch.

An attempt this session altered the stored transcript while leaving its hash —
the shape a partial write or edited replay row would leave. Two useful things
came out of it and are worth keeping:

* the replay table refuses an update that does not advance its revision, which
  is a real durability guard;
* with the transcript tampered, the Run executed NOTHING — the injected action
  never ran and no request 2 was issued.

What could not be shown in the time available is that the refusal surfaces as
the canonical integrity error on a durable, observable Run state: the Run stayed
in `running` across the observation window rather than terminalizing with
`GOVERNED_RESPONSE_REHYDRATION_CONFLICT`. Whether the guard fires and the Run
merely retries, or the mismatch is absorbed somewhere earlier, is UNRESOLVED.
The scenario was removed rather than committed in a failing state.

**What would close it.** Determine where a rehydration conflict lands in the
attempt lifecycle, then assert the durable integrity signal alongside the
already-observed absence of effects, and mutation-test removal of the hash
check against it.


## Governed Request Delivery Uncertainty (recorded 2026-08-02, resolved as fail-closed)

**Status:** closed as a design position, not as a defect. Exactly-once external
transport is NOT claimed.

A governed request commits its reservation, ordinal, budget charge and
provider-request replay, and `markEconomicRequestStarted` runs before any byte
leaves. There is no marker that could fix this: a database transaction is not
atomic with a network send. A marker written before the send cannot prove bytes
left; one written after cannot be guaranteed to exist when they did. Adding one
would buy the appearance of certainty and none of the substance, so none was
added.

The runtime therefore treats a reservation in `request_started` with no durable
response as UNDECIDABLE and fails closed under
`GOVERNED_REQUEST_DELIVERY_UNCERTAIN` / `governed_request_delivery_uncertain`.
It does not retransmit: a second send could pay for and apply a second answer to
a request the provider already served.

Two crash points prove the position, and prove production cannot tell them
apart — which is the point:

* `governed-pre-transport-restart-postgres-test.js` — zero bytes sent;
* `governed-post-transport-restart-postgres-test.js` — the provider demonstrably
  received the request, then the process died before the response was durable.

Both yield the same durable outcome: one ordinal, one charge, one reservation,
one request replay, no response, no progress window, no churn increment, no
progress block, no second transport, and an idempotent reason across repeated
restarts.

**Consequence, stated plainly.** A request the Ticket paid for can end
unanswered, and no automatic recovery will complete it. That is a deliberate
trade: an unanswered paid request is recoverable by an operator, while a
duplicated external send is not.

**Not claimed.** No progress window exists until a durable response and its
required evidence exist. Automatic retransmission of an ambiguous started
request is unsupported.

## suite-mutation-test Stale Anchor: closed 2026-08-04

**Status:** closed. Supersedes the entry recorded when the failure was only
observed, not diagnosed.

The `owned-path-scope-broadened` mutation aimed at `server.js`, where the owned
-path containment rule used to live. `350809f` moved it to
`runtime/authority-paths.js` so the enforced rule and every operator-visible
listing (admin dashboard, oquery CLI) could not drift, and reformatted it across
two lines. **The invariant still exists — only the textual anchor was stale.**

What remains in `server.js` is `matchedOwnedRootForEntry`, which documents
itself as display-only and as merely reusing this containment shape. Aiming
there would mutate a label rather than an authority, and the out-of-scope write
would still be refused, so the mutation would have survived while looking
repaired.

Re-aimed at `runtime/authority-paths.js`; killed by
`allocation-scope-authority-test.js` in 5.5s. Unmodified control passes, source
is restored and SHA-256-verified, and an equivalent refactor of the same
function produces no false hit.

## Terminal Projection Surface Inventory (recorded 2026-08-04)

**Verdict on the mapping owner: VERIFIED-PROGRESS TERMINAL MAPPING HAS ONE
CANONICAL OWNER** — `deriveLeafItemDisposition` in
`runtime/structured-allocation-leaf-run-contract.js`, whose only production
caller is `persistence/postgres/store.js` (structured reconciliation).

**Verdict on CLI: CANONICAL CLI RUN INSPECTION EXISTS** — `scripts/oquery.js`
reads `runConsequence.completionDecision` and prints execution, verification and
objective dispositions. It is not yet asserted by any terminal-projection suite.

**Surface inventory correction.** Earlier sessions treated
`/api/runs/:id/events` as though it covered the Run/runtime API. It does not —
they are separate routes with separate contracts. The actual readers are:

| Surface | Route / owner |
|---|---|
| Ticket page | `GET /tickets/:id` |
| Ticket API | `GET /api/tickets/:id/runtime`, `/api/tickets/:id/timeline` |
| Run page | `GET /runs/:id` |
| Run/runtime API | `GET /api/runs/:id/state` (via `readRuntimeRunAuthority`) |
| Run events API | `GET /api/runs/:id/events` — distinct contract |
| Reconciliation | `deriveLeafItemDisposition` |
| Parent aggregate | allocation plan `aggregateDecision.items` |
| CLI | `scripts/oquery.js` |

**There is no `GET /api/tickets/:id`.** A previous assertion accepted 200 OR 404
against that non-existent route; it passed by hitting the 404 and proved nothing.
Replaced with the real runtime route.

**Still open, explicitly:**

* per-Run field assertions on `/api/tickets/:id/runtime` — its payload reports
  every Run and carries per-Run `error` fields, so whole-payload substring
  checks pass or fail for reasons belonging to SIBLINGS. Only the status code is
  asserted. The correct fix is to assert the leaf's own entry once its shape is
  established.
* `/api/runs/:id/state` is asserted only for valid completion.
* CLI is asserted for no row.
* `deriveLeafItemDisposition` mapping assertions (blocked leaf projects
  `blocked`, never `completed`) — `scripts/verified-progress-terminal-mapping-test.js`
  covers the BLOCK SHAPE separation but not the disposition mapping; its
  canonical leaf-run binding shape was not established in budget.

## Governed Progress Block-Hash Ownership: closed 2026-08-04

**Verdict: GOVERNED PROGRESS BLOCK HASH HAS ONE CANONICAL PROJECTION OWNER** —
`projectBlock` in `runtime/verified-progress-projection.js`, reached through
`readTicketVerifiedProgressProjection`. Production callers: the Ticket runtime
API (`serializeTicketRuntimeState`) and the Ticket detail page, which the source
comments describe as "the single canonical seam so the page, the API and the
CLI cannot disagree".

**Two different hashes, previously conflated.**

| Hash | Meaning | Owner |
|---|---|---|
| `completionDecisionHash` | identifies the completion DECISION | `deriveLeafItemDisposition` → `structuredAllocationLeafExecution.items[]` |
| `governedProgressBlock.blockHash` | hash OVER the block's own fields | `projectBlock` → run-level verified-progress projection |

A previous entry treated the decision-hash coverage as though it closed
block-hash propagation. It did not. Closed now at the real owner: dropping the
block hash, replacing it with the churn-decision hash, or reconstructing it from
a constant are all caught by `verified-progress-projection-postgres-test`, as
are dropping the reason and dropping sibling authority.

**What each reader actually owns, corrected.** The TICKET-level projection is a
SUMMARY — run IDs grouped by closed stop reason
(`blockedForVerifiedProgressExhaustion`,
`blockedForUndeclaredSiblingDependency`, …), named per reason because the
reasons are not interchangeable. It does NOT carry per-Run `blockHash`; that is
the RUN-level projection. `governed-blocked-restart-postgres-test` therefore
asserts REASON MEMBERSHIP on the Ticket runtime API — that this Run appears
under verified-progress exhaustion and under neither sibling dependency nor
duration exhaustion — rather than asserting a hash the reader does not expose.

**A documented guarantee that nothing proved.** `projectBlock` states that
normalizing on read "re-verifies that the stored block hash covers its own
fields. A tampered block refuses here instead of being displayed." A mutation
short-circuiting `normalizeGovernedProgressBlock` whenever a `blockHash` was
present SURVIVED every suite — no suite ever presented a tampered block.
`verified-progress-terminal-mapping-test` now edits a stored block's reason,
blocked instant, policy hash and churn-decision hash while keeping the old hash,
and substitutes the hash itself; all five refuse on read. The mutation is now
caught.

## Run-State API Does Not Own Block or Integrity Authority (recorded 2026-08-04)

**Status:** recorded surface limitation, not a defect.

`GET /api/runs/:id/state` reports Run identity and lifecycle. It does NOT
expose `governedProgressBlock` or `integrityFailureCode`. A terminal-projection
suite must therefore not assert those fields on it — doing so would assert a
field the reader does not own.

What matters is that the limitation never becomes a CONFLICT: this API must not
claim success while the block or integrity authority says otherwise. That is
asserted. Whether the Run-state API should carry block authority is a product
question, not a test repair.

The matrix column for this reader is therefore "identity and non-success
disposition only" for the block and integrity rows.

**Per-Run scoping is now enforced, with refusals.**
`findRuntimeRun(payload, runId)` in `scripts/fixtures/terminal-projection-restart.js`
locates the target leaf in `structuredAllocationLeafExecution.items` and refuses
when no item matches, when more than one matches, or when the payload carries no
items at all. The Ticket runtime payload reports EVERY Run, and whole-payload
substring checks were the recurring mistake of this tranche — they pass or fail
for reasons belonging to siblings. Mutation-proved: a helper returning a
different item than the target is caught.

## Blocked-Projection Mutation Sensitivity: closed 2026-08-04

**Status:** closed. Supersedes the entry recording that three mutations
survived the cold-restart suite.

They survived structurally, not carelessly: restart suites re-read durable rows
and never invoke `deriveLeafItemDisposition` or `projectedStatus`, so mutating
the mapping could not make them fail. Forcing a restart suite to call a
transition purely to catch a mutation would have made it test something it is
not about.

The mapping is now asserted in `structured-allocation-leaf-run-contract-test`,
which already owned the canonical valid fixture (`runFacts`, `alphaBinding`,
`decisionFor`) — reused rather than reinterpreted, so there is no second
reading of the input contract.

**The reason is the authority, not the status.** A blocked decision projects
itemStatus `failed`; `blocked` is not a leaf item status. What separates a
coordination or churn block from an ordinary unsuccessful decision is the
reason `completion_blocked` alongside the preserved decision hash. An earlier
draft asserted a `blocked` itemStatus — that would have asserted a status this
contract does not have.

Mutations caught at `deriveLeafItemDisposition` (7 of 8):

| Mutation | Result |
|---|---|
| blocked leaf maps to completed | CAUGHT |
| blocked leaf loses its decision hash | CAUGHT |
| block reason collapses into generic failure | CAUGHT |
| disposition invents sibling authority fields | CAUGHT |
| progress block may carry sibling details | CAUGHT |
| sibling block may omit sibling details | CAUGHT |
| sibling block loses its requested path | CAUGHT |
| both block kinds hash identically | SURVIVED — mis-premised |

The survivor is not a gap. It forced `churnDecisionHash` to a constant on the
assumption that the churn hash is what separates the two block kinds. It is
not: the block hash covers `reason` and `siblingDependency` independently, so
the two blocks still hash differently with a degraded churn hash. That is a
stronger property than the mutation assumed.

## Structured-Leaf Terminal-State Representability (recorded 2026-08-04)

Classification of the nine terminal states, from source and from the refusals
the database actually raises. Recorded because several are NOT missing tests —
they are states the system refuses to represent, and the refusal is the proof.

| # | State | Classification |
|---|---|---|
| 1 | valid completed leaf + canonical decision | production path |
| 2 | completed, decision missing | controlled fixture (status written, evidence withheld) |
| 3 | decision bound to wrong Run/Ticket | controlled fixture (internally valid, wrongly bound) |
| 4 | completion-authority mismatch | controlled fixture; **not observable in Ticket projection** |
| 5 | decision conflicts with Run status | controlled fixture |
| 6 | replay-integrity failure | production path (existing corruption scenario) |
| 7 | verified_progress_exhausted | production path |
| 8 | undeclared_sibling_dependency | production path |
| 9 | uncontained replay corruption | controlled fixture |

Findings that changed how these must be proved:

* **A stored decision cannot be corrupted in place.**
  `normalizeCompletionDecision` recomputes `decisionHash` over every other
  field, so editing `runId` in the database yields
  `COMPLETION_DECISION_INVALID` — a different failure than the binding rule
  under test. Cases 3-5 need a decision that is internally consistent and
  wrongly bound, built through the canonical builder.
* **One malformed decision per Run, by construction.** `run_consequences` is
  keyed by `run_id`, requires `ticket_id` to match the Run's through a
  composite foreign key, and is append-only (the evidence-mutation trigger
  refuses UPDATE and DELETE). Cases cannot be staged by overwriting; each needs
  its own admitted Run.
* **Terminal Runs cannot be reopened**, so one Run cannot serve two malformed
  cases in sequence.
* **Case 4 was unobservable in Ticket projection — and that was a defect, not
  a property.** CORRECTED 2026-08-04. The projection passed
  `runCompletionAuthorityHash: null`, which the shared rule reads as "no
  opinion", so it never reported `completion_authority_mismatch`. That rule
  exists for a caller genuinely holding no comparable hash; this caller held
  one. `projectedStatus` guards on `item.completionAuthoritySnapshot` in order
  to reach the evaluator at all, and allocation reconciliation compares against
  exactly `run.completionAuthoritySnapshot.objectiveContractHash`. So a
  structured leaf could present a decision built against a DIFFERENT objective
  contract, be called a mismatch by reconciliation, and be projected
  `completed` by the Ticket in the same breath.

  **Verdict: STRUCTURED TICKET PROJECTION CAN VALIDATE COMPLETION AUTHORITY.**
  The projection now supplies the hash it already holds — the existing durable
  field, not a reconstruction. A generic Run is unaffected: the guard returns
  its status before the evaluator is reached, so no Run without structured
  authority can fail for lacking it. Both domains are asserted.

`COMPLETION_EVIDENCE_MISSING` is ONE code carrying DIFFERENT closed reasons
(`completion_decision_missing`, `completion_decision_stale`,
`completion_authority_mismatch`, `completion_decision_conflicts_run`). A
projection collapsing them would still refuse, and would still pass a test
asserting only the code, so the reason is asserted every time.

**Closed 2026-08-04:** case 6 (replay-integrity failure) and case 9
(uncontained corruption) now have fresh-process proofs, and case 8
(sibling dependency) has cross-surface parity after restart. The uncontained
case previously read its corruption in the SAME process that applied it, which
proves a refusal but not that it survives a restart — a refusal depending on
the corrupting process still being alive would be a cache, not an authority. A
fourth server now reads it cold.

The contained/uncontained distinction is proved to be the DISPOSITION rather
than the presence of corruption: contained renders 200 stating
`replay_unavailable_integrity_failure`; uncontained refuses closed with HTTP 500
naming `POSTGRES_REPLAY_INTEGRITY_FAILURE` and a sanitized reason. The refusal
MAY name the integrity code — that is what it is refusing about — but it never
borrows the contained vocabulary, never claims `replay_available`, never
terminalizes the Run, and never records an integrity event to explain itself.

**No-side-effect scoping, learned the hard way.** A Ticket-scoped count matrix
reported large drift across the sibling-dependency restart and looked like
projection side effects. It was not: that scenario deliberately leaves the
SIBLING executing, so its ordinary progress showed up as drift. Terminal-Run
scope is the honest measurement when a neighbour is still live; Ticket scope is
right only when the whole batch is terminal. Both helpers exist for that reason.

**Closed 2026-08-04 (second pass):** case 1 (valid structured completion) and
case 7 (`verified_progress_exhausted`) now have cold-process proofs, by
extending the existing lifecycle and blocked-restart scenarios rather than
building new ones. Both assert the Run page, Ticket page and Run events API in
addition to the durable authority.

**No-side-effect scope, corrected.** A previous entry implied the matrix was
closed on terminal-Run scope. It was not: Run scope proves the terminal leaf was
not restarted, NOT that projection did no Ticket-wide work. Every case now ends
with a Ticket-scoped closing read taken after full durable quiescence, with
every projection surface re-issued against it — zero drift in all four. Where a
pre-restart baseline moves, the delta is reported and attributed rather than
scoped away:

* blocked-restart CRASHES a server mid-flight, so its restart is RECOVERY, not
  projection: the leaf is reclaimed, terminalized and given its completion
  decision, and interrupted siblings finish. Those rows are execution. The
  projection claim is made separately against an already-quiescent Ticket.
* sibling-dependency deliberately leaves the sibling executing, so the sibling
  is allowed to finish before the Ticket-scoped closing read.

**A completed leaf renders `verified_progress_exhausted` on its Run page**,
under a "Churn decision" heading. This is not a borrowed authority: the last
progress window produced no new verified progress and the Run then completed
because its declared work was satisfied. Both records are true and the churn
decision is labelled as its own authority. The suite therefore asserts that no
governed progress BLOCK and no integrity disposition exist for a completed leaf,
rather than asserting the absence of a string.

**Still open:** the Ticket API and CLI columns for all five rows (only page and
events API are asserted); and deterministic mutation coverage for the
verified-progress projection path — see the note below.

## Sibling Refusal's failureKind: closed 2026-08-04

**Status:** closed. Supersedes the entry recorded when the value was only known
to be inert.

**Verdict: FAILURE_KIND IS ADVISORY BUT OBSERVABLE METADATA** — and the
specific value `no_progress` was inert on the sibling-dependency path.

Consumer inventory. `buildRunTriage` maps `failureKind` to a reason code for a
CLOSED set only: `protected_path`, `provider_error`, and the runtime-budget
kinds (`runtime_budget_insufficient`, `runtime_budget_exhausted`,
`runtime_duration_exhausted`, `deterministic_infeasibility`). A few call sites
test `protected_path` or `workspace_error` directly. Nothing anywhere reads
`no_progress` as a failure kind — the three writes have no matching read, and
`model:no_progress` is an unrelated EVENT type. So it controlled no durable
classification, no retry eligibility, no aggregation and no completion
semantics; anything unmapped falls through to `runtime_failed`.

But the field is not inert as a FIELD: `buildRunFailure` returns a record only
when `error.failureKind` is set, or for three specific codes. With it removed,
the sibling refusal falls through every branch and returns **null**, losing the
durable `GOVERNED_SIBLING_READ_BLOCKED` code and the sibling detail. Deleting
it would therefore have destroyed observable evidence to remove a misleading
label.

Minimal correction: keep the field, replace the borrowed value with
`sibling_dependency_blocked`, which describes this refusal instead of implying
churn/progress semantics the system does not honour. Triage, retry, aggregation
and completion are unchanged — unmapped kinds already produced `runtime_failed`.
No new triage category was invented.

The coordination refusal continues to be distinguished where it always was: the
canonical progress block's reason, sibling allocation item, sibling Run,
requested path, `siblingDependencyBlocked` flag and hash. Automatic retry
remains prohibited through the triage owner, not through this field.

## Duplicate-Dispatch Outcome Anomaly: closed 2026-08-04

**Status:** closed. Supersedes the "unreproduced" entry recorded earlier the
same day, which was honest about not knowing the cause and is replaced now that
the cause is proved rather than guessed.

The observation — one transport, one reservation, one ordinal, and NO caller
reporting `received` — is reproduced deterministically by a barrier that holds
the dispatch owner at a chosen boundary instead of racing the scheduler. Two
distinct defects were behind it:

1. **A rejected owner vanished from the accounting.** The duplicate-concurrency
   test filtered to FULFILLED outcomes, so an owner whose post-transport
   persistence threw contributed nothing and left a bare count with no
   explanation. Every caller is now accounted for, rejections included with
   their error code. The runtime behaviour here was and remains correct: a
   response that could not be made durable is one no caller may claim.

2. **A caller that lost the start race reported `already_dispatched_unresolved`
   — the same status `closeUnconfirmed` returns for an ABANDONED request it
   settled at the reserved maximum.** Worse, the losing path never consulted the
   claim-aware classifier that every other observer goes through, so the two
   ways of discovering "somebody else started this" could disagree. Both now
   resolve through one authority, `resolveStartedRequest`.

The correction that mattered most is narrow: a caller that just lost the atomic
start transition has FIRST-HAND evidence of a live concurrent owner, which is
strictly stronger than a lease read. Unifying the two paths naively made such a
caller settle books the winner still owned whenever the lease could not see the
winner — an unleased Run, another process's lease, or one expired mid-flight.
`concurrentStartObserved` keeps that distinction explicit.

The dispatch owner never enters this authority at all. It holds its result
linearly from the start transition through transport and durable persistence to
its own returned outcome, so it can never be told its own live request belongs
to somebody else.

## Governed Claim Ownership: closed 2026-08-03

**Status:** closed. Recorded because the path to it corrected two of my own
earlier claims.

Request starts are bound to the append-only `position` of the
`run.lease_acquired` event the INITIATING attempt resolved at entry, validated
transactionally against the governing claim. A superseded claim is refused
(`ECONOMIC_REQUEST_STALE_CLAIM_ATTEMPT` /
`governed_leaf_stale_claim_attempt`) rather than silently rebound to whatever
claim is newest at write time.

Two corrections along the way:

* comparing `started_at` against the claim timestamp was described as claim
  identity in an earlier handoff. It is not — `clock_timestamp()` has finite
  resolution and clock order is not append order;
* deriving the claim inside the store was described as making the binding "a
  fact rather than an inference". It removed caller trust but introduced a
  different error: a caller that began under claim A, paused, and resumed after
  reclaim would have its request recorded against claim B.

The equal-timestamp collision that the database refuses to stage — three
integrity mechanisms reject it — is now proved as data by
`scripts/governed-request-claim-classification-test.js`, against a pure
classifier that takes no timestamps at all and says so by source assertion.

## Parent–Fixture Hash Handshake: NOT REQUIRED (recorded and closed 2026-08-03)

**Status:** closed as a design position.

The governed request body exposes no Run, source or ordinal identity
(`runtime/provider-request-body.js:33`), and the transport adds no identifying
header (`runtime/governed-openai-transport.js:62`), so keying staged responses
by canonical identity would need a synchronous parent–fixture control protocol.
That protocol is not built, and is not needed, because every property it would
have bought is established another way:

* production request identity is bound to `exact_request_hash` and its economic
  reservation — the fixture's staging has no bearing on it;
* cross-Run ownership is isolated: a planner or sibling request cannot consume a
  leaf response, and crash boundaries belong to staged request matches rather
  than a global arrival count;
* requests within one Run are SEQUENTIAL, proved from durable row ordering —
  request 2's reservation is created only after request 1 has a durable
  response and turn 0's receipts and postcondition evidence have committed, so
  two turns cannot race for a staged answer;
* persisted response identity is verified against canonical execution turn;
* swapping the request-1 and request-2 responses fails deterministically in one
  run;
* lifecycle stability is 30/30.

**Stated precisely.** Staged order is NOT production authority. It is
deterministic scenario sequencing whose result is independently verified against
canonical turn identity, in a system where the requests it sequences cannot
overlap.

## Malformed Success Is Hard to Persist (recorded 2026-08-03)

**Status:** informational — defense in depth worth knowing about.

Constructing a Run that claims `completed` without valid completion evidence is
resisted by the database itself, not only by projection. In sequence, direct
writes hit: pending runs cannot complete without entering running;
`runs_lifecycle_timestamps`; `runs_terminal_phase_shape`;
`runs_current_phase_check`; and finally "terminal runs cannot be reopened".

`malformed-completion-projection-postgres-test` therefore proves ONE case —
`completed` with no decision is refused with `COMPLETION_EVIDENCE_MISSING`, the
Ticket status is unchanged, and no synthetic decision is created. The intended
failed/interrupted contrast could not be built on the same Run because terminal
Runs cannot be reopened; that half is covered where it occurs naturally, in
`governed-replay-corruption-postgres-test`.

Constraints were NOT disabled to build a richer scenario. Doing so would have
proved something about a database this system does not run on.

## Provider Transport Invocation — Residual Crash Window (recorded 2026-08-07)

**Status:** informational — a permanent, unavoidable limitation, recorded so it
is never mistaken for a defect and never quietly relied on as if it were absent.

`provider.transport_invoked` is written by the two production transport owners
(`server.js:callOpenAI` → `fetch`, and
`runtime/governed-openai-transport.js` → `https.request`) **after** the platform
call has been made. It therefore has no false positives: if the event exists,
the transport function was invoked.

It does have **false negatives**, and cannot be made not to. The platform call is
an OS operation and the observation is a database transaction, so the two cannot
be atomic. A process that dies between the call returning and the event
committing leaves the request in flight with no durable transport observation.

**The consequence, stated as a rule:** absence of `provider.transport_invoked`
means UNKNOWN. It is never proof that a provider was not called. The projection
carries that rule beside the value (`transport.absenceMeans`), and the
`nonImplications` list on every live artifact repeats it, precisely so a consumer
reading a zero cannot lose it.

**What was deliberately NOT done.** Recording the observation *before* the
platform call would remove the false negatives and introduce false positives — a
crash in that gap would leave durable evidence asserting an invocation that never
happened. For an evidence system, an event that can overstate is worse than one
that can be missing, so the window is placed where it can only lose a true fact.

**The no-repeat authority is unchanged.** Whether a request may be retried is
decided by the economic reservation state, not by this observation. A missing
transport event does not make a possibly-dispatched request look undispatched.

## Tight-Budget Postcondition Liveness Regression (recorded and closed 2026-08-08)

**Status:** closed by sharing PostgreSQL transactions across facts that already
form one durability boundary. The supported, intentional
`AGENT_MAX_RUNTIME_DURATION_MS=2000` contract in
`postcondition-repeated-write timeout-avoided` is unchanged.

The first properly configured release checkpoint against
`f22e55dacdeb2a04f8012c1ca5fb25fa32b4ca6d` remains a historical failure:
167/216 checks passed and check 168 failed with
`RUN_RUNTIME_DURATION_EXCEEDED` at approximately 2,271 ms. That result is not
rewritten by this correction.

Same-machine attribution found two material contributors. Durable runtime-budget
accounting introduced the intrinsic critical-path cost: the scenario grew from
30 to 44 PostgreSQL transactions at its introduction, then transport observation
added three more. Ambient WAL/host contention amplified that intrinsic work; the
checkpoint prefix itself leaked no server, Node process, PostgreSQL transaction,
or lock holder.

The correction removes transaction boundaries, not facts:

* a model-request reservation, `provider.request.persisted`, and its charge
  commit are one pre-transport transaction on the ungoverned path;
* an execution-step reservation/commit and lease heartbeat are one transaction
  before the next product action;
* a workspace-operation reservation and prepared intent are one transaction
  before the target effect;
* its receipt/evidence and charge commit are one transaction after the effect;
* multiple events appended inside one transaction reuse the chain tip already
  locked by that transaction.

No transaction crosses an external provider or workspace effect. A failed
post-effect receipt/charge transaction leaves the prepared intent and reserved
charge for reconciliation. A budget refusal is not retried by generic operation
error accounting. `provider.transport_invoked` remains evidence-only, remains
after the actual platform call, and is neither dropped nor moved.

Against the corrected executable source, the unchanged tight-budget scenario
completed 10/10 in isolation (min 1,026, median 1,059, p90 1,125, max 1,241 ms)
and 10/10 after the exact first two suite scenarios (min 1,065, median 1,158.5,
p90 1,299, max 1,451 ms). The path performs the same three hermetic model
responses, two parsed plans, two workspace receipts, seven charges, three each
of provider request/transport/response evidence, and the same postcondition and
terminal result, while using 33 rather than 47 PostgreSQL transactions. External
provider calls in all attribution and regression work: zero.

## Tranche 6 Live-v1 Decision Topology (recorded and closed 2026-08-09)

**Status:** closed by a versioned live-v2 manifest. Historical live-v1 remains
byte-for-byte execution authority for the runs already bound to it and is never
rewritten or paired with v2.

The frozen RETAIN rule requires families 2, 3, 5 and 6. Live-v1 instead copied
the fixture membership for families 3, 4, 7, 8 and 9. It also gave family 7
structured evidence with no A evidence. RETAIN and one family-level hard
comparison were therefore structurally impossible regardless of model outcome.
This was a matrix-selection defect: the fixture-derived selection rule never
consulted terminal-decision evaluability.

Live-v2 contains two outcome-independent executable scenarios for each required
family, with every scenario run on A, A2a, A2b, B and C: 8 matched scenario
cells x 5 arms = 40 cells, repeated 3 times = 120 slots. Two cells per family
are load-bearing. With one A cell, repetition agreement forces its completion
rate to zero or one: zero makes cost-per-truthful-completion unevaluable, while
one makes a positive structured gain impossible. The second matched cell makes
both frozen criteria jointly reachable without unbalanced arm denominators.

Specialized families 7 and 8 remain deterministic readiness/failure-boundary
proofs; they are not unmatched scored cells in v2. Recovery determinism remains
evaluable because every exact v2 cell repeats one comparison envelope three
times. The `stochasticIdentity` field remains a legacy scoring identity alias,
not a provider seed; real live mode records the stable fact that no fixture
response is staged instead of hashing temporary agent ids.

The v2 canonical manifest hash is
`634963b5581a57449e0c45ffb7973f86a3ff0b6bd6b708d4fc06b9969c8c76b6`.
Its maximum is 17,160,360 micro-USD (840 canonical attempts at 20,429), below
the unchanged 20,000,000 micro-USD ceiling. No observed result from an aborted
real corpus participated in membership, topology, economics or tests.

The first post-commit synthetic attempt was intentionally not credited: its
local wrapper stopped before slot 60, and its partial artifacts exposed that the
new family 2/5/6 ticket objectives fell outside the deterministic create-folder
grammar. Governed leaf admission correctly refused them with
`GOVERNED_LEAF_NO_EVALUABLE_FACT`. The objectives now use the existing canonical
`Create folders X and Y` grammar, while their family context remains explicit in
declared-work evidence. A source-level gate requires two typed folder facts for
every v2 scenario, and focused PostgreSQL diagnostics prove both B and C admit
and execute leaf Runs in all four required families.

## Evaluation Reader Quiescence After Terminal Logs (recorded and closed 2026-08-11)

**Status:** closed at the terminal evidence-settlement owner. The completed REAL
LIVE-v3 result and its `FINAL STOP` decision are unchanged.

The post-result checkpoint reached owner 109 with 108/226 owners passed, then
`evaluation-live-artifact-domain-postgres-test.js` observed its durable
fingerprint move across the read-only Ticket report. The report path itself is
SELECT-only. Its filesystem production owner writes only the designated
write-once JSON, Markdown and hash artifacts after scoring an already-complete
corpus.

A PostgreSQL advisory-lock reproduction at the exact successor trial class
(`03-013-family-5_5A-B`) held the post-terminal `run:failed` diagnostic INSERTs.
The old quiescence reader returned true with three legitimate writers still in
flight. Calling the report left every fingerprint field unchanged; releasing
the writers changed only `diagnostic_logs`, from 24 to 27 rows, by committing
one redundant `run:failed` echo for each terminal leaf. No report projection
changed. The retained checkpoint streams do not contain the thrown error's
in-memory before/between/after detail, and its harness schema was correctly
dropped, so the historical row values are not reconstructed or overstated.

The ordering defect was that best-effort described both failure semantics and,
accidentally, settlement semantics. The terminal echoes are legitimately
best-effort—failure to write one cannot overturn the authoritative terminal
bundle—but a successful write may not remain pending after the parent Ticket is
projected terminal, because that Ticket projection is the evaluator's durable
quiescence authority. Terminal callers now await the contained log promise
before projecting the Ticket. This does not make a log failure authoritative;
it only settles success or contained failure before quiescence becomes visible.

The deterministic regression drives the actual REAL runner through the captured
production boundary, gates the terminal log, proves the Ticket remains
non-quiescent and no artifact is accepted, then releases the writer and proves
two report reads are stable. A focused mutation removes the await from the
historically exercised failed-run owner and must kill that regression.

## Declared-Work Historical Fixture After Ticket Attempts (recorded and closed 2026-08-17)

**Status:** closed at the historical fixture boundary. Current Run admission,
Ticket-attempt membership, and declared-work authority are unchanged.

The canonical checkpoint at
`d9710cb3473aebec7e3346dc1508eaa0c4a59305` passed 139 of 230 owners and then
`declared-work-postgres-test.js` tried to insert its pre-declared-work Run into a
new Ticket without `ticket_attempt_id`. That fixture was introduced by
`b123ad5f7c16d1cee73580c8aaefc0384c86d8d4`, before migration 039 existed, to
prove that a Run admitted before `declaredWorkSnapshot` remains readable as
`historical-unavailable`; it was never a cross-Ticket admission test.

The retained INSERT copied only older Run fields/body from Ticket 1 to Ticket 5.
It did not copy or supply Ticket 1's attempt identity. At refusal, Ticket 5 was
open at revision 1 with no attempt and no Run. PostgreSQL's membership trigger
therefore rejected the null attempt reference with `Run and Ticket attempt must
belong to the same Ticket` before any declared-work assertion ran.

The compatibility boundary is now explicit and split by owner. The pre-039
backfill owner proves that a historical non-plan Run deterministically maps to a
singleton Ticket attempt without rewriting its body. The declared-work owner
seeds that exact post-migration envelope atomically: it locks the historical
Ticket, lets kernel authority mint one singleton attempt, inserts the original
pre-contract body with no `declaredWorkSnapshot`, and binds the Run to that
same-Ticket attempt. Current admission is not used to manufacture a historical
absence, no attempt identity crosses Tickets, and no product caller gains an
attempt-selection seam.

## Economic Schema Sibling Fixture After Ticket Attempts (recorded and closed 2026-08-18)

**Status:** closed at the schema-fixture admission boundary. Economic accounting
and Ticket-attempt authority are unchanged.

The checkpoint at `938c0e7bc50a3a14280fb3bb27ceaf6e96e79a7d` reached owner 147,
`economic-accounting-schema-postgres-test.js`, after 146 of 230 owners. That
Tranche-4 schema owner had created one pending worker Run and later called the
low-level `createRun` seam again on the same Ticket. Migration 039 correctly
refused a second singleton attempt while the first was unsettled.

The second Run was not a retry, historical row, or independent schema case. The
owner's original assertion explicitly models two sibling leaf Runs carrying
identical serialized request bytes, proving that uniqueness belongs to the
canonical request source rather than `exact_request_hash`. The pair is therefore
one logical execution wave and is now admitted once through
`createRunsAndStartTicket` as an exact two-member attempt. The foreign-Ticket FK
fixture separately receives its own normal singleton admission.

`planningAttemptId` remains the UUID provenance subject of a planner economic
request and is not Ticket-attempt identity. Reservations remain bound to either
one planner provenance identity or one Run; a multi-member Ticket attempt may
contain Runs with separate economic reservations. No provider pricing,
reservation lifecycle, settlement, role, or monetary rule moved into the
Ticket-attempt contract, and no economic record became Ticket lifecycle
authority.

## Runtime-Budget Serial Wave After Ticket Attempts (recorded and closed 2026-08-18)

**Status:** closed at the runtime-budget fixture admission boundary. Runtime
budgets, scheduling, and Ticket-attempt authority are unchanged.

The checkpoint at `f5f6edbb55beb42d26f9d6fe885111171264ec0d` reached owner 189,
`runtime-budget-postgres-test.js`, after 188 of 230 owners. Its serial-policy
scenario created one pending Run with `allowParallelRuns: false`, then called
the low-level `createRun` seam again on the same Ticket. Migration 039 correctly
refused a second singleton attempt while the first was unsettled.

The second Run was not a retry, a later policy admission, or an independent
budget case. The original Tranche-5 assertion requires two pending Runs on one
Ticket before either is claimed so that the canonical scheduler can prove the
second lease is refused while the first is active. Both Runs carry the same
immutable runtime-budget snapshot. The fixture now admits that complete pair
once through `createRunsAndStartTicket` as one exact two-member attempt.

Runtime-budget authority remains Run-local: each admitted Run retains its own
immutable snapshot, while a batch shares only the effective `maxAttempts`
authority already required by admission. Ticket attempts retain only identity,
membership, and disposition; they gain no execution-limit, scheduler-capacity,
or budget-charge semantics.

The same owner also retained a pre-attempt `maxAttempts` fixture that expected a
first two-Run wave to exceed a ceiling of one. The accepted authority counts
that wave as one attempt, so it is admissible. The exhaustion proof now admits
and authoritatively settles one failed predecessor, then uses the real retry
boundary to prove a second attempt is refused and the transactional reopen
creates neither a new attempt nor a Run. No unsettled predecessor is bypassed,
and Run count is not restored as attempt authority.

## Live Credential Role Trial Failure Attribution (recorded 2026-08-18)

**Status:** false attribution closed at the Owner-111 harness; the underlying
one-time pre-boundary stall remains unclassified unless it recurs with the new
safe diagnostic.

The checkpoint at `24f74362e3c3e6716b58b9a1c110d504d5fff241` reached the REAL-path
credential owner after 110 of 230 owners. A and A2a both observed only requests
whose projected configured-Agent credential matched. A2b then retained no
final-hop observation and no trial artifact, but its trial exception was caught
and discarded before the owner evaluated one combined observation assertion.
The resulting message incorrectly attributed a pre-boundary trial failure to
configured-Agent credential projection.

The immediately preceding checkpoint passed all 48 credential assertions, and
one focused acquisition at the identical failing source passed all 48 again in
38 seconds. Owner source, its complete runner/server/preload/manifest closure,
host classification and provider-variable scrubbing were unchanged. The failed
owner ran for about 75 minutes, but the discarded exception and cleaned harness
schema leave no source-owned evidence that distinguishes a blocked HTTP request,
database operation, child operation or another awaited boundary. No timeout,
retry or shared runtime behavior is changed without that evidence.

Owner 111 now propagates a failed role trial before reading observations. Its
diagnostic retains only arm, controlled phase, sanitized error class, sanitized
repository error code and sanitized repository stage. It never retains the raw
message, cause, request, header, environment or credential material. A missing
artifact and a boundary-observation read failure have separate phases; a
successful trial must explicitly reach the provider boundary before the
unchanged per-arm credential-match assertion runs. Controlled falsifications
prove both that a pre-boundary A2b failure remains a safe trial failure and that
a reached final hop with a wrong match still dies at the existing A2b credential
assertion.

## Verification Contract Authority After Ticket Attempts (recorded 2026-08-18)

**Status:** closed at the Owner-215 assertion boundary. Verification,
completion-decision and Ticket-attempt production authority are unchanged.

The checkpoint at `888b3197acd1f2be2a6ea839560aa9417d219562` reached Owner 215,
`verification-contract-authority-test.js`, after 214 of 230 owners. Scenario 3
created a completed Run row carrying a valid captured workflow verification
contract, but deliberately stopped before replay finalization, consequence,
completion decision and Ticket-attempt settlement. Its manual-completion request
was correctly refused because the current attempt was unsettled. The historical
assertion instead required the refusal prose to name verification.

That assertion belonged to the pre-attempt projector. Before migration 039,
manual completion selected the latest Run and inspected its verification state;
after the accepted cutover it consumes the kernel-owned current attempt and its
settled disposition. An unsettled exact attempt is an earlier authoritative
refusal, regardless of one member's captured verification-contract shape. No
verification signal was lost, and no new Ticket reason taxonomy is decided here.

The owner now tests the two authorities separately. Scenarios 3–5 read the
existing structured `verification.requirement` projection, so valid, absent,
empty and identity-less captured contracts are distinguished without depending
on English error text. Scenario 3 also proves that manual completion stops at
the unsettled-attempt boundary. The relaxed recovery scenario crosses the real
evidence, consequence and settlement path and now asserts the canonical
completion decision's `verificationDisposition: failed` and
`reasonCode: VERIFICATION_FAILED`; its stricter control asserts the corresponding
passed/objective-completed decision. Thus the owner still fails if structured
verification causality is removed even when prose contains the word
“verification.”


## T2 Leaf-Lineage Closure at the Run Admission Boundary (recorded and corrected 2026-08-18)

**Status:** corrected in the T2 Tranche 1 working tree. The lock-protocol and
stale-materialization corrections recorded below are untouched; the v2
terminal-finality premise they rely on is now mechanically enforced instead of
assumed.

Terminal aggregate finality (a persisted `completed`/`failed` aggregate can
never legitimately face a differing current derivation) requires LEAF-LINEAGE
CLOSURE: no NEW Run can later be admitted carrying a `leafRunBinding` to an
already-admitted plan/item. Binding immutability on an existing Run and
migration 039's same-attempt membership guard do not prove this — a NEW
attempt could carry a Run bound to the OLD plan/item, extending the lineage so
a previously terminal aggregate legitimately derives something else.

FOUND BY FALSIFICATION. scripts/t2-lineage-closure-postgres-test.js rebuilt a
fully valid binding + governed envelope for a NEW Run identity from durable
public data only (the next Run identity predicted by READING the runs
sequence; the binding and envelope are data with self-hashes, no secret) and
attempted admission through the low-level seam. `store.createRun` ACCEPTED it.
The Ticket's lineage then held a later bound Run; production reconciliation
REFRESHED the terminal `completed` aggregate to `pending` (the plan status
regresses) while the shared pure evaluator classifies the same durable state
as `terminal_conflict` and refuses — the exact settlement/cancellation
divergence the terminal rule exists to prevent. The same smuggle was possible
through `createRunsAndStartTicket` (new attempt after reopen), the real
`createRetryRun` composition, and a `transitionRun` body patch minting the
binding post-INSERT.

DIAGNOSED. Every Run INSERT funnels through a single seam — `createRun`
(the only two `INSERT INTO runs` statements live there; direct calls,
`createRunsAndStartTicket`, `createRetryRun` and structured leaf admission all
compose over it) — and that seam, like the `transitionRun` body-patch merge,
carried no lineage-authority check: a record/patch carrying `leafRunBinding`
was merely validated for internal consistency, never for minting authority.
The canonical `admitStructuredAllocationLeafRuns` did refuse second admission
(its existing-run and plan-status layers), but nothing prevented bypassing it
through the funnel. (A binding without a governed envelope was already refused
by the read-time pairing guard — which is why the falsification needed the
full constructed pair, and why a half-smuggle proves nothing.)

FIXED at the canonical admission authority, mirroring the existing
caller-owned-identity refusals (RUN_IDENTITY_NOT_CALLER_OWNED,
TICKET_ATTEMPT_IDENTITY_NOT_CALLER_OWNED):

- `createRun` refuses record-carried `leafRunBinding` unless the canonical
  structured leaf-admission path holds the module-private
  `LEAF_LINEAGE_MINT` Symbol capability. The capability is passed only inside
  the admitting transaction by `admitStructuredAllocationLeafRuns`; it is not
  the caller-forgeable `leafLineageAdmission: true` option that the
  falsification exposed. The canonical path re-derives every binding from the
  LOCKED admitted plan, reserves the Run identity first, and re-verifies the
  binding off the persisted rows. Error: `RUN_LEAF_LINEAGE_NOT_CALLER_OWNED`.
- `transitionRun` refuses `leafRunBinding` body patches
  (`RUN_LEAF_LINEAGE_IMMUTABLE`), mirroring `DECLARED_WORK_SNAPSHOT_IMMUTABLE`.
- No DB uniqueness constraint was added: the binding lives in the run body
  JSONB alongside legitimate historical v1/v2 compat shapes (runs may carry
  `allocationPlanId` with no binding), and a constraint there was not proven
  compatible with historical reconstruction. The funnel guard is the minimum
  mechanical correction.

ORIGINAL CONCURRENT SMEUGGLE CASE NOW REFUSED. The falsification suite (26
assertions) proves every seam refuses before INSERT, the terminal aggregate
and settled Ticket remain untouched, the refused composed retry rolls back
its reopen, and the duplicate canonical admission is refused by its own
`plan_not_pending` layer once the plan has settled. An intermittent
test-side outcome assumption in the lock suite's settlement-vs-leaf-admission
case (duplicate admission racing settlement: re-report while the plan is
pending versus `plan_not_pending` refusal once settlement has committed) was
also corrected to classify both source-legitimate interleavings with
exclusive-cause pairings; it was the pre-existing intermittent failure
observed once during the first correction handoff and not reproduced until
now. Terminal-finality is re-derived from the enforced closure: a terminal
aggregate's per-item lineage-current Runs are terminal (immutable statuses,
write-once decisions, immutable bindings) and can never gain a later member,
so the current derivation is fixed. `interrupted` remains refreshable.

## T2 v2 Completion-Authority Stale-Materialization Semantics (recorded and corrected 2026-08-18)

**Status:** corrected in the T2 Tranche 1 working tree. The lock-protocol
correction recorded above is untouched; only the pure v2 evaluator, its test
and the leaf-run suite's regression inventory changed.

The corrected `evaluateV2CompletionAuthority` first answered "does the
persisted aggregate equal the fresh aggregate?", so a contract-valid but
STALE persisted nonterminal aggregate (materialized `running`/`pending`/
`interrupted` over earlier evidence) versus a current derivation of
`completed` returned `completionInevitable: false, reason: aggregate_conflict`
— while production settlement, which reconciles (re-derives and re-persists)
inside its own transaction and then gates on the refreshed aggregate,
completed. The same authoritative current evidence therefore gave the future
read-only cancellation consumer "not inevitable" and settlement "completed",
violating the frozen T2 invariant that transaction scheduling may serialize
mutations but may not choose between CANCELED and COMPLETED when pre-existing
durable evidence already determines completion.

Source-derived classification (proven, not assumed): the persisted
`aggregateDecision` is a MATERIALIZED PROJECTION written solely by
`_reconcileLeafItemsLocked` (the only UPDATE on `allocation_plans`); it may
legitimately go stale because run statuses advance to terminal and
`run_consequences` rows are insertable at any time after the run is terminal
(the 002 terminal guard requires terminality, not terminalization-order).
`normalizeAggregatePlanDecision` proves structure/integrity/binding
(decisionHash, planHash/planId identity, re-derived projections) but does NOT
prove freshness; malformed or misbound stored aggregates are integrity
failures that throw on the production row read (`allocationPlanFromRow`) and
now throw identically in the evaluator, never falling back to "fresh
decides". TERMINAL aggregates (`completed`/`failed`) are final by
construction of their immutable inputs (terminal run statuses have empty
transition sets; decisions are write-once per run) plus leaf-lineage closure
— mechanically enforced at the Run admission boundary; see the
"T2 Leaf-Lineage Closure" entry above, which at the time this entry was
written was still an unproven premise and was subsequently proven by
falsification — so a
structurally valid terminal aggregate conflicting with current evidence is
an integrity contradiction, unreachable through legitimate channels, and the
evaluator refuses it (`persistedState: 'terminal_conflict'`,
`completionInevitable: false`) rather than choosing either side.

Corrected verdict rule: `completionInevitable` is determined by the CURRENT
derivation from the currently durable authoritative evidence. A stale
NONTERMINAL materialization never blocks completion; settlement and
cancellation compute the same verdict from the same current facts
(settlement refreshes the materialization as a side effect; cancellation is
read-only and must refuse when completion is already inevitable). Result
shape exposes `currentAggregate`, `persistedAggregate`, `persistedState`
(`absent|current|stale|terminal_conflict`) and `materializationRequired`.
Regression coverage: the pure matrix (20 assertions including the
settlement/cancellation equivalence proof over every reachable row) plus a
durable end-to-end regression in
`scripts/structured-allocation-leaf-run-postgres-test.js` (materialize
nonterminal, advance evidence to completed, evaluator answers inevitable,
real `transitionTicketAfterRun` refreshes and completes). The evaluator was
also corrected to consume the PRODUCTION run shape (runFromRow rows with
flattened body fields) — the earlier mock-only `run.body.*` reads had never
accepted real rows, which the durable regression exposed.

## T2 Lock-Protocol Falsification Deadlock (recorded and corrected 2026-08-18)

**Status:** corrected in the T2 Tranche 1 working tree. The frozen Ticket-first
lock direction was falsified by its own concurrency test and is replaced by
the Ticket-last direction; the failure history is retained in
`scripts/t2-lock-protocol-postgres-test.js` and
`docs/T2_IMPLEMENTATION_TRANCHE_1.md`.

The T2 Tranche 1 handoff froze a Ticket-level lock order of
`Ticket FOR UPDATE -> attempt FOR UPDATE -> Runs ORDER BY id FOR UPDATE` and
reordered `transitionTicketAfterRun`, `reopenTicket` and the
`createRunsAndStartTicket` predecessor path onto it. The handoff's own
falsification — two members of the same attempt, settled concurrently through
different member ids — then produced a real PostgreSQL 40P01, and the failing
test was weakened to sequential settlement instead of being diagnosed.

The observed deadlock graph (PostgreSQL server log, both the original
handoff run and the independent reproduction) was:

- Process A — settlement `transitionTicketAfterRun` — executing
  `SELECT * FROM runs WHERE ticket_attempt_id = $1 ORDER BY id FOR UPDATE`,
  holding `tickets` FOR UPDATE, `ticket_attempts` FOR UPDATE and the first
  member-run tuple, waiting for the second member-run tuple.
- Process B — run-level evidence writer (`claimPendingRun` / `startClaimedRun`
  / `transitionRun` terminalization) — executing
  `INSERT INTO events (... ticket_id ...)`, holding the second member run
  FOR UPDATE (its `UPDATE runs` / candidate CTE), waiting for
  `tickets` FOR KEY SHARE (the `events.ticket_id REFERENCES tickets(id)`
  foreign-key check), which Process A's FOR UPDATE blocks.

Root cause: the schema's own evidence path mandates `runs -> tickets FOR KEY
SHARE` (every event INSERT foreign-key check; see the same boundary documented
at `_appendEvent`, which orders run-row locks before chain-tip locks for the
identical reason). FOR KEY SHARE conflicts with FOR UPDATE, so any writer
that holds `tickets` FOR UPDATE while still waiting for a run/attempt lock
forms a genuine cycle with any concurrent run-evidence writer. The
application-level `T -> A -> R` graph was acyclic only across the explicit
SELECT ... FOR UPDATE statements; it ignored the foreign-key/trigger-induced
locks (events FK, `run_event_chain_tips`, membership-guard attempt locks)
that the same statements transitively acquire.

Correction (minimal, in the same working tree): the global Ticket-level class
order is `allocation_plans -> runs (members ORDER BY id) -> ticket_attempts ->
tickets`, with the Ticket FOR UPDATE always taken LAST.
`transitionTicketAfterRun` was reordered to routing read (no lock) ->
allocation-plan lock (restored first, matching leaf admission) -> members
ORDER BY id (routed run included; no routed-run-first lock) -> current
attempt (stale-routing revalidation) -> Ticket. `reopenTicket` reverted to
attempt -> Ticket. The `createRunsAndStartTicket` predecessor path now locks
predecessor Run -> current attempt before the Ticket gate.
`createRetryRun` acquires the predecessor Run lock before composing
`reopenTicket` + admission in one transaction. The deterministic member id
order and the stale-routing revalidation from the falsified Tranche 1 are
retained. The original concurrent case now passes repeatedly (30 consecutive
suite runs plus a 60-iteration staggered reproduction loop with no deadlock),
and the restored suite covers settlement-vs-settlement (both routing
directions), settlement-vs-reopen, settlement-vs-predecessor-admission,
settlement-vs-structured-leaf-admission, and stale-routing under a
concurrent `createRetryRun` admission.


## T2 Durable Cancellation Authority Substrate (recorded 2026-08-20)

**Status:** Tranche 2 authority substrate proven; materialized `canceled`
status intentionally deferred to the atomic five-state cutover.

Migration `040_ticket_cancellation_authority.sql` adds a nullable,
Ticket-owned `tickets.cancellation_authority` JSONB value. PostgreSQL checks
its exact six-key shape, version, Ticket identity, attribution, reason and
timestamp semantics; a PL/pgSQL helper parses `committedAt` as `timestamptz` so
an ISO-shaped impossible date cannot pass. A write-once trigger rejects any
replacement after first commit. The normalized runtime contract is
`runtime/ticket-cancellation-authority-contract.js`.

`PostgresRuntimeStore.cancelTicket` is the store-level writer. It routes without
a lock and then acquires the proven Tranche 1 order
`allocation_plans -> Run members ORDER BY id -> ticket_attempts -> tickets`,
revalidates the current attempt, evaluates the shared attempt completion and v2
completion authorities, and commits the authority plus
`ticket.cancellation_committed` provenance event atomically. The event is not
the source of current cancellation state. Exact semantic repeats are
idempotent; changed authority input, completed Tickets, historical `closed`
Tickets, malformed/misbound v2 authority and completion-inevitable evidence
refuse. Existing Run cancellation-shaped evidence does not create Ticket
cancellation authority.

The frozen lifecycle projector reports `canceled` from the durable authority,
but `tickets.status` remains in the historical six-state vocabulary because
`canceled` is not accepted by migrations 001/009. No historical `closed` row is
reinterpreted. Later attempt admission, reopen, generic Ticket transitions and
settlement cannot bypass an already committed authority.

The PostgreSQL shape rule is NULL-safe and exact-key: a PL/pgSQL CHECK helper
returns false for missing/null required fields, wrong JSON scalar types, wrong
Ticket binding, unsupported versions and unsupported extra fields. Direct SQL
falsification covers every such malformed shape, one valid first write and a
subsequent rewrite refusal.

Focused falsification: `scripts/t2-cancellation-authority-postgres-test.js`
passes 76 assertions, including direct SQL impossible-timestamp rejection,
completion/cancellation serialization, the
pre-existing-completion race, forced cancellation-first and completion-first
orderings, an actual not-yet-inevitable writer race, stale v2 materialization,
malformed v2 refusal, idempotence and PostgreSQL rewrite refusal. The pure
authority contract passes 10 assertions.

The race results are not collapsed into "one terminal authority." If
completion is already durable before the writers race, cancellation refuses
regardless of scheduling and settlement retains `COMPLETED`. If completion is
not yet inevitable at the serialization point, cancellation-first commits the
authority and blocks later settlement, while completion-first commits
`COMPLETED` and cancellation refuses. Every concurrent Promise result is
inspected and paired with its exact cause.

This is the durable cancellation authority substrate only. Public cancellation
activation and active-Run interruption/recovery integration remain prerequisites
before cancellation is exposed as final product behavior; neither is
implemented here.


## T2 Tranche 3 Five-State Cutover Source Preflight (recorded 2026-08-20)

**Status:** source contract reconciled; operational row preflight remains
required before any migration 041 implementation or execution.

The legacy close writer was traced from `PATCH /api/tickets/:id/status` through
`transitionTicketState`/`transitionTicket`: the Ticket row and `ticket.updated`
event commit `previousStatus`, status, revision, `changedBy`, and `changedAt`
together. The separate `ticket:status_change` diagnostic log records explicit
`fromStatus`/`toStatus`, actor and timestamp after that transaction. Active
Runs are then interrupted in separate operations using the exact reason
`<changedBy> closed ticket #<ticketId>`, with Run terminal events and logs. This
sequence is reconstructably ordered but not one transaction and carries no
close event id into interruption evidence.

The earlier CLOSED classifier was partially wrong because it used legacy
`previousStatus` as semantic authority. The corrected classifier reconstructs
the frozen lifecycle from all durable authority established immediately before
`closeAt`, excluding the close operation and its consequences. Thus a completed
attempt followed by legacy `open` during manual rerun remains PROVEN NOT
CANCELED. FAILED is demoted first and then follows the ordinary OPEN, BLOCKED,
IN_PROGRESS, or COMPLETED matrix row; it has no special close semantics.
`open -> closed` is PROVEN CANCELED only with matching product close evidence
and no contradiction. `in_progress -> closed` additionally requires every
active Run's exact closure interruption consequence. Missing or conflicting
evidence and `blocked -> closed` remain AMBIGUOUS.

The pre-close authority ordering uses attempt admission/settlement timestamps,
Run terminal/evidence timestamps, blocker/triage creation and resolution
timestamps, and close event position/timestamp. `aggregateDecision.decidedAt`
and `allocation_plans.updated_at` describe only the current mutable v2
projection; they do not preserve prior aggregate values. Reconciliation events
preserve status/hash/changed-item observations but not a complete prior
aggregate. Historical v2 completion is therefore reconstructed from immutable
leaf membership and append-only per-Run evidence as-of close. Any required
immutable plan/evidence fact that cannot be ordered is AMBIGUOUS.

Historical PROVEN CANCELED authority reconstruction uses durable Ticket id,
operator identity, close timestamp, and the deterministic source
`historical_operator_closure`; the reason is a factual migration-owned
statement, never a fabricated user reason. Missing semantic facts abort the
transaction.

The deterministic migration matrix includes completed-plus-intermediate-open,
all FAILED demotion variants, normal OPEN close, complete versus partial
IN_PROGRESS interruption, BLOCKED close, completed close, and post-close
evidence exclusion.

The eventual release requires stopping all old readers and writers before the
zero-ambiguity read-only preflight and atomic five-state migration, then
deploying the five-state runtime before reopening traffic. No mixed old/new
runtime/database interval is permitted. Manual rerun still requires an atomic
new-attempt writer; blocker rows without reconstructable current authority must
refuse rather than absorb blocker supersession work.


## T2 Tranche 4 Zero-Mutation Historical Classifier (recorded 2026-08-20)

**Status:** read-only five-state classifier proven in isolated PostgreSQL
schemas; operational database execution remains separately gated.

`runtime/ticket-history-classifier-contract.js` is pure and authority-first.
It reconstructs durable lifecycle authority as-of `closeAt`, demotes FAILED
before classification, treats legacy status as consistency evidence only, and
derives CLOSED outcomes from canonical pre-close lifecycle plus qualifying
close/interruption evidence. Historical v2 completion uses immutable leaf
membership and append-only per-Run evidence; mutable aggregate rows and
`updated_at` are not treated as historical versions.

`scripts/t2-five-state-classifier.js` gathers raw facts with SELECTs inside
`BEGIN READ ONLY`, verifies `transaction_read_only=on` and an optional expected
database identity, rolls back, and emits deterministic JSON with a report hash.
It has no DATABASE_URL fallback and does not invoke reconciliation or mutation
helpers. The isolated PostgreSQL proof snapshots all classifier-read tables,
runs the command twice, and verifies byte-identical reports and no logical
mutation. The pure matrix passes 28 assertions; the PostgreSQL proof passes 10
assertions per run across three independent runs.

Migration 041 is absent. The next step is a separately authorized,
zero-ambiguity operational read-only enumeration; no migration or lifecycle
mutation is included in this tranche.

## T2 Tranche 5 Operator-Facing Cancellation Surface — UNRESOLVED (recorded 2026-08-22)

**Status:** OPEN product-surface decision. No policy invented.

Tranche 5 ships the durable cancellation authority and its dedicated intent
route `POST /api/tickets/:id/cancel` (authority + materialized CANCELED in one
atomic projection), but provides NO operator-facing UI or CLI entry point for
cancellation, and the retired generic lifecycle PATCH is refused
unconditionally. The ticket-detail page therefore offers no cancel control,
and `oquery` offers no cancel command.

This is deliberate non-decision, not an oversight: T2 Tranche 2 recorded that
"public cancellation activation ... remain[s] prerequisites before
cancellation is exposed as final product behavior" (T2_IMPLEMENTATION_TRANCHE_2.md),
and no later tranche record authorizes a specific operator surface. The
independent review of Tranche 5 required that this NOT be silently assumed in
either direction. Accordingly:

- Cancellation remains API-reachable only until a product decision names the
  intended surface (ticket-detail button, tickets-list action, oquery command,
  or explicitly API-only).
- No generic "set status" authority may be restored to fill the gap.
- Completion remains settlement-only regardless of the decision.

Decision owner: product. Any resolution must be recorded here with its
rationale before UI/CLI work begins.

## T2 Tranche 5 maxAttempts Reprojection Demoted Completed Tickets — RESOLVED (recorded and corrected 2026-08-24)

**Status:** RESOLVED in this tranche's working tree; regression-pinned.

The uncommitted Tranche-5 canonical reprojection inside
`updateTicketMaxAttempts` composed blocking authority FIRST and only then
considered a settled completed attempt (`won -> blocked`, else completed/open).
Because the composer counts admitted attempts regardless of disposition,
lowering or re-saving `maxAttempts` to the consumed count on a genuinely
completed Ticket reprojection it `COMPLETED -> BLOCKED`
(`maxAttemptsExhausted` winning at `admittedCount >= ceiling`). An independent
review reproduced this through canonical writers only: exact deterministic
`workspace_objective_receipt` authority minted a hash-bound
`completed/OBJECTIVE_COMPLETED` decision, settlement projected COMPLETED, and
the policy write demoted it (revisions +2 with a `ticket.lifecycle_reprojected`
event naming `previousStatus: "completed"`).

This contradicted frozen T2 precedence — rule 3 (current settled completed
attempt with exact proof) outranks rule 4 (canonical blocker) — and diverged
from BOTH other implementations of the same ordering: settlement
(`transitionTicketAfterRun` maps `completed|blocked` dispositions directly and
consults the composer only for failed/interrupted) and migration 041's
historical classifier (`deriveCurrentLifecycle` feeds `projectTicketLifecycle`,
which orders rule 3 before rule 4). For identical durable facts the classifier
proposed `completed` while the runtime writer produced `blocked`; post-fix both
agree.

**Why completion wins:** the write-once settled disposition IS the persisted
exact proof — settlement validated `evaluateAttemptCompletionAuthority` before
writing it — and only the current/highest-ordinal attempt qualifies, so stale
older completions cannot resurrect and an unsettled current attempt still
outranks via the guard. Cancellation is untouched (the writer refuses
committed cancellations outright).

**Correction (minimum):** the reprojection now mirrors settlement exactly —
current settled `completed` projects `completed`; every other settled
disposition composes through the shared blocking-authority module for
`blocked`/`open`. Exhaustion remains fully effective against failed/interrupted
current attempts (the ordinal-242 race outcome is unchanged: two failed
attempts at ceiling 2 still project BLOCKED) and remains visible as the latent
composer verdict when a valid completion governs.

**Regression evidence:** `scripts/t2-tranche5-store-postgres-test.js` section
"completed-attempt precedence" pins: policy persisted, COMPLETED retained,
no lifecycle event needed, exactly one durable event, completion intact,
latent `maxAttemptsExhausted` reference recorded, CANCELED refuses the writer,
raise is a no-op on COMPLETED, stale-completion never resurrects, and current-
attempt exhaustion still blocks. 68 assertions pass on isolated PostgreSQL 17;
the ordinal-242 owner passes unchanged.

## T2 Migration-041 Classifier Fact-Assembly Parity — RESOLVED (recorded and corrected 2026-08-24)

**Status:** RESOLVED in the working tree; operational cutover re-attempt
requires a fresh release checkpoint plus a fresh amended-classifier barrier.

The first authorized operational 041 execution refused safely inside its
migration transaction and rolled back: the hook's classification of ticket 3
returned `integrity_contradiction`
(`HISTORY_CLASSIFIER_INVALID_INPUT`) on a fact set the accepted standalone
double-run preflight had classified clean (5/5 migratable, byte-identical
reports). No SQL body, ledger write, or data change occurred; the database
remains at migration-040 semantics.

Root cause: `classifyTicketHistory` is one semantic authority but its callers
assembled persistence rows with PRIVATE mappers. The hook mapped diagnostic-log
identity from raw `ticket_id` while selecting rows by
`ticket_id IS NULL AND context_ticket_id = :id`, feeding `log.ticketId: null`
into the contract's `positiveId(body.ticketId || log.ticketId)` for exactly
the context-only logs it selected because of that context. Source review found
further latent drift (run/plan bodies nested instead of spread — silently
disabling v2 reconstruction — missing `run.ticketId`/`plan.ticketId`,
dropped context_run_id resolution, synthesized run `updatedAt`). The
double-run barrier could not see any of this because both runs used the
standalone tool's own mapper.

**Correction (minimum):** `runtime/ticket-history-classifier-facts.js` is now
the single pure persistence-row → classifier-fact boundary (identity fallback:
direct column wins; context columns resolve only when direct is NULL; global
rows attach to nobody), required by BOTH `scripts/t2-five-state-classifier.js`
and the 041 hook; the hook's SELECTs were widened to feed the same fields.
Lifecycle semantics unchanged; the shared module is bound into migration 041's
Q1 source-digest closure.

**Regression evidence:** `scripts/t2-five-state-fact-parity-postgres-test.js`
exercises BOTH real seams against one legacy-040 schema (context-only log,
direct log, conflicting identity, global noise): standalone child-process
report and real-hook projection must agree per Ticket; source assertions
forbid private fact mappers from reappearing in either entry point.

## T3-A Objective-Revision Kernel — migration-authority exception and sanctioned baseline append (recorded 2026-08-24)

**Status:** Frozen T3-a kernel decisions, implemented in the working tree; the
activation migration is NOT authorized for operational execution until the
separate T3 cutover boundary is authorized.

**1. Why the activation baseline preserves generic `tickets.revision`
(migration-only `tickets_revision_guard` suspension).** Installing
`body.objectiveRevision` materializes kernel metadata over ALREADY-EXISTING
requested-outcome content. It changes no operator-visible Ticket state —
status, objective text, acceptance criteria, lifecycle and authority fields
remain byte/value exact — so it is migration materialization, not a
Ticket revision; advancing the generic counter would rewrite concurrency
authority for every concurrent caller without any semantic change. This is the
same invariant class as migration 039's narrowly scoped
`runs_revision_guard` suspension (kernel column backfill preserved Run
revisions), though the mechanism here guards Ticket-body metadata rather than
a new Run column. The exception exists ONLY inside migration 042's
transaction: disable immediately before the pointer-installation statements,
restore immediately after, assert restoration (`pg_trigger.tgenabled`) and
value-exactness before COMMIT. No runtime code gains guard-bypass authority.

**2. Why migration-time insertion into the append-only events table is
truthful.** No earlier migration had written `events`, because none needed to
record a PRESENT-TENSE system fact. The T3 baseline does: it asserts "at T3
activation this Ticket's requested outcome was exactly this canonical
content" — with real append position, activation-time `capturedAt`, migration
actor, `number:1`, `provenance:'t3_activation_baseline'`, full canonical
content and binding hash. It never pretends to be creation history
(`creation` provenance remains reserved to the actual creator authority). The
mechanism is bounded to migration 042, this one event type, this one
provenance; it is deterministic, idempotent on re-entry, refuses any
pre-existing pointer/event ambiguity or noncanonical legacy content, and
rolls back to zero partial baselines.

**3. Activation/cutover boundary (repository-owned guidance).** Quiesce the
runtime and ALL Ticket-creation/writer paths → prove quiescence → apply
migrations through 042 via the canonical runner → verify every Ticket carries
coherent baseline event + pointer → start the exact published revision-aware
runtime source → verify admission integrity enforcement and revision-1
creation behavior → reopen activity. No interval may permit un-revisioned
creation after baselines exist, nor pointer-requiring admission before they do.

**4. Objective-less legacy Tickets are an activation PRECONDITION failure,
not a skip class.** A pre-T3 Ticket with no requested-outcome objective is
valid legacy state, but T3 cannot truthfully fabricate revision content for
content that does not exist. Migration 042 therefore REFUSES the entire
activation transaction — code `T042_OBJECTIVE_REVISION_BASELINE_REQUIRED`,
identifying affected Ticket ids and the absent-objective reason class, zero
mutations — whenever any pre-T3 Ticket lacks a canonical objective.
Objective-less Tickets are never skipped, repaired, invented, or left
pointerless by a successful 042; successful 042 guarantees revision authority
for EVERY Ticket. Operational activation requires separately authorized
resolution of such Tickets (or proof none exist). The classification lives in
ONE place (the hook's every-Ticket preflight); the SQL convergence block
asserts the same unconditional invariant with no exemption.

**5. Objective revision follows the frozen attempt → Ticket lock order.**
`reviseTicketObjective` locks the latest Ticket attempt FOR UPDATE first and
the Ticket row last — the settlement/rerun direction. Its authoritative
unsettled-attempt read happens AFTER acquiring the Ticket lock as a plain
(non-locking) SELECT: because every admission/settlement writer for this
Ticket must hold the Ticket row while creating or settling attempts, any
overlapping writer has completed by then, so the plain read cannot miss a
concurrently admitted unsettled attempt and takes no lock that could invert
the order into a new 40P01 cycle.

**6. Advancing the repository migration head requires advancing the
process-execution release contract's compatible-schema window.** The release
contract pins `databaseSchemaVersion` / minimum / maximum to EXACTLY the
repository migration head (historical convention: bumped together at every
head-advancing commit — 37→38→39→41→42). Release readiness fails closed with
`PROCESS_RELEASE_SCHEMA_INCOMPATIBLE` whenever `migrationStatus.headVersion`
differs from that pin. Two separate discoveries during T3-a verification made
this coupling concrete: (1) the canonical full checkpoint failed at ordinal
135 because `postgres-runtime-cutover-test` seeded an OBJECTIVE-LESS current
fixture Ticket and admission integrity correctly refused its missing/malformed
objectiveRevision pointer — that fixture class was swept and corrected across
all affected owners; (2) the PREVENTIVE remaining-owner sweep then exposed
`process-runtime-dispatch-postgres-test` denying every runProcess with
`PROCESS_SANDBOX_UNAVAILABLE` and `process-supervision-postgres-test` timing
out awaiting a process operation that could never become active; clean-HEAD /
dirty bisection isolated the cause to repository migration head 42 versus the
contract's schema pin 41 (`PROCESS_RELEASE_SCHEMA_INCOMPATIBLE` → sandbox
authority denied). Future head-advancing migrations MUST include the same
release-contract window bump plus their owners' literal updates, or the
release checkpoint will fail exactly here.

**7. Generic `transitionTicket` can no longer mutate requested-outcome
content.** A patch containing `objective` / `acceptanceCriteria` now refuses
with `TICKET_OBJECTIVE_REVISION_REQUIRED` when the merged result differs
canonically from current content. When the patch is only CANONICALLY EQUAL to
current content, the requested-outcome keys are stripped/ignored before the
body merge on BOTH branches — structured-authority and plain Tickets alike —
so persisted requested-outcome storage bytes cannot be rewritten without
objective-revision authority even through whitespace-padded variants. The
surrounding ordinary transition still occurs and generic revision/evidence may
therefore advance; that is not "no Ticket transition" — it is "no
requested-outcome storage mutation." Tickets carrying
`structuredAllocationAuthority` keep their verbatim historical
`STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE` refusal for any MATERIAL change to
either field (objective-text case preserving the original message verbatim;
acceptanceCriteria now covered by the same immutability authority because
revision identity binds both fields), checked with precedence over the generic
rule. This seals the last runtime generic mutator able to create out-of-band
requested-outcome byte drift; `reviseTicketObjective` is the only sanctioned
writer of changed content.
The declared-work PostgreSQL owner was resequenced accordingly: operator stop
(existing lifecycle authority) settles the first attempt →
`reviseTicketObjective` N→N+1 → rerun binds the NEW revision while the old
admitted Run's declared-work snapshot remains byte-exact — replacing its
former mid-attempt `transitionTicket` objective patch, which frozen T3
correctly refuses.

---

*Corrupted Replay Snapshot Recovery Loop recorded, diagnosed and closed 2026-08-03 by scripts/governed-replay-corruption-postgres-test.js. Ticket Projection Over Failed Leaf recorded and closed 2026-08-03. Run Detail Page Over Corrupt Transcript recorded and closed 2026-08-03. Replay-Availability Field Unasserted recorded and closed 2026-08-03. Duplicate Terminal-Leaf Derivations recorded and closed 2026-08-03 (one shared authority, both consumers). Governed Lifecycle Transport-Count Flake recorded and closed 2026-08-03 (fixture arrival counter conflated with canonical ordinal). Intermittent Guard Mutation Limit recorded and closed 2026-08-03 (deterministic correlation contract). Fixture Crash Boundary Arrival Counter recorded and closed 2026-08-03. Parent-Fixture Hash Handshake recorded and closed as NOT REQUIRED 2026-08-03. Concurrent-Duplicate Misclassification regression recorded and closed 2026-08-03 by claim-epoch classification. Malformed Success Persistence Resistance recorded 2026-08-03. Replayed Recovery Window Churn recorded and resolved 2026-08-02. Governed Request Delivery Uncertainty recorded and resolved 2026-08-02. Governed Response-Hash Tamper recorded 2026-08-02. Workspace Operation Error Handling recorded 2026-05-28. Event Log Stream Semantics merged 2026-06-12 from `UNRESOLVED_EVENT_LOG_QUESTIONS.md` (2026-05-28). complete:true Under Per-Response Action Caps recorded 2026-06-18, ported to this document 2026-07-16. Structured Allocation Leaf-Run Retry Boundary recorded 2026-07-31. Governed No-Progress Refusal Coverage recorded and closed 2026-08-02. Recovered Governed Run Resume recorded and closed 2026-08-02 by scripts/governed-authorized-restart-postgres-test.js by scripts/governed-no-progress-withholding-postgres-test.js.*

## T3-C Executed-Intent Reader Closure — one resolver seam, legacy compatibility rule, fail-closed authority (recorded 2026-08-26)

**Status:** Implemented in the working tree on top of frozen T3-a/T3-b; owned
by `scripts/t3c-reader-closure-postgres-test.js` (registered required in the
test manifest and release checkpoint). No migration and no storage change.

**1. One repository-owned executed-intent seam.** Post-admission readers do not
each re-derive Run intent. `resolveExecutedRequestedOutcome(run, ticket)` in
server.js answers exactly "What immutable requested outcome belongs to this
Run?": declared work when `projectDeclaredWorkForRun` yields a snapshot
(objective text plus the ticket-authored success criterion as executed
acceptanceCriteria); otherwise the rules below. `buildAdmittedTicketProjection`
is now a thin consumer of the same seam, so prompt/runtime/completion readers
that already consumed `promptTicket` needed no edits.

**2. Post-T3 missing/malformed authority fails closed.** A Run carrying
`objectiveRevision` authority that lacks coherent immutable declared work is an
integrity failure, not a fallback opportunity: the seam throws
`DeclaredWorkContractError('DECLARED_WORK_AUTHORITY_REQUIRED')` (malformed
snapshots already throw through normalization/binding validation). A PRESENT but
malformed pointer is likewise corrupted state, never legacy history: revision
authority is classified FIRST through the frozen T3-a `validatePointer`, so a
noncanonical pointer throws
`DeclaredWorkContractError('DECLARED_WORK_REVISION_AUTHORITY_MALFORMED')` and
cannot ride on an otherwise-usable declared-work snapshot. The stop boundary
refuses, terminalization does not fabricate replay evidence, and the Run is left
un-terminalized rather than evidenced against current Ticket intent. No new
taxonomy was invented — existing declared-work and T3 pointer-integrity
semantics carry the refusal.

**3. Legacy Runs: recovered write-once compatibility rule.** Pre-T3 Runs — those
whose Run-level objectiveRevision authority is GENUINELY ABSENT (null/absent
field), as opposed to present-but-malformed — legitimately have
historically-unavailable executed intent
(existing `projectDeclaredWorkForRun` availability semantics; successful 042
guarantees revision authority for every TICKET but cannot retroactively stamp
RUNS admitted before T3). For such Runs the interrupted/terminal-repair replay
captures then-current Ticket intent AT WRITE TIME, records
`declaredWorkAvailability: 'historical-unavailable'`, and is never retroactively
re-read or rewritten by later revisions. This is captured-at-interrupt evidence,
not a claim that current Ticket intent is historical truth. No migration was
created for pre-T3 Runs.

**4. Readers changed vs deliberately untouched.** Changed to consume the Run's
immutable projection/seam: the two `checkObviousTicketPostcondition` completion
shortcuts in `runAgentTicket`, `isDirectWorkspaceObjectiveSatisfied`, the
prior-artifact-owner retry decision/corrective feedback, `createRunReplaySnapshot`,
`ensureInterruptedRunReplaySnapshot`, `ensureFailedRunReplaySnapshot`, and the
missing-replay fabrication branch of `reconcileTerminalRunUnlocked`. Deliberately
untouched: pre-admission feasibility/allocation/admission-gate readers (current
intent is the correct authority before admission), workflow routing identity,
and presentation/diagnostic renderings that display current Ticket state next to
Run snapshots with explicit labels.

Recorded 2026-08-26 as the T3-c implementation candidate; independent
implementation review accepted and T3 semantic closure supported; canonical
release acceptance remains pending.

**5. Post-review finding: governed completion evidence adapter.** The canonical
checkpoint's governed verified-progress lifecycle owner exposed that the old
post-batch `checkObviousTicketPostcondition(ticket)` call had made a structured
leaf completable by re-parsing mutable parent-Ticket intent. The accepted T3-c
change to `promptTicket` correctly removed that invalid authority, but revealed
that `completion-decision-contract` still received direct postcondition input
only through replay `run:postcondition_completed` observations even after the
same canonical evaluator had committed a complete governed evidence set.

The bounded correction stays in server assembly, before terminalization. For a
governed structured leaf only, `buildGovernedCompletionReplayClaim` translates
one atomically persisted evidence set into the existing replay claim shape when
and only when it has exactly one satisfied verdict for every immutable
`eligibleExecutionFacts(run)` criterion and every Run, Ticket, plan, item,
governed-policy, completion-authority, evaluator and request-window binding
agrees. Malformed evidence throws through existing normalization; incomplete,
unsatisfied, foreign or stale evidence produces no completion claim. The claim
records the supporting evidence ids/hashes, so the unchanged completion
decision's required-evidence hash binds the exact persisted rows. It does not
parse Ticket intent or inspect the filesystem, creates no new evidence format,
and changes no completion vocabulary, precedence, leaf mapping, attempt
settlement or migration identity.

**6. Review status.** This correction is a substantive post-review finding and
does not close T3-c or authorize a release checkpoint. Focused finding-closure
review remains required. During focused verification, the first T3-c owner
invocation observed `Run.status = completed` before its separate Ticket
settlement transaction advanced the Ticket revision, then attempted objective
revision with the stale generic revision and raised `OptimisticConcurrencyError`.
An unchanged second invocation passed all 42 assertions. The completion-evidence
correction does not execute for that non-governed Run; the owner synchronization
observation remains recorded rather than being hidden or repaired in this
bounded change.

**7. Independent medium-finding correction status.** Independent finding-
closure review accepted the adapter's internal evidence binding but found two
separate medium defects. The production defect is corrected: a governed leaf
with a direct-write-style immutable leaf objective could still take the pre-
adapter workflow-draft or successful-workspace-mutation terminal shortcut.
`runAgentTicket` now excludes governed structured leaves from those two ordinary-
Run heuristics, so they reach persisted governed postcondition assembly and can
complete only through the existing `run:postcondition_completed` input produced
from a complete admitted fact set. The ordinary non-governed heuristics are
unchanged.

The original S1 correction predicate was rejected as over-constrained. This
owner's existing scenario truthfully settles Run `completed`, attempt
disposition `blocked`, and Ticket status `blocked`; neither the fixture nor the
product is changed to force another outcome. Synchronization now waits for the
exact Run's current attempt to acquire any non-null write-once disposition plus
`settledAt`. Only after observing that durable attempt boundary does the owner
fetch the Ticket and consume the fresh post-settlement revision. Product and
fixture settlement semantics are unchanged. T3 semantic closure and release
acceptance remain pending narrow finding-closure review.

---

## Broad Ticket-Kernel Roadmap (T0–T10) and T4 Tranche Authority — bootstrap record (recorded 2026-08-26)

**Status:** Repository-owned architecture authority, supplied as such because a T4 opening
recovery proved it was otherwise unrecoverable (hermeticity evidence at the end of this entry).
This section is the single canonical statement of the broad ticket-kernel roadmap; no other
document duplicates or supersedes it. The other registered roadmaps
(`PROCESS_EXECUTION_ROADMAP.md`, `WORK_DEFINITION_AND_TYPED_EVIDENCE_ROADMAP.md`,
`STRUCTURED_ALLOCATION_AND_MODEL_ECONOMICS_ROADMAP.md`) are separate axes — process executor,
typed evidence, structured allocation — and do NOT define this sequence.

### The roadmap

An architectural sequencing boundary only. It is NOT a requirement that every tranche introduce
a large subsystem.

| Tranche | Name | State |
| --- | --- | --- |
| T0 | baseline | starting point |
| T1 | structured allocation decision | decided (structured-allocation evaluation closed FINAL STOP; see `SYSTEM_STATUS.md`) |
| T2 | lifecycle + reasons | implemented; FROZEN |
| T3 | objective revisions / immutable executed intent | implemented; FROZEN |
| T4 | relationships | OPERATIONALLY CLOSED (semantic kernel FROZEN; implementation complete, independently reviewed, canonical checkpoint passed, runtime cutover verified — see the T4 operational closure entry below) |
| T5 | waiting / time / fairness / backpressure | OPERATIONALLY CLOSED (semantic kernel FROZEN; implementation complete, independently reviewed, canonical checkpoint passed; no separate operational cutover required — see the T5 operational closure entry below) |
| T6 | effect boundary | SEMANTIC KERNEL FROZEN; IMPLEMENTATION COMPLETE (zero runtime delta; verification registered); OPERATIONAL CLOSURE NOT CLAIMED (see the T6 Effect Boundary — semantic freeze entry below; zero-runtime-delta implementation/verification registration entry below) |
| T7 | intervention / context | pending |
| T8 | operator plane | pending |
| T9 | external actor / event | pending |
| T10 | foundation closure | final |

Tranche names alone confer no semantics: behavior for T5+ must never be inferred forward from a
name, and each later tranche becomes repository-owned only through its own recorded brief and
registered decision.

### Tranche numbering axes — disambiguation guard

This repository contains MULTIPLE UNRELATED tranche-numbering axes. A bare historical
"Tranche N" label outside this broad-roadmap authority MUST NOT be interpreted as broad Tn
without explicit authority saying so. This is a hermeticity/cognitive-efficiency guard, not a
rename migration: historical migration headers, register entries, and file names are NOT
renamed.

Known axes:

1. **Broad T0–T10 ticket-kernel roadmap** (this section). Broad T5 = waiting / time /
   fairness / backpressure. Broad T5's registered authority is the T5 authority
   bootstrap entry below together with the T5 semantic freeze entry that follows it.
2. **T2 internal implementation tranches.** "T2 Tranche 5" names T2's own internal
   implementation sequence (five-state Ticket lifecycle cutover, migration 041 lineage,
   operator-facing cancellation surface, maxAttempts reprojection corrections). It has no
   relation to broad T5.
3. **Historical other-workstream tranche numbering.** Existing migration/register references
   such as the runtime-budget/evidence "Tranche 5" (migrations 030, 035–038; the "Tranche 5
   Register: CLOSED (2026-08-05)" entry) belong to that workstream's own historical sequence.
   They DO NOT mean broad T5 is implemented, designed, or closed. "Tranche 6" in
   `SYSTEM_STATUS.md` is the structured-allocation axis, not broad T6. Other historical
   tranche numbering may also exist (for example the eight-tranche process-execution roadmap
   and the four-tranche typed-evidence roadmap are separate axes entirely).

Rule: when any artifact says "Tranche N" or "Tn" without an explicit pointer to THIS roadmap
section, treat it as its own workstream's label. Broad Tn status is defined ONLY by this
section and the registered entries it names.

### T4 purpose

One narrow kernel question:

HOW MAY ONE TICKET BE DURABLY AND UNAMBIGUOUSLY RELATED TO ANOTHER TICKET WITHOUT MAKING
MUTABLE PROSE, UI LABELS, OR ACCIDENTAL STORAGE TOPOLOGY INTO AUTHORITY?

T4 is about cross-Ticket relationship FACTS. T4 does NOT assign scheduling, waiting, ordering,
fairness, backpressure, execution, completion, cancellation, or lifecycle consequences to those
facts, and consequences must not be inferred merely from a relationship name. In particular T4
MUST NOT create a dependency/waiting engine: waiting/time/fairness/backpressure belong to T5.

### T4 design boundaries

1. Preserve all frozen T2/T3 authority.
2. Keep Ticket lifecycle projection topology-neutral unless a later explicitly reviewed tranche
   changes that.
3. Distinguish durable relationship truth from mutable Ticket prose, UI-only labels, incidental
   JSON topology, execution-attempt membership, allocation topology, Work Context grouping,
   handoff provenance, process-template provenance, watcher provenance, and workspace/effect
   ownership.
4. Do not duplicate authority for facts already authoritatively owned elsewhere.
5. Audit the existing workflow parent/child Ticket topology (spawn-provenance `parentTicketId`
   links carried in Ticket bodies): it is a real cross-Ticket relation-like surface whose present
   authority/invariants must be understood first.
6. Determine whether that surface should remain owned by its existing spawn provenance and merely
   expose a relationship projection, be strengthened with referential/integrity authority, or be
   represented by a general T4 relation primitive. DO NOT assume the answer in advance.
7. Determine the minimum operator-authored relationship capability, if any, justified by product
   need.
8. Explicitly prevent relationship kinds/labels from silently becoming execution or lifecycle
   authority.
9. Preserve immutable Ticket identity across objective revision and attempts.
10. Fail closed when a consumer requires authoritative relationship truth and the underlying
    authority is malformed or contradictory.

### Design status — UNFROZEN at bootstrap; FROZEN 2026-08-26 by the registered freeze below

Open design questions, none answered here and none to be assumed: whether T4 needs a new relation
table; edge-owned versus Ticket-owned versus event-derived versus projected representation; exact
kinds; closed versus extensible kind vocabulary; directional versus symmetric representation;
cycles; duplicate-edge semantics; create/retract semantics; permission vocabulary; hashing; event
shape; locking strategy; API shape; UI shape; and whether handoff or parent/child provenance
should be represented as T4 relations at all.

No T4 semantic kernel was frozen as of this bootstrap, and any earlier contingent proposal from
outside the repository (during the opening recovery or elsewhere) is NOT authority. T4 became
authorized for freeze only once a design was recovered from THIS authority, independently reviewed
with three medium findings closed (body negative non-authority; handoff scoping; enumeration
completeness), and recorded in its own registered decision — see "T4 Workflow-Spawn Relationship
Kernel — semantic freeze (recorded 2026-08-26)" below. The questions above are answered there
exactly as far as the first kernel reaches; handoff exposure and operator-authored kinds remain
deferred, not silently decided. Implementation remains separately gated by the implementation
review boundary recorded in that freeze entry.

### Why this entry exists — hermeticity evidence from the T4 opening recovery

Recovery from repository evidence alone established: T2/T3 implemented semantics were fully
recoverable (frozen contract modules under `runtime/`, migrations 039–042, owner tests pinned in
the test manifest and release checkpoint, matching register entries). The forward broad roadmap
was NOT recoverable: no repository source named T4, defined "relationships" as a tranche, or
sequenced T0–T10, so a fresh model could only have proceeded on hidden conversational context.
T4 implementation was therefore correctly refused until this bootstrap made the roadmap and
tranche purpose repository-owned, exactly per the core principle that nothing required to
understand, operate, audit, or continue this project may exist only in agent memory or chat
context.

---

## T4 Workflow-Spawn Relationship Kernel — semantic freeze (recorded 2026-08-26)

**Status:** Frozen semantic kernel. Implementation NOT started; operational closure NOT claimed.
*(The preceding sentence is historical status as recorded at this 2026-08-26 semantic freeze.
It is superseded by the T4 operational closure entry below: T4 implementation has since
completed, passed independent implementation review and the canonical checkpoint, and broad T4
is OPERATIONALLY CLOSED. The semantic kernel recorded here is unchanged.)*
This is the registered decision the T4 bootstrap record above requires before implementation: the
design was recovered from THIS authority, passed independent design review with three medium
findings closed (M1: non-authoritative Ticket-body topology can neither grant nor veto relationship
truth; M2: first kernel scope is workflow-spawn parentage only, handoff remains separate; M3:
candidate discovery is not authority — every emitted fact requires complete per-child provenance
interpretation), and is frozen here. This entry does not reopen any frozen T2/T3 authority.

T4's first semantic kernel intentionally formalizes ONE already-existing durable cross-Ticket truth
— WORKFLOW-SPAWN PARENTAGE — through a derived read seam. It introduces NO generic relationship
subsystem.

### 1. Authority (T4-I1, T4-I2)

The authoritative relationship source is the existing immutable append-only workflow-spawn
provenance carried by the child's `ticket.created` event (the accepted predicate provenance of the
frozen T2 blocking-authority composer). The existing sanctioned writer remains unchanged. No new
relationship writer exists. No relationship table exists. No mutable Ticket body field is
relationship authority: `body.parentTicketId` and related spawn topology may neither establish a
relationship, nor deny a relationship, nor invalidate otherwise coherent authoritative provenance.
Body disagreement is non-authoritative integrity drift only — diagnosable, or mechanically
repairable only under a separately authorized procedure, never load-bearing for authority.

### 2. Canonical T4 fact (T4-I7)

T4 exposes a derived immutable workflow-spawn relationship fact containing the minimum semantic
identity:

- child Ticket identity;
- parent Ticket identity;
- one exact workflow-spawn relationship kind;
- originating authoritative `ticket.created` event identity/position.

No independent relationship identity is minted; the immutable originating record supplies identity.
The fact binds Ticket identities only — not Ticket revisions, attempts, Runs, allocation items, or
workflow execution topology — therefore T2 reruns/retries/resume and T3 objective revisions cannot
alter it.

### 3. Interpretation seam

One canonical pure T4 interpretation boundary owns workflow-spawn relationship semantics. It
consumes, semantically: one child Ticket identity; that child's COMPLETE relevant immutable
creation-provenance set; and exact evidence sufficient to determine whether the referenced parent
Ticket exists. SQL/query/storage mechanics are outside the pure semantic contract.

The seam is the sole canonical interpreter of workflow-spawn provenance AS A T4 RELATIONSHIP FACT.
It is NOT the sole global consumer of workflow-spawn provenance: the frozen T2 blocking-authority
composer remains an intentionally independent existing consumer of the same already-frozen
provenance predicate, and T2 remains unchanged.

### 4. Resolution

A child-specific authoritative relationship read consumes the child's complete relevant provenance:

- exactly one coherent applicable provenance record => one relationship fact;
- clean absence => truthful relationship absence;
- attempted but malformed provenance => fail closed;
- multiple applicable parent bindings, including duplicate applicable records => fail closed;
- referenced parent identity nonexistent/incoherent => fail closed.

Never choose among conflicting records, collapse them, infer intended parentage, or fall back to
Ticket body topology. Implementation uses repository-consistent exact failure vocabulary (the
review-established classification MALFORMED_SPAWN_PROVENANCE /
MULTIPLE_APPLICABLE_PROVENANCE / PARENT_TICKET_NOT_FOUND names the classes; exact code spelling is
implementation-reviewable, refusal-not-choice is not).

### 5. Parent -> child enumeration (T4-I3, T4-I5)

CANDIDATE DISCOVERY and AUTHORITATIVE RELATION RESOLUTION are permanently distinguished. A
parent-indexed query over immutable event payloads MAY discover candidate child Ticket identities;
that filtered query is NEVER sufficient to establish relationship truth. For every candidate child:
load its COMPLETE relevant creation-provenance set, invoke the canonical resolver, emit a
relationship fact only if exactly one coherent fact is proven AND its parent identity equals the
requested parent.

A candidate whose complete provenance is malformed, multiple, orphaned, or otherwise unresolved
must not silently disappear into a normal complete result. The enumeration result shape itself must
explicitly distinguish COMPLETE (all attributable candidates resolved coherently) from INCOMPLETE
(one or more attributable candidates refused); an INCOMPLETE result carries both the proven
coherent facts and typed refused child identities with refusal reasons. Completeness state lives in
the typed semantic result, not in callers noticing a non-empty refusal array. A consumer requiring
a complete authoritative set may escalate INCOMPLETE to fail-closed refusal.

### 6. Bounded corruption (T4-I4)

Corruption scope follows evidence. A malformed provenance record that cannot itself be attributed
to a requested parent must not poison unrelated parent enumeration globally; which parent malformed
provenance "probably" meant is never inferred. Child-specific required-truth reads still fail
closed on that child's own malformed authority. Presentation may render an explicit
unavailable/corrupt state but must NEVER convert an authoritative refusal or an INCOMPLETE result
into an apparently complete empty/partial relationship list.

### 7. Kind has zero operational authority (T4-I6)

The workflow-spawn relationship kind grants ZERO lifecycle meaning, admission meaning, scheduling,
waiting, ordering, fairness, backpressure, execution authority, completion authority, or
cancellation authority. The existing frozen T2 admissionHold behavior remains exactly where its
reviewed authority lives (the frozen composer path), and T4 must not restate or reroute it merely
through the new relationship abstraction. T5 owns waiting/time/fairness/backpressure.

### 8. Separate authority models remain separate

T4 does NOT unify handoff provenance, Work Context grouping, Ticket Attempt membership, Run
membership, allocation topology, process-template provenance, watcher provenance, or
workspace/effect ownership. Handoff receives no T4 kind in this tranche. Operator-authored
arbitrary relationship kinds remain unauthorized absent later recorded product need and design
authority.

### 9. Storage / writes

NO relation table. NO new persistence authority. NO migration. NO relationship writer. NO
create/retract/edit relation API. NO new locking class. NO new transaction authority. NO
body-immutability guard merely to preserve body parity. Existing workflow-spawn creation and
idempotency authority (including the migration-003 spawn-idempotency unique index) remains
unchanged.

### 10. Expected implementation shape — guidance, not permission to alter frozen semantics

The minimum implementation may include: one pure runtime T4 spawn-relation contract; minimal
read-only persistence methods for parent-side candidate discovery and complete child-side
creation-provenance retrieval; localized server readers moving authoritative parent/child questions
off `body.parentTicketId` onto the canonical seam; explicit UI unavailable/corrupt handling where a
current projection would otherwise silently omit refused relationship truth; and deterministic pure
plus PostgreSQL owners registered in the canonical test manifest and release checkpoint. A
migration is NOT expected. If implementation proves a migration, new writer, new authority source,
or any T2/T3 change necessary: STOP and reopen architecture before making that change.

### Frozen invariants

- **T4-I1 — Provenance authority.** Append-only workflow-spawn creation provenance is the sole
  authority for the T4 workflow-spawn relationship fact.
- **T4-I2 — Negative non-authority.** Mutable/incidental Ticket-body topology can neither grant
  nor deny that fact.
- **T4-I3 — Complete-provenance resolution.** No filtered subset establishes relationship truth;
  an emitted fact requires complete relevant provenance resolution for that child.
- **T4-I4 — Bounded fail-closed corruption.** Malformed, multiple, or orphaned authority refuses
  required truth without inventing parentage or globally widening corruption beyond evidence.
- **T4-I5 — Explicit enumeration completeness.** Parent-side authoritative enumeration explicitly
  distinguishes COMPLETE from INCOMPLETE and never presents refused candidates as a complete set.
- **T4-I6 — Kind non-authority.** The relationship kind itself has no lifecycle/execution/waiting
  semantics.
- **T4-I7 — Derived identity.** No independent relationship identity or writer is introduced;
  immutable originating provenance carries identity.
- **T4-I8 — Frozen predecessor isolation.** T2/T3 semantics and existing T2 provenance consumers
  remain unchanged.

### Open status after freeze

*(Historical status as recorded at this 2026-08-26 semantic freeze:)* T4 purpose: FROZEN. T4
semantic kernel: FROZEN (this entry). T4 implementation: NOT STARTED (at the time of the
freeze). T4 operational closure: NOT CLAIMED (at the time of the freeze). Handoff/general
operator relationships: DEFERRED, not silently decided — exposure via a later second projection
or kind remains available only through a future registered decision under this register's
discipline. Current status is recorded in the T4 operational closure entry below.

---

## T4 Workflow-Spawn Relationship Kernel — operational closure (recorded 2026-08-27)

**Status:** OPERATIONALLY CLOSED. This entry repairs a stale-status hermeticity defect: before
this entry, a fresh recovery of this register could infer that broad T4 remained unimplemented
because the freeze entry above recorded "implementation NOT started" as its then-current
status. This is a status/evidence repair only. It changes NO T4 semantic decision and does not
touch T4-I1..T4-I8, which remain exactly as frozen in the entry above.

### Current authoritative status

T4 — relationships: **OPERATIONALLY CLOSED.**

- Semantic kernel: FROZEN (2026-08-26 entry above; T4-I1..T4-I8 unchanged).
- Implementation: COMPLETE (pure contract `runtime/t4-spawn-relation-contract.js` with owner
  tests `t4-spawn-relation-contract-test.js` and `t4-spawn-relation-postgres-test.js`
  registered required in the canonical test manifest, plus its localized server read seams).
- Independent implementation review: CLOSED with HIGH=0, MEDIUM=0, LOW=0.
- Canonical release checkpoint: PASSED 252/252 owned suites.
- Runtime cutover: COMPLETED; the exact published revision was verified running.

### Independently recoverable evidence

- Published commit (also current repository HEAD at the time this closure was recorded):
  `bb9159569a5dc21dc735aea1bde089b844fe25ec`
- Published tree: `32450e402502bb2e243f210e387874ac1f4da5f8`
- Canonical checkpoint `checkpointRunIdentity`:
  `24968bcc-9adb-4198-8a9f-aff568bbfbc0`
- Canonical checkpoint `registryHash`:
  `844af8c1521a9c99093062e54c2c17d2246e14789c6510ee371a91336093a4ee`
- Checkpoint result: passedCount / totalCount = 252 / 252

### Operational cutover record

- The exact published revision was verified running at cutover; no migration or schema change
  was required or made.
- No provider call was used for closure verification.
- No operational workflow-spawn relationship existed in the live system, so a read-only
  positive-path relationship sample could not be taken. Operational closure therefore relies
  on live source/readiness verification plus the checkpoint-owned deterministic and PostgreSQL
  positive-path evidence (the owner tests above), which remains retained by the checkpoint.
- This limitation is recorded so no later reader assumes a live positive-path sample was or
  was not taken.

---

## T5 Waiting / Time / Fairness / Backpressure — authority bootstrap (recorded 2026-08-27)

**Status:** PURPOSE BOOTSTRAPPED; SEMANTIC KERNEL UNFROZEN; IMPLEMENTATION NOT STARTED;
OPERATIONAL CLOSURE NOT CLAIMED.
*(The preceding sentence is historical status as recorded at this 2026-08-27 bootstrap. It is
superseded by the T5 semantic freeze entry below: the semantic design was recovered from THIS
entry's authority, passed independent review, and is now FROZEN there. This entry's
mechanism classifications, fences, terminology separations, and open-question list remain the
historical authority that led to that freeze; the freeze entry records the answers to the
open questions.)*

Tranche names alone confer no semantics: the words "waiting / time / fairness / backpressure"
are a roadmap label plus an ownership boundary inherited from the frozen T4 kernel (T4-I6),
NOT a definition. This entry is a minimum authority bootstrap, recorded because a fresh
read-only recovery (2026-08-27) proved broad T5 had no brief, no kernel question, and no
registered classification of the existing related mechanisms, while three unrelated
"Tranche 5" numbering axes collide with the broad name (see the tranche-numbering
disambiguation guard in the broad roadmap entry above).

This entry authorizes DESIGN RECOVERY only. It does NOT decide the T5 kernel, does NOT freeze
any semantic invariant, does NOT promote any existing mechanism to T5 authority, and does NOT
answer the open questions below.

### T5 kernel question (design question, NOT its answer)

WHEN WORK CANNOT OR SHOULD NOT PROCEED NOW FOR REASONS NOT ALREADY OWNED BY FROZEN T2 BLOCKER
AUTHORITY, WHAT DURABLE FACTS — IF ANY — MAY GOVERN:

- when that work becomes eligible to proceed;
- ordering/fairness among otherwise eligible contenders;
- and how capacity/backpressure defers or refuses work;

WITHOUT:

- introducing another Ticket lifecycle state;
- redefining T2 BLOCKED or admissionHold;
- changing T3 attempt/revision/executed-intent identity;
- giving T4 relationships operational meaning;
- turning runtime budgets into backpressure;
- or promoting incidental scheduler/queue/timer mechanisms into semantic authority merely
  because they already exist?

This question intentionally leaves open whether the correct T5 kernel is small, large, or even
whether some candidate concepts require new durable authority at all. The T5 semantic design
must be recovered from THIS authority through a registered decision of its own; nothing in
this bootstrap pre-freezes an answer.

### Existing surfaces: candidates, NOT authority

A read-only audit (2026-08-27) inventoried the materially relevant existing surfaces. Standing
rule for all of them: **EXISTENCE OF A MECHANISM DOES NOT PROMOTE IT TO BROAD-T5 SEMANTIC
AUTHORITY.** Each classification below is the bootstrap classification only; a later
registered T5 decision may reclassify with recorded reasons.

**A. Durable runtime capacity wait mechanism — DESIGN CANDIDATE / EXISTING MECHANISM.**
`run_capacity_waits` (migration 030) carries `first_blocked_at`, `next_eligible_at`, `active`,
capacity-domain/resource identity, a fairness index ordered by `first_blocked_at`, FIFO-like
older-waiter selection in `acquireRuntimeCapacity`, and `capacity.waiting` /
`capacity.acquired` evidence events. Written today only for budgeted Runs that lose the claim
(`server.js` gates on the run-budget snapshot) and inside `withCapacity` slot waiting.
NOT YET FROZEN AS BROAD-T5 SEMANTIC AUTHORITY. Open decisions include whether persisted
waiting itself is product semantic truth; whether FIFO fairness is semantic or replaceable;
and whether `next_eligible_at` is policy or mechanism.

**B. Mutation admission backpressure — EXISTING SYSTEM-LEVEL BACKPRESSURE MECHANISM; T5
OWNERSHIP UNDECIDED.** Bounded outstanding mutation/appending admission
(`runtime/mutation-admission.js`), HTTP 429 / Retry-After under pressure, scheduler pause
while saturated, automatic reopening when pressure clears (register-recorded recovery
scenarios). Broad T5 does NOT own this yet; ownership is an open question.

**C. Pending-run claim order / capacity — LOWER-LEVEL RUNTIME MECHANISM unless a later T5
decision explicitly promotes a semantic rule.** `max_active_runs`, `local_model_concurrency`,
`allowParallelRuns` sibling serialization, SKIP LOCKED / lease mechanics, and `created_at, id`
pending-run claim ordering (PostgreSQL-coordinated in `claimPendingRun`). Capacity ceilings
and lease/claim machinery remain runtime mechanisms. Whether FIFO claim order itself is a
semantic fairness rule is OPEN.

**D. Lease / stale-work time — PRE-EXISTING EXECUTION-CONTINUITY MECHANISM.** DB-clock lease
expiry and recovery (`lease_expires_at <= clock_timestamp()` fencing, `run.lease_expired`,
recovery modes). T5 may consume its evidence but does not automatically own or redefine it.

**E. Hard runtime budgets — PREDECESSOR-OWNED HARD EXECUTION/RESOURCE BOUNDS.** Immutable
per-run snapshots: attempts, execution steps, model requests, duration, workspace/process/
browser operations, artifact bytes, and related capacity reservations (migrations 024/030,
`runtime-budget-contract.js`, workload-profile envelopes). They are NOT automatically T5
backpressure. Their authority is NOT reopened by T5.

**F. Process-template due scheduling — SEPARATE PROCESS-EXECUTION MECHANISM.** `next_run_at`
process-template scheduling and its due index create tickets on a schedule. Possible relevance
of the word "time" is an OPEN T5 scope question; it is NOT absorbed automatically.

**G. Presentation-only waiting — PRESENTATION ONLY; NOT SEMANTIC AUTHORITY.** UI labels such
as "Waiting to start" and `run:queued` presentation are derived display of pending state.

### Frozen predecessor boundaries (non-negotiable T5 design fences)

**T2:**

- Exactly five Ticket lifecycle states remain: OPEN, IN_PROGRESS, BLOCKED, COMPLETED, CANCELED.
- T5 does NOT gain permission merely from its name to add WAITING.
- T2 blocker authority remains frozen (triage unresolved, persisted refusal,
  maxAttemptsExhausted, settledBlockedAttempt, admissionHold — the closed input set of the
  pure lifecycle projector).
- admissionHold remains T2 authority unless architecture is explicitly reopened.
- A persisted blocked decision is not automatically reopened by runtime time or capacity
  changes ("a persisted block is the decision of record and is never reopened by the runtime").

**T3:**

- Objective revision authority unchanged.
- Executed intent remains immutable per admitted execution.
- Attempt/rerun/resume identity unchanged; T5 timing must not silently redefine attempt
  identity.

**T4:**

- Workflow-spawn relationship facts remain topology only.
- Relationship kind has ZERO waiting, dependency, ordering, scheduling, fairness, or
  backpressure authority (T4-I6).
- T5 must not infer dependency semantics from parent/child relationship facts.

**Other predecessor guards already recorded elsewhere in this register and
`docs/DECISION_LOG.md`:**

- Queue time != governed execution time (the immutable execution epoch — earliest
  `run.lease_acquired` — starts governed duration; a never-leased Run has zero spent time).
- Governed execution duration uses its existing execution epoch / database-clock authority
  (`clock_timestamp()`, not the process clock), with reason
  `cumulative_execution_duration_exhausted`.
- Runtime-initiated retry/replan/reroute remains declined where frozen (the churn decision
  vocabulary is exactly `continue | blocked`; a separately authorized retry Run is unaffected).
- Governed provider transport has no retry/second-route/repair semantics.
- Existing hard runtime budgets remain their current authority.

### Terminology separations for T5 design

**BLOCKED != WAITING** for T5 design purposes, and no new WAITING lifecycle state is defined
by this bootstrap. The five current uses that must never be conflated:

1. T2 lifecycle BLOCKED (durable blocker authority projection);
2. T2 admissionHold projected as BLOCKED (spawned child pending first admission — T2's frozen
   projection of a waiting-like condition; do not re-derive from T5);
3. Run capacity waiting while the Run remains `pending` (`run_capacity_waits` +
   `capacity.waiting` evidence; no lifecycle mutation today);
4. churn decision `blocked` (run-level progress stop; decision of record);
5. presentation labels like "Waiting to start".

Further separations:

- **HARD LIMIT != BACKPRESSURE.** A per-run/request/workspace-operation cap is an enforcement
  bound, not system-level admission pressure.
- **QUEUE ORDER != FAIRNESS POLICY.** A FIFO claim ordering is a mechanism default; a fairness
  policy is a declared semantic rule.
- **AUDIT TIMESTAMP != TIME AUTHORITY.** Only timestamps whose value changes an authoritative
  decision (lease fencing, execution-epoch duration, due-template discovery, capacity-wait
  ordering) are time authority.
- **T4 RELATIONSHIP != DEPENDENCY.** A parent/child relationship fact carries zero waiting or
  ordering meaning.

### Open questions (recorded OPEN; NOT answered here)

1. Is existing durable FIFO capacity fairness (`first_blocked_at` ordering) semantic truth or
   replaceable mechanism?
2. Does broad T5 require any NEW durable waiting authority at all?
3. If durable waiting exists, is it Run-level, Ticket-visible projection, or something else —
   while preserving the frozen five-state lifecycle?
4. Is T2 admissionHold explicitly OUT OF SCOPE, or would changing it require an explicit
   reopening of T2?
5. Is `next_eligible_at` semantic policy or scheduler mechanism?
6. Should non-budgeted pending Runs participate in the same durable capacity waiting evidence?
7. Does broad T5 own mutation-admission backpressure or merely consume its pressure signal?
8. Should the existing `capacity_backpressure` failure-kind wording be disambiguated from
   system mutation backpressure?
9. Is pending-run FIFO claim order semantic fairness or replaceable scheduling?
10. Does process-template `next_run_at` belong to broad T5 or remain a separate
    process-execution concern?
11. Are known ungoverned-family duration inconsistencies (per-loop-entry duration, attempt-
    local counters; see the A3 verdict entries above) relevant to T5, or do they remain
    runtime-budget/runtime-execution defects outside T5?

### Cognitive-efficiency rule

A fresh capable model should be able to recover from this entry and the broad roadmap entry
alone: what T5 is allowed to decide; what it is NOT allowed to redefine; which existing
mechanisms are merely evidence/candidates; and which questions still require semantic judgment
— with minimum search/reasoning burden consistent with understanding the system. Facts,
authorities, boundaries, and evidence are preserved here so the future design does not need to
re-derive them; they are NOT precomputed into design decisions. Do not freeze accidental
topology or implementation. Recovery burden must not be reduced by silently deciding open
questions in advance.

---

## T5 Waiting / Time / Fairness / Backpressure — semantic freeze (recorded 2026-08-27)

**Status:** SEMANTIC KERNEL FROZEN; IMPLEMENTATION NOT STARTED; OPERATIONAL CLOSURE NOT
CLAIMED.
*(The preceding sentence is historical status as recorded at this 2026-08-27 semantic freeze.
It is superseded by the T5 operational closure entry below: implementation has since completed
and been published to master, the registered implementation/evidence obligation has CLOSED, and
broad T5 is OPERATIONALLY CLOSED. The semantic kernel recorded here, including T5-I1..T5-I10,
is unchanged.)*

This is the registered decision the T5 authority bootstrap entry above requires. The semantic
design was recovered from that bootstrap's authority (kernel question, classifications A–G,
frozen predecessor fences, terminology separations, open questions) and then passed independent
design review. Initial independent review found HIGH=3 / MEDIUM=5 / LOW=2; blocking classes
included T2 admission conflation, false FIFO/seniority guarantees, accidental scheduler
fossilization, a restart/live-pressure contradiction, evidence overclaim, and over-broad time
wording. The design was corrected with the strategy: corrected admission vocabulary; REMOVAL of
FIFO/fairness from the semantic kernel rather than repair; narrowed restart/time/evidence
boundaries; no new durable authority introduced. Narrow independent finding-closure re-review
returned HIGH=0 / MEDIUM=0 / LOW=1 with verdict ALL T5 DESIGN REVIEW FINDINGS CLOSED; CORRECTED
T5 SEMANTIC KERNEL READY TO RECORD AS FROZEN AUTHORITY. No blocking finding remains. The
remaining LOW was a standalone wording ambiguity in T5-I4 and is closed in this freeze by
stating NON-DECISION DISPATCH DEFERRAL and ATTEMPT ADMISSION HAS ALREADY OCCURRED explicitly.
No T2/T3/T4 authority was reopened.

### T5 purpose

T5 defines the semantic boundaries for temporary Run deferral and related capacity/pressure
conditions that are NOT already frozen T2 blocker authority. T5 protects truthful distinctions
and predecessor boundaries. T5 does NOT define a scheduler, queue policy, fairness algorithm,
or new Ticket lifecycle state.

### Frozen invariants

- **T5-I1 — No new lifecycle state.** T5 adds no Ticket lifecycle state. Deferral, waiting, or
  pressure by themselves never mutate Ticket lifecycle. The frozen T2 lifecycle remains exactly
  OPEN, IN_PROGRESS, BLOCKED, COMPLETED, CANCELED. T5 introduces no WAITING state.
- **T5-I2 — Attempt-member deferral.** A pending Run is ALREADY an admitted member of its
  existing T2 attempt. Temporary dispatch/resource deferral of that Run creates: no Ticket
  blocker; no NEW attempt; no settlement of the existing attempt; no increment of attempt
  count; no disposition change of the existing attempt; no Run-membership change; no T3
  identity change; no Ticket lifecycle mutation. Scheduler dispatch claim and execution-lease
  acquisition have ZERO T2 attempt-admission authority. The word "admission" is reserved for
  the frozen T2 attempt-admission boundary.
- **T5-I3 — Two-phase run deferral.** PHASE 1 — PRE-LEASE DISPATCH DEFERRAL: the Run already
  belongs to its admitted attempt; the Run remains pending; no execution lease exists yet;
  queue time remains outside predecessor-governed execution duration; the cause may or may not
  be durably classifiable. PHASE 2 — IN-LEASE RESOURCE-CAPACITY WAITING: same Run; same
  admitted attempt; execution lease already exists; resource-capacity acquisition may wait;
  predecessor-governed duration continues to accrue; T5 neither pauses nor resets that duration
  authority. The two phases must not be conflated or assumed to have identical evidence or
  timing behavior.
- **T5-I4 — Mechanism reconsideration boundary.** A mechanism may automatically
  retry/reconsider a Run after TEMPORARY NON-DECISION DISPATCH DEFERRAL. "Non-decision" here
  refers ONLY to execution dispatch/lease acquisition. ATTEMPT ADMISSION HAS ALREADY OCCURRED.
  This reconsideration creates no new attempt, does not settle the existing attempt, and is not
  reopening a Ticket or attempt. Runtime time/capacity changes MUST NOT be inferred to
  automatically clear or reopen predecessor decisions of record, including: T2 blocker
  decisions; admissionHold; churn-blocked decisions; budget exhaustion; maxAttemptsExhausted;
  any other predecessor decision of record.
- **T5-I5 — No T5 time-granted eligibility.** T5 introduces no clock-granted Run eligibility of
  its own. There is no T5 "not before X" authority. `next_eligible_at` is NOT T5 semantic
  eligibility authority. Scheduler/retry interval constants are NOT T5 semantic policy.
  Predecessor-owned clocks may change conditions consumed by runtime/T5 reasoning, including:
  run-lease expiry; capacity-slot staleness/reclaim; recovery fences; governed execution
  duration; process-template due scheduling. That does NOT transfer clock ownership to T5. T5
  gives the process clock no new semantic standing.
- **T5-I6 — Ordering/fairness not frozen.** T5 v1 freezes NO FIFO guarantee, queue-order
  guarantee, fairness guarantee, or starvation guarantee. Existing `created_at, id` claim
  ordering, `first_blocked_at` older-waiter behavior, fairness indexes, SKIP LOCKED, scheduler
  cursor traversal, and wait-row active behavior remain REPLACEABLE MECHANISM. None of
  `first_blocked_at`, `active`, `capacity.waiting` events, or `created_at` ordering is promoted
  into broad-T5 fairness authority. A future fairness policy requires its own product-justified
  registered decision. QUEUE ORDER != FAIRNESS POLICY.
- **T5-I7 — Non-conflation boundary.** T5 MUST NOT conflate: (1) Run dispatch/resource
  deferral; (2) contemporaneous mutation-admission pressure; (3) capacity-machinery errors;
  (4) hard budget exhaustion; (5) latched evidence-persistence failure. Mutation-admission
  pressure remains predecessor-owned, is contemporaneous process-local mechanism state, and has
  no required historical semantic persistence. The existing failureKind string
  `capacity_backpressure` is NOT canonical T5 semantics and MUST NOT be interpreted as meaning
  ordinary capacity occupancy only. Any rename/alias cleanup is implementation work, not frozen
  semantics.
- **T5-I8 — Evidence-bounded cause claims.** A capacity-wait cause/domain may be asserted only
  when coherent supporting evidence exists; for example, coherent durable capacity-wait
  evidence may support a cause claim for a budgeted Run. But `pending + no lease` alone does
  NOT prove "waiting for capacity." Without sufficient evidence the truthful result is
  UNKNOWN / NOT DURABLY CLASSIFIED. T5 invents no durable evidence merely to improve
  observability.
- **T5-I9 — Restart truthfulness of durable distinctions.** Every distinction T5 declares
  DURABLE semantic truth must remain truthful and recoverable after restart from durable
  authority/evidence. Intentionally live-only mechanism conditions do NOT require historical
  reconstruction: a process-local mutation-pressure condition may disappear on restart because
  refused requests never obtained durable work identity/state. UNKNOWN remains valid after
  restart where cause was never durably established. No durable T5 truth may depend on an
  undocumented in-memory timer.
- **T5-I10 — Predecessor non-interference.** T5 changes nothing in T2 (five lifecycle states;
  blocker-authority input set; admissionHold; attempt admission; attempt counting; attempt
  membership), T3 (objective revision; immutable executed intent; attempt/rerun/resume
  identity), or T4 (relationship authority; T4-I1..I8; relationship facts remain operationally
  inert). T5 also does NOT absorb or redefine: mutation-admission ownership; lease/stale-work
  recovery; runtime-budget authority; governed-duration authority; churn `continue|blocked`;
  provider transport no-retry behavior; process-template `next_run_at` scheduling; known
  ungoverned-family duration defects. Those remain predecessor/separate authorities.

### Explicit non-concepts

T5 does NOT introduce: Ticket WAITING; a sixth lifecycle state; a new Run status; a new waiting
identity; a new capacity-request identity; a new durable eligibility table/field/event; FIFO
policy; fairness policy; starvation policy; priority policy; an aging/deadline system;
dependency semantics; a generic scheduler; a queue framework; T5-owned retry timing; T5-owned
process-template scheduling.

### Existing-mechanism disposition

The bootstrap entry above remains the inventory authority; status against the frozen kernel:

- `run_capacity_waits` — mechanism/evidence surface, NOT promoted wholesale to T5 authority.
- `first_blocked_at` / `active` / fairness index — mechanism only; no T5 ordering semantics.
- `next_eligible_at` — mechanism/diagnostic field; not eligibility authority.
- mutation-admission — predecessor-owned live pressure mechanism.
- claim ordering / scheduler cursor / SKIP LOCKED — replaceable scheduler mechanism.
- lease/recovery — predecessor execution-continuity mechanism.
- hard budgets — predecessor bounds, not backpressure.
- process-template `next_run_at` — separate process-execution domain.
- "Waiting to start" / `run:queued` — presentation only.

### T5 implementation obligation — run_capacity_waits active flag does not reactivate

**Status:** CLOSED — IMPLEMENTATION / EVIDENCE DEFECT REPAIRED AND INDEPENDENTLY REVIEWED
(HIGH = 0, MEDIUM = 0, LOW = 0). History below is preserved unchanged for a fresh model.

Verified source truth (pre-repair):

- `active = true` exists only as the INSERT default (`run_capacity_waits`, migration 030).
- Both conflict-update/re-wait writers (`recordPendingRunCapacityWait` and the
  `acquireRuntimeCapacity` upsert in `persistence/postgres/runtime-budget-methods.js`) update
  `next_eligible_at` / `updated_at` / revision but do NOT set `active = true`.
- Successful claim and slot acquisition both set `active = false` (claim deactivation in
  `claimPendingRun`; `acquireRuntimeCapacity` success path).
- After first deactivation, a later re-wait can emit truthful `capacity.waiting` evidence while
  the row remains `active = false`.
- Production reachability was independently established for:
  1. budgeted Run pre-lease block -> claim/deactivate -> requeue/resume -> blocks again;
  2. same Run acquires one resource -> row deactivates -> later waits for another resource.

Consequences (pre-repair):

- `getRunBudgetState` may expose `capacityWait.active = false` while the Run is currently
  waiting.
- The older-waiter mechanism's `active = true` filter can stop recognizing such a waiter.
- This is mechanism/evidence corruption, NOT T5 semantic authority. `active` is NOT promoted
  into T5 semantics.

Original closure requirement: implementation must repair or replace the stale-active
evidence/mechanism and supply deterministic + PostgreSQL owner proof before T5 can be declared
operationally closed. The fix is NOT prescribed by this freeze.

Closure evidence (independent implementation review returned HIGH = 0 / MEDIUM = 0 / LOW = 0):

- Production repair — `persistence/postgres/runtime-budget-methods.js`: both
  `recordPendingRunCapacityWait` and the `acquireRuntimeCapacity` wait upsert now make every
  qualifying new/re-activated wait row describe the CURRENT wait episode by updating
  `capacity_domain`, `resource_key`, `source_identity`, `reason`, `next_eligible_at`,
  `updated_at`, `revision` (exactly +1, trigger-enforced), `active = true`, and
  `first_blocked_at` = current episode start. Repeated polling of the same already-active
  wait remains idempotent. Mechanism coherence follows the separately recorded
  RECORDED IMPLEMENTATION-MECHANISM DECISION — run_capacity_waits is the
  current-wait-episode snapshot (below); `active` remains mechanism/evidence state, NOT
  broad-T5 semantic authority.
- Mechanism owner — `scripts/runtime-budget-postgres-test.js`: owns initial active wait,
  deactivation, same-identity reactivation, changed-identity reactivation for BOTH writers,
  current identity/cause coherence, exact revision behavior, no duplicate event/revision churn
  on repeated polling of the new identity, `first_blocked_at` episode behavior,
  `getRunBudgetState` current identity, actual-resource waiter recognition, and no false
  blocking on the stale prior resource.
- Frozen-T5 cross-boundary owner — `scripts/t5-waiting-boundary-postgres-test.js`: owns
  already-admitted attempt-member deferral, no new attempt/settlement/lifecycle mutation,
  UNKNOWN/null without evidence, coherent current capacity evidence, `next_eligible_at`
  non-authority, two-phase distinction, changed-identity idempotence boundary, and restart
  truthfulness of the CURRENT wait identity.
- Vocabulary owner — `scripts/runtime-budget-contract-test.js`: pins the existing
  `failureKind` mapping without making `capacity_backpressure` canonical T5 occupancy
  semantics.
- Manifest/checkpoint ownership — `scripts/test-manifest.js` and `scripts/release-checkpoint.js`
  register the dedicated T5 PostgreSQL owner exactly once as required.

### RECORDED IMPLEMENTATION-MECHANISM DECISION — run_capacity_waits is the current-wait-episode snapshot

**Status:** RECORDED IMPLEMENTATION-MECHANISM DECISION; NOT BROAD-T5 SEMANTIC AUTHORITY.
Recorded during the T5 active-reactivation implementation because repository authority was
insufficient to define `first_blocked_at` across a changed/re-activated wait. This decision
owns mechanism coherence only; it introduces NO FIFO, fairness, seniority, or starvation
policy and does not modify T5-I1..T5-I10.

`run_capacity_waits` is the durable CURRENT-WAIT-EPISODE snapshot for one Run (one row per
Run, primary key `run_id`). Append-only `capacity.waiting` events provide historical wait
evidence. Therefore:

1. When the existing conflict-update predicate qualifies because a new/re-activated wait
   episode is being recorded, the row must describe the CURRENT wait: `active = true`,
   current identity/cause fields match the current writer input, and `first_blocked_at`
   begins the NEW current wait episode.
2. Repeated polling of the SAME already-active current wait remains idempotent: no row
   update, `first_blocked_at` stable, no revision churn, no duplicate `capacity.waiting`
   event.
3. `first_blocked_at` is mechanism state only. It is NOT broad-T5 FIFO/fairness/seniority
   authority.
4. A Run may not carry old wait-episode seniority into a new wait episode merely because
   the same `run_id` row is reused.

This decision does NOT by itself close the active-reactivation obligation above; that
obligation is CLOSED (see above) following the independent finding-closure re-review, with
this decision recorded as its mechanism-coherence basis.

### Implementation boundary

Implementation must preserve/prove T5-I1..T5-I10. Expected work may include: enforcing or
auditing semantic non-conflation at relevant readers; making operator/read surfaces obey
UNKNOWN when evidence is absent; ensuring no unenforced `next_eligible_at` value is presented
as semantic time; correcting the verified `run_capacity_waits` active-reactivation defect above;
adding deterministic and PostgreSQL owners; registering required owners in the canonical
manifest/checkpoint. No migration is required merely because T5 exists: the current semantic
design requires NO new table, NO new column, NO new event type, NO new lifecycle state. If
implementation discovers that T5-I1..T5-I10 cannot be truthfully implemented without new
durable semantic authority, a migration, a new writer, or a T2/T3/T4 semantic change: STOP and
reopen architecture. Do not improvise around the freeze.

---

## T5 Waiting / Time / Fairness / Backpressure — operational closure (recorded 2026-08-27)

**Status:** OPERATIONALLY CLOSED. This entry records broad-T5 operational closure after the
published implementation; it is a status/evidence record only. It changes NO T5 semantic
decision and does not touch T5-I1..T5-I10, which remain exactly as frozen in the T5 semantic
freeze entry above.

### Current authoritative status

T5 — waiting / time / fairness / backpressure: **OPERATIONALLY CLOSED.**

- Semantic kernel: FROZEN (2026-08-27 freeze entry above; T5-I1..T5-I10 unchanged).
- Implementation: COMPLETE and published to master.
- Independent implementation review: CLOSED with HIGH=0, MEDIUM=0, LOW=0.
- Registered active-reactivation implementation/evidence obligation: CLOSED (its closure
  evidence is inside the freeze entry above and is not duplicated here).
- RECORDED IMPLEMENTATION-MECHANISM DECISION — run_capacity_waits current-wait-episode
  snapshot: RECORDED and unchanged; remains mechanism-only, not broad-T5 semantic authority.
- Canonical release checkpoint: PASSED 253/253 owned suites.
- No separate operational cutover was required or performed (record below).

### Independently recoverable evidence

- Published commit (also current repository HEAD at the time this closure was recorded):
  `0a947d1272098604f102405b2a6943c3d24822a9`
- Published tree: `05722980926c0428200a69840e1a3911eea349ea`
- Production implementation: `persistence/postgres/runtime-budget-methods.js` — the corrected
  current-wait-episode writers; the full implementation narrative is the freeze entry's
  closure evidence above and is not duplicated here.
- Registered owners: `scripts/runtime-budget-contract-test.js`,
  `scripts/runtime-budget-postgres-test.js`, `scripts/t5-waiting-boundary-postgres-test.js`
  (registered required in the canonical test manifest and release checkpoint).
- Canonical checkpoint `checkpointRunIdentity`:
  `180eda6c-8622-445e-aa88-421c316dbbcb`
- Canonical checkpoint `registryHash`:
  `2a0b397b73971d7a47163b335457ecb40273f5d240ff946f23c6c8e4e33b1a74`
- Checkpoint result: passedCount / totalCount = 253 / 253

### No-cutover record

T5 required NO separate operational cutover: no migration; no schema change; no new table,
column, or event type; no new durable semantic authority; no backfill; no
provider/external-service change. The corrected behavior uses the existing migration-030
`run_capacity_waits` representation. Any pre-repair wait-row state is handled by the
corrected current-wait writers on that Run's next genuine wait; no operational database
rewrite was required. No operational database action was required or performed for T5
closure. No runtime restart is a T5 closure requirement.

### Honest evidence basis

Operational closure relies on the published source identity above, the independent
implementation review, and the canonical deterministic/PostgreSQL checkpoint evidence. No
live positive-path capacity-pressure sample was required or taken. This is recorded so no
later reader invents either a live test that did not happen or an unperformed closure
requirement.

### Remaining T5 work

No unresolved broad-T5 implementation or operational-closure obligation remains. T5-I6 still
freezes no FIFO/fairness/ordering policy; future scheduler, fairness, or product work in this
area requires its own registered decision under this register's discipline and does not
reopen T5 closure.

---

## T6 Effect Boundary — authority bootstrap (recorded 2026-08-27)

**Status:** AUTHORITY BOOTSTRAPPED; SEMANTIC KERNEL UNFROZEN; IMPLEMENTATION NOT STARTED;
OPERATIONAL CLOSURE NOT CLAIMED.

This entry is a minimum authority bootstrap, recorded because a fresh read-only recovery
(2026-08-27) proved broad T6 had no brief, no kernel question, and no registered classification
of the existing effect-related mechanisms, while the roadmap label "effect boundary" carries no
repository semantics. It was produced by a repository-only discovery pass over source, migrations,
runtime contracts, evidence surfaces, tests, and register entries.

Recorded explicitly:

- The roadmap label **"effect boundary" confers NO semantics**. No T6 concept may be inferred
  from the name.
- This entry authorizes **semantic DESIGN only**.
- It **freezes NO T6 invariant**.
- It **promotes NO existing effect mechanism into broad-T6 semantic authority**.
- **Implementation is prohibited** until a separate T6 semantic-freeze decision is recorded in
  this register (see Implementation prohibition below).

### T6 kernel question (DESIGN QUESTION — NOT ITS ANSWER)

WHEN AN ADMITTED RUN CAUSES, OR MAY CAUSE, A REAL EFFECT OUTSIDE THE AUTHORITATIVE POSTGRES
RUNTIME, WHICH EXISTING PRE-EFFECT, CROSS-EFFECT, POST-EFFECT, AND UNCERTAINTY REQUIREMENTS ARE
GENERAL T6 INVARIANTS, WHICH MUST REMAIN DOMAIN-SPECIFIC, AND WHAT MINIMUM DURABLE FACTS — IF ANY
BEYOND THOSE PREDECESSOR-OWNED REQUIREMENTS — ARE REQUIRED SO THAT CRASH, RESTART, OR PARTIAL
FAILURE ALWAYS YIELDS EITHER SUPPORTED TRUTH ABOUT WHAT HAPPENED OR A TRUTHFUL REFUSAL TO CLAIM
IT — WITHOUT PROMOTING ANY SINGLE EXISTING PER-DOMAIN MECHANISM INTO GENERAL SEMANTIC AUTHORITY
OR REDEFINING FROZEN T2/T3/T4/T5 AUTHORITY?

Why the question is phrased this way: the repository already contains predecessor-owned and
domain-specific effect requirements — the operator-contract rule that a future irreversible-effect
surface must record its attempted request before execution and its result/failure afterward
(`docs/OPERATOR_CONTRACT.md` "External Side-Effect Boundary"); existing workspace crash-window
recovery behavior (recorded below as an existing workspace fact); governed provider
request/delivery uncertainty requirements; and process operation persistence requirements. The
OPEN semantic issue is what broad T6 generalizes — not whether those repository facts exist.

### Existing effect surfaces — candidates, NOT T6 authority

Standing rule: **EXISTENCE OF AN IMPLEMENTED MECHANISM DOES NOT PROMOTE IT TO BROAD-T6 SEMANTIC
AUTHORITY.** A later registered T6 decision may reclassify with recorded reasons.

**1. Workspace target operations.** Existing behavior owned by current source and tests
(`persistence/postgres/migrations/004_non_terminal_evidence.sql`,
`persistence/postgres/store.js`, `server.js`): a durable prepared intent exists before a real
target action; the action executes outside the runtime transaction; an operation receipt is
committed atomically with replay/event evidence; recovery can classify a prepared-but-unreceipted
operation against current target state, reconciling applied effects WITHOUT re-applying, and
refusing uncertain ones for explicit reconciliation; evidence must not be fabricated. Recorded as
EXISTING WORKSPACE BEHAVIOR only. NOT frozen as T6 semantics: the exact prepare/effect/receipt/
reconcile triad, its vocabulary, and its SQL shape are NOT broad-T6 authority.

**2. Governed provider transport.** A separate durable request/delivery uncertainty protocol
(reservation → request_started → transport uncertainty window → response_persisted → settled/released;
no retransmission after delivery uncertainty; settlement reconstructible from the durable response).
A DIFFERENT solution to the same boundary; do NOT model it as workspace prepared-intent machinery.

**3. Process operations.** A separate durable exactly-once/recoverable operation lifecycle with
closed terminal outcomes and hash-pinned launch/containment identity; process output is evidence,
not authority. Its lifecycle-state names are NOT frozen into T6.

**4. Browser v1.** A read-tier/evidence regime with NO prepared-intent reconciliation path
(read receipts and replay/event evidence only; in-memory session state is live-only; the browser
mutation tier is designed but NOT implemented). This asymmetry is an EXISTING FACT, not a defect
silently repaired by T6.

**5. Reserved `external.effect` vocabulary.** Consumed by consequence/read surfaces
(`collectExplicitExternalEffects`, run decision map). NO repository producer exists. Therefore it
is NOT current effect authority; no emitter may be created by this bootstrap; its
keep/retire/implement disposition is an OPEN T6 semantic question. A fresh model must not infer
that `external.effect` rows currently exist.

**6. Operator recovery.** The existing human-authored durable recovery mechanism for workspace
uncertainty (`operator_recovery_intents`, migration 012). A candidate constraint, not broad-T6
authority.

Compressed classifications (bootstrap classification only):

- **A — EXISTING REPOSITORY AUTHORITY T6 MUST NOT CONTRADICT:**
  - *Frozen broad-tranche semantic authority:* T2 lifecycle/attempt/blocker/cancellation; T3
    objective revision + immutable executed intent; T4-I1..I8; T5-I1..I10.
  - *Other repository-recorded predecessor/current authority:* churn `continue|blocked`; the
    governed persistence classifications (e.g. `REQUIRED — POST-EXTERNAL-SIDE-EFFECT,
    UNCERTAINTY ON FAILURE`) as recorded durability authority; "process output is evidence, not
    authority"; "availability is not write authority".
- **B — existing mechanism constraining design but not T6 authority:** workspace prepared
  intents, operation receipts, reconciliation behavior, advisory-lock fencing, mutation-fingerprint
  idempotency, operator recovery, governed provider request lifecycle, process operation
  lifecycle, browser v1 evidence path, runtime budgets, mutation admission, lease fencing, the
  fail-closed evidence-persistence latch.
- **C — unresolved candidate semantic role:** `external.effect`; `consequence.externalEffects`;
  attempted-vs-committed consequence data; the applied/not-applied/uncertain vocabulary; the
  generalization of any workspace mechanism; cross-domain operation-key identity; target-side
  idempotency as a participant obligation.
- **D — presentation/diagnostic/evidence only:** run decision map labels; run-detail projections;
  best-effort run logs; "Waiting to start" labels.
- **E — historical/noncanonical:** JSON-era authority documents and storage names (see the
  OPEN PRE-DESIGN HERMETICITY OBLIGATION below); historical "Tranche N" labels on other axes.
- **F — missing authority / hermeticity gap:** no broad repository-owned T6 effect authority
  existed before this record (CLOSED as an AUTHORITY-BOOTSTRAP GAP by this entry; see below).

### Predecessor fences (non-negotiable T6 design fences)

**T2:**
- No lifecycle state; effect state must not become a sixth state or a disguised lifecycle state.
- No effect-driven attempt admission/membership/count/disposition semantics; "admission" remains
  T2 vocabulary.
- No redefinition of completion, cancellation, or blocker authority; churn vocabulary remains
  exactly `continue | blocked`.

**T3:**
- Current requested intent vs immutable executed intent unchanged.
- Effect evidence must not be fabricated against current Ticket intent.
- Objective-revision authority unchanged.

**T4:**
- Workflow-spawn relationship provenance gains ZERO effect authority.
- Relationship kind does not route or authorize effects.

**T5:**
- Waiting/deferral/backpressure/time/fairness boundaries unchanged.
- Mutation admission remains predecessor-owned.
- UNKNOWN remains truthful when evidence is insufficient.
- The restart-truthfulness discipline remains binding.
- Effect state must not become a disguised T5 wait state.

Other repository-owned guards preserved where material: provider no-retry / never-retransmit on
uncertain delivery; process output is evidence, not authority; runtime budgets remain their
existing authority; evidence-persistence failure remains fail-closed; availability is not write
authority.

No additional fence is created by this bootstrap.

### Terminology / non-conflation fences (for T6 design)

- EFFECT ≠ MUTATION ≠ CONSEQUENCE ≠ RECEIPT ≠ INTENT.
- EXECUTION TARGET (immutable model-artifact identity, `runtime/execution-target-registry.js`)
  ≠ TARGET OPERATION (workspace/browser effect operation) ≠ TARGET PROVIDER (workspace boundary).
- OPERATION RECEIPT ≠ READ RECEIPT ≠ MUTATION RECEIPT ≠ ECONOMIC SETTLEMENT RECEIPT.
- EXTERNAL EFFECT ≠ NOTIFICATION.
- UNCERTAIN ≠ FAILED ≠ NOT_APPLIED.
- "admission" remains T2 vocabulary. "kind" remains T4 relationship vocabulary.
  "waiting/deferral" remains T5 vocabulary.

The positive T6 vocabulary is NOT defined by this bootstrap.

### Open semantic questions (recorded OPEN; NOT answered here)

1. Does T6 need a single effect concept, or only general boundary invariants over existing
   domain mechanisms?
2. Which parts of the workspace prepare/effect/receipt/reconcile behavior generalize, if any?
3. What minimum durable fact supports a positive claim that an effect occurred?
4. What does absence of post-effect evidence prove, if anything?
5. When must the truthful result be UNKNOWN/UNCERTAIN, and who may resolve it?
6. What is T6's relationship to target-side idempotency?
7. Which current domains are actually governed by broad T6?
8. Is attempted-vs-committed consequence data semantic truth or projection?
9. Does completion target-state evidence own effect truth or only completion truth?
10. What is the disposition of the reserved-but-never-emitted `external.effect` vocabulary?
11. Do operation keys remain domain-specific or gain any broad identity rule?
12. What effect claims must remain truthful after restart?

### EXISTING WORKSPACE RECOVERY FACT — NOT YET A BROAD-T6 INVARIANT

To close the authority-location weakness found during discovery (the strongest concise statement
of this behavior previously lived primarily in a test-file comment), the CURRENT workspace
behavior is recorded here as repository fact:

- A durable prepared intent exists before the target action.
- The real effect may occur before a receipt can be durably committed (the crash window).
- If recovery proves the effect applied, reconciliation completes evidence WITHOUT re-applying
  the effect.
- If recovery cannot distinguish the state safely, recovery REFUSES and requires explicit
  reconciliation (the Run is interrupted; a reconciliation-required event is recorded).
- Positive effect evidence is NEVER fabricated.

This is an EXISTING WORKSPACE RECOVERY FACT, NOT YET A BROAD-T6 INVARIANT. Executable owner:
`scripts/target-operation-reconciliation-test.js` (registered required in the canonical test
manifest and release checkpoint). Recording this fact does NOT decide that the exact workspace
mechanism, vocabulary, or storage generalizes.

### Hermeticity finding disposition (discovery pass, 2026-08-27)

- **HIGH-1 — No broad repository-owned T6 effect authority existed.**
  Disposition: CLOSED BY THIS BOOTSTRAP RECORD as an AUTHORITY-BOOTSTRAP GAP. This is not an
  implementation defect. The record now provides the canonical question, predecessor fences,
  candidate classifications, and open semantic questions. It still does NOT answer T6.
- **MEDIUM-1 — Stale JSON-era authority documents.**
  `docs/AUTHORITY_AND_DURABILITY.md`, `docs/EVIDENCE_VS_TELEMETRY.md`, and
  `docs/EXECUTION_SEMANTICS.md` contain discoverable JSON-era/storage authority statements that
  conflict with current PostgreSQL authority unless a superseding document is also read.
  Disposition: CLOSED — see the "T6 pre-design hermeticity obligation — closure" record below.
  (Originally recorded as an OPEN PRE-DESIGN HERMETICITY OBLIGATION at discovery; the published
  correction preserved useful historical content so a fresh model cannot mistake retired JSON
  authority for current runtime truth.)
- **MEDIUM-2 — Crash-window contract lived primarily in a test comment.**
  Disposition: CLOSED by the EXISTING WORKSPACE RECOVERY FACT section above, which records the
  current behavior in repository authority and names its executable owner, without freezing the
  mechanism as a broad-T6 invariant.
- **MEDIUM-3 — `external.effect` has no producer.**
  Disposition: recorded explicitly (surface 5 above): consumed by consequence/read surfaces; no
  current producer; reserved/non-authoritative today; keep/retire/implement disposition is an
  OPEN T6 semantic question. NOT "fixed" during bootstrap.

### Pre-design gate

T6 semantic design MUST NOT begin until BOTH:

1. this authority-bootstrap record is published; AND
2. the OPEN PRE-DESIGN HERMETICITY OBLIGATION for the stale JSON-era authority documents is
   closed.

Both conditions are now SATISFIED — see the "T6 pre-design hermeticity obligation — closure"
record below; the prohibition text above is retained for chronology.

This gate is about repository self-sufficiency, not semantic review. The `external.effect` open
question does NOT block design. No source implementation is permitted before semantic freeze
regardless.

### Schema / migration status

- The existing schema is sufficient to conduct T6 semantic design.
- No T6 migration is currently authorized or required by this bootstrap.
- Whether implementation eventually needs new persistence is OPEN and depends on the frozen
  semantic result. No migration number is named.

### Implementation prohibition

Until T6 semantic freeze: NO T6 production implementation; NO migration; NO new T6 event type;
NO new effect table; NO API; NO generic effect framework; NO promotion of prepared intents or
operation receipts into broad authority. If semantic design concludes that predecessor semantics
must change: STOP for explicit architecture review.

### Cognitive-efficiency rule

A fresh capable model should be able to recover from this entry and the broad roadmap entry
alone: what T6 is allowed to decide; what it may NOT redefine; which existing mechanisms are
candidates only; and which questions require semantic judgment — with minimum search/reasoning
burden consistent with understanding the system. Facts, authorities, boundaries, and evidence are
preserved here so the future design does not need to re-derive them; they are NOT precomputed
into design decisions. Do not freeze accidental topology or implementation. Recovery burden must
not be reduced by silently deciding open questions in advance.

## T6 pre-design hermeticity obligation — closure (recorded 2026-08-27)

The MEDIUM-1 discovery finding (stale JSON-era authority documents) is CLOSED.

- Scope: the stale JSON-era authority-document obligation only.
- Affected documents: `docs/AUTHORITY_AND_DURABILITY.md`, `docs/EVIDENCE_VS_TELEMETRY.md`, and
  `docs/EXECUTION_SEMANTICS.md`.
- Correction commit: `c1a39aa682989583ee2ff9d203e65b051a46c036` (parent
  `42d9091e85bebf3b171c586565bfbbe4da73217d`, tree `8a3b9d1e52c52e7df9634f1d6bbb6654b767cfed`).
- The correction was independently reviewed before publication; review result: HIGH=0, MEDIUM=0
  (one nonblocking LOW residual, not claimed resolved here).
- All eight recorded false-current-authority inference probes (retired JSON ticket/run/event/
  lease/log/operation-history authority; supported-adapter path; five-state Ticket vocabulary)
  were unsupported after correction.
- PostgreSQL remains the sole current runtime persistence authority.
- Useful historical/storage-independent material was retained under explicit retired-adapter
  framing.
- No T6 semantic question was answered and no T6 invariant was frozen by this closure or by the
  correction.
- No source/runtime/schema/migration/API/event/table behavior changed; the correction is
  docs-only and no checkpoint was required or run.

Pre-design gate status: SATISFIED.

- Bootstrap publication condition: satisfied by `42d9091e85bebf3b171c586565bfbbe4da73217d`.
- Stale-JSON hermeticity condition: satisfied by `c1a39aa682989583ee2ff9d203e65b051a46c036`.

Therefore T6 semantic design is now PERMITTED by the recorded pre-design gate. PERMITTED does
NOT mean STARTED. The T6 status remains: AUTHORITY BOOTSTRAPPED; SEMANTIC KERNEL UNFROZEN;
IMPLEMENTATION NOT STARTED; OPERATIONAL CLOSURE NOT CLAIMED. The implementation prohibition and
all open T6 semantic questions are unchanged.

Nonblocking residuals, explicitly NOT claimed closed by this record:

- the stale AGENTS.md citation inside `docs/EVIDENCE_VS_TELEMETRY.md`;
- stale JSON-era wording in `docs/OPERATIONAL_TELEMETRY.md`;
- historical references in `docs/archive/README.md`;
- other historical JSON-era references;
- `docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md` wording noted by the reviewer.

The closure claim is narrow: the specific recorded T6 pre-design stale-JSON authority
obligation is closed.

## T6 Effect Boundary — semantic freeze (recorded 2026-08-27)

**Status of this record:** semantic-freeze CANDIDATE, prepared for independent review. This
record freezes the T6 semantic kernel only when this exact record — together with the
roadmap-row update above — is published by being committed to this register on the
authoritative `master`. Publication means exactly that: this exact semantic-freeze record and
roadmap update committed into the canonical register on authoritative `master`. An
uncommitted working-tree candidate is not authority, and a commit on a local or
non-authoritative branch is not publication by this wording. Until that publication the
operative T6 status
remains: AUTHORITY BOOTSTRAPPED; SEMANTIC KERNEL UNFROZEN; IMPLEMENTATION NOT STARTED;
OPERATIONAL CLOSURE NOT CLAIMED. Upon publication of this exact record: SEMANTIC KERNEL
FROZEN; IMPLEMENTATION NOT STARTED; OPERATIONAL CLOSURE NOT CLAIMED. The implementation
prohibition recorded in the T6 authority bootstrap remains binding until a separate
implementation decision is registered.

This record was derived from the authority bootstrap's open questions (above) by read-only
semantic design passes over the repository's effect-related mechanisms. It freezes boundary
invariants only; it promotes no single per-domain mechanism into broad authority; it
redefines no frozen T2/T3/T4/T5 semantics.

### Decision summary

T6 is a **TRUTHFULNESS BOUNDARY** over explicitly governed real-effect surfaces. When an
admitted Run causes, or may have caused, a real effect outside authoritative runtime
persistence, T6 ensures that crash, restart, or partial failure always yields either
supported truth about what happened or a truthful refusal to claim it.

T6 is NOT: a generic effect subsystem; a universal effect entity; a lifecycle; a universal
receipt model; a universal reconciliation protocol; a universal idempotency protocol. The
persistence boundary LOCATES the truth problem; it does not define a positive ontology.
EFFECT ≠ "anything outside PostgreSQL". T6 freezes boundary invariants, not a universal
EFFECT object.

Scope sentence: T6 governs real effects outside authoritative runtime persistence that an
admitted Run causes or may cause, on the governed effect surfaces designated below. It
defines no effect ontology, no lifecycle state, no event type, and no table.

### Terminology — governed effect invocation ≠ T2 Ticket attempt

The T6-local unit is the **governed effect invocation** (short: governed invocation). A
governed effect invocation is NOT a T2 Ticket attempt. It is the domain-local external-action
identity/recovery boundary already provided by the applicable domain mechanism — for example
workspace operation identity, provider reservation/request identity, or process-operation
identity. T6 does NOT create a new universal effect-ID object. T6 does NOT redefine T2
`attempt`, `admission`, `membership`, `ordinal`, `retry`, `rerun`, or `resume`.

### Governed membership rule

Governed membership is by explicit repository classification ONLY — never inferred merely
from mutation, externality, browser operation, being outside PostgreSQL, or implementation
existence. EFFECT ≠ MUTATION.

Currently governed surfaces (repository authority already classifies their real-effect
boundary):

1. Workspace target mutations (`docs/OPERATOR_CONTRACT.md` "External Side-Effect Boundary";
   T6 authority bootstrap, workspace surfaces).
2. Governed provider requests (same operator-contract boundary; T6 bootstrap, provider
   transport surface).
3. Process operations (T6 bootstrap, process-operations surface).

A future surface becomes T6-governed ONLY through explicit repository classification under
the External Side-Effect Boundary because its repetition or unsupported occurrence claims
present the T6 truth problem. That classification must precede or accompany implementation
(the boundary's pre-effect recording duty attaches at the surface's first effect).

Browser v1 read-tier is NOT currently T6-governed (read-tier/evidence regime; registered
asymmetry is fact, not defect). If a browser mutation tier is later implemented,
implementation alone does NOT make it T6-governed; it requires explicit repository
classification. Not currently governed: operator/human actions (not Run-caused),
notifications, logs/telemetry/metrics, replaceable artifacts, evaluation fixtures.

### Frozen invariants (T6-I1..T6-I5, canonical order)

**T6-I1 — Pre-effect durable invocation record.** *Positive authority.*

A governed effect invocation must not be performed before authoritative persistence contains
a durable record sufficient, under the domain's own contract, to identify that invocation and
to support truthful post-hoc reasoning about its outcome.

Necessity: the record is the enabling fact for T6-I4 and T6-I5. Without the pre-effect
durable record, a crash during the external action can leave no authoritative trace from
which recovery can distinguish an already performed invocation from one that never occurred,
allowing recovery to re-perform an effect without sufficient truth authority. In the
workspace domain specifically, this can manifest as post-effect state being mistaken for the
invocation's starting state and the mutation being applied again. Current domain evidence:
workspace prepared intent +
event before the action; provider reservation and one-winner start before any byte leaves;
process intent before launcher contact; `docs/OPERATOR_CONTRACT.md` requires pre-recording
for future irreversible-effect surfaces.

Does NOT mean: record shape/content is domain-specific (this does NOT generalize
`target_operation_intents`, its SQL shape, or its preState mechanism); the record is
evidence, NOT T2 admission; it creates no Ticket lifecycle or wait state; browser v1 reads
(ungoverned) need no such record.

**T6-I2 — Supported positive effect claims.** *Truthfulness requirement.*

No authoritative repository claim may state or imply that a governed real effect occurred
unless repository-owned durable evidence sufficient under the applicable domain contract
supports that claim.

Authoritative carriers include receipts; authoritative events/evidence records; consequence
records when making an effect claim; evaluations/completion decisions when making an effect
claim; recovery records; decisions of record. Presentation/diagnostic surfaces are NOT
promoted into semantic authority.

RECEIPT ≠ EFFECT. The existing receipt-kind nonconflations (operation receipt ≠ read receipt
≠ mutation receipt ≠ economic settlement receipt) are preserved. This subsumes and generalizes
the never-fabricate rules: positive effect evidence is never fabricated.

**T6-I3 — Absence is not proof of absence.** *Negative/non-authority.*

Absence of post-effect evidence alone must never be treated as proof that a governed effect
did not occur. Non-occurrence may be established only through domain-designated evidence:
positive observation of unchanged state, or demonstrated absence of a record whose existence
the domain mechanism guarantees when the effect occurred.

This does NOT mean non-occurrence can never be established; it prohibits bare-absence
inference. Current domain evidence: workspace `not_applied` requires pre-state-match
observation, never receipt-absence; provider observation absence is UNKNOWN, never proof of
non-invocation; process unlaunched conclusions require the launcher's guaranteed-complete
durable registry.

**T6-I4 — Effect-occurrence uncertainty remains unresolved.** *Truthfulness requirement;
effect-truth dimension only.*

When repository-owned durable evidence cannot safely distinguish whether a governed effect
occurred, authoritative effect-occurrence truth must remain unresolved. The runtime must
preserve enough durable uncertainty to prevent an unsupported occurred claim, an unsupported
not-occurred claim, and unsafe repetition under T6-I5. Effect-occurrence uncertainty may be
resolved only by evidence or by a domain-designated adjudication authority explicitly
authorized to establish that fact. Domain policy may act conservatively while uncertainty
remains, but such policy action does NOT itself resolve effect occurrence.

Current resolution classifications, recorded precisely: workspace operator recovery
authorizes a resolution process, while actual occurrence/non-occurrence remains
evidence-established (recovery completes evidence only when classification proves the fact,
and refuses what it cannot prove); launcher facts are evidence; conservative provider
economic settlement is policy acting while delivery occurrence remains unresolved (the
settlement receipt never claims an unreceived response). No current authority establishes
occurrence by declaration.

UNCERTAIN ≠ FAILED and UNCERTAIN ≠ NOT_APPLIED are preserved. The words `uncertain`,
`applied`, `not_applied` are NOT frozen as broad-T6 vocabulary; they remain workspace-domain
terms. T6-I4 does NOT redefine FAILED, INTERRUPTED, BLOCKED, T5 UNKNOWN (cause
classification), Ticket lifecycle, or waiting/deferral: a Run may fail or be interrupted
while effect occurrence remains unresolved, and effect uncertainty never becomes a lifecycle
state, blocker, or churn outcome.

**T6-I5 — No additional effect from repeating an unresolved governed invocation.**
*Negative rule; invocation-local.*

Within the identity and recovery boundary of the SAME governed effect invocation under the
applicable domain mechanism, an invocation whose occurrence remains unresolved must not be
invoked again in a way that can produce an additional real effect. Such repetition is
permitted only when durable domain authority sufficient under that domain's contract
establishes that no additional effect can result. Reuse of an operation key, identical
inputs, a matching objective, a matching path, matching provider-request bytes, or assumed
target idempotency do not by themselves establish repetition safety.

Cross-Run boundary (explicit): an independently admitted new Run or T2 attempt is NOT
automatically the same governed effect invocation merely because its objective, inputs, path,
provider request, process, or real-world consequence resembles an earlier unresolved
invocation. T6 creates NO cross-Run effect equivalence, NO global effect ID, and NO global
business-level deduplication.

Current implementation fact (recorded OUTSIDE the invariant, not part of it): current
governed domains satisfy T6-I5 through durable no-effect proof or by never repeating an
unresolved invocation; no current domain uses participant-side deduplication as the
establishment authority. A future explicitly classified domain may use a durable
deduplication authority only if its separately registered domain contract is sufficient to
establish the required no-additional-effect fact; T6-I5 itself neither grants nor forbids
such a mechanism.

### New Run / retry / rerun / resume fence (load-bearing)

T6 governed effect invocation ≠ T2 Ticket attempt. Existing predecessor authority remains
exactly as registered: retry/rerun/reassess admit a NEW T2 attempt; lease reclaim, replay
continuation, terminal repair, and resume retain the existing Run/attempt identity
(`docs/TICKET_ATTEMPT_AUTHORITY.md`; `docs/PRIMITIVE_GLOSSARY.md`). Admission copies no
effect state, and T6 does NOT gate or condition new-attempt admission on predecessor effect
uncertainty ("admission" remains T2 vocabulary with no effect inputs).

An independently admitted new Run starts its OWN T6 chain for each governed effect invocation
it performs — its own T6-I1 record, T6-I2 claim gate, T6-I3 absence rule, T6-I4 unresolved
handling, and T6-I5 invocation-local repetition safety. The predecessor Run's unresolved
effect evidence remains durably visible and independently recoverable (run-scoped recovery
does not touch the new Run's evidence).

Deliberate product boundary, recorded explicitly: T6 prevents crash/restart/partial-failure
recovery from silently duplicating the same governed effect invocation. It does NOT prevent
an operator or separately admitted new Run from deliberately initiating another similar
real-world effect. Cross-Run/business-level effect deduplication, if ever wanted, is a
separate future decision requiring its own identity seam and must not be inferred from T6.

### Registered open questions — disposition (all closed by this record)

- Q1 One EFFECT concept? NO. Boundary invariants only.
- Q2 Workspace generalization? Only the semantic shape: pre-effect durability; supported
  claims; no bare-absence inference; unresolved preservation; no additional effect from
  same-invocation repetition. Workspace preState/`not_applied` machinery remains
  domain-specific (workspace reapplies only after durable not_applied proof — that is the
  domain's exemplar of the T6-I5 establishment gate, not the gate itself).
- Q3 Positive occurrence claim? Requires domain-designated repository-owned durable evidence.
- Q4 Missing evidence proves? Nothing by itself.
- Q5 UNKNOWN/UNCERTAIN? Freeze unresolved-preservation behavior, not a universal word;
  settlement does not resolve occurrence.
- Q6 Target-side idempotency? Not a broad obligation; may be a separately authorized domain
  capability; never assumed.
- Q7 Governed domains? Explicit repository classification only.
- Q8 Attempted vs committed consequence? Truthful durable projection, not new semantic
  authority.
- Q9 Completion target-state evidence? Completion truth only; does not independently own
  effect truth.
- Q10 `external.effect`? Reserved, non-authoritative vocabulary; no semantic role frozen; no
  emitter authorized.
- Q11 Operation keys? Remain domain-specific; no broad identity contract.
- Q12 Restart truth? T6-I1 records, T6-I2 evidence, T6-I4 unresolved truth, and the authority
  required for T6-I5 must survive where losing them could cause false claims or unsafe
  same-invocation repetition; live-only state may disappear where that cannot happen.

### Rejected generalizations (not frozen)

Universal prepared-intent machinery; universal receipt shape; universal reconciliation state
machine; universal operation-key identity; universal target idempotency; universal
`external.effect` event; universal attempted/committed consequence schema; browser using
workspace recovery; provider using workspace recovery; effect = mutation; effect =
irreversible action; effect = anything outside PostgreSQL; global/cross-Run effect
deduplication.

### `external.effect` disposition

`external.effect` remains reserved and non-authoritative. No producer currently exists. T6
creates no emitter and freezes no semantic role for it. Its current consequence/presentation
consumers do not grant semantic authority. Empty current external-effect evidence means "no
recorded external-effect evidence", NOT "no external effect occurred". The vocabulary is not
retired in this semantic-freeze step (a future disposition, if ever wanted, is a separate
registered decision; the sibling reserved type `notification.sent` is notification vocabulary
and is not decided by T6).

### Attempted-vs-committed disposition

Attempted-vs-committed consequence data remains a truthful durable projection, not new broad
authority. "Attempted" means an invocation/action was attempted; it MUST NOT be read as proof
that the real effect occurred. A committed consequence read as an occurrence claim remains
subject to T6-I2 and therefore must be backed by the domain's authoritative durable evidence.
No universal consequence schema is frozen.

### Target-side idempotency / deduplication disposition

Target-side idempotency is NOT a broad T6 obligation. Safety may not be inferred from
operation key, same request bytes, same inputs, or assumed target behavior. A future
domain-specific durable deduplication authority may satisfy T6-I5 only through a separately
registered contract sufficient to establish that replay cannot create an additional effect.
No current domain has such an exemplar.

### Predecessor fences preserved (not rewritten)

T2: lifecycle / attempt / admission / completion / cancellation / blocker authority. T3:
objective revision / immutable executed intent / retry-rerun-resume identity. T4:
relationship authority; kind has no effect authority. T5: waiting / deferral / backpressure /
time / fairness; UNKNOWN cause classification; noninterference. Also preserved: provider
no-retransmit; process-output-is-evidence; availability-is-not-write-authority;
required-persistence fail-closed behavior; runtime budgets; lease fencing; mutation
admission. No T6 invariant may become authority over those mechanisms.

### Residual boundaries (non-blocking)

1. Presentation wording: "External effects (0)" / "none" can only mean no recorded evidence,
   not proof that none occurred. Presentation hygiene, not a freeze blocker.
2. `notification.sent` remains separate notification vocabulary; T6's disposition of
   `external.effect` does not decide it.
3. Workspace `applied` / `not_applied` / `uncertain` remain workspace-domain vocabulary, NOT
   broad-T6 semantic terms.
4. Cross-Run/business-level effect deduplication is explicitly outside this T6 kernel and
   would require a separate future decision.

### Implementation consequences

The semantic design requires no new persistence concept, event type, universal receipt, or
universal schema. Current domain mechanisms appear capable of satisfying the frozen kernel.
That statement does NOT mean T6 implementation is complete. Implementation remains NOT
STARTED. No implementation steps are authorized by this record; no migration is authorized or
numbered; no schema work is authorized. Implementation requires its own separately registered
decision.

### Cognitive-efficiency note

A fresh capable model can recover the T6 answer from this record plus the governed-membership
rule alone: record before invocation (I1); claim only with durable evidence (I2); absence
proves nothing by itself (I3); unresolved stays unresolved until evidence or explicitly
authorized adjudication resolves it (I4); never repeat an unresolved invocation in a way that
can add an effect (I5) — invocation-local, no cross-Run equivalence. Domain mechanisms are
needed only to learn HOW to comply, not WHETHER a claim is truthful.

## T6 provider-surface classification — ordinary worker transport (recorded 2026-08-27)

**Status of this record:** classification-clarification CANDIDATE, prepared for independent review.
This record is an APPLICATION of the already-frozen T6 membership rule to one previously unnamed
live provider path. It makes explicit what current repository authority already determines. It is
NOT a T6 semantic amendment, NOT a new invariant, NOT a governed-surface addition or removal, and
NOT an implementation change. Until it is published by being committed to this register on
authoritative `master`, it is not authority (the same convention the semantic-freeze record states
for itself: an uncommitted working-tree candidate is not authority).

### Question and classification

One classification seam remained implicit in the published T6 authority: whether the live
ordinary (non-structured) worker provider transport — `callOpenAI` / `callOllama`, reached
through the ungoverned provider path selected by `selectRunProviderPath`
(`runtime/governed-leaf-orchestration.js:116-130`; `server.js:12722-12727`) — is subject to
T6-I1..T6-I5.

**Classification: NO. The ordinary worker provider transport is currently OUTSIDE T6 governance.**

The authority chain, each link already in the repository:

1. **Frozen membership rule** (T6 Effect Boundary — semantic freeze, "Governed membership rule"):
   "Governed membership is by explicit repository classification ONLY — never inferred merely from
   mutation, externality, browser operation, being outside PostgreSQL, or implementation
   existence."
2. **Frozen governed-surface list** (same record, "Governed membership rule"): item 2 names
   "Governed provider requests" and cites "T6 bootstrap, provider transport surface".
3. **T6 bootstrap provider surface** (T6 Effect Boundary — authority bootstrap, "Existing effect
   surfaces" item 2): the cited surface is "Governed provider transport. A separate durable
   request/delivery uncertainty protocol (reservation → request_started → transport uncertainty
   window → response_persisted → settled/released; no retransmission after delivery uncertainty
   …)". The frozen item therefore names the reservation-based governed protocol.
4. **Repository term of art** (`docs/ARCHITECTURE_INVARIANTS.md` §10 "Governed Execution
   (Tranche 4)"): "No governed provider request may occur before a durable reservation exists and
   a one-winner start transition has been won", and "A structured leaf Run with complete governed
   authority cannot reach an ungoverned provider adapter" — the worker adapters are the named,
   deliberate counterpart family.
5. **Existing records preserving the historical ungoverned provider family**:
   `docs/DECISION_LOG.md` ("Ollama cannot be governed. … Ollama remains fully supported on
   historical ungoverned paths"); the ungoverned-path pre-transport transaction record
   (`docs/ARCHITECTURAL_DECISIONS_PENDING.md`, Tight-Budget Postcondition Liveness Regression:
   "… one pre-transport transaction on the ungoverned path"); and the registered distinct
   ungoverned execution family in the structured-evaluation record (direct arms, "multi-agent but
   ungoverned").
6. **The frozen I5 implementation fact** (semantic freeze, invariant T6-I5: "current governed
   domains satisfy T6-I5 through durable no-effect proof or by never repeating an unresolved
   invocation") holds as written only under this classification, because the ordinary worker path
   does repeat interrupted requests (see the implementation fact below). The frozen factual record
   is true exactly when this path is outside the current governed set.

The result is NOT inferred from the word "ungoverned"; it follows from the frozen membership rule
operating over the chain above. No repository authority anywhere classifies the ordinary worker
provider path as T6-governed.

### Operator-contract relation

`docs/OPERATOR_CONTRACT.md` "External Side-Effect Boundary" states that model-provider calls are
an external runtime surface, recorded in replay as provider requests/responses. That statement
describes the external side-effect/recording boundary. It is NOT, by itself, the T6
governed-membership enumeration: T6 membership is controlled by the later frozen
explicit-classification rule. The boundary description is not invalid and is not superseded; the
two authorities operate at different layers, and the frozen record itself cites the boundary for
both workspace and provider surfaces. The ordinary worker path satisfies the boundary's recording
regime as written: request evidence is committed before transport and result/failure evidence
afterward.

### Current runtime fact (implementation fact, NOT semantic authority)

For the ordinary worker provider path, as implemented today:

- request evidence (`provider.request.persisted`) is durably recorded before any byte leaves —
  one pre-transport transaction with the budget charge (`server.js`: `onRequest` is awaited
  before the platform call; registered in the Tight-Budget Postcondition Liveness Regression
  record);
- if request evidence exists but response evidence does not after an interruption, the same
  logical worker request may be issued again during continuation (the resume contract treats the
  re-entered turn as the same request being finished; `server.js:23228-23244`, `23443-23455`);
- no reservation / `request_started` no-retransmit authority exists on this path (the registered
  no-retransmit fence, Governed Request Delivery Uncertainty record, is scoped to governed
  requests).

Because this path is outside current T6 governance, that behavior is NOT a violation of T6-I5.
T6 currently imposes no judgment on that behavior. This clarification neither endorses nor
changes it under any other current or future authority.

### Invocation-identity note

The ordinary worker path already possesses a durable logical request identity — the Run plus the
model-call key, materialized as the provider-request evidence key and the runtime-budget source
identity (`server.js:12710`, `12732`, `23441`). That fact does NOT make the path T6-governed, and
identity alone does NOT establish repetition safety. No new effect ID or cross-domain identity
contract is created by this record.

### Future-classification fence (forward guidance only)

If a future registered decision classifies the ordinary worker provider path under T6, its
interrupted-request reissue behavior must be evaluated against the frozen kernel BEFORE such
classification becomes operational. In particular, T6-I5 would require durable domain authority
establishing that repetition of an unresolved invocation cannot create an additional real effect;
the ordinary worker path has no such no-additional-effect authority today. This record does not
classify the path into T6, does not design a fix, does not authorize migration or schema work,
does not copy the governed reservation protocol into the worker path, and does not prohibit the
path's current behavior. Forward guidance only.

### No semantic change

This record changes nothing frozen:

- T6-I1, T6-I2, T6-I3, T6-I4, T6-I5: unchanged.
- Governed membership rule: unchanged.
- Current governed surface list: unchanged — workspace target mutations; governed provider
  requests; process operations.
- Browser v1 classification: unchanged (read-tier outside T6).
- Cross-Run boundary: unchanged (no cross-Run equivalence, no global effect ID, no global
  business-level deduplication).
- `external.effect` disposition: unchanged (reserved, non-authoritative, no producer).
- T2/T3/T4/T5 authority: unchanged.

T6 remains: SEMANTIC KERNEL FROZEN; IMPLEMENTATION NOT STARTED; OPERATIONAL CLOSURE NOT CLAIMED.
This record claims no implementation progress and no operational closure.

### Deliberately out of scope

Not addressed here, each a separate question: `docs/OPERATOR_CONTRACT.md` enumeration drift;
"External effects (N)" presentation wording; the workspace not-applied crash-window test; the
orphaned `event-chain-restart-test.js`; any T6 verification indexing.

---

## T6 Effect Boundary — zero-runtime-delta implementation / verification registration (recorded 2026-08-27)

**Status of this record:** Phase-A implementation-registration CANDIDATE, prepared for
independent review. It registers that the already-frozen T6 semantic kernel is REALIZED by
existing predecessor-owned governed-domain mechanisms, requires ZERO runtime implementation
delta, and that repository-owned deterministic verification ownership is now explicitly
indexed. It is NOT a T6 semantic amendment, NOT a new invariant, NOT a governed-surface
addition or removal, NOT an implementation code change, and NOT operational closure. Until
this exact record and the roadmap-row update above are published by being committed to this
register on authoritative `master`, they are not authority (the same convention the semantic
freeze and classification records state for themselves: an uncommitted working-tree candidate
is not authority). The CURRENT published T6 status therefore remains: SEMANTIC KERNEL FROZEN;
IMPLEMENTATION NOT STARTED; OPERATIONAL CLOSURE NOT CLAIMED. Upon publication of this exact
reviewed record: SEMANTIC KERNEL FROZEN; IMPLEMENTATION COMPLETE (zero runtime delta;
verification registered); OPERATIONAL CLOSURE NOT CLAIMED. Operational closure is NOT claimed
by this record; it requires its own Phase-B evidence record and a fresh canonical checkpoint
after this Phase-A publication.

### Zero-runtime-delta decision

T6 requires NO new runtime mechanism. The frozen invariants (T6-I1..T6-I5, semantic freeze
entry above; semantics not re-specified here) are already realized by the existing governed
surfaces:

WORKSPACE TARGET MUTATIONS

- durable target operation intent before effect (`target_operation_intents`, migration 004,
  append-only);
- receipt/evidence ownership committed atomically with replay/event evidence;
- positive post-state classification (`classifyPreparedWorkspaceMutation`, `server.js` —
  classification by observation, never by receipt-absence);
- unresolved refusal (`workspace.operation_reconciliation_required`; manufacture nothing);
- safe same-invocation repetition gate (re-execution only after durable `not_applied` proof).

GOVERNED PROVIDER REQUESTS

- durable reservation with ordinal and budget charge;
- one-winner `request_started` before any byte leaves
  (`runtime/governed-leaf-orchestration.js` `markEconomicRequestStarted`);
- durable response/settlement evidence (settlement reconstructible from the durable response);
- uncertainty preservation (started-without-response is UNDECIDABLE, fail-closed
  `governed_request_delivery_uncertain`);
- never retransmit an unresolved governed request.

PROCESS OPERATIONS

- durable process intent before launcher contact (`process_operations`, migration 029, with
  hash-pinned launch/containment identity, `runtime/process-execution-contract.js`);
- launcher registry/evidence authority (output is evidence, not authority);
- fail-closed absence handling (unlaunched conclusions require the launcher's
  guaranteed-complete durable registry);
- truthful interruption/reconciliation (launcher facts are evidence);
- accepted operation never relaunched (exactly-once lifecycle, closed terminal outcomes).

### 15-cell compliance result

```
             WORKSPACE   PROVIDER   PROCESS
T6-I1        PASS        PASS       PASS
T6-I2        PASS        PASS       PASS
T6-I3        PASS        PASS       PASS
T6-I4        PASS        PASS       PASS
T6-I5        PASS        PASS       PASS
```

PASS means: current repository implementation satisfies the frozen invariant for that
explicitly governed surface. This matrix is implementation/verification status. It is NOT new
semantic authority and creates none.

### Verification index (navigation only — pointers, not copied prose)

All suites named REQUIRED below are registered `status: "required"` in
`scripts/test-manifest.js` and therefore run in the canonical release checkpoint (PostgreSQL
suites gated by `TEST_DATABASE_URL`).

| Invariant | Workspace | Governed provider | Process |
| --- | --- | --- | --- |
| T6-I1 | Owner: `target_operation_intents` intent-before-effect + preState capture (`server.js`, `persistence/postgres/store.js`). Direct: `target-operation-reconciliation-test.js`, `operation-poststate-observation-test.js`. Supporting: `reconciliation-evidence-failure-test.js` | Owner: reservation + one-winner start (`runtime/governed-leaf-orchestration.js`, `markEconomicRequestStarted`). Direct: `governed-pre-transport-restart-postgres-test.js` (zero bytes sent). Supporting: `governed-required-persistence-postgres-test.js` | Owner: intent-before-launcher-contact, hash-pinned identity (`runtime/process-execution-contract.js`, migration 029). Direct: `process-runtime-lifecycle-postgres-test.js`, `process-launcher-foundation-contract-test.js` |
| T6-I2 | Owner: receipt atomic with replay/event evidence. Direct: `target-operation-reconciliation-test.js` (exactly one recovery receipt), `reconciliation-evidence-failure-test.js` (refusal on persistence failure) | Owner: settlement from durable response; receipt never claims unreceived response. Direct: `economic-settlement-receipt-contract-test.js` | Owner: output-is-evidence consequence reconstruction. Direct: `process-consequence-reconstruction-test.js` |
| T6-I3 | Owner: positive pre-state-match classifier (`classifyPreparedWorkspaceMutation`). Direct: `operation-poststate-observation-test.js` | Owner: `transport.absenceMeans` = UNKNOWN carried beside projection value. Direct: `provider-transport-observation-test.js` | Owner: guaranteed-complete launcher registry gate. Direct: `process-runtime-fault-recovery-test.js` |
| T6-I4 | Owner: divergence refusal + `workspace.operation_reconciliation_required`. Direct: `target-operation-reconciliation-test.js` (UNCERTAIN branch) | Owner: UNDECIDABLE fail-closed `governed_request_delivery_uncertain`. Direct: `governed-post-transport-restart-postgres-test.js`. Supporting: `provider-response-recovery-postgres-test.js` | Owner: launcher facts as evidence; truthful interruption. Direct: `process-runtime-fault-recovery-test.js`. Supporting: `process-supervision-postgres-test.js` |
| T6-I5 | Owner: reapply gate — recovery effect only after durable `not_applied` proof (`server.js`). Direct: `target-operation-reconciliation-test.js` (applied side: no re-apply, no second receipt). Supporting (mutation shield, NOT a required owner): `suite-mutation-test.js` — registered `status: "excluded", reason: "mutation-tool"`, deliberately outside the checkpoint; it exists to prove the required suites' sensitivity to classifier/refusal regressions | Owner: never retransmit an unresolved governed request. Direct: `governed-pre-transport-restart-postgres-test.js` + `governed-post-transport-restart-postgres-test.js` (both crash points: one ordinal, one charge, no second transport) | Owner: exactly-once lifecycle, accepted operation never relaunched, closed terminal outcomes. Direct: `process-runtime-fault-recovery-test.js`. Supporting: `process-execution-runtime-test.js`, `process-launcher-foundation-deployment-test.js` |

Supporting workspace/admission context (all REQUIRED, indirect for the kernel):
`mutation-admission-contract-test.js`, `mutation-admission-scheduler-test.js`,
`mutation-admission-backpressure-test.js`. Required launcher/foundation ownership for the
process column: `process-launcher-foundation-{contract,cross-uid,deployment,native}-test.js`,
`process-materializer-{contract,cross-uid,deployment,linux,native}-test.js`,
`process-launcher-retention-test.js` (infrastructure beneath the I1/I3/I5 owners).

### Zero-delta implementation evidence

Independently recomputed from current history (2026-08-27): `git diff 0a947d1..HEAD
--name-only` contains ONLY `AGENTS.md` and four documentation files
(`docs/ARCHITECTURAL_DECISIONS_PENDING.md`, `docs/AUTHORITY_AND_DURABILITY.md`,
`docs/EVIDENCE_VS_TELEMETRY.md`, `docs/EXECUTION_SEMANTICS.md`); zero changed paths under
`server.js`, `runtime/`, `persistence/` (including migrations), `scripts/test-manifest.js`,
or `scripts/release-checkpoint.js`. Base identity `0a947d1272098604f102405b2a6943c3d24822a9`
is the published T5 implementation commit against which the register's T5 operational-closure
entry records canonical checkpoint evidence (253/253). That recorded T5 checkpoint evidence is
NOT claimed as T6 closure evidence; T6's own closure checkpoint is PENDING (below). No "T6
implementation commit" containing runtime code exists or is invented: this Phase-A publication
itself is the registered decision recognizing the already-existing implementation.

### Schema / migration / behavior delta

SCHEMA DELTA: NONE. MIGRATION: NONE. NEW TABLE/COLUMN/EVENT TYPE: NONE. BACKFILL: NONE.
RUNTIME BEHAVIOR CHANGE: NONE. PROVIDER CHANGE: NONE. PROCESS-LAUNCHER CHANGE: NONE.
WORKSPACE-TARGET CHANGE: NONE.

### Ordinary worker provider transport

The published classification record above governs: the ordinary/non-structured worker provider
transport (`callOpenAI` / `callOllama` via the ungoverned `selectRunProviderPath`) remains
OUTSIDE CURRENT T6 GOVERNANCE. It is therefore not part of the 15-cell implementation matrix.
The derivation is not repeated and not reopened.

### Residuals (nonblocking, carried for future reviewers)

- RESIDUAL 1 — workspace positive `not_applied` → safe re-execution has no dedicated
  end-to-end crash-injection suite. NONBLOCKING: the property is deterministically recoverable
  from the positive pre-state-match classifier, the required reconciliation verification, the
  classifier mutation shield, and the registered workspace recovery fact; no separate
  crash-injection suite is required for truthful closure.
- RESIDUAL 2 — "External effects (N)" presentation wording. NONBLOCKING PRESENTATION HYGIENE:
  the frozen record already states it means recorded evidence, not proof of effect occurrence.
  Presentation cannot become semantic authority (T6-I2).

Orphaned-test boundary: `event-chain-restart-test.js` remains registered
`orphaned/cutover-orphan` in `scripts/test-manifest.js` and is NOT a T6 closure dependency;
its relevant property has successor required ownership. Not repaired here.

### Frozen semantic nonchange

T6-I1 unchanged. T6-I2 unchanged. T6-I3 unchanged. T6-I4 unchanged. T6-I5 unchanged. Governed
membership rule unchanged. Governed surface list unchanged: 1. workspace target mutations;
2. governed provider requests; 3. process operations. Ordinary worker provider transport
classification unchanged. Browser v1 classification unchanged. Cross-Run boundary unchanged.
`external.effect` disposition unchanged. T2/T3/T4/T5 unchanged. This record adds
IMPLEMENTATION / VERIFICATION STATUS ONLY.

### Checkpoint status

CANONICAL CHECKPOINT FOR T6 OPERATIONAL CLOSURE: PENDING. It must be run only after (1) this
Phase-A candidate is independently reviewed, and (2) this exact reviewed Phase-A candidate is
published to authoritative `master`. No prior checkpoint evidence is claimed to close T6 and
no T6 checkpoint identity/hash/counts are claimed here.

### Cutover status

OPERATIONAL CUTOVER REQUIRED: NO. Phase A changes no runtime, schema, migration, provider
behavior, process behavior, workspace behavior, or DB state. This does not itself claim
operational closure.

### Implementation-complete claim scope

"IMPLEMENTATION COMPLETE" here means exactly: the frozen T6 invariants are realized by
existing governed-domain mechanisms, and repository-owned deterministic verification ownership
is now explicitly registered. It does NOT mean: new T6 runtime code was written; a checkpoint
has passed for T6 closure; operational closure is complete; the presentation residual is
fixed; or the ordinary worker provider transport was brought under T6.

### Hermeticity / cognitive-efficiency note

After publication, a fresh capable model can recover, without broad source rediscovery: frozen
semantics from the freeze entry; governed membership from the freeze; the ordinary worker
exclusion from the published classification record; and implementation realization plus
verification ownership from THIS record. No upstream record is duplicated; this record only
points. The register's cognitive-efficiency rule is honored: recovery burden is reduced by
indexing already-registered facts, not by deciding open questions in advance — no T6 semantic
question is decided here.
