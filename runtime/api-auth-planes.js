'use strict';

// The ONE repository-owned authentication-plane classifier (P1 governed
// programmatic access, docs/ARCHITECTURAL_DECISIONS_PENDING.md, "P1 ... design
// freeze", section 7). Server routing, operator HTML behavior, and every
// classification assertion in the registered test suites read this single
// definition so no route can quietly drift onto or off of a plane.
//
// Planes:
//   BEARER_ELIGIBLE_API — authenticated API product routes. A present
//     Authorization header owns authentication (no session fallback); an
//     absent header leaves the existing session path available.
//   SESSION_ONLY_API — the API-token credential-management namespace. Bearer
//     is NOT an authentication input here: bearer compromise must never
//     amplify into replacement credentials.
//   PUBLIC_API — the frozen public API list below. Bearer is NOT an
//     authentication input; malformed Authorization headers must not change
//     public behavior.
//   NON_API — HTML/operator surfaces. Session behavior unchanged; bearer
//     credentials never widen onto these routes.

const PUBLIC_API_ROUTES = Object.freeze(['/api/health']);

const API_TOKEN_NAMESPACE_PATH = '/api/tokens';

const AUTH_PLANES = Object.freeze([
  'BEARER_ELIGIBLE_API',
  'SESSION_ONLY_API',
  'PUBLIC_API',
  'NON_API'
]);

// Exactly `/api/tokens` or `/api/tokens/<rest>`. This is deliberately NOT a
// bare prefix test: `/api/tokensomething` is an ordinary API product path, not
// token management.
function isApiTokenNamespacePath(pathname) {
  const normalized = String(pathname === undefined || pathname === null ? '' : pathname);
  return normalized === API_TOKEN_NAMESPACE_PATH || normalized.startsWith(`${API_TOKEN_NAMESPACE_PATH}/`);
}

function isApiPath(pathname) {
  const normalized = String(pathname === undefined || pathname === null ? '' : pathname);
  return normalized === '/api' || normalized.startsWith('/api/');
}

// `pathname` is either a request pathname or a Fastify route pattern
// (`:id` parameter segments classify identically). Unknown API paths fall
// through to the bearer-eligible plane, so a future authenticated API route is
// authenticated by default and never public by omission.
function classifyApiRoutePath(pathname) {
  const normalized = String(pathname === undefined || pathname === null ? '' : pathname);
  if (!isApiPath(normalized)) return 'NON_API';
  if (PUBLIC_API_ROUTES.includes(normalized)) return 'PUBLIC_API';
  if (isApiTokenNamespacePath(normalized)) return 'SESSION_ONLY_API';
  return 'BEARER_ELIGIBLE_API';
}

module.exports = {
  AUTH_PLANES,
  PUBLIC_API_ROUTES,
  API_TOKEN_NAMESPACE_PATH,
  isApiPath,
  isApiTokenNamespacePath,
  classifyApiRoutePath
};
