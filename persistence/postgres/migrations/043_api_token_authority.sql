-- API-token credential authority (P1 GOVERNED PROGRAMMATIC ACCESS).
--
-- Durable registration of the design freeze recorded in
-- docs/ARCHITECTURAL_DECISIONS_PENDING.md ("P1 GOVERNED PROGRAMMATIC ACCESS —
-- accepted design freeze"). One credential kind only: bearer tokens for
-- EXISTING access_users. No new principal class, no service accounts, no
-- cross-user issuance, no delegation, no scopes, no expiry, no last-used
-- tracking, no active-token cap, and no IP/user-agent metadata. Only the
-- SHA-256 hex digest of the complete presented token is ever persisted; the
-- raw token is returned exactly once at issuance and never stored.
--
-- LOCKSTEP (freeze section 2): `access_permissions` is migration-owned (the
-- 019 trigger rejects all non-migration writes) and the repository builtin
-- floor now expects `apiToken:manage`, so the canonical permission row is
-- inserted here under the established migration-time trigger-suppression
-- pattern (the ALTER TABLE ... DISABLE/ENABLE TRIGGER pattern used by
-- 039_ticket_attempt_authority.sql).

CREATE TABLE api_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_fk BIGINT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT api_tokens_user_fk FOREIGN KEY (user_fk)
    REFERENCES access_users(id) ON DELETE CASCADE,
  -- Digest uniqueness covers revoked rows too: one presented token maps to at
  -- most one credential for all time, so find-active-by-digest is total.
  CONSTRAINT api_tokens_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT api_tokens_token_hash_shape
    CHECK (length(btrim(token_hash)) = 64 AND token_hash = btrim(token_hash) AND token_hash ~ '^[0-9a-f]{64}$'),
  -- Labels are trimmed, non-empty, and at most 128 characters.
  CONSTRAINT api_tokens_label_shape
    CHECK (length(btrim(label)) > 0 AND length(label) <= 128 AND label = btrim(label)),
  CONSTRAINT api_tokens_revocation_shape CHECK (
    (revoked_at IS NULL) OR (revoked_at IS NOT NULL)
  )
);

-- Ownership listing is by user; the digest lookup uses the unique constraint
-- above. No expiry/last-used/metadata columns exist by design.
CREATE INDEX api_tokens_user_fk_id_idx ON api_tokens (user_fk, id);

-- Revoke-once integrity: the ONLY permitted mutation is `revoked_at
-- NULL -> timestamp`, exactly once, with every identity field immutable. This
-- prevents resurrection, re-labeling, re-owning, or digest substitution.
-- Deletion is deliberately NOT blocked: the user FK cascades and a deleted
-- user's credentials must vanish with the account.
CREATE FUNCTION enforce_api_token_revoke_once() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'API token revocation is permanent';
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_fk <> OLD.user_fk OR
     NEW.token_hash <> OLD.token_hash OR NEW.label <> OLD.label OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'API token identity fields are immutable';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'API token updates are reserved for permanent revocation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER api_tokens_revoke_once
BEFORE UPDATE ON api_tokens
FOR EACH ROW EXECUTE FUNCTION enforce_api_token_revoke_once();

COMMENT ON TABLE api_tokens IS
  'Bearer credentials for EXISTING access_users (P1 governed programmatic access). Stores the SHA-256 hex digest of the complete presented token only; revocation is permanent; deletion follows the owning user via cascade.';

-- Canonical permission-catalog row for the token-management builtin floor.
-- apiToken:manage means EXACTLY: issue, list, and revoke API tokens belonging
-- to the CURRENT authenticated user. It confers no ticket, run, or product
-- authority. Suppression is migration authority only and is restored within
-- this same transaction.
ALTER TABLE access_permissions DISABLE TRIGGER access_permissions_migration_owned;

INSERT INTO access_permissions (name) VALUES
  ('apiToken:manage');

ALTER TABLE access_permissions ENABLE TRIGGER access_permissions_migration_owned;
