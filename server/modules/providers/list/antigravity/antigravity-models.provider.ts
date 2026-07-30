import crossSpawn from 'cross-spawn';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

// `agy models` starts the CLI's sidecar on a cold run, which can take several
// seconds; a run that arrives while that startup is in progress can block for
// much longer, so the timeout is generous and the read below is shared.
const ANTIGRAVITY_MODELS_TIMEOUT_MS = 30_000;
// Two facets probe the same command (the model catalog and the auth check), and
// the app loads them together on startup. Overlapping invocations are the case
// that makes the CLI block, so a completed read is briefly reusable.
const ANTIGRAVITY_MODELS_CACHE_TTL_MS = 10_000;
// `agy models` prints one model per line. Ids are lowercase, separator-joined
// slugs (`gemini-3.6-flash-high`); a display name may follow after whitespace on
// the same line. Requiring at least one separator keeps banner or notice words
// from being mistaken for a selectable model.
const MODEL_ID_TOKEN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

/**
 * Catalog used whenever `agy models` cannot be reached or returns nothing
 * usable. Mirrors the models Antigravity CLI 1.1.8 ships with, using the
 * display names the CLI itself prints for them.
 */
export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
    { value: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
    { value: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)' },
    { value: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)' },
    { value: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)' },
    { value: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)' },
    { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
  DEFAULT: 'gemini-3.6-flash-high',
};

const EFFORT_SUFFIXES = new Set(['low', 'medium', 'high']);
const NUMERIC_TOKEN = /^\d+(?:\.\d+)*$/;
const SINGLE_DIGIT_TOKEN = /^\d$/;
const UPPERCASE_TOKENS = new Set(['gpt', 'oss']);

const capitalizeToken = (token: string): string => (
  token.charAt(0).toUpperCase() + token.slice(1)
);

/**
 * Derives a display label from one model id.
 *
 * Antigravity ids encode the reasoning effort as the last segment
 * (`gemini-3.1-pro-high`), so that segment becomes a parenthesized suffix, and
 * adjacent single digits are a split version number (`claude-sonnet-4-6` →
 * `Claude Sonnet 4.6`). Both conventions match the names the CLI prints itself.
 */
const buildAntigravityModelLabel = (modelId: string): string => {
  const tokens = modelId.split('-').filter(Boolean);
  if (tokens.length === 0) {
    return modelId;
  }

  const effort = EFFORT_SUFFIXES.has(tokens[tokens.length - 1].toLowerCase())
    ? tokens.pop()
    : undefined;
  const labelParts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const lower = tokens[index].toLowerCase();
    const nextToken = tokens[index + 1]?.toLowerCase();

    if (SINGLE_DIGIT_TOKEN.test(lower) && nextToken && SINGLE_DIGIT_TOKEN.test(nextToken)) {
      labelParts.push(`${lower}.${nextToken}`);
      index += 1;
      continue;
    }

    if (NUMERIC_TOKEN.test(lower)) {
      labelParts.push(lower);
      continue;
    }

    labelParts.push(UPPERCASE_TOKENS.has(lower) ? lower.toUpperCase() : capitalizeToken(lower));
  }

  const label = labelParts.join(' ') || modelId;
  return effort ? `${label} (${capitalizeToken(effort)})` : label;
};

/**
 * Resolves the label for one model id when the CLI printed no display name.
 *
 * `agy models` on CLI 1.1.8 prints bare ids, so the shipped catalog is consulted
 * first: it carries the exact names the CLI uses elsewhere (`GPT-OSS 120B`),
 * which no id-derived heuristic can reproduce.
 */
const labelForAntigravityModelId = (modelId: string): string => (
  ANTIGRAVITY_FALLBACK_MODELS.OPTIONS.find((option) => option.value === modelId)?.label
    ?? buildAntigravityModelLabel(modelId)
);

/**
 * Parses `agy models` stdout.
 *
 * Every non-empty line is `<model-id>` optionally followed by whitespace and a
 * display name (`gemini-3.6-flash-high  Gemini 3.6 Flash (High)`). Lines whose
 * first token is not a plausible model id are dropped so banner text or update
 * notices cannot become selectable models.
 *
 * Exported for the provider tests and `AntigravityProviderModels`.
 */
