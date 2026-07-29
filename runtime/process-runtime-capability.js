'use strict';

const {
  PROCESS_ARTIFACT_PUBLICATION_CONTRACT_VERSION,
  PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION,
  PROCESS_RUNTIME_CAPABILITY_KEYS,
  PROCESS_RUNTIME_CAPABILITY_VERSION,
  PROCESS_RUNTIME_CONTROLLER_PROTOCOL_VERSION,
  hashProcessContractValue,
  normalizeProcessPolicySnapshot,
  normalizeProcessRuntimeCapabilityDescriptor: normalizeRuntimeCapabilityContract
} = require('./process-execution-contract');
const {
  normalizeContainmentHealth
} = require('./process-launcher-foundation-contract');
const {
  normalizeMaterializerGeneration
} = require('./process-materializer-contract');
const PROCESS_ENABLED_RELEASE_GATES = Object.freeze([
  'process-launcher-foundation-cross-uid-test.js',
  'process-runtime-lifecycle-postgres-test.js',
  'process-runtime-fault-recovery-test.js'
]);

class ProcessRuntimeCapabilityError extends Error {
  constructor(message, code = 'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE') {
    super(message);
    this.name = 'ProcessRuntimeCapabilityError';
    this.code = code;
    this.failureKind = 'process_runtime_unavailable';
  }
}

function normalizeProcessRuntimeCapabilityDescriptor(value, {
  observedAt = new Date().toISOString()
} = {}) {
  try {
    return normalizeRuntimeCapabilityContract(value, { observedAt });
  } catch (error) {
    const mismatch = /generation does not match/.test(error.message);
    throw new ProcessRuntimeCapabilityError(error.message, mismatch
      ? 'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
      : 'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE');
  }
}

class ProcessRuntimeCapabilityResolver {
  constructor({
    featureEnabled,
    repository,
    artifactStore,
    materializerClient,
    launcherClient,
    releaseReadiness = null,
    releaseGates = PROCESS_ENABLED_RELEASE_GATES
  } = {}) {
    this.featureEnabled = featureEnabled === true;
    this.repository = repository;
    this.artifactStore = artifactStore;
    this.materializerClient = materializerClient;
    this.launcherClient = launcherClient;
    this.releaseReadiness = releaseReadiness;
    this.releaseGates = releaseGates;
  }

