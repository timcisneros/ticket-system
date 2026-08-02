'use strict';

// Proof-of-life probe for the test-server startup contract.
//
// Loaded through `NODE_OPTIONS=--require`, so it runs inside the spawned server
// before server.js. It reports only what the harness contract test needs to
// distinguish "the environment actually arrived" from "the server started and
// nobody checked" — the failure mode that let a hermetic preload sit unloaded
// through a whole session of green suites.
//
// NO CREDENTIAL VALUE IS EVER PRINTED. Whether a key is present is a boolean;
// the value is never read into the output stream, because the point of the
// stripping this verifies is that the value must not travel.

const marker = process.env.HARNESS_PROBE_MARKER || '';

console.log('HARNESS_PROBE_ACTIVE=true');
console.log(`HARNESS_PROBE_MARKER=${marker}`);
console.log(`HARNESS_PROBE_OPENAI_KEY_PRESENT=${'OPENAI_API_KEY' in process.env}`);
console.log(`HARNESS_PROBE_OPENAI_ORG_PRESENT=${'OPENAI_ORG_ID' in process.env}`);
console.log(`HARNESS_PROBE_OPENAI_PROJECT_PRESENT=${'OPENAI_PROJECT_ID' in process.env}`);

// If the argument shape were nested one level too deep the child would receive a
// variable literally named `env`. Reporting it turns that specific mistake into
// an observable symptom rather than a silent absence of NODE_OPTIONS.
console.log(`HARNESS_PROBE_NESTED_ENV_PRESENT=${'env' in process.env}`);
