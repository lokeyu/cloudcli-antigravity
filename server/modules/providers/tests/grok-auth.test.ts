import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { GrokProviderAuth } from '@/modules/providers/list/grok/grok-auth.provider.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

// Exactly what `grok models` printed on CLI 0.2.114 for a signed-in account.
const AUTHENTICATED_STDOUT = [
  'You are logged in with grok.com.',
  '',
  'Default model: grok-4.5',
  '',
  'Available models:',
  '  * grok-4.5 (default)',
  '',
].join('\n');

/**
 * Stands in for the `grok` CLI: `child_process.spawn` is replaced with a
 * recorder handing back this fake child, so no real binary is located or run,
 * no credential store is touched, and no prompt reaches the account.
 */
class FakeGrokAuthProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];

  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeGrokAuthProcess;
};

/** How the fake CLI behaves once the adapter has spawned it. */
type CliBehaviour = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  /** Leaves the child running so the probe has to time out. */
  hang?: boolean;
  /** Emits `error` and then `close`, to prove the probe settles once. */
  errorThenClose?: boolean;
};

type StatusRun = {
  status: ProviderAuthStatus;
  call: SpawnCall;
};

/**
 * Runs `getStatus()` against a scripted fake CLI.
 *
 * The single assertion below is the seam between the fake child and Node's
 * heavily overloaded `spawn` signature.
 */
async function readStatusWithFakeCli(
  behaviour: CliBehaviour,
  { probeTimeoutMs = 5_000 }: { probeTimeoutMs?: number } = {},
): Promise<StatusRun> {
  const calls: SpawnCall[] = [];
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeGrokAuthProcess();
    calls.push({ command, args, options, child });

    // The adapter attaches its listeners synchronously after spawn returns.
    setImmediate(() => {
      if (behaviour.hang) {
        return;
      }

      if (behaviour.spawnError) {
        child.emit('error', behaviour.spawnError);
        if (behaviour.errorThenClose) {
          // A late close must not overwrite the outcome already settled above.
          child.emit('close', 0);
        }
        return;
      }

      if (behaviour.stdout) {
        child.stdout.emit('data', Buffer.from(behaviour.stdout));
      }
      if (behaviour.stderr) {
        child.stderr.emit('data', Buffer.from(behaviour.stderr));
      }
      child.emit('close', behaviour.exitCode ?? 0);
    });

    return child as unknown as ChildProcess;
  }) as typeof childProcess.spawn;

  try {
    const status = await new GrokProviderAuth(probeTimeoutMs).getStatus();
    const call = calls[0];
    assert.ok(call, 'expected the adapter to spawn the CLI');
    assert.equal(calls.length, 1, 'expected exactly one CLI invocation');
    return { status, call };
  } finally {
    childProcess.spawn = originalSpawn;
  }
}

const enoent = (): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error('spawn grok ENOENT');
  error.code = 'ENOENT';
  return error;
};

// ---------------------------
// Authenticated states

test('Grok auth reports an authenticated account from the real CLI output', async () => {
  const { status } = await readStatusWithFakeCli({ stdout: AUTHENTICATED_STDOUT });

  assert.deepEqual(status, {
    installed: true,
    provider: 'grok',
    authenticated: true,
    email: null,
    method: 'grok_cli',
  });
});

test('Grok auth treats the login banner alone as authenticated', async () => {
  const { status } = await readStatusWithFakeCli({
    stdout: 'You are logged in with grok.com.\n',
  });

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.error, undefined);
});

test('Grok auth treats a model catalog without a banner as authenticated', async () => {
  const { status } = await readStatusWithFakeCli({
    stdout: 'Available models:\n  * grok-4.5 (default)\n',
  });

  assert.equal(status.authenticated, true);
  assert.equal(status.method, 'grok_cli');
});

test('Grok auth stays authenticated when the weekly agent quota is exhausted', async () => {
  // `grok models` never sends a prompt, so it still lists the catalog while
  // agent requests are refused for the rest of the week.
  const { status } = await readStatusWithFakeCli({
    stdout: AUTHENTICATED_STDOUT,
    stderr: 'warning: Grok Build usage balance exhausted for this account\n',
  });

  assert.equal(status.authenticated, true);
  assert.equal(status.error, undefined);
});

test('Grok auth reports authenticated from valid inspect JSON shape', async () => {
  const inspectJson = JSON.stringify({
    grokVersion: '0.2.114',
    channel: 'stable',
    cwd: '/home/claude/workspace',
    permissions: {},
    loginPolicy: { apiKeyAuthDisabled: false },
    skills: [],
    agents: [],
  });

  const { status } = await readStatusWithFakeCli({ stdout: inspectJson });

  assert.deepEqual(status, {
    installed: true,
    provider: 'grok',
    authenticated: true,
    email: null,
    method: 'grok_cli',
  });
});

test('Grok auth stays authenticated when inspect JSON has no email field', async () => {
  const inspectJson = JSON.stringify({
    grokVersion: '0.2.114',
    permissions: {},
  });

  const { status } = await readStatusWithFakeCli({ stdout: inspectJson });

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.email, null);
});

test('Grok auth handles malformed JSON output with safe error message', async () => {
  const { status } = await readStatusWithFakeCli({
    stdout: '{ "grokVersion": "0.2.114", malformed...',
    exitCode: 0,
  });

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.error, 'Grok CLI returned malformed JSON output');
});

// ---------------------------
// Unauthenticated and failure states

