# CloudCLI native Antigravity provider

Implement a native `antigravity` provider in this exact CloudCLI v1.37.0 source tree.

Do not modify the globally installed CloudCLI package.
Do not modify systemd.
Do not install npm dependencies yet.
Do not commit or push changes.
Inspect the existing provider architecture and follow its current conventions.

## Environment

Antigravity executable:

/home/claude/.local/bin/agy

Current CLI version:

1.1.8

Default model:

gemini-3.6-flash-high

## Available models

gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.6-flash-low
gemini-3.5-flash-high
gemini-3.5-flash-medium
gemini-3.5-flash-low
gemini-3.1-pro-high
gemini-3.1-pro-low
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium

Models should preferably be discovered dynamically by executing:

agy models

Parse each line as:

<model-id><whitespace><display-name>

## New conversation

Spawn the CLI directly without a shell, using the selected CloudCLI project
directory as the child process cwd.

Equivalent command:

agy \
  --new-project \
  --model=<selected-model> \
  --output-format=stream-json \
  --print=<prompt>

Use `--mode=plan` when CloudCLI requests plan mode.

Use `--mode=accept-edits` when CloudCLI requests editing mode.

Do not add `--dangerously-skip-permissions` unconditionally.
Only use it when the CloudCLI request explicitly selects the provider's
bypass/auto-approve permission mode. Preserve safe permission semantics where
the CloudCLI architecture supports them.

## Continue conversation

The `init` event returns:

{
  "event": "init",
  "conversation_id": "<uuid>"
}

Continue the same conversation with:

agy \
  --conversation=<conversation_id> \
  --model=<selected-model> \
  --output-format=stream-json \
  --print=<prompt>

Do not use `--new-project` together with `--conversation`.

Always spawn the process with cwd set to the selected CloudCLI project path.

## Stream format

Input is line-delimited JSON.

### Initialization

{
  "event": "init",
  "conversation_id": "...",
  "init": {
    "model": "gemini-3.6-flash-high",
    "cwd": "/project/path",
    "tools": [],
    "permission_mode": "always-proceed"
  }
}

Store `conversation_id` as provider session metadata so later messages resume
the correct Antigravity conversation.

### Assistant output

Text is emitted in:

{
  "event": "step_update",
  "step_update": {
    "step_type": "agent_response",
    "state": "ACTIVE or DONE",
    "text_delta": "..."
  }
}

Stream `text_delta` to the CloudCLI assistant response.

Avoid duplicating text when ACTIVE and DONE events contain overlapping data.
Confirm actual behavior and implement a deduplication-safe parser.

### Tool call

Tool start:

{
  "event": "step_update",
  "step_update": {
    "step_index": 3,
    "state": "ACTIVE",
    "step_type": "tool",
    "tool_name": "run_command",
    "tool_info": {
      "name": "run_command",
      "parameters": {
        "CommandLine": "pwd"
      }
    }
  }
}

Tool completion:

{
  "event": "step_update",
  "step_update": {
    "step_index": 3,
    "state": "DONE",
    "step_type": "tool",
    "tool_name": "run_command",
    "tool_info": {
      "name": "run_command",
      "parameters": {
        "CommandLine": "pwd"
      },
      "output": "/project/path"
    }
  }
}

Map these to the closest existing CloudCLI tool start/tool result event format.
Use step_index as a stable call correlation identifier.

### Final result

{
  "event": "result",
  "result": {
    "conversation_id": "...",
    "status": "SUCCESS",
    "response": "...",
    "duration_seconds": 1.2,
    "num_turns": 1,
    "usage": {
      "input_tokens": 9968,
      "output_tokens": 54,
      "thinking_tokens": 49,
      "cache_read_tokens": 8141,
      "total_tokens": 10022
    }
  }
}

Map token usage and completion status into CloudCLI's provider event model.

Treat non-SUCCESS results, malformed JSON lines, non-zero process exit codes,
and meaningful stderr output as provider errors.

## Required integration

Inspect and update all required places, including where applicable:

- server provider implementation under:
  server/modules/providers/list/antigravity/
- provider registry
- shared LLMProvider/provider ID types
- provider capabilities
- provider model service integration
- authentication/status API
- session handling and synchronization
- frontend provider types
- provider selector
- provider authentication status maps
- logos/icons and display names
- localization labels
- tests

Use the display name:

Antigravity

Use the provider ID:

antigravity

Use a suitable existing Google/Gemini icon where the project already contains
one. Do not add downloaded binary assets.

## Authentication status

Do not handle or expose OAuth tokens.

The authentication status provider may verify access by running:

agy models

Successful exit with at least one parsed model means authenticated.

An error or empty model list means unauthenticated and should expose a sanitized
error message.

## Sessions

CloudCLI-created sessions must retain the Antigravity `conversation_id`.

Support:

- starting a new Antigravity conversation;
- resuming by conversation_id;
- streaming text;
- displaying tool calls and results;
- cancellation by terminating the child process;
- selected model;
- selected project cwd.

Native enumeration of all historical Antigravity conversations is optional for
the first implementation. Clearly mark unsupported optional capabilities rather
than returning fabricated data.

## Tests

Add focused tests for:

- parsing `agy models`;
- parsing init events;
- streaming assistant text;
- tool ACTIVE and DONE correlation;
- result and usage parsing;
- malformed lines;
- failed result;
- argument generation for new and resumed conversations;
- ensuring the project path is passed as process cwd;
- permission-mode argument mapping.

At the end:

1. Review the full diff.
2. Run only tests/type checks that work without installing missing dependencies.
3. Do not run npm install.
4. Do not change system files.
5. Report changed files, remaining risks, and exact commands needed for
   dependency installation, typecheck, tests, and build.
