import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import { sliceTailPage } from '@/shared/utils.js';

/**
 * Grok's session/history adapter, deliberately conservative for now.
 *
 * What is verified about Grok CLI 0.2.114:
 * - `grok sessions list` shows remote sessions, but `grok export` answers
 *   `Session not found` for them, so their transcripts cannot be read here;
 * - no local session exists to observe, because the account's weekly quota is
 *   exhausted, so the Markdown `grok export` produces for a local session has
 *   never been seen;
 * - inventing a parser for an unobserved format would put heuristically
 *   reconstructed — effectively fabricated — history into the UI.
 *
 * Until a local transcript has been captured and a parser written against it,
 * history is reported as empty rather than guessed. Live runs are unaffected:
 * the Grok runtime normalizes its own NDJSON stream and never routes events
 * through this adapter.
 *
 * Consumers: the provider registry, once Grok is registered as a provider, and
 * `server/modules/providers/tests/grok-sessions.test.ts`.
 */
export class GrokProviderSessions implements IProviderSessions {
  /**
   * Returns no messages for any raw payload.
   *
   * The runtime parses its own live stream, so nothing in the app ever hands
   * this adapter an event it could vouch for; the repository also has no
   * runtime guard that could strictly prove an arbitrary value is already a
   * `NormalizedMessage`. Forwarding unverified data would fabricate transcript
   * rows, so nothing is forwarded.
   */
  normalizeMessage(_raw: unknown, _sessionId: string | null): NormalizedMessage[] {
    return [];
  }

  /**
   * Returns an empty history page shaped exactly like every other provider's.
   *
   * The pagination fields still go through the shared `sliceTailPage` contract
   * so `offset`/`limit`/`hasMore` behave identically to real histories, and
   * callers cannot tell an intentionally empty provider from an empty session.
   * No CLI is spawned and no Grok file is read — see the class comment for why
   * there is nothing trustworthy to read yet.
   */
  async fetchHistory(
    _sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);

    const { page, hasMore } = sliceTailPage<NormalizedMessage>([], normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total: 0,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
