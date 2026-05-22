# Operational Pressures

Recurring human/operator friction observed during real use.

This file is append-only in spirit. It records concrete pressure, not
architecture, planning, orchestration, or speculative fixes.

## Observations

- Path ambiguity caused no-op or failed runs when agents used paths outside the intended project directory.

- Ambiguous `(no output)` command results caused operator uncertainty during repeated polling.

- Text output like `[ERROR] ... PASSED` confused rule severity with rule result state.

- Protected paths forced workaround workflows, such as documenting direct test commands or adding wrapper scripts instead of editing `package.json`.

- Operators are tempted to bypass the pipeline when blocked by protected paths, missing mutation surfaces, or repeated repair loops.

- Over-inspection caused no-progress failures when agents spent the available run budget listing or reading instead of mutating.

- Repair tickets became necessary after partial mutations because direct silent fixes would contaminate provenance.

- Failed read actions on nonexistent paths sometimes appeared in human summaries as if the intended path had been inspected successfully.

- Runs with partial mutations required comparing replay, mutation history, and current workspace state to understand what actually changed.

- A completed or failed ticket status alone was not enough to know whether useful mutations occurred.

- Derived ticket and run summaries sometimes hid the distinction between proposed actions, executed actions, and blocked actions.

- Repair tickets preserved provenance, but also made it harder to see the original defect without inspecting the earlier failed run.

- Current workspace state could make a feature appear complete even when the canonical run status was failed.

- No-op creates and failed reads needed mutation/history inspection to distinguish harmless existing state from missing work.

- Direct verification commands were necessary to separate observed behavior from inferred behavior after agent runs.

- Documentation generated from intended feature meaning could overstate implementation semantics; T169 described severity as changing pass/fail behavior, while source inspection showed severity was only metadata until T170 repaired the docs.

- During T172 through T174, repeated `runs` polling showed a running state with no new steps while raw logs already contained the pending model request boundary and later completion events; operators needed raw logs plus refreshed run state to distinguish stalled work from delayed derived status.

- T171 failed with zero mutations after only LIST/READ actions; the absence of mutations was materially different from a failed mutation and required checking failure context plus mutation history before creating a replacement ticket.

- T172 implemented the requested feature, but its generated test asserted an inferred output shape instead of the actual reporter contract; the failing test exposed drift between intended behavior and source-backed behavior.

- T173 repaired the test using another derived interpretation of the text report, but missed summary count lines; a second repair ticket was needed because the repair narrative still did not match actual CLI output.

- Direct CLI verification after T174 was necessary to establish observed behavior: `--failures-only` preserved full evaluation while displaying zero rule rows for an all-passing project.

- T175 targeted ticketing-system source (`scripts/oquery.js`), but the agent workspace could not see the `scripts` directory and completed with zero mutations; this exposed the intended boundary that app source is outside agent authority and source changes are developer-side product work.

- T175 produced `run:completed_noop` and `run:completed` rather than a failure, even though the requested product improvement was not executed; operators had to inspect raw logs to distinguish completed no-op from completed work.

- R179's runtime envelope made the authority boundary explicit: `workspaceRoot` and `mainWorkspaceRoot` were `ticket-system/workspace-root`, so repository-root product files such as `scripts/oquery.js` were correctly outside the agent's operational world.

- R179 replay exposed `mutation count 0` and `outcome no_mutations`, while ticket/run status still read `completed`; the canonical evidence existed, but the status surface compressed distinct outcomes together.

- A task can be impossible within the current authority boundary even when the model can state that clearly and set `complete:true`; `impossible_within_boundary` is expected security behavior for source-code attempts or other paths outside the mounted workspace, while current completion semantics still need to distinguish impossible-but-reported from successfully-executed.

- In R92 and R133, replay displayed all model-proposed actions for the failing step, while mutation history showed only the actions actually recorded before the protected-path rejection stopped execution; operators had to compare replay with mutation history to avoid treating proposed later writes as executed.

- The `failures` view uses `OK` in the "model response had action(s)" section to mean the model action was structurally valid, not that it executed successfully; in R6 and R34 this could be mistaken for successful execution even though the run failed before later proposed actions were recorded.

- The term `outcome` currently refers to different semantic layers across views: runs/tickets use it for operational outcome, while replay uses it for mutation outcome; no evidence yet shows wrong operator decisions, but the shared term could compress meaning during interpretation.
