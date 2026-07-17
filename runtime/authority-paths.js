'use strict';

// Workspace authority path rules shared by the server runtime, the admin
// dashboard listing, and the oquery CLI, so the enforced rules and every
// operator-visible listing of them come from one definition and cannot drift.

const fs = require('fs');

const DEFAULT_PROTECTED_WORKSPACE_PATHS = Object.freeze([
  '.git', '.env', '.env.*', 'node_modules', 'package.json', 'pnpm-lock.yaml'
]);

// Hardcoded application-file guard (WORKSPACE_SENSITIVE_PATH). Distinct from the
// operator-editable protected-paths config; changing it is a code change.
const SENSITIVE_APPLICATION_PATHS = Object.freeze([
  'data',
  'server.js',
  'views/admin',
  'views/login.ejs',
  'views/layout.ejs',
  'package.json',
  'pnpm-lock.yaml'
]);

// Reads the operator-editable protected-path patterns, falling back to the
// built-in defaults when the config file is missing or unreadable. `fromConfig`
// reports which source is live so listings can state it truthfully.
function readProtectedWorkspacePaths(filePath) {
  try {
    const configuredPaths = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(configuredPaths)) {
      throw new Error('Protected workspace paths config must be an array');
    }
    return {
      paths: configuredPaths
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean),
      fromConfig: true
    };
  } catch (error) {
    return { paths: [...DEFAULT_PROTECTED_WORKSPACE_PATHS], fromConfig: false };
  }
}

module.exports = {
  DEFAULT_PROTECTED_WORKSPACE_PATHS,
  SENSITIVE_APPLICATION_PATHS,
  readProtectedWorkspacePaths
};
