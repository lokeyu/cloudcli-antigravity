import childProcess from 'node:child_process';

import type { IProviderModels } from '@/shared/interfaces.js';
import { catalogOrFallback, ProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

// `grok models` answers from the already-running leader process and exits on its
// own, so this only has to cover a cold start of that sidecar.
const GROK_MODELS_TIMEOUT_MS = 20_000;

/**
 * Catalog used whenever `grok models` cannot be reached or lists nothing usable.
 *
 * Deliberately minimal: `grok-4.5` is the only model CLI 0.2.114 was observed
 * offering, and guessing at further ids would put models in the picker that the
 * account may not be able to run at all.
 *
 * Consumers: `GrokProviderModels` and `server/modules/providers/tests/grok-models.test.ts`.
 */
export const GROK_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'grok-4.5', label: 'Grok 4.5' },
  ],
  DEFAULT: 'grok-4.5',
};

// Model ids are lowercase, separator-joined slugs (`grok-4.5`,
// `grok-code-fast-1`). Requiring at least one separator keeps prose words in the
// login banner and section headers from being mistaken for a selectable model.
const MODEL_ID_TOKEN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
// `grok models` prints its rows as `  * grok-4.5 (default)`; the marker
// alternatives cover the bullet characters CLIs commonly switch between.
const LIST_BULLET_PREFIX = /^[-*•·]\s+/;
// The CLI announces the default twice: once on its own line and once as a suffix
// on the matching row.
const ANNOUNCED_DEFAULT_LINE = /^default model\s*:\s*(\S+)/i;
const DEFAULT_ROW_MARKER = /\((?:default|current)\)/i;
const NUMERIC_TOKEN = /^\d+(?:\.\d+)*$/;

/** One `grok models` reading: the models it listed plus the default it marked. */
type GrokModelsListing = {
  options: ProviderModelOption[];
  defaultValue: string | null;
};

/**
 * Derives a display label from one model id.
 *
 * Grok ids already carry a dotted version (`grok-4.5`), so the segments only
 * need capitalizing: `grok-code-fast-1` becomes `Grok Code Fast 1`.
 */
const buildGrokModelLabel = (modelId: string): string => {
  const label = modelId
    .split(/[-_]/)
    .filter(Boolean)
    .map((token) => (
      NUMERIC_TOKEN.test(token)
        ? token
        : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
    ))
    .join(' ');

  return label || modelId;
};

/**
 * Resolves the label for one model id, preferring the wording already shipped in
 * the fallback catalog so the same model never appears under two spellings.
 */
const labelForGrokModelId = (modelId: string): string => (
  GROK_FALLBACK_MODELS.OPTIONS.find((option) => option.value === modelId)?.label
    ?? buildGrokModelLabel(modelId)
);

/**
 * Parses `grok models` stdout.
 *
 * The command prints a login banner, a `Default model: <id>` line, an
 * `Available models:` header, and then one bulleted row per model
 * (`  * grok-4.5 (default)`). Only the first token of a de-bulleted row is read,
 * and only when it has model-id shape, so banner text, headers, and any trailing
 * annotation can never become selectable models. Duplicate ids are dropped.
 *
 * Consumer: `server/modules/providers/tests/grok-models.test.ts`.
 */
export const parseGrokModelsStdout = (stdout: string): GrokModelsListing => {
  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();
  let announcedDefault: string | null = null;
  let markedDefault: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const announced = ANNOUNCED_DEFAULT_LINE.exec(line);
    if (announced) {
      const candidate = announced[1];
      if (MODEL_ID_TOKEN.test(candidate)) {
        announcedDefault = candidate;
      }
      continue;
    }

    const row = line.replace(LIST_BULLET_PREFIX, '').trim();
    const value = row.split(/\s+/)[0] ?? '';
    if (!MODEL_ID_TOKEN.test(value)) {
      continue;
    }

    // A row may carry `(default)` even when the announcement line is missing.
    if (!markedDefault && DEFAULT_ROW_MARKER.test(row)) {
      markedDefault = value;
    }

    if (seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    options.push({ value, label: labelForGrokModelId(value) });
  }

  return {
    options,
    defaultValue: announcedDefault ?? markedDefault,
  };
};

