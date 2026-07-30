import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { GrokMcpProvider } from '@/modules/providers/list/grok/grok-mcp.provider.js';
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

test('GrokMcpProvider - listServers parsing edge cases', async (t) => {
  await t.test('parses empty array', async () => {
    await withMockSpawn(
      () => ({ stdout: '[]\n', exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.deepEqual(res, { user: [], local: [], project: [] });
      },
    );
  });

  await t.test('parses single stdio server', async () => {
    const json = JSON.stringify([
      { name: 'echo-server', scope: 'project', enabled: true, command: '/bin/echo' },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.project.length, 1);
        assert.deepEqual(res.project[0], {
          provider: 'grok',
          name: 'echo-server',
          scope: 'project',
          transport: 'stdio',
          command: '/bin/echo',
        });
      },
    );
  });

  await t.test('parses stdio server with args and env', async () => {
    const json = JSON.stringify([
      {
        name: 'full-stdio',
        scope: 'user',
        enabled: true,
        command: 'node',
        args: ['server.js', '--port', '8080'],
        env: { NODE_ENV: 'test', SECRET_VAR: 'val' },
      },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.user.length, 1);
        assert.deepEqual(res.user[0], {
          provider: 'grok',
          name: 'full-stdio',
          scope: 'user',
          transport: 'stdio',
          command: 'node',
          args: ['server.js', '--port', '8080'],
          env: { NODE_ENV: 'test', SECRET_VAR: 'val' },
        });
      },
    );
  });

  await t.test('parses single HTTP server with headers', async () => {
    const json = JSON.stringify([
      {
        name: 'remote-http',
        scope: 'project',
        enabled: true,
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.project.length, 1);
        assert.deepEqual(res.project[0], {
          provider: 'grok',
          name: 'remote-http',
          scope: 'project',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer token' },
        });
      },
    );
  });

  await t.test('parses single SSE server', async () => {
    const json = JSON.stringify([
      {
        name: 'remote-sse',
        scope: 'user',
        type: 'sse',
        enabled: true,
        url: 'https://api.example.com/sse',
      },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.user.length, 1);
        assert.deepEqual(res.user[0], {
          provider: 'grok',
          name: 'remote-sse',
          scope: 'user',
          transport: 'sse',
          url: 'https://api.example.com/sse',
        });
      },
    );
  });

  await t.test('preserves server order', async () => {
    const json = JSON.stringify([
      { name: 'first', scope: 'project', enabled: true, command: 'cmd1' },
      { name: 'second', scope: 'project', enabled: true, command: 'cmd2' },
      { name: 'third', scope: 'project', enabled: true, command: 'cmd3' },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.deepEqual(
          res.project.map((s) => s.name),
          ['first', 'second', 'third'],
        );
      },
    );
  });

  await t.test('parses server with enabled: false', async () => {
    const json = JSON.stringify([
      { name: 'disabled-server', scope: 'project', enabled: false, command: 'cmd' },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.project.length, 1);
        assert.equal(res.project[0].name, 'disabled-server');
      },
    );
  });

  await t.test('skips corrupt and invalid items', async () => {
    const json = JSON.stringify([
      null,
      123,
      'string-item',
      { name: '', scope: 'project', enabled: true, command: 'echo' }, // empty name
      { name: 's1', scope: 'invalid', enabled: true, command: 'echo' }, // invalid scope
      { name: 's2', scope: 'project', enabled: 'true', command: 'echo' }, // non-boolean enabled
      { name: 's3', scope: 'project', enabled: true, command: '' }, // empty command
      { name: 's4', scope: 'project', enabled: true, url: '' }, // empty url
      { name: 'valid', scope: 'project', enabled: true, command: 'valid-cmd' },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.project.length, 1);
        assert.equal(res.project[0].name, 'valid');
      },
    );
  });

  await t.test('skips unknown transport type', async () => {
    const json = JSON.stringify([
      { name: 'unknown-type', scope: 'project', enabled: true, url: 'http://x', type: 'unsupported' },
      { name: 'valid-sse', scope: 'project', enabled: true, url: 'http://x', type: 'sse' },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.project.length, 1);
        assert.equal(res.project[0].name, 'valid-sse');
      },
    );
  });

  await t.test('skips ambiguous item with both command and url', async () => {
    const json = JSON.stringify([
      { name: 'ambiguous', scope: 'project', enabled: true, command: 'cmd', url: 'http://x' },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.project.length, 0);
      },
    );
  });

  await t.test('skips items with non-string values in env, headers, or args', async () => {
    const json = JSON.stringify([
      { name: 'bad-args', scope: 'project', enabled: true, command: 'cmd', args: [123] },
      { name: 'bad-env', scope: 'project', enabled: true, command: 'cmd', env: { K: 123 } },
      { name: 'bad-headers', scope: 'project', enabled: true, url: 'http://x', headers: { H: null } },
      { name: 'good', scope: 'project', enabled: true, command: 'good-cmd' },
    ]);
    await withMockSpawn(
      () => ({ stdout: json, exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.equal(res.project.length, 1);
        assert.equal(res.project[0].name, 'good');
      },
    );
  });

  await t.test('handles invalid JSON gracefully', async () => {
    await withMockSpawn(
      () => ({ stdout: 'not json syntax', exitCode: 0 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.deepEqual(res, { user: [], local: [], project: [] });
      },
    );
  });
});

