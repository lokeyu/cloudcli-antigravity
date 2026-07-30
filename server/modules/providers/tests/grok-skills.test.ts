import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { GrokSkillsProvider } from '@/modules/providers/list/grok/grok-skills.provider.js';
import { AppError } from '@/shared/utils.js';

class FakeGrokProcess extends EventEmitter {
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
  child: FakeGrokProcess;
};

type CliResponse = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  hang?: boolean;
  errorThenClose?: boolean;
};

function withMockSpawn(
  handler: (args: readonly string[], options: SpawnOptions) => CliResponse,
  runTest: (calls: SpawnCall[]) => Promise<void>,
): Promise<void> {
  const calls: SpawnCall[] = [];
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeGrokProcess();
    calls.push({ command, args, options, child });

    const behaviour = handler(args, options);

    setImmediate(() => {
      if (behaviour.hang) {
        return;
      }

      if (behaviour.spawnError) {
        child.emit('error', behaviour.spawnError);
        if (behaviour.errorThenClose) {
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

    return child as unknown as childProcess.ChildProcess;
  }) as typeof childProcess.spawn;

  return runTest(calls).finally(() => {
    childProcess.spawn = originalSpawn;
  });
}

test('GrokSkillsProvider - listSkills parser & mapping', async (t) => {
  await t.test('parses single bundled skill into system scope', async () => {
    const json = JSON.stringify({
      skills: [
        {
          name: 'build-with-ai',
          description: 'Build AI applications with Grok',
          userInvocable: true,
          source: {
            type: 'bundled',
            path: '/home/user/.grok/bundled/skills/build-with-ai/SKILL.md',
          },
        },
      ],
    });
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.equal(res.length, 1);
        assert.deepEqual(res[0], {
          provider: 'grok',
          name: 'build-with-ai',
          description: 'Build AI applications with Grok',
          command: '/build-with-ai',
          scope: 'system',
          sourcePath: '/home/user/.grok/bundled/skills/build-with-ai/SKILL.md',
        });
        assert.equal(res[0].pluginName, undefined);
        assert.equal(res[0].pluginId, undefined);
      },
    );
  });

  await t.test('parses single project skill into project scope', async () => {
    const json = JSON.stringify({
      skills: [
        {
          name: 'my-project-skill',
          description: 'Custom project skill',
          userInvocable: true,
          source: {
            type: 'project',
            path: '/path/to/project/.agents/skills/my-project-skill/SKILL.md',
          },
        },
      ],
    });
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.equal(res.length, 1);
        assert.deepEqual(res[0], {
          provider: 'grok',
          name: 'my-project-skill',
          description: 'Custom project skill',
          command: '/my-project-skill',
          scope: 'project',
          sourcePath: '/path/to/project/.agents/skills/my-project-skill/SKILL.md',
        });
      },
    );
  });

  await t.test('preserves order of multiple skills', async () => {
    const json = JSON.stringify({
      skills: [
        {
          name: 'alpha',
          description: 'Alpha skill',
          userInvocable: true,
          source: { type: 'bundled', path: '/path/alpha/SKILL.md' },
        },
        {
          name: 'beta',
          description: 'Beta skill',
          userInvocable: true,
          source: { type: 'project', path: '/path/beta/SKILL.md' },
        },
        {
          name: 'gamma',
          description: 'Gamma skill',
          userInvocable: true,
          source: { type: 'bundled', path: '/path/gamma/SKILL.md' },
        },
      ],
    });
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(
          res.map((s) => s.name),
          ['alpha', 'beta', 'gamma'],
        );
      },
    );
  });

  await t.test('handles userInvocable false by omitting command prefix', async () => {
    const json = JSON.stringify({
      skills: [
        {
          name: 'internal-helper',
          description: 'Internal non-invocable skill',
          userInvocable: false,
          source: { type: 'bundled', path: '/path/internal/SKILL.md' },
        },
      ],
    });
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.equal(res.length, 1);
        assert.equal(res[0].command, '');
      },
    );
  });

  await t.test('parses empty skills array', async () => {
    await withMockSpawn(
      () => ({ stdout: JSON.stringify({ skills: [] }), exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });

  await t.test('skips malformed skills elements', async () => {
    const json = JSON.stringify({
      skills: [
        null,
        123,
        'bad-element',
        { name: '', description: 'Desc', userInvocable: true, source: { type: 'bundled', path: '/p/SKILL.md' } },
        { name: 's1', description: 123, userInvocable: true, source: { type: 'bundled', path: '/p/SKILL.md' } },
        { name: 's2', description: 'D', userInvocable: 'yes', source: { type: 'bundled', path: '/p/SKILL.md' } },
        { name: 's3', description: 'D', userInvocable: true, source: null },
        { name: 'valid', description: 'Good skill', userInvocable: true, source: { type: 'project', path: '/valid/SKILL.md' } },
      ],
    });
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.equal(res.length, 1);
        assert.equal(res[0].name, 'valid');
      },
    );
  });

  await t.test('skips items with unknown source.type', async () => {
    const json = JSON.stringify({
      skills: [
        { name: 'bad-type', description: 'D', userInvocable: true, source: { type: 'unknown', path: '/p/SKILL.md' } },
        { name: 'good-type', description: 'D', userInvocable: true, source: { type: 'project', path: '/p/SKILL.md' } },
      ],
    });
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.equal(res.length, 1);
        assert.equal(res[0].name, 'good-type');
      },
    );
  });

  await t.test('skips items whose source.path does not end in SKILL.md', async () => {
    const json = JSON.stringify({
      skills: [
        { name: 'not-skill-md', description: 'D', userInvocable: true, source: { type: 'project', path: '/path/README.md' } },
        { name: 'is-skill-md', description: 'D', userInvocable: true, source: { type: 'project', path: '/path/SKILL.md' } },
      ],
    });
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.equal(res.length, 1);
        assert.equal(res[0].name, 'is-skill-md');
      },
    );
  });

  await t.test('handles invalid JSON gracefully', async () => {
    await withMockSpawn(
      () => ({ stdout: 'not json', exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });

  await t.test('handles non-object JSON root', async () => {
    await withMockSpawn(
      () => ({ stdout: '[1, 2, 3]', exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });

  await t.test('handles missing skills field', async () => {
    await withMockSpawn(
      () => ({ stdout: JSON.stringify({ otherField: true }), exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });
});

test('GrokSkillsProvider - CLI process execution for listSkills', async (t) => {
  await t.test('executes grok inspect --json without shell with cwd = workspacePath', async () => {
    await withMockSpawn(
      () => ({ stdout: JSON.stringify({ skills: [] }), exitCode: 0 }),
      async (calls) => {
        const provider = new GrokSkillsProvider();
        await provider.listSkills({ workspacePath: '/target/workspace' });
        assert.equal(calls.length, 1);
        const [call] = calls;
        assert.equal(call.command, 'grok');
        assert.deepEqual(call.args, ['inspect', '--json']);
        assert.equal(call.options.shell, undefined);
        assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(call.options.cwd, '/target/workspace');
      },
    );
  });

  await t.test('handles ENOENT spawn error without throwing', async () => {
    const enoent = new Error('spawn grok ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    await withMockSpawn(
      () => ({ spawnError: enoent }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });

  await t.test('handles child process timeout and SIGTERM', async () => {
    await withMockSpawn(
      () => ({ hang: true }),
      async (calls) => {
        const provider = new GrokSkillsProvider(10); // 10ms timeout
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
      },
    );
  });

  await t.test('handles non-zero exit code without throwing', async () => {
    await withMockSpawn(
      () => ({ stdout: '', stderr: 'Inspect failed', exitCode: 1 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });

  await t.test('handles empty stdout without throwing', async () => {
    await withMockSpawn(
      () => ({ stdout: '', exitCode: 0 }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });

  await t.test('settles once on race between error and close', async () => {
    const err = new Error('late error') as NodeJS.ErrnoException;
    err.code = 'EFAIL';
    await withMockSpawn(
      () => ({ spawnError: err, errorThenClose: true }),
      async () => {
        const provider = new GrokSkillsProvider();
        const res = await provider.listSkills();
        assert.deepEqual(res, []);
      },
    );
  });
});

test('GrokSkillsProvider - addSkills & removeSkill writes', async (t) => {
  await t.test('addSkills throws AppError PROVIDER_SKILLS_WRITE_UNSUPPORTED without spawning CLI', async () => {
    await withMockSpawn(
      () => ({ stdout: 'should not run', exitCode: 0 }),
      async (calls) => {
        const provider = new GrokSkillsProvider();
        await assert.rejects(
          provider.addSkills({
            entries: [{ content: '# Skill\nDescription' }],
          }),
          (err: unknown) => {
            assert(err instanceof AppError);
            assert.equal(err.code, 'PROVIDER_SKILLS_WRITE_UNSUPPORTED');
            assert.equal(err.statusCode, 400);
            assert(err.message.includes('read-only'));
            return true;
          },
        );
        assert.equal(calls.length, 0);
      },
    );
  });

  await t.test('removeSkill throws AppError PROVIDER_SKILLS_WRITE_UNSUPPORTED without spawning CLI', async () => {
    await withMockSpawn(
      () => ({ stdout: 'should not run', exitCode: 0 }),
      async (calls) => {
        const provider = new GrokSkillsProvider();
        await assert.rejects(
          provider.removeSkill({ directoryName: 'some-skill' }),
          (err: unknown) => {
            assert(err instanceof AppError);
            assert.equal(err.code, 'PROVIDER_SKILLS_WRITE_UNSUPPORTED');
            assert.equal(err.statusCode, 400);
            assert(err.message.includes('read-only'));
            return true;
          },
        );
        assert.equal(calls.length, 0);
      },
    );
  });
});
