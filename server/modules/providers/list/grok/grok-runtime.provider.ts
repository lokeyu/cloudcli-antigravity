import childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  readOptionalString,
} from '@/shared/utils.js';

// Grok is not part of the `LLMProvider` union yet: this stage ships the runtime
// adapter alone, and the union gains 'grok' when the provider is registered.
// This is the single place that bridges the gap, so registration only has to
// extend the union and delete the assertion.
const PROVIDER = 'grok' as LLMProvider;

// `grok` is looked up on PATH and spawned directly — never through a shell — so
// the prompt travels as a single argv entry with no quoting rules to get wrong.
const GROK_COMMAND = 'grok';

/**
 * Permission modes `grok` accepts for `--permission-mode` (verified against CLI
 * 0.2.114). The app and the CLI happen to use the same vocabulary here, so the
 * selected mode is forwarded verbatim.
 */
const GROK_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const;

type GrokPermissionMode = typeof GROK_PERMISSION_MODES[number];

/** The child process plus the abort marker the close handler reads back. */
type GrokChildProcess = ChildProcess & { aborted?: boolean };

/**
 * One parsed NDJSON line from `--output-format streaming-json`.
 *
 * The documented event list is not exhaustive, so every field stays `unknown`
 * and is narrowed at its use site: an unrecognized or wrongly typed payload has
 * to be ignorable rather than a crash.
 */
type GrokStreamEvent = {
  type?: unknown;
  data?: unknown;
  message?: unknown;
  sessionId?: unknown;
  usage?: unknown;
};

/** The metering block Grok reports on `end`; absent keys mean an unmetered turn. */
type GrokUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
};

/** The shared token budget shape carried by a `status`/`token_budget` message. */
type GrokTokenBudget = {
  used: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: { input: number; output: number };
};

/** The subset of the caller's run options this runtime understands. */
type GrokRunOptions = {
  sessionId?: string;
  projectPath?: string;
  cwd?: string;
  model?: string;
  sessionSummary?: string;
  permissionMode?: string;
};

/** Fields a run emits on top of the envelope `send()` fills in. */
type GrokMessageFields = {
  kind: NormalizedMessage['kind'];
  content?: string;
  text?: string;
  tokenBudget?: GrokTokenBudget;
};

/** The terminal run notifications this runtime sends. */
type RunStoppedNotification = {
  userId: string | number | null;
  provider: LLMProvider;
  sessionId: string;
  sessionName?: string;
  stopReason: string;
};

type RunFailedNotification = {
  userId: string | number | null;
  provider: LLMProvider;
  sessionId: string;
  sessionName?: string;
  error: Error | string;
};

// `@/modules/notifications` is still JavaScript, so TypeScript infers its
// parameter types from `sessionId = null` style defaults and rejects a real
// session id. These two adapters are the single boundary conversion and can be
// deleted once the notification orchestrator itself is migrated.
const notifyGrokRunStopped =
  notifyRunStopped as unknown as (notification: RunStoppedNotification) => void;
const notifyGrokRunFailed =
  notifyRunFailed as unknown as (notification: RunFailedNotification) => void;

// Only the CLI's own stderr is ever quoted back to the user, and only when it
// is the sole description of a failure; cap it so a crash dump cannot be
// replayed into the transcript in full.
const STDERR_PREVIEW_LENGTH = 500;

// Grok wraps the upstream 402 in a generic "Internal error", which tells the
// user nothing actionable. The marker is the only stable part of that payload.
const QUOTA_EXHAUSTED_MARKER = 'Grok Build usage balance exhausted';
const QUOTA_EXHAUSTED_MESSAGE = 'Grok Build weekly usage balance is exhausted. Try again after the quota resets.';

const activeGrokProcesses = new Map<string, GrokChildProcess>();

const isGrokPermissionMode = (value: unknown): value is GrokPermissionMode =>
  typeof value === 'string' && (GROK_PERMISSION_MODES as readonly string[]).includes(value);

