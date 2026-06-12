# ARCHIVE — Evidence Bundles

Frozen investigation evidence (data + harness scripts + reports), preserved verbatim
for provenance. Nothing here is executed by the running system. Scripts inside these
bundles may reference repo-root paths and are not expected to run from this location.

For archived *documentation* (closed investigations, superseded plans), see
`docs/archive/` instead.

## TM-ST-INVESTIGATIONS/

Evidence corpus from the TM (terminal-mismatch / truncation) and ST investigation
tracks: collected event data (`data/`), the collection/replay harnesses (`scripts/`),
and the resulting reports (`docs/`), including the mutating-limit-3 replay results
that informed the `ENABLE_PREFIX_TRUNCATION` feature (see AGENTS.md "Current Known
Reality"). The still-active TM-3 validation harness remains at
`scripts/tm3-replay-validation.js` (`npm run validate:truncation`).

## backup-vendors-040/

Frozen vendor fixture files (`vendor-030.md` … `vendor-040.md`) and the
`fixture-manifest.json` snapshot backing the vendor-compliance investigation runs
recorded in the root evidence corpus (`evidence-ledger.md`,
`failure-cluster-report.md`).
