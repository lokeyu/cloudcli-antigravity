import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTIGRAVITY_FALLBACK_MODELS,
  buildAntigravityDefinition,
  parseAntigravityModelsStdout,
} from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import {
  AntigravityStreamParser,
  AntigravitySessionsProvider,
  readAntigravityConversationId,
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

const CONVERSATION_ID = '6994ceee-e745-4ffe-87d0-1d430ecb2526';

const stepUpdate = (stepUpdateFields: Record<string, unknown>) => ({
  event: 'step_update',
  step_update: { conversation_id: CONVERSATION_ID, ...stepUpdateFields },
});

const parseAll = (
  parser: AntigravityStreamParser,
  events: unknown[],
  sessionId: string | null = CONVERSATION_ID,
): NormalizedMessage[] => events.flatMap((event) => parser.parseEvent(event, sessionId));

// ---------------------------
// `agy models` parsing

test('Antigravity models provider parses bare ids, display names, and drops junk', () => {
  const options = parseAntigravityModelsStdout(`
gemini-3.6-flash-high
gemini-3.1-pro-low   Gemini 3.1 Pro (Low)
claude-sonnet-4-6
gpt-oss-120b-medium
not a model id at all
gemini-3.6-flash-high
{"json":"noise"}

`);

  assert.deepEqual(options, [
    // No display name printed and a known id → the shipped catalog label wins.
    { value: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
    // Display name printed → used verbatim.
    { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ]);
});

test('Antigravity models provider derives labels for ids missing from the shipped catalog', () => {
  const options = parseAntigravityModelsStdout('gemini-4.0-pro-high\nclaude-haiku-5-2\n');

  assert.deepEqual(options, [
    { value: 'gemini-4.0-pro-high', label: 'Gemini 4.0 Pro (High)' },
    { value: 'claude-haiku-5-2', label: 'Claude Haiku 5.2' },
  ]);
});

test('Antigravity models provider keeps the documented default and falls back on empty output', () => {
  const definition = buildAntigravityDefinition(parseAntigravityModelsStdout(`
claude-sonnet-4-6
gemini-3.6-flash-high
`));
  assert.equal(definition.DEFAULT, 'gemini-3.6-flash-high');
  assert.deepEqual(definition.OPTIONS.map((option) => option.value), [
    'claude-sonnet-4-6',
    'gemini-3.6-flash-high',
  ]);

  // Without the documented default present, the first listed model stands in.
  assert.equal(buildAntigravityDefinition(parseAntigravityModelsStdout('claude-sonnet-4-6')).DEFAULT, 'claude-sonnet-4-6');
  assert.deepEqual(buildAntigravityDefinition([]), ANTIGRAVITY_FALLBACK_MODELS);
  assert.equal(ANTIGRAVITY_FALLBACK_MODELS.DEFAULT, 'gemini-3.6-flash-high');
});

// ---------------------------
// Live stream parsing

test('Antigravity init event carries the conversation id and emits nothing', () => {
  const initEvent = {
    event: 'init',
    conversation_id: CONVERSATION_ID,
    init: {
      model: 'gemini-3.6-flash-high',
      cwd: '/project/path',
      tools: [],
      permission_mode: 'request-review',
    },
  };

  assert.equal(readAntigravityConversationId(initEvent), CONVERSATION_ID);
  // Every later event repeats the id, so a dropped init still resolves it.
  assert.equal(readAntigravityConversationId(stepUpdate({ step_index: 0 })), CONVERSATION_ID);
  assert.equal(
    readAntigravityConversationId({ event: 'result', result: { conversation_id: CONVERSATION_ID } }),
    CONVERSATION_ID,
  );
  assert.equal(readAntigravityConversationId('not an object'), null);
  assert.equal(readAntigravityConversationId({ event: 'init', init: {} }), null);

  assert.deepEqual(new AntigravityStreamParser().parseEvent(initEvent, CONVERSATION_ID), []);
});

test('Antigravity assistant text streams as incremental deltas without duplication', () => {
  const parser = new AntigravityStreamParser();
  const messages = parseAll(parser, [
    stepUpdate({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    stepUpdate({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Gravity is ' }),
    stepUpdate({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'the invisible ' }),
    // CLI 1.1.8 puts the last increment on the DONE update rather than repeating.
    stepUpdate({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'architect.' }),
    stepUpdate({ step_index: 3, state: 'DONE', step_type: 'checkpoint' }),
  ]);

  assert.deepEqual(messages.map((message) => message.kind), [
    'stream_delta',
    'stream_delta',
    'stream_delta',
  ]);
  assert.equal(messages.map((message) => message.content).join(''), 'Gravity is the invisible architect.');
  assert.equal(new Set(messages.map((message) => message.id)).size, 3);
  assert.deepEqual(new Set(messages.map((message) => message.provider)), new Set(['antigravity']));
});

test('Antigravity text parsing tolerates a cumulative DONE snapshot and exact repeats', () => {
  const parser = new AntigravityStreamParser();
  const messages = parseAll(parser, [
    stepUpdate({ step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Part one. ' }),
    // A build that resends the whole message on DONE must not duplicate it.
    stepUpdate({ step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'Part one. Part two.' }),
    // A verbatim repeat of everything already forwarded is dropped entirely.
    stepUpdate({ step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'Part one. Part two.' }),
    stepUpdate({ step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: '' }),
  ]);

  assert.deepEqual(messages.map((message) => message.content), ['Part one. ', 'Part two.']);
});

test('Antigravity text steps stay independent so one step cannot swallow another', () => {
  const parser = new AntigravityStreamParser();
  const messages = parseAll(parser, [
    stepUpdate({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'Same text.' }),
    stepUpdate({ step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'Same text.' }),
  ]);

  assert.deepEqual(messages.map((message) => message.content), ['Same text.', 'Same text.']);
});

test('Antigravity tool ACTIVE and DONE updates correlate through step_index', () => {
  const parser = new AntigravityStreamParser();
  const toolInfo = { name: 'run_command', parameters: { CommandLine: 'pwd' } };
  const messages = parseAll(parser, [
    stepUpdate({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: toolInfo }),
    stepUpdate({
      step_index: 3,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { ...toolInfo, output: '/project/path' },
    }),
  ]);

  assert.equal(messages.length, 2);
  const [call, completion] = messages;
  assert.equal(call.kind, 'tool_use');
  assert.equal(call.toolName, 'run_command');
  assert.deepEqual(call.toolInput, { CommandLine: 'pwd' });
  assert.equal(call.toolResult, undefined);

  assert.equal(completion.kind, 'tool_use');
  // Same call, two updates: one shared toolId, two distinct message ids.
  assert.equal(completion.toolId, call.toolId);
  assert.notEqual(completion.id, call.id);
  assert.deepEqual(completion.toolResult, { content: '/project/path', isError: false });
});

test('Antigravity tool errors are reported on the correlated tool call', () => {
  const parser = new AntigravityStreamParser();
  const toolInfo = { name: 'run_command', parameters: { CommandLine: 'pwd' } };
  const messages = parseAll(parser, [
    stepUpdate({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: toolInfo }),
    stepUpdate({
      step_index: 3,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        ...toolInfo,
        error: { type: 'TOOL_ERROR', message: 'User denied permission to run command:\npwd' },
      },
    }),
  ]);

  assert.equal(messages[1].toolId, messages[0].toolId);
  assert.deepEqual(messages[1].toolResult, {
    content: 'User denied permission to run command:\npwd',
    isError: true,
  });
});

test('Antigravity tool output serializes structured payloads', () => {
  const messages = new AntigravityStreamParser().parseEvent(
    stepUpdate({
      step_index: 7,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'list_dir',
      tool_info: { name: 'list_dir', parameters: {}, output: { entries: ['a.txt'] } },
    }),
    CONVERSATION_ID,
  );

  assert.equal(messages[0].toolResult?.content, JSON.stringify({ entries: ['a.txt'] }, null, 2));
  assert.equal(messages[0].toolResult?.isError, false);
});

test('Antigravity successful result reports usage and ends the stream', () => {
  const messages = new AntigravityStreamParser().parseEvent({
    event: 'result',
    result: {
      conversation_id: CONVERSATION_ID,
      status: 'SUCCESS',
      response: 'Hello from Antigravity.\n',
      duration_seconds: 1.2,
      num_turns: 1,
      usage: {
        input_tokens: 9968,
        output_tokens: 54,
        thinking_tokens: 49,
        cache_read_tokens: 8141,
        total_tokens: 10022,
      },
    },
  }, CONVERSATION_ID);

  assert.deepEqual(messages.map((message) => message.kind), ['status', 'stream_end']);
  assert.equal(messages[0].text, 'token_budget');
  // cache_read_tokens is already inside input_tokens and thinking_tokens inside
  // output_tokens, so neither is added again.
  assert.deepEqual(messages[0].tokenBudget, {
    used: 10022,
    inputTokens: 9968,
    outputTokens: 54,
    breakdown: { input: 9968, output: 54 },
  });
});

test('Antigravity failed result surfaces the CLI error before ending the stream', () => {
  const messages = new AntigravityStreamParser().parseEvent({
    event: 'result',
    result: {
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'invalid model selection (--model "not-a-real-model")',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  }, null);

  assert.deepEqual(messages.map((message) => message.kind), ['error', 'stream_end']);
  assert.equal(messages[0].content, 'invalid model selection (--model "not-a-real-model")');
  // A zero-token usage block is not reported as a budget.
  assert.equal(messages.some((message) => message.kind === 'status'), false);
});

test('Antigravity non-SUCCESS results without an error message still report a failure', () => {
  const messages = new AntigravityStreamParser().parseEvent({
    event: 'result',
    result: { status: 'CANCELLED' },
  }, CONVERSATION_ID);

  assert.equal(messages[0].kind, 'error');
  assert.equal(messages[0].content, 'Antigravity finished with status CANCELLED');
});

test('Antigravity stream parser ignores unknown and malformed events', () => {
  const parser = new AntigravityStreamParser();

  assert.deepEqual(parser.parseEvent(null, CONVERSATION_ID), []);
  assert.deepEqual(parser.parseEvent('a string', CONVERSATION_ID), []);
  assert.deepEqual(parser.parseEvent({ event: 'something_new' }, CONVERSATION_ID), []);
  assert.deepEqual(parser.parseEvent({ event: 'step_update' }, CONVERSATION_ID), []);
  assert.deepEqual(parser.parseEvent({ event: 'result' }, CONVERSATION_ID), []);
  assert.deepEqual(parser.parseEvent(stepUpdate({ step_index: 1, state: 'DONE', step_type: 'unknown' }), CONVERSATION_ID), []);

  // A step_update without a step_index still parses instead of throwing.
  const orphan = parser.parseEvent(
    stepUpdate({ state: 'DONE', step_type: 'agent_response', text_delta: 'No index.' }),
    CONVERSATION_ID,
  );
  assert.equal(orphan[0].content, 'No index.');
});

test('Antigravity sessions provider exposes single-event normalization', () => {
  const provider = new AntigravitySessionsProvider();
  const messages = provider.normalizeMessage(
    stepUpdate({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'One shot.' }),
    'app-session-1',
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].content, 'One shot.');
  assert.equal(messages[0].sessionId, 'app-session-1');
});

// ---------------------------
// Transcript history

const TRANSCRIPT = [
  {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-07-30T10:57:39Z',
    content: '<USER_REQUEST>\nRun pwd and report the output.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-07-30T10:57:39Z.\n</ADDITIONAL_METADATA>',
  },
  {
    step_index: 1,
    source: 'SYSTEM',
    type: 'CONVERSATION_HISTORY',
    status: 'DONE',
    created_at: '2026-07-30T10:57:39Z',
  },
  {
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-07-30T10:57:39Z',
    tool_calls: [{ name: 'run_command', args: { CommandLine: '"pwd"' } }],
  },
  {
    step_index: 3,
    source: 'MODEL',
    type: 'RUN_COMMAND',
    status: 'DONE',
    created_at: '2026-07-30T10:57:40Z',
    exit_code: 0,
    content: 'The command exited with code 0.\nOutput:\n/project/path\n',
  },
  {
    step_index: 4,
    source: 'SYSTEM',
    type: 'CHECKPOINT',
    status: 'DONE',
    created_at: '2026-07-30T10:57:40Z',
    content: '{{ CHECKPOINT 0 }} internal bookkeeping',
  },
  {
    step_index: 5,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-07-30T10:57:40Z',
    content: 'The working directory is `/project/path`.',
  },
];

test('Antigravity transcript normalization renders prompts, tool calls, and results', () => {
  const provider = new AntigravitySessionsProvider();
  // A truncated trailing line (the CLI appends while a run is live) must not
  // hide the steps before it.
  const content = `${TRANSCRIPT.map((step) => JSON.stringify(step)).join('\n')}\n{"step_index":6,"sou`;
  const messages = provider.normalizeTranscriptSteps(content, 'app-session-1');

  assert.deepEqual(messages.map((message) => message.kind), [
    'text',
    'tool_use',
    'tool_result',
    'text',
  ]);

  // The prompt is unwrapped from <USER_REQUEST> and generated metadata blocks
  // are not shown.
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Run pwd and report the output.');
  assert.equal(messages[0].timestamp, new Date('2026-07-30T10:57:39Z').toISOString());

  assert.equal(messages[1].toolName, 'run_command');
  assert.deepEqual(messages[1].toolInput, { CommandLine: '"pwd"' });

  assert.equal(messages[2].toolName, 'RUN_COMMAND');
  assert.equal(messages[2].isError, false);
  assert.match(String(messages[2].content), /\/project\/path/);

  assert.equal(messages[3].role, 'assistant');
  assert.equal(messages[3].content, 'The working directory is `/project/path`.');

  // Every id is unique and scoped to the app session id.
  assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
  assert.deepEqual(new Set(messages.map((message) => message.sessionId)), new Set(['app-session-1']));
});

test('Antigravity transcript normalization flags failed tool steps', () => {
  const provider = new AntigravitySessionsProvider();
  const messages = provider.normalizeTranscriptSteps(JSON.stringify({
    step_index: 3,
    source: 'MODEL',
    type: 'RUN_COMMAND',
    status: 'DONE',
    created_at: '2026-07-30T10:57:40Z',
    exit_code: 2,
    content: 'The command exited with code 2.',
  }), 'app-session-1');

  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].isError, true);
});

test('Antigravity transcript normalization keeps one id per tool call in a multi-tool step', () => {
  const provider = new AntigravitySessionsProvider();
  const messages = provider.normalizeTranscriptSteps(JSON.stringify({
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-07-30T10:57:39Z',
    content: 'Checking two things.',
    tool_calls: [
      { name: 'list_dir', args: { DirectoryPath: '/a' } },
      { name: 'list_dir', args: { DirectoryPath: '/b' } },
    ],
  }), 'app-session-1');

  assert.deepEqual(messages.map((message) => message.kind), ['text', 'tool_use', 'tool_use']);
  assert.equal(new Set(messages.map((message) => message.id)).size, 3);
  assert.notEqual(messages[1].toolId, messages[2].toolId);
});

test('Antigravity history returns an empty page for unknown or unsafe conversation ids', async () => {
  const provider = new AntigravitySessionsProvider();

  // Path traversal in a provider-native id must never reach the filesystem.
  const traversal = await provider.fetchHistory('app-session-1', {
    providerSessionId: '../../../../etc',
    limit: 10,
  });
  assert.deepEqual(traversal, { messages: [], total: 0, hasMore: false, offset: 0, limit: 10 });

  // A well-formed id with no transcript on disk is simply empty history.
  const missing = await provider.fetchHistory('app-session-1', {
    providerSessionId: '00000000-0000-4000-8000-000000000000',
  });
  assert.deepEqual(missing, { messages: [], total: 0, hasMore: false, offset: 0, limit: null });
});
