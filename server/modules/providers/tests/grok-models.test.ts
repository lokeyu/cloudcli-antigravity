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
import { ProviderModelsDiscoveryError } from '@/shared/provider-models-discovery.js';

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
  /** Never exits, so the provider's own timeout is the only thing that settles it. */
  stall?: boolean;
};

/**
 * Runs `body` with `child_process.spawn` replaced by a scripted fake CLI.
 *
 * No real binary is located or run, so nothing here reaches the account's quota.
 * The single cast below is the seam between the fake child and Node's heavily
 * overloaded `spawn` signature; the original is always restored.
 */
async function withFakeGrokCli<T>(
  behaviour: CliBehaviour,
  body: (calls: SpawnCall[]) => Promise<T>,
): Promise<T> {
  const calls: SpawnCall[] = [];
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeGrokModelsProcess();
    calls.push({ command, args, options, child });

    if (behaviour.stall) {
      return child as unknown as ChildProcess;
    }

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
    return await body(calls);
  } finally {
    childProcess.spawn = originalSpawn;
  }
}

/** Runs `getSupportedModels()` against a scripted fake CLI that answers. */
async function readModelsWithFakeCli(behaviour: CliBehaviour): Promise<{
  definition: Awaited<ReturnType<GrokProviderModels['getSupportedModels']>>;
  call: SpawnCall;
}> {
  return withFakeGrokCli(behaviour, async (calls) => {
    const definition = await new GrokProviderModels().getSupportedModels();
    const call = calls[0];
    assert.ok(call, 'expected the provider to spawn the CLI');
    return { definition, call };
  });
}

/**
 * Asserts one rejection is a discovery failure carrying the Grok catalog.
 *
 * The catalog has to ride along on the error: it is the only thing
 * `providerModelsService` can answer with when no snapshot exists.
 */
const assertGrokDiscoveryFailure = (error: unknown): true => {
  assert.ok(
    error instanceof ProviderModelsDiscoveryError,
    `expected a ProviderModelsDiscoveryError, got ${String(error)}`,
  );
  assert.equal(error.name, 'ProviderModelsDiscoveryError');
  assert.deepEqual(error.fallback, GROK_FALLBACK_MODELS);
  return true;
};

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

test('Grok models provider reports output without models as a failed discovery', async () => {
  const unusableOutputs = [
    '',
    '   \n\n',
    'You are logged in with grok.com.\n',
    // Fully malformed: no line has model-id shape anywhere in it.
    ' binary garbage\n{"unexpected": "json"}\n<<<>>>\n',
    // A catalog whose rows carry no usable ids at all.
    'Available models:\n  * none\n  * (see docs)\n',
  ];

  for (const stdout of unusableOutputs) {
    await withFakeGrokCli({ stdout }, async () => {
      await assert.rejects(
        () => new GrokProviderModels().getSupportedModels(),
        (error: unknown) => {
          assertGrokDiscoveryFailure(error);
          assert.match((error as Error).message, /listed no usable models/);
          // Nothing threw underneath, so no cause is invented for it.
          assert.equal((error as ProviderModelsDiscoveryError).cause, undefined);
          return true;
        },
        `expected discovery to fail for stdout ${JSON.stringify(stdout)}`,
      );
    });
  }
});

test('Grok models provider reports a non-zero exit as a failed discovery with a cause', async () => {
  await withFakeGrokCli({ stderr: 'grok: not logged in\n', exitCode: 1 }, async () => {
    await assert.rejects(
      () => new GrokProviderModels().getSupportedModels(),
      (error: unknown) => {
        assertGrokDiscoveryFailure(error);
        const { cause } = error as ProviderModelsDiscoveryError;
        assert.ok(cause instanceof Error);
        // The CLI's own stderr stays on the cause so logs name the real reason.
        assert.equal(cause.message, 'grok: not logged in');
        return true;
      },
    );
  });
});

test('Grok models provider reports a missing CLI as a failed discovery with a cause', async () => {
  const spawnError = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });

  await withFakeGrokCli({ spawnError }, async () => {
    await assert.rejects(
      () => new GrokProviderModels().getSupportedModels(),
      (error: unknown) => {
        assertGrokDiscoveryFailure(error);
        assert.equal((error as ProviderModelsDiscoveryError).cause, spawnError);
        return true;
      },
    );
  });
});

