'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

function browserError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureKind = 'browser_error';
  error.detail = detail;
  return error;
}

// Phase-2 (safe interaction) key allowlist. The design names Enter, Tab,
// Escape, and the arrow keys; the arrow keys are expressed here with the
// canonical Chromium/Playwright key spellings. This list is the ONLY keyboard
// authority `press` accepts — no arbitrary key strings, no browser shortcuts.
const INTERACTION_KEY_ALLOWLIST = Object.freeze([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
]);

// The observation selector set. Element provenance is positional over exactly
// this set, so interaction resolution MUST use the identical selector and the
// identical visibility mapping as `observe`.
const OBSERVED_ELEMENT_SELECTOR = 'a,button,input,select,textarea,[role],h1,h2,h3';

function configuredExecutable() {
  const executablePath = typeof process.env.BROWSER_ENGINE_EXECUTABLE === 'string'
    ? process.env.BROWSER_ENGINE_EXECUTABLE.trim()
    : '';
  if (!executablePath || !fs.existsSync(executablePath)) return null;
  try {
    if (!fs.statSync(executablePath).isFile()) return null;
    fs.accessSync(executablePath, fs.constants.X_OK);
    return executablePath;
  } catch (_) {
    return null;
  }
}

function isEngineAvailable() {
  return Boolean(configuredExecutable());
}

function getEngineStatus() {
  const configuredPath = typeof process.env.BROWSER_ENGINE_EXECUTABLE === 'string'
    ? process.env.BROWSER_ENGINE_EXECUTABLE.trim()
    : '';
  const executablePath = configuredExecutable();
  let version = null;
  if (executablePath) {
    try {
      version = execFileSync(executablePath, ['--version'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim().slice(0, 200) || null;
    } catch (_) {
      version = null;
    }
  }
  return {
    configured: Boolean(configuredPath),
    executableExists: Boolean(configuredPath && fs.existsSync(configuredPath)),
    available: Boolean(executablePath),
    version
  };
}

function normalizeAllowedOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw browserError('BROWSER_TARGET_UNAVAILABLE', 'Browser target has no allowed origins');
  }
  const normalized = new Set();
  for (const value of origins) {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== value) {
        throw new Error('invalid origin');
      }
      normalized.add(parsed.origin);
    } catch (_) {
      throw browserError('BROWSER_TARGET_UNAVAILABLE', `Browser target has invalid allowed origin: ${String(value)}`);
    }
  }
  return normalized;
}

function assertAllowedUrl(value, allowedOrigins) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw browserError('BROWSER_ORIGIN_BLOCKED', 'Browser URL is invalid', { blockedUrl: String(value) });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !allowedOrigins.has(parsed.origin)) {
    throw browserError('BROWSER_ORIGIN_BLOCKED', `Browser origin is not allowed: ${parsed.origin}`, {
      blockedUrl: parsed.href,
      blockedOrigin: parsed.origin
    });
  }
  return parsed.href;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || '');
  const fullBytes = Buffer.byteLength(text);
  if (fullBytes <= maxBytes) return { text, bytes: fullBytes, fullBytes, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes) end -= 1;
  const bounded = text.slice(0, end);
  return { text: bounded, bytes: Buffer.byteLength(bounded), fullBytes, truncated: true };
}

function redirectChain(response) {
  if (!response) return [];
  const chain = [];
  let request = response.request();
  while (request) {
    chain.unshift(request.url());
    request = request.redirectedFrom();
  }
  return chain;
}

