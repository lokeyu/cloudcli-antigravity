import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildGrokArgs,
  grokRuntime,
  normalizeGrokErrorMessage,
  resolveGrokPermissionMode,
} from '@/modules/providers/list/grok/grok-runtime.provider.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const SESSION_ID = '9f1c2d34-5b6a-47e8-9c01-2d3e4f5a6b7c';
const PROJECT_DIR = '/tmp/grok-project';

/**
 * Every Grok run in this file is fully synthetic: `child_process.spawn` is
 * replaced with a recorder that hands back this fake child, so no `grok` binary
 * is located, executed, or asked to spend the account's weekly quota.
 */
class FakeGrokProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  killed = false;

  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    this.killed = true;
    return true;
  }

  writeStdout(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
  }

  writeStderr(chunk: string): void {
    this.stderr.emit('data', Buffer.from(chunk));
  }

  /** Replays NDJSON lines the way a real stream would: one trailing newline each. */
  writeEvents(events: AnyRecord[]): void {
    for (const event of events) {
      this.writeStdout(`${JSON.stringify(event)}\n`);
    }
  }

  close(code: number | null): void {
    this.emit('close', code);
  }
}

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeGrokProcess;
};

type TestWriter = ProviderRuntimeWriter & {
  sessionId: string | null;
  messages: NormalizedMessage[];
};

/**
 * Swaps `child_process.spawn` for a recorder. The two assertions below are the
 * seam between the fake process and Node's heavily overloaded spawn signature;
 * nothing else in this file asserts types.
 */
function installSpawnMock(): { calls: SpawnCall[]; restore(): void } {
  const calls: SpawnCall[] = [];
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeGrokProcess();
    calls.push({ command, args, options, child });
    return child as unknown as ChildProcess;
  }) as typeof childProcess.spawn;

  return {
    calls,
    restore() {
      childProcess.spawn = originalSpawn;
    },
  };
}

const createRuntimeContext = (
  overrides: Partial<ProviderRuntimeContext> = {},
): ProviderRuntimeContext => ({
  // A brand-new app session has no Grok session id recorded yet; the resume
  // tests override this with a known provider-native id.
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel?.trim() || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  // The Grok runtime parses its own stream and never calls this.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
  ...overrides,
});

const createWriter = (): TestWriter => ({
  userId: null,
  sessionId: null,
  messages: [],
  send(message: unknown) {
    this.messages.push(message as NormalizedMessage);
  },
  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  },
});

/** Waits for the runtime to reach its spawn call, which sits behind two awaits. */
async function waitForSpawn(calls: SpawnCall[], timeoutMs = 5000): Promise<SpawnCall> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = calls[calls.length - 1];
    if (call) {
      return call;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error('Timed out waiting for grok to be spawned');
}

type DriveHarness = { writer: TestWriter; call: SpawnCall };
type DriveFunction = (child: FakeGrokProcess, harness: DriveHarness) => void | Promise<void>;

type RunGrokResult = {
  writer: TestWriter;
  call: SpawnCall;
  error: unknown;
};

/**
 * Runs one scenario against the mocked CLI.
 *
 * `drive` receives the fake child process and is responsible for emitting the
 * stream and closing it; the returned `error` is the rejection the runtime
 * produced, if any, so failure paths can be asserted without try/catch noise.
 */
async function runGrok({
  prompt = 'Hi',
  options = { cwd: PROJECT_DIR, sessionId: 'app-session-1' },
  context = createRuntimeContext(),
  drive = (child) => child.close(0),
}: {
  prompt?: string;
  options?: AnyRecord;
  context?: ProviderRuntimeContext;
  drive?: DriveFunction;
} = {}): Promise<RunGrokResult> {
  const spawnMock = installSpawnMock();
  const writer = createWriter();

  try {
    const settled = Promise.resolve(grokRuntime.run(prompt, options, writer, context))
      .then(() => null, (error: unknown) => error);
    const call = await waitForSpawn(spawnMock.calls);
    await drive(call.child, { writer, call });

    return { writer, call, error: await settled };
  } finally {
    spawnMock.restore();
  }
}

const streamDeltas = (writer: TestWriter): string[] => writer.messages
  .filter((message) => message.kind === 'stream_delta')
  .map((message) => String(message.content));

const errorContents = (writer: TestWriter): string[] => writer.messages
  .filter((message) => message.kind === 'error')
  .map((message) => String(message.content));

