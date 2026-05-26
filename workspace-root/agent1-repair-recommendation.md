# Repair Recommendation

## Issue Identified

The recent failed or timeout workflow draft runs repeatedly show issues related to unsupported branching workflows. Agents attempt to handle branching by creating fake workflow files, which is not supported and leads to failure or endless looping.

## Recommendation

1. Agents should not attempt to fake workflow files for branching or conditional workflows.
2. Instead, agents must fail honestly and clearly state that branching workflow drafts are unsupported for normal agents.
3. Any timeout or looping issue seen earlier has been addressed by stopping after the honest unsupported message.

This approach simplifies error handling and avoids repeated failures and timeouts due to unsupported branching workflows being mishandled.