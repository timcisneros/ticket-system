'use strict';

// Workspace authority path rules shared by the server runtime, the admin
// dashboard listing, and the oquery CLI, so the enforced rules and every
// operator-visible listing of them come from one definition and cannot drift.

const fs = require('fs');
const path = require('path');

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

// Dependency-neutral lexical rules shared by historical allocation admission,
// runtime workspace enforcement, and structured allocation contracts. The
// historical ownership normalizer deliberately retains its permissive spelling
// behavior; callers that admit new authority must first use
// normalizeWorkspaceRelativePath (and may impose stricter canonical spelling).
function normalizeWorkspaceRelativePath(inputPath = '', options = {}) {
  const rawPath = String(inputPath || '').trim();

  if (path.isAbsolute(rawPath)) {
    const error = new Error('Absolute paths are not allowed');
    error.code = 'WORKSPACE_ABSOLUTE_PATH';
    error.failureKind = 'protected_path';
    error.details = { path: rawPath };
    throw error;
  }

  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  const relativePath = normalized === '.' ? '' : normalized;
  const segments = relativePath.split('/').filter(Boolean);

  if (relativePath.startsWith('../') || relativePath === '..' || segments.includes('..')) {
    const error = new Error('Path traversal is not allowed');
    error.code = 'WORKSPACE_PATH_TRAVERSAL';
    error.failureKind = 'protected_path';
    error.details = { path: rawPath };
    throw error;
  }

  if (!options.allowHidden && segments.some(segment => segment.startsWith('.'))) {
    const error = new Error('Hidden and system paths are not allowed');
    error.code = 'WORKSPACE_HIDDEN_PATH';
    error.failureKind = 'protected_path';
    error.details = { path: rawPath };
    throw error;
  }

  return relativePath;
}

function normalizeWorkspaceOwnershipPath(relativePath) {
  const normalized = path.posix.normalize(
    String(relativePath || '').replace(/\\/g, '/').trim()
  );
  const cleanPath = normalized === '.' ? '' : normalized.replace(/^\/+/, '');

  if (!cleanPath) return '';
  return cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
}

function isPathInsideOwnedOutputPaths(relativePath, ownedOutputPaths) {
  const normalizedPath = path.posix.normalize(
    String(relativePath || '').replace(/\\/g, '/').trim()
  ).replace(/^\/+/, '');

  return ownedOutputPaths.some(ownedPath => {
    const normalizedOwnedPath = normalizeWorkspaceOwnershipPath(ownedPath);
    return normalizedPath === normalizedOwnedPath.slice(0, -1) ||
      normalizedPath.startsWith(normalizedOwnedPath);
  });
}

function workspaceOwnershipPathsOverlap(leftPath, rightPath) {
  const left = normalizeWorkspaceOwnershipPath(leftPath);
  const right = normalizeWorkspaceOwnershipPath(rightPath);
  return left === right || left.startsWith(right) || right.startsWith(left);
}

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
  isPathInsideOwnedOutputPaths,
  normalizeWorkspaceOwnershipPath,
  normalizeWorkspaceRelativePath,
  workspaceOwnershipPathsOverlap,
  readProtectedWorkspacePaths
};