const messagesOfKind = (writer: TestWriter, kind: NormalizedMessage['kind']): NormalizedMessage[] =>
  writer.messages.filter((message) => message.kind === kind);

const TEXT_EVENT = { type: 'text', data: 'Hello there' };
const END_EVENT = {
  type: 'end',
  stopReason: 'EndTurn',
  sessionId: SESSION_ID,
  requestId: 'req-1',
  usage: {},
  modelUsage: {},
  num_turns: 1,
};

// ---------------------------
// Argument generation

test('buildGrokArgs builds a new headless request with prompt, format, cwd and permission mode', () => {
  assert.deepEqual(
    buildGrokArgs({
      prompt: 'Hello',
      projectPath: PROJECT_DIR,
      permissionMode: 'default',
      model: undefined,
      resumeSessionId: null,
    }),
    [
      '--single', 'Hello',
      '--output-format', 'streaming-json',
      '--cwd', PROJECT_DIR,
      '--permission-mode', 'default',
    ],
  );
});

test('buildGrokArgs appends --model only when a model was resolved', () => {
  const withModel = buildGrokArgs({
    prompt: 'Hello',
    projectPath: PROJECT_DIR,
    permissionMode: 'default',
    model: 'grok-code-fast-1',
    resumeSessionId: null,
  });
  assert.deepEqual(withModel.slice(-2), ['--model', 'grok-code-fast-1']);

  const withoutModel = buildGrokArgs({
    prompt: 'Hello',
    projectPath: PROJECT_DIR,
    permissionMode: 'default',
    resumeSessionId: null,
  });
  assert.equal(withoutModel.includes('--model'), false);
});

test('buildGrokArgs keeps a prompt starting with a dash as a value', () => {
  const args = buildGrokArgs({
    prompt: '--not-a-flag',
    projectPath: PROJECT_DIR,
    permissionMode: 'default',
  });

  assert.equal(args[0], '--single');
  assert.equal(args[1], '--not-a-flag');
});

test('resolveGrokPermissionMode passes supported modes through and falls back to default', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']) {
    assert.equal(resolveGrokPermissionMode(mode), mode);
  }

  assert.equal(resolveGrokPermissionMode(undefined), 'default');
  assert.equal(resolveGrokPermissionMode('somethingNew'), 'default');
});

// ---------------------------
// Process wiring

test('a new request spawns grok from PATH with --single, streaming-json, --cwd and --permission-mode', async () => {
  const { call } = await runGrok({
    prompt: 'Where am I?',
    options: { cwd: PROJECT_DIR, sessionId: 'app-session-1', permissionMode: 'default' },
    drive: (fake) => {
      fake.writeEvents([TEXT_EVENT, END_EVENT]);
      fake.close(0);
    },
  });

  assert.equal(call.command, 'grok');
  assert.deepEqual(call.args, [
    '--single', 'Where am I?',
    '--output-format', 'streaming-json',
    '--cwd', PROJECT_DIR,
    '--permission-mode', 'default',
  ]);
  assert.equal(call.options.cwd, PROJECT_DIR);
});

test('grok is spawned without a shell, with the prompt as one unescaped argv entry', async () => {
  const prompt = 'echo "hi" && rm -rf $HOME; `whoami`';
  const { call } = await runGrok({
    prompt,
    drive: (fake) => fake.close(0),
  });

  // No shell means no quoting rules: the prompt reaches the CLI verbatim.
  assert.notEqual(call.options.shell, true);
  assert.equal(call.options.shell, undefined);
  assert.ok(Array.isArray(call.args));
  assert.equal(call.args[call.args.indexOf('--single') + 1], prompt);
});

test('a resolved model is forwarded as --model', async () => {
  const { call } = await runGrok({
    options: { cwd: PROJECT_DIR, sessionId: 'app-session-1', model: 'grok-code-fast-1' },
    drive: (fake) => fake.close(0),
  });

  const modelIndex = call.args.indexOf('--model');
  assert.notEqual(modelIndex, -1);
  assert.equal(call.args[modelIndex + 1], 'grok-code-fast-1');
});

