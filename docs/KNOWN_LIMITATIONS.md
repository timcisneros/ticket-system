# Known Limitations

## Internal Demo Baseline

The `v0.1.0-internal-demo` baseline is intended for local internal/demo use. It
is not production security hardened, multi-user/hosted deployment ready, final
UX, an RL/training system, or a general verifier for all domains.

## JSON Local Store

The app uses a single-process JSON file store. This is suitable for the current
local substrate and deterministic regression harnesses, but it is not a hosted
database, migration system, backup system, or multi-process coordination layer.

Tracked `data/*.json` files are baseline/demo seed data. Local demo/dev state
should normally live in ignored `.local-data/` with workspace mutations in
ignored `.local-workspace/`.

## Single-Process Assumptions

Runtime execution assumes one server process owns the selected `DATA_DIR`.
Writer-lock checks help avoid accidental concurrent writers, but this is not a
distributed lock or production concurrency design.

## Provider Keys and Secrets

Provider keys and local secrets are user-managed. `.env`, `.env.local`, and
`.env.test.local` are ignored by Git. Do not commit API keys, local provider
credentials, or demo-only bootstrap secrets.

Tracked seed agents do not contain provider API keys. Configure provider keys
through ignored env files, shell environment, or the local Admin UI. If a real
provider key was ever committed in historical data, revoke it at the provider;
this repository does not rewrite release history.

## Local gemma3:latest Latency

Local `gemma3:latest` latency is dominated by prompt evaluation cost, not runtime orchestration. Runtime-loop changes should not be assumed to materially improve ordinary-ticket latency without new evidence.

Slow local Ollama runs may time out while waiting for model output. Treat those
as latency/provider observations unless replay, events, logs, or operation
history show a runtime correctness issue.

## Verification and Postconditions

Postcondition and verifier behavior is bounded to implemented deterministic
cases and current regression coverage. Passing checks do not prove arbitrary
task correctness or complete domain verification.

## Workflow Draft Intent Shape

`createWorkflowDraftIntent` supports flat write workflows only. Branching or conditional workflow generation is outside this capability.

## Demo Fixtures

Demo fixtures and tracked seed data are not final business data. They exist to
exercise the ticket, workflow, evidence, replay, and UI surfaces during local
validation.

## Debug Reset

Admin debug reset is a destructive local demo/dev reset. It is disabled in
`production` mode and is not a production recovery mechanism. It clears local
ticket/run execution state and workspace reset surfaces so reused ticket/run IDs
do not attach stale evidence, while preserving auth/config/product state such as
users, groups, permissions, agents, workflows, provider configuration, ignored
env files, and secrets.
