'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

function browserError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureKind = 'browser_error';
  error.detail = detail;
  return error;
}

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
      return runGuarded(async () => {
        const state = await pageState();
        const elements = await page.locator('a,button,input,select,textarea,[role],h1,h2,h3').evaluateAll((nodes, limit) => {
          const visible = node => {
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          return nodes.filter(visible).slice(0, limit).map((node, index) => ({
            elementId: `observed-${index + 1}`,
            role: node.getAttribute('role') || node.tagName.toLowerCase(),
            name: (node.getAttribute('aria-label') || node.getAttribute('alt') || '').slice(0, 200),
            text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
            enabled: !node.disabled
          }));
        }, Math.max(1, Math.min(maxElements, 100)));
        return { ...state, elements, truncated: elements.length >= Math.min(maxElements, 100) };
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