test('an existing provider session resumes with --resume and never --session-id', async () => {
  const { call, writer } = await runGrok({
    context: createRuntimeContext({ resolveProviderSessionId: () => SESSION_ID }),
    drive: (fake) => {
      fake.writeEvents([TEXT_EVENT, END_EVENT]);
      fake.close(0);
    },
  });

  const resumeIndex = call.args.indexOf('--resume');
  assert.notEqual(resumeIndex, -1);
  assert.equal(call.args[resumeIndex + 1], SESSION_ID);
  // `--session-id` only creates a new session under a chosen id, so resuming
  // must never reach for it.
  assert.equal(call.args.includes('--session-id'), false);
  // A resumed run must not re-announce a session creation.
  assert.equal(messagesOfKind(writer, 'session_created').length, 0);
});

test('every supported permission mode is forwarded verbatim', async () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']) {
    const { call } = await runGrok({
      options: { cwd: PROJECT_DIR, sessionId: `app-session-${mode}`, permissionMode: mode },
      drive: (fake) => fake.close(0),
    });

    const modeIndex = call.args.indexOf('--permission-mode');
    assert.notEqual(modeIndex, -1, `${mode}: --permission-mode missing`);
    assert.equal(call.args[modeIndex + 1], mode, `${mode}: not forwarded verbatim`);
  }
});

// ---------------------------
// Stream parsing

test('a single text event is streamed as one assistant delta', async () => {
  const { writer, error } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([{ type: 'text', data: 'Hello there' }, END_EVENT]);
      fake.close(0);
    },
  });

  assert.equal(error, null);
  assert.deepEqual(streamDeltas(writer), ['Hello there']);
});

test('multiple text events are streamed in order', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([
        { type: 'text', data: 'The ' },
        { type: 'text', data: 'answer ' },
        { type: 'text', data: 'is 42.' },
        END_EVENT,
      ]);
      fake.close(0);
    },
  });

  assert.deepEqual(streamDeltas(writer), ['The ', 'answer ', 'is 42.']);
  assert.equal(streamDeltas(writer).join(''), 'The answer is 42.');
});

test('a JSON event split across stdout chunks is parsed once it is complete', async () => {
  const { writer, error } = await runGrok({
    drive: (fake, { writer: live }) => {
      const line = JSON.stringify({ type: 'text', data: 'split across chunks' });
      fake.writeStdout(line.slice(0, 12));
      // Nothing may be emitted while the line is still partial.
      assert.deepEqual(streamDeltas(live), []);
      fake.writeStdout(line.slice(12));
      assert.deepEqual(streamDeltas(live), []);
      fake.writeStdout('\n');
      fake.writeEvents([END_EVENT]);
      fake.close(0);
    },
  });

  assert.equal(error, null);
  assert.deepEqual(streamDeltas(writer), ['split across chunks']);
});

test('several NDJSON events arriving in one chunk are all parsed', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeStdout([
        JSON.stringify({ type: 'text', data: 'one' }),
        JSON.stringify({ type: 'text', data: 'two' }),
        JSON.stringify({ type: 'text', data: 'three' }),
        '',
      ].join('\n'));
      fake.writeEvents([END_EVENT]);
      fake.close(0);
    },
  });

  assert.deepEqual(streamDeltas(writer), ['one', 'two', 'three']);
});

test('a trailing line without a newline is flushed exactly once on close', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([{ type: 'text', data: 'streamed' }]);
      // No trailing newline: the runtime has to flush this from its buffer.
      fake.writeStdout(JSON.stringify({ type: 'text', data: 'buffered' }));
      fake.close(0);
    },
  });

  assert.deepEqual(streamDeltas(writer), ['streamed', 'buffered']);
});

test('text is not replayed after end or process close', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([{ type: 'text', data: 'Hello there' }, END_EVENT]);
      fake.close(0);
    },
  });

  assert.deepEqual(streamDeltas(writer), ['Hello there']);
  // Exactly one stream end and one terminal complete, no matter that `end` and
  // `close` both arrived.
  assert.equal(messagesOfKind(writer, 'stream_end').length, 1);
  assert.equal(messagesOfKind(writer, 'complete').length, 1);
});

test('a repeated end event does not close the stream twice', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([TEXT_EVENT, END_EVENT, END_EVENT]);
      fake.close(0);
    },
  });

  assert.equal(messagesOfKind(writer, 'stream_end').length, 1);
});

