import childProcess from 'node:child_process';
import path from 'node:path';

import type { IProviderSkills } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
  ProviderSkillScope,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

//----------------- GROK SKILLS PROVIDER ADAPTER ------------

const PROVIDER = 'grok' as LLMProvider;
const GROK_COMMAND = 'grok';
const GROK_CLI_TIMEOUT_MS = 20_000;

function resolveWorkspacePath(workspacePath?: string): string {
  return path.resolve(workspacePath ?? process.cwd());
}

type ExecGrokCliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

/**
 * Executes `grok inspect --json` with process isolation and timeout rules.
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
 * Parses `grok inspect --json` output under strict schema rules.
 */
function parseSkillsInspectJson(rawStdout: string): ProviderSkill[] {
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

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.skills)) {
    return [];
  }

  const skills: ProviderSkill[] = [];

  for (const item of root.skills) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const rec = item as Record<string, unknown>;

    // Validate name
    if (typeof rec.name !== 'string' || !rec.name.trim()) {
      continue;
    }
    const name = rec.name.trim();

    // Validate description
    if (typeof rec.description !== 'string') {
      continue;
    }
    const description = rec.description;

    // Validate userInvocable
    if (typeof rec.userInvocable !== 'boolean') {
      continue;
    }
    const userInvocable = rec.userInvocable;

    // Validate source object
    if (!rec.source || typeof rec.source !== 'object' || Array.isArray(rec.source)) {
      continue;
    }
    const src = rec.source as Record<string, unknown>;

    // Validate source.type ('project' or 'bundled')
    if (src.type !== 'project' && src.type !== 'bundled') {
      continue;
    }

    // Validate source.path (must end with SKILL.md)
    if (typeof src.path !== 'string' || !src.path.trim()) {
      continue;
    }
    const sourcePath = src.path.trim();
    if (!sourcePath.endsWith('SKILL.md')) {
      continue;
    }

    const scope: ProviderSkillScope = src.type === 'project' ? 'project' : 'system';
    const command = userInvocable ? `/${name}` : '';

    skills.push({
      provider: PROVIDER,
      name,
      description,
      command,
      scope,
      sourcePath,
    });
  }

  return skills;
}

/**
 * Native Grok CLI skills provider adapter.
 *
 * Discovers skills via `grok inspect --json`. Managed skill writes are unsupported.
 * Consumed by provider service / registry (when registered) and
 * `server/modules/providers/tests/grok-skills.test.ts`.
 */
export class GrokSkillsProvider implements IProviderSkills {
  constructor(private readonly timeoutMs: number = GROK_CLI_TIMEOUT_MS) {}

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const cwd = resolveWorkspacePath(options?.workspacePath);
    const result = await execGrokCli(['inspect', '--json'], cwd, this.timeoutMs);

    if (result.error || result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    return parseSkillsInspectJson(result.stdout);
  }

  async addSkills(_input: ProviderSkillCreateInput): Promise<ProviderSkill[]> {
    throw new AppError('grok skills are read-only via CLI metadata and do not support managed writes.', {
      code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
      statusCode: 400,
    });
  }

  async removeSkill(
    _input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }> {
    throw new AppError('grok skills are read-only via CLI metadata and do not support managed writes.', {
      code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
      statusCode: 400,
    });
  }
}
