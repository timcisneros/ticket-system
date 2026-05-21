# Testing in governance-kernel

In this environment, the `package.json` file in the `governance-kernel` directory is protected and should not be edited. 

This means that the usual `npm test` command may not be available or functional.

## Running Tests

To run tests, use either of the following methods:

- Run the provided test wrapper script through the shell explicitly:

  ```sh
  sh test.sh
  ```

  This is necessary because the `test.sh` script is not executable in this environment, so it must be run via `sh`.

- Run the Node.js test command directly:

  ```sh
  node --test test/test-rules.js tests/core.test.js tests/types.test.js tests/reporter.test.js tests/integration.test.js tests/presets.test.js tests/gov-check-cli.test.js
  ```

This ensures tests run correctly without requiring changes to the protected `package.json`.
