#!/usr/bin/env node

const path = require('path');
const { standardProjectRules } = require('../src/presets');
const { enforceSilent } = require('../src/enforcer');
const { generateTextReport } = require('../src/reporter');
const buildContext = require('../src/utils').buildContext;

// Parse CLI arguments
const projectPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.';
const outputJson = process.argv.includes('--json');
const failuresOnly = process.argv.includes('--failures-only');

// Extract all --ignore <path> arguments from CLI
function parseIgnoredPaths(argv) {
  const ignored = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ignore' && i + 1 < argv.length) {
      ignored.push(argv[i + 1]);
      i++;
    }
  }
  return ignored;
}

const ignoredPaths = parseIgnoredPaths(process.argv);

async function main() {
  try {
    const absProjectPath = path.resolve(projectPath);

    const rules = standardProjectRules(absProjectPath);

    // Build context with ignoredPaths
    const context = buildContext(absProjectPath, { ignoredPaths });

    const { passed, failures } = enforceSilent(rules, context);

    const results = rules.map(rule => {
      const failure = failures.find(f => f.rule === rule.name);
      const passedRule = !failure;
      return {
        rule: rule.name,
        name: rule.name,
        passed: passedRule,
        description: rule.description,
        severity: rule.severity || 'error'
      };
    });

    // Filter based on --failures-only flag
    const displayResults = failuresOnly ? results.filter(r => !r.passed) : results;

    if (outputJson) {
      const failureDetails = failures.map(f => ({ name: f.rule, description: f.description, severity: f.severity }));
      const jsonOutput = {
        passed,
        failed: failureDetails.length,
        total: results.length,
        failures: failureDetails,
        rules: displayResults.map(({name, passed, description, severity}) => ({ name, passed, description, severity })),
        ignoredPaths
      };
      console.log(JSON.stringify(jsonOutput));
    } else {
      const report = generateTextReport(displayResults);
      console.log(report);
    }

    process.exit(passed ? 0 : 1);
  } catch (err) {
    if (outputJson) {
      console.log(JSON.stringify({ error: String(err) }));
    } else {
      console.error('Error running governance check:', err);
    }
    process.exit(1);
  }
}

main();
