import spawn from 'cross-spawn';

import { readAntigravityModelOptions } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

const SANITIZED_ERROR_MAX_LENGTH = 240;
// Long opaque blobs in CLI output can be bearer/OAuth material. They are
// replaced before an error string is ever returned to an API caller.
const SECRET_LIKE_TOKEN = /\b[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9_.-]*\b/g;

/**
 * Reduces raw CLI output to one short, credential-free line.
 *
 * Antigravity authentication is an OAuth flow the CLI owns; its failures can
 * echo token material, so nothing from stdout/stderr reaches the status API
 * before passing through here.
 */
const sanitizeAntigravityError = (value: unknown): string => {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const redacted = firstLine.replace(SECRET_LIKE_TOKEN, '[redacted]');

  if (!redacted) {
    return 'Antigravity CLI did not report any models';
  }

  return redacted.length > SANITIZED_ERROR_MAX_LENGTH
    ? `${redacted.slice(0, SANITIZED_ERROR_MAX_LENGTH)}…`
    : redacted;
};

export class AntigravityProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Antigravity CLI is available to the server process.
   */
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('agy', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns Antigravity CLI installation and access status.
   *
   * The CLI exposes no credential query, so access is probed with the cheapest
   * authenticated call it has: `agy models`. A successful exit with at least one
   * parsed model means the CLI has usable credentials. No token is read, stored,
   * or reported — `email` stays null by design.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    if (!installed) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI (agy) is not installed',
      };
    }

    try {
      const models = await readAntigravityModelOptions();
      if (models.length === 0) {
        return {
          installed: true,
          provider: 'antigravity',
          authenticated: false,
          email: null,
          method: null,
          error: 'Antigravity CLI returned no models',
        };
      }

      return {
        installed: true,
        provider: 'antigravity',
        authenticated: true,
        email: null,
        method: 'antigravity_cli',
      };
    } catch (error) {
      return {
        installed: true,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: sanitizeAntigravityError(error),
      };
    }
  }
}
