'use strict';

const crypto = require('crypto');
const net = require('net');

const {
  PROCESS_LAUNCHER_FOUNDATION_FAILURE_CODES,
  PROCESS_LAUNCHER_FOUNDATION_MAX_MESSAGE_BYTES,
  PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION,
  ProcessLauncherFoundationError,
  buildGetRootfsRequest,
  buildLauncherLaunchRequest,
  buildLauncherOperationRequest,
  buildVerifyExecutableRequest,
  normalizeContainmentHealth,
  normalizeExecutableAuthority,
  normalizePrivateExecutionResult,
  normalizePrivateOperationStatus,
  normalizeProcessLauncherFoundationClientConfig,
  normalizeRootfsAuthority
} = require('./process-launcher-foundation-contract');

const SUCCESS_KEYS = Object.freeze(['version', 'requestId', 'ok', 'result']);
const FAILURE_KEYS = Object.freeze(['version', 'requestId', 'ok', 'error']);
const ERROR_KEYS = Object.freeze(['code', 'message']);

function closed(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProcessLauncherFoundationError(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new ProcessLauncherFoundationError(
      `${label} must contain exactly: ${keys.join(', ')}`
    );
  }
}

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0 ||
      payload.length > PROCESS_LAUNCHER_FOUNDATION_MAX_MESSAGE_BYTES) {
    throw new ProcessLauncherFoundationError(
      'Launcher foundation request exceeds the message ceiling'
    );
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function parseResponse(payload, requestId) {
  let response;
  try {
    response = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    throw new ProcessLauncherFoundationError(
      `Launcher foundation response is invalid JSON: ${error.message}`
    );
  }
  closed(response, response && response.ok === true ? SUCCESS_KEYS : FAILURE_KEYS,
    'launcher foundation response');
  if (response.version !== PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION ||
      typeof response.ok !== 'boolean') {
    throw new ProcessLauncherFoundationError(
      'Launcher foundation response envelope is invalid'
    );
  }
  if (response.ok) {
    if (response.requestId !== requestId) {
      throw new ProcessLauncherFoundationError(
        'Launcher foundation response requestId mismatch'
      );
    }
    return response.result;
  }
  closed(response.error, ERROR_KEYS, 'launcher foundation error');
  if (typeof response.error.code !== 'string' ||
      !PROCESS_LAUNCHER_FOUNDATION_FAILURE_CODES.includes(response.error.code) ||
      typeof response.error.message !== 'string' || !response.error.message) {
    throw new ProcessLauncherFoundationError(
      'Launcher foundation returned an unknown typed failure'
    );
  }
  if (response.requestId === null) {
    if (response.error.code === 'PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED' &&
        response.error.message === 'Launcher foundation client is not authorized') {
      throw new ProcessLauncherFoundationError(response.error.message, response.error.code);
    }
    throw new ProcessLauncherFoundationError(
      'Only the launcher pre-authentication refusal may use a null requestId'
    );
  }
  if (response.requestId !== requestId) {
    throw new ProcessLauncherFoundationError(
      'Launcher foundation response requestId mismatch'
    );
  }
  throw new ProcessLauncherFoundationError(response.error.message, response.error.code);
}

class ProcessLauncherFoundationClient {
  constructor(configuration) {
    this.configuration = normalizeProcessLauncherFoundationClientConfig(configuration);
  }

  async health(options) {
    return normalizeContainmentHealth(await this.#request('health', {}), options);
  }

  async getRootfs(request) {
    const normalized = buildGetRootfsRequest(request);
    return normalizeRootfsAuthority(
      await this.#request('getRootfs', normalized),
      {
        id: normalized.rootfsId,
        manifestSha256: normalized.rootfsManifestSha256
      }
    );
  }

  async verifyExecutable(request) {
    const normalized = buildVerifyExecutableRequest(request);
    return normalizeExecutableAuthority(
      await this.#request('verifyExecutable', normalized),
      normalized
    );
  }

  async launch(request, authority) {
    const normalized = buildLauncherLaunchRequest(request, authority);
    return normalizePrivateExecutionResult(
      await this.#request('launch', normalized),
      normalized.launchPlan.operationIdentity
    );
  }

  async getOperation(request) {
    const normalized = buildLauncherOperationRequest(request);
    return normalizePrivateOperationStatus(
      await this.#request('getOperation', normalized),
      normalized.operationIdentity
    );
  }

  async cancelOperation(request) {
    const normalized = buildLauncherOperationRequest(request);
    return normalizePrivateOperationStatus(
      await this.#request('cancelOperation', normalized),
      normalized.operationIdentity
    );
  }

  #request(operation, body) {
    const requestId = `request-${crypto.randomBytes(24).toString('hex')}`;
    const frame = encodeFrame({
      version: PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION,
      requestId,
      operation,
      body
    });
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.configuration.socketPath });
      let settled = false;
      let header = Buffer.alloc(0);
      let payload = null;
      let received = 0;
      let deferredWriteError = null;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) {
          if (error instanceof ProcessLauncherFoundationError) reject(error);
          else reject(new ProcessLauncherFoundationError(
            `Launcher foundation is unavailable: ${error.message || String(error)}`,
            'PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE'
          ));
        } else {
          resolve(value);
        }
      };
      socket.setTimeout(this.configuration.timeoutMs);
      socket.once('timeout', () => settle(new ProcessLauncherFoundationError(
        'Launcher foundation request timed out',
        'PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE'
      )));
      socket.once('error', error => {
        if (error && error.code === 'EPIPE') {
          deferredWriteError = error;
          return;
        }
        settle(error);
      });
      socket.once('connect', () => socket.write(frame));
      socket.on('data', chunk => {
        if (settled) return;
        let input = chunk;
        if (header.length < 4) {
          const needed = 4 - header.length;
          header = Buffer.concat([header, input.subarray(0, needed)]);
          input = input.subarray(Math.min(needed, input.length));
          if (header.length < 4) return;
          const length = header.readUInt32BE(0);
          if (length === 0 ||
              length > PROCESS_LAUNCHER_FOUNDATION_MAX_MESSAGE_BYTES) {
            settle(new ProcessLauncherFoundationError(
              'Launcher foundation response frame size is invalid'
            ));
            return;
          }
          payload = Buffer.allocUnsafe(length);
        }
        if (input.length > payload.length - received) {
          settle(new ProcessLauncherFoundationError(
            'Launcher foundation response contains trailing bytes'
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
          settle(deferredWriteError || new ProcessLauncherFoundationError(
            'Launcher foundation closed before a complete response'
          ));
        }
      });
      socket.once('close', () => {
        if (!settled) {
          settle(deferredWriteError || new ProcessLauncherFoundationError(
            'Launcher foundation closed before a complete response'
          ));
        }
      });
    });
  }
}

module.exports = {
  ProcessLauncherFoundationClient,
  encodeFrame,
  parseResponse
};
