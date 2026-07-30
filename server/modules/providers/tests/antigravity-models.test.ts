import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANTIGRAVITY_FALLBACK_MODELS,
  AntigravityProviderModels,
  readAntigravityModelOptions,
} from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import {
  isProviderModelsDiscoveryError,
  ProviderModelsDiscoveryError,
} from '@/shared/provider-models-discovery.js';
import type { ProviderModelOption } from '@/shared/types.js';

/**
 * Asserts one rejection is a discovery failure carrying the Antigravity catalog.
 *
 * The catalog has to ride along on the error: it is the only thing
 * `providerModelsService` can answer with when no snapshot exists.
 */
const assertAntigravityDiscoveryFailure = (error: unknown): true => {
  assert.ok(
    error instanceof ProviderModelsDiscoveryError,
    `expected a ProviderModelsDiscoveryError, got ${String(error)}`,
  );
  assert.equal(error.name, 'ProviderModelsDiscoveryError');
  assert.deepEqual(error.fallback, ANTIGRAVITY_FALLBACK_MODELS);
  return true;
};

/** Two live rows, neither of them the shipped default. */
const LIVE_OPTIONS: ProviderModelOption[] = [
  { value: 'gemini-4.0-pro-high', label: 'Gemini 4.0 Pro (High)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
];

/**
 * Runs `body` with a stub `agy` first on PATH.
 *
 * `readAntigravityModelOptions()` takes no seam by design — `AntigravityProviderAuth`
 * calls it directly — so its contract is exercised against a real spawn of a
 * throwaway executable rather than the developer's installed CLI.
 */
const withStubbedAgy = async (script: string, body: () => Promise<void>): Promise<void> => {
  const binDirectory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-agy-stub-'));
  const originalPath = process.env.PATH;

  await writeFile(path.join(binDirectory, 'agy'), script, { mode: 0o755 });
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ''}`;

  try {
    await body();
  } finally {
    process.env.PATH = originalPath;
    await rm(binDirectory, { recursive: true, force: true });
  }
};

test('AntigravityProviderModels returns the live catalog when the CLI lists models', async () => {
  const provider = new AntigravityProviderModels({
    readModelOptions: async () => LIVE_OPTIONS,
  });

  const definition = await provider.getSupportedModels();

  assert.deepEqual(definition.OPTIONS, LIVE_OPTIONS);
  // No shipped row is grafted onto a live reading.
  assert.equal(definition.OPTIONS.length, LIVE_OPTIONS.length);
});

test('AntigravityProviderModels keeps the documented DEFAULT rules for live catalogs', async () => {
  const withShippedDefault = new AntigravityProviderModels({
    readModelOptions: async () => [
      { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
      { value: ANTIGRAVITY_FALLBACK_MODELS.DEFAULT, label: 'Gemini 3.6 Flash (High)' },
    ],
  });

  // The shipped default wins wherever it appears in the live list.
  assert.equal(
    (await withShippedDefault.getSupportedModels()).DEFAULT,
    ANTIGRAVITY_FALLBACK_MODELS.DEFAULT,
  );

  const withoutShippedDefault = new AntigravityProviderModels({
    readModelOptions: async () => LIVE_OPTIONS,
  });

  // Otherwise the first row the CLI printed becomes the default.
  assert.equal((await withoutShippedDefault.getSupportedModels()).DEFAULT, 'gemini-4.0-pro-high');
});

test('AntigravityProviderModels reports an empty model list as a failed discovery', async () => {
  const provider = new AntigravityProviderModels({
    readModelOptions: async () => [],
  });

  await assert.rejects(() => provider.getSupportedModels(), (error: unknown) => {
    assertAntigravityDiscoveryFailure(error);
    assert.match((error as Error).message, /listed no usable models/);
    // Nothing was read, so no cause is invented for it.
    assert.equal((error as ProviderModelsDiscoveryError).cause, undefined);
    return true;
  });
});

test('AntigravityProviderModels carries the shipped catalog on the discovery error', async () => {
  const provider = new AntigravityProviderModels({
    readModelOptions: async () => [],
  });

  await assert.rejects(() => provider.getSupportedModels(), (error: unknown) => {
    assert.ok(isProviderModelsDiscoveryError(error));
    assert.deepEqual(error.fallback, ANTIGRAVITY_FALLBACK_MODELS);
    assert.equal(error.fallback.DEFAULT, 'gemini-3.6-flash-high');
    return true;
  });
});

test('AntigravityProviderModels wraps a failed read, keeping the original cause', async () => {
  const spawnFailure = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
  const provider = new AntigravityProviderModels({
    readModelOptions: async () => {
      throw spawnFailure;
    },
  });

  await assert.rejects(() => provider.getSupportedModels(), (error: unknown) => {
    assertAntigravityDiscoveryFailure(error);
    // The original failure stays attached so logs keep naming the real cause.
    assert.equal((error as ProviderModelsDiscoveryError).cause, spawnFailure);
    return true;
  });
});

test('AntigravityProviderModels keeps naming a default model when discovery fails', async () => {
  const emptyCatalog = new AntigravityProviderModels({
    readModelOptions: async () => [],
  });
  const unreachableCli = new AntigravityProviderModels({
    readModelOptions: async () => {
      throw new Error('spawn agy ENOENT');
    },
  });

  assert.deepEqual(await emptyCatalog.getCurrentActiveModel(), {
    model: ANTIGRAVITY_FALLBACK_MODELS.DEFAULT,
  });
  assert.deepEqual(await unreachableCli.getCurrentActiveModel('conversation-1'), {
    model: ANTIGRAVITY_FALLBACK_MODELS.DEFAULT,
  });
  // A live catalog still names its own default.
  const live = new AntigravityProviderModels({ readModelOptions: async () => LIVE_OPTIONS });
  assert.deepEqual(await live.getCurrentActiveModel(), { model: 'gemini-4.0-pro-high' });
});

test('AntigravityProviderModels constructs with no arguments for the provider registry', () => {
  // The registry builds it as `new AntigravityProviderModels()`; the seam must
  // stay optional and default to the real reader.
  const provider = new AntigravityProviderModels();

  assert.ok(provider instanceof AntigravityProviderModels);
  assert.equal(typeof provider.getSupportedModels, 'function');
  assert.equal(typeof provider.getCurrentActiveModel, 'function');
});

test('readAntigravityModelOptions still answers empty CLI output with an empty list', async () => {
  if (process.platform === 'win32') {
    return;
  }

  // A clean exit that prints nothing selectable is how an unauthenticated CLI
  // answers. `AntigravityProviderAuth` reads that as "no credentials", so this
  // must stay a resolved empty array rather than a typed discovery failure.
  await withStubbedAgy('#!/bin/sh\nexit 0\n', async () => {
    const options = await readAntigravityModelOptions();

    assert.deepEqual(options, []);
  });
});