test('Grok auth reports a signed-out account that still exits cleanly', async () => {
  const { status } = await readStatusWithFakeCli({
    stdout: 'Not logged in. Run `grok login` to continue.\n',
  });

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.method, null);
  assert.equal(status.error, 'Grok CLI is not logged in. Run `grok login`.');
});

test('Grok auth reports a signed-out account that exits non-zero', async () => {
  const { status } = await readStatusWithFakeCli({
    stderr: 'error: not authenticated; run `grok login` first\n',
    exitCode: 1,
  });

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.error, 'Grok CLI is not logged in. Run `grok login`.');
});

test('Grok auth reports a missing CLI as not installed', async () => {
  const { status } = await readStatusWithFakeCli({ spawnError: enoent() });

  assert.deepEqual(status, {
    installed: false,
    provider: 'grok',
    authenticated: false,
    email: null,
    method: null,
    error: 'Grok CLI (grok) is not installed',
  });
});

test('Grok auth reports a CLI that cannot be started with its errno only', async () => {
  const error: NodeJS.ErrnoException = new Error('spawn /opt/tools/grok EACCES');
  error.code = 'EACCES';

  const { status } = await readStatusWithFakeCli({ spawnError: error });

  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.error, 'Grok CLI could not be started (EACCES)');
  // The binary path from the spawn error is not echoed back.
  assert.equal(status.error?.includes('/opt/tools'), false);
});

test('Grok auth reports an unexpected CLI failure as a short sanitized line', async () => {
  const { status } = await readStatusWithFakeCli({
    stderr: 'panic: leader socket refused the connection\nstack frame 1\nstack frame 2\n',
    exitCode: 2,
  });

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  // Only the first line survives; the rest of the dump is dropped.
  assert.equal(status.error, 'panic: leader socket refused the connection');
});

test('Grok auth reports the exit code when the CLI fails silently', async () => {
  const { status } = await readStatusWithFakeCli({ exitCode: 3 });

  assert.equal(status.authenticated, false);
  assert.equal(status.error, 'Grok CLI exited with code 3');
});

test('Grok auth times out, terminates the CLI with SIGTERM and reports it', async () => {
  const { status, call } = await readStatusWithFakeCli({ hang: true }, { probeTimeoutMs: 25 });

  assert.deepEqual(call.child.signals, ['SIGTERM']);
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.error, 'Grok CLI did not respond in time');
});

// ---------------------------
// Safety of what is reported

test('Grok auth never reports tokens, environment or credential paths', async () => {
  const { status } = await readStatusWithFakeCli({
    stderr: [
      'failed to read /home/tester/.grok/auth.json',
      'token=sk-live-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
      'HOME=/home/tester PATH=/usr/bin GROK_API_KEY=xai-secret-value',
    ].join('\n'),
    exitCode: 4,
  });

  const reported = status.error ?? '';
  assert.equal(reported.includes('.grok'), false);
  assert.equal(reported.includes('auth.json'), false);
  assert.equal(reported.includes('/home/tester'), false);
  assert.equal(reported.includes('sk-live-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH'), false);
  assert.equal(reported.includes('GROK_API_KEY'), false);
  assert.equal(reported.includes('xai-secret-value'), false);
  // The remaining line is still useful and short.
  assert.match(reported, /^failed to read \[path\]$/);
  assert.ok(reported.length <= 240);

  // No account identity is ever derived from the CLI banner either.
  assert.equal(status.email, null);
});

test('Grok auth caps a very long CLI failure line', async () => {
  const { status } = await readStatusWithFakeCli({
    // Short words only, so this is capped rather than redacted as one blob.
    stderr: `error: ${'retry later '.repeat(60)}\n`,
    exitCode: 1,
  });

  // 240 characters plus the ellipsis that marks the cut.
  assert.equal((status.error ?? '').length, 241);
  assert.match(status.error ?? '', /…$/);
});

test('Grok auth redacts a long opaque blob instead of echoing it', async () => {
  const { status } = await readStatusWithFakeCli({
    stderr: `error: ${'x'.repeat(500)}\n`,
    exitCode: 1,
  });

  assert.equal(status.error, 'error: [redacted]');
});

// ---------------------------
// Process wiring

test('Grok auth probes with `grok models`, without a shell and with stdin ignored', async () => {
  const { call } = await readStatusWithFakeCli({ stdout: AUTHENTICATED_STDOUT });

  assert.equal(call.command, 'grok');
  assert.deepEqual(call.args, ['models']);
  // No shell means nothing in the argument list is ever interpreted.
  assert.notEqual(call.options.shell, true);
  assert.equal(call.options.shell, undefined);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('Grok auth releases its stream and close listeners once the probe settles', async () => {
  const { call } = await readStatusWithFakeCli({ stdout: AUTHENTICATED_STDOUT });

  assert.equal(call.child.stdout.listenerCount('data'), 0);
  assert.equal(call.child.stderr.listenerCount('data'), 0);
  assert.equal(call.child.listenerCount('close'), 0);
  // A late failure must not become an uncaught exception, so one inert error
  // sink is kept: emitting here has to stay harmless.
  assert.equal(call.child.listenerCount('error'), 1);
  call.child.emit('error', new Error('late failure'));
  // A clean run never terminates the CLI.
  assert.deepEqual(call.child.signals, []);
});

test('Grok auth settles once when error and close race', async () => {
  const { status } = await readStatusWithFakeCli({
    spawnError: enoent(),
    errorThenClose: true,
  });

  // The first outcome wins: the close that follows cannot rewrite it into a
  // successful, authenticated run.
  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.error, 'Grok CLI (grok) is not installed');
});
