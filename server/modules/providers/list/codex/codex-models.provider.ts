import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import { catalogOrFallback, ProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'gpt-5.4',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'gpt-5.4-mini',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.4',
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
};

const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => {
  const effortValues = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
      .map((level) => {
        const value = readOptionalString(level?.effort);
        if (!value) {
          return null;
        }

        return {
          value,
          description: readOptionalString(level?.description),
        };
      })
      .filter((level): level is NonNullable<typeof level> => Boolean(level))
    : [];

  return {
    value: model.slug as string,
    label: readOptionalString(model.display_name) ?? (model.slug as string),
    description: readOptionalString(model.description),
    effort: effortValues.length > 0
      ? {
          default: readOptionalString(model.default_reasoning_level) ?? undefined,
          values: effortValues,
        }
      : undefined,
  };
};

export const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  const sortedModels = [...models]
    .filter((model) => model.visibility === 'list' && model.supported_in_api !== false)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  return {
    OPTIONS: options,
    DEFAULT: options[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT,
  };
};

/** Seam for tests: the real readers touch the files Codex keeps under `~/.codex`. */
type CodexProviderModelsDependencies = {
  readModelsCache?: () => Promise<string>;
  readConfig?: () => Promise<string>;
};

export class CodexProviderModels implements IProviderModels {
  private readonly readModelsCache: () => Promise<string>;

  private readonly readConfig: () => Promise<string>;

  constructor(dependencies: CodexProviderModelsDependencies = {}) {
    this.readModelsCache = dependencies.readModelsCache
      ?? (() => readFile(CODEX_MODELS_CACHE_PATH, 'utf8'));
    this.readConfig = dependencies.readConfig
      ?? (() => readFile(CODEX_CONFIG_PATH, 'utf8'));
  }

  /**
   * Reads the catalog Codex caches in `~/.codex/models_cache.json`.
   *
   * Rejects with `ProviderModelsDiscoveryError` when the file is missing or
   * unreadable, when it does not parse as JSON, and when nothing in it survives
   * the visibility filter. The built-in catalog rides along on the error so
   * `providerModelsService` can prefer an existing snapshot over it instead of
   * recording a placeholder as a live reading.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    let models: CodexCachedModel[];

    try {
      const raw = await this.readModelsCache();
      const parsed = readObjectRecord(JSON.parse(raw));
      models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];
    } catch (error) {
      throw new ProviderModelsDiscoveryError(
        CODEX_FALLBACK_MODELS,
        'Unable to read the Codex model cache',
        { cause: error },
      );
    }

    const definition = buildCodexModelsDefinition(models);
    // The builder answers with the shipped catalog itself when the cache held
    // nothing listable, so identity is what distinguishes "read a catalog" from
    // "read a file with no models in it" without duplicating its filter rules.
    if (definition === CODEX_FALLBACK_MODELS) {
      throw new ProviderModelsDiscoveryError(
        CODEX_FALLBACK_MODELS,
        'The Codex model cache listed no selectable models',
      );
    }

    return definition;
  }

  /**
   * Reads the catalog for default-naming purposes only.
   *
   * `getCurrentActiveModel` needs a model name to fall back on, not proof that
   * the cache was readable, so a failed discovery resolves to the built-in
   * catalog here rather than propagating.
   */
  private async readCatalogForDefault(): Promise<ProviderModelsDefinition> {
    return catalogOrFallback(() => this.getSupportedModels());
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await this.readConfig();
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.readCatalogForDefault());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.readCatalogForDefault());
    }
  }
}
