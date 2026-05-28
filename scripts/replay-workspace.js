#!/usr/bin/env node
// Workspace Reconstruction Engine
// Replays workspace.operation events in sequence order to build a
// deterministic in-memory workspace projection.
// No live filesystem access — purely from events + operation-history.

function createWorkspaceProjection() {
  const files = new Map();   // path -> { content, createdAt, modifiedAt }
  const folders = new Set(); // path

  function pathParts(path) {
    return path.split('/').filter(Boolean);
  }

  function parentPath(path) {
    const parts = pathParts(path);
    if (parts.length <= 1) return null;
    return parts.slice(0, -1).join('/');
  }

  function ensureParentFolders(filePath) {
    const parts = pathParts(filePath);
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      folders.add(current);
    }
  }

  function writeFile(filePath, content, timestamp) {
    ensureParentFolders(filePath);
    const existing = files.get(filePath);
    files.set(filePath, {
      content: content || '',
      createdAt: existing ? existing.createdAt : timestamp,
      modifiedAt: timestamp
    });
  }

  function createFolder(folderPath, timestamp) {
    ensureParentFolders(folderPath);
    folders.add(folderPath);
  }

  function deletePath(targetPath, timestamp) {
    // Delete file if exists
    if (files.has(targetPath)) {
      files.delete(targetPath);
    }
    // Delete folder and all children
    for (const filePath of Array.from(files.keys())) {
      if (filePath === targetPath || filePath.startsWith(`${targetPath}/`)) {
        files.delete(filePath);
      }
    }
    for (const folderPath of Array.from(folders)) {
      if (folderPath === targetPath || folderPath.startsWith(`${targetPath}/`)) {
        folders.delete(folderPath);
      }
    }
  }

  function executeFile(filePath, _input, timestamp) {
    // executeFile is a no-op in projection (side effects captured elsewhere)
    ensureParentFolders(filePath);
    if (!files.has(filePath)) {
      files.set(filePath, {
        content: '',
        createdAt: timestamp,
        modifiedAt: timestamp
      });
    }
  }

  function readFile(filePath) {
    return files.get(filePath) || null;
  }

  function listDirectory(dirPath) {
    const prefix = dirPath ? `${dirPath}/` : '';
    const entries = [];
    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes('/')) {
        entries.push({ name: filePath.slice(prefix.length), type: 'file' });
      }
    }
    for (const folderPath of folders) {
      if (folderPath.startsWith(prefix) && folderPath !== dirPath && !folderPath.slice(prefix.length).includes('/')) {
        entries.push({ name: folderPath.slice(prefix.length), type: 'folder' });
      }
    }
    return entries;
  }

  function applyOperation(op, timestamp) {
    // Handle event payload structure: { operation: 'writeFile', path: '...', input: {...}, result: {...} }
    // Or replay structure: { operation: { operation: 'writeFile', args: {...} }, result: {...} }
    let opName, opPath, opContent;
    if (typeof op.operation === 'string') {
      // Event payload format
      opName = op.operation;
      opPath = op.path;
      opContent = op.input && op.input.content;
    } else if (op.operation && typeof op.operation === 'object') {
      // Replay snapshot format
      opName = op.operation.operation || op.operation;
      const args = op.operation.args || {};
      opPath = args.path;
      opContent = args.content;
    } else {
      opName = op;
      opPath = op.path;
      opContent = op.content;
    }

    switch (opName) {
      case 'writeFile':
        writeFile(opPath, opContent, timestamp);
        return { status: 'ok', path: opPath };
      case 'createFolder':
        createFolder(opPath, timestamp);
        return { status: 'ok', path: opPath };
      case 'deletePath':
        deletePath(opPath, timestamp);
        return { status: 'ok', path: opPath };
      case 'executeFile':
        executeFile(opPath, op.input, timestamp);
        return { status: 'ok', path: opPath };
      case 'readFile':
        return { status: 'ok', path: opPath, content: readFile(opPath) };
      case 'listDirectory':
        return { status: 'ok', path: opPath, entries: listDirectory(opPath) };
      default:
        return { status: 'unknown_operation', operation: opName };
    }
  }

  function getState() {
    const fileEntries = {};
    for (const [path, data] of files) {
      fileEntries[path] = {
        content: data.content,
        contentHash: hashContent(data.content)
      };
    }
    return {
      files: fileEntries,
      folders: Array.from(folders).sort()
    };
  }

  function hashContent(content) {
    if (!content) return null;
    return require('crypto')
      .createHash('sha256')
      .update(content)
      .digest('hex');
  }

  return {
    applyOperation,
    getState,
    readFile,
    listDirectory,
    files,
    folders
  };
}

// ── Replay workspace events for a specific run ────────────────────

function reconstructWorkspaceForRun(events, runId) {
  const projection = createWorkspaceProjection();
  const runEvents = events
    .filter(e => e.runId === runId && !e._parseError)
    .sort((a, b) => {
      if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
      return String(a.ts).localeCompare(String(b.ts));
    });

  const applied = [];
  for (const ev of runEvents) {
    if (ev.type === 'workspace.operation' && ev.payload) {
      const result = projection.applyOperation(ev.payload, ev.ts);
      applied.push({
        operation: ev.payload.operation || (ev.payload.operation && ev.payload.operation.operation),
        path: ev.payload.path || (ev.payload.operation && ev.payload.operation.args && ev.payload.operation.args.path),
        seq: ev.seq,
        ts: ev.ts,
        result
      });
    }
  }

  return {
    projection,
    applied,
    finalState: projection.getState()
  };
}

module.exports = {
  createWorkspaceProjection,
  reconstructWorkspaceForRun
};

// CLI usage for testing
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const dataDir = process.argv[2] || path.resolve('data');
  const runId = parseInt(process.argv[3], 10) || 1;

  function readEventsJsonl(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  }

  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const result = reconstructWorkspaceForRun(events, runId);

  console.log(JSON.stringify({
    runId,
    operationsApplied: result.applied.length,
    finalState: result.finalState
  }, null, 2));
}
