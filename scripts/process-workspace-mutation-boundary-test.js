#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  PostgresRuntimeStore
} = require('../persistence/postgres/store');
const {
  createAsserter,
  sleep,
  withHarness
} = require('./postgres-test-harness');

const ROOT = path.resolve(__dirname, '..');
const assert = createAsserter();

async function main() {
  await withHarness(
    'process workspace mutation boundary',
    async ({ store, schema, databaseUrl }) => {
      const peer = new PostgresRuntimeStore({
        connectionString: databaseUrl,
        schema,
        lockTimeoutMs: 5000
      });
      try {
        let releaseBoundary;
        let boundaryEntered = false;
        const boundaryRelease = new Promise(resolve => { releaseBoundary = resolve; });
        const boundary = store.withWorkspaceMutationBoundary({
          targetId: 'local-workspace'
        }, async requests => {
          boundaryEntered = true;
          assert(requests.length === 1 &&
            requests[0].resource === 'workspace:local-workspace:' &&
            requests[0].mode === 'exclusive',
          'materialization takes the existing workspace root resource exclusively');
          await boundaryRelease;
        });

        while (!boundaryEntered) await sleep(10);
        let mutationEntered = false;
        const mutation = peer.withTargetOperationLock({
          targetId: 'local-workspace',
          paths: ['src/index.js']
        }, async requests => {
          mutationEntered = true;
          assert(requests.some(request =>
            request.resource === 'workspace:local-workspace:' &&
            request.mode === 'shared'
          ), 'ordinary mutation uses the same root resource in shared mode');
        });
        await sleep(200);
        assert(mutationEntered === false,
          'workspace mutation cannot enter while materialization owns the root boundary');
        releaseBoundary();
        await boundary;
        await mutation;
        assert(mutationEntered,
          'blocked mutation resumes after the materialization boundary releases');

        const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        assert(/operatorWorkspaceMutationApi[\s\S]*withTargetOperationLock/.test(serverSource),
          'operator workspace mutations use the PostgreSQL hierarchical lock family');
        assert(/workspace\/fixture[\s\S]*withWorkspaceMutationBoundary/.test(serverSource),
          'fixture reset uses the root-exclusive workspace boundary');
        assert(/resetDebugData[\s\S]*withWorkspaceMutationBoundary/.test(serverSource),
          'debug reset uses the root-exclusive workspace boundary');
        assert(/executeWorkspaceOperation[\s\S]*withTargetOperationLock/.test(serverSource),
          'agent workspace mutations retain the hierarchical lock family');
        assert(/executeRecovery[\s\S]*withOperatorRecoveryLock/.test(serverSource),
          'operator recovery retains the hierarchical lock family');
      } finally {
        await peer.close();
      }
    }
  );
  console.log(`\nPASS: process workspace mutation boundary — ${assert.count()} assertions`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
