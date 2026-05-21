const { checkRules } = require('./rules-engine');

function enforce(rules, context) {
    const results = rules.map(rule => {
        let passed = false;
        try {
            passed = rule.predicate(context);
        } catch (e) {
            passed = false;
        }
        // Normalize severity
        const severity = rule.severity || 'error';
        return { rule: rule.name, passed, description: rule.description, severity };
    });

    const failedRules = results.filter(r => !r.passed);
    if (failedRules.length > 0) {
        const messages = failedRules.map(r => `Rule '${r.rule}' failed [${r.severity.toUpperCase()}]: ${r.description}`);
        throw new Error(messages.join('\n'));
    }
}

function enforceSilent(rules, context) {
    const results = rules.map(rule => {
        let passed = false;
        try {
            passed = rule.predicate(context);
        } catch (e) {
            passed = false;
        }
        // normalize severity here too
        const severity = rule.severity || 'error';
        return { rule: rule.name, passed, description: rule.description, severity };
    });
    const passed = results.every(r => r.passed);
    const failures = results.filter(r => !r.passed);
    return { passed, failures };
}

module.exports = { enforce, enforceSilent };