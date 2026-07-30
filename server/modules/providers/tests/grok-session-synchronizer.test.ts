import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import test from 'node:test';

import { GrokSessionSynchronizer } from '@/modules/providers/list/grok/grok-session-synchronizer.provider.js';

const synchronizer = new GrokSessionSynchronizer();

const CHILD_PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const;
const FS_READ_FUNCTIONS = ['readFile', 'readFileSync', 'readdirSync', 'existsSync'] as const;
const FS_WRITE_FUNCTIONS = ['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync'] as const;

/**
 * Counts every process launch and filesystem access attempted while `run`
 * executes. The synchronizer is documented as indexing nothing, so the count
 * has to be zero — no CLI call, no read, and no filesystem mutation.
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
  instrument(fs, [...FS_READ_FUNCTIONS, ...FS_WRITE_FUNCTIONS]);
  instrument(fsPromises, ['readFile', 'readdir', 'writeFile', 'mkdir', 'rm', 'unlink'] as const);

  try {
    await run();
  } finally {
    for (const restore of restorers) {
      restore();
    }
  }

  return calls;
}

test('Grok synchronizer indexes nothing on a full scan', async () => {
  assert.equal(await synchronizer.synchronize(), 0);
});

test('Grok synchronizer indexes nothing for an incremental scan with since', async () => {
  assert.equal(await synchronizer.synchronize(new Date('2026-06-17T00:00:00Z')), 0);
});

test('Grok synchronizer ignores watcher file events', async () => {
  assert.equal(await synchronizer.synchronizeFile('/tmp/anything/opencode.db'), null);
  assert.equal(await synchronizer.synchronizeFile(''), null);
});

test('Grok synchronizer runs no CLI and touches no filesystem', async () => {
  const sideEffects = await countSideEffects(async () => {
    await synchronizer.synchronize();
    await synchronizer.synchronize(new Date());
    await synchronizer.synchronizeFile('/tmp/grok/sessions.db');
  });

  assert.equal(sideEffects, 0);
});
