# Process-execution release compatibility

The process-execution release contract is the machine-readable compatibility
authority. This matrix describes release contract version 1 for application 1.1.1.
No pairing not listed here is supported.

| Authority | Supported | Read-only compatible | Upgrade required | Unsupported |
| --- | --- | --- | --- | --- |
| PostgreSQL schema | 42 | none | older schema | future or partial schema |
| Launcher protocol | 1 | 1 for recovery/observation | none | every other version |
| Materializer protocol | 1 | 1 for recovery/observation | none | every other version |
| Process target catalog | 2 | historical catalog embedded in admitted runs | catalog 1 for new admission | future versions |
| Rootfs registry | 1 | retained admitted rootfs generations | replacement installs a new generation | unverified/future schema |
| Runtime budget snapshot | 1 | runs with explicit historical compatibility | missing snapshot for new admission | future versions |
| Completion authority | 1 | explicitly labelled historical runs | missing current authority | future versions |
| Completion decision | 1 | explicitly labelled historical runs | missing current decision | future versions |
| Process supervision | 1 | explicitly labelled historical lifecycle | missing current lifecycle | future versions |
| Process operation record | schema 029 | terminal records retained under schema 42 | schema below 42 | future/unknown migrations |

## Deployment generation policy

Mixed-version runtime generations are unsupported. Upgrades are quiesced:

1. Disable new process admission with
   `npm run release:admission -- --disable --actor release-operator --reason upgrade`.
2. Drain or cancel active work and confirm release health has no active,
   finalizing, cancellation-pending, or reconciliation-failed process operation.
3. Stop every old runtime instance.
4. Run `npm run release:db-preflight`, take the paired database/artifact backup,
   then run `npm run release:db-migrate`.
5. Install the matching application, launcher, materializer, rootfs, seccomp
   policy, units, and tmpfiles configuration from one release manifest.
6. Start native services and the runtime with admission still disabled.
7. Validate readiness and the bounded canary before enabling admission.

The durable admission row is bound to the application version, source revision,
and release-contract hash. A mismatched active generation is `blocked`, not a
rolling-compatibility guess.

Application-only rollback is permitted only when the previous release contract
supports schema 42. Otherwise rollback means an explicit database and paired
artifact restore; the system never runs reverse SQL or silently downgrades a
schema.
