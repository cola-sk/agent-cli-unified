# agent-cli-unified

一个可复用的 Node.js 模块，为以下本地 CLI 代理提供标准化的命令构建、执行和流式事件解析能力：
- Codex CLI
- Claude Code CLI
- Gemini CLI
- Copilot CLI

## 安装

```bash
npm i @sking7/agent-cli-unified
```

## 快速上手

```js
const { buildCliInvocation, runCliAgent, detectCliAgents } = require('@sking7/agent-cli-unified');

// 1. 检测本地可用的 CLI Agent 及其版本
const available = detectCliAgents();
console.log(available);

// 2. 构建基础调用命令与参数
const invocation = buildCliInvocation({
  agent: 'codex',
  prompt: 'fix lint errors',
  cwd: '/path/to/repo',
});

console.log(invocation.command, invocation.args.join(' '));

// 3. 运行本地 Agent，监听实时流式事件并开启安全沙箱
const result = await runCliAgent({
  agent: 'gemini',
  prompt: 'summarize repository status',
  cwd: '/path/to/repo',
  sandbox: {
    restrictToWorkspace: true, // 工作区锁定：如果检测到 Agent 尝试跨目录操作，自动 SIGKILL 熔断
  },
  onEvent: (event) => {
    if (event.type === 'tool_use') {
      console.log('工具调用:', event.name, event.input);
    } else if (event.type === 'text') {
      process.stdout.write(event.text);
    }
  },
});

console.log(result.ok, result.exitCode);
```

## API 说明

### `buildCliInvocation(options)`

构建确定性的 CLI 命令调用配置。

- `agent`: `codex | claude | gemini | copilot`（支持别名映射）
- `prompt`: 必填字符串
- `cwd`: 可选，工作目录；默认使用用户 Home 目录
- `systemPrompt`: 可选，系统提示词；若 CLI 支持则直接注入对应参数，否则拼装进 Prompt 中
- `model`: 可选，模型名称；对于支持的 CLI 映射为 `--model`
- `commandPath`: 可选，显式指定的可执行文件路径
- `argsTemplate`: 可选，自定义参数模板数组（如 `['--sys', '{{SYSTEM}}', '--run', '{{PROMPT}}']`），会自动替换对应的模板占位符
- `argsOverride`: 可选，完全覆盖底层 args 参数数组
- `extraArgs`: 可选，追加的额外参数数组
- `env`: 可选，追加的额外环境变量键值对
- `sandbox`: 可选，沙箱策略配置
  - `restrictToWorkspace` (boolean): 为 `true` 时，会在系统提示词中追加严格的工作目录锁定规则。
- `cliOptions`: 可选，高级 CLI 运行标志开关
  - `bypassConfirmations` (默认 `true`)
  - `disableUpdateCheck` (默认 `true`, codex)
  - `skipGitRepoCheck` (默认 `true`, codex)
  - `includeHookEvents` (默认 `true`, claude)
  - `geminiPromptStyle` (`flag` 默认使用 -p，或 `positional` 位置参数)

返回对象: `{ agent, label, binary, command, args, cwd, env, prompt }`

### `runCliAgent(options)`

使用 `spawn` 调起并执行本地 CLI，返回 Promise：

- `ok`, `exitCode`, `signal`
- `stdout`, `stderr`
- `events`（从标准输出流中解析统一后的事件数组：`text`、`thinking`、`tool_use`、`tool_result`、`system`、`error`）
- `invocation`（解析后的命令、参数、工作区和环境变量）
- `timedOut` (boolean)

Copilot CLI 的 JSONL 生命周期事件也会被统一：`tool.execution_start` 会转换为 `tool_use`，`tool.execution_complete` 会转换为 `tool_result`，因此上层应用可以用同一套工具时间线渲染 Claude Code、Codex、Gemini 和 Copilot。

参数配置:

- 支持 `buildCliInvocation(options)` 的所有参数
- `timeoutMs`: 可选，超时毫秒数
- `attachments`: 可选，图片附件数组 `{ name, mimeType, base64Data }`。会自动写入临时目录，测试结束后自动清除。
- `sandbox`: 可选，沙箱策略配置
  - `restrictToWorkspace` (boolean): 为 `true` 时，会实时监控标准输出流中的 `tool_use` 工具事件。如果检测到 Agent 试图读写或在工作目录（`cwd`）外部执行指令，且用户没有显式授权，子进程将被立刻执行 `SIGKILL` 终止，Promise 将被拒绝并抛出 `SECURITY_VIOLATION` 错误。
- 回调函数:
  - `onStdout(line)`
  - `onStderr(line)`
  - `onEvent(event)`

### `detectCliAgents(options?)`

检测本地环境中各个 CLI 代理的可用性、路径及版本。返回的对象结构中额外包含 `subLabel` 和 `type` 字段，方便前端 UI 绑定渲染。

### 高级辅助工具函数

统一库还导出了以下核心实用函数：

- `materializeImageAttachments(attachments)`: 将剪贴板 base64 格式的图片文件写入临时文件夹。
- `buildPromptWithImageFiles(prompt, files)`: 扩展 Prompt 内容，加入临时图片路径引导。
- `isAttemptingUnauthorizedAccess(toolName, input, workspacePath)`: 物理校验工具入参中是否含有工作区外部路径。
- `explicitlyRequestsExternalAccess(userContent, workspacePath)`: 智能语义分析 Prompt 文本，判断用户是否主动授权了越权访问行为。

## 测试

运行单元测试（包含 Mock 沙箱主动熔断测试）：

```bash
npm test
```

运行真实 Agent CLI 集成测试（会在本地真实拉起 CLI 执行指令）：

```bash
npm run test:real
```

控制集成测试的环境变量参数：

- `REAL_AGENT_LIST=codex,claude` 测试特定 CLI
- `REAL_AGENT_TIMEOUT_MS=120000` 修改单个 CLI 测试超时限制
