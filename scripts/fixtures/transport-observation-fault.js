'use strict';

// TEST-ONLY — a failure at the exact point the durable transport observation is
// written.
//
// WHY IT EXISTS. `provider.transport_invoked` is evidence, not execution
// authority, and the property that makes that true is negative: a failure to
// record it must change NOTHING about the provider request it observes. A
// negative property cannot be proved by watching the happy path — it needs the
// failure to actually happen, at the place it would really happen.
//
// WHY HERE AND NOT IN PRODUCTION SOURCE. The seam under test is exactly the one
// where "it silently continued" would be the defect, so production must have no
// branch for this at all. The fault decorates `PostgresRuntimeStore.prototype`
// from a preload, before server.js requires it — the same discipline the
// governed fault injector uses — and production defaults are untouched.
//
// It is deliberately blunt: every write fails, for the whole process. A suite
// that arms it is asking "what does a Run look like when this evidence never
// lands", and the answer must be "exactly like one where it did, minus the
// evidence".

const fs = require('node:fs');

const FAULT_ENV = 'LIVE_PROVIDER_TRANSPORT_OBSERVATION_FAULT';
const MARKER_ENV = 'LIVE_PROVIDER_TRANSPORT_OBSERVATION_FAULT_MARKER';

function armTransportObservationFaultIfRequested() {
  if (process.env[FAULT_ENV] !== '1') return false;
  // Required lazily: a preload that never arms the fault must not drag the
  // whole persistence layer into memory before server.js configures it.
  // eslint-disable-next-line global-require
  const { PostgresRuntimeStore } = require('../../persistence/postgres/store');
  const marker = process.env[MARKER_ENV] || null;
  PostgresRuntimeStore.prototype.recordProviderTransportInvocation =
    async function refuseTransportObservation() {
      if (marker) fs.appendFileSync(marker, 'observation_write_refused\n');
      const error = new Error(
        'injected failure: the provider transport observation could not be written');
      error.code = 'INJECTED_TRANSPORT_OBSERVATION_WRITE_FAILURE';
      throw error;
    };
  console.log('LIVE_PROVIDER_TRANSPORT_OBSERVATION_FAULT_ARMED');
  return true;
}

module.exports = { FAULT_ENV, MARKER_ENV, armTransportObservationFaultIfRequested };