test('the provider-native session id is taken from the end event', async () => {
  const { writer } = await runGrok({
    options: { cwd: PROJECT_DIR, sessionId: 'app-session-1' },
    drive: (fake) => {
      fake.writeEvents([TEXT_EVENT, END_EVENT]);
      fake.close(0);
    },
  });

  const sessionCreated = messagesOfKind(writer, 'session_created')[0];
  assert.equal(sessionCreated?.newSessionId, SESSION_ID);
  assert.equal(writer.sessionId, SESSION_ID);
});

test('usage from the end event is reported as a token budget status', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([
        TEXT_EVENT,
        { ...END_EVENT, usage: { input_tokens: 1200, output_tokens: 48, total_tokens: 1248 } },
      ]);
      fake.close(0);
    },
  });

  const tokenBudget = writer.messages.find(
    (message) => message.kind === 'status' && message.text === 'token_budget',
  );
  assert.deepEqual(tokenBudget?.tokenBudget, {
    used: 1248,
    inputTokens: 1200,
    outputTokens: 48,
    breakdown: { input: 1200, output: 48 },
  });
});

test('an empty usage block produces no token budget status', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([TEXT_EVENT, END_EVENT]);
      fake.close(0);
    },
  });

  assert.equal(
    writer.messages.some((message) => message.kind === 'status' && message.text === 'token_budget'),
    false,
  );
});

test('a thought event is reported as reasoning, never as assistant text', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([
        { type: 'thought', data: 'The user wants the current directory.' },
        { type: 'text', data: 'You are in /tmp.' },
        END_EVENT,
      ]);
      fake.close(0);
    },
  });

  const thinking = messagesOfKind(writer, 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.content, 'The user wants the current directory.');
  // Reasoning must not leak into the visible answer.
  assert.deepEqual(streamDeltas(writer), ['You are in /tmp.']);
});

test('unknown, empty and malformed stream lines are ignored without failing the run', async () => {
  const { writer, error } = await runGrok({
    drive: (fake) => {
      fake.writeStdout('\n');
      fake.writeStdout('   \n');
      fake.writeEvents([{ type: 'a_future_event_type', data: { anything: true } }]);
      fake.writeStdout('this is not json\n');
      fake.writeStdout('{"type":"text","data":"unterminated\n');
      fake.writeEvents([{ type: 'text', data: 'still here' }, END_EVENT]);
      fake.close(0);
    },
  });

  assert.equal(error, null);
  // Valid events on either side of the junk are still delivered.
  assert.deepEqual(streamDeltas(writer), ['still here']);
  assert.deepEqual(errorContents(writer), []);
  assert.equal(messagesOfKind(writer, 'complete')[0]?.success, true);
});

// ---------------------------
// Failures

test('an error event is surfaced and fails the run', async () => {
  const { writer, error } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([{ type: 'error', message: 'Model refused the request' }]);
      fake.close(1);
    },
  });

  assert.deepEqual(errorContents(writer), ['Model refused the request']);
  assert.match(String(error), /exited with code 1/);
  assert.equal(messagesOfKind(writer, 'complete')[0]?.success, false);
});

test('an exhausted Grok Build balance is normalized into an actionable message', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([{
        type: 'error',
        message: 'Internal error: request failed: API error (status 402 Payment Required): '
          + 'Grok Build usage balance exhausted for this account, resets weekly',
      }]);
      fake.close(1);
    },
  });

  assert.deepEqual(
    errorContents(writer),
    ['Grok Build weekly usage balance is exhausted. Try again after the quota resets.'],
  );
  // The nested technical wrapper is not shown once the cause is recognized.
  assert.equal(errorContents(writer).some((content) => content.includes('Internal error')), false);
});

test('normalizeGrokErrorMessage keeps unrecognized messages intact', () => {
  assert.equal(normalizeGrokErrorMessage('some other failure'), 'some other failure');
  assert.match(normalizeGrokErrorMessage(''), /without a message/);
  assert.equal(
    normalizeGrokErrorMessage('...Grok Build usage balance exhausted...'),
    'Grok Build weekly usage balance is exhausted. Try again after the quota resets.',
  );
});

test('a non-zero exit without an error event reports stderr', async () => {
  const { writer, error } = await runGrok({
    drive: (fake) => {
      fake.writeStderr('grok: failed to resolve the workspace\n');
      fake.close(2);
    },
  });

  assert.deepEqual(errorContents(writer), ['grok: failed to resolve the workspace']);
  assert.match(String(error), /exited with code 2/);
});

