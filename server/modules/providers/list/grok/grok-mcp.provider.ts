import childProcess from 'node:child_process';
import path from 'node:path';

import type { IProviderMcp } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderMcpServer,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

//----------------- GROK MCP PROVIDER ADAPTER ------------

const PROVIDER = 'grok' as LLMProvider;
const GROK_COMMAND = 'grok';
const GROK_CLI_TIMEOUT_MS = 20_000;
const SUPPORTED_SCOPES: readonly McpScope[] = ['user', 'project'];
const SUPPORTED_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];

const SANITIZED_ERROR_MAX_LENGTH = 240;
const PATH_LIKE_TOKEN = /(?:[A-Za-z]:\\|~?\/)[^\s'"`]*/g;
const SECRET_LIKE_TOKEN = /\b[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9_.-]*\b/g;

/**
 * Sanitizes CLI error streams so file paths, bearer tokens, and secrets are
 * redacted before an error reaches callers or logs.
 */
function sanitizeGrokCliMessage(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const redacted = firstLine
    .replace(PATH_LIKE_TOKEN, '[path]')
    .replace(SECRET_LIKE_TOKEN, '[redacted]')
    .trim();

  if (!redacted) {
    return '';
  }

  return redacted.length > SANITIZED_ERROR_MAX_LENGTH
    ? `${redacted.slice(0, SANITIZED_ERROR_MAX_LENGTH)}…`
    : redacted;
}

function normalizeServerName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new AppError('MCP server name is required.', {
      code: 'MCP_SERVER_NAME_REQUIRED',
      statusCode: 400,
    });
  }
  return normalized;
}

function resolveWorkspacePath(workspacePath?: string): string {
  return path.resolve(workspacePath ?? process.cwd());
}

function assertScope(scope: McpScope): void {
  if (!SUPPORTED_SCOPES.includes(scope)) {
    throw new AppError(`Provider "${PROVIDER}" does not support "${scope}" MCP scope.`, {
      code: 'MCP_SCOPE_NOT_SUPPORTED',
      statusCode: 400,
    });
  }
}

function assertTransport(transport: McpTransport): void {
  if (!SUPPORTED_TRANSPORTS.includes(transport)) {
    throw new AppError(`Provider "${PROVIDER}" does not support "${transport}" MCP transport.`, {
      code: 'MCP_TRANSPORT_NOT_SUPPORTED',
      statusCode: 400,
    });
  }
}

type ExecGrokCliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

/**
 * Executes a `grok` CLI command with standard process isolation and timeout rules.
 */
