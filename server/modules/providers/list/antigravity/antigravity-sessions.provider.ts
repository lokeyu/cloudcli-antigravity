import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'antigravity';

// Antigravity conversation ids are UUIDs; the transcript for a conversation
// lives under a directory named after that id, so the id has to be validated
// before it is used to build a filesystem path.
const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

const AGENT_RESPONSE_STEP = 'agent_response';
const TOOL_STEP = 'tool';

/**
 * Antigravity data directory (`~/.gemini/antigravity-cli`).
 *
 * Only the CLI's own transcript logs are read from here — never the sibling
 * OAuth token file.
 */
const getAntigravityHomeDirectory = (): string => (
  path.join(os.homedir(), '.gemini', 'antigravity-cli')
);

/**
 * Path of the plain-text transcript Antigravity writes for one conversation.
 *
 * The conversation store itself (`conversations/<id>.db`) holds protobuf blobs
 * the CLI does not document, while this JSONL log carries the same steps in a
 * readable form.
 */
const buildTranscriptPath = (conversationId: string): string | null => {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    return null;
  }

  return path.join(
    getAntigravityHomeDirectory(),
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
};

/**
 * Reads a string field without trimming it.
 *
 * `readOptionalString` trims, which would silently eat the leading spaces and
 * trailing newlines that assistant `text_delta` chunks carry — concatenating the
 * deltas has to reproduce the response exactly.
 */
const readRawString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Renders a tool payload for display without throwing on cyclic values. */
const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * Converts one Antigravity usage block into the app's token budget shape.
 *
 * Antigravity's counters nest rather than add up: `cache_read_tokens` is part of
 * `input_tokens`, `thinking_tokens` is part of `output_tokens`, and
 * `total_tokens` equals `input_tokens + output_tokens` (verified against CLI
 * 1.1.8 output). Input and output are therefore reported as-is, and the reported
 * total is trusted when present.
 */
