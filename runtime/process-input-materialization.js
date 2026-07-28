'use strict';

const {
  validateProcessLaunchAuthorityContext
} = require('./process-launch-plan');
const {
  ProcessMaterializerError,
  buildGetProcessSnapshotRequest,
  buildProcessMaterializationRequest,
  normalizeWorkspaceSnapshotDescriptor
} = require('./process-materializer-contract');

function assertBoundaryRepository(repository) {
  if (!repository || typeof repository !== 'object' ||
      typeof repository.withWorkspaceMutationBoundary !== 'function') {
    throw new ProcessMaterializerError(
      'Workspace mutation-boundary repository is unavailable',
      'PROCESS_WORKSPACE_MUTATION_BOUNDARY_UNAVAILABLE'
    );
  }
  return repository;
}

function assertMaterializerClient(client) {
  if (!client || typeof client !== 'object' ||
      typeof client.health !== 'function' ||
      typeof client.materialize !== 'function' ||
      typeof client.getSnapshot !== 'function' ||
      !client.configuration ||
      typeof client.configuration.workspaceAllocationId !== 'string') {
    throw new TypeError('A process materializer client is required');
  }
  return client;
}

async function materializeProcessExecutionInput({
  boundaryRepository,
  materializerClient,
  workspaceTargetId,
  launchAuthorityContext,
  targetId,
  profileId,
  operationId
} = {}) {
  const repository = assertBoundaryRepository(boundaryRepository);
  const client = assertMaterializerClient(materializerClient);
  let enteredBoundary = false;
  try {
    return await repository.withWorkspaceMutationBoundary({
      targetId: workspaceTargetId
    }, async () => {
      enteredBoundary = true;
      const context = validateProcessLaunchAuthorityContext(
        launchAuthorityContext,
        { targetId, profileId }
      );
      const profile = context.processPolicySnapshot.profiles.find(candidate =>
        candidate.targetId === targetId && candidate.profileId === profileId
      );
      if (!profile) {
        throw new ProcessMaterializerError(
          'Selected process profile is absent from immutable launch authority',
          'PROCESS_MATERIALIZER_REQUEST_INVALID'
        );
      }
      const generation = await client.health();
      const request = buildProcessMaterializationRequest({
        workspaceAllocationId: client.configuration.workspaceAllocationId,
        runId: context.runId,
        ticketId: context.ticketId,
        operationId,
        policySnapshotHash: context.processPolicySnapshot.snapshotHash,
        materializerGeneration: generation.materializerGeneration,
        filesystemPolicy: profile.filesystemPolicy
      });
      const descriptor = normalizeWorkspaceSnapshotDescriptor(
        await client.materialize(request),
        {
          runId: context.runId,
          policySnapshotHash: context.processPolicySnapshot.snapshotHash,
          materializerGeneration: generation.materializerGeneration
        }
      );
      const retrieved = normalizeWorkspaceSnapshotDescriptor(
        await client.getSnapshot(buildGetProcessSnapshotRequest({
          snapshotId: descriptor.id,
          runId: context.runId,
          ticketId: context.ticketId,
          operationId,
          policySnapshotHash: context.processPolicySnapshot.snapshotHash,
          materializerGeneration: generation.materializerGeneration,
          filesystemPolicy: profile.filesystemPolicy
        })),
        {
          id: descriptor.id,
          runId: context.runId,
          policySnapshotHash: context.processPolicySnapshot.snapshotHash,
          materializerGeneration: generation.materializerGeneration
        }
      );
      if (JSON.stringify(retrieved) !== JSON.stringify(descriptor)) {
        throw new ProcessMaterializerError(
          'Materializer retrieval did not reproduce the published descriptor',
          'PROCESS_INPUT_SNAPSHOT_MISMATCH'
        );
      }
      return descriptor;
    });
  } catch (error) {
    if (enteredBoundary) throw error;
    throw new ProcessMaterializerError(
      `Workspace mutation boundary could not be acquired: ${error.message || String(error)}`,
      'PROCESS_WORKSPACE_MUTATION_BOUNDARY_UNAVAILABLE'
    );
  }
}

module.exports = {
  materializeProcessExecutionInput
};