test('Grok models provider reports its own timeout as a failed discovery', async (t) => {
  // Only `setTimeout` is faked: the fake CLI still schedules through setImmediate.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  await withFakeGrokCli({ stall: true }, async (calls) => {
    // The command is spawned synchronously, so the timer exists before the tick.
    const pending = new GrokProviderModels().getSupportedModels();
    t.mock.timers.tick(20_000);

    await assert.rejects(pending, (error: unknown) => {
      assertGrokDiscoveryFailure(error);
      const { cause } = error as ProviderModelsDiscoveryError;
      assert.ok(cause instanceof Error);
      assert.equal(cause.message, 'grok models timed out');
      return true;
    });

    // The hung child is signalled rather than left running.
    assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
  });
});

test('a failed Grok discovery never leaks credentials into its message', async () => {
  const behaviours: CliBehaviour[] = [
    {
      stderr: 'grok: invalid api key xai-SECRETKEY0123456789 in /home/user/.grok/credentials.json\n',
      exitCode: 1,
    },
    { spawnError: new Error('spawn grok ENOENT') },
    { stdout: 'You are logged in with grok.com.\n' },
  ];

  for (const behaviour of behaviours) {
    await withFakeGrokCli(behaviour, async () => {
      await assert.rejects(
        () => new GrokProviderModels().getSupportedModels(),
        (error: unknown) => {
          const { message } = error as Error;
          // The message is a fixed string; only the cause quotes the CLI.
          assert.ok(!message.includes('xai-SECRETKEY0123456789'), message);
          assert.ok(!message.includes('.grok'), message);
          assert.ok(!message.includes('api key'), message);
          return true;
        },
      );
    });
  }
});

test('a failed Grok discovery carries the shipped catalog for the caching layer', async () => {
  await withFakeGrokCli({ stdout: '' }, async () => {
    await assert.rejects(
      () => new GrokProviderModels().getSupportedModels(),
      (error: unknown) => {
        assert.ok(error instanceof ProviderModelsDiscoveryError);
        assert.deepEqual(error.fallback, GROK_FALLBACK_MODELS);
        assert.equal(error.fallback.DEFAULT, 'grok-4.5');
        return true;
      },
    );
  });
});

test('Grok models provider keeps naming a default model when discovery fails', async () => {
  for (const behaviour of [
    { stdout: '' } satisfies CliBehaviour,
    { spawnError: new Error('spawn grok ENOENT') } satisfies CliBehaviour,
    { stderr: 'grok: not logged in\n', exitCode: 1 } satisfies CliBehaviour,
  ]) {
    await withFakeGrokCli(behaviour, async () => {
      const provider = new GrokProviderModels();

      // A failed discovery must not turn into a failed active-model lookup.
      assert.deepEqual(await provider.getCurrentActiveModel(), {
        model: GROK_FALLBACK_MODELS.DEFAULT,
      });
      assert.deepEqual(await provider.getCurrentActiveModel('app-session-1'), {
        model: 'grok-4.5',
      });
    });
  }
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

test('Grok models provider keeps the models from a partly unreadable listing', async () => {
  const { definition } = await readModelsWithFakeCli({
    stdout: [
      'You are logged in with grok.com.',
      'Update available: 0.2.115 — run grok upgrade',
      '',
      'Available models:',
      '  * grok-4.5 (default)',
      '  see https://docs.x.ai for details',
      '  * grok-code-fast-1',
      '  <<< unreadable row >>>',
      '',
    ].join('\n'),
  });

  // Banners, headers and noise are dropped; every readable row survives.
  assert.deepEqual(definition, {
    OPTIONS: [
      { value: 'grok-4.5', label: 'Grok 4.5' },
      { value: 'grok-code-fast-1', label: 'Grok Code Fast 1' },
    ],
    DEFAULT: 'grok-4.5',
  });
});

test('an exhausted Grok quota alongside a listed catalog is still a successful discovery', async () => {
  // Quota exhaustion is a generation-time failure: `grok models` still exits 0
  // and still lists what the account may select.
  const { definition } = await readModelsWithFakeCli({
    stdout: [
      'You are logged in with grok.com.',
      'Your weekly quota is exhausted. Usage resets on Monday.',
      '',
      'Default model: grok-4.5',
      '',
      'Available models:',
      '  * grok-4.5 (default)',
      '',
    ].join('\n'),
    stderr: 'warning: weekly limit reached\n',
    exitCode: 0,
  });

  assert.deepEqual(definition, {
    OPTIONS: [{ value: 'grok-4.5', label: 'Grok 4.5' }],
    DEFAULT: 'grok-4.5',
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