function execGrokCli(
  args: string[],
  cwd: string,
  timeoutMs: number = GROK_CLI_TIMEOUT_MS,
): Promise<ExecGrokCliResult> {
  return new Promise<ExecGrokCliResult>((resolve) => {
    const proc = childProcess.spawn(GROK_COMMAND, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const onStdout = (chunk: Buffer | string): void => {
      stdout += chunk.toString();
    };

    const onStderr = (chunk: Buffer | string): void => {
      stderr += chunk.toString();
    };

    const finish = (result: ExecGrokCliResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off('data', onStdout);
      proc.stderr?.off('data', onStderr);
      proc.off('close', onClose);
      proc.off('error', onError);
      proc.on('error', () => undefined);
      resolve(result);
    };

    const onClose = (code: number | null): void => {
      finish({ exitCode: code, stdout, stderr });
    };

    const onError = (error: Error): void => {
      finish({ exitCode: null, stdout, stderr, error });
    };

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('close', onClose);
    proc.on('error', onError);

    timer = setTimeout(() => {
      proc.kill('SIGTERM');
      finish({ exitCode: null, stdout, stderr, error: new Error('Command timed out') });
    }, timeoutMs);
  });
}

/**
 * Parses and validates `grok mcp list --json` output under strict schema rules.
 */
function parseMcpListJson(rawStdout: string): ProviderMcpServer[] {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const servers: ProviderMcpServer[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;

    // Validate name
    if (typeof record.name !== 'string' || !record.name.trim()) {
      continue;
    }
    const name = record.name.trim();

    // Validate scope
    if (record.scope !== 'user' && record.scope !== 'project') {
      continue;
    }
    const scope: McpScope = record.scope;

    // Validate enabled
    if (typeof record.enabled !== 'boolean') {
      continue;
    }

    // Ambiguity check: cannot have both command and url
    if (record.command !== undefined && record.url !== undefined) {
      continue;
    }

    // stdio transport candidate
    if (record.command !== undefined) {
      if (typeof record.command !== 'string' || !record.command.trim()) {
        continue;
      }
      const command = record.command.trim();

      // args validation
      let argsToUse: string[] | undefined;
      if (record.args !== undefined) {
        if (!Array.isArray(record.args) || !record.args.every((a) => typeof a === 'string')) {
          continue;
        }
        argsToUse = record.args as string[];
      }

      // env validation
      let envToUse: Record<string, string> | undefined;
      if (record.env !== undefined) {
        if (
          !record.env ||
          typeof record.env !== 'object' ||
          Array.isArray(record.env) ||
          !Object.values(record.env as Record<string, unknown>).every((v) => typeof v === 'string')
        ) {
          continue;
        }
        envToUse = record.env as Record<string, string>;
      }

      servers.push({
        provider: PROVIDER,
        name,
        scope,
        transport: 'stdio',
        command,
        ...(argsToUse && argsToUse.length > 0 ? { args: argsToUse } : {}),
        ...(envToUse && Object.keys(envToUse).length > 0 ? { env: envToUse } : {}),
      });
      continue;
    }

    // http/sse transport candidate
    if (record.url !== undefined) {
      if (typeof record.url !== 'string' || !record.url.trim()) {
        continue;
      }
      const url = record.url.trim();

      // headers validation
      let headersToUse: Record<string, string> | undefined;
      if (record.headers !== undefined) {
        if (
          !record.headers ||
          typeof record.headers !== 'object' ||
          Array.isArray(record.headers) ||
          !Object.values(record.headers as Record<string, unknown>).every((v) => typeof v === 'string')
        ) {
          continue;
        }
        headersToUse = record.headers as Record<string, string>;
      }

      // transport/type validation
      let transport: McpTransport = 'http';
      if (record.type !== undefined) {
        if (record.type === 'sse') {
          transport = 'sse';
        } else {
          // Unknown type value
          continue;
        }
      }

      servers.push({
        provider: PROVIDER,
        name,
        scope,
        transport,
        url,
        ...(headersToUse && Object.keys(headersToUse).length > 0 ? { headers: headersToUse } : {}),
      });
      continue;
    }
  }

  return servers;
}

function deepEqualStrings(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const mapA = a ?? {};
  const mapB = b ?? {};
  const keysA = Object.keys(mapA);
  const keysB = Object.keys(mapB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (mapA[k] !== mapB[k]) return false;
  }
  return true;
}

function deepEqualStringArrays(a?: string[], b?: string[]): boolean {
  const arrA = a ?? [];
  const arrB = b ?? [];
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (arrA[i] !== arrB[i]) return false;
  }
  return true;
}

function isSameMcpConfig(existing: ProviderMcpServer, input: UpsertProviderMcpServerInput): boolean {
  if (existing.transport !== input.transport) {
    return false;
  }

  if (input.transport === 'stdio') {
    if (existing.command !== input.command) {
      return false;
    }
    if (!deepEqualStringArrays(existing.args, input.args)) {
      return false;
    }
    if (!deepEqualStrings(existing.env, input.env)) {
      return false;
    }
    return true;
  }

  if (existing.url !== input.url) {
    return false;
  }
  if (!deepEqualStrings(existing.headers, input.headers)) {
    return false;
  }

  return true;
}

/**
 * Native Grok CLI MCP provider adapter.
 *
 * Consumed by provider service / registry (when registered) and
 * `server/modules/providers/tests/grok-mcp.test.ts`.
 */
export class GrokMcpProvider implements IProviderMcp {
  constructor(private readonly timeoutMs: number = GROK_CLI_TIMEOUT_MS) {}

  async listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>> {
    const cwd = resolveWorkspacePath(options?.workspacePath);
    const result = await execGrokCli(['mcp', 'list', '--json'], cwd, this.timeoutMs);

    const grouped: Record<McpScope, ProviderMcpServer[]> = {
      user: [],
      local: [],
      project: [],
    };

    if (result.error || result.exitCode !== 0 || !result.stdout.trim()) {
      return grouped;
    }

    const servers = parseMcpListJson(result.stdout);
    for (const server of servers) {
      grouped[server.scope].push(server);
    }

    return grouped;
  }

  async listServersForScope(
    scope: McpScope,
    options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    if (scope === 'local') {
      return [];
    }
    assertScope(scope);

    const allServers = await this.listServers(options);
    return allServers[scope];
  }

  async upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    const scope = input.scope ?? 'project';
    assertScope(scope);
    assertTransport(input.transport);

