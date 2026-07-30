import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  GROK_FALLBACK_MODELS,
  GrokProviderModels,
  buildGrokDefinition,
  parseGrokModelsStdout,
} from '@/modules/providers/list/grok/grok-models.provider.js';

// Exactly what `grok models` printed on CLI 0.2.114 with one entitled model.
const REAL_CLI_STDOUT = [
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
 * recorder handing back this fake child, so no real binary is located or run and
 * no request ever reaches the account's quota.
 */
class FakeGrokModelsProcess extends EventEmitter {
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
  child: FakeGrokModelsProcess;
};

/** How the fake CLI should behave once the provider has spawned it. */
type CliBehaviour = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnError?: Error;
};

/**
 * Runs `getSupportedModels()` against a scripted fake CLI.
 *
 * The single assertion below is the seam between the fake child and Node's
 * heavily overloaded `spawn` signature.
 */
async function readModelsWithFakeCli(behaviour: CliBehaviour): Promise<{
  definition: Awaited<ReturnType<GrokProviderModels['getSupportedModels']>>;
  call: SpawnCall;
}> {
  const calls: SpawnCall[] = [];
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeGrokModelsProcess();
    calls.push({ command, args, options, child });

    // The provider attaches its listeners synchronously after spawn returns.
    setImmediate(() => {
      if (behaviour.spawnError) {
        child.emit('error', behaviour.spawnError);
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
    const definition = await new GrokProviderModels().getSupportedModels();
    const call = calls[0];
    assert.ok(call, 'expected the provider to spawn the CLI');
    return { definition, call };
  } finally {
    childProcess.spawn = originalSpawn;
  }
}

// ---------------------------
// Parsing real CLI output

test('Grok models provider parses the real CLI output into one model and its default', () => {
  const definition = buildGrokDefinition(parseGrokModelsStdout(REAL_CLI_STDOUT));

  assert.deepEqual(definition, {
    OPTIONS: [{ value: 'grok-4.5', label: 'Grok 4.5' }],
    DEFAULT: 'grok-4.5',
  });
});

test('Grok models provider ignores the login banner, headers and service text', () => {
  const listing = parseGrokModelsStdout(`
You are logged in with grok.com.
Not logged in. Run grok login to continue.
Available models:
Models:
  see https://docs.x.ai for details
  * grok-4.5 (default)
`);

  // Only the bulleted model row survives; nothing prose-shaped is selectable.
  assert.deepEqual(listing.options, [{ value: 'grok-4.5', label: 'Grok 4.5' }]);
});

test('Grok models provider reads several models and keeps CLI order', () => {
  const listing = parseGrokModelsStdout(`
Available models:
  * grok-4.5 (default)
  * grok-code-fast-1
  * grok-4-fast-reasoning
`);

  assert.deepEqual(listing.options.map((option) => option.value), [
    'grok-4.5',
    'grok-code-fast-1',
    'grok-4-fast-reasoning',
  ]);
});

test('Grok models provider accepts the bullet characters a CLI may switch between', () => {
  const listing = parseGrokModelsStdout(`
  * grok-4.5
  - grok-code-fast-1
  • grok-4-fast-reasoning
grok-4-heavy
`);

  assert.deepEqual(listing.options.map((option) => option.value), [
    'grok-4.5',
    'grok-code-fast-1',
    'grok-4-fast-reasoning',
    'grok-4-heavy',
  ]);
});

test('Grok models provider removes duplicate model ids', () => {
  const listing = parseGrokModelsStdout(`
Available models:
  * grok-4.5 (default)
  * grok-code-fast-1
  * grok-4.5
  * grok-code-fast-1
`);

  assert.deepEqual(listing.options.map((option) => option.value), ['grok-4.5', 'grok-code-fast-1']);
});

test('Grok models provider builds readable labels from model ids', () => {
  const listing = parseGrokModelsStdout(`
  * grok-4.5
  * grok-code-fast-1
  * grok-4-fast-reasoning
  * grok_4_heavy
`);

  assert.deepEqual(listing.options, [
    { value: 'grok-4.5', label: 'Grok 4.5' },
    { value: 'grok-code-fast-1', label: 'Grok Code Fast 1' },
    { value: 'grok-4-fast-reasoning', label: 'Grok 4 Fast Reasoning' },
    { value: 'grok_4_heavy', label: 'Grok 4 Heavy' },
  ]);
});

// ---------------------------
// Default model detection

test('Grok models provider takes the default from the announcement line', () => {
  const definition = buildGrokDefinition(parseGrokModelsStdout(`
Default model: grok-code-fast-1

Available models:
  * grok-4.5
  * grok-code-fast-1
`));

  assert.equal(definition.DEFAULT, 'grok-code-fast-1');
});

test('Grok models provider takes the default from a marked row when no line announces it', () => {
  const definition = buildGrokDefinition(parseGrokModelsStdout(`
Available models:
  * grok-4.5
  * grok-code-fast-1 (default)
`));

  assert.equal(definition.DEFAULT, 'grok-code-fast-1');
});

test('Grok models provider ignores an announced default the CLI did not list', () => {
  const definition = buildGrokDefinition(parseGrokModelsStdout(`
Default model: grok-not-listed

Available models:
  * grok-code-fast-1
  * grok-4.5
`));

  // The shipped default wins over the first row when the CLI names a phantom.
  assert.equal(definition.DEFAULT, 'grok-4.5');
});

test('Grok models provider falls back to the first model when nothing is marked', () => {
  const definition = buildGrokDefinition(parseGrokModelsStdout(`
  * grok-code-fast-1
  * grok-4-fast-reasoning
`));

  assert.equal(definition.DEFAULT, 'grok-code-fast-1');
});

// ---------------------------
// Failure paths

test('Grok models provider falls back to grok-4.5 when the CLI prints nothing usable', async () => {
  for (const stdout of ['', '   \n\n', 'You are logged in with grok.com.\n']) {
    const { definition } = await readModelsWithFakeCli({ stdout });
    assert.deepEqual(definition, GROK_FALLBACK_MODELS);
    assert.equal(definition.DEFAULT, 'grok-4.5');
  }
});

test('Grok models provider falls back to grok-4.5 on a non-zero exit', async () => {
  const { definition } = await readModelsWithFakeCli({
    stderr: 'grok: not logged in\n',
    exitCode: 1,
  });

  assert.deepEqual(definition, GROK_FALLBACK_MODELS);
});

test('Grok models provider falls back to grok-4.5 when the CLI is not installed', async () => {
  const { definition } = await readModelsWithFakeCli({
    spawnError: new Error('spawn grok ENOENT'),
  });

  assert.deepEqual(definition, GROK_FALLBACK_MODELS);
});

test('the fallback catalog lists only the model the CLI was seen offering', () => {
  assert.deepEqual(GROK_FALLBACK_MODELS.OPTIONS, [{ value: 'grok-4.5', label: 'Grok 4.5' }]);
  assert.equal(GROK_FALLBACK_MODELS.DEFAULT, 'grok-4.5');
});

// ---------------------------
// Process wiring

test('Grok models provider runs `grok models` from PATH without a shell', async () => {
  const { call } = await readModelsWithFakeCli({ stdout: REAL_CLI_STDOUT });

  assert.equal(call.command, 'grok');
  assert.deepEqual(call.args, ['models']);
  // No shell means nothing in the argument list is ever interpreted.
  assert.notEqual(call.options.shell, true);
  assert.equal(call.options.shell, undefined);
});

test('Grok models provider reads the live catalog through the CLI', async () => {
  const { definition } = await readModelsWithFakeCli({
    stdout: [
      'You are logged in with grok.com.',
      '',
      'Default model: grok-code-fast-1',
      '',
      'Available models:',
      '  * grok-4.5',
      '  * grok-code-fast-1 (default)',
    ].join('\n'),
  });

  assert.deepEqual(definition, {
    OPTIONS: [
      { value: 'grok-4.5', label: 'Grok 4.5' },
      { value: 'grok-code-fast-1', label: 'Grok Code Fast 1' },
    ],
    DEFAULT: 'grok-code-fast-1',
  });
});

test('Grok models provider reports the catalog default as the active model', async () => {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = ((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const child = new FakeGrokModelsProcess();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(REAL_CLI_STDOUT));
      child.emit('close', 0);
    });
    return child as unknown as ChildProcess;
  }) as typeof childProcess.spawn;

  try {
    // Grok has no per-session model readback, so a session id changes nothing.
    const provider = new GrokProviderModels();
    assert.deepEqual(await provider.getCurrentActiveModel(), { model: 'grok-4.5' });
    assert.deepEqual(await provider.getCurrentActiveModel('app-session-1'), { model: 'grok-4.5' });
  } finally {
    childProcess.spawn = originalSpawn;
  }
});
