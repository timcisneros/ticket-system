// governance-kernel/src/types.js

function createRuleType(name, schema) {
  return {
    name,
    validate: schema,
  };
}

function validateValue(type, value) {
  if (!type || typeof type.validate !== 'function') {
    throw new Error('Invalid type provided for validation');
  }
  return type.validate(value);
}

const TYPE_STRING = {
  name: 'string',
  validate: (value) => typeof value === 'string',
};

const TYPE_NUMBER = {
  name: 'number',
  validate: (value) => typeof value === 'number' && !Number.isNaN(value),
};

const TYPE_BOOLEAN = {
  name: 'boolean',
  validate: (value) => typeof value === 'boolean',
};

const TYPE_OBJECT = {
  name: 'object',
  validate: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
};

const TYPE_ARRAY = {
  name: 'array',
  validate: (value) => Array.isArray(value),
};

module.exports = {
  createRuleType,
  validateValue,
  TYPE_STRING,
  TYPE_NUMBER,
  TYPE_BOOLEAN,
  TYPE_OBJECT,
  TYPE_ARRAY,
};
