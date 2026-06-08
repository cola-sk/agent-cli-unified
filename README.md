# agent-cli-unified

A reusable Node.js package that standardizes command construction and execution for:
- Codex CLI
- Claude Code CLI
- Gemini CLI
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

const invocation = buildCliInvocation({
  agent: 'codex',
  prompt: 'fix lint errors',
  cwd: '/path/to/repo',
});

console.log(invocation.command, invocation.args.join(' '));

const result = await runCliAgent({
  agent: 'gemini',
  prompt: 'summarize repository status',
  cwd: '/path/to/repo',
  onEvent: (event) => {
    if (event.type === 'tool_call') {
      console.log('TOOL', event.name, event.input);
    }
  },
});

console.log(result.ok, result.exitCode);
console.log(result.stdout);
```

## API

### `buildCliInvocation(options)`

Build a deterministic command invocation.

- `agent`: `codex | claude | gemini | copilot` (aliases supported)
- `prompt`: required string
- `cwd`: optional; defaults to user home
- `systemPrompt`: optional; injected when CLI supports it, otherwise folded into prompt
- `model`: optional; mapped to `--model` for supported CLIs
- `commandPath`: optional explicit executable path
- `argsOverride`: optional full args override
- `extraArgs`: optional additional args appended to built args
- `env`: optional extra env vars
- `cliOptions`: optional advanced flags toggle
  - `bypassConfirmations` (default `true`)
  - `disableUpdateCheck` (default `true`, codex)
  - `skipGitRepoCheck` (default `true`, codex)
  - `includeHookEvents` (default `true`, claude)
  - `geminiPromptStyle` (`flag` default, or `positional`)

### `runCliAgent(options)`

Runs the invocation with `spawn` and returns:

- `ok`, `exitCode`, `signal`
- `stdout`, `stderr`
- `events` (best-effort parsed events from stream output)
- `invocation` (resolved command/args/cwd/env)

Callbacks:

- `onStdout(line)`
- `onStderr(line)`
- `onEvent(event)`

### `detectCliAgents(options?)`

Detects local binary availability and version for all supported CLIs.

## Test

Unit tests (no real agent invocation):

```bash
npm test
```

Real integration tests (actually invoke codex/claude/gemini/copilot CLIs):

```bash
npm run test:real
```

Optional environment controls:

- `REAL_AGENT_LIST=codex,claude` to run a subset
- `REAL_AGENT_TIMEOUT_MS=180000` to increase per-agent timeout

Example:

```bash
REAL_AGENT_LIST=codex,claude REAL_AGENT_TIMEOUT_MS=180000 npm run test:real
```

## Publish To npm

### 1. Update package scope

In `package.json`, set `name` to match your GitHub user/org scope, e.g.:

```json
"name": "@my-org/agent-cli-unified"
```

### 2. Configure npm auth token (local)

Create `.npmrc` (do not commit token):

```ini
@my-org:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx_plaintext_token
always-auth=true
```

Token must have package publish permissions.

### 3. Login check and dry run

```bash
npm whoami --registry=https://npm.pkg.github.com
npm pack
```

### 4. Publish

```bash
npm publish
```

Because `publishConfig.registry` is set to GitHub npm registry, this publishes to GitHub Packages.

### 5. Install from GitHub Packages

In consumer project `.npmrc`:

```ini
@my-org:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx_plaintext_token
always-auth=true
```

Then:

```bash
npm i @my-org/agent-cli-unified
```

## GitHub Actions Auto Publish

A workflow is included at `.github/workflows/publish-gpr.yml`.

It publishes when you push a tag like `v0.1.0`.

```bash
git tag v0.1.0
git push origin v0.1.0
```
