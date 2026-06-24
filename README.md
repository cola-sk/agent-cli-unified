# agent-cli-unified

[中文文档](README_ZH.md)

A reusable Node.js package that standardizes command construction, execution, and stream event parsing for:
- Codex CLI
- Claude Code CLI
- Antigravity CLI
- Copilot CLI

## Install

```bash
npm i @sking7/agent-cli-unified
```

## Quick Usage

```js
const { buildCliInvocation, runCliAgent, detectCliAgents } = require('@sking7/agent-cli-unified');

const available = detectCliAgents();
console.log(available);

// 1. Basic Invocation Builder
const invocation = buildCliInvocation({
  agent: 'codex',
  prompt: 'fix lint errors',
  cwd: '/path/to/repo',
});

console.log(invocation.command, invocation.args.join(' '));

// 2. Running an Agent with Real-time Event Stream & Security Sandbox
const result = await runCliAgent({
  agent: 'antigravity',
  prompt: 'summarize repository status',
  cwd: '/path/to/repo',
  sandbox: {
    restrictToWorkspace: true, // Auto SIGKILL child if it attempts file access outside cwd
  },
  onEvent: (event) => {
    if (event.type === 'tool_use') {
      console.log('TOOL USE', event.name, event.input);
    } else if (event.type === 'text') {
      process.stdout.write(event.text);
    }
  },
});

console.log(result.ok, result.exitCode);
```

## API

### `buildCliInvocation(options)`

Build a deterministic command invocation.

- `agent`: `codex | claude | antigravity | copilot`
- `prompt`: required string
- `cwd`: optional; defaults to user home
- `systemPrompt`: optional; injected when CLI supports it, otherwise folded into prompt
- `model`: optional; mapped to `--model` for supported CLIs
- `commandPath`: optional explicit executable path
- `argsTemplate`: optional arguments template list (e.g. `['--sys', '{{SYSTEM}}', '--run', '{{PROMPT}}']`) which replaces placeholders dynamically
- `argsOverride`: optional full args override
- `extraArgs`: optional additional args appended to built args
- `env`: optional extra env vars
- `sandbox`: optional sandbox configuration
  - `restrictToWorkspace` (boolean): when true, appends standard security rules to system instructions.
- `cliOptions`: optional advanced flags toggle
  - `bypassConfirmations` (default `true`)
  - `disableUpdateCheck` (default `true`, codex)
  - `skipGitRepoCheck` (default `true`, codex)
  - `includeHookEvents` (default `true`, claude)

Returns: `{ agent, label, binary, command, args, cwd, env, prompt }`

### `runCliAgent(options)`

Runs the invocation with `spawn` and returns:

- `ok`, `exitCode`, `signal`
- `stdout`, `stderr`
- `events` (parsed unified events from stream output: `text`, `thinking`, `tool_use`, `tool_result`, `system`, `error`)
- `invocation` (resolved command/args/cwd/env)
- `timedOut` (boolean)

Copilot CLI JSONL lifecycle events are normalized too: `tool.execution_start` is emitted as `tool_use`, and `tool.execution_complete` is emitted as `tool_result`, so consumers can render one tool timeline across Claude Code, Codex, Antigravity, and Copilot.

Parameters:

- All options from `buildCliInvocation(options)`
- `timeoutMs`: optional process timeout limit
- `attachments`: optional array of `{ name, mimeType, base64Data }` image attachments (materialized automatically to disk and cleaned up on close)
- `sandbox`: optional sandbox configuration
  - `restrictToWorkspace` (boolean): actively monitors parsed `tool_use` events. If the agent attempts to read, write, or run commands outside the workspace directory (`cwd`), the subprocess is immediately terminated with `SIGKILL` and the Promise rejects with a `SECURITY_VIOLATION` error.
- Callbacks:
  - `onStdout(line)`
  - `onStderr(line)`
  - `onEvent(event)`

### `detectCliAgents(options?)`

Detects local binary availability and version for all supported CLIs. Returns detailed agent specifications including `subLabel` and `type` fields for UI mapping.

### Advanced Utilities

- `materializeImageAttachments(attachments)`: Saves base64 clipboard attachments as temporary files.
- `buildPromptWithImageFiles(prompt, files)`: Appends image file references and instructions to prompt text.
- `isAttemptingUnauthorizedAccess(toolName, input, workspacePath)`: Validates if tool inputs access paths outside workspace bounds.
- `explicitlyRequestsExternalAccess(userContent, workspacePath)`: Detects if the prompt explicitly requests/authorizes external path access.

## Test

Unit tests (including mock-sandbox verification):

```bash
npm test
```

Real integration tests (actually invoke local agent CLIs):

```bash
npm run test:real
```

Optional environment controls:

- `REAL_AGENT_LIST=codex,claude` to run a subset
- `REAL_AGENT_TIMEOUT_MS=120000` to adjust per-agent timeout
