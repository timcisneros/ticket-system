# Architectural Decisions Pending

## Workspace Operation Error Handling

| Field | Value |
|-------|-------|
| **Status** | Unresolved inconsistency |
| **Documentation** | Recoverable |
| **Implementation** | Terminal |
| **Evidence** | See `docs/archive/DOCUMENTATION_IMPLEMENTATION_DIVERGENCE.md` |
| **Decision required** | Which behavior is authoritative? |

**Description:**

The documentation (`OPERATIONS.md`, `STATE_SURFACES.md`) claims that workspace operation failures are recoverable feedback returned to the model. The implementation (`server.js`) treats all filesystem errors (except `listDirectory` ENOENT) as terminal failures that immediately end the run. Both behaviors have co-existed since the initial commit on 2026-05-19. No reconciliation has occurred.

---

*Recorded 2026-05-28.*
