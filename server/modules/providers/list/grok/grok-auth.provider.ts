import childProcess from 'node:child_process';

import { parseGrokModelsStdout } from '@/modules/providers/list/grok/grok-models.provider.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

const PROVIDER = 'grok';

/**
 * `grok models` is the only read-only account probe the CLI publishes.
 *
 * CLI 0.2.114 has no `auth` subcommand: its credential surface is `login` and
 * `logout`, one of which starts an interactive sign-in and the other of which
 * destroys credentials, so neither can be used for a status check. `grok models`
 * answers from the local leader process, prints the login banner and the model
 * catalog, and never sends a prompt — so it also cannot be affected by an
 * exhausted agent quota.
 */
const GROK_AUTH_PROBE_ARGS = ['models'] as const;
const GROK_AUTH_PROBE_TIMEOUT_MS = 20_000;

// `grok models` opens with `You are logged in with grok.com.` when credentials
// are usable. The account identity after "with" is deliberately not captured.
const LOGGED_IN_BANNER = /you are logged in\b/i;

// Phrases the CLI uses when it wants the user to sign in. None of them overlaps
// with the quota wording (`usage balance exhausted`), which must stay a
// signed-in state.
const NOT_LOGGED_IN_SIGNALS = [
  /not logged in/i,
  /not authenticated/i,
  /unauthenticated/i,
  /grok login/i,
  /log in to/i,
  /sign in to/i,
];