test('an error event followed by a non-zero exit reports the failure only once', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeEvents([{ type: 'error', message: 'Model refused the request' }]);
      fake.writeStderr('grok: exiting after error\n');
      fake.close(1);
    },
  });

  // The stderr echo of a failure the CLI already reported is not repeated.
  assert.deepEqual(errorContents(writer), ['Model refused the request']);
});

test('a non-zero exit with empty stderr reports the exit code', async () => {
  const { writer, error } = await runGrok({
    drive: (fake) => {
      fake.writeStderr('   \n');
      fake.close(3);
    },
  });

  assert.deepEqual(errorContents(writer), ['Grok CLI exited with code 3']);
  assert.match(String(error), /exited with code 3/);
  const complete = messagesOfKind(writer, 'complete')[0];
  assert.equal(complete?.exitCode, 3);
  assert.equal(complete?.success, false);
});

test('failure messages never quote the environment the CLI ran with', async () => {
  const { writer } = await runGrok({
    drive: (fake) => {
      fake.writeStderr('grok: auth failed\n');
      fake.close(1);
    },
  });

  const reported = errorContents(writer).join('\n');
  assert.equal(reported.includes('auth.json'), false);
  assert.equal(reported.includes('PATH='), false);
  for (const key of ['GROK_API_KEY', 'XAI_API_KEY', 'HOME']) {
    assert.equal(reported.includes(`${key}=`), false);
  }
});

// ---------------------------
// Abort and process registry
//
// The registry is private, so its lifecycle is asserted through the public
// `abort` contract: it answers `true` only while a run is still cancellable.

test('aborting a run sends SIGTERM and clears the active process', async () => {
  const { writer, error } = await runGrok({
    options: { cwd: PROJECT_DIR, sessionId: 'app-session-abort' },
    drive: async (fake) => {
      fake.writeEvents([{ type: 'text', data: 'working on it' }]);

      // A live run is cancellable...
      assert.equal(await grokRuntime.abort('app-session-abort'), true);
      assert.deepEqual(fake.signals, ['SIGTERM']);
      // ...and is dropped from the registry the moment it is cancelled.
      assert.equal(await grokRuntime.abort('app-session-abort'), false);

      // SIGTERM leaves no exit code, which the runtime reports as termination.
      fake.close(null);
    },
  });

  assert.match(String(error), /terminated/);
  // The abort handler owns the terminal `complete` for cancelled runs.
  assert.equal(messagesOfKind(writer, 'complete').length, 0);
  // Closing after an abort must not resurrect the entry.
  assert.equal(await grokRuntime.abort('app-session-abort'), false);
});

test('aborting a session that was never started is a no-op', async () => {
  assert.equal(await grokRuntime.abort('never-started'), false);
});

test('a successful run leaves nothing to abort under either session key', async () => {
  const { writer } = await runGrok({
    options: { cwd: PROJECT_DIR, sessionId: 'app-session-ok' },
    drive: (fake) => {
      fake.writeEvents([TEXT_EVENT, END_EVENT]);
      fake.close(0);
    },
  });

  // The run really did learn a provider-native id, so both keys are relevant.
  assert.equal(writer.sessionId, SESSION_ID);
  assert.equal(await grokRuntime.abort('app-session-ok'), false);
  assert.equal(await grokRuntime.abort(SESSION_ID), false);
});

test('a failed run leaves nothing to abort', async () => {
  const { error } = await runGrok({
    options: { cwd: PROJECT_DIR, sessionId: 'app-session-failed' },
    drive: (fake) => {
      fake.writeEvents([{ type: 'error', message: 'Model refused the request' }]);
      fake.close(1);
    },
  });

  assert.ok(error);
  assert.equal(await grokRuntime.abort('app-session-failed'), false);
});

test('a spawn error reports a missing CLI and leaves nothing to abort', async () => {
  const { writer, error } = await runGrok({
    options: { cwd: PROJECT_DIR, sessionId: 'app-session-spawn-error' },
    context: createRuntimeContext({ isProviderInstalled: async () => false }),
    drive: (fake) => {
      fake.emit('error', new Error('spawn grok ENOENT'));
    },
  });

  assert.match(String(error), /ENOENT/);
  assert.ok(errorContents(writer).some((content) => content.includes('is not installed')));
  assert.equal(messagesOfKind(writer, 'complete').length, 1);
  assert.equal(await grokRuntime.abort('app-session-spawn-error'), false);
});
