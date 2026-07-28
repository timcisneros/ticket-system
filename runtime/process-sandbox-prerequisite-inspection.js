'use strict';

const {
  ProcessLauncherFoundationError
} = require('./process-launcher-foundation-contract');

function assertClient(client, operation, label) {
  if (!client || typeof client !== 'object' || typeof client[operation] !== 'function') {
    throw new ProcessLauncherFoundationError(
      `${label} is unavailable`,
      'PROCESS_CONTAINMENT_UNAVAILABLE'
    );
  }
  return client;
}

async function inspectProcessSandboxPrerequisites({
  launcherFoundationClient,
  materializerClient,
  observedAt = new Date().toISOString()
} = {}) {
  const launcher = assertClient(
    launcherFoundationClient,
    'health',
    'Launcher foundation client'
  );
  const materializer = assertClient(
    materializerClient,
    'health',
    'Process materializer client'
  );
  const [launcherHealth, materializerHealth] = await Promise.all([
    launcher.health({ observedAt }),
    materializer.health()
  ]);
  if (launcherHealth.materializerGeneration !==
      materializerHealth.materializerGeneration) {
    throw new ProcessLauncherFoundationError(
      'Launcher containment and materializer generations do not match',
      'PROCESS_CONTAINMENT_GENERATION_MISMATCH'
    );
  }
  return launcherHealth;
}

module.exports = {
  inspectProcessSandboxPrerequisites
};
