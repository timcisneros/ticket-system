# Browser Environment (Operator)

The Browser environment at `/browser` is the operator-driven counterpart of the run-side Phase 1 browser boundary described in `docs/BROWSER_TARGET_DESIGN.md`. It lives in the nav under **Environments** next to Workspace; environments share that menu and future environments should be added there.

## Boundary

Same Phase 1 contract as agent browser runs — no widening:

- Operations: `navigate`, `observe`, `readPageText`, `screenshot`, `wait` only.
- Sessions run against one **active browser target**; the target's exact-origin allowlist is enforced by the engine (`runtime/browser-engine.js`) on every request, including subresources.
- The target's per-run limits apply per operator session: `maxActionsPerRun`, `maxNavigationsPerRun`, `maxScreenshotsPerRun`, `navTimeoutMs`, `waitTimeoutMsCap`, `maxPageTextBytes`.
- One session per operator user; operations are serialized (409 `BROWSER_SESSION_BUSY` on overlap); sessions auto-close after 10 minutes idle and on server shutdown.
- Engine availability comes from `BROWSER_ENGINE_EXECUTABLE` (an executable Chromium) plus `playwright-core`; the page shows engine status.

## Permissions

- `browser:read` — view the page/engine status/session state.
- `browser:operate` — open/close sessions and execute operations.

## Audit

Mirrors `workspace:operator_mutation`: every session transition and operation lands in the system log —

- `browser:operator_session_opened` / `browser:operator_session_closed` (with reason and counters),
- `browser:operator_operation` with pre/post page state (redacted URL + title hash), a receipt (hashes, redacted URLs, duration, error codes), and `requestedBy`.

Screenshots persist under `ARTIFACT_ROOT/browser/<sessionId>/` with SHA-256 in the receipt; the base64 preview returned to the UI is never logged. URLs in evidence are always redacted (`redactBrowserUrl`: credentials stripped, query values replaced, fragment dropped).

## Routes

- `GET /browser` — page (browser.ejs).
- `GET/POST/DELETE /api/browser/session` — session state / open `{targetId}` / close.
- `POST /api/browser/operation` — `{ operation, args }`.

## CSRF / Referrer-Policy interaction (login lockout postmortem)

The app once sent `Referrer-Policy: no-referrer`. Under that policy Chromium serializes `Origin: null` even on same-origin form POSTs, and the CSRF gate (`requestOriginAllowed`) rejected every browser login with 403 "Request origin is not allowed". Fixed 2026-07-16:

- The security-header hook sends `Referrer-Policy: same-origin` (still leaks nothing cross-origin, keeps Origin real on same-origin posts).
- `requestOriginAllowed` accepts a literal `null` Origin only when the browser-controlled `Sec-Fetch-Site: same-origin` header vouches for the request. Cross-site posts still 403; web content cannot forge Sec-Fetch-Site.

Consequences for browser-driven tests: drive the login form directly — no cookie-injection or Origin-rewriting workarounds are needed. If the 403 ever reappears, suspect a proxy/browser stripping `Sec-Fetch-Site` while forcing no-referrer, or a `PUBLIC_BASE_URL` that does not match the origin actually being browsed.

## Tests

- `pnpm run test:browser-environment` (`scripts/browser-environment-test.js`) — end-to-end operator flow: target creation, session lifecycle, all five operations, origin blocking, limit capping, audit assertions. Skips live-engine checks when no Chromium is available (same detection as `scripts/browser-target-regression-test.js`).
