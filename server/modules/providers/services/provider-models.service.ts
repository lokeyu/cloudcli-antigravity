import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import { isProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';
import type {
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
  ProviderModelsResult,
  ProviderSessionModel,
} from '@/shared/types.js';

export const PROVIDER_MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * How long a provider's built-in catalog answers for after discovery failed and
 * no snapshot existed to fall back on.
 *
 * Deliberately far shorter than the snapshot TTL: a built-in catalog is a
 * placeholder, so the next request a minute later must be free to probe the CLI
 * again, while a burst of requests in between does not spawn one process each.
 */
export const PROVIDER_MODELS_FALLBACK_TTL_MS = 60_000;
const PROVIDER_MODELS_CACHE_VERSION = 2;
const UNCACHED_PROVIDERS = new Set<LLMProvider>(['claude']);

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionStore = {
  getSessionById(sessionId: string): { model: string | null } | null;
  setSessionModel(sessionId: string, model: string): void;
};

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  cachePath?: string;
  sessions?: ProviderModelsSessionStore;
  now?: () => number;
  renameCacheFile?: typeof rename;
};

type ProviderModelsOptions = {
  bypassCache?: boolean;
};

type ProviderModelsCacheEntry = {
  updatedAt: number;
  expiresAt: number;
  models: ProviderModelsDefinition;
};

type ProviderModelsCacheFile = {
  version: number;
  entries: Record<string, ProviderModelsCacheEntry>;
};

/**
 * One provider's built-in catalog, held in memory only.
 *
 * Kept apart from the working snapshot cache on purpose: `persistCache()`
 * serializes the whole snapshot map, so a fallback parked there would reach disk
 * as soon as any other provider refreshed.
 */
type ProviderModelsFallbackEntry = {
  models: ProviderModelsDefinition;
  expiresAt: number;
};

const getProviderModelsCachePath = (): string => path.join(
  os.homedir(),
  '.cloudcli',
  'provider-models-cache.json',
);

const toProviderModelsCacheInfo = (
  entry: ProviderModelsCacheEntry,
  source: ProviderModelsCacheInfo['source'],
): ProviderModelsCacheInfo => ({
  updatedAt: new Date(entry.updatedAt).toISOString(),
  expiresAt: new Date(entry.expiresAt).toISOString(),
  source,
});

const isProviderModelOption = (
  value: unknown,
): value is ProviderModelsDefinition['OPTIONS'][number] => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).value === 'string'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).label === 'string'
  && (
    typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'undefined'
    || typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'string'
  )
);

const isProviderModelsDefinition = (value: unknown): value is ProviderModelsDefinition => (
  Boolean(value)
  && typeof value === 'object'
  && Array.isArray((value as ProviderModelsDefinition).OPTIONS)
  && (value as ProviderModelsDefinition).OPTIONS.every(isProviderModelOption)
  && typeof (value as ProviderModelsDefinition).DEFAULT === 'string'
);

const isProviderModelsCacheEntry = (value: unknown): value is ProviderModelsCacheEntry => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsCacheEntry).updatedAt === 'number'
  && typeof (value as ProviderModelsCacheEntry).expiresAt === 'number'
  && isProviderModelsDefinition((value as ProviderModelsCacheEntry).models)
);

const readProviderModelsCacheFile = async (
  cachePath: string,
): Promise<ProviderModelsCacheFile | null> => {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderModelsCacheFile>;
    if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return null;
    }

    const entries = Object.fromEntries(
      Object.entries(parsed.entries).filter((entry): entry is [string, ProviderModelsCacheEntry] =>
        isProviderModelsCacheEntry(entry[1]),
      ),
    );

    return {
      version: PROVIDER_MODELS_CACHE_VERSION,
      entries,
    };
  } catch {
    return null;
  }
};

