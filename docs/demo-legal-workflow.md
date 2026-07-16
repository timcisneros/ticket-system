# Legal Workflow Demo

This demo proves the current architecture path:

```txt
Ticket -> Agent -> Workflow Capability -> Actions -> Environment
```

It uses the existing workflow runner, actions catalog, replay, operation history, and recovery preview. It does not require a visual builder, new action type, policy layer, approval system, or new workflow engine feature.

## Prerequisites

- The app is running on `http://localhost:3000`.
- Admin login is available.
- Agent `Mike` exists and uses the local Ollama-backed model.
- Ollama is running and has Mike's configured model available.
- Workflow `Legal intake summary` exists. Startup seeds it as `legal-intake-summary` if missing.

## Workflow

Admin path:

```txt
/admin/workflows
```

Workflow name:

```txt
Legal intake summary
```

Workflow id:

```txt
legal-intake-summary
```

Action sequence:

```txt
agentStructuredOutput -> condition -> writeFile -> stop
```

The workflow extracts:

```txt
clientName
matterType
urgency
summary
recommendedNextStep
```

If `urgency == "high"`, it writes:

```txt
urgent-case-summary.md
```

Otherwise it writes:

```txt
case-summary.md
```

## Manual Demo

1. Open `http://localhost:3000`.
2. Create a new ticket.
3. Set `Execution Path` to `Workflow`.
4. Select `Legal intake summary`.
5. Assign the ticket to `Mike`.
6. Use this input JSON:

```json
{
  "intakeText": "Client name: Jordan Lee. Matter type: landlord tenant emergency. Jordan received a lockout notice and says the landlord changed the locks this morning. There is a court filing deadline tomorrow at 9 AM and Jordan needs urgent help getting access restored. Please summarize the matter and recommend the next step."
}
```

7. Submit the ticket and wait for completion.
8. Inspect the output file in the workspace.
9. Open the run detail page and inspect replay/debug sections.

Expected replay evidence:

```txt
capabilitySelection
workflowActions: agentStructuredOutput
workflowActions: condition
workflowActions: writeFile
workflowActions: stop
capabilityOutputs
workspaceOperations: writeFile
```

Expected operation history:

```txt
writeFile urgent-case-summary.md
```

Expected recovery preview:

```txt
deletePath urgent-case-summary.md
```

## Scripted Demo

With the app already running:

```bash
pnpm run demo:legal-workflow
```

The script logs in, saves the workflow JSON through the admin route, creates a Mike workflow ticket, waits for the run, and prints:

- ticket id
- run id
- output path
- extracted fields
- replay action sequence
- operation history id
- recovery preview action

Environment overrides:

```bash
BASE_URL=http://localhost:3000 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 pnpm run demo:legal-workflow
```

The demo intentionally uses the real local model path. If Mike/Ollama returns malformed JSON or is unavailable, the run should fail with replay and failure summary evidence rather than silently succeeding.
