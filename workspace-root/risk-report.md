# Security Risk and Code Smell Report

## src/calculator.js

1. **Use of eval in parseInput function**
   - Severity: High
   - Issue: Using `eval` on user input is a serious security risk as it allows arbitrary code execution.
   - Suggested Fix: Replace `eval` with a safe parsing method or use a proper parser.

2. **No zero check in divide function**
   - Severity: Medium
   - Issue: The divide function does not handle division by zero, which could cause runtime errors.
   - Suggested Fix: Add validation to handle zero divisor cases safely.

## src/database.js

1. **Global mutation of `connection` variable**
   - Severity: Medium
   - Issue: `connection` is declared as a constant but reassigned. Also, global state mutation can lead to hard-to-debug issues.
   - Suggested Fix: Declare `connection` with `let` and encapsulate connection state to avoid global mutations.

2. **No SQL sanitization in query function**
   - Severity: High
   - Issue: The `query` function executes raw SQL without sanitizing inputs, risking SQL injection attacks.
   - Suggested Fix: Use parameterized queries or sanitize inputs before executing SQL.

## config/settings.json

1. **Hardcoded sensitive values (apiKey, database password)**
   - Severity: High
   - Issue: Sensitive information like `apiKey` and database password are hardcoded in a configuration file, which can be a security risk if exposed.
   - Suggested Fix: Move sensitive credentials to environment variables or secure vault solutions, and avoid committing them to source control.

2. **Debug mode enabled in production**
   - Severity: Low
   - Issue: `debug` is set to true, which may leak sensitive data or affect performance in production.
   - Suggested Fix: Ensure debug mode is disabled in production environments.
