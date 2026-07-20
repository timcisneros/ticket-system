'use strict';

const ACTIVE_RUNTIME_BACKEND = 'postgres';

function resolveRuntimePersistenceBackend(env = process.env) {
  const requested = String(env.PERSISTENCE_BACKEND || ACTIVE_RUNTIME_BACKEND).trim().toLowerCase();
  if (requested === ACTIVE_RUNTIME_BACKEND) return ACTIVE_RUNTIME_BACKEND;
  throw new Error(
    `Unsupported PERSISTENCE_BACKEND: ${requested || '(empty)'}. ` +
    'The runtime is PostgreSQL-only; JSON development stores are not a server backend.'
  );
}

module.exports = { ACTIVE_RUNTIME_BACKEND, resolveRuntimePersistenceBackend };
