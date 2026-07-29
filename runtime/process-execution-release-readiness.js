'use strict';

const {
  PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION
} = require('./process-launcher-foundation-contract');
const {
  PROCESS_MATERIALIZER_PROTOCOL_VERSION
} = require('./process-materializer-contract');
const {
  PROCESS_EXECUTION_ROOTFS_REGISTRY_SCHEMA_VERSION,
  evaluateProcessExecutionReleaseReadiness
} = require('./process-execution-release-contract');

class ProcessExecutionReleaseReadiness {
  constructor({
    installed,
    releaseContract,
    repository,
    launcherClient,
    materializerClient,
    artifactStore,
    targetCatalog,
    deploymentValidated
  } = {}) {
    this.installed = installed === true;
    this.releaseContract = releaseContract;
    this.repository = repository;
    this.launcherClient = launcherClient;
    this.materializerClient = materializerClient;
    this.artifactStore = artifactStore;
    this.targetCatalog = targetCatalog;
    this.deploymentValidated = deploymentValidated === true;
  }

  async evaluate() {
    const releaseState = this.repository &&
      typeof this.repository.getProcessExecutionReleaseState === 'function'
      ? await this.repository.getProcessExecutionReleaseState()
      : null;
    const migrationStatus = this.repository &&
      typeof this.repository.getMigrationStatus === 'function'
      ? await this.repository.getMigrationStatus()
      : null;
    let launcher = null;
    let materializer = null;
    let artifactStorage = null;
    if (this.installed) {
      try {
        const health = await this.launcherClient.health();
        launcher = {
          available: true,
          protocolVersion: PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION,
          rootfsRegistrySchemaVersion:
            PROCESS_EXECUTION_ROOTFS_REGISTRY_SCHEMA_VERSION,
          readyForExecution: health.readyForExecution === true,
          generationId: health.generationId,
          rootfsRegistryGeneration: health.rootfsRegistryGeneration,
          materializerGeneration: health.materializerGeneration
        };
      } catch (error) {
        launcher = {
          available: false,
          code: error && error.code || 'PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE'
        };
      }
      try {
        const health = await this.materializerClient.health();
        materializer = {
          available: true,
          protocolVersion: PROCESS_MATERIALIZER_PROTOCOL_VERSION,
          generationId: health.materializerGeneration
        };
      } catch (error) {
        materializer = {
          available: false,
          code: error && error.code || 'PROCESS_MATERIALIZER_UNAVAILABLE'
        };
      }
      try {
        const health = await this.artifactStore.health();
        artifactStorage = {
          available: health && health.status === 'writable',
          version: health && health.version
        };
      } catch (error) {
        artifactStorage = {
          available: false,
          code: error && error.code || 'PROCESS_OUTPUT_ARTIFACT_FAILED'
        };
      }
    }
    const readiness = evaluateProcessExecutionReleaseReadiness({
      releaseContract: this.releaseContract,
      installed: this.installed,
      admissionEnabled: Boolean(
        this.installed && releaseState && releaseState.admissionEnabled
      ),
      releaseState,
      migrationStatus,
      launcher,
      materializer,
      artifactStorage,
      targetCatalog: {
        schemaVersion: this.targetCatalog && this.targetCatalog.version
      },
      deployment: { validated: this.deploymentValidated }
    });
    return Object.freeze({
      ...readiness,
      launcher,
      materializer,
      artifactStorage,
      migrationStatus,
      releaseState
    });
  }

  async assertAdmissionReady() {
    const readiness = await this.evaluate();
    if (readiness.state !== 'ready') {
      const error = new Error(
        `Process execution release readiness is ${readiness.state}`
      );
      error.code = readiness.state === 'disabled'
        ? 'PROCESS_RELEASE_ADMISSION_DISABLED'
        : 'PROCESS_RELEASE_READINESS_UNAVAILABLE';
      error.failureKind = 'process_release_unavailable';
      error.readiness = readiness;
      throw error;
    }
    return readiness;
  }
}

module.exports = {
  ProcessExecutionReleaseReadiness
};
