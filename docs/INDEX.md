# Documentation Index

## Living current guidance

- [`../README.md`](../README.md) — architecture, startup, and verification.
- [`SETUP_AND_FIRST_RUN.md`](SETUP_AND_FIRST_RUN.md) — environment and first run.
- [`SYSTEM_STATUS.md`](SYSTEM_STATUS.md) — implemented guarantees and remaining productization work.
- [`POSTGRES_CUTOVER.md`](POSTGRES_CUTOVER.md) — current PostgreSQL authority/coordination contract.
- [`PRIMITIVE_GLOSSARY.md`](PRIMITIVE_GLOSSARY.md) — runtime terminology.
- [`OPERATIONAL_TRANSPARENCY.md`](OPERATIONAL_TRANSPARENCY.md) — read-only operational surfaces.
- [`OPERATOR_INBOX.md`](OPERATOR_INBOX.md) and [`BROWSER_ENVIRONMENT.md`](BROWSER_ENVIRONMENT.md) —
  active product surfaces maintained with their implementations.

These stable documents are updated when implementation changes. A fresh release checkpoint, not a
document, is verification authority.

## Historical and design reference

Other documents in this directory include point-in-time audits, experiments, milestones, release
notes, design proposals, and JSON-runtime operating notes. Their original claims are preserved as
historical evidence and are not silently refreshed into current facts. A historical document may
still explain intent, but it does not override the living documents above or active code.

Retired JSON implementation and its directly coupled tests are under
[`../ARCHIVE/legacy-json-runtime/`](../ARCHIVE/legacy-json-runtime/). Frozen evidence corpora and
other explicitly archived investigations remain under [`../ARCHIVE/`](../ARCHIVE/).
