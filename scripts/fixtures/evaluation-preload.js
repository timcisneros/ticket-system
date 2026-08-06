'use strict';

// Tranche 6 — the single preload a spawned evaluation server loads.
//
// It composes the two existing hermetic seams rather than adding a third:
//
//   1. `hermetic-governed-transport-preload` — injects the governed transport's
//      documented `httpsRequest` seam (arms B and C) and guards
//      `http.request`, `https.request` and `fetch` against any non-localhost
//      host;
//   2. `evaluation-fetch-fixture` — serves the ungoverned `callOpenAI` path
//      (arms A, A2a, A2b) from the SAME staged response table.
//
// Order matters and is deliberate. The hermetic preload runs first so its
// guard is in place, then the fetch fixture replaces `globalThis.fetch` with a
// router that still refuses every host it does not recognize. A replacement
// that widened access would defeat the guard it was installed behind; this one
// narrows it, because unrecognized hosts and unmatched requests both refuse.
//
// TEST-ONLY. Production source is unchanged and reads none of the environment
// variables below. The spawned server loads this through `NODE_OPTIONS`.

const path = require('node:path');

const NAMESPACE_DIR = process.env.EVALUATION_FIXTURE_NAMESPACE || null;

// 1. The existing hermetic boundary, including the governed injection seam.
require(path.join(__dirname, 'hermetic-governed-transport-preload.js'));

// 2. The ungoverned fetch route, pointed at the same staged table.
if (NAMESPACE_DIR) {
  const {
    installEvaluationFetchFixture
  } = require(path.join(__dirname, 'evaluation-fetch-fixture.js'));
  installEvaluationFetchFixture({ namespaceDir: NAMESPACE_DIR });
  console.log(`EVALUATION_FETCH_FIXTURE_ACTIVE=${path.basename(NAMESPACE_DIR)}`);
} else {
  console.log('EVALUATION_FETCH_FIXTURE_ACTIVE=none');
}
