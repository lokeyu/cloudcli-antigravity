import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  antigravityRuntime,
  buildAntigravityArgs,
  isAntigravitySessionActive,
  resolveAntigravityPermissionArgs,
} from './antigravity-runtime.provider.js';
import { AntigravitySessionsProvider } from './antigravity-sessions.provider.js';

const CONVERSATION_ID = '6994ceee-e745-4ffe-87d0-1d430ecb2526';

const sessionsProvider = new AntigravitySessionsProvider();

const createRuntimeContext = (overrides = {}) => ({
  // A brand-new app session has no Antigravity conversation id recorded yet;
  // the resume tests override this with a known conversation id.
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
  ...overrides,
});

const createWriter = () => ({
  userId: null,
  sessionId: null,
  messages: [],
  send(message) {
    this.messages.push(message);
  },
  setSessionId(sessionId) {
    this.sessionId = sessionId;
  },
});

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

/**
 * Writes a fake `agy` onto PATH that records how it was invoked and replays a
 * canned stream-json transcript, so the runtime can be driven without the real
 * CLI or a network call.
 */
async function createFakeAntigravityExecutable(binDir, { streamLines, exitCode = 0, stderr = '', hangMs = 0 }) {
  const scriptPath = path.join(binDir, 'agy.js');
  await writeFile(scriptPath, `
const capturePath = process.env.AGY_ARGS_CAPTURE;
if (capturePath) {
  require('node:fs').writeFileSync(capturePath, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
  }));
}

const stderrText = ${JSON.stringify(stderr)};
if (stderrText) {
  process.stderr.write(stderrText);
}

for (const line of ${JSON.stringify(streamLines)}) {
  console.log(line);
}

// A non-zero hang keeps the fake CLI alive so a run can be cancelled mid-flight.
if (${hangMs} > 0) {
  setTimeout(() => process.exit(${exitCode}), ${hangMs});
} else {
  process.exit(${exitCode});
}
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'agy.cmd'), '@echo off\r\nnode "%~dp0agy.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'agy');
  // `exec` replaces the shell with node so the real single-process `agy` is
  // modelled faithfully and an abort's SIGTERM reaches the CLI itself.
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/agy.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

/**
 * Runs one fake-CLI scenario with PATH pointed at a throwaway directory and
 * restores every mutated environment variable afterwards.
 */
async function withFakeAntigravity(
  { streamLines, exitCode = 0, stderr = '', hangMs = 0, projectDirName = 'project' },
  runScenario,
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-cli-'));
  const projectDir = path.join(tempRoot, projectDirName);
  const argsCapturePath = path.join(tempRoot, 'agy-args.json');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.AGY_ARGS_CAPTURE;

  try {
    await createFakeAntigravityExecutable(tempRoot, { streamLines, exitCode, stderr, hangMs });
    // The project directory has to exist: it becomes the child process cwd.
    await mkdir(projectDir, { recursive: true });

    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.AGY_ARGS_CAPTURE = argsCapturePath;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    return await runScenario({
      projectDir,
      readCapture: async () => JSON.parse(await readFile(argsCapturePath, 'utf8')),
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.AGY_ARGS_CAPTURE;
    } else {
      process.env.AGY_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
}

const SUCCESS_STREAM = [
  JSON.stringify({
    event: 'init',
    conversation_id: CONVERSATION_ID,
    init: { model: 'gemini-3.6-flash-high', cwd: '/project/path', tools: [], permission_mode: 'request-review' },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: CONVERSATION_ID, step_index: 0, state: 'DONE', step_type: 'user_input' },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' } },
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 3,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' }, output: '/project/path' },
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 5,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'The directory is ',
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: 5,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: '/project/path.',
    },
  }),
  JSON.stringify({
    event: 'result',
    result: {
      conversation_id: CONVERSATION_ID,
      status: 'SUCCESS',
      response: 'The directory is /project/path.',
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
  }),
];

// ---------------------------
// Argument generation

test('buildAntigravityArgs starts a new conversation without --conversation', () => {
  assert.deepEqual(
    buildAntigravityArgs({
      conversationId: null,
      model: 'gemini-3.6-flash-high',
      permissionMode: 'default',
      prompt: 'Hello',
    }),
    [
      '--new-project',
      '--model=gemini-3.6-flash-high',
      '--output-format=stream-json',
      '--print=Hello',
    ],
  );
});

test('buildAntigravityArgs resumes by conversation id and never combines it with --new-project', () => {
  const args = buildAntigravityArgs({
    conversationId: CONVERSATION_ID,
    model: 'claude-sonnet-4-6',
    permissionMode: 'default',
    prompt: 'And now?',
  });

  assert.deepEqual(args, [
    `--conversation=${CONVERSATION_ID}`,
    '--model=claude-sonnet-4-6',
    '--output-format=stream-json',
    '--print=And now?',
  ]);
  assert.equal(args.includes('--new-project'), false);
});

test('buildAntigravityArgs omits the model when none was resolved and keeps the prompt last', () => {
  const args = buildAntigravityArgs({
    conversationId: null,
    model: undefined,
    permissionMode: 'plan',
    // A prompt starting with a dash must stay a value, never a flag.
    prompt: '--not-a-flag',
  });

  assert.deepEqual(args, [
    '--new-project',
    '--output-format=stream-json',
    '--mode=plan',
    '--print=--not-a-flag',
  ]);
});

// ---------------------------
// Permission modes

test('resolveAntigravityPermissionArgs maps UI permission modes onto agy flags', () => {
  assert.deepEqual(resolveAntigravityPermissionArgs('plan'), ['--mode=plan']);
  assert.deepEqual(resolveAntigravityPermissionArgs('acceptEdits'), ['--mode=accept-edits']);
  assert.deepEqual(resolveAntigravityPermissionArgs('bypassPermissions'), ['--dangerously-skip-permissions']);
  // Anything else leaves the CLI's own review mode in charge.
  assert.deepEqual(resolveAntigravityPermissionArgs('default'), []);
  assert.deepEqual(resolveAntigravityPermissionArgs(undefined), []);
  assert.deepEqual(resolveAntigravityPermissionArgs('somethingNew'), []);
});

test('agy is spawned with --dangerously-skip-permissions only for bypassPermissions', async () => {
  const scenarios = [
    { permissionMode: undefined, expectFlags: [] },
    { permissionMode: 'default', expectFlags: [] },
    { permissionMode: 'plan', expectFlags: ['--mode=plan'] },
    { permissionMode: 'acceptEdits', expectFlags: ['--mode=accept-edits'] },
    { permissionMode: 'bypassPermissions', expectFlags: ['--dangerously-skip-permissions'] },
  ];

  for (const scenario of scenarios) {
    await withFakeAntigravity({ streamLines: SUCCESS_STREAM }, async ({ projectDir, readCapture }) => {
      await antigravityRuntime.run(
        'Hi',
        { cwd: projectDir, permissionMode: scenario.permissionMode },
        createWriter(),
        createRuntimeContext(),
      );

      const { args } = await readCapture();
      for (const expectedFlag of scenario.expectFlags) {
        assert.ok(
          args.includes(expectedFlag),
          `${scenario.permissionMode}: expected "${expectedFlag}" in ${JSON.stringify(args)}`,
        );
      }

      const shouldBypass = scenario.permissionMode === 'bypassPermissions';
      assert.equal(
        args.includes('--dangerously-skip-permissions'),
        shouldBypass,
        `${scenario.permissionMode}: unexpected bypass flag state in ${JSON.stringify(args)}`,
      );
      if (!shouldBypass && scenario.permissionMode !== 'plan' && scenario.permissionMode !== 'acceptEdits') {
        assert.equal(args.some((arg) => arg.startsWith('--mode=')), false);
      }
    });
  }
});

// ---------------------------
// Process wiring

test('agy runs with the selected project directory as its cwd', async () => {
  await withFakeAntigravity(
    { streamLines: SUCCESS_STREAM, projectDirName: 'selected-project' },
    async ({ projectDir, readCapture }) => {
      await antigravityRuntime.run(
        'Where am I?',
        // projectPath is the fallback; cwd wins when both are supplied.
        { cwd: projectDir, projectPath: path.join(projectDir, '..'), sessionId: 'app-session-1' },
        createWriter(),
        createRuntimeContext(),
      );

      const capture = await readCapture();
      // macOS resolves /var to /private/var, so compare canonical paths.
      assert.equal(await realpath(capture.cwd), await realpath(projectDir));
      assert.notEqual(capture.cwd, process.cwd());
    },
  );
});

test('agy resumes with the recorded conversation id and reports no new session', async () => {
  await withFakeAntigravity({ streamLines: SUCCESS_STREAM }, async ({ projectDir, readCapture }) => {
    const writer = createWriter();
    await antigravityRuntime.run(
      'And now?',
      { cwd: projectDir, sessionId: 'app-session-1' },
      writer,
      // A session with a recorded provider id resumes instead of creating one.
      createRuntimeContext({ resolveProviderSessionId: () => CONVERSATION_ID }),
    );

    const { args } = await readCapture();
    assert.ok(args.includes(`--conversation=${CONVERSATION_ID}`));
    assert.equal(args.includes('--new-project'), false);
    // Resumed runs must not re-announce a session creation.
    assert.equal(writer.messages.some((message) => message.kind === 'session_created'), false);
  });
});

test('agy stream is normalized into session_created, tool, text, usage and complete events', async () => {
  await withFakeAntigravity({ streamLines: SUCCESS_STREAM }, async ({ projectDir }) => {
    const writer = createWriter();
    await antigravityRuntime.run(
      'Where am I?',
      { cwd: projectDir, sessionId: 'app-session-1', model: 'gemini-3.6-flash-high' },
      writer,
      createRuntimeContext(),
    );

    const kinds = writer.messages.map((message) => message.kind);
    const sessionCreatedIndex = kinds.indexOf('session_created');
    const firstDeltaIndex = kinds.indexOf('stream_delta');

    // The conversation id has to be published before any content references it.
    assert.notEqual(sessionCreatedIndex, -1);
    assert.ok(sessionCreatedIndex < firstDeltaIndex);
    assert.equal(writer.messages[sessionCreatedIndex].newSessionId, CONVERSATION_ID);
    assert.equal(writer.sessionId, CONVERSATION_ID);

    const toolMessages = writer.messages.filter((message) => message.kind === 'tool_use');
    assert.equal(toolMessages.length, 2);
    assert.equal(toolMessages[0].toolId, toolMessages[1].toolId);
    assert.deepEqual(toolMessages[1].toolResult, { content: '/project/path', isError: false });

    const streamedText = writer.messages
      .filter((message) => message.kind === 'stream_delta')
      .map((message) => message.content)
      .join('');
    assert.equal(streamedText, 'The directory is /project/path.');

    const tokenBudget = writer.messages.find(
      (message) => message.kind === 'status' && message.text === 'token_budget',
    );
    assert.deepEqual(tokenBudget?.tokenBudget, {
      used: 10022,
      inputTokens: 9968,
      outputTokens: 54,
      breakdown: { input: 9968, output: 54 },
    });

    const completeMessages = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completeMessages.length, 1);
    assert.equal(completeMessages[0].exitCode, 0);
    assert.equal(completeMessages[0].success, true);
    assert.equal(writer.messages.some((message) => message.kind === 'error'), false);
  });
});

test('agy malformed stream lines are reported as errors without losing valid events', async () => {
  const streamLines = [
    SUCCESS_STREAM[0],
    'this is not json',
    SUCCESS_STREAM[4],
    SUCCESS_STREAM[5],
    SUCCESS_STREAM[6],
  ];

  await withFakeAntigravity({ streamLines }, async ({ projectDir }) => {
    const writer = createWriter();
    await assert.rejects(
      antigravityRuntime.run(
        'Where am I?',
        { cwd: projectDir, sessionId: 'app-session-1' },
        writer,
        createRuntimeContext(),
      ),
    );

    const errors = writer.messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    assert.match(String(errors[0].content), /malformed stream line: this is not json/);

    // The rest of the stream is still parsed.
    const streamedText = writer.messages
      .filter((message) => message.kind === 'stream_delta')
      .map((message) => message.content)
      .join('');
    assert.equal(streamedText, 'The directory is /project/path.');

    // A run that reported an error completes as a failure even on exit code 0.
    const complete = writer.messages.find((message) => message.kind === 'complete');
    assert.equal(complete.success, false);
  });
});

test('agy non-SUCCESS results and non-zero exits are reported as provider errors', async () => {
  const streamLines = [
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error: 'invalid model selection (--model "not-a-real-model")',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    }),
  ];

  await withFakeAntigravity({ streamLines, exitCode: 1 }, async ({ projectDir }) => {
    const writer = createWriter();
    await assert.rejects(
      antigravityRuntime.run(
        'Hi',
        { cwd: projectDir, sessionId: 'app-session-1', model: 'not-a-real-model' },
        writer,
        createRuntimeContext(),
      ),
      /exited with code 1/,
    );

    const errors = writer.messages.filter((message) => message.kind === 'error');
    assert.ok(errors.some((message) => String(message.content).includes('invalid model selection')));

    const complete = writer.messages.find((message) => message.kind === 'complete');
    assert.equal(complete.success, false);
    assert.equal(complete.exitCode, 1);
  });
});

test('agy stderr output is surfaced without failing an otherwise clean run', async () => {
  await withFakeAntigravity(
    { streamLines: SUCCESS_STREAM, stderr: 'jetski: a tool required a permission headless mode cannot prompt for\n' },
    async ({ projectDir }) => {
      const writer = createWriter();
      // The CLI writes advisories to stderr on runs that still exit cleanly, so
      // the message reaches the user but does not turn the run into a failure.
      await antigravityRuntime.run(
        'Hi',
        { cwd: projectDir, sessionId: 'app-session-1' },
        writer,
        createRuntimeContext(),
      );

      const errors = writer.messages.filter((message) => message.kind === 'error');
      assert.ok(errors.some((message) => String(message.content).includes('headless mode cannot prompt')));
      assert.equal(writer.messages.find((message) => message.kind === 'complete').success, true);
    },
  );
});

test('aborting an Antigravity run terminates the child process', async () => {
  await withFakeAntigravity(
    // Only the init event is emitted, then the fake CLI hangs until killed.
    { streamLines: [SUCCESS_STREAM[0]], hangMs: 10_000 },
    async ({ projectDir }) => {
      const writer = createWriter();
      const run = antigravityRuntime.run(
        'Take your time',
        { cwd: projectDir, sessionId: 'app-session-abort' },
        writer,
        createRuntimeContext(),
      );

      await waitUntil(() => isAntigravitySessionActive('app-session-abort'));
      assert.equal(antigravityRuntime.abort('app-session-abort'), true);

      // SIGTERM leaves no exit code, which the runtime reports as termination.
      await assert.rejects(run, /terminated/);
      assert.equal(isAntigravitySessionActive('app-session-abort'), false);
      // The abort handler owns the terminal `complete` for cancelled runs.
      assert.equal(writer.messages.some((message) => message.kind === 'complete'), false);
      // Aborting an unknown session is a no-op rather than an error.
      assert.equal(antigravityRuntime.abort('app-session-abort'), false);
    },
  );
});

test('aborting an Antigravity session reports no active process once it has finished', async () => {
  await withFakeAntigravity({ streamLines: SUCCESS_STREAM }, async ({ projectDir }) => {
    await antigravityRuntime.run(
      'Hi',
      { cwd: projectDir, sessionId: 'app-session-1' },
      createWriter(),
      createRuntimeContext(),
    );

    // The process map is keyed by the app session id and cleared on close.
    assert.equal(antigravityRuntime.abort('app-session-1'), false);
  });
});

/** Polls until `condition` holds, so a spawned child can be observed. */
async function waitUntil(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for the Antigravity process to start');
}
