import type { ProviderModelsDefinition } from '@/shared/types.js';

/**
 * Signals that a provider could not read its live model catalog.
 *
 * Provider model adapters used to swallow discovery failures and return their
 * built-in catalog instead, which made a failed run indistinguishable from a
 * successful one. `providerModelsService` then treated that built-in catalog as
 * a live reading and persisted it over a perfectly good snapshot for three days.
 *
 * Adapters therefore reject with this error and carry the built-in catalog on
 * it, so the caching layer can decide between an existing snapshot and the
 * fallback rather than having the decision made for it.
 *
 * Backend-internal only: it never reaches the HTTP layer, and
 * `IProviderModels.getSupportedModels()` keeps its
 * `Promise<ProviderModelsDefinition>` signature.
 *
 * Consumers: `CursorProviderModels`, `providerModelsService`, and their tests.
 */
export class ProviderModelsDiscoveryError extends Error {
  /** The provider's built-in catalog, used when no snapshot exists at all. */
  readonly fallback: ProviderModelsDefinition;

  constructor(
    fallback: ProviderModelsDefinition,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    // Set explicitly: subclassing Error leaves `name` as "Error" after the
    // transpiled constructor runs, and the name is part of this contract.
    this.name = 'ProviderModelsDiscoveryError';
    this.fallback = fallback;
  }
}

/**
 * Recognizes a discovery failure without relying on `instanceof` alone.
 *
 * The backend is loaded as source under `tsx` in tests and as compiled output in
 * production, so a structural check keeps the signal readable even if the class
 * were ever evaluated twice.
 */
export const isProviderModelsDiscoveryError = (
  value: unknown,
): value is ProviderModelsDiscoveryError => {
  if (value instanceof ProviderModelsDiscoveryError) {
    return true;
  }

  return (
    value instanceof Error
    && value.name === 'ProviderModelsDiscoveryError'
    && Array.isArray((value as ProviderModelsDiscoveryError).fallback?.OPTIONS)
  );
};

/**
 * Runs one catalog read and answers with the built-in catalog when discovery
 * failed.
 *
 * Adapters use this for their own internal reads — `getCurrentActiveModel()`
 * only needs *a* default to name, so the new reject contract must not turn a
 * missing CLI into a failed active-model lookup. Errors that are not discovery
 * failures keep propagating.
 */
export const catalogOrFallback = async (
  readCatalog: () => Promise<ProviderModelsDefinition>,
): Promise<ProviderModelsDefinition> => {
  try {
    return await readCatalog();
  } catch (error) {
    if (isProviderModelsDiscoveryError(error)) {
      return error.fallback;
    }

    throw error;
  }
};