/**
 * Builds the provider catalog from one parsed `grok models` reading.
 *
 * A default the CLI named wins, as long as it is a model the CLI also listed;
 * otherwise the shipped default is preferred and the first listed model is the
 * last resort. An empty reading falls back to the shipped catalog rather than
 * leaving the picker empty; `GrokProviderModels.getSupportedModels()` rejects
 * before reaching that branch, so the substitution is never mistaken for a live
 * reading.
 *
 * Consumer: `server/modules/providers/tests/grok-models.test.ts`.
 */
export const buildGrokDefinition = (listing: GrokModelsListing): ProviderModelsDefinition => {
  const { options, defaultValue } = listing;
  if (options.length === 0) {
    return GROK_FALLBACK_MODELS;
  }

  const listedDefault = options.find((option) => option.value === defaultValue)?.value;
  const shippedDefault = options.find((option) => option.value === GROK_FALLBACK_MODELS.DEFAULT)?.value;

  return {
    OPTIONS: options,
    DEFAULT: listedDefault ?? shippedDefault ?? options[0].value,
  };
};

/**
 * Runs `grok models` and resolves its stdout.
 *
 * The CLI is spawned directly from PATH with its arguments as a separate array
 * and no shell, so nothing here is interpolated into a command line. Rejects on
 * spawn failure, a non-zero exit, or the timeout so the caller can fall back.
 */
const runGrokModelsCommand = (): Promise<string> => new Promise((resolve, reject) => {
  const grokProcess = childProcess.spawn('grok', ['models'], {
    cwd: process.cwd(),
    env: { ...process.env },
    // Nothing is written to the CLI, and an open stdin pipe would leave it
    // waiting for an EOF that never arrives.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    grokProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('grok models timed out'));
    }
  }, GROK_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string): void => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);

    if (error) {
      reject(error);
      return;
    }

    resolve(output);
  };

  grokProcess.stdout?.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  grokProcess.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  grokProcess.on('error', (error: Error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });

  grokProcess.on('close', (code: number | null) => {
    if (code !== 0) {
      // Only the CLI's own stderr is quoted back — never the environment it ran
      // with, which is where credentials would live.
      finish(new Error(stderr.trim() || `grok models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

/** One discovery failure, always carrying the shipped catalog. */
const grokDiscoveryFailure = (
  message: string,
  cause?: unknown,
): ProviderModelsDiscoveryError => new ProviderModelsDiscoveryError(
  GROK_FALLBACK_MODELS,
  message,
  { cause },
);

/**
 * Grok's model catalog adapter.
 *
 * Reads the catalog straight from the CLI on every call: `providerModelsService`
 * owns the caching layer, so adding another one here would only make the picker
 * slower to notice a newly granted model.
 *
 * Consumers: the provider registry, once Grok is registered as a provider, and
 * `server/modules/providers/tests/grok-models.test.ts`.
 */
export class GrokProviderModels implements IProviderModels {
  /**
   * Reads the live catalog from `grok models`.
   *
   * Rejects with `ProviderModelsDiscoveryError` when the CLI cannot be run, exits
   * non-zero, or times out, and equally when it exits cleanly with nothing that
   * parses as a model row. The shipped catalog rides along on the error instead
   * of being returned here, so `providerModelsService` can prefer an existing
   * snapshot over it rather than recording a placeholder as a live reading.
   *
   * A run that listed models is a successful discovery whatever else it printed:
   * quota warnings belong to generation, not to the catalog.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    let stdout: string;

    try {
      stdout = await runGrokModelsCommand();
    } catch (error) {
      // A missing CLI, a failed run, and a timeout are all "no catalog to read".
      throw grokDiscoveryFailure('Unable to discover Grok models', error);
    }

    const listing = parseGrokModelsStdout(stdout);
    // Checked before the builder runs: its empty-listing branch answers with the
    // shipped catalog, which must never leave this method as a live reading.
    if (listing.options.length === 0) {
      throw grokDiscoveryFailure('grok models listed no usable models');
    }

    return buildGrokDefinition(listing);
  }

  /**
   * Reads the catalog for default-naming purposes only.
   *
   * `getCurrentActiveModel` needs a model name to fall back on, not proof that
   * the CLI answered, so a failed discovery resolves to the shipped catalog here
   * rather than propagating.
   */
  private async readCatalogForDefault(): Promise<ProviderModelsDefinition> {
    return catalogOrFallback(() => this.getSupportedModels());
  }

  /**
   * Grok exposes no per-session model readback: `grok models` reports the
   * account-wide default only, and sessions the app started carry their model on
   * the session row, so this only ever needs to answer with the catalog default.
   */
  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.readCatalogForDefault());
  }
}