async function createBrowserSession(options = {}) {
  const executablePath = configuredExecutable();
  if (!executablePath) {
    throw browserError(
      'BROWSER_TARGET_UNAVAILABLE',
      'Browser engine is unavailable; set BROWSER_ENGINE_EXECUTABLE to an executable Chromium binary'
    );
  }

  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const navTimeoutMs = Number.isInteger(options.navTimeoutMs) && options.navTimeoutMs > 0
    ? options.navTimeoutMs
    : 30000;
  let playwright;
  try {
    // Keep the heavy optional runtime dependency isolated to this wrapper.
    playwright = require('playwright-core');
  } catch (cause) {
    throw browserError('BROWSER_TARGET_UNAVAILABLE', 'playwright-core is unavailable', { cause: cause.message });
  }

  let browser;
  let context;
  let page;
  const blockedRequests = [];
  try {
    browser = await playwright.chromium.launch({ executablePath, headless: true });
    context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const requestUrl = route.request().url();
      try {
        assertAllowedUrl(requestUrl, allowedOrigins);
        await route.continue();
      } catch (error) {
        blockedRequests.push({ url: requestUrl, code: 'BROWSER_ORIGIN_BLOCKED' });
        await route.abort('blockedbyclient');
      }
    });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(navTimeoutMs);
  } catch (cause) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    throw browserError('BROWSER_TARGET_UNAVAILABLE', `Browser engine failed to launch: ${cause.message}`);
  }

  function takeBlockedRequests() {
    return blockedRequests.splice(0, blockedRequests.length);
  }

  async function pageState() {
    return { url: page.url(), title: await page.title() };
  }

  // Canonical observation inventory. The elementId numbering, visibility
  // mapping, and field shapes here are the single authority for BOTH the
  // model-visible `observe` result and Phase-2 interaction provenance: an
  // interaction resolves its target positionally over this exact set, never
  // through a model-supplied selector.
  const collectInventory = (nodes, limit) => {
    const visible = node => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const collected = [];
    for (let rawIndex = 0; rawIndex < nodes.length; rawIndex += 1) {
      const node = nodes[rawIndex];
      if (!visible(node)) continue;
      if (collected.length >= limit) break;
      const tag = node.tagName.toLowerCase();
      const type = String(node.getAttribute('type') || '').toLowerCase();
      collected.push({
        elementId: `observed-${collected.length + 1}`,
        rawIndex,
        role: node.getAttribute('role') || tag,
        name: (node.getAttribute('aria-label') || node.getAttribute('alt') || '').slice(0, 200),
        text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        enabled: !node.disabled,
        // Canonical credential-sensitivity marker (Phase-2 fill redaction
        // authority). Field values are deliberately never inventoried.
        sensitive: tag === 'input' && type === 'password',
        fillable: (tag === 'input' || tag === 'textarea' || tag === 'select') &&
          !(tag === 'input' && ['checkbox', 'radio', 'file', 'submit', 'button', 'image', 'reset'].includes(type)),
        select: tag === 'select'
      });
    }
    return collected;
  };

  // Model-visible element shape (Phase 1 shape plus the `sensitive` marker).
  function toModelElement(record) {
    return {
      elementId: record.elementId,
      role: record.role,
      name: record.name,
      text: record.text,
      enabled: record.enabled,
      sensitive: record.sensitive
    };
  }

  // Canonical page-state identity: identical to the server-side observe
  // receipt computation — sha256 over {url, title, elements} in the
  // model-visible element shape.
  function inventoryHash(url, title, elements) {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ url, title, elements: elements.map(toModelElement) }))
      .digest('hex');
  }

  async function inventoryState(maxElements = 100) {
    return runGuarded(async () => {
      const state = await pageState();
      const elements = await page.locator(OBSERVED_ELEMENT_SELECTOR)
        .evaluateAll(collectInventory, Math.max(1, Math.min(maxElements, 100)));
      return {
        url: state.url,
        title: state.title,
        truncated: elements.length >= Math.max(1, Math.min(maxElements, 100)),
        elements,
        pageStateHash: inventoryHash(state.url, state.title, elements)
      };
    });
  }

  // Post-interaction origin containment is enforced by the context-level route
  // guard and the blocked-request check in runGuarded; this bounded settle only
  // lets an interaction-triggered navigation finish before the post state is
  // captured, so the recorded post page-state identity is truthful. The post
  // inventory probe retries once after the settle, because an interaction that
  // triggers an immediate navigation can destroy the frame's execution context
  // while the first probe runs; the click/press effect is real and the page
  // settles on the post-interaction document.
  async function settleAfterInteraction() {
    await page.waitForLoadState('domcontentloaded', { timeout: navTimeoutMs }).catch(() => {});
  }

  // Post-interaction state capture MUST NOT run inside a nested runGuarded:
  // a nested guard's start-of-operation cleanup would consume the interaction's
  // blocked-origin records before the interaction's own runGuarded check sees
  // them, which would let an out-of-allowlist interaction effect appear as a
  // clean success. These probes are therefore unguarded and read-only.
  async function unguardedPageState() {
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  async function unguardedInventory(maxElements = 100) {
    const state = await unguardedPageState();
    const elements = await page.locator(OBSERVED_ELEMENT_SELECTOR)
      .evaluateAll(collectInventory, Math.max(1, Math.min(maxElements, 100)));
    return {
      url: state.url,
      title: state.title,
      truncated: elements.length >= Math.max(1, Math.min(maxElements, 100)),
      elements,
      pageStateHash: inventoryHash(state.url, state.title, elements)
    };
  }

  async function postInteractionState() {
    try {
      return await unguardedInventory();
    } catch (error) {
      if (!/Execution context was destroyed|navigation/i.test(String(error && error.message))) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: navTimeoutMs }).catch(() => {});
      return await unguardedInventory();
    }
  }

  async function resolveInteractionTarget(elementId, allowedPageStateHashes) {
    const current = await inventoryState();
    if (!allowedPageStateHashes.includes(current.pageStateHash)) {
      throw browserError('BROWSER_ELEMENT_STALE',
        'Page state changed since the observation that minted this elementId; re-observe to recover', {
        expectedPageStateHashes: [...allowedPageStateHashes],
        actualPageStateHash: current.pageStateHash
      });
    }
    const target = current.elements.find(element => element.elementId === elementId);
    if (!target) {
      throw browserError('BROWSER_ELEMENT_NOT_FOUND', `Observed element is unknown for this run: ${elementId}`, { elementId });
    }
    return { current, target };
  }

  function unwrapClickDispatch(error) {
    // A click that triggers an immediate navigation can destroy the frame's
    // execution context after the click was dispatched. The click's effect is
    // real; fall through to the post-interaction state capture instead of
    // misclassifying this as session loss.
    return Boolean(error && /Execution context was destroyed|navigation/i.test(String(error.message)));
  }

  async function runGuarded(operation) {
    takeBlockedRequests();
    try {
      const result = await operation();
      const blocked = takeBlockedRequests();
      if (blocked.length > 0) {
        throw browserError('BROWSER_ORIGIN_BLOCKED', `Browser request origin is not allowed: ${blocked[0].url}`, {
          blockedUrl: blocked[0].url,
          blockedRequests: blocked
        });
      }
      return result;
    } catch (error) {
      const blocked = takeBlockedRequests();
      if (error && error.code && error.code.startsWith('BROWSER_')) throw error;
      if (blocked.length > 0) {
        throw browserError('BROWSER_ORIGIN_BLOCKED', `Browser request origin is not allowed: ${blocked[0].url}`, {
          blockedUrl: blocked[0].url,
          blockedRequests: blocked
        });
      }
      if (error && (error.name === 'TimeoutError' || /Timeout/i.test(error.message || ''))) {
        throw browserError('BROWSER_TIMEOUT', `Browser operation timed out: ${error.message}`);
      }
      if (!browser.isConnected() || page.isClosed()) {
        throw browserError('BROWSER_SESSION_LOST', 'Browser session was lost');
      }
      throw browserError('BROWSER_SESSION_LOST', `Browser operation failed: ${error.message || String(error)}`);
    }
  }

  return {
    async navigate(url) {
      const requestedUrl = assertAllowedUrl(url, allowedOrigins);
      return runGuarded(async () => {
        const response = await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
        const state = await pageState();
        return {
          requestedUrl,
          finalUrl: state.url,
          status: response ? response.status() : null,
          title: state.title,
          redirectChain: redirectChain(response)
        };
      });
    },

    async observe(maxElements = 100) {
      const state = await inventoryState(maxElements);
      return {
        url: state.url,
        title: state.title,
        elements: state.elements.map(toModelElement),
        truncated: state.truncated
      };
    },

    async clickElement(elementId, allowedPageStateHashes = []) {
      return runGuarded(async () => {
        const { current, target } = await resolveInteractionTarget(elementId, allowedPageStateHashes);
        const before = {
          url: current.url,
          title: current.title,
          pageStateHash: current.pageStateHash
        };
        try {
          await page.locator(OBSERVED_ELEMENT_SELECTOR).nth(target.rawIndex).click({ timeout: navTimeoutMs });
        } catch (error) {
          if (!unwrapClickDispatch(error)) throw error;
        }
        await settleAfterInteraction();
        const post = await postInteractionState();
        return {
          elementId,
          role: target.role,
          name: target.name,
          before,
          after: { url: post.url, title: post.title, pageStateHash: post.pageStateHash }
        };
      });
    },

    async fillElement(elementId, value, allowedPageStateHashes = []) {
      if (typeof value !== 'string') {
        throw browserError('BROWSER_FILL_VALUE_INVALID', 'fill requires a string value', { elementId: String(elementId) });
      }
      return runGuarded(async () => {
        const { current, target } = await resolveInteractionTarget(elementId, allowedPageStateHashes);
        if (!target.fillable) {
          throw browserError('BROWSER_ELEMENT_NOT_FILLABLE',
            `Observed element cannot be filled: ${elementId} (${target.role})`, {
            elementId,
            role: target.role
          });
        }
        const before = {
          url: current.url,
          title: current.title,
          pageStateHash: current.pageStateHash
        };
        const locator = page.locator(OBSERVED_ELEMENT_SELECTOR).nth(target.rawIndex);
        if (target.select) {
          await locator.selectOption(value, { timeout: navTimeoutMs });
        } else {
          await locator.fill(value, { timeout: navTimeoutMs });
        }
        await settleAfterInteraction();
        const post = await postInteractionState();
        return {
          elementId,
          role: target.role,
          name: target.name,
          sensitive: target.sensitive,
          before,
          after: { url: post.url, title: post.title, pageStateHash: post.pageStateHash }
        };
      });
    },

    async pressKey(key) {
      if (!INTERACTION_KEY_ALLOWLIST.includes(key)) {
        throw browserError('BROWSER_KEY_NOT_ALLOWED', `Keyboard key is not on the press allowlist: ${String(key)}`, { key: String(key) });
      }
      return runGuarded(async () => {
        const current = await inventoryState();
        const before = { url: current.url, title: current.title, pageStateHash: current.pageStateHash };
        await page.keyboard.press(key);
        await settleAfterInteraction();
        const post = await postInteractionState();
        return {
          key,
          before,
          after: { url: post.url, title: post.title, pageStateHash: post.pageStateHash }
        };
      });
    },

    async readPageText(maxBytes) {
      return runGuarded(async () => {
        const state = await pageState();
        const text = await page.locator('body').innerText().catch(() => '');
        const normalized = text.replace(/\s+/g, ' ').trim();
        return { ...state, ...truncateUtf8(normalized, maxBytes) };
      });
    },

    async screenshot(filePath) {
      return runGuarded(async () => {
        const state = await pageState();
        await page.screenshot({ path: filePath, fullPage: true });
        return { ...state, path: filePath };
      });
    },

    async wait(forMs, capMs) {
      const boundedMs = Math.max(0, Math.min(Number(forMs) || 0, capMs));
      return runGuarded(async () => {
        await page.waitForTimeout(boundedMs);
        return { ...(await pageState()), requestedMs: Number(forMs) || 0, waitedMs: boundedMs, truncated: boundedMs !== Number(forMs) };
      });
    },

    pageState,

    async close() {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  };
}

module.exports = { createBrowserSession, isEngineAvailable, getEngineStatus };
