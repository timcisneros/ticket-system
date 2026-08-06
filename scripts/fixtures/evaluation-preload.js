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

// ── 0. THE SHARED OBSERVATION SINK, installed FIRST ────────────────────────
//
// Both transport adapters and the real read seam write through this one sink,
// so a governed request, an ungoverned request and an actual file read are all
// described in the same per-trial streams. Installing it before anything else
// means the marker exists for the whole trial — which is what lets an empty
// stream be read as "nothing happened" rather than "nobody was watching".
const DESCRIPTOR_JSON = process.env.EVALUATION_OBSERVATION_DESCRIPTOR || null;
if (DESCRIPTOR_JSON) {
  const {
    createObservationSink, markSinkInstalled, hashBytes
  } = require(path.join(__dirname, 'evaluation-observation-sink.js'));
  const descriptor = markSinkInstalled(JSON.parse(DESCRIPTOR_JSON));
  const sink = createObservationSink(descriptor);
  globalThis.__EVALUATION_OBSERVATION_SINK__ = sink;

  // ── THE REAL READ SEAM ──────────────────────────────────────────────
  //
  // The workspace provider is built inside `server.js` from a function defined
  // in that same file, so a `--require` preload cannot wrap it: the preload
  // runs first. The narrowest seam that still observes the ACTUAL read is the
  // `fs` call the provider makes, wrapped here and scoped hard:
  //
  //   * only paths inside this trial's workspace root;
  //   * only after the real read RETURNS — a throw is re-thrown untouched and
  //     records nothing, because a failed read is not an access;
  //   * the exact returned value is hashed and then handed back UNCHANGED.
  //
  // It fabricates nothing, pre-reads nothing, widens no authorization and
  // suppresses no error. It cannot run outside a trial: without the descriptor
  // environment value this whole block is skipped.
  const WORKSPACE_ROOT = process.env.EVALUATION_OBSERVED_WORKSPACE_ROOT || null;
  if (WORKSPACE_ROOT) {
    const nodeFs = require('node:fs');
    const nodePath = require('node:path');
    const realReadFileSync = nodeFs.readFileSync;
    const observedRoot = nodePath.resolve(WORKSPACE_ROOT);
    nodeFs.readFileSync = function observedReadFileSync(target, ...rest) {
      // The real call first. Its result and its errors are authoritative.
      const value = realReadFileSync.call(this, target, ...rest);
      try {
        if (typeof target === 'string') {
          const resolved = nodePath.resolve(target);
          if (resolved === observedRoot ||
              resolved.startsWith(`${observedRoot}${nodePath.sep}`)) {
            sink.recordConsumerRead({
              readerTaskId: null,
              requestedPath: nodePath.relative(observedRoot, resolved),
              returnedBytes: value
            });
          }
        }
      } catch (_) {
        // An observation must never change what production returns, including
        // by failing. A sink write that cannot happen is a lost observation,
        // and the completeness contract is what reports that — not an
        // exception thrown into the middle of a workspace read.
      }
      return value;
    };
  }
}

// 1. The existing hermetic boundary, including the governed injection seam.
require(path.join(__dirname, 'hermetic-governed-transport-preload.js'));

// 1b. DIAGNOSTIC CAPTURE for leaf admission, opt-in and test-only.
//
// `server.js` maps every unexpected leaf-admission exception to
// `leaf_admission_conflict` and renders the vocabulary message rather than
// `error.message`, so the real cause reaches neither durable state nor stdout.
// This wrapper observes the canonical store method BELOW that catch-all and
// prints sanitized facts — constructor, code, SQLSTATE, message, cause chain
// and the immediate stack owner. It rethrows unchanged, so production
// behaviour is identical whether or not it is enabled.
if (process.env.EVALUATION_CAPTURE_LEAF_ADMISSION === '1') {
  const storePath = path.join(__dirname, '..', '..', 'persistence', 'postgres', 'store.js');
  const { PostgresRuntimeStore } = require(storePath);
  const real = PostgresRuntimeStore.prototype.admitStructuredAllocationLeafRuns;
  PostgresRuntimeStore.prototype.admitStructuredAllocationLeafRuns =
    async function capturedAdmit(...args) {
      try {
        return await real.apply(this, args);
      } catch (error) {
        const chain = [];
        for (let current = error; current; current = current.cause) {
          chain.push({
            name: current.name || null,
            code: current.code || null,
            // PostgreSQL SQLSTATE when the driver supplies one.
            sqlstate: current.severity ? current.code : null,
            constraint: current.constraint || null,
            table: current.table || null,
            column: current.column || null,
            detail: current.detail || null,
            message: String(current.message || '').slice(0, 400),
            at: String((current.stack || '').split('\n')[1] || '').trim()
          });
          if (chain.length > 4) break;
        }
        console.error('LEAF_ADMISSION_RAW_ERROR ' + JSON.stringify(chain));
        throw error;
      }
    };
}

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
