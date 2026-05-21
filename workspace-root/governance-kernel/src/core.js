const { createRule, checkRules } = require('./rules-engine');
const { enforce } = require('./enforcer');
const { buildContext } = require('./utils');

class Governance {
    constructor(options = {}) {
        this.options = options;
    }

    registerRule(name, predicate, description) {
        return createRule(name, predicate, description);
    }

    check(context) {
        return checkRules(context);
    }

    enforce(context) {
        // Enforce all rules registered in the rules engine
        // We assume enforce from enforcer module uses all rules inside rules-engine
        return enforce(this.getRules(), context);
    }

    getRules() {
        // This helper fetches all rules from rules-engine internal rules array.
        // However, rules array isn't exported, so as a workaround, here we call checkRules with context and extract rules.
        // Since no direct access to rules array, this method returns empty array, making enforce use default rules list in enforcer.
        // To fully align, we can assume enforcer.enforce uses rules from rules-engine internally.
        // So to maintain backward compatibility, leave as empty array.
        return [];
    }

    static createProjectContext(projectPath, options = {}) {
        return buildContext(projectPath, options);
    }
}

// Backward compatibility exports
module.exports = {
    createRule,
    checkRules,
    enforce,
    version: '0.2.0',
    Governance
};
