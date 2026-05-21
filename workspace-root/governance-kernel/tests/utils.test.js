const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const test = require('node:test');
const os = require('os');
const { buildContext } = require('../src/utils');

function createDirStructure(baseDir) {
    // Create files and folders
    fs.writeFileSync(path.join(baseDir, 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(baseDir, 'node_modules'));
    fs.mkdirSync(path.join(baseDir, 'dist'));
    fs.mkdirSync(path.join(baseDir, 'coverage'));
    fs.mkdirSync(path.join(baseDir, 'node_modules_extra'));
}

test.describe('buildContext ignoredPaths exact matching', () => {
    let tmpDir;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-ctx-'));
        createDirStructure(tmpDir);
    });

    test.afterEach(() => {
        // Remove everything inside tmpDir synchronously
        function rmrf(dir) {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, entry);
                if (fs.lstatSync(fullPath).isDirectory()) {
                    rmrf(fullPath);
                } else {
                    fs.unlinkSync(fullPath);
                }
            }
            fs.rmdirSync(dir);
        }
        rmrf(tmpDir);
    });

    test.it('no ignoredPaths preserves files array', () => {
        const ctx = buildContext(tmpDir);
        assert.deepStrictEqual(ctx.ignoredPaths, []);

        // It includes all the direct entries
        assert(ctx.files.includes('keep.txt'));
        assert(ctx.files.includes('node_modules'));
        assert(ctx.files.includes('dist'));
        assert(ctx.files.includes('coverage'));
        assert(ctx.files.includes('node_modules_extra'));

        assert.strictEqual(ctx.isIgnored(path.join(tmpDir, 'node_modules')), false);
        assert.strictEqual(ctx.isIgnored(path.join(tmpDir, 'dist')), false);
        assert.strictEqual(ctx.isIgnored(path.join(tmpDir, 'coverage')), false);
        assert.strictEqual(ctx.isIgnored(path.join(tmpDir, 'node_modules_extra')), false);
    });

    test.it('ignoredPaths entries are preserved exactly and filtered from files', () => {
        const ignored = ['node_modules', 'dist', 'coverage'];
        const ctx = buildContext(tmpDir, { ignoredPaths: ignored });

        // Normalized ignoredPaths are exactly those
        assert.deepStrictEqual(ctx.ignoredPaths.sort(), ignored.sort());

        // files exclude ignored entries exactly
        assert(!ctx.files.includes('node_modules'));
        assert(!ctx.files.includes('dist'));
        assert(!ctx.files.includes('coverage'));

        // files includes those not ignored
        assert(ctx.files.includes('keep.txt'));
        assert(ctx.files.includes('node_modules_extra'));

        // isIgnored true for exact ignored root entries
        assert(ctx.isIgnored(path.join(tmpDir, 'node_modules')));
        assert(ctx.isIgnored(path.join(tmpDir, 'dist')));
        assert(ctx.isIgnored(path.join(tmpDir, 'coverage')));

        // isIgnored false for partial match
        assert.strictEqual(ctx.isIgnored(path.join(tmpDir, 'node_modules_extra')), false);
    });

    test.it('isIgnored works with relative paths', () => {
        const ignored = ['node_modules', 'dist'];
        const ctx = buildContext(tmpDir, { ignoredPaths: ignored });

        assert(ctx.isIgnored('node_modules'));
        assert(ctx.isIgnored('dist'));
        assert(!ctx.isIgnored('node_modules_extra'));
        assert(!ctx.isIgnored('keep.txt'));
    });

    test.it('isIgnored normalizes separators to slash and matches exact', () => {
        const ignored = ['node_modules', 'dist'];
        const ctx = buildContext(tmpDir, { ignoredPaths: ignored });

        // Path with backslashes (Windows style) normalized
        const weirdPath = 'node_modules'.split('/').join(path.sep);
        assert(ctx.isIgnored(weirdPath));

        // Subdirectory under ignored is not matched exactly
        assert(!ctx.isIgnored('node_modules/somefile'));
    });
});
