'use strict';

// Tranche 5 — a test-only seam that fails ONE named durable write, once.
//
// WHY A DECORATOR AND NOT A PRODUCTION HOOK. The whole question this matrix
// asks is "what does production do when a required write does not commit". A
// branch in production that exists to answer it is a branch production can
// take, and the failure mode under test is precisely "it silently continued".
// So nothing here is reachable from production source: the real store object is
// wrapped, and `runGovernedLeafRequest` already accepts its repository as a
// parameter, so the decorated object arrives through the seam production
// itself uses to inject a repository.
//
// WHY NOT SHUT POSTGRESQL DOWN. Killing the database fails every write at once,
// which proves that a Run stops — not that it stops for the right reason, and
// not which write's absence caused it. These faults name exactly one method,
// and record what committed before and after, so a scenario can state the
// boundary rather than infer it.
//
// THREE MODES, because "the write failed" is three different situations:
//
//   before  — the statement never ran. Nothing committed. This models a
//             transaction that rolled back.
//   after   — the statement ran and COMMITTED, and the caller then failed.
//             This is the post-commit window, and it is the only one that can
//             produce a durable fact whose caller never learned about it.
//   replace — the method returns a caller-supplied value without touching the
//             database. For proving what a consumer does with a write that
//             reports success while persisting nothing.
//
// Every fault is armed for a bounded number of firings and records each one,
// so a scenario asserts the injection happened rather than assuming it.

const FAULT_CODE = 'TEST_REQUIRED_PERSISTENCE_FAILURE';

class InjectedPersistenceFailure extends Error {
  constructor(method, when) {
    super(`injected required-persistence failure at ${method} (${when})`);
    this.name = 'InjectedPersistenceFailure';
    this.code = FAULT_CODE;
    this.injectedMethod = method;
    this.injectedWhen = when;
  }
}

// Wrap `store` so that `method` fails. Every other method — and every property,
// including `pool` and `table` — passes straight through to the real store, so
// a scenario reads durable state through the same object it wrote it with.
//
//   method  the store method name to fault
//   when    'before' | 'after' | 'replace'
//   times   how many invocations to fault (default 1: the restart or retry
//           that follows must run against unmodified behaviour)
//   match   optional predicate on the call arguments; only matching calls are
//           faulted, so a shared method can be failed for one boundary without
//           breaking every other user of it
//   value   for 'replace': the value returned instead of calling through
function faultRepository(store, {
  method,
  when = 'before',
  times = 1,
  match = null,
  value = null
} = {}) {
  if (!method) throw new TypeError('a faulted method name is required');
  if (typeof store[method] !== 'function') {
    throw new TypeError(`the store has no method ${method} to fault`);
  }
  if (!['before', 'after', 'replace'].includes(when)) {
    throw new TypeError(`unsupported fault mode: ${when}`);
  }

  const firings = [];
  let remaining = times;

  const faulted = async function faultedMethod(...args) {
    const applies = remaining > 0 &&
      (typeof match !== 'function' || match(...args));
    if (!applies) return store[method](...args);
    remaining -= 1;

    if (when === 'replace') {
      firings.push({ when, args, committed: false });
      return typeof value === 'function' ? value(...args) : value;
    }
    if (when === 'before') {
      // Nothing ran. This is the rolled-back transaction.
      firings.push({ when, args, committed: false });
      throw new InjectedPersistenceFailure(method, when);
    }
    // 'after': the write COMMITTED and the caller then failed. The durable
    // fact exists and its caller never learned so.
    const result = await store[method](...args);
    firings.push({ when, args, committed: true, result });
    throw new InjectedPersistenceFailure(method, when);
  };

  const repository = new Proxy(store, {
    get(target, property, receiver) {
      if (property === method) return faulted;
      const resolved = Reflect.get(target, property, receiver);
      // Bind functions to the REAL store, never to the proxy. A method that
      // internally calls `this.someOtherMethod()` must reach the real one, or
      // the fault would leak into every call path that happens to share a
      // helper — and the scenario would no longer be naming one boundary.
      return typeof resolved === 'function' ? resolved.bind(target) : resolved;
    }
  });

  return {
    repository,
    // How many times the fault actually fired. A scenario asserts this: a
    // matcher that never matched would otherwise let the whole row pass
    // vacuously against completely healthy behaviour.
    get fired() { return firings.length; },
    get firings() { return firings.slice(); },
    // True when the faulted write COMMITTED before its caller failed.
    get committed() { return firings.some(entry => entry.committed); },
    disarm() { remaining = 0; }
  };
}

// ── Faulting a write a method makes on ITSELF ───────────────────────────────
//
// `faultRepository` deliberately binds pass-through methods to the real store,
// so a faulted method cannot leak into unrelated call paths that share a
// helper. That also means it cannot reach a write a store method performs
// internally — `terminalizeRun` calling `this.recordRunConsequence` is the case
// that matters, because those internal writes are exactly the ones sharing a
// transaction.
//
// So this shadows the method as an OWN property of the instance. `this.method`
// resolves the own property before the prototype, so the internal call is
// faulted, and `restore()` deletes the shadow to expose the prototype method
// again. Scoped to one store instance in one test process; the prototype is
// never modified.
function faultStoreMethod(store, {
  method, when = 'before', times = 1, match = null
} = {}) {
  if (typeof store[method] !== 'function') {
    throw new TypeError(`the store has no method ${method} to fault`);
  }
  if (Object.prototype.hasOwnProperty.call(store, method)) {
    throw new Error(`${method} is already faulted on this store instance`);
  }
  const real = store[method].bind(store);
  const firings = [];
  let remaining = times;

  store[method] = async function shadowedMethod(...args) {
    const applies = remaining > 0 &&
      (typeof match !== 'function' || match(...args));
    if (!applies) return real(...args);
    remaining -= 1;
    if (when === 'before') {
      firings.push({ when, args, committed: false });
      throw new InjectedPersistenceFailure(method, when);
    }
    const result = await real(...args);
    firings.push({ when, args, committed: true, result });
    throw new InjectedPersistenceFailure(method, when);
  };

  return {
    get fired() { return firings.length; },
    get firings() { return firings.slice(); },
    restore() { delete store[method]; }
  };
}

// Assert an error is the injected one and not some unrelated failure the
// scenario mistook for its own fault.
function isInjectedFailure(error) {
  return Boolean(error) && error.code === FAULT_CODE;
}

module.exports = {
  FAULT_CODE,
  InjectedPersistenceFailure,
  faultRepository,
  faultStoreMethod,
  isInjectedFailure
};