const buildTokenBudget = (usage: AnyRecord | null): AnyRecord | undefined => {
  if (!usage) {
    return undefined;
  }

  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const reportedTotal = Number(usage.total_tokens ?? 0);
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

/**
 * Reads the conversation id out of any `agy --output-format=stream-json` event.
 *
 * Used by the Antigravity runtime adapter to learn the conversation id it has
 * to persist and resume with; every event repeats it, but only the `init` event
 * is guaranteed to arrive before any assistant output.
 */
export const readAntigravityConversationId = (event: unknown): string | null => {
  const record = readObjectRecord(event);
  if (!record) {
    return null;
  }

  const topLevelId = readOptionalString(record.conversation_id);
  if (topLevelId) {
    return topLevelId;
  }

  const stepUpdate = readObjectRecord(record.step_update);
  const resultRecord = readObjectRecord(record.result);
  return readOptionalString(stepUpdate?.conversation_id)
    ?? readOptionalString(resultRecord?.conversation_id)
    ?? null;
};

/**
 * Stateful reader for one `agy --output-format=stream-json` run.
 *
 * The stream is line-delimited JSON where a single logical step is reported
 * several times as it progresses (`ACTIVE` … `DONE`). Two of those repetitions
 * need run-scoped memory, which is why this is an instance rather than a pure
 * function:
 *
 * - assistant text arrives as `text_delta` on both `ACTIVE` and `DONE` updates
 *   of the same `step_index`. Antigravity 1.1.8 sends strict increments, but a
 *   build that repeats the accumulated text on `DONE` would otherwise duplicate
 *   the whole message, so each step's emitted text is remembered and only the
 *   unseen remainder is forwarded.
 * - tool steps are reported twice (invocation, then completion). `step_index`
 *   is unique for the lifetime of a conversation, so it is the call correlation
 *   id: both updates emit the same `toolId` and the second one carries the
 *   result, which is how the other providers attach output to a tool call.
 *
 * Used by the Antigravity runtime adapter (one instance per run) and by
 * `AntigravitySessionsProvider.normalizeMessage`.
 */
export class AntigravityStreamParser {
  /** Assistant text already forwarded, per `step_index`. */
  private readonly emittedTextByStep = new Map<number, string>();
  /** Tool ids already announced, per `step_index`. */
  private readonly toolIdByStep = new Map<number, string>();
  /**
   * Run-scoped id prefix. Step indexes restart at 0 for every new conversation,
   * so they alone would collide between runs of different sessions.
   */
  private readonly runId = generateMessageId(PROVIDER);

  /**
   * Maps one parsed stream event onto normalized messages.
   *
   * Unknown events and steps the UI has no representation for (user echoes,
   * conversation history markers, checkpoints) return an empty list.
   */
  parseEvent(event: unknown, sessionId: string | null): NormalizedMessage[] {
    const record = readObjectRecord(event);
    if (!record) {
      return [];
    }

    const eventName = readOptionalString(record.event);
    if (eventName === 'step_update') {
      return this.parseStepUpdate(readObjectRecord(record.step_update), sessionId);
    }

    if (eventName === 'result') {
      return this.parseResult(readObjectRecord(record.result), sessionId);
    }

    // `init` only carries the conversation id and environment echo; the runtime
    // reads it directly and turns it into the session mapping.
    return [];
  }

  private parseStepUpdate(
    stepUpdate: AnyRecord | null,
    sessionId: string | null,
  ): NormalizedMessage[] {
    if (!stepUpdate) {
      return [];
    }

    const stepType = readOptionalString(stepUpdate.step_type);
    if (stepType === AGENT_RESPONSE_STEP) {
      return this.parseAgentResponse(stepUpdate, sessionId);
    }

    if (stepType === TOOL_STEP) {
      return this.parseToolStep(stepUpdate, sessionId);
    }

    return [];
  }

  private parseAgentResponse(
    stepUpdate: AnyRecord,
    sessionId: string | null,
  ): NormalizedMessage[] {
    const delta = readRawString(stepUpdate.text_delta);
    if (!delta) {
      return [];
    }

    const stepIndex = this.readStepIndex(stepUpdate);
    const emitted = this.emittedTextByStep.get(stepIndex) ?? '';
    const content = this.readUnseenText(emitted, delta);
    if (!content) {
      return [];
    }

    this.emittedTextByStep.set(stepIndex, emitted + content);

    return [createNormalizedMessage({
      // The suffix keeps ids unique across the several deltas of one step.
      id: `${this.runId}_step_${stepIndex}_${emitted.length}`,
      sessionId,
      provider: PROVIDER,
      kind: 'stream_delta',
      content,
    })];
  }

  /**
   * Returns the part of `delta` that has not been forwarded yet.
   *
   * A strict increment is returned unchanged. A cumulative snapshot (the whole
   * message so far) is reduced to its new tail, and an exact repeat of what was
   * already sent is dropped.
   */
  private readUnseenText(emitted: string, delta: string): string {
    if (!emitted) {
      return delta;
    }

    if (delta === emitted) {
      return '';
    }

    if (delta.startsWith(emitted)) {
      return delta.slice(emitted.length);
    }

    return delta;
  }

  private parseToolStep(
    stepUpdate: AnyRecord,
    sessionId: string | null,
  ): NormalizedMessage[] {
    const stepIndex = this.readStepIndex(stepUpdate);
    const toolInfo = readObjectRecord(stepUpdate.tool_info);
    const toolName = readOptionalString(stepUpdate.tool_name)
      ?? readOptionalString(toolInfo?.name)
      ?? 'Tool';
    const state = readOptionalString(stepUpdate.state) ?? '';
    const isFirstUpdate = !this.toolIdByStep.has(stepIndex);
    const toolId = this.toolIdByStep.get(stepIndex) ?? `${this.runId}_tool_${stepIndex}`;
    this.toolIdByStep.set(stepIndex, toolId);

    const message = createNormalizedMessage({
      // `ACTIVE` announces the call and `DONE`/`ERROR` completes it; distinct
      // message ids with a shared toolId let the UI update in place.
      id: isFirstUpdate ? `${toolId}_call` : `${toolId}_${state.toLowerCase() || 'update'}`,
      sessionId,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName,
      toolInput: toolInfo?.parameters ?? {},
      toolId,
    });

    const toolError = readObjectRecord(toolInfo?.error);
    if (state === 'ERROR' || toolError) {
      message.toolResult = {
        content: readOptionalString(toolError?.message)
          ?? formatToolContent(toolError ?? 'Antigravity tool call failed'),
        isError: true,
      };
      return [message];
    }

    if (toolInfo && toolInfo.output !== undefined) {
      message.toolResult = {
        content: formatToolContent(toolInfo.output),
        isError: false,
      };
    }

    return [message];
  }

  private parseResult(
    result: AnyRecord | null,
    sessionId: string | null,
  ): NormalizedMessage[] {
    if (!result) {
      return [];
    }

    const messages: NormalizedMessage[] = [];
    const status = readOptionalString(result.status) ?? '';
    if (status !== 'SUCCESS') {
      messages.push(createNormalizedMessage({
        sessionId,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(result.error)
          ?? `Antigravity finished with status ${status || 'UNKNOWN'}`,
      }));
    }

    const tokenBudget = buildTokenBudget(readObjectRecord(result.usage));
    if (tokenBudget) {
      messages.push(createNormalizedMessage({
        sessionId,
        provider: PROVIDER,
        kind: 'status',
        text: 'token_budget',
        tokenBudget,
      }));
    }

    messages.push(createNormalizedMessage({
      sessionId,
      provider: PROVIDER,
      kind: 'stream_end',
    }));

    return messages;
  }

  private readStepIndex(stepUpdate: AnyRecord): number {
    const stepIndex = Number(stepUpdate.step_index);
    return Number.isFinite(stepIndex) ? stepIndex : -1;
  }
}

type AntigravityTranscriptStep = {
  stepIndex: number;
  source: string;
  type: string;
  status: string;
  createdAt: string;
  content: string;
  toolCalls: AnyRecord[];
  exitCode: number | null;
};

const USER_REQUEST_TAG = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/;

/**
 * Extracts the prompt a user actually typed from a transcript `USER_INPUT` step.
 *
 * Antigravity wraps the prompt in `<USER_REQUEST>` and appends generated
 * `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` blocks that must not be
 * shown as part of the message.
 */
const readUserRequestText = (content: string): string => {
  const tagged = USER_REQUEST_TAG.exec(content);
  if (tagged) {
    return tagged[1].trim();
  }

  return content.split(/<[A-Z_]+>/)[0].trim();
};

const readTranscriptStep = (line: string): AntigravityTranscriptStep | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = readObjectRecord(parsed);
  if (!record) {
    return null;
  }

  const stepIndex = Number(record.step_index);
  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls.map((call) => readObjectRecord(call)).filter((call): call is AnyRecord => call !== null)
    : [];

  return {
    stepIndex: Number.isFinite(stepIndex) ? stepIndex : -1,
    source: readOptionalString(record.source) ?? '',
    type: readOptionalString(record.type) ?? '',
    status: readOptionalString(record.status) ?? '',
    createdAt: normalizeProviderTimestamp(record.created_at),
    content: readRawString(record.content),
    toolCalls,
    exitCode: typeof record.exit_code === 'number' ? record.exit_code : null,
  };
};

