import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenCodeDefinitionFromVerboseModels,
  buildOpenCodeDefinitionFromIds,
  parseOpenCodeModelsStdout,
  parseOpenCodeVerboseModelsStdout,
  OPENCODE_FALLBACK_MODELS,
  OpenCodeProviderModels,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

test('OpenCode models provider parses plain CLI output and removes duplicates', () => {
  const ids = parseOpenCodeModelsStdout(`
opencode/big-pickle
not a model
anthropic/claude-opus-4-7-fast
anthropic/claude-opus-4-7-fast
openai/gpt-5.5-pro
`);

  assert.deepEqual(ids, [
    'opencode/big-pickle',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.5-pro',
  ]);
});

test('OpenCode models provider formats frontend labels from provider-prefixed ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-super-free',
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-opus-4-7-fast',
    'google/model-alpha',
    'openai/gpt-5.4-mini-fast',
    'openai/gpt-5.5-pro',
    'newprovider/alpha-v12-special-20261231',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

test('OpenCode models provider maps verbose model variants to effort options and filters inactive status', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "name": "DeepSeek V4 Flash Free",
  "status": "active",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5",
  "status": "active",
  "variants": {
    "low": {
      "effort": "low"
    },
    "max": {
      "effort": "max"
    }
  }
}
inactiveprovider/model-disabled
{
  "id": "model-disabled",
  "providerID": "inactiveprovider",
  "name": "Model Disabled",
  "status": "inactive"
}
google/model-alpha
{
  "id": "model-alpha",
  "providerID": "google",
  "name": "Model Alpha"
}
`);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'DeepSeek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5',
      description: 'anthropic - anthropic/claude-sonnet-5',
      effort: {
        values: [
          { value: 'low' },
          { value: 'max' },
        ],
      },
    },
  ]);
});

test('OpenCode models picks first available connected model if default is not in list', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'custom/first-connected-model',
    'custom/second-connected-model',
  ]);

  assert.equal(definition.DEFAULT, 'custom/first-connected-model');
});

test('OpenCode fallback catalog does not contain old obsolete model IDs', () => {
  const values = OPENCODE_FALLBACK_MODELS.OPTIONS.map((opt) => opt.value);
  assert.equal(values.includes('anthropic/claude-sonnet-4-5'), false);
  assert.equal(values.includes('anthropic/claude-opus-4-1'), false);
  assert.equal(values.includes('openai/gpt-5.1'), false);
  assert.equal(values.includes('openai/gpt-5.1-codex'), false);
  assert.equal(OPENCODE_FALLBACK_MODELS.DEFAULT, 'opencode/big-pickle');
});

test('OpenCodeProviderModels falls back gracefully when discovery fails', async () => {
  const provider = new OpenCodeProviderModels();
  const definition = await provider.getSupportedModels();

  assert.ok(definition.OPTIONS.length > 0);
  assert.ok(typeof definition.DEFAULT === 'string');
});
