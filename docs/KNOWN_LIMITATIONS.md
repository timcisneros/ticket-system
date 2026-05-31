# Known Limitations

## Local gemma3:latest Latency

Local `gemma3:latest` latency is dominated by prompt evaluation cost, not runtime orchestration. Runtime-loop changes should not be assumed to materially improve ordinary-ticket latency without new evidence.

## Workflow Draft Intent Shape

`createWorkflowDraftIntent` supports flat write workflows only. Branching or conditional workflow generation is outside this capability.
