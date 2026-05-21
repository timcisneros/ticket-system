#!/bin/sh
set -e

node --test test/test-rules.js tests/core.test.js tests/types.test.js tests/reporter.test.js tests/integration.test.js tests/presets.test.js tests/gov-check-cli.test.js tests/utils.test.js
