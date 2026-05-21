// Reporter module for governance-kernel

function generateTextReport(results, options = {}) {
    // results is expected to be an array with items having: rule, passed, description, severity, and possibly error
    const counts = { pass: 0, fail: 0 };
    const lines = results.map(r => {
        const severitySegment = r.severity ? `[severity:${r.severity.toLowerCase()}]` : '';
        if (r.passed) {
            counts.pass++;
            return `PASS ${r.rule}${severitySegment ? ' ' + severitySegment : ''} - ${r.description}`;
        } else {
            counts.fail++;
            return `FAIL ${r.rule}${severitySegment ? ' ' + severitySegment : ''} - ${r.description}` + (r.error ? ` (Error: ${r.error})` : '');
        }
    });
    const summary = `\nSummary:\nPassed: ${counts.pass}\nFailed: ${counts.fail}\nTotal: ${results.length}`;
    return lines.join('\n') + summary;
}

function generateJsonReport(results) {
    // returns a JSON string with structured data
    const summary = {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length
    };
    // Include severity in details
    const details = results.map(r => {
        const detail = {
            rule: r.rule,
            passed: r.passed,
            description: r.description,
            severity: r.severity
        };
        if (r.error) detail.error = r.error.toString();
        return detail;
    });
    return JSON.stringify({ summary, details }, null, 2);
}

module.exports = {
    generateTextReport,
    generateJsonReport
};