export class AntigravitySessionsProvider implements IProviderSessions {
  /**
   * Normalizes one live `agy --output-format=stream-json` event.
   *
   * The runtime adapter drives a long-lived `AntigravityStreamParser` instead,
   * because text de-duplication and tool correlation need run-scoped state.
   * This entry point exists for the shared `IProviderSessions` contract and
   * treats every event as if it were the first one of a run.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    return new AntigravityStreamParser().parseEvent(rawMessage, sessionId);
  }

  /**
   * Loads history from the transcript log Antigravity writes per conversation.
   *
   * Pagination follows the shared tail contract (`sliceTailPage`): offset 0 is
   * the most recent page and `limit: null` means unbounded.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const emptyResult: FetchHistoryResult = {
      messages: [],
      total: 0,
      hasMore: false,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };

    // The transcript directory is named after the provider-native conversation
    // id, not the app-facing session id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const transcriptPath = buildTranscriptPath(providerSessionId);
    if (!transcriptPath) {
      return emptyResult;
    }

    let content: string;
    try {
      content = await readFile(transcriptPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[AntigravityProvider] Failed to load session ${sessionId}:`, message);
      }
      return emptyResult;
    }

    const normalized = this.normalizeTranscriptSteps(content, sessionId);
    const total = normalized.length;
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }

  /**
   * Converts transcript JSONL text into normalized messages.
   *
   * Public so the provider tests can exercise transcript normalization without
   * a real Antigravity data directory.
   */
  normalizeTranscriptSteps(content: string, sessionId: string): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const step = readTranscriptStep(trimmed);
      if (!step) {
        // A truncated trailing line must not hide the rest of the transcript.
        continue;
      }

      const baseId = `${sessionId}_step_${step.stepIndex >= 0 ? step.stepIndex : messages.length}`;

      if (step.type === 'USER_INPUT') {
        const text = readUserRequestText(step.content);
        if (text) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: step.createdAt,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
          }));
        }
        continue;
      }

      if (step.type === 'PLANNER_RESPONSE') {
        if (step.content.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: step.createdAt,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: step.content,
          }));
        }

        // One planner step can request several tools; the discriminator keeps
        // the emitted ids unique.
        step.toolCalls.forEach((call, callIndex) => {
          messages.push(createNormalizedMessage({
            id: `${baseId}_tool_${callIndex}`,
            sessionId,
            timestamp: step.createdAt,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: readOptionalString(call.name) ?? 'Tool',
            toolInput: call.args ?? {},
            toolId: `${baseId}_tool_${callIndex}`,
          }));
        });
        continue;
      }

      // Remaining MODEL steps are tool outputs, typed after the tool that ran
      // (`RUN_COMMAND`, `VIEW_FILE`, …). System steps (conversation history,
      // checkpoints, system messages) are internal bookkeeping.
      if (step.source === 'MODEL' && step.content.trim()) {
        messages.push(createNormalizedMessage({
          id: `${baseId}_result`,
          sessionId,
          timestamp: step.createdAt,
          provider: PROVIDER,
          kind: 'tool_result',
          toolName: step.type,
          toolId: baseId,
          content: step.content,
          isError: step.status === 'ERROR' || (step.exitCode !== null && step.exitCode !== 0),
        }));
      }
    }

    return messages;
  }
}