test('GrokMcpProvider - CLI process execution for list', async (t) => {
  await t.test('executes exact command grok mcp list --json without shell', async () => {
    await withMockSpawn(
      () => ({ stdout: '[]', exitCode: 0 }),
      async (calls) => {
        const provider = new GrokMcpProvider();
        await provider.listServers({ workspacePath: '/custom/workspace' });
        assert.equal(calls.length, 1);
        const [call] = calls;
        assert.equal(call.command, 'grok');
        assert.deepEqual(call.args, ['mcp', 'list', '--json']);
        assert.equal(call.options.shell, undefined);
        assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(call.options.cwd, '/custom/workspace');
      },
    );
  });

  await t.test('handles child process timeout and SIGTERM', async () => {
    await withMockSpawn(
      () => ({ hang: true }),
      async (calls) => {
        const provider = new GrokMcpProvider(10); // 10ms timeout
        const res = await provider.listServers();
        assert.deepEqual(res, { user: [], local: [], project: [] });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
      },
    );
  });

  await t.test('handles ENOENT spawn error without throwing', async () => {
    const enoent = new Error('spawn grok ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    await withMockSpawn(
      () => ({ spawnError: enoent }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.deepEqual(res, { user: [], local: [], project: [] });
      },
    );
  });

  await t.test('handles non-zero exit code without throwing', async () => {
    await withMockSpawn(
      () => ({ stdout: '', stderr: 'error listing mcp', exitCode: 1 }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.deepEqual(res, { user: [], local: [], project: [] });
      },
    );
  });

  await t.test('settles once on race between error and close', async () => {
    const err = new Error('late error') as NodeJS.ErrnoException;
    err.code = 'EFAIL';
    await withMockSpawn(
      () => ({ spawnError: err, errorThenClose: true }),
      async () => {
        const provider = new GrokMcpProvider();
        const res = await provider.listServers();
        assert.deepEqual(res, { user: [], local: [], project: [] });
      },
    );
  });
});

