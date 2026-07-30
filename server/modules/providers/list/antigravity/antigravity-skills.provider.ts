import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

/**
 * Antigravity discovers skills as `skills/<name>/SKILL.md` directories under a
 * customization root: `.agents` inside the workspace, `~/.gemini/config`
 * globally, plus the read-only skills bundled with the CLI itself.
 */
const ANTIGRAVITY_GLOBAL_SKILL_DIR = ['.gemini', 'config', 'skills'];
const ANTIGRAVITY_BUILTIN_SKILL_DIR = ['.gemini', 'antigravity-cli', 'builtin', 'skills'];

export class AntigravitySkillsProvider extends SkillsProvider {
  constructor() {
    super('antigravity');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'project',
      rootDir: path.join(workspacePath, '.agents', 'skills'),
      commandPrefix: '/',
    });

    if (repoRoot) {
      // The launch folder and the repository root can be the same directory;
      // `addUniqueProviderSkillSource` collapses the duplicate.
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'repo',
        rootDir: path.join(repoRoot, '.agents', 'skills'),
        commandPrefix: '/',
      });
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), ...ANTIGRAVITY_GLOBAL_SKILL_DIR),
      commandPrefix: '/',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'system',
      rootDir: path.join(os.homedir(), ...ANTIGRAVITY_BUILTIN_SKILL_DIR),
      commandPrefix: '/',
    });

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), ...ANTIGRAVITY_GLOBAL_SKILL_DIR),
      commandPrefix: '/',
    };
  }
}
