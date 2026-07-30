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
import { ProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';

/**
 * Asserts one rejection is a discovery failure carrying the OpenCode catalog.
 *
 * The catalog has to ride along on the error: it is the only thing
 * `providerModelsService` can answer with when no snapshot exists.
 */
const assertOpenCodeDiscoveryFailure = (error: unknown): true => {
  assert.ok(
    error instanceof ProviderModelsDiscoveryError,
    `expected a ProviderModelsDiscoveryError, got ${String(error)}`,
  );
  assert.equal(error.name, 'ProviderModelsDiscoveryError');
  assert.deepEqual(error.fallback, OPENCODE_FALLBACK_MODELS);
  return true;
};

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

test('OpenCodeProviderModels returns the live catalog from verbose output', async () => {
  const provider = new OpenCodeProviderModels({
    runModelsCommand: async () => `
opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "status": "active"
}
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5",
  "status": "active"
}
`,
  });

  const definition = await provider.getSupportedModels();

  assert.deepEqual(
    definition.OPTIONS.map((option) => option.value),
    ['opencode/big-pickle', 'anthropic/claude-sonnet-5'],
  );
  assert.equal(definition.DEFAULT, 'opencode/big-pickle');
});

test('OpenCodeProviderModels still reads plain output when no verbose block is printed', async () => {
  const provider = new OpenCodeProviderModels({
    runModelsCommand: async () => `
opencode/big-pickle
openai/gpt-5.5-pro
`,
  });

  const definition = await provider.getSupportedModels();

  assert.deepEqual(
    definition.OPTIONS.map((option) => option.value),
    ['opencode/big-pickle', 'openai/gpt-5.5-pro'],
  );
  assert.equal(definition.DEFAULT, 'opencode/big-pickle');
});

test('OpenCodeProviderModels keeps the models it recognized in partially valid output', async () => {
  const provider = new OpenCodeProviderModels({
    runModelsCommand: async () => `
Loading providers...
openai/gpt-5.5-pro
this line is not a model id
{ "half": "a verbose block"
opencode/big-pickle
`,
  });

  const definition = await provider.getSupportedModels();

  assert.deepEqual(
    definition.OPTIONS.map((option) => option.value),
    ['openai/gpt-5.5-pro', 'opencode/big-pickle'],
  );
  assert.equal(definition.DEFAULT, 'opencode/big-pickle');
});

test('OpenCodeProviderModels reports empty output as a failed discovery', async () => {
  for (const stdout of ['', '   \n\n']) {
    const provider = new OpenCodeProviderModels({ runModelsCommand: async () => stdout });

    await assert.rejects(
      () => provider.getSupportedModels(),
      assertOpenCodeDiscoveryFailure,
      `expected discovery to fail for stdout ${JSON.stringify(stdout)}`,
    );
  }
});

test('OpenCodeProviderModels reports fully malformed output as a failed discovery', async () => {
  const provider = new OpenCodeProviderModels({
    runModelsCommand: async () => 'Loading providers...\nno models are connected\n<<<>>>\n',
  });

  await assert.rejects(() => provider.getSupportedModels(), assertOpenCodeDiscoveryFailure);
});

test('OpenCodeProviderModels reports output with only unsupported providers as a failed discovery', async () => {
  const verboseProvider = new OpenCodeProviderModels({
    runModelsCommand: async () => `
google/model-alpha
{
  "id": "model-alpha",
  "providerID": "google",
  "name": "Model Alpha"
}
`,
  });
  await assert.rejects(() => verboseProvider.getSupportedModels(), assertOpenCodeDiscoveryFailure);

  const plainProvider = new OpenCodeProviderModels({
    runModelsCommand: async () => 'google/model-alpha\ngoogle/model-beta\n',
  });
  await assert.rejects(() => plainProvider.getSupportedModels(), assertOpenCodeDiscoveryFailure);
});

test('OpenCodeProviderModels reports a failed CLI run as a failed discovery', async () => {
  const runFailure = new Error('opencode models exited with code 1');
  const provider = new OpenCodeProviderModels({
    runModelsCommand: async () => {
      throw runFailure;
    },
  });

  await assert.rejects(() => provider.getSupportedModels(), (error: unknown) => {
    assertOpenCodeDiscoveryFailure(error);
    // The original failure stays attached so logs keep naming the real cause.
    assert.equal((error as ProviderModelsDiscoveryError).cause, runFailure);
    return true;
  });
});

test('OpenCodeProviderModels keeps naming a default model when discovery fails', async () => {
  const provider = new OpenCodeProviderModels({
    runModelsCommand: async () => {
      throw new Error('opencode models timed out');
    },
  });

  // No session id: answers straight from the catalog.
  assert.deepEqual(await provider.getCurrentActiveModel(), {
    model: OPENCODE_FALLBACK_MODELS.DEFAULT,
  });

  // A session that OpenCode has no row for falls through the same path.
  assert.deepEqual(
    await provider.getCurrentActiveModel('session-that-does-not-exist'),
    { model: OPENCODE_FALLBACK_MODELS.DEFAULT },
  );
});
