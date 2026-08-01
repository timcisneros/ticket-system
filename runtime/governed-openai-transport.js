'use strict';

// Tranche 4 — the production OpenAI governed transport.
//
// It sends bytes. That is the whole responsibility, and the deliberate
// narrowness is the point:
//
//   * the endpoint is the fixed official one, not configurable;
//   * the body is the persisted string, written to the socket as-is;
//   * nothing is serialized, re-serialized, merged or defaulted here.
//
// There is NO configurable base URL. A test injects a different transport
// function rather than pointing this one somewhere else, so no configuration
// value can ever redirect a real governed request.

const https = require('node:https');

const GOVERNED_OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';

// Creates the transport function the orchestration calls. Everything it needs
// arrives per-request from the reservation; the factory itself holds no route,
// model or credential.
function createOpenAiGovernedTransport() {
  return async function openAiGovernedTransport({
    endpointIdentity,
    serializedRequest,
    credentials,
    timeoutMs,
    maxResponseBytes
  }) {
    // The endpoint is verified rather than trusted: a captured request whose
    // endpoint is not the official one is refused instead of being sent
    // somewhere else.
    if (endpointIdentity !== GOVERNED_OPENAI_ENDPOINT) {
      throw new Error(
        `governed OpenAI dispatch refuses endpoint ${String(endpointIdentity)}`);
    }
    const apiKey = credentials && credentials.apiKey;
    if (!apiKey) throw new Error('no OpenAI credential was resolved');

    // The bytes, measured once, sent once.
    const payload = Buffer.from(serializedRequest, 'utf8');

    return await new Promise((resolve, reject) => {
      const request = https.request(GOVERNED_OPENAI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.byteLength,
          Authorization: `Bearer ${apiKey}`
        },
        timeout: timeoutMs
      }, response => {
        const chunks = [];
        let received = 0;
        let overflowed = false;
        response.on('data', chunk => {
          received += chunk.length;
          // The existing response bound, enforced on the wire so an oversized
          // body is abandoned rather than buffered.
          if (received > maxResponseBytes) {
            overflowed = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (overflowed) {
            const error = new Error(
              `governed response exceeded ${maxResponseBytes} bytes`);
            error.responseTooLarge = true;
            reject(error);
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (_) {
            resolve({ text });
            return;
          }
          resolve({
            // The model text, extracted the same way the ungoverned adapter
            // does, so response handling downstream is unchanged.
            text: extractResponseText(parsed),
            // Passed through uninterpreted; the settlement contract decides
            // whether it is trustworthy.
            usage: parsed && parsed.usage ? parsed.usage : undefined,
            identity: parsed && typeof parsed.id === 'string' ? parsed.id : undefined
          });
        });
        response.on('error', reject);
      });
      request.on('timeout', () => {
        const error = new Error('governed request timed out');
        error.name = 'AbortError';
        request.destroy(error);
      });
      request.on('error', reject);
      request.end(payload);
    });
  };
}

// Mirrors the existing OpenAI Responses extraction. Kept here rather than
// imported from the server so this module has no dependency on it.
function extractResponseText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.output_text === 'string' && parsed.output_text) return parsed.output_text;
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  const pieces = [];
  for (const item of output) {
    const content = Array.isArray(item && item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part.text === 'string') pieces.push(part.text);
    }
  }
  return pieces.join('');
}

module.exports = {
  GOVERNED_OPENAI_ENDPOINT,
  createOpenAiGovernedTransport,
  extractResponseText
};