test('GrokMcpProvider - upsertServer', async (t) => {
  await t.test('adds new stdio server with correct argv structure', async () => {
    await withMockSpawn(
      (args) => {
        if (args.includes('list')) {
          return { stdout: '[]', exitCode: 0 };
        }
        return { stdout: 'Added stdio MCP server', exitCode: 0 };
      },
      async (calls) => {
        const provider = new GrokMcpProvider();
        const res = await provider.upsertServer({
          name: 'my-stdio',
          scope: 'project',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres'],
          env: { DB_URL: 'postgres://localhost/db' },
          workspacePath: '/my/project',
        });

        assert.deepEqual(res, {
          provider: 'grok',
          name: 'my-stdio',
          scope: 'project',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres'],
          env: { DB_URL: 'postgres://localhost/db' },
        });

        assert.equal(calls.length, 2); // list then add
        const addCall = calls[1];
        assert.deepEqual(addCall.args, [
          'mcp',
          'add',
          '--scope',
          'project',
          '-e',
          'DB_URL=postgres://localhost/db',
          'my-stdio',
          '--',
          'npx',
          '-y',
          '@modelcontextprotocol/server-postgres',
        ]);
        assert.equal(addCall.options.cwd, '/my/project');
      },
    );
  });

  await t.test('adds HTTP server with headers', async () => {
    await withMockSpawn(
      (args) => {
        if (args.includes('list')) {
          return { stdout: '[]', exitCode: 0 };
        }
        return { stdout: 'Added HTTP MCP server', exitCode: 0 };
      },
      async (calls) => {
        const provider = new GrokMcpProvider();
        const res = await provider.upsertServer({
          name: 'my-http',
          scope: 'user',
          transport: 'http',
          url: 'https://mcp.sentry.io/mcp',
          headers: { 'X-Token': 'secret123' },
        });

        assert.equal(res.transport, 'http');
        assert.equal(calls.length, 2);
        const addCall = calls[1];
        assert.deepEqual(addCall.args, [
          'mcp',
          'add',
          '--transport',
          'http',
          '--scope',
          'user',
          '-H',
          'X-Token: secret123',
          'my-http',
          'https://mcp.sentry.io/mcp',
        ]);
      },
    );
  });

  await t.test('adds SSE server', async () => {
    await withMockSpawn(
      (args) => {
        if (args.includes('list')) {
          return { stdout: '[]', exitCode: 0 };
        }
        return { stdout: 'Added SSE MCP server', exitCode: 0 };
      },
      async (calls) => {
        const provider = new GrokMcpProvider();
        const res = await provider.upsertServer({
          name: 'my-sse',
          scope: 'project',
          transport: 'sse',
          url: 'https://mcp.sentry.io/sse',
        });

        assert.equal(res.transport, 'sse');
        assert.equal(calls.length, 2);
        const addCall = calls[1];
        assert.deepEqual(addCall.args, [
          'mcp',
          'add',
          '--transport',
          'sse',
          '--scope',
          'project',
          'my-sse',
          'https://mcp.sentry.io/sse',
        ]);
      },
    );
  });

  await t.test('skips mutation if existing server configuration is identical', async () => {
    const existingList = JSON.stringify([
      {
        name: 'same-server',
        scope: 'project',
        enabled: true,
        command: '/bin/echo',
        args: ['hello'],
        env: { TEST_VAR: '1' },
      },
    ]);
    await withMockSpawn(
      () => ({ stdout: existingList, exitCode: 0 }),
      async (calls) => {
        const provider = new GrokMcpProvider();
        const res = await provider.upsertServer({
          name: 'same-server',
          scope: 'project',
          transport: 'stdio',
          command: '/bin/echo',
          args: ['hello'],
          env: { TEST_VAR: '1' },
        });

        assert.equal(res.name, 'same-server');
        assert.equal(calls.length, 1); // list only, no add/remove call
      },
    );
  });

  await t.test('replaces existing server in same scope and removes it first', async () => {
    const existingList = JSON.stringify([
      {
        name: 'existing-server',
        scope: 'project',
        enabled: true,
        command: 'old-command',
      },
    ]);
    await withMockSpawn(
      (args) => {
        if (args.includes('list')) {
          return { stdout: existingList, exitCode: 0 };
        }
        if (args.includes('remove')) {
          return { stdout: 'Removed MCP server', exitCode: 0 };
        }
        return { stdout: 'Added MCP server', exitCode: 0 };
      },
      async (calls) => {
        const provider = new GrokMcpProvider();
        await provider.upsertServer({
          name: 'existing-server',
          scope: 'project',
          transport: 'stdio',
          command: 'new-command',
        });

        assert.equal(calls.length, 3); // list -> remove -> add
        assert.deepEqual(calls[1].args, ['mcp', 'remove', '--scope', 'project', 'existing-server']);
        assert.deepEqual(calls[2].args, [
          'mcp',
          'add',
          '--scope',
          'project',
          'existing-server',
          '--',
          'new-command',
        ]);
      },
    );
  });

  await t.test('triggers rollback when add fails after removing existing server', async () => {
    const existingList = JSON.stringify([
      {
        name: 'rollback-target',
        scope: 'project',
        enabled: true,
        command: 'old-command',
      },
    ]);
    await withMockSpawn(
      (args) => {
        if (args.includes('list')) {
          return { stdout: existingList, exitCode: 0 };
        }
        if (args.includes('remove')) {
          return { stdout: 'Removed', exitCode: 0 };
        }
        // first add (new command) fails, second add (rollback old command) succeeds
        if (args.includes('new-command')) {
          return { stderr: 'Failed to add server', exitCode: 1 };
        }
        return { stdout: 'Restored', exitCode: 0 };
      },
      async (calls) => {
        const provider = new GrokMcpProvider();
        await assert.rejects(
          provider.upsertServer({
            name: 'rollback-target',
            scope: 'project',
            transport: 'stdio',
            command: 'new-command',
          }),
          (err: unknown) => {
            assert(err instanceof AppError);
            assert.equal(err.code, 'MCP_UPSERT_FAILED');
            return true;
          },
        );

        assert.equal(calls.length, 4); // list -> remove -> failed add -> rollback add
        assert.deepEqual(calls[3].args, [
          'mcp',
          'add',
          '--scope',
          'project',
          'rollback-target',
          '--',
          'old-command',
        ]);
      },
    );
  });

  await t.test('handles rollback failure safely', async () => {
    const existingList = JSON.stringify([
      {
        name: 'double-fail',
        scope: 'project',
        enabled: true,
        command: 'old-cmd',
      },
    ]);
    await withMockSpawn(
      (args) => {
        if (args.includes('list')) {
          return { stdout: existingList, exitCode: 0 };
        }
        if (args.includes('remove')) {
          return { stdout: 'Removed', exitCode: 0 };
        }
        return { stderr: 'Add failed', exitCode: 1 };
      },
      async () => {
        const provider = new GrokMcpProvider();
        await assert.rejects(
          provider.upsertServer({
            name: 'double-fail',
            scope: 'project',
            transport: 'stdio',
            command: 'new-cmd',
          }),
          (err: unknown) => {
            assert(err instanceof AppError);
            assert.equal(err.code, 'MCP_UPSERT_FAILED');
            assert(err.message.includes('rollback failed'));
            return true;
          },
        );
      },
    );
  });

  await t.test('redacts secret env and header values in error messages', async () => {
    const secretValue = 'super_secret_bearer_token_xyz_123456789';
    await withMockSpawn(
      (args) => {
        if (args.includes('list')) {
          return { stdout: '[]', exitCode: 0 };
        }
        return { stderr: `Error setting token ${secretValue} at /home/user/.grok/secret.key`, exitCode: 1 };
      },
      async () => {
        const provider = new GrokMcpProvider();
        await assert.rejects(
          provider.upsertServer({
            name: 'secret-server',
            scope: 'project',
            transport: 'http',
            url: 'http://example.com',
            headers: { Auth: secretValue },
          }),
          (err: unknown) => {
            assert(err instanceof AppError);
            assert(!err.message.includes(secretValue));
            assert(!err.message.includes('/home/user/.grok/secret.key'));
            assert(err.message.includes('[redacted]') || err.message.includes('[path]'));
            return true;
          },
        );
      },
    );
  });
});

