import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * Antigravity reads MCP servers from one global file only
 * (`~/.gemini/config/mcp_config.json`); per-workspace configuration is not part
 * of its customization model, so this provider supports the `user` scope alone.
 */
const getAntigravityMcpConfigPath = (): string => (
  path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
);

/**
 * Reads the MCP config, tolerating the empty placeholder file the Antigravity
 * installer creates. A missing file and a zero-byte file both mean "no servers
 * configured yet"; genuinely malformed JSON still surfaces to the caller.
 */
const readAntigravityMcpConfig = async (): Promise<Record<string, unknown>> => {
  let content: string;
  try {
    content = await readFile(getAntigravityMcpConfigPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    throw error;
  }

  if (!content.trim()) {
    return {};
  }

  return readObjectRecord(JSON.parse(content)) ?? {};
};

export class AntigravityMcpProvider extends McpProvider {
  constructor() {
    // Antigravity documents exactly two transports: stdio (`command`) and SSE
    // (`serverUrl`). Streamable HTTP is not supported by the CLI.
    super('antigravity', ['user'], ['stdio', 'sse']);
  }

  protected async readScopedServers(_scope: McpScope, _workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readAntigravityMcpConfig();
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const config = await readAntigravityMcpConfig();
    config.mcpServers = servers;
    await writeJsonConfig(getAntigravityMcpConfigPath(), config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      const serverConfig: Record<string, unknown> = {
        command: input.command,
      };
      if (input.args?.length) {
        serverConfig.args = input.args;
      }
      if (input.env && Object.keys(input.env).length > 0) {
        serverConfig.env = input.env;
      }

      return serverConfig;
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for sse MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      serverUrl: input.url,
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    const command = readOptionalString(config.command);
    if (command) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'stdio',
        command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    // `url` is accepted on read so a hand-written config using the more common
    // key still shows up in the UI.
    const url = readOptionalString(config.serverUrl) ?? readOptionalString(config.url);
    if (url) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'sse',
        url,
      };
    }

    return null;
  }
}
