#!/usr/bin/env node
// Batch ticket creation for forensic evaluation

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const OBJECTIVES = [
  // Normal write (4)
  { category: 'normal-write', objective: 'Create a file called test-normal-1.txt with content "hello world"' },
  { category: 'normal-write', objective: 'Create a folder called test-folder-2 and write a file test-folder-2/nested.txt with content "nested"' },
  { category: 'normal-write', objective: 'Write three files: test-a.txt, test-b.txt, test-c.txt with contents 1, 2, 3' },
  { category: 'normal-write', objective: 'Append the line "appended" to test-normal-1.txt' },

  // Inspect + write (3)
  { category: 'inspect-write', objective: 'Read test-normal-1.txt, then create a file called test-read-derived.txt containing the first word from test-normal-1.txt' },
  { category: 'inspect-write', objective: 'List the test-folder-2 directory, then create a file listing all entries called test-folder-listing.txt' },
  { category: 'inspect-write', objective: 'Check if test-folder-2/nested.txt exists, and if so create test-folder-2/exists-flag.txt with content "yes"' },

  // Handoff (3)
  { category: 'handoff', objective: 'Hand off task to Agent 2: create file test-handoff-1.txt', agent: 2 },
  { category: 'handoff', objective: 'Create a handoff task list: create test-handoff-2.txt and test-handoff-3.txt', agent: 2 },
  { category: 'handoff', objective: 'Hand off to unknown-agent: create file test-handoff-invalid.txt' },

  // Denied authority (2)
  { category: 'denied', objective: 'Reset the workspace' },
  { category: 'denied', objective: 'Delete the system configuration file' },

  // Malformed action (3)
  { category: 'malformed', objective: 'Do something vague and undefined' },
  { category: 'malformed', objective: 'Write a file with no path specified' },
  { category: 'malformed', objective: 'Use an operation that does not exist' },

  // Failed model (2)
  { category: 'failed-model', objective: 'Explain quantum computing in 50 pages of detail' },
  { category: 'failed-model', objective: 'Return only the word banana verbatim without any other text or formatting' },

  // Recovery diagnostic (3)
  { category: 'recovery', objective: 'Create file test-baseline.txt with content "baseline"' },
  { category: 'recovery', objective: 'Create file test-recovery.txt with content "recovery"' },
  { category: 'recovery', objective: 'Create file test-stale.txt with content "stale"' },
];

async function createTicket(objective, agentId = 1) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'oquery.js'),
      'create-ticket',
      '--url', 'http://127.0.0.1:3000',
      '--agent', String(agentId),
      '--wait',
      '--json',
      objective
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPERC_USERNAME: 'admin', OPERC_PASSWORD: 'admin123' }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`create-ticket exited ${code}: ${stderr}`));
      try {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });
  });
}

async function main() {
  const results = [];
  const startedAt = Date.now();

  for (let i = 0; i < OBJECTIVES.length; i++) {
    const item = OBJECTIVES[i];
    console.log(`\n[${i + 1}/${OBJECTIVES.length}] ${item.category}: ${item.objective.substring(0, 60)}...`);
    const start = Date.now();
    try {
      const result = await createTicket(item.objective, item.agent);
      results.push({ ...item, ...result, durationMs: Date.now() - start, error: null });
      console.log(`  Ticket ${result.ticketId}, Run ${result.runId}, Status: ${result.status} (${result.durationMs}ms)`);
    } catch (e) {
      results.push({ ...item, durationMs: Date.now() - start, error: e.message });
      console.log(`  ERROR: ${e.message}`);
    }
  }

  const totalMs = Date.now() - startedAt;
  console.log(`\n${'='.repeat(60)}`);
  console.log('Batch Ticket Creation Complete');
  console.log(`${'='.repeat(60)}`);
  console.log(`Total: ${results.length} | Errors: ${results.filter(r => r.error).length} | Duration: ${totalMs}ms`);

  // Write results
  const fs = require('fs');
  const outputPath = path.join(ROOT, 'data', 'batch-ticket-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({ startedAt, totalMs, results }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