/**
 * Resolves the UI permission mode onto the `--permission-mode` value.
 *
 * Supported modes are forwarded unchanged; anything unrecognized falls back to
 * the CLI's own `default` mode instead of being passed through unchecked.
 *
 * Consumer: `server/modules/providers/tests/grok-runtime.provider.test.ts`.
 */
export function resolveGrokPermissionMode(permissionMode: unknown): GrokPermissionMode {
  return isGrokPermissionMode(permissionMode) ? permissionMode : 'default';
}

/**
 * Builds the argv for one headless `grok` run.
 *
 * `--single` takes the prompt as its own argv entry, so a prompt starting with
 * `-` can never be re-read as a flag. Resuming uses `--resume`: Grok's
 * `--session-id` only *creates* a session under a caller-chosen UUID and would
 * silently start a fresh conversation instead of continuing the recorded one.
 *
 * Consumer: `server/modules/providers/tests/grok-runtime.provider.test.ts`.
 */
export function buildGrokArgs({
  prompt,
  projectPath,
  permissionMode,
  model,
  resumeSessionId,
}: {
  prompt: string;
  projectPath: string;
  permissionMode?: string;
  model?: string;
  resumeSessionId?: string | null;
}): string[] {
  const args = [
    '--single', prompt,
    '--output-format', 'streaming-json',
    '--cwd', projectPath,
    '--permission-mode', resolveGrokPermissionMode(permissionMode),
  ];

  if (model) {
    args.push('--model', model);
  }

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  return args;
}

/**
 * Turns a Grok `error` event message into something worth showing a user.
 *
 * Consumer: `server/modules/providers/tests/grok-runtime.provider.test.ts`.
 */
export function normalizeGrokErrorMessage(message: unknown): string {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    return 'Grok CLI reported an error without a message';
  }

  // The nested technical wrapper is dropped once the cause is recognized.
  if (text.includes(QUOTA_EXHAUSTED_MARKER)) {
    return QUOTA_EXHAUSTED_MESSAGE;
  }

  return text;
}

/** Reads the run options this runtime supports out of the caller's payload. */
const readGrokRunOptions = (options: AnyRecord): GrokRunOptions => ({
  sessionId: readOptionalString(options.sessionId),
  projectPath: readOptionalString(options.projectPath),
  cwd: readOptionalString(options.cwd),
  model: readOptionalString(options.model),
  sessionSummary: readOptionalString(options.sessionSummary),
  permissionMode: readOptionalString(options.permissionMode),
});

/** Narrows one NDJSON line to an event object, or `null` if it is not one. */
const parseGrokStreamEvent = (line: string): GrokStreamEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // The stream is NDJSON but not guaranteed to be *only* NDJSON, so a line
    // that will not parse is dropped instead of failing the run.
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  return parsed as GrokStreamEvent;
};

/** Reads a token count that Grok may report under either naming convention. */
const readTokenCount = (...candidates: unknown[]): number => {
  for (const candidate of candidates) {
    const count = Number(candidate);
    if (Number.isFinite(count) && count !== 0) {
      return count;
    }
  }

  return 0;
};

/**
 * Converts the `end` event's usage block into the shared token budget shape.
 *
 * Grok reports `usage: {}` for turns it does not meter, which yields no budget
 * message rather than a zeroed one.
 */
const buildGrokTokenBudget = (usage: unknown): GrokTokenBudget | undefined => {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return undefined;
  }

  const reported = usage as GrokUsage;
  const inputTokens = readTokenCount(reported.input_tokens, reported.inputTokens);
  const outputTokens = readTokenCount(reported.output_tokens, reported.outputTokens);
  const reportedTotal = readTokenCount(reported.total_tokens, reported.totalTokens);
  const used = reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens;

  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
};

