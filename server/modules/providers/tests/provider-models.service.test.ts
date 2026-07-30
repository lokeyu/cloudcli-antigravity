import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProviderModelsService,
  PROVIDER_MODELS_CACHE_TTL_MS,
  PROVIDER_MODELS_FALLBACK_TTL_MS,
} from '@/modules/providers/services/provider-models.service.js';
import { ProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';
import type {
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({
  model,
});

/** In-memory stand-in for the `sessions` table rows the service reads and writes. */
const createSessionStore = (rows: Record<string, string | null> = {}) => {
  const sessions = new Map(Object.entries(rows));
  return {
    sessions,
    getSessionById: (sessionId: string) =>
      (sessions.has(sessionId) ? { model: sessions.get(sessionId) ?? null } : null),
    setSessionModel: (sessionId: string, model: string) => {
      sessions.set(sessionId, model);
    },
  };
};

const createEphemeralCachePath = (): string => path.join(
  os.tmpdir(),
  `provider-model-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

const createCacheEntry = (
  model: string,
  updatedAt: number,
  expiresAt: number,
) => ({
  updatedAt,
  expiresAt,
  models: createModels(model),
});

const writeCacheFile = async (
  cachePath: string,
  entries: Record<string, ReturnType<typeof createCacheEntry>>,
): Promise<void> => {
  await writeFile(cachePath, `${JSON.stringify({ version: 2, entries }, null, 2)}\n`, 'utf8');
};

/** The built-in catalog one adapter carries on a discovery failure. */
const createDiscoveryFailure = (model: string): ProviderModelsDiscoveryError =>
  new ProviderModelsDiscoveryError(createModels(model), `discovery failed for ${model}`);

/**
 * Lets every already-queued cache write run to completion.
 *
 * Persistence is queued rather than awaited by the caller in some paths, so
 * assertions about what did *not* reach disk have to give those writes a turn
 * first — otherwise they would pass simply by running too early.
 */
const settlePendingWrites = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('provider models service delegates to the resolved provider model adapter', async () => {
  const calls: LLMProvider[] = [];
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => {
      calls.push(provider);
      return {
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      };
    },
  });

  const models = await service.getProviderModels('codex', { bypassCache: true });

  assert.deepEqual(calls, ['codex']);
  assert.equal(models.models.DEFAULT, 'codex-models');
  assert.equal(models.cache.source, 'fresh');
});

test('provider models service returns each provider adapter result without rewriting it', async () => {
  const expectedModels: ProviderModelsDefinition = {
    OPTIONS: [
      { value: 'cursor-a', label: 'Cursor A' },
      { value: 'cursor-b', label: 'Cursor B' },
    ],
    DEFAULT: 'cursor-b',
  };

  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => expectedModels,
        getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
      },
    }),
  });

  const models = await service.getProviderModels('cursor', { bypassCache: true });

  assert.deepEqual(models.models, expectedModels);
});

test('provider models are cached for the three-day ttl', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-ttl-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const first = await service.getProviderModels('codex');
    const cached = await service.getProviderModels('codex');
    assert.equal(loadCount, 1);
    assert.equal(cached.models.DEFAULT, first.models.DEFAULT);
    assert.equal(cached.cache.source, 'memory');

    currentTime += PROVIDER_MODELS_CACHE_TTL_MS - 1;
    await service.getProviderModels('codex');
    assert.equal(loadCount, 1);

    currentTime += 2;
    const refreshed = await service.getProviderModels('codex');
    assert.equal(loadCount, 2);
    assert.equal(refreshed.models.DEFAULT, 'codex-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('claude provider models are always loaded directly from the provider', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-claude-direct-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    const second = await service.getProviderModels('claude');

    assert.equal(loadCount, 2);
    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(second.models.DEFAULT, 'claude-2');
    assert.equal(second.cache.source, 'fresh');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('provider model cache is persisted across service instances', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-file-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');

  try {
    const writer = createProviderModelsService({
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => createModels('cursor-cached'),
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });
    await writer.getProviderModels('cursor');

    const reader = createProviderModelsService({
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw new Error('loader should not be called for persisted cache hits');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });
    const models = await reader.getProviderModels('cursor');
    assert.equal(models.models.DEFAULT, 'cursor-cached');
    assert.equal(models.cache.source, 'disk');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent provider model requests share one load operation', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-pending-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return createModels('claude-cached');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('claude-active'),
        },
      }),
    });

    const [first, second] = await Promise.all([
      service.getProviderModels('claude'),
      service.getProviderModels('claude'),
    ]);

    assert.equal(loadCount, 1);
    assert.equal(first.models.DEFAULT, 'claude-cached');
    assert.equal(second.models.DEFAULT, 'claude-cached');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('bypassCache forces a fresh provider fetch and updates cache metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-refresh-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active-${loadCount}`),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    currentTime += 50;
    const refreshed = await service.getProviderModels('claude', { bypassCache: true });

    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(refreshed.models.DEFAULT, 'claude-2');
    assert.equal(refreshed.cache.source, 'fresh');
    assert.notEqual(refreshed.cache.updatedAt, first.cache.updatedAt);
    assert.equal(loadCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveSessionModel asks the provider adapter for the session it was given', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const service = createProviderModelsService({
    sessions: createSessionStore({ 'session-123': null }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async (sessionId) => {
          calls.push({ provider, sessionId });
          return createCurrentActiveModel(`${provider}-${sessionId}`);
        },
      },
    }),
  });

  const resolved = await service.resolveSessionModel('opencode', { sessionId: 'session-123' });

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(resolved.model, 'opencode-session-123');
});
test('setSessionModel records the model on the session row', async () => {
  const sessions = createSessionStore({ 'session-1': null });
  const service = createProviderModelsService({
    sessions,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  const stored = service.setSessionModel('claude', 'session-1', 'opus');

  assert.deepEqual(stored, {
    provider: 'claude',
    sessionId: 'session-1',
    model: 'opus',
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1'), 'opus');
});

test('setSessionModel ignores sessions that have no row yet', async () => {
  const sessions = createSessionStore();
  const service = createProviderModelsService({
    sessions,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  assert.equal(service.setSessionModel('claude', 'missing-session', 'opus'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('resolveSessionModel prefers the recorded session model over everything else', async () => {
  const service = createProviderModelsService({
    sessions: createSessionStore({ 'session-1': 'haiku' }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'sonnet',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to provider session state for sessions the app never recorded', async () => {
  const service = createProviderModelsService({
    sessions: createSessionStore({ 'session-1': null }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('opencode', {
    sessionId: 'session-1',
    requestedModel: 'requested',
  });

  assert.equal(resolved.model, 'provider-reported');
  assert.equal(resolved.source, 'provider');
});

test('resolveSessionModel uses the requested model when the provider only reports its catalog default', async () => {
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    sessions: createSessionStore({ 'session-1': null }),
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => createModels('default'),
        getCurrentActiveModel: async () => createCurrentActiveModel('default'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'haiku',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel answers with the requested model for a chat that has no session yet', async () => {
  const service = createProviderModelsService({
    sessions: createSessionStore(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('codex', { requestedModel: 'gpt-5.5' });

  assert.equal(resolved.model, 'gpt-5.5');
  assert.equal(resolved.sessionId, null);
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to the catalog default with nothing else to go on', async () => {
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    sessions: createSessionStore(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel('provider-reported'),
      },
    }),
  });

  const resolved = await service.resolveSessionModel('codex');

  assert.equal(resolved.model, 'codex-models');
  assert.equal(resolved.source, 'default');
});

test('resolveResumeModel prefers the recorded session model over the requested one', async () => {
  const service = createProviderModelsService({
    sessions: createSessionStore({ 'session-456': 'composer-2' }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
      },
    }),
  });

  const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
  assert.equal(model, 'composer-2');
});

test('resolveResumeModel never lets provider session state override the requested model', async () => {
  let providerLookups = 0;
  const service = createProviderModelsService({
    sessions: createSessionStore({ 'session-456': null }),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => {
          providerLookups += 1;
          return createCurrentActiveModel('global-config-model');
        },
      },
    }),
  });

  const model = await service.resolveResumeModel('codex', 'session-456', 'gpt-5.5');

  assert.equal(model, 'gpt-5.5');
  assert.equal(providerLookups, 0);
});

test('provider models service preserves stale cache when provider fetch fails or returns empty catalog', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-stale-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  let currentTime = 1_000;
  let shouldFail = false;

  try {
    const service = createProviderModelsService({
      cachePath,
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            if (shouldFail) {
              throw new Error('CLI execution failure / quota exhausted');
            }
            return createModels(`${provider}-cached`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const initial = await service.getProviderModels('cursor');
    assert.equal(initial.models.DEFAULT, 'cursor-cached');

    // Advance time beyond TTL so memory cache expires
    currentTime += PROVIDER_MODELS_CACHE_TTL_MS + 10_000;
    shouldFail = true;

    // Fetch should fail, but return stale cache instead of throwing or wiping
    const fallbackStale = await service.getProviderModels('cursor', { bypassCache: true });
    assert.equal(fallbackStale.models.DEFAULT, 'cursor-cached');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('persisting refreshed Cursor models keeps an expired Codex snapshot on disk', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-keep-stale-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  let currentTime = 1_000;
  let cursorLoads = 0;

  try {
    const service = createProviderModelsService({
      cachePath,
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            if (provider === 'cursor') {
              cursorLoads += 1;
              return createModels(`cursor-${cursorLoads}`);
            }
            return createModels('codex-stale');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    await service.getProviderModels('cursor');
    await service.getProviderModels('codex');
    currentTime += PROVIDER_MODELS_CACHE_TTL_MS + 1;

    await service.getProviderModels('cursor', { bypassCache: true });

    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as {
      entries: Record<string, { models: ProviderModelsDefinition }>;
    };
    assert.equal(persisted.entries.cursor.models.DEFAULT, 'cursor-2');
    assert.equal(persisted.entries.codex.models.DEFAULT, 'codex-stale');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('expired disk snapshots trigger discovery and remain available as stale fallback', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-expired-fallback-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  const currentTime = PROVIDER_MODELS_CACHE_TTL_MS + 10_000;
  let loadCount = 0;

  try {
    await writeCacheFile(cachePath, {
      codex: createCacheEntry('codex-stale', 1_000, 1_000 + PROVIDER_MODELS_CACHE_TTL_MS),
    });

    const service = createProviderModelsService({
      cachePath,
      now: () => currentTime,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            throw new Error('Codex discovery failed');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('codex-active'),
        },
      }),
    });

    const result = await service.getProviderModels('codex');

    assert.equal(loadCount, 1, 'an expired entry must not be treated as fresh');
    assert.equal(result.models.DEFAULT, 'codex-stale');
    assert.equal(result.cache.source, 'disk');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('parallel provider refreshes serialize atomic writes and persist valid results for both providers', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-parallel-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  let activeRenames = 0;
  let maximumActiveRenames = 0;

  try {
    const service = createProviderModelsService({
      cachePath,
      renameCacheFile: async (...args: Parameters<typeof rename>) => {
        activeRenames += 1;
        maximumActiveRenames = Math.max(maximumActiveRenames, activeRenames);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await rename(...args);
        } finally {
          activeRenames -= 1;
        }
      },
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-fresh`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    await Promise.all([
      service.getProviderModels('cursor', { bypassCache: true }),
      service.getProviderModels('codex', { bypassCache: true }),
    ]);

    const raw = await readFile(cachePath, 'utf8');
    const persisted = JSON.parse(raw) as {
      version: number;
      entries: Record<string, { models: ProviderModelsDefinition }>;
    };

    assert.equal(maximumActiveRenames, 1);
    assert.equal(persisted.version, 2);
    assert.equal(persisted.entries.cursor.models.DEFAULT, 'cursor-fresh');
    assert.equal(persisted.entries.codex.models.DEFAULT, 'codex-fresh');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('failed atomic rename preserves the previous cache file and cleans up the temp file', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-atomic-failure-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');

  try {
    await writeCacheFile(cachePath, {
      codex: createCacheEntry('codex-working', 1_000, 1_000 + PROVIDER_MODELS_CACHE_TTL_MS),
    });
    const original = await readFile(cachePath, 'utf8');
    t.mock.method(console, 'warn', () => {});

    const service = createProviderModelsService({
      cachePath,
      renameCacheFile: async () => {
        throw new Error('simulated rename failure');
      },
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-fresh`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    await service.getProviderModels('cursor', { bypassCache: true });

    assert.equal(await readFile(cachePath, 'utf8'), original);
    assert.deepEqual(await readdir(tempRoot), ['models-cache.json']);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------
// Discovery failures: stale snapshots outrank built-in fallback catalogs

test('a typed discovery failure returns the expired snapshot and leaves the cache file untouched', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-typed-stale-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  const snapshotUpdatedAt = 1_000;
  const snapshotExpiresAt = snapshotUpdatedAt + PROVIDER_MODELS_CACHE_TTL_MS;
  const currentTime = snapshotExpiresAt + 10_000;

  try {
    await writeCacheFile(cachePath, {
      cursor: createCacheEntry('cursor-stale', snapshotUpdatedAt, snapshotExpiresAt),
    });
    const originalFile = await readFile(cachePath, 'utf8');

    const service = createProviderModelsService({
      cachePath,
      now: () => currentTime,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw createDiscoveryFailure('cursor-builtin');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });

    const result = await service.getProviderModels('cursor');
    await settlePendingWrites();

    assert.equal(result.models.DEFAULT, 'cursor-stale', 'the stale snapshot must win');
    assert.notEqual(result.models.DEFAULT, 'cursor-builtin');
    assert.equal(result.cache.source, 'disk');
    assert.equal(result.cache.updatedAt, new Date(snapshotUpdatedAt).toISOString());
    assert.equal(result.cache.expiresAt, new Date(snapshotExpiresAt).toISOString());
    assert.equal(await readFile(cachePath, 'utf8'), originalFile);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a typed discovery failure without any snapshot answers with the built-in catalog only', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-typed-fallback-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');

  try {
    const service = createProviderModelsService({
      cachePath,
      now: () => 1_000,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw createDiscoveryFailure('cursor-builtin');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });

    const result = await service.getProviderModels('cursor');
    await settlePendingWrites();

    assert.equal(result.models.DEFAULT, 'cursor-builtin');
    assert.deepEqual(
      await readdir(tempRoot),
      [],
      'a fallback must not be a reason to create the cache file',
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a parked fallback never reaches disk when another provider persists a live catalog', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-fallback-leak-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');

  try {
    const service = createProviderModelsService({
      cachePath,
      now: () => 1_000,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            if (provider === 'cursor') {
              throw createDiscoveryFailure('cursor-builtin');
            }
            return createModels('codex-live');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        },
      }),
    });

    const cursorResult = await service.getProviderModels('cursor');
    const codexResult = await service.getProviderModels('codex');
    await settlePendingWrites();

    assert.equal(cursorResult.models.DEFAULT, 'cursor-builtin');
    assert.equal(codexResult.models.DEFAULT, 'codex-live');

    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as {
      entries: Record<string, { models: ProviderModelsDefinition }>;
    };
    assert.equal(persisted.entries.codex.models.DEFAULT, 'codex-live');
    assert.deepEqual(Object.keys(persisted.entries), ['codex']);
    assert.equal(persisted.entries.cursor, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a parked fallback answers for its short ttl and then lets discovery run again', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-fallback-ttl-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            throw createDiscoveryFailure(`cursor-builtin-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });

    const first = await service.getProviderModels('cursor');
    assert.equal(loadCount, 1);
    assert.equal(first.models.DEFAULT, 'cursor-builtin-1');

    currentTime += PROVIDER_MODELS_FALLBACK_TTL_MS - 1;
    const withinTtl = await service.getProviderModels('cursor');
    assert.equal(loadCount, 1, 'a parked fallback must not re-run discovery');
    assert.equal(withinTtl.models.DEFAULT, 'cursor-builtin-1');

    currentTime += 2;
    const afterTtl = await service.getProviderModels('cursor');
    assert.equal(loadCount, 2, 'discovery must be retried once the fallback ttl elapses');
    assert.equal(afterTtl.models.DEFAULT, 'cursor-builtin-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('parallel requests share one failed discovery and receive the same stale result', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-parallel-failure-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');
  const currentTime = PROVIDER_MODELS_CACHE_TTL_MS + 10_000;
  let loadCount = 0;

  try {
    await writeCacheFile(cachePath, {
      cursor: createCacheEntry('cursor-stale', 1_000, 1_000 + PROVIDER_MODELS_CACHE_TTL_MS),
    });

    const service = createProviderModelsService({
      cachePath,
      now: () => currentTime,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw createDiscoveryFailure('cursor-builtin');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });

    const [first, second] = await Promise.all([
      service.getProviderModels('cursor'),
      service.getProviderModels('cursor'),
    ]);

    assert.equal(loadCount, 1, 'both callers must share one discovery attempt');
    assert.equal(first, second, 'both callers must observe the very same result');
    assert.equal(first.models.DEFAULT, 'cursor-stale');
    assert.equal(first.cache.source, 'disk');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('an untyped provider error without any snapshot still propagates', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-untyped-'));

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw new Error('unexpected adapter crash');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        },
      }),
    });

    await assert.rejects(
      () => service.getProviderModels('cursor'),
      /unexpected adapter crash/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('an uncached provider answers a typed discovery failure with the built-in catalog', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-uncached-typed-'));

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => 1_000,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw createDiscoveryFailure('claude-builtin');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('claude-active'),
        },
      }),
    });

    const result = await service.getProviderModels('claude');
    await settlePendingWrites();

    assert.equal(result.models.DEFAULT, 'claude-builtin');
    assert.equal(result.cache.source, 'fresh');
    assert.deepEqual(await readdir(tempRoot), [], 'uncached providers must not persist anything');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
