const fs = require('fs');
const path = require('path');

function buildContext(rootDir, options = {}) {
    const ignoredPaths = options.ignoredPaths || [];

    // Normalize ignored paths for exact matching to use forward slashes and relative to rootDir
    const normalizedIgnoredPaths = ignoredPaths.map(p => {
        // Convert to posix style (slash) paths
        let relPath = p;
        if (path.isAbsolute(p)) {
            // Make relative to rootDir
            relPath = path.relative(rootDir, p);
        }
        return relPath.split(path.sep).join('/');
    });

    let files = [];
    try {
        files = fs.readdirSync(rootDir);
    } catch (err) {
        files = [];
    }

    // Filter files to exclude exact ignored root entries
    const filteredFiles = files.filter(f => !normalizedIgnoredPaths.includes(f.split(path.sep).join('/')));

    function isIgnored(targetPath) {
        // Normalize separators to slash
        let relPath = targetPath;
        if (path.isAbsolute(targetPath)) {
            relPath = path.relative(rootDir, targetPath);
        }
        relPath = relPath.split(path.sep).join('/');

        // Exact match with any ignored path
        return normalizedIgnoredPaths.includes(relPath);
    }

    return Object.assign({
        rootDir,
        ignoredPaths: normalizedIgnoredPaths,
        files: filteredFiles,
        isIgnored
    }, options);
}

function validatePath(basePath, targetPath) {
    const resolvedBase = path.resolve(basePath);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

function formatResults(results) {
    return results.map(r => {
        return `${r.rule}: ${r.passed ? 'PASSED' : 'FAILED'} - ${r.description}`;
    }).join('\n');
}

module.exports = {
    buildContext,
    validatePath,
    formatResults
};
