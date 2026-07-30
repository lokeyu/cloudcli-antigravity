import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCursorModelsDefinition,
  CURSOR_FALLBACK_MODELS,
  CursorProviderModels,
  parseModelsOutput,
} from '@/modules/providers/list/cursor/cursor-models.provider.js';
import { ProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';

/**
 * Asserts one rejection is a discovery failure carrying the Cursor catalog.
 *
 * The catalog has to ride along on the error: it is the only thing
 * `providerModelsService` can answer with when no snapshot exists.
 */
const assertCursorDiscoveryFailure = (error: unknown): true => {
  assert.ok(
    error instanceof ProviderModelsDiscoveryError,
    `expected a ProviderModelsDiscoveryError, got ${String(error)}`,
  );
  assert.equal(error.name, 'ProviderModelsDiscoveryError');
  assert.deepEqual(error.fallback, CURSOR_FALLBACK_MODELS);
  return true;
};

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

test('CursorProviderModels returns the live catalog when the CLI lists models', async () => {
  const provider = new CursorProviderModels({
    listModels: async () => `
Available models
gpt-5.6-sol-high - GPT-5.6 Sol High (default)
composer-2.5-fast - Composer 2.5 Fast
`,
  });

  const definition = await provider.getSupportedModels();

  assert.deepEqual(definition, {
    OPTIONS: [
      { value: 'gpt-5.6-sol-high', label: 'gpt-5.6-sol-high', description: 'GPT-5.6 Sol High' },
      { value: 'composer-2.5-fast', label: 'composer-2.5-fast', description: 'Composer 2.5 Fast' },
    ],
    DEFAULT: 'gpt-5.6-sol-high',
  });
});

test('CursorProviderModels reports empty CLI output as a failed discovery', async () => {
  for (const stdout of ['', '   \n\n', 'Loading models...\nAvailable models\n']) {
    const provider = new CursorProviderModels({ listModels: async () => stdout });

    await assert.rejects(
      () => provider.getSupportedModels(),
      assertCursorDiscoveryFailure,
      `expected discovery to fail for stdout ${JSON.stringify(stdout)}`,
    );
  }
});

test('CursorProviderModels reports a failed CLI run as a failed discovery', async () => {
  const spawnFailure = new Error('spawn cursor-agent ENOENT');
  const provider = new CursorProviderModels({
    listModels: async () => {
      throw spawnFailure;
    },
  });

  await assert.rejects(() => provider.getSupportedModels(), (error: unknown) => {
    assertCursorDiscoveryFailure(error);
    // The original failure stays attached so logs keep naming the real cause.
    assert.equal((error as ProviderModelsDiscoveryError).cause, spawnFailure);
    return true;
  });
});

test('CursorProviderModels reports fully malformed CLI output as a failed discovery', async () => {
  const provider = new CursorProviderModels({
    listModels: async () => '\u0000\u0001binary garbage\n{"unexpected":"json"}\n<<<>>>\n',
  });

  await assert.rejects(() => provider.getSupportedModels(), assertCursorDiscoveryFailure);
});

test('CursorProviderModels keeps naming a default model when discovery fails', async () => {
  const provider = new CursorProviderModels({
    listModels: async () => {
      throw new Error('cursor-agent --list-models timed out');
    },
  });

  // No session id: answers straight from the catalog.
  assert.deepEqual(await provider.getCurrentActiveModel(), {
    model: CURSOR_FALLBACK_MODELS.DEFAULT,
  });

  // A session that has no store on disk falls through the same path.
  assert.deepEqual(
    await provider.getCurrentActiveModel('session-that-does-not-exist'),
    { model: CURSOR_FALLBACK_MODELS.DEFAULT },
  );
});
