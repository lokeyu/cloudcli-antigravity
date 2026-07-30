import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexModelsDefinition,
  CODEX_FALLBACK_MODELS,
  CodexProviderModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';
import { ProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';

/**
 * Asserts one rejection is a discovery failure carrying the Codex catalog.
 *
 * The catalog has to ride along on the error: it is the only thing
 * `providerModelsService` can answer with when no snapshot exists.
 */
const assertCodexDiscoveryFailure = (error: unknown): true => {
  assert.ok(
    error instanceof ProviderModelsDiscoveryError,
    `expected a ProviderModelsDiscoveryError, got ${String(error)}`,
  );
  assert.equal(error.name, 'ProviderModelsDiscoveryError');
  assert.deepEqual(error.fallback, CODEX_FALLBACK_MODELS);
  return true;
};

/** A models cache holding one listable model, serialized the way Codex writes it. */
const createCodexCacheJson = (): string => JSON.stringify({
  models: [
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', priority: 1, visibility: 'list' },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', priority: 7, visibility: 'list' },
    { slug: 'codex-auto-review', priority: 0, visibility: 'hide' },
  ],
});

test('Codex models picks model with best numerical priority as default', () => {
  const definition = buildCodexModelsDefinition([
    { slug: 'gpt-5.4', priority: 16, visibility: 'list' },
    { slug: 'gpt-5.6-sol', priority: 1, visibility: 'list' },
    { slug: 'gpt-5.5', priority: 7, visibility: 'list' },
  ]);

  assert.equal(definition.DEFAULT, 'gpt-5.6-sol');
  assert.equal(definition.OPTIONS[0].value, 'gpt-5.6-sol');
});

test('Codex models works when best priority is non-1', () => {
  const definition = buildCodexModelsDefinition([
    { slug: 'model-b', priority: 15, visibility: 'list' },
    { slug: 'model-a', priority: 5, visibility: 'list' },
  ]);

  assert.equal(definition.DEFAULT, 'model-a');
  assert.equal(definition.OPTIONS[0].value, 'model-a');
});

test('Codex models ignores hidden model even if it has best priority', () => {
  const definition = buildCodexModelsDefinition([
    { slug: 'codex-auto-review', priority: 1, visibility: 'hide' },
    { slug: 'gpt-5.6-sol', priority: 2, visibility: 'list' },
  ]);

  assert.equal(definition.DEFAULT, 'gpt-5.6-sol');
  assert.deepEqual(
    definition.OPTIONS.map((opt) => opt.value),
    ['gpt-5.6-sol'],
  );
});

test('Codex models preserves file order when priorities are equal', () => {
  const definition = buildCodexModelsDefinition([
    { slug: 'first-model', priority: 10, visibility: 'list' },
    { slug: 'second-model', priority: 10, visibility: 'list' },
  ]);

  assert.equal(definition.DEFAULT, 'first-model');
  assert.deepEqual(
    definition.OPTIONS.map((opt) => opt.value),
    ['first-model', 'second-model'],
  );
});

test('Codex models maps reasoning levels correctly', () => {
  const definition = buildCodexModelsDefinition([
    {
      slug: 'gpt-5.6-sol',
      priority: 1,
      visibility: 'list',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Low effort' },
        { effort: 'medium', description: 'Medium effort' },
        { effort: 'high', description: 'High effort' },
      ],
    },
  ]);

  const modelOpt = definition.OPTIONS[0];
  assert.equal(modelOpt.effort?.default, 'low');
  assert.deepEqual(modelOpt.effort?.values, [
    { value: 'low', description: 'Low effort' },
    { value: 'medium', description: 'Medium effort' },
    { value: 'high', description: 'High effort' },
  ]);
});

test('CodexProviderModels returns the live catalog from a valid models cache', async () => {
  const provider = new CodexProviderModels({
    readModelsCache: async () => createCodexCacheJson(),
  });

  const definition = await provider.getSupportedModels();

  // Priority order is preserved and the hidden entry never becomes selectable.
  assert.deepEqual(definition.OPTIONS.map((option) => option.value), ['gpt-5.6-sol', 'gpt-5.4']);
  assert.deepEqual(definition.OPTIONS.map((option) => option.label), ['GPT-5.6 Sol', 'GPT-5.4']);
  assert.equal(definition.DEFAULT, 'gpt-5.6-sol');
});

test('CodexProviderModels reports a missing models cache as a failed discovery', async () => {
  const missingFile = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  const provider = new CodexProviderModels({
    readModelsCache: async () => {
      throw missingFile;
    },
  });

  await assert.rejects(() => provider.getSupportedModels(), (error: unknown) => {
    assertCodexDiscoveryFailure(error);
    // The original read failure stays attached so logs keep naming the real cause.
    assert.equal((error as ProviderModelsDiscoveryError).cause, missingFile);
    return true;
  });
});

test('CodexProviderModels reports an unparseable models cache as a failed discovery', async () => {
  for (const raw of ['', 'not json at all', '{"models": [', '\u0000\u0001binary garbage']) {
    const provider = new CodexProviderModels({ readModelsCache: async () => raw });

    await assert.rejects(
      () => provider.getSupportedModels(),
      assertCodexDiscoveryFailure,
      `expected discovery to fail for cache contents ${JSON.stringify(raw)}`,
    );
  }
});

test('CodexProviderModels reports a cache without listable models as a failed discovery', async () => {
  const cacheVariants = [
    JSON.stringify({ models: [] }),
    JSON.stringify({ models: [{ slug: 'codex-auto-review', priority: 1, visibility: 'hide' }] }),
    JSON.stringify({ models: [{ slug: 'gpt-5.4', visibility: 'list', supported_in_api: false }] }),
    JSON.stringify({ models: [{ display_name: 'no slug at all', visibility: 'list' }] }),
    JSON.stringify({ unexpected: 'shape' }),
  ];

  for (const raw of cacheVariants) {
    const provider = new CodexProviderModels({ readModelsCache: async () => raw });

    await assert.rejects(
      () => provider.getSupportedModels(),
      assertCodexDiscoveryFailure,
      `expected discovery to fail for cache contents ${raw}`,
    );
  }
});

test('CodexProviderModels keeps naming a default model when discovery fails', async () => {
  const provider = new CodexProviderModels({
    readModelsCache: async () => {
      throw new Error('ENOENT: no such file');
    },
    readConfig: async () => {
      throw new Error('ENOENT: no such file');
    },
  });

  assert.deepEqual(await provider.getCurrentActiveModel(), {
    model: CODEX_FALLBACK_MODELS.DEFAULT,
  });
});

test('CodexProviderModels reads the configured model even when discovery fails', async () => {
  const provider = new CodexProviderModels({
    readModelsCache: async () => {
      throw new Error('ENOENT: no such file');
    },
    readConfig: async () => 'model = "gpt-5.6-sol"\n',
  });

  assert.deepEqual(await provider.getCurrentActiveModel(), { model: 'gpt-5.6-sol' });
});

test('CodexProviderModels falls back to the catalog default when the config names no model', async () => {
  const provider = new CodexProviderModels({
    readModelsCache: async () => createCodexCacheJson(),
    readConfig: async () => 'approval_policy = "never"\n',
  });

  assert.deepEqual(await provider.getCurrentActiveModel(), { model: 'gpt-5.6-sol' });
});
