# Governance Kernel

This project provides a rules engine and enforcer for managing and validating governance policies through customizable rules.

## Overview

Governance-kernel lets you create governance rules programmatically, add them to an enforcement engine, and run silent enforcement checks to validate if the rules pass or fail against a given context.

## Example Usage

```js
const { createRule, checkRules, enforce, version } = require('./src/core');

// Create a rule: checks that README.md exists in the project
const hasReadme = createRule(
  'hasReadme',
  () => require('fs').existsSync('README.md'),
  'Project should have README.md'
);

// Check rules
const checkResult = checkRules([hasReadme], {});

// Enforce rules
const enforcementResult = enforce([hasReadme], {});

console.log('Version:', version);
console.log('Check Result:', checkResult);
console.log('Enforcement Result:', enforcementResult);
```
