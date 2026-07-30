import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexModelsDefinition,
  CODEX_FALLBACK_MODELS,
  CodexProviderModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';

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

test('CodexProviderModels falls back gracefully when cache file is missing or invalid', async () => {
  const provider = new CodexProviderModels();
  const definition = await provider.getSupportedModels();

  assert.ok(definition.OPTIONS.length > 0);
  assert.ok(typeof definition.DEFAULT === 'string');
});
