'use strict';

const ACTIVE_RUNTIME_BACKEND = 'json';
const POSTGRES_BACKEND = 'postgres';

function resolveRuntimePersistenceBackend(env = process.env) {
  const requested = String(env.PERSISTENCE_BACKEND || ACTIVE_RUNTIME_BACKEND).trim().toLowerCase();
  if (requested === ACTIVE_RUNTIME_BACKEND) return ACTIVE_RUNTIME_BACKEND;
  if (requested === POSTGRES_BACKEND) {
    throw new Error(
      'PERSISTENCE_BACKEND=postgres is not yet an active server backend. ' +
      'Refusing a partial JSON/PostgreSQL authority; complete the cutover contract in ' +
      'docs/POSTGRES_CUTOVER.md before enabling it.'
    );
  }
  throw new Error(`Unsupported PERSISTENCE_BACKEND: ${requested || '(empty)'}`);
}

module.exports = {
  ACTIVE_RUNTIME_BACKEND,
  POSTGRES_BACKEND,
  resolveRuntimePersistenceBackend
};
