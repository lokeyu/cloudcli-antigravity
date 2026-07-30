import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Grok has no session artifact this app can attribute to a project, so
 * provider-native session discovery is deliberately unsupported.
 *
 * `grok sessions list` (verified against CLI 0.2.114) reports only
 * `SESSION ID / CREATED / UPDATED / STATUS / SUMMARY` — no project or workspace
 * path. Indexing those rows would mean guessing which project each session
 * belongs to, which would put fabricated sessions into the sidebar, so the
 * synchronizer indexes nothing and never runs the CLI or touches the
 * filesystem.
 *
 * Sessions started from CloudCLI are unaffected: the Grok runtime reports the
 * provider-native session id via its `session_created` event, the chat gateway
 * records it as the session's `provider_session_id`, and those sessions live in
 * the app database without any scanning.
 *
 * Consumers: the provider registry, once Grok is registered as a provider, and
 * `server/modules/providers/tests/grok-session-synchronizer.test.ts`.
 */
export class GrokSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(_since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(_filePath: string): Promise<string | null> {
    return null;
  }
}