const writeProviderModelsCacheFile = async (
  cachePath: string,
  entries: Map<LLMProvider, ProviderModelsCacheEntry>,
  renameCacheFile: typeof rename,
): Promise<void> => {
  const payload: ProviderModelsCacheFile = {
    version: PROVIDER_MODELS_CACHE_VERSION,
    // Expiry controls whether discovery runs, not whether the last working
    // snapshot remains available as a stale fallback.
    entries: Object.fromEntries(entries),
  };

  const cacheDirectory = path.dirname(cachePath);
  const temporaryPath = path.join(
    cacheDirectory,
    `.${path.basename(cachePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(cacheDirectory, { recursive: true });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await renameCacheFile(temporaryPath, cachePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temp file may not have been created or may already have been moved.
    }
    throw error;
  }
};

/**
 * Provider model lookup service.
 *
 * Routes and other service callers use this layer instead of resolving provider
 * classes directly so the provider-registry dependency stays centralized in one
 * place.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const cachePath = dependencies.cachePath ?? getProviderModelsCachePath();
  const sessions = dependencies.sessions ?? sessionsDb;
  const now = dependencies.now ?? (() => Date.now());
  const renameCacheFile = dependencies.renameCacheFile ?? rename;
  const memoryCache = new Map<LLMProvider, ProviderModelsCacheEntry>();
  // Never persisted and never merged into `memoryCache`; see the type comment.
  const fallbackCache = new Map<LLMProvider, ProviderModelsFallbackEntry>();
  const pendingRequests = new Map<LLMProvider, Promise<ProviderModelsResult>>();
  let persistedCacheLoaded = false;
  let persistedCacheLoadPromise: Promise<void> | null = null;
  let persistQueue: Promise<void> = Promise.resolve();

  const getAnyExistingCacheEntry = (
    provider: LLMProvider,
    source: ProviderModelsCacheInfo['source'] = 'disk',
  ): ProviderModelsResult | null => {
    const entry = memoryCache.get(provider);
    if (entry && entry.models && Array.isArray(entry.models.OPTIONS) && entry.models.OPTIONS.length > 0) {
      return {
        models: entry.models,
        cache: toProviderModelsCacheInfo(entry, source),
      };
    }
    return null;
  };

  /**
   * Describes a built-in catalog in the shape callers already expect.
   *
   * `source` stays `'fresh'` because the wire format is unchanged at this stage:
   * the short expiry is what tells the reader this is not a three-day snapshot.
   */
  const toFallbackResult = (
    models: ProviderModelsDefinition,
    expiresAt: number,
  ): ProviderModelsResult => ({
    models,
    cache: {
      updatedAt: new Date(expiresAt - PROVIDER_MODELS_FALLBACK_TTL_MS).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      source: 'fresh',
    },
  });

  const readFallbackCacheEntry = (
    provider: LLMProvider,
    currentTime: number,
  ): ProviderModelsResult | null => {
    const entry = fallbackCache.get(provider);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= currentTime) {
      fallbackCache.delete(provider);
      return null;
    }

    return toFallbackResult(entry.models, entry.expiresAt);
  };

  /**
   * Parks a built-in catalog for the fallback TTL.
   *
   * Called only when discovery failed *and* no snapshot of any age exists, so
   * this never competes with a real reading of the provider's catalog.
   */
  const setFallbackCacheEntry = (
    provider: LLMProvider,
    models: ProviderModelsDefinition,
    currentTime: number,
  ): ProviderModelsResult => {
    const expiresAt = currentTime + PROVIDER_MODELS_FALLBACK_TTL_MS;
    fallbackCache.set(provider, { models, expiresAt });
    return toFallbackResult(models, expiresAt);
  };

  const pruneExpiredMemoryEntry = (
    provider: LLMProvider,
    currentTime: number,
    source: ProviderModelsCacheInfo['source'],
  ): ProviderModelsResult | null => {
    const cachedEntry = memoryCache.get(provider);
    if (!cachedEntry) {
      return null;
    }

    if (cachedEntry.expiresAt > currentTime) {
      return {
        models: cachedEntry.models,
        cache: toProviderModelsCacheInfo(cachedEntry, source),
      };
    }

    return null;
  };

  const loadPersistedCache = async (): Promise<void> => {
    if (persistedCacheLoaded) {
      return;
    }

    if (!persistedCacheLoadPromise) {
      persistedCacheLoadPromise = (async () => {
        const cacheFile = await readProviderModelsCacheFile(cachePath);

        for (const [provider, entry] of Object.entries(cacheFile?.entries ?? {})) {
          if (entry.models && Array.isArray(entry.models.OPTIONS) && entry.models.OPTIONS.length > 0) {
            memoryCache.set(provider as LLMProvider, entry);
          }
        }

        persistedCacheLoaded = true;
      })().finally(() => {
        persistedCacheLoadPromise = null;
      });
    }

    await persistedCacheLoadPromise;
  };

  const persistCache = (): Promise<void> => {
    // Build the payload only when this operation reaches the front of the
    // queue. Later writes therefore include every provider committed to memory
    // while earlier writes were in flight.
    persistQueue = persistQueue.then(async () => {
      try {
        await writeProviderModelsCacheFile(cachePath, memoryCache, renameCacheFile);
      } catch (error) {
        console.warn('Unable to persist provider models cache:', error);
      }
    });

    return persistQueue;
  };

  const setCacheEntry = async (
    provider: LLMProvider,
    models: ProviderModelsDefinition,
  ): Promise<ProviderModelsCacheEntry> => {
    const currentTime = now();
    const entry: ProviderModelsCacheEntry = {
      updatedAt: currentTime,
      expiresAt: currentTime + PROVIDER_MODELS_CACHE_TTL_MS,
      models,
    };

    memoryCache.set(provider, entry);
    await persistCache();
    return entry;
  };

  const loadAndCacheModels = (
    provider: LLMProvider,
  ): Promise<ProviderModelsResult> => {
    const request = resolveProvider(provider).models.getSupportedModels()
      .then(async (models) => {
        if (!models || !Array.isArray(models.OPTIONS) || models.OPTIONS.length === 0) {
          await loadPersistedCache();
          const stale = getAnyExistingCacheEntry(provider);
          if (stale) {
            return stale;
          }
        }

        // A live reading supersedes any placeholder this provider is serving.
        fallbackCache.delete(provider);
        const entry = await setCacheEntry(provider, models);
        return {
          models,
          cache: toProviderModelsCacheInfo(entry, 'fresh'),
        };
      })
      .catch(async (error) => {
        await loadPersistedCache();
        const stale = getAnyExistingCacheEntry(provider);
        if (stale) {
          // Returned untouched: no timestamps are rewritten and nothing is
          // persisted, so a good snapshot survives a broken CLI indefinitely.
          return stale;
        }

        if (isProviderModelsDiscoveryError(error)) {
          // Nothing to fall back on, so the provider's built-in catalog answers
          // — in memory only, and only until the short fallback TTL runs out.
          return setFallbackCacheEntry(provider, error.fallback, now());
        }

        throw error;
      })
      .finally(() => {
        pendingRequests.delete(provider);
      });

    pendingRequests.set(provider, request);
    return request;
  };

  const loadDirectModels = (
    provider: LLMProvider,
  ): Promise<ProviderModelsResult> => {
    const request = resolveProvider(provider).models.getSupportedModels()
      .then((models) => {
        const currentTime = now();
        return {
          models,
          cache: {
            updatedAt: new Date(currentTime).toISOString(),
            expiresAt: new Date(currentTime).toISOString(),
            source: 'fresh' as const,
          },
        };
      })
      .catch((error) => {
        // Uncached providers keep no snapshot to prefer, so a discovery failure
        // can only be answered with the built-in catalog. Nothing is cached or
        // persisted here — the next request probes the provider again.
        if (isProviderModelsDiscoveryError(error)) {
          const currentTime = now();
          return {
            models: error.fallback,
            cache: {
              updatedAt: new Date(currentTime).toISOString(),
              expiresAt: new Date(currentTime).toISOString(),
              source: 'fresh' as const,
            },
          };
        }

        throw error;
      })
      .finally(() => {
        pendingRequests.delete(provider);
      });

    pendingRequests.set(provider, request);
    return request;
  };

  const getProviderModels = async (
    provider: LLMProvider,
    options: ProviderModelsOptions = {},
  ): Promise<ProviderModelsResult> => {
    if (UNCACHED_PROVIDERS.has(provider)) {
      const pendingRequest = pendingRequests.get(provider);
      if (pendingRequest) {
        return pendingRequest;
      }

      return loadDirectModels(provider);
    }

    if (options.bypassCache) {
      const pendingRequest = pendingRequests.get(provider);
      if (pendingRequest) {
        return pendingRequest;
      }

      // An explicit refresh deliberately ignores a parked fallback: the user
      // asking for one is exactly the case worth re-probing the CLI for.
      return loadAndCacheModels(provider);
    }

    const currentTime = now();
    const cachedModels = pruneExpiredMemoryEntry(provider, currentTime, 'memory');
    if (cachedModels) {
      return cachedModels;
    }

    // Checked before the disk read: a parked fallback only exists because
    // discovery already failed with no snapshot on disk to prefer.
    const fallbackModels = readFallbackCacheEntry(provider, currentTime);
    if (fallbackModels) {
      return fallbackModels;
    }

    const pendingRequest = pendingRequests.get(provider);
    if (pendingRequest) {
      return pendingRequest;
    }

    await loadPersistedCache();

    const persistedModels = pruneExpiredMemoryEntry(provider, now(), 'disk');
    if (persistedModels) {
      return persistedModels;
    }

    const postLoadPendingRequest = pendingRequests.get(provider);
    if (postLoadPendingRequest) {
      return postLoadPendingRequest;
    }

    return loadAndCacheModels(provider);
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const readRecordedSessionModel = (sessionId: string): string | null => {
    const session = sessions.getSessionById(sessionId);
    return session?.model?.trim() || null;
  };

  /**
   * Records the model one session runs with.
   *
   * Called from the active-model route when the user picks a model and from
   * `chat.send` on every turn, so the row always matches what the session last
   * ran with. Sessions the app has not created yet (no row) are ignored rather
   * than treated as an error: the client keeps its own pending selection and
   * the value lands on the row with the first send.
   */
  const setSessionModel = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): ProviderSessionModel | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return null;
    }

    if (!sessions.getSessionById(normalizedSessionId)) {
      return null;
    }

    sessions.setSessionModel(normalizedSessionId, normalizedModel);
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      source: 'session',
    };
  };

  /**
   * Answers "which model is this session using?" for every display surface.
   *
   * Precedence, highest first:
   *   1. the model recorded on the session row — the user's pick, or whatever
   *      the last send used;
   *   2. the provider's own session state, for sessions started outside the app
   *      that we have never recorded a model for;
   *   3. `requestedModel`, the client's current default, for a chat that has no
   *      session yet;
   *   4. the provider catalog default.
   */
  const resolveSessionModel = async (
    provider: LLMProvider,
    options: { sessionId?: string | null; requestedModel?: string | null } = {},
  ): Promise<ProviderSessionModel> => {
    const normalizedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const normalizedRequestedModel = typeof options.requestedModel === 'string'
      ? options.requestedModel.trim()
      : '';

    if (normalizedSessionId) {
      const recordedModel = readRecordedSessionModel(normalizedSessionId);
      if (recordedModel) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: recordedModel,
          source: 'session',
        };
      }

      // Never sent on through the app. Ask the provider what its own session
      // state says before falling back to anything client-supplied.
      const catalog = (await getProviderModels(provider)).models;
      const providerModel = await getCurrentActiveModel(provider, normalizedSessionId);
      const resolvedProviderModel = providerModel.model?.trim();
      if (resolvedProviderModel && resolvedProviderModel !== catalog.DEFAULT) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: resolvedProviderModel,
          source: 'provider',
        };
      }

      return {
        provider,
        sessionId: normalizedSessionId,
        model: normalizedRequestedModel || catalog.DEFAULT,
        source: normalizedRequestedModel ? 'session' : 'default',
      };
    }

    if (normalizedRequestedModel) {
      return {
        provider,
        sessionId: null,
        model: normalizedRequestedModel,
        source: 'session',
      };
    }

    const catalog = (await getProviderModels(provider)).models;
    return {
      provider,
      sessionId: null,
      model: catalog.DEFAULT,
      source: 'default',
    };
  };

  /**
   * Picks the model one run should use, for provider runtime adapters.
   *
   * Deliberately narrower than `resolveSessionModel`: the provider's own
   * session state is not consulted here. Codex reports a global config value
   * from `getCurrentActiveModel`, which would silently override the model the
   * user picked in the composer on every single run.
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    void provider;
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      return normalizedRequestedModel || undefined;
    }

    const recordedModel = readRecordedSessionModel(normalizedSessionId);
    return recordedModel || normalizedRequestedModel || undefined;
  };

  const clearCache = (): void => {
    memoryCache.clear();
    fallbackCache.clear();
    pendingRequests.clear();
    persistedCacheLoaded = false;
    persistedCacheLoadPromise = null;
  };

  return {
    getProviderModels,
    setSessionModel,
    resolveSessionModel,
    resolveResumeModel,
    clearCache,
  };
};

export const providerModelsService = createProviderModelsService();
