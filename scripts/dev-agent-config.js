'use strict';

const { promptHidden, promptVisible } = require('./dev-environment');

const PROVIDERS = Object.freeze(['openai', 'ollama']);
const DEFAULT_AGENT_NAME = 'Developer Agent';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

function normalized(value) {
  return String(value || '').trim();
}

function agentReadiness(agent, env = process.env) {
  const provider = PROVIDERS.includes(agent && agent.provider) ? agent.provider : null;
  const model = normalized(agent && agent.model) ||
    (provider === 'openai' ? normalized(env.OPENAI_MODEL) : normalized(env.OLLAMA_MODEL));
  const hasCredential = provider === 'ollama' ||
    Boolean(normalized(agent && agent.apiKey) || normalized(env.OPENAI_API_KEY));
  const reasons = [];
  if (!provider) reasons.push('unsupported provider');
  if (!model) reasons.push('model is missing');
  if (!hasCredential) reasons.push('OpenAI API key is missing');
  return {
    ready: reasons.length === 0,
    provider,
    modelConfigured: Boolean(model),
    credentialConfigured: hasCredential,
    reasons
  };
}

function providerConfigFromEnvironment(env = process.env) {
  const explicit = normalized(env.DEV_AGENT_PROVIDER).toLowerCase();
  if (explicit && !PROVIDERS.includes(explicit)) {
    throw new Error('DEV_AGENT_PROVIDER must be openai or ollama');
  }
  const openaiReady = Boolean(normalized(env.OPENAI_MODEL) && normalized(env.OPENAI_API_KEY));
  const ollamaReady = Boolean(normalized(env.OLLAMA_MODEL));
  const provider = explicit || (openaiReady ? 'openai' : ollamaReady ? 'ollama' : null);
  if (!provider) return null;
  if (provider === 'openai' && !openaiReady) return null;
  if (provider === 'ollama' && !ollamaReady) return null;
  return {
    name: normalized(env.DEV_AGENT_NAME) || DEFAULT_AGENT_NAME,
    provider,
    model: provider === 'openai' ? normalized(env.OPENAI_MODEL) : normalized(env.OLLAMA_MODEL),
    apiKey: '',
    baseUrl: provider === 'ollama' ? normalized(env.OLLAMA_BASE_URL) || DEFAULT_OLLAMA_BASE_URL : ''
  };
}

async function promptProviderConfig({
  env = process.env,
  visiblePrompt = promptVisible,
  hiddenPrompt = promptHidden
} = {}) {
  const inferred = normalized(env.DEV_AGENT_PROVIDER).toLowerCase() ||
    (normalized(env.OPENAI_API_KEY) ? 'openai' : 'ollama');
  const provider = normalized(await visiblePrompt('Initial agent provider (openai/ollama)', {
    defaultValue: inferred
  })).toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error('Initial agent provider must be openai or ollama');

  const name = normalized(await visiblePrompt('Initial agent name', {
    defaultValue: normalized(env.DEV_AGENT_NAME) || DEFAULT_AGENT_NAME
  }));
  if (!name) throw new Error('Initial agent name is required');

  const configuredModel = provider === 'openai' ? env.OPENAI_MODEL : env.OLLAMA_MODEL;
  const model = normalized(await visiblePrompt(`${provider === 'openai' ? 'OpenAI' : 'Ollama'} model`, {
    defaultValue: normalized(configuredModel)
  }));
  if (!model) throw new Error('Initial agent model is required');

  let apiKey = '';
  let baseUrl = '';
  if (provider === 'openai' && !normalized(env.OPENAI_API_KEY)) {
    apiKey = normalized(await hiddenPrompt('OpenAI API key (stored in local PostgreSQL)'));
    if (!apiKey) throw new Error('OpenAI API key is required');
  }
  if (provider === 'ollama') {
    baseUrl = normalized(await visiblePrompt('Ollama base URL', {
      defaultValue: normalized(env.OLLAMA_BASE_URL) || DEFAULT_OLLAMA_BASE_URL
    }));
  }

  return { name, provider, model, apiKey, baseUrl };
}

async function firstConfiguredAgentPage(store) {
  const page = await store.listConfiguredAgents({ afterId: 0, limit: 100 });
  return {
    agents: Array.isArray(page.agents) ? page.agents : [],
    truncated: page.nextAfterId != null
  };
}

async function ensureInitialAgent({
  store,
  env = process.env,
  interactive = process.stdin.isTTY === true,
  visiblePrompt = promptVisible,
  hiddenPrompt = promptHidden
}) {
  const page = await firstConfiguredAgentPage(store);
  const readyAgent = page.agents.find(agent => agentReadiness(agent, env).ready);
  if (readyAgent) {
    return { created: false, agent: readyAgent, existingCount: page.agents.length, truncated: page.truncated };
  }
  if (page.truncated) {
    throw new Error('No runnable agent was found in the bounded first 100 records; inspect the full catalog in Admin');
  }

  let config = providerConfigFromEnvironment(env);
  if (!config && interactive) {
    config = await promptProviderConfig({ env, visiblePrompt, hiddenPrompt });
  }
  if (!config) {
    throw new Error(
      'No runnable configured agent exists. Set OPENAI_API_KEY and OPENAI_MODEL, or set OLLAMA_MODEL ' +
      '(optionally DEV_AGENT_PROVIDER and DEV_AGENT_NAME), then rerun pnpm dev:setup'
    );
  }

  const existingNames = new Set(page.agents.map(agent => normalized(agent.name).toLowerCase()));
  const baseName = config.name;
  let suffix = 1;
  while (existingNames.has(normalized(config.name).toLowerCase())) {
    suffix += 1;
    config = { ...config, name: baseName + ' ' + suffix };
  }

  const groupPage = await store.listGroups({ afterId: 0, canReceiveTickets: true, limit: 1 });
  const group = Array.isArray(groupPage.groups) ? groupPage.groups[0] : null;
  if (!group) throw new Error('No ticket-capable access group exists for the initial agent');

  const value = {
    name: config.name,
    type: 'agent',
    provider: config.provider,
    model: config.model
  };
  if (config.apiKey) value.apiKey = config.apiKey;
  if (config.baseUrl) value.baseUrl = config.baseUrl;

  const result = await store.createConfiguredAgent({
    value,
    groupIds: [group.id],
    changedBy: 'dev-setup'
  });
  return { created: true, agent: result.agent, group };
}

module.exports = {
  DEFAULT_AGENT_NAME,
  DEFAULT_OLLAMA_BASE_URL,
  PROVIDERS,
  agentReadiness,
  ensureInitialAgent,
  firstConfiguredAgentPage,
  promptProviderConfig,
  providerConfigFromEnvironment
};