  async resolve(processPolicySnapshot) {
    if (!this.featureEnabled) {
      throw new ProcessRuntimeCapabilityError(
        'Process execution is disabled by feature policy'
      );
    }
    if (!this.releaseReadiness ||
        typeof this.releaseReadiness.assertAdmissionReady !== 'function') {
      throw new ProcessRuntimeCapabilityError(
        'Process execution release readiness authority is unavailable'
      );
    }
    try {
      await this.releaseReadiness.assertAdmissionReady();
    } catch (error) {
      throw new ProcessRuntimeCapabilityError(
        error && error.message
          ? error.message
          : 'Process execution release readiness is unavailable',
        error && error.code === 'PROCESS_RELEASE_ADMISSION_DISABLED'
          ? 'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE'
          : 'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
      );
    }
    const snapshot = normalizeProcessPolicySnapshot(processPolicySnapshot);
    if (snapshot.version !== 3 || snapshot.capabilityEnabled !== true ||
        snapshot.profiles.length === 0) {
      throw new ProcessRuntimeCapabilityError(
        'Only a nonempty version-3 process snapshot can receive runtime capability'
      );
    }
    if (!this.repository ||
        typeof this.repository.isProcessExecutionSchemaAvailable !== 'function' ||
        typeof this.repository.isRuntimeBudgetSchemaAvailable !== 'function' ||
        await this.repository.isProcessExecutionSchemaAvailable() !== true ||
        await this.repository.isRuntimeBudgetSchemaAvailable() !== true) {
      throw new ProcessRuntimeCapabilityError(
        'PostgreSQL process lifecycle or runtime budget schema is unavailable'
      );
    }
    if (!this.artifactStore || typeof this.artifactStore.health !== 'function') {
      throw new ProcessRuntimeCapabilityError('Process artifact storage is unavailable');
    }
    await this.artifactStore.health();
    if (!this.materializerClient || typeof this.materializerClient.health !== 'function' ||
        !this.launcherClient || typeof this.launcherClient.health !== 'function') {
      throw new ProcessRuntimeCapabilityError('Native process services are unavailable');
    }
    if (!Array.isArray(this.releaseGates) ||
        PROCESS_ENABLED_RELEASE_GATES.some(gate => !this.releaseGates.includes(gate))) {
      throw new ProcessRuntimeCapabilityError(
        'Mandatory process-enabled release gates are not registered'
      );
    }
    const materializer = normalizeMaterializerGeneration(
      await this.materializerClient.health()
    );
    const containment = normalizeContainmentHealth(await this.launcherClient.health());
    if (containment.readyForExecution !== true ||
        containment.materializerGeneration !== materializer.materializerGeneration) {
      throw new ProcessRuntimeCapabilityError(
        'Containment and materializer generations do not match',
        'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
      );
    }
    let rootfsRegistryGeneration = null;
    for (const profile of snapshot.profiles) {
      const rootfs = await this.launcherClient.getRootfs({
        rootfsId: profile.runtimeRootfs.id,
        rootfsManifestSha256: profile.runtimeRootfs.manifestSha256
      });
      const executable = await this.launcherClient.verifyExecutable({
        rootfsId: profile.runtimeRootfs.id,
        rootfsManifestSha256: profile.runtimeRootfs.manifestSha256,
        executablePath: profile.executableIdentity.path,
        executableSha256: profile.executableIdentity.sha256,
        format: profile.executableIdentity.format
      });
      if (rootfs.rootfsRegistryGeneration !== executable.rootfsRegistryGeneration ||
          rootfs.id !== profile.runtimeRootfs.id ||
          rootfs.manifestSha256 !== profile.runtimeRootfs.manifestSha256 ||
          executable.executableSha256 !== profile.executableIdentity.sha256) {
        throw new ProcessRuntimeCapabilityError(
          'Rootfs or executable authority does not match the run snapshot',
          'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
        );
      }
      if (rootfsRegistryGeneration !== null &&
          rootfsRegistryGeneration !== rootfs.rootfsRegistryGeneration) {
        throw new ProcessRuntimeCapabilityError(
          'Profiles resolve through different rootfs registry generations',
          'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
        );
      }
      rootfsRegistryGeneration = rootfs.rootfsRegistryGeneration;
    }
    if (rootfsRegistryGeneration !== containment.rootfsRegistryGeneration) {
      throw new ProcessRuntimeCapabilityError(
        'Rootfs registry and containment generations do not match',
        'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
      );
    }
    const authority = {
      controllerProtocolVersion: PROCESS_RUNTIME_CONTROLLER_PROTOCOL_VERSION,
      databaseSchemaVersion: PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION,
      artifactPublicationContractVersion: PROCESS_ARTIFACT_PUBLICATION_CONTRACT_VERSION,
      containmentGenerationId: containment.generationId,
      materializerGeneration: materializer.materializerGeneration,
      rootfsRegistryGeneration,
      launcherProtocolVersion: containment.launcherProtocolVersion
    };
    return normalizeProcessRuntimeCapabilityDescriptor({
      version: PROCESS_RUNTIME_CAPABILITY_VERSION,
      status: 'runtime_verified',
      generationId: `process-runtime-v1-${hashProcessContractValue(authority)}`,
      ...authority,
      verifiedAt: containment.verifiedAt,
      expiresAt: containment.expiresAt,
      readyForExecution: true
    });
  }

  async resolveLaunchAuthority(processPolicySnapshot, expectedGenerationId) {
    const runtimeCapability = await this.resolve(processPolicySnapshot);
    if (runtimeCapability.generationId !== expectedGenerationId) {
      throw new ProcessRuntimeCapabilityError(
        'Current process runtime capability does not match admitted authority',
        'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
      );
    }
    const sandboxCapability = normalizeContainmentHealth(
      await this.launcherClient.health()
    );
    if (sandboxCapability.generationId !==
          runtimeCapability.containmentGenerationId ||
        sandboxCapability.materializerGeneration !==
          runtimeCapability.materializerGeneration ||
        sandboxCapability.rootfsRegistryGeneration !==
          runtimeCapability.rootfsRegistryGeneration) {
      throw new ProcessRuntimeCapabilityError(
        'Fresh containment health does not match runtime capability authority',
        'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
      );
    }
    return Object.freeze({
      runtimeCapability,
      sandboxCapability
    });
  }
}

module.exports = {
  PROCESS_ENABLED_RELEASE_GATES,
  PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION,
  PROCESS_RUNTIME_CAPABILITY_KEYS,
  PROCESS_RUNTIME_CAPABILITY_VERSION,
  PROCESS_RUNTIME_CONTROLLER_PROTOCOL_VERSION,
  ProcessRuntimeCapabilityError,
  ProcessRuntimeCapabilityResolver,
  normalizeProcessRuntimeCapabilityDescriptor
};