async function runGrok(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    sessionSummary,
    permissionMode,
  } = readGrokRunOptions(options ?? {});

  // Callers pass the stable app session id; the CLI resumes with the
  // provider-native session id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  // Grok takes the workspace through `--cwd`, and the child process cwd is kept
  // in sync so relative paths resolve the same way either route is used.
  const workingDir = cwd || projectPath || process.cwd();
  // Process-map key: the app session id when the caller supplied one, so
  // abort-by-app-id always works.
  const processKey = sessionId || Date.now().toString();

  return new Promise<void>((resolve, reject) => {
    let capturedSessionId: string | null = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let stderrText = '';
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    let terminalNotificationSent = false;
    // The `end` event closes the assistant stream; a repeat must not re-emit
    // usage or a second stream end.
    let endHandled = false;
    // Set once the CLI has reported a failure itself, so a non-zero exit does
    // not surface the same problem a second time in different words.
    let sawErrorEvent = false;

    const notifyTerminalState = ({ code = null, error = null }: {
      code?: number | null;
      error?: Error | string | null;
    } = {}): void => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyGrokRunStopped({
          userId: writer.userId || null,
          provider: PROVIDER,
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyGrokRunFailed({
        userId: writer.userId || null,
        provider: PROVIDER,
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Grok CLI exited with code ${code}`,
      });
    };

    const send = (fields: GrokMessageFields): void => {
      writer.send(createNormalizedMessage({
        ...fields,
        sessionId: capturedSessionId || sessionId || null,
        provider: PROVIDER,
      }));
    };

    const sendError = (content: string): void => {
      send({ kind: 'error', content });
    };

    const registerSession = (nextSessionId: string | undefined): void => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      const runningProcess = activeGrokProcesses.get(processKey);
      if (!sessionId && processKey !== capturedSessionId && runningProcess) {
        activeGrokProcesses.delete(processKey);
        activeGrokProcesses.set(capturedSessionId, runningProcess);
      }

      writer.setSessionId?.(capturedSessionId);

      // The chat gateway turns this into the app-id-to-session-id mapping that
      // later turns resume with.
      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: PROVIDER,
        }));
      }
    };

    const handleGrokEvent = (event: GrokStreamEvent): void => {
      switch (event.type) {
        case 'text': {
          const content = typeof event.data === 'string' ? event.data : '';
          if (content) {
            // Deltas are forwarded as they arrive and never replayed later, so
            // the transcript cannot end up with the answer twice.
            send({ kind: 'stream_delta', content });
          }
          return;
        }

        case 'thought': {
          const content = typeof event.data === 'string' ? event.data : '';
          if (content) {
            // Reasoning has its own kind, so it is never mixed into the
            // assistant's visible answer.
            send({ kind: 'thinking', content });
          }
          return;
        }

        case 'end': {
          registerSession(readOptionalString(event.sessionId));
          if (endHandled) {
            return;
          }

          endHandled = true;
          const tokenBudget = buildGrokTokenBudget(event.usage);
          if (tokenBudget) {
            send({ kind: 'status', text: 'token_budget', tokenBudget });
          }

          send({ kind: 'stream_end' });
          return;
        }

        case 'error': {
          sawErrorEvent = true;
          sendError(normalizeGrokErrorMessage(event.message));
          return;
        }

        default:
          // The event list is open-ended; unknown but well-formed events are
          // not this adapter's business.
      }
    };

    const processGrokOutputLine = (line: string): void => {
      if (!line || !line.trim()) {
        return;
      }

      const event = parseGrokStreamEvent(line);
      if (!event) {
        return;
      }

      try {
        handleGrokEvent(event);
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[Grok] Failed to process stream event:', errorContent);
        sendError(errorContent);
      }
    };

    const releaseProcess = (): void => {
      activeGrokProcesses.delete(processKey);
      if (sessionId) {
        activeGrokProcesses.delete(sessionId);
      }
      if (capturedSessionId) {
        activeGrokProcesses.delete(capturedSessionId);
      }
    };

    // `grok` is a native binary, but keep the shared prompt flattening so an
    // npm-style shim on Windows cannot truncate a multi-line prompt.
    const prompt = flattenPromptForWindowsShell(command || '');
    const args = buildGrokArgs({
      prompt,
      projectPath: workingDir,
      permissionMode,
      model: resolvedModel,
      resumeSessionId: providerSessionId,
    });

    const grokProcess: GrokChildProcess = childProcess.spawn(GROK_COMMAND, args, {
      cwd: workingDir,
      // Headless mode takes its prompt from `--single` and never reads stdin;
      // detaching it keeps the CLI from waiting on an EOF that never comes.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    activeGrokProcesses.set(processKey, grokProcess);

    grokProcess.stdout?.on('data', (chunk: Buffer | string) => {
      // Stream chunks can split a JSON line across packets; keep the trailing
      // partial line until its newline arrives.
      stdoutLineBuffer += chunk.toString();
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';

      completeLines.forEach((line) => {
        processGrokOutputLine(line.trim());
      });
    });

    grokProcess.stderr?.on('data', (chunk: Buffer | string) => {
      // Buffered rather than forwarded: on a clean run Grok's stderr is noise,
      // and on a failing run it is the only description of what went wrong.
      stderrText += chunk.toString();
    });

    grokProcess.on('close', async (code: number | null) => {
      releaseProcess();

      if (stdoutLineBuffer.trim()) {
        processGrokOutputLine(stdoutLineBuffer.trim());
      }
      stdoutLineBuffer = '';

      const finalSessionId = sessionId || capturedSessionId || processKey;
      const failed = code !== 0 || sawErrorEvent;

      if (code !== 0 && !sawErrorEvent) {
        if (code === 127 || code === null) {
          const installed = await context.isProviderInstalled();
          if (!installed) {
            sendError('Grok CLI (grok) is not installed. Install it from https://grok.com');
          }
        }

        // Only the CLI's own stderr is quoted back — never the environment it
        // ran with, which is where credentials would live.
        const stderrDetail = stderrText.trim().slice(0, STDERR_PREVIEW_LENGTH);
        sendError(stderrDetail || (code === null
          ? 'Grok CLI process was terminated'
          : `Grok CLI exited with code ${code}`));
      }

      // Terminal complete — skipped for aborted runs (abort-session already
      // sent the aborted complete on this run's behalf).
      if (!completeSent && !grokProcess.aborted) {
        completeSent = true;
        writer.send(createCompleteMessage({
          provider: PROVIDER,
          sessionId: finalSessionId,
          // A clean exit that still reported an error is a failed run.
          exitCode: failed ? (code ?? 1) : 0,
        }));
      }

      if (!failed) {
        notifyTerminalState({ code });
        resolve();
        return;
      }

      notifyTerminalState({ code: code ?? 1 });
      if (code === null) {
        reject(new Error('Grok CLI process was terminated'));
        return;
      }

      reject(new Error(code === 0
        ? 'Grok CLI reported a failed run'
        : `Grok CLI exited with code ${code}`));
    });

    grokProcess.on('error', async (error: Error) => {
      releaseProcess();

      const finalSessionId = sessionId || capturedSessionId || processKey;
      const installed = await context.isProviderInstalled();
      sendError(!installed
        ? 'Grok CLI (grok) is not installed. Install it from https://grok.com'
        : error.message);

      if (!completeSent && !grokProcess.aborted) {
        completeSent = true;
        writer.send(createCompleteMessage({
          provider: PROVIDER,
          sessionId: finalSessionId,
          exitCode: 1,
        }));
      }

      notifyTerminalState({ error });
      reject(error);
    });
  });
}

/**
 * Cancels a run by terminating the `grok` child process.
 *
 * Headless mode has no cancel message, so the process itself is the
 * cancellation unit. The conversation stays resumable: Grok has already
 * persisted the turns it completed under the same session id.
 */
function abortGrokRun(sessionId: string): boolean {
  const grokProcess = activeGrokProcesses.get(sessionId);
  if (!grokProcess) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  grokProcess.aborted = true;
  grokProcess.kill('SIGTERM');
  activeGrokProcesses.delete(sessionId);
  return true;
}

/**
 * Grok's live execution adapter.
 *
 * Consumers: the provider registry, once Grok is registered as a provider, and
 * `server/modules/providers/tests/grok-runtime.provider.test.ts`.
 */
export const grokRuntime: IProviderRuntime = {
  run: runGrok,
  abort: abortGrokRun,
};
