const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');

// Helper to check if path is a markdown file
function isMarkdownFile(file) {
  return file.endsWith('.md');
}

// Helper to extract links from markdown content
// Matches [text](link) - captures link
function extractLinks(content) {
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  const links = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return links;
}

// Helper to check URL (http or https)
function checkHttpUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => {
      req.abort();
      resolve(false);
    });
  });
}

// Helper to check local file existence
async function checkLocalLink(baseDir, link) {
  try {
    const fullPath = path.resolve(baseDir, link);
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

// Concurrency pool helper
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

// Recursive directory scan to find all markdown files
async function findMarkdownFiles(dir) {
  const skipDirs = new Set(['node_modules', '.git', '.opencode']);
  try {
    let results = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith('.')) {
          // Skip node_modules, .git, .opencode and hidden directories
          continue;
        }
        const nested = await findMarkdownFiles(fullPath);
        results = results.concat(nested);
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        results.push(fullPath);
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

// Main export function: checkLinks(dir) with recursive scanning
async function checkLinks(dir) {
  const mdFilePaths = await findMarkdownFiles(dir);

  const results = {};

  for (const filePath of mdFilePaths) {
    const content = await fs.readFile(filePath, 'utf-8');
    const links = extractLinks(content);
    const baseDir = path.dirname(filePath);

    const checkLink = async (link) => {
      if (/^https?:\/\//i.test(link)) {
        return { link, ok: await checkHttpUrl(link) };
      } else {
        return { link, ok: await checkLocalLink(baseDir, link) };
      }
    };

    const checked = await asyncPool(5, links, checkLink);

    results[filePath] = checked;
  }

  return results;
}

module.exports = {
  checkLinks,
  isMarkdownFile,
  extractLinks,
  checkHttpUrl,
  checkLocalLink,
  asyncPool,
  findMarkdownFiles,
};
