import crossSpawn from 'cross-spawn';

import {
  AntigravityStreamParser,
  readAntigravityConversationId
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from '@/shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else. `agy` is spawned directly — never through
// a shell — so prompts are passed as a single argv entry with no quoting rules.
const spawnFunction = crossSpawn;

const activeAntigravityProcesses = new Map();

const MALFORMED_LINE_PREVIEW_LENGTH = 200;

/**
 * Maps the UI permission mode onto the Antigravity CLI's own controls.
 *
 * `agy` (verified against CLI 1.1.8) has one execution-mode flag plus one
 * escape hatch, and its default is a review mode that denies anything it cannot
 * prompt for in headless mode:
 * - plan              → `--mode=plan`, the read-only planning mode.
 * - acceptEdits       → `--mode=accept-edits`, which auto-approves file edits
 *                       while other tools still need permission.
 * - bypassPermissions → `--dangerously-skip-permissions`. This is the only mode
 *                       that gets the flag: adding it unconditionally would
 *                       silently auto-approve every tool in the safe modes.
 * - default           → nothing; the CLI's `request-review` mode governs, and
 *                       tools it cannot confirm are denied rather than run.
 *
 * Exported for tests only.
 */
export function resolveAntigravityPermissionArgs(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return ['--mode=plan'];
    case 'acceptEdits':
      return ['--mode=accept-edits'];
    case 'bypassPermissions':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

/**
 * Builds the argv for one `agy` print-mode run.
 *
 * `--new-project` and `--conversation` are mutually exclusive: the first
 * creates the conversation, the second resumes the one whose id was recorded on
 * the session row. The prompt is passed as `--print=<prompt>` so a prompt
 * starting with `-` cannot be mistaken for a flag.
 *
 * Exported for tests only.
 */
export function buildAntigravityArgs({ conversationId, model, permissionMode, prompt }) {
  const args = [];

  if (conversationId) {
    args.push(`--conversation=${conversationId}`);
  } else {
    args.push('--new-project');
  }

  if (model) {
    args.push(`--model=${model}`);
  }

  args.push('--output-format=stream-json');
  args.push(...resolveAntigravityPermissionArgs(permissionMode));
  args.push(`--print=${prompt}`);

  return args;
}

async function spawnAntigravity(command, options = {}, ws, context) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    sessionSummary,
    permissionMode
  } = options;

  // Callers pass the stable app session id; the CLI resumes with the
  // provider-native conversation id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  // Antigravity resolves relative paths and workspace trust from the child
  // process cwd, so the selected project directory is the working directory.
  const workingDir = cwd || projectPath || process.cwd();
  // Process-map key: the app session id when the caller supplied one, so
  // abort-by-app-id always works.
  const processKey = sessionId || Date.now().toString();

  return new Promise((resolve, reject) => {
    const parser = new AntigravityStreamParser();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let antigravityProcess = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    // Set only for failures that invalidate the run itself (a non-SUCCESS
    // `result`, a broken stream line). Advisory stderr is surfaced to the user
    // but does not turn a cleanly exiting run into a failed one.
    let sawFatalError = false;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'antigravity',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'antigravity',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Antigravity CLI exited with code ${code}`
      });
    };

    const sendError = (content, { fatal = false } = {}) => {
      if (fatal) {
        sawFatalError = true;
      }

      ws.send(createNormalizedMessage({
        kind: 'error',
        content,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'antigravity'
      }));
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      if (!sessionId && processKey !== capturedSessionId && antigravityProcess) {
        activeAntigravityProcesses.delete(processKey);
        activeAntigravityProcesses.set(capturedSessionId, antigravityProcess);
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      // The chat gateway turns this into the app-id-to-conversation-id mapping
      // that later turns resume with.
      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'antigravity'
        }));
      }
    };

    const processAntigravityOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Print mode is documented as line-delimited JSON, so a non-JSON line
        // is a provider error rather than assistant output.
        const preview = line.length > MALFORMED_LINE_PREVIEW_LENGTH
          ? `${line.slice(0, MALFORMED_LINE_PREVIEW_LENGTH)}…`
          : line;
        sendError(`Antigravity CLI emitted a malformed stream line: ${preview}`, { fatal: true });
        return;
      }

      try {
        registerSession(readAntigravityConversationId(event));
        for (const message of parser.parseEvent(event, capturedSessionId || sessionId || null)) {
          // The parser only emits `error` for a non-SUCCESS `result`, which is
          // the CLI declaring the whole run failed.
          if (message.kind === 'error') {
            sawFatalError = true;
          }
          ws.send(message);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[Antigravity] Failed to process stream event:', errorContent);
        sendError(errorContent, { fatal: true });
      }
    };

    // `agy` is a native binary, but keep the shared prompt flattening so an
    // npm-style `.cmd` shim on Windows cannot truncate a multi-line prompt.
    const prompt = flattenPromptForWindowsShell(command || '');
    const args = buildAntigravityArgs({
      conversationId: providerSessionId,
      model: resolvedModel,
      permissionMode,
      prompt
    });

    antigravityProcess = spawnFunction('agy', args, {
      cwd: workingDir,
      // Print mode takes its prompt from `--print` and never reads stdin, but it
      // does wait for stdin to reach EOF: an open stdin pipe makes `agy` hang
      // indefinitely (verified against CLI 1.1.8). Detaching stdin is what lets
      // the run finish on its own.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    activeAntigravityProcesses.set(processKey, antigravityProcess);

    antigravityProcess.stdout.on('data', (data) => {
      // Stream chunks can split a JSON line across packets; keep the trailing
      // partial line until its newline arrives.
      stdoutLineBuffer += data.toString();
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';

      completeLines.forEach((line) => {
        processAntigravityOutputLine(line.trim());
      });
    });

    antigravityProcess.stderr.on('data', (data) => {
      const stderrText = data.toString();
      if (!stderrText.trim()) {
        return;
      }

      console.error('Antigravity CLI stderr:', stderrText);
      sendError(stderrText);
    });

    antigravityProcess.on('close', async (code) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeAntigravityProcesses.delete(finalSessionId);
      activeAntigravityProcesses.delete(processKey);

      if (stdoutLineBuffer.trim()) {
        processAntigravityOutputLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      // Terminal complete — skipped for aborted runs (abort-session already
      // sent the aborted complete on this run's behalf). A clean exit that
      // still reported a fatal error is completed as a failure.
      const exitCode = code === 0 && sawFatalError ? 1 : code;
      if (!completeSent && !antigravityProcess.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({
          provider: 'antigravity',
          sessionId: finalSessionId,
          exitCode
        }));
      }

      if (code === 0 && !sawFatalError) {
        notifyTerminalState({ code });
        resolve();
        return;
      }

      if (code === 127 || code === null) {
        const installed = await context.isProviderInstalled();
        if (!installed) {
          sendError('Antigravity CLI (agy) is not installed. Install it from https://antigravity.google');
        }
      }

      notifyTerminalState({ code: exitCode });
      if (code === null) {
        reject(new Error('Antigravity CLI process was terminated'));
        return;
      }

      reject(new Error(code === 0
        ? 'Antigravity CLI reported a failed run'
        : `Antigravity CLI exited with code ${code}`));
    });

    antigravityProcess.on('error', async (error) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeAntigravityProcesses.delete(finalSessionId);
      activeAntigravityProcesses.delete(processKey);

      const installed = await context.isProviderInstalled();
      sendError(!installed
        ? 'Antigravity CLI (agy) is not installed. Install it from https://antigravity.google'
        : error.message);

      if (!completeSent && !antigravityProcess.aborted) {
        completeSent = true;
        ws.send(createCompleteMessage({
          provider: 'antigravity',
          sessionId: finalSessionId,
          exitCode: 1
        }));
      }

      notifyTerminalState({ error });
      reject(error);
    });
  });
}

/**
 * Cancels a run by terminating the `agy` child process.
 *
 * Print mode has no cancel message, so the process itself is the cancellation
 * unit. The conversation stays resumable: Antigravity has already persisted the
 * steps it completed under the same conversation id.
 */
function abortAntigravitySession(sessionId) {
  const antigravityProcess = activeAntigravityProcesses.get(sessionId);
  if (!antigravityProcess) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  antigravityProcess.aborted = true;
  antigravityProcess.kill('SIGTERM');
  activeAntigravityProcesses.delete(sessionId);
  return true;
}

function isAntigravitySessionActive(sessionId) {
  return activeAntigravityProcesses.has(sessionId);
}

function getActiveAntigravitySessions() {
  return Array.from(activeAntigravityProcesses.keys());
}

export const antigravityRuntime = {
  run: spawnAntigravity,
  abort: abortAntigravitySession,
};

export {
  spawnAntigravity,
  abortAntigravitySession,
  isAntigravitySessionActive,
  getActiveAntigravitySessions
};
