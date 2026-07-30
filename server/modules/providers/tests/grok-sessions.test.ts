import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import test from 'node:test';

import { GrokProviderSessions } from '@/modules/providers/list/grok/grok-sessions.provider.js';

const sessions = new GrokProviderSessions();

const CHILD_PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const;
const FS_FUNCTIONS = ['readFile', 'readFileSync', 'readdirSync', 'existsSync'] as const;

/**
 * Counts every process launch and filesystem read attempted while `run`
 * executes. The adapter is documented as doing no I/O at all, so the observed
 * count has to be zero — this is what proves `grok export` / `grok sessions`
 * are never spawned and `~/.grok` is never read.
 */
async function countSideEffects(run: () => Promise<void>): Promise<number> {
  let calls = 0;
  const restorers: Array<() => void> = [];

  const instrument = <T extends object>(target: T, keys: readonly (keyof T)[]): void => {
    for (const key of keys) {
      const original = target[key];
      if (typeof original !== 'function') {
        continue;
      }

      target[key] = ((...args: unknown[]) => {
        calls += 1;
        return (original as (...callArgs: unknown[]) => unknown).apply(target, args);
      }) as T[typeof key];
      restorers.push(() => {
        target[key] = original;
      });
    }
  };

  instrument(childProcess, CHILD_PROCESS_FUNCTIONS);
  instrument(fs, FS_FUNCTIONS);
  instrument(fsPromises, ['readFile', 'readdir'] as const);

  try {
    await run();
  } finally {
    for (const restore of restorers) {
      restore();
    }
  }

  return calls;
}

// ---------------------------
// Empty history contract

test('Grok sessions history is empty with default options', async () => {
  const result = await sessions.fetchHistory('app-session-1');

  assert.deepEqual(result, {
    messages: [],
    total: 0,
    hasMore: false,
    offset: 0,
    limit: null,
  });
});

test('Grok sessions history stays contract-shaped for limit null', async () => {
  const result = await sessions.fetchHistory('app-session-1', { limit: null, offset: 0 });

  assert.deepEqual(result.messages, []);
  assert.equal(result.total, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.limit, null);
});

test('Grok sessions history echoes a non-zero offset without inventing pages', async () => {
  const result = await sessions.fetchHistory('app-session-1', { limit: 50, offset: 100 });

  assert.deepEqual(result.messages, []);
  assert.equal(result.total, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.offset, 100);
  assert.equal(result.limit, 50);
});

test('Grok sessions history supports limit 0 like every other provider', async () => {
  const result = await sessions.fetchHistory('app-session-1', { limit: 0, offset: 0 });

  assert.deepEqual(result.messages, []);
  assert.equal(result.total, 0);
  // With nothing before the empty page there is nothing more to load.
  assert.equal(result.hasMore, false);
  assert.equal(result.limit, 0);
});

test('Grok sessions history clamps negative offset and limit instead of failing', async () => {
  const result = await sessions.fetchHistory('app-session-1', { limit: -5, offset: -10 });

  assert.equal(result.offset, 0);
  assert.equal(result.limit, 0);
  assert.deepEqual(result.messages, []);
});

// ---------------------------
// No fabricated messages

test('Grok sessions never fabricates a NormalizedMessage from unknown raw input', () => {
  const rawInputs: unknown[] = [
    { type: 'text', data: 'looks like a live event' },
    { kind: 'text', content: 'looks already normalized', provider: 'grok' },
    'plain string output',
    12345,
    null,
    undefined,
    ['array', 'of', 'things'],
  ];

  for (const raw of rawInputs) {
    assert.deepEqual(sessions.normalizeMessage(raw, 'app-session-1'), []);
    assert.deepEqual(sessions.normalizeMessage(raw, null), []);
  }
});

// ---------------------------
// No I/O of any kind

test('Grok sessions adapter spawns no process and reads no Grok files', async () => {
  const sideEffects = await countSideEffects(async () => {
    await sessions.fetchHistory('app-session-1');
    await sessions.fetchHistory('019ed739-5a4c-7523-8da8-e245359e639e', { limit: 10, offset: 0 });
    sessions.normalizeMessage({ type: 'text', data: 'hi' }, 'app-session-1');
  });

  assert.equal(sideEffects, 0);
});