const SANITIZED_ERROR_MAX_LENGTH = 240;
// Filesystem paths can point at the credential store (`~/.grok/auth.json`), so
// anything path-shaped is replaced before an error reaches an API caller.
const PATH_LIKE_TOKEN = /(?:[A-Za-z]:\\|~?\/)[^\s'"`]*/g;
// Long opaque blobs in CLI output can be bearer/OAuth material.
const SECRET_LIKE_TOKEN = /\b[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9_.-]*\b/g;

/** What one `grok models` probe learned, with nothing interpreted yet. */
type GrokProbeOutcome =
  | { kind: 'output'; stdout: string; stderr: string; exitCode: number | null }
  | { kind: 'missing' }
  | { kind: 'unstartable'; code: string }
  | { kind: 'timeout' };

/**
 * Reduces raw CLI output to one short, credential-free line.
 *
 * Only the first non-empty line survives, with path-like and token-like
 * fragments redacted and the result capped, so a full stderr dump can never
 * reach the status API.
 */
const sanitizeGrokCliMessage = (value: string): string => {
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
};

const looksLoggedOut = (output: string): boolean => (
  NOT_LOGGED_IN_SIGNALS.some((signal) => signal.test(output))
);

/** Reads the errno code off a spawn failure without exposing the message. */
const readSpawnErrorCode = (error: Error): string => {
  const { code } = error as NodeJS.ErrnoException;
  return typeof code === 'string' && code ? code : 'UNKNOWN';
};

const buildStatus = (
  fields: Pick<ProviderAuthStatus, 'installed' | 'authenticated' | 'method'> & { error?: string },
): ProviderAuthStatus => ({
  installed: fields.installed,
  provider: PROVIDER,
  authenticated: fields.authenticated,
  // No credential is ever read, so there is no account identity to report.
  email: null,
  method: fields.method,
  ...(fields.error ? { error: fields.error } : {}),
});

/**
 * Turns one probe outcome into the shared auth status.
 *
 * A clean exit that shows either the login banner or a parsed catalog is proof
 * of usable credentials; the two are checked independently so a future CLI that
 * drops the banner still reports correctly.
 */
const buildGrokAuthStatus = (outcome: GrokProbeOutcome): ProviderAuthStatus => {
  if (outcome.kind === 'missing') {
    return buildStatus({
      installed: false,
      authenticated: false,
      method: null,
      error: 'Grok CLI (grok) is not installed',
    });
  }

  if (outcome.kind === 'unstartable') {
    return buildStatus({
      installed: false,
      authenticated: false,
      method: null,
      error: `Grok CLI could not be started (${outcome.code})`,
    });
  }

  if (outcome.kind === 'timeout') {
    return buildStatus({
      installed: true,
      authenticated: false,
      method: null,
      error: 'Grok CLI did not respond in time',
    });
  }

  const { stdout, stderr, exitCode } = outcome;

  if (exitCode === 0) {
    const hasCatalog = parseGrokModelsStdout(stdout).options.length > 0;
    if (LOGGED_IN_BANNER.test(stdout) || hasCatalog) {
      return buildStatus({ installed: true, authenticated: true, method: 'grok_cli' });
    }
  }

  if (looksLoggedOut(`${stdout}\n${stderr}`)) {
    return buildStatus({
      installed: true,
      authenticated: false,
      method: null,
      error: 'Grok CLI is not logged in. Run `grok login`.',
    });
  }

  return buildStatus({
    installed: true,
    authenticated: false,
    method: null,
    error: sanitizeGrokCliMessage(stderr)
      || sanitizeGrokCliMessage(stdout)
      || `Grok CLI exited with code ${exitCode}`,
  });
};

/**
 * Grok's installation and credential status adapter.
 *
 * Consumers: the provider registry, once Grok is registered as a provider, and
 * `server/modules/providers/tests/grok-auth.test.ts`.
 */
export class GrokProviderAuth implements IProviderAuth {
  /**
   * @param probeTimeoutMs How long `grok models` may take before the probe gives
   * up and terminates it. Only the auth tests pass this, so they do not have to
   * wait out the real 20 second budget.
   */
  constructor(private readonly probeTimeoutMs: number = GROK_AUTH_PROBE_TIMEOUT_MS) {}

  /**
   * Reports whether the Grok CLI is installed and holds usable credentials.
   *
   * Nothing is read from `~/.grok`; the answer comes entirely from how the CLI
   * responds to its own read-only `models` command. No token, credential path,
   * or environment content is returned, so `email` stays null by design.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    return buildGrokAuthStatus(await this.probeGrokModels());
  }

  /**
   * Runs `grok models` and resolves what happened, never rejecting.
   *
   * The CLI is spawned straight from PATH with its arguments as a separate array
   * and no shell, stdin detached so it cannot wait on input, and both output
   * streams piped. Exactly one outcome is produced even when `error` and `close`
   * both fire, and the timer and stream listeners are released either way.
   */
  private probeGrokModels(): Promise<GrokProbeOutcome> {
    return new Promise<GrokProbeOutcome>((resolve) => {
      const grokProcess = childProcess.spawn('grok', [...GROK_AUTH_PROBE_ARGS], {
        cwd: process.cwd(),
        env: { ...process.env },
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

      const finish = (outcome: GrokProbeOutcome): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        grokProcess.stdout?.off('data', onStdout);
        grokProcess.stderr?.off('data', onStderr);
        grokProcess.off('close', onClose);
        grokProcess.off('error', onError);
        // A child can still emit `error` after it was settled — a kill that
        // fails, for example. An emitter with no `error` listener turns that
        // into an uncaught exception, so one inert sink stays attached.
        grokProcess.on('error', () => undefined);
        resolve(outcome);
      };

      const onClose = (code: number | null): void => {
        finish({ kind: 'output', stdout, stderr, exitCode: code });
      };

      const onError = (error: Error): void => {
        const code = readSpawnErrorCode(error);
        finish(code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unstartable', code });
      };

      grokProcess.stdout?.on('data', onStdout);
      grokProcess.stderr?.on('data', onStderr);
      grokProcess.on('close', onClose);
      grokProcess.on('error', onError);

      timer = setTimeout(() => {
        grokProcess.kill('SIGTERM');
        finish({ kind: 'timeout' });
      }, this.probeTimeoutMs);
    });
  }
}