export const parseAntigravityModelsStdout = (stdout: string): ProviderModelOption[] => {
  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) {
      continue;
    }

    const separatorIndex = line.search(/\s/);
    const value = separatorIndex < 0 ? line : line.slice(0, separatorIndex);
    if (!MODEL_ID_TOKEN.test(value) || seenValues.has(value)) {
      continue;
    }

    const displayName = separatorIndex < 0 ? '' : line.slice(separatorIndex).trim();
    seenValues.add(value);
    options.push({
      value,
      label: displayName || labelForAntigravityModelId(value),
    });
  }

  return options;
};

/**
 * Builds the provider catalog from parsed `agy models` rows.
 *
 * Exported for the provider tests and `AntigravityProviderModels`.
 */
export const buildAntigravityDefinition = (
  options: ProviderModelOption[],
): ProviderModelsDefinition => {
  if (options.length === 0) {
    return ANTIGRAVITY_FALLBACK_MODELS;
  }

  const defaultValue = options.find((option) => option.value === ANTIGRAVITY_FALLBACK_MODELS.DEFAULT)?.value
    ?? options[0].value;

  return {
    OPTIONS: options,
    DEFAULT: defaultValue,
  };
};

/**
 * Runs `agy models` and resolves its stdout.
 *
 * Rejects on spawn failure, a non-zero exit, or the timeout so callers can
 * distinguish "Antigravity is unreachable" from "Antigravity has no models".
 */
const runAntigravityModelsCommand = (): Promise<string> => new Promise((resolve, reject) => {
  const antigravityProcess = spawnFunction('agy', ['models'], {
    cwd: process.cwd(),
    env: { ...process.env },
    // `agy` waits for stdin to reach EOF before it prints anything, so an open
    // stdin pipe makes this command hang until the timeout (verified against CLI
    // 1.1.8). Detaching stdin entirely is what lets it exit on its own.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    antigravityProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('agy models timed out'));
    }
  }, ANTIGRAVITY_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
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

  antigravityProcess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  antigravityProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  antigravityProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });

  antigravityProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `agy models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

/** One shared `agy models` read, so concurrent callers never spawn two. */
let inFlightModelsRead: Promise<ProviderModelOption[]> | null = null;
let lastModelsRead: { options: ProviderModelOption[]; readAt: number } | null = null;

/**
 * Runs `agy models` and returns exactly what it listed, without substituting a
 * fallback catalog. Rejects when the CLI cannot be run.
 *
 * Concurrent callers share one invocation and a successful result is reused for
 * `ANTIGRAVITY_MODELS_CACHE_TTL_MS`; failures are never cached, so the next call
 * probes the CLI again. `providerModelsService` keeps its own longer-lived cache
 * on top of this — this one exists purely to stop the auth and model facets from
 * running the command against each other.
 *
 * Used by `AntigravityProviderAuth`, which treats "exited cleanly with at least
 * one model" as proof of usable credentials and therefore must be able to see an
 * empty list.
 */
export const readAntigravityModelOptions = async (): Promise<ProviderModelOption[]> => {
  if (lastModelsRead && Date.now() - lastModelsRead.readAt < ANTIGRAVITY_MODELS_CACHE_TTL_MS) {
    return lastModelsRead.options;
  }

  if (inFlightModelsRead) {
    return inFlightModelsRead;
  }

  inFlightModelsRead = runAntigravityModelsCommand()
    .then((stdout) => {
      const options = parseAntigravityModelsStdout(stdout);
      lastModelsRead = { options, readAt: Date.now() };
      return options;
    })
    .finally(() => {
      inFlightModelsRead = null;
    });

  return inFlightModelsRead;
};

export class AntigravityProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      return buildAntigravityDefinition(await readAntigravityModelOptions());
    } catch {
      return ANTIGRAVITY_FALLBACK_MODELS;
    }
  }

  /**
   * Antigravity exposes no per-conversation model readback: `agy` records the
   * selected model inside opaque trajectory blobs, and the CLI has no query for
   * it. Sessions the app started carry their model on the session row, so this
   * only ever needs to answer with the catalog default.
   */
  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