test('GrokMcpProvider - removeServer', async (t) => {
  await t.test('removes server in user scope', async () => {
    await withMockSpawn(
      () => ({ stdout: 'Removed MCP server from user config', exitCode: 0 }),
      async (calls) => {
        const provider = new GrokMcpProvider();
        const res = await provider.removeServer({ name: 'user-srv', scope: 'user' });
        assert.deepEqual(res, {
          removed: true,
          provider: 'grok',
          name: 'user-srv',
          scope: 'user',
        });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, ['mcp', 'remove', '--scope', 'user', 'user-srv']);
      },
    );
  });

  await t.test('removes server in project scope', async () => {
    await withMockSpawn(
      () => ({ stdout: 'Removed MCP server from project config', exitCode: 0 }),
      async (calls) => {
        const provider = new GrokMcpProvider();
        const res = await provider.removeServer({ name: 'proj-srv', scope: 'project' });
        assert.deepEqual(res, {
          removed: true,
          provider: 'grok',
          name: 'proj-srv',
          scope: 'project',
        });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, ['mcp', 'remove', '--scope', 'project', 'proj-srv']);
      },
    );
  });

  await t.test('rejects local scope before spawn', async () => {
    await withMockSpawn(
      () => ({ stdout: 'Should not run', exitCode: 0 }),
      async (calls) => {
        const provider = new GrokMcpProvider();
        await assert.rejects(
          provider.removeServer({ name: 'local-srv', scope: 'local' }),
          (err: unknown) => {
            assert(err instanceof AppError);
            assert.equal(err.code, 'MCP_SCOPE_NOT_SUPPORTED');
            assert.equal(err.statusCode, 400);
            return true;
          },
        );
        assert.equal(calls.length, 0); // No CLI call made!
      },
    );
  });

  await t.test('scope isolation: remove with scope project does not touch user scope', async () => {
    await withMockSpawn(
      () => ({ stdout: 'Removed', exitCode: 0 }),
      async (calls) => {
        const provider = new GrokMcpProvider();
        await provider.removeServer({ name: 'shared-name', scope: 'project' });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, ['mcp', 'remove', '--scope', 'project', 'shared-name']);
      },
    );
  });
});