    const normalizedName = normalizeServerName(input.name);
    const cwd = resolveWorkspacePath(input.workspacePath);

    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }
    } else {
      if (!input.url?.trim()) {
        throw new AppError('url is required for http/sse MCP servers.', {
          code: 'MCP_URL_REQUIRED',
          statusCode: 400,
        });
      }
    }

    const existingServers = await this.listServersForScope(scope, { workspacePath: input.workspacePath });
    const existing = existingServers.find((s) => s.name === normalizedName);

    if (existing && isSameMcpConfig(existing, input)) {
      return existing;
    }

    let removedExisting = false;
    if (existing) {
      const removeResult = await this.execRemoveCli(normalizedName, scope, cwd);
      if (!removeResult.success) {
        throw new AppError(
          `Failed to remove existing MCP server "${normalizedName}" in scope "${scope}" before updating: ${removeResult.errorDetail}`,
          { code: 'MCP_UPSERT_FAILED', statusCode: 500 },
        );
      }
      removedExisting = true;
    }

    const addResult = await this.execAddCli(normalizedName, scope, input, cwd);
    if (!addResult.success) {
      if (removedExisting && existing) {
        const rollbackResult = await this.execAddFromExisting(existing, cwd);
        if (!rollbackResult.success) {
          throw new AppError(
            `Failed to add MCP server "${normalizedName}" in scope "${scope}" and rollback failed: ${addResult.errorDetail}`,
            { code: 'MCP_UPSERT_FAILED', statusCode: 500 },
          );
        }
      }
      throw new AppError(
        `Failed to add MCP server "${normalizedName}" in scope "${scope}": ${addResult.errorDetail}`,
        { code: 'MCP_UPSERT_FAILED', statusCode: 500 },
      );
    }

    if (input.transport === 'stdio') {
      return {
        provider: PROVIDER,
        name: normalizedName,
        scope,
        transport: 'stdio',
        command: input.command!.trim(),
        ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
        ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
      };
    }

    return {
      provider: PROVIDER,
      name: normalizedName,
      scope,
      transport: input.transport,
      url: input.url!.trim(),
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
    };
  }

  async removeServer(input: {
    name: string;
    scope?: McpScope;
    workspacePath?: string;
  }): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
    const scope = input.scope ?? 'project';
    assertScope(scope);

    const normalizedName = normalizeServerName(input.name);
    const cwd = resolveWorkspacePath(input.workspacePath);

    const removeResult = await this.execRemoveCli(normalizedName, scope, cwd);

    return {
      removed: removeResult.success,
      provider: PROVIDER,
      name: normalizedName,
      scope,
    };
  }

  private async execRemoveCli(
    name: string,
    scope: McpScope,
    cwd: string,
  ): Promise<{ success: boolean; errorDetail: string }> {
    const result = await execGrokCli(['mcp', 'remove', '--scope', scope, name], cwd, this.timeoutMs);
    const notFound =
      result.stderr.toLowerCase().includes('not found') ||
      result.stdout.toLowerCase().includes('not found');
    const success = result.exitCode === 0 && !notFound;

    const safeStderr = sanitizeGrokCliMessage(result.stderr || result.stdout || '');
    const exitInfo = result.exitCode !== null ? `exit code ${result.exitCode}` : 'spawn error';
    const errorDetail = safeStderr ? `${exitInfo} (${safeStderr})` : exitInfo;

    return { success, errorDetail };
  }

  private async execAddCli(
    name: string,
    scope: McpScope,
    input: UpsertProviderMcpServerInput,
    cwd: string,
  ): Promise<{ success: boolean; errorDetail: string }> {
    const args: string[] = ['mcp', 'add'];

    if (input.transport === 'stdio') {
      args.push('--scope', scope);
      if (input.env) {
        for (const [k, v] of Object.entries(input.env)) {
          args.push('-e', `${k}=${v}`);
        }
      }
      args.push(name);
      args.push('--');
      args.push(input.command!.trim());
      if (input.args) {
        for (const arg of input.args) {
          args.push(arg);
        }
      }
    } else {
      args.push('--transport', input.transport, '--scope', scope);
      if (input.headers) {
        for (const [k, v] of Object.entries(input.headers)) {
          args.push('-H', `${k}: ${v}`);
        }
      }
      args.push(name);
      args.push(input.url!.trim());
    }

    const result = await execGrokCli(args, cwd, this.timeoutMs);
    const success = result.exitCode === 0 && !result.error;

    const safeStderr = sanitizeGrokCliMessage(result.stderr || result.stdout || '');
    const exitInfo = result.exitCode !== null ? `exit code ${result.exitCode}` : 'spawn error';
    const errorDetail = safeStderr ? `${exitInfo} (${safeStderr})` : exitInfo;

    return { success, errorDetail };
  }

  private async execAddFromExisting(
    existing: ProviderMcpServer,
    cwd: string,
  ): Promise<{ success: boolean; errorDetail: string }> {
    const input: UpsertProviderMcpServerInput = {
      name: existing.name,
      scope: existing.scope,
      transport: existing.transport,
      command: existing.command,
      args: existing.args,
      env: existing.env,
      url: existing.url,
      headers: existing.headers,
    };
    return this.execAddCli(existing.name, existing.scope, input, cwd);
  }
}
