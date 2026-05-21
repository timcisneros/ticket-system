// Rules engine module

const rules = [];

// Modified createRule with optional severity (default 'error')
function createRule(name, predicate, description, severity = 'error') {
    const sev = severity || 'error';
    const rule = { name, predicate, description, severity: sev };
    rules.push(rule);
    return rule;
}

function addRule(rule) {
    if (rule && rule.name && typeof rule.predicate === 'function') {
        if (!rule.severity) {
            rule.severity = 'error';
        }
        rules.push(rule);
    } else {
        throw new Error('Invalid rule format');
    }
}

function checkRules(context) {
    const results = rules.map(rule => {
        let passed = false;
        try {
            passed = rule.predicate(context);
        } catch (e) {
            passed = false;
        }
        return { rule: rule.name, passed, description: rule.description, severity: rule.severity };
    });
    const passed = results.every(r => r.passed);
    return { passed, results };
}

module.exports = {
    createRule,
    addRule,
    checkRules
};
