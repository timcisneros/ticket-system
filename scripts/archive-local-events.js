#!/usr/bin/env node
// archive-local-events.js — operator-controlled lifecycle tool for the
// append-only event log (data/events.jsonl, or the active DATA_DIR store).
//
// events.jsonl is an append-only evidence artifact, not editable source. When a
// local/demo log grows large, archive it deliberately instead of hand-editing.
//
// Behavior:
//   * Inspect the target log and report size + line count.
//   * Write a timestamped archive copy under <store>/event-archive/ (Git-ignored).
//   * Only start a fresh empty log when `--reset` is passed explicitly.
//
// Safety:
//   * Touches ONLY the target event log — never provider keys, other data
//     files, source fixtures, or release tags.
//   * Never resets without the explicit `--reset` flag.
//
// Usage:
//   node scripts/archive-local-events.js [--file <path>] [--reset] [--quiet]
//   DATA_DIR=.local-data node scripts/archive-local-events.js
//
// Default target: $DATA_DIR/events.jsonl if DATA_DIR is set, else ./data/events.jsonl
// (mirrors the server's DATA_DIR resolution).

const fs = require('fs');
const path = require('path');

function defaultEventLogPath() {
  const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
  return path.join(dir, 'events.jsonl');
}

function timestampForFilename(now = new Date()) {
  // ISO 8601 with filename-unsafe characters (":", ".") replaced.
  return now.toISOString().replace(/[:.]/g, '-');
}

// Inspect the log without modifying it.
function inspectEventLog(file) {
  if (!fs.existsSync(file)) return { exists: false, bytes: 0, lines: 0 };
  const stat = fs.statSync(file);
  const raw = fs.readFileSync(file, 'utf8');
  let lines = 0;
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf('\n', start);
    if (end === -1) end = raw.length;
    if (raw.slice(start, end).trim()) lines += 1;
    if (end === raw.length) break;
    start = end + 1;
  }
  return { exists: true, bytes: stat.size, lines };
}

// Archive `file` to <dir>/event-archive/events-<timestamp>.jsonl. When `reset`
// is true, truncate the original to an empty log AFTER the archive is written
// and verified. Returns details; throws on missing source or copy mismatch.
function archiveEventLog({ file, reset = false, now = new Date() } = {}) {
  const source = path.resolve(file);
  if (!fs.existsSync(source)) {
    const error = new Error(`Event log not found: ${source}`);
    error.code = 'ENOENT';
    throw error;
  }

  const info = inspectEventLog(source);
  const archiveDir = path.join(path.dirname(source), 'event-archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `events-${timestampForFilename(now)}.jsonl`);

  // Copy first; verify byte length before any destructive reset.
  fs.copyFileSync(source, archivePath);
  const archivedBytes = fs.statSync(archivePath).size;
  if (archivedBytes !== info.bytes) {
    throw new Error(`Archive verification failed: ${archivedBytes} bytes archived vs ${info.bytes} bytes source`);
  }

  let didReset = false;
  if (reset) {
    // Explicit, operator-requested fresh start. Only the event log is touched.
    fs.writeFileSync(source, '');
    didReset = true;
  }

  return {
    source,
    archivePath,
    bytes: info.bytes,
    lines: info.lines,
    reset: didReset
  };
}

function parseArgs(argv) {
  const args = { file: null, archive: false, reset: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive') args.archive = true;
    else if (arg === '--reset') args.reset = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--file') { args.file = argv[++i] || null; }
    else if (arg.startsWith('--file=')) { args.file = arg.slice('--file='.length); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

// Decide what to do from parsed flags. Default is inspect-only. Reset is only
// allowed alongside an archive copy, so the log is never truncated without first
// preserving its evidence.
function resolveAction(args) {
  if (args.reset && !args.archive) {
    const error = new Error('--reset requires --archive (refusing to reset without first archiving)');
    error.code = 'ERESET_WITHOUT_ARCHIVE';
    throw error;
  }
  return { archive: Boolean(args.archive), reset: Boolean(args.reset) };
}

const HELP = `archive-local-events.js — inspect/archive the append-only event log

Usage:
  node scripts/archive-local-events.js [--file <path>] [--archive] [--reset] [--quiet]

Modes:
  (no flags)          Inspect only — report size + line count, change nothing.
  --archive           Copy the target log to a timestamped archive file.
  --archive --reset   Copy, then replace the target with a fresh empty log.

Options:
  --file <path>   Target event log (default: $DATA_DIR/events.jsonl or ./data/events.jsonl)
  --quiet         Suppress the human-readable summary
  -h, --help      Show this help

--reset requires --archive (the log is never truncated without first archiving).
Archives are written under <store>/event-archive/ and are Git-ignored.
The script only ever touches the target event log.`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(HELP);
    process.exit(2);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  let action;
  try {
    action = resolveAction(args);
  } catch (error) {
    console.error(error.message);
    console.error(HELP);
    process.exit(2);
  }

  const file = args.file ? path.resolve(args.file) : defaultEventLogPath();

  const pre = inspectEventLog(file);
  if (!pre.exists) {
    console.error(`Event log not found: ${file}`);
    console.error('Nothing to inspect. (The server recreates an empty log on next start.)');
    process.exit(1);
  }

  // Inspect-only (default): report and change nothing.
  if (!action.archive) {
    if (!args.quiet) {
      console.log('Event log (inspect only)');
      console.log('='.repeat(60));
      console.log(`  target:   ${file}`);
      console.log(`  size:     ${pre.bytes} bytes`);
      console.log(`  lines:    ${pre.lines}`);
      console.log('  action:   none — pass --archive to copy, --archive --reset to copy + start fresh');
    }
    return;
  }

  let result;
  try {
    result = archiveEventLog({ file, reset: action.reset });
  } catch (error) {
    console.error(`Archive failed: ${error.message}`);
    process.exit(1);
  }

  if (!args.quiet) {
    console.log('Event log archive');
    console.log('='.repeat(60));
    console.log(`  source:   ${result.source}`);
    console.log(`  size:     ${result.bytes} bytes`);
    console.log(`  lines:    ${result.lines}`);
    console.log(`  archive:  ${result.archivePath}`);
    console.log(`  reset:    ${result.reset ? 'yes — fresh empty log started' : 'no — source left intact'}`);
    if (!result.reset) {
      console.log('  (pass --reset with --archive to start a fresh empty log)');
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  defaultEventLogPath,
  timestampForFilename,
  inspectEventLog,
  archiveEventLog,
  parseArgs,
  resolveAction
};
