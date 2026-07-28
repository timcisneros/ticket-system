'use strict';

const crypto = require('crypto');
const net = require('net');

const {
  PROCESS_MATERIALIZER_FAILURE_CODES,
  PROCESS_MATERIALIZER_MAX_MESSAGE_BYTES,
  PROCESS_MATERIALIZER_PROTOCOL_VERSION,
  ProcessMaterializerError,
  normalizeMaterializerGeneration,
  normalizeProcessMaterializerClientConfig,
  normalizeWorkspaceSnapshotDescriptor,
  validateGetProcessSnapshotRequest,
  validateProcessMaterializationRequest
} = require('./process-materializer-contract');

const RESPONSE_KEYS = Object.freeze(['version', 'requestId', 'ok', 'result']);
const ERROR_RESPONSE_KEYS = Object.freeze(['version', 'requestId', 'ok', 'error']);
const ERROR_DOCUMENT_KEYS = Object.freeze(['code', 'message']);

function closedObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProcessMaterializerError(
      `${label} must be a plain object`,
      'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new ProcessMaterializerError(
      `${label} must contain exactly: ${keys.join(', ')}`,
      'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
    );
  }
}

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0 || payload.length > PROCESS_MATERIALIZER_MAX_MESSAGE_BYTES) {
    throw new ProcessMaterializerError(
      'Materializer request exceeds the bounded protocol message size',
      'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
    );
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function translateSocketError(error) {
  if (error instanceof ProcessMaterializerError) return error;
  return new ProcessMaterializerError(
    `Process materializer is unavailable: ${error.message || String(error)}`,
    'PROCESS_MATERIALIZER_UNAVAILABLE'
  );
}

function parseResponse(payload, requestId) {
  let response;
  try {
    response = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    throw new ProcessMaterializerError(
      `Materializer response is not valid JSON: ${error.message}`,
      'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
    );
  }
  if (response && response.ok === true) {
    closedObject(response, RESPONSE_KEYS, 'materializer success response');
  } else {
    closedObject(response, ERROR_RESPONSE_KEYS, 'materializer error response');
  }
  if (response.version !== PROCESS_MATERIALIZER_PROTOCOL_VERSION ||
      response.requestId !== requestId || typeof response.ok !== 'boolean') {
    throw new ProcessMaterializerError(
      'Materializer response envelope does not match the request',
      'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
    );
  }
  if (response.ok) return response.result;
  closedObject(response.error, ERROR_DOCUMENT_KEYS, 'materializer error');
  if (typeof response.error.code !== 'string' ||
      !PROCESS_MATERIALIZER_FAILURE_CODES.includes(response.error.code) ||
      typeof response.error.message !== 'string' || !response.error.message) {
    throw new ProcessMaterializerError(
      'Materializer returned an unknown or malformed typed failure',
      'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
    );
  }
  throw new ProcessMaterializerError(response.error.message, response.error.code);
}

class ProcessMaterializerClient {
  constructor(configuration) {
    this.configuration = normalizeProcessMaterializerClientConfig(configuration);
  }

  async health() {
    const result = await this.#request('health', {});
    return normalizeMaterializerGeneration(result);
  }

  async materialize(request) {
    const normalized = validateProcessMaterializationRequest(request);
    if (normalized.workspaceAllocationId !== this.configuration.workspaceAllocationId) {
      throw new ProcessMaterializerError(
        'Materialization request does not match the client configured workspace allocation',
        'PROCESS_WORKSPACE_ALLOCATION_UNKNOWN'
      );
    }
    const result = await this.#request('materialize', normalized);
    return normalizeWorkspaceSnapshotDescriptor(result, {
      runId: normalized.runId,
      policySnapshotHash: normalized.policySnapshotHash,
      materializerGeneration: normalized.materializerGeneration
    });
  }

  async getSnapshot(request) {
    const normalized = validateGetProcessSnapshotRequest(request);
    const result = await this.#request('getSnapshot', normalized);
    return normalizeWorkspaceSnapshotDescriptor(result, {
      id: normalized.snapshotId,
      runId: normalized.expectedRunId,
      policySnapshotHash: normalized.expectedPolicySnapshotHash,
      materializerGeneration: normalized.expectedMaterializerGeneration
    });
  }

  #request(operation, body) {
    const requestId = `request-${crypto.randomBytes(24).toString('hex')}`;
    const frame = encodeFrame({
      version: PROCESS_MATERIALIZER_PROTOCOL_VERSION,
      requestId,
      operation,
      body
    });
    const { socketPath, timeoutMs } = this.configuration;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      let settled = false;
      let header = Buffer.alloc(0);
      let payload = null;
      let received = 0;

      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(translateSocketError(error));
        else resolve(value);
      };

      socket.setTimeout(timeoutMs);
      socket.once('timeout', () => settle(new ProcessMaterializerError(
        'Process materializer request timed out',
        'PROCESS_MATERIALIZER_UNAVAILABLE'
      )));
      socket.once('error', error => settle(error));
      socket.once('connect', () => socket.write(frame));
      socket.on('data', chunk => {
        if (settled) return;
        let input = chunk;
        if (header.length < 4) {
          const required = 4 - header.length;
          header = Buffer.concat([header, input.subarray(0, required)]);
          input = input.subarray(Math.min(required, input.length));
          if (header.length < 4) return;
          const length = header.readUInt32BE(0);
          if (length === 0 || length > PROCESS_MATERIALIZER_MAX_MESSAGE_BYTES) {
            settle(new ProcessMaterializerError(
              'Materializer response declares an invalid frame size',
              'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
            ));
            return;
          }
          payload = Buffer.allocUnsafe(length);
        }
        if (input.length > payload.length - received) {
          settle(new ProcessMaterializerError(
            'Materializer response contains trailing bytes',
            'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
          ));
          return;
        }
        input.copy(payload, received);
        received += input.length;
        if (received === payload.length) {
          try {
            settle(null, parseResponse(payload, requestId));
          } catch (error) {
            settle(error);
          }
        }
      });
      socket.once('end', () => {
        if (!settled) {
          settle(new ProcessMaterializerError(
            'Materializer closed before returning a complete response',
            'PROCESS_MATERIALIZER_PROTOCOL_INVALID'
          ));
        }
      });
    });
  }
}

module.exports = {
  ProcessMaterializerClient,
  encodeFrame,
  parseResponse
};
