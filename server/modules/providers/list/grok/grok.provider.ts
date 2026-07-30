import { GrokProviderAuth } from '@/modules/providers/list/grok/grok-auth.provider.js';
import { GrokMcpProvider } from '@/modules/providers/list/grok/grok-mcp.provider.js';
import { GrokProviderModels } from '@/modules/providers/list/grok/grok-models.provider.js';
import { grokRuntime } from '@/modules/providers/list/grok/grok-runtime.provider.js';
import { GrokSessionSynchronizer } from '@/modules/providers/list/grok/grok-session-synchronizer.provider.js';
import { GrokProviderSessions } from '@/modules/providers/list/grok/grok-sessions.provider.js';
import { GrokSkillsProvider } from '@/modules/providers/list/grok/grok-skills.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

/**
 * Concrete Grok aggregate provider implementation.
 *
 * Exposes runtime, model catalog, MCP, auth, skills, session history, and
 * synchronization facets behind one registry-owned object.
 *
 * Consumed by `server/modules/providers/provider.registry.ts`.
 */
export class GrokProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = grokRuntime;
  readonly models: IProviderModels = new GrokProviderModels();
  readonly mcp: IProviderMcp = new GrokMcpProvider();
  readonly auth: IProviderAuth = new GrokProviderAuth();
  readonly skills: IProviderSkills = new GrokSkillsProvider();
  readonly sessions: IProviderSessions = new GrokProviderSessions();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new GrokSessionSynchronizer();

  constructor() {
    super('grok');
  }
}
