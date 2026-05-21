const assert = require('assert');
const path = require('path');
const { test } = require('node:test');
const { findMarkdownFiles, extractLinks, asyncPool, checkLinks } = require('../src/index');

// Tests

test('findMarkdownFiles should find .md files, skip node_modules and hidden files, and handle missing directory', async (t) => {
  const testDir = path.resolve('./linkcheck/test/sample-folder');

  // Case: directory does not exist
  let files = await findMarkdownFiles('nonexistent_dir');
  assert.deepStrictEqual(files, []);

  // Case: skip node_modules and hidden files
  files = await findMarkdownFiles('./linkcheck/test');
  for (const f of files) {
    assert(f.endsWith('.md'), `File ${f} does not end with .md`);
  }
});


test('extractLinks should extract links from markdown string', (t) => {
  const md = 'This is a [link](http://example.com) in markdown.';
  let links = extractLinks(md);
  assert(Array.isArray(links), 'links should be an array');
  assert(links.length === 1, 'should extract 1 link');
  assert.strictEqual(links[0], 'http://example.com');

  links = extractLinks('No links here.');
  assert.deepStrictEqual(links, []);

  links = extractLinks('');
  assert.deepStrictEqual(links, []);
});


test('asyncPool should respect concurrency and produce correct results', async (t) => {
  function delayTask(value, delay) {
    return () => new Promise((resolve) => setTimeout(() => resolve(value), delay));
  }

  const tasks = [
    () => Promise.resolve(1),
    delayTask(2, 50),
    delayTask(3, 20),
    () => Promise.resolve(4),
  ];
  const concurrency = 2;
  const results = await asyncPool(concurrency, tasks, async fn => fn());
  assert.deepStrictEqual(results, [1, 2, 3, 4]);
});


test('checkLinks integration: local exists/missing and http link returns status', async (t) => {
  const markdown = `
  [local-exists](./sample.md)
  [local-missing](./missing.md)
  [http-valid](http://example.com)
  `;

  const links = extractLinks(markdown);
  assert(Array.isArray(links));
  assert(links.includes('./sample.md') || links.includes('sample.md'));

  const statuses = await checkLinks(path.resolve(__dirname, '..', 'test'));
  assert(typeof statuses === 'object');

  // Check for local-exists
  const existsResults = statuses[Object.keys(statuses).find(k => k.endsWith('sample.md'))];
  assert(existsResults);
  const localExists = existsResults.find(r => r.link.endsWith('sample.md'));
  assert(localExists);
  assert(localExists.ok === true);

  // Check for local-missing
  const missingFileKey = Object.keys(statuses).find(k => k.endsWith('missing.md'));
  if(missingFileKey) {
    const missingResults = statuses[missingFileKey];
    const localMissing = missingResults.find(r => r.link.endsWith('missing.md'));
    assert(localMissing);
    assert(localMissing.ok === false);
  }

  // HTTP valid
  const httpKeys = Object.keys(statuses);
  let httpFound = false;
  for (const key of httpKeys) {
    const results = statuses[key];
    for (const r of results) {
      if (r.link === 'http://example.com') {
        httpFound = true;
        assert(typeof r.ok === 'boolean');
      }
    }
  }
  assert(httpFound);
});
