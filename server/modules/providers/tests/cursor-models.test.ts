import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCursorModelsDefinition,
  CURSOR_FALLBACK_MODELS,
  CursorProviderModels,
  parseModelsOutput,
} from '@/modules/providers/list/cursor/cursor-models.provider.js';

test('Cursor models parser extracts marked default model', () => {
  const output = `
Available models
gpt-5.6-sol-high - GPT-5.6 Sol High (default)
composer-2.5-fast - Composer 2.5 Fast
  `;
  const parsed = parseModelsOutput(output);
  const definition = buildCursorModelsDefinition(parsed);

  assert.equal(definition.DEFAULT, 'gpt-5.6-sol-high');
  assert.equal(definition.OPTIONS.length, 2);
});

test('Cursor models uses composer-2.5-fast when no default is explicitly marked by CLI', () => {
  const output = `
Available models
gpt-5.6-sol-high - GPT-5.6 Sol High
composer-2.5-fast - Composer 2.5 Fast
claude-sonnet-5-high - Sonnet 5
  `;
  const parsed = parseModelsOutput(output);
  const definition = buildCursorModelsDefinition(parsed);

  assert.equal(definition.DEFAULT, 'composer-2.5-fast');
});

test('Cursor models uses first available model when marked default and composer-2.5-fast are absent', () => {
  const output = `
Available models
custom-model-alpha - Custom Alpha
custom-model-beta - Custom Beta
  `;
  const parsed = parseModelsOutput(output);
  const definition = buildCursorModelsDefinition(parsed);

  assert.equal(definition.DEFAULT, 'custom-model-alpha');
});

test('Cursor fallback catalog does not contain obsolete model IDs', () => {
  const values = CURSOR_FALLBACK_MODELS.OPTIONS.map((opt) => opt.value);
  const obsoletePrefixes = ['gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1-codex', 'claude-4', 'grok-4.3'];

  for (const value of values) {
    for (const prefix of obsoletePrefixes) {
      assert.equal(
        value.startsWith(prefix),
        false,
        `Fallback model list should not contain obsolete model: ${value}`,
      );
    }
  }
  assert.equal(CURSOR_FALLBACK_MODELS.DEFAULT, 'composer-2.5-fast');
});

test('CursorProviderModels falls back gracefully when CLI list is empty or fails', async () => {
  const provider = new CursorProviderModels();
  // Call getSupportedModels when cursor-agent may fail or succeed; definition must be valid
  const definition = await provider.getSupportedModels();
  assert.ok(definition.OPTIONS.length > 0);
  assert.ok(typeof definition.DEFAULT === 'string');
});
