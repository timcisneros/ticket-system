const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempWorkspaceRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-workspace-`));
}

function removeTempWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot) return;

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTmp = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedTmp, resolvedRoot);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove non-temp workspace: ${workspaceRoot}`);
  }

  fs.rmSync(resolvedRoot, { recursive: true, force: false });
}

module.exports = {
  createTempWorkspaceRoot,
  removeTempWorkspaceRoot
};
