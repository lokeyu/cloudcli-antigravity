import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Antigravity has no indexable session artifact this app can attribute to a
 * project, so provider-native session discovery is deliberately unsupported.
 *
 * What Antigravity persists per conversation is:
 * - `~/.gemini/antigravity-cli/conversations/<id>.db` — protobuf blobs in an
 *   undocumented schema;
 * - `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
 *   — readable steps, but with no record of the workspace the run happened in;
 * - `~/.gemini/antigravity-cli/conversation_summaries.db` — has a
 *   `workspace_uris` column, but the CLI leaves it empty for print-mode runs and
 *   only writes a row for some conversations.
 *
 * Guessing a project for those rows would put fabricated sessions in the
 * sidebar, so the synchronizer indexes nothing. Sessions started from CloudCLI
 * are unaffected: the runtime reports the conversation id over the chat gateway,
 * which records it as the session's `provider_session_id`, and history for those
 * sessions is read from the transcript log by `AntigravitySessionsProvider`.
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(_since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(_filePath: string): Promise<string | null> {
    return null;
  }
}
