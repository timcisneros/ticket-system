-- P4-R2 (Browser Phase-2 Safe Interaction) — canonical permission registration.
--
-- The published P4 design freeze (docs/ARCHITECTURAL_DECISIONS_PENDING.md,
-- "P4 — GOVERNED SURFACE EXPANSION", section 9) authorizes exactly this
-- narrow migration: registering the new canonical browser-interaction access
-- permission through the repository's migration-owned access-permission
-- lifecycle. `browser:interact` means EXACTLY: create or configure tickets
-- whose execution policy authorizes bounded browser interaction
-- (click/fill/press). It is distinct from the manual operator-browser
-- `browser:read` / `browser:operate` permissions, confers no browser-target
-- management, no Phase-3 authority (downloads, persistent sessions,
-- credential stores), and no run-loop bypass.
--
-- LOCKSTEP (P4 freeze section 9; precedent: migration 043
-- `apiToken:manage`): `access_permissions` is migration-owned (the 019
-- trigger rejects all non-migration writes) and the repository builtin
-- floor in persistence/access-catalog.js now expects `browser:interact`,
-- so the canonical permission row is inserted here under the established
-- migration-time trigger-suppression pattern (the ALTER TABLE ...
-- DISABLE/ENABLE TRIGGER pattern used by 039/043). No other schema or
-- permission change is part of P4-R2.

-- Canonical permission-catalog row for the browser-interaction builtin
-- floor. Suppression is migration authority only and is restored within
-- this same transaction.
ALTER TABLE access_permissions DISABLE TRIGGER access_permissions_migration_owned;

INSERT INTO access_permissions (name) VALUES
  ('browser:interact');

ALTER TABLE access_permissions ENABLE TRIGGER access_permissions_migration_owned;
