import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentDefinition {
  id: string;
  aliases: string[];
  binary: string;
  label: string;
  subLabel: string;
  type: string;
  versionFlag: string;
}

export interface DetectedAgent {
  id: string;
  label: string;
  subLabel: string;
  type: string;
  binary: string;
  available: boolean;
  executablePath: string | null;
  version: string | null;
}

export interface CliOptions {
  bypassConfirmations?: boolean;
  disableUpdateCheck?: boolean;
  skipGitRepoCheck?: boolean;
  includeHookEvents?: boolean;
  verbose?: boolean;
  print?: boolean;
  geminiPromptStyle?: 'flag' | 'positional';
  claudeOutputFormat?: string;
  geminiOutputFormat?: string;
  copilotOutputFormat?: string;
  copilotStreamMode?: string;
  skipTrust?: boolean;
  [key: string]: any;
}

export interface SandboxOptions {
  restrictToWorkspace?: boolean;
}

export interface Attachment {
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface MaterializedAttachment {
  filePath: string;
  mimeType: string;
  name: string;
}

export interface BuildCliInvocationOptions {
  agent?: string;
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  model?: string;
  commandPath?: string;
  argsTemplate?: string[];
  argsOverride?: string[];
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  sandbox?: SandboxOptions;
  cliOptions?: CliOptions;
  findExecutable?: (binary: string) => string | null;
}

export interface CliInvocation {
  agent: string;
  label: string;
  binary: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  prompt: string;
}

export interface RunCliAgentOptions extends BuildCliInvocationOptions {
  timeoutMs?: number;
  attachments?: Attachment[];
  onEvent?: (event: any) => void;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface RunCliAgentResult {
  invocation: CliInvocation;
  exitCode: number | null;
  signal: string | null;
  ok: boolean;
  stdout: string;
  stderr: string;
  events: any[];
  timedOut: boolean;
  timeoutMs: number | null;
}

const DEFAULT_AGENT = 'claude';

const AGENT_DEFINITIONS: Record<string, AgentDefinition> = Object.freeze({
  claude: {
    id: 'claude',
    aliases: ['claude-code', 'claude-agent'],
    binary: 'claude',
    label: 'Claude Code',
    subLabel: 'Anthropic CLI Agent',
    type: 'local',
    versionFlag: '--version',
  },
  codex: {
    id: 'codex',
    aliases: ['codex-agent'],
    binary: 'codex',
    label: 'Codex CLI',
    subLabel: 'OpenAI CLI Agent',
    type: 'local',
    versionFlag: '-c check_for_update_on_startup=false --version',
  },
  gemini: {
    id: 'gemini',
    aliases: ['gemini-agent'],
    binary: 'gemini',
    label: 'Gemini CLI',
    subLabel: 'Google CLI Agent',
    type: 'local',
    versionFlag: '--version',
  },
  copilot: {
    id: 'copilot',
    aliases: ['copilot-agent', 'copilot-cli'],
    binary: 'copilot',
    label: 'Copilot CLI',
    subLabel: 'GitHub CLI Agent',
    type: 'local',
    versionFlag: '--version',
  },
});

const AGENT_ALIAS_MAP: Record<string, string> = Object.freeze(
  Object.values(AGENT_DEFINITIONS).reduce((acc, item) => {
    acc[item.id] = item.id;
    for (const alias of item.aliases) acc[alias] = item.id;
    return acc;
  }, {} as Record<string, string>)
);

function normalizeAgent(agent?: string): string {
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return DEFAULT_AGENT;
  return AGENT_ALIAS_MAP[key] || DEFAULT_AGENT;
}

function resolveCwd(cwd?: string): string {
  if (typeof cwd === 'string' && cwd.trim()) {
    const trimmed = cwd.trim();
    if (trimmed.startsWith('~')) {
      return path.join(os.homedir(), trimmed.slice(1));
    }
    return path.resolve(trimmed);
  }
  return os.homedir();
}

function buildCliPath(): string {
  const existing = process.env.PATH || '';
  const home = os.homedir();
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    home ? `${home}/.local/bin` : '',
  ].filter(Boolean);
  return [...new Set([...existing.split(':'), ...extras].filter(Boolean))].join(':');
}

function findExecutable(binary: string): string | null {
  try {
    const located = execSync(`which ${binary}`, { encoding: 'utf8', stdio: [] }).trim();
    if (located && fs.existsSync(located)) return located;
  } catch (e) {
    // ignore
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, `.local/bin/${binary}`),
    path.join(home, `.npm-global/bin/${binary}`),
    `/usr/local/bin/${binary}`,
    `/opt/homebrew/bin/${binary}`,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getExecutableVersion(execPath: string, versionFlag = '--version'): string | null {
  try {
    const out = execSync(`"${execPath}" ${versionFlag}`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: [],
      env: {
        ...process.env,
        DISABLE_AUTOUPDATER: '1',
      },
    }).trim();
    const match = out.match(/[0-9]+\.[0-9]+\.?[0-9]*/);
    return match ? match[0] : out.split('\n')[0].trim();
  } catch (e) {
    return null;
  }
}

function defaultEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: buildCliPath(),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    CI: '1',
    COLUMNS: '10000',
    LINES: '10000',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    DISABLE_AUTOUPDATER: '1',
    ...extra,
  };
}

function buildAgentArgs(agentId: string, payload: {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  cliOptions?: CliOptions;
}): string[] {
  const {
    prompt,
    cwd,
    systemPrompt,
    model,
    cliOptions = {},
  } = payload;

  const opts = {
    bypassConfirmations: cliOptions.bypassConfirmations !== false,
    disableUpdateCheck: cliOptions.disableUpdateCheck !== false,
    skipGitRepoCheck: cliOptions.skipGitRepoCheck !== false,
    includeHookEvents: cliOptions.includeHookEvents !== false,
    verbose: cliOptions.verbose !== false,
    print: cliOptions.print !== false,
    geminiPromptStyle: cliOptions.geminiPromptStyle || 'flag',
    ...cliOptions,
  };

  if (agentId === 'claude') {
    const args = ['-p', prompt];
    if (opts.print) args.push('--print');
    args.push(`--output-format=${opts.claudeOutputFormat || 'stream-json'}`);
    if (opts.includeHookEvents) args.push('--include-hook-events');
    if (opts.bypassConfirmations) args.push('--dangerously-skip-permissions');
    if (opts.verbose) args.push('--verbose');
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    if (model) args.push('--model', model);
    return args;
  }

  if (agentId === 'codex') {
    const effectivePrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['exec', '--json'];
    if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check');
    if (opts.bypassConfirmations) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (opts.disableUpdateCheck) args.push('-c', 'check_for_update_on_startup=false');
    args.push('-C', cwd);
    if (model) args.push('--model', model);
    args.push(effectivePrompt);
    return args;
  }

  if (agentId === 'gemini') {
    const effectivePrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['--output-format', opts.geminiOutputFormat || 'stream-json'];
    if (opts.bypassConfirmations) args.push('--yolo');
    if (opts.skipTrust !== false) args.push('--skip-trust');
    if (model) args.push('--model', model);
    if (opts.geminiPromptStyle === 'positional') args.push(effectivePrompt);
    else args.push('-p', effectivePrompt);
    return args;
  }

  if (agentId === 'copilot') {
    const effectivePrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = [
      '--output-format', opts.copilotOutputFormat || 'json',
      '--stream', opts.copilotStreamMode || 'on',
    ];
    if (opts.bypassConfirmations) args.push('--yolo');
    if (model) args.push('--model', model);
    args.push('-p', effectivePrompt);
    return args;
  }

  return [prompt];
}

function detectCliAgents(options: {
  findExecutable?: (binary: string) => string | null;
  getVersion?: (execPath: string, versionFlag?: string) => string | null;
} = {}): DetectedAgent[] {
  const find = options.findExecutable || findExecutable;
  const version = options.getVersion || getExecutableVersion;

  return Object.values(AGENT_DEFINITIONS).map((agent) => {
    const executablePath = find(agent.binary);
    if (!executablePath) {
      return {
        id: agent.id,
        label: agent.label,
        subLabel: agent.subLabel,
        type: agent.type,
        binary: agent.binary,
        available: false,
        executablePath: null,
        version: null,
      };
    }
    return {
      id: agent.id,
      label: agent.label,
      subLabel: agent.subLabel,
      type: agent.type,
      binary: agent.binary,
      available: true,
      executablePath,
      version: version(executablePath, agent.versionFlag) || 'unknown',
    };
  });
}

function explicitlyRequestsExternalAccess(userContent: string, workspacePath?: string | null): boolean {
  if (!workspacePath) return false;
  
  // Find all absolute paths in userContent
  const absPathRegex = /(?:\s|^)(\/[a-zA-Z0-9_\.\-]+(?:\/[a-zA-Z0-9_\.\-]+)*)/g;
  let match;
  while ((match = absPathRegex.exec(userContent)) !== null) {
    const matchedPath = match[1];
    const relative = path.relative(workspacePath, matchedPath);
    const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!isInside) {
      return true; 
    }
  }
  
  const keywords = [
    'other directory', 'external directory', 'outside of', 'cross-directory', 
    'system directory', 'home directory', 'slash', 'root folder',
    '其它目录', '外部目录', '工作区之外', '跨目录', '系统目录', '家目录', '根目录'
  ];
  const lowercaseContent = userContent.toLowerCase();
  return keywords.some(kw => lowercaseContent.includes(kw));
}

function isAttemptingUnauthorizedAccess(toolName: string, input: Record<string, any>, workspacePath: string): boolean {
  if (!toolName || !input) return false;
  
  // 1. Validate file path parameters
  const filePathKeys = ['file_path', 'path', 'filepath', 'file', 'target', 'dest', 'source', 'src'];
  for (const key of filePathKeys) {
    const val = input[key];
    if (typeof val === 'string' && val.trim()) {
      const resolved = path.isAbsolute(val) ? path.resolve(val) : path.resolve(workspacePath, val);
      const relative = path.relative(workspacePath, resolved);
      const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);
      if (!isInside && resolved !== workspacePath) {
        return true; 
      }
    }
  }
  
  // 2. Validate bash/command execution parameters
  const cmdKeys = ['command', 'cmd', 'script', 'args'];
  for (const key of cmdKeys) {
    const val = input[key];
    const checkStr = Array.isArray(val) ? val.join(' ') : (typeof val === 'string' ? val : '');
    if (checkStr.trim()) {
      const absPathRegex = /(?:\s|^)(\/[a-zA-Z0-9_\.\-]+(?:\/[a-zA-Z0-9_\.\-]+)*)/g;
      let match;
      while ((match = absPathRegex.exec(checkStr)) !== null) {
        const matchedPath = match[1];
        const relative = path.relative(workspacePath, matchedPath);
        const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);
        if (!isInside && matchedPath !== workspacePath) {
          return true; 
        }
      }
    }
  }
  
  return false;
}

function buildCliInvocation(options: BuildCliInvocationOptions = {} as BuildCliInvocationOptions): CliInvocation {
  let prompt = String(options.prompt || '').trim();
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const agentId = normalizeAgent(options.agent);
  const agent = AGENT_DEFINITIONS[agentId];
  const cwd = resolveCwd(options.cwd);

  const sandbox = options.sandbox || {};
  if (sandbox.restrictToWorkspace) {
    const workspacePath = path.resolve(cwd);
    if (!prompt.includes('[SECURITY POLICY - WORKSPACE LOCK]')) {
      prompt = `${prompt}\n\n` +
        `[SECURITY POLICY - WORKSPACE LOCK]\n` +
        `- You are strictly restricted to operate ONLY within the active workspace directory: "${workspacePath}".\n` +
        `- Do NOT read, write, create, or execute any commands in directories outside of "${workspacePath}".\n` +
        `- All file operations (read, write, list) and shell commands must be relative to or inside "${workspacePath}".\n` +
        `- Unless explicitly requested in your prompt to access a specific external path, you must not access any default home sandbox (~/.codex or ~/.cortex) or system directories.\n` +
        `- If you need to write temporary files, create a temporary folder INSIDE "${workspacePath}".\n` +
        `- If you cannot fulfill the request within "${workspacePath}", explain this limitation to the user.`;
    }
  }

  const commandPath =
    (typeof options.commandPath === 'string' && options.commandPath.trim()) ||
    (options.findExecutable || findExecutable)(agent.binary);

  if (!commandPath) {
    throw new Error(`Executable not found for ${agent.label} (${agent.binary})`);
  }

  let args;
  const systemPrompt = options.systemPrompt || '';

  if (Array.isArray(options.argsTemplate)) {
    const hasSystemPlaceholder = options.argsTemplate.some((a) => a.includes('{{SYSTEM}}'));
    const hasPromptPlaceholder = options.argsTemplate.some((a) => a.includes('{{PROMPT}}'));
    
    const effectivePrompt = hasSystemPlaceholder || !systemPrompt
      ? prompt
      : `${systemPrompt}\n\n${prompt}`;
      
    args = options.argsTemplate.map((a) =>
      a.replace('{{SYSTEM}}', systemPrompt)
       .replace('{{PROMPT}}', effectivePrompt)
       .replace('{{MODEL}}', options.model || '')
    );
    
    if (!hasPromptPlaceholder) {
      if (agentId === 'claude') {
        if (options.model) args.push('--model', options.model);
        args.push('-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions');
        if (systemPrompt) args.push('--system-prompt', systemPrompt);
      } else if (agentId === 'gemini') {
        if (options.model) args.push('--model', options.model);
        args.push('--skip-trust', '-p', effectivePrompt, '--output-format', 'stream-json', '--yolo');
      } else if (agentId === 'copilot') {
        if (options.model) args.push('--model', options.model);
        args.push('-p', effectivePrompt, '--yolo');
      } else if (agentId === 'codex') {
        args.push('-C', cwd);
        args.push('exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');
        if (options.model) args.push('--model', options.model);
        args.push(effectivePrompt);
      } else {
        args.push(effectivePrompt);
      }
    }
  } else if (Array.isArray(options.argsOverride)) {
    args = [...options.argsOverride];
  } else {
    args = buildAgentArgs(agent.id, {
      prompt,
      cwd,
      systemPrompt: options.systemPrompt,
      model: options.model,
      cliOptions: options.cliOptions,
    });
  }

  if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
    args.push(...options.extraArgs);
  }

  return {
    agent: agent.id,
    label: agent.label,
    binary: agent.binary,
    command: commandPath,
    args,
    cwd,
    env: defaultEnv(options.env),
    prompt,
  };
}

class LineBuffer {
  private _buffer: string;
  private _onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this._buffer = '';
    this._onLine = onLine;
  }

  append(chunk: string): void {
    this._buffer += chunk;
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';
    for (const line of lines) this._onLine(line);
  }

  flush(): void {
    if (this._buffer) {
      this._onLine(this._buffer);
      this._buffer = '';
    }
  }
}

function parseAgentEvent(line: string): any {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { type: 'text', text: line };
  }

  try {
    const json = JSON.parse(trimmed);
    const eventType = typeof json.type === 'string' ? json.type : '';

    // 1. Claude Code CLI nested events
    if (eventType === 'assistant' && json.message && Array.isArray(json.message.content)) {
      const out = [];
      for (const block of json.message.content) {
        if (block.type === 'text' && block.text) {
          out.push({ type: 'text', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          out.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            name: block.name || '',
            input: block.input || {},
            toolUseId: block.id || '',
          });
        }
      }
      return out.length > 0 ? out : null;
    }

    // 1b. Nested Gemini/standard message content events (unpacks tool calls and text)
    if (eventType === 'message' && (json.role === 'assistant' || json.role === 'model') && Array.isArray(json.content)) {
      const out = [];
      for (const block of json.content) {
        if ((block.type === 'text' || block.type === 'content') && (block.text || block.content)) {
          out.push({ type: 'text', text: block.text || block.content });
        } else if (block.type === 'thinking' && block.thinking) {
          out.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'functionCall') {
          out.push({
            type: 'tool_use',
            name: block.name || block.function || '',
            input: block.input || block.args || {},
            toolUseId: block.id || '',
          });
        }
      }
      return out.length > 0 ? out : null;
    }

    // 1c. Flat Gemini/standard message content events
    if (eventType === 'message' && (json.role === 'assistant' || json.role === 'model') && typeof json.content === 'string') {
      return { type: 'text', text: json.content };
    }

    // 1d. Standard result/final event
    if (eventType === 'result') {
      const resText = json.result || json.content || json.value || '';
      if (resText && typeof resText === 'string') {
        return { type: 'text', text: resText };
      }
    }

    if (eventType === 'user' && json.message && Array.isArray(json.message.content)) {
      const out = [];
      for (const block of json.message.content) {
        if (block.type === 'tool_result') {
          out.push({
            type: 'tool_result',
            content: block.content || '',
            toolUseId: block.id || '',
            isError: !!block.is_error,
          });
        }
      }
      return out.length > 0 ? out : null;
    }

    // 2. Codex item started/completed events
    if ((eventType === 'item.started' || eventType === 'item.completed') && json.item && typeof json.item === 'object') {
      const item = json.item;
      const itemType = String(item.type || '');
      const itemId = String(item.id || '');

      if (eventType === 'item.completed' && itemType === 'agent_message') {
        const text =
          (typeof item.text === 'string' && item.text) ||
          (typeof item.content === 'string' && item.content) ||
          (typeof item.message === 'string' && item.message) ||
          '';

        if (text) {
          return { type: 'text', text };
        }
      }

      if (eventType === 'item.started') {
        const input: Record<string, any> = {};
        if (typeof item.command === 'string') {
          const cmd = item.command.trim().replace(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+/, '').replace(/^['"]|['"]$/g, '');
          input.command = cmd;
        }
        if (item.status != null) input.status = item.status;
        
        return {
          type: 'tool_use',
          name: itemType || 'codex_item',
          input,
          toolUseId: itemId || undefined,
        };
      } else { // item.completed
        const status = String(item.status || '');
        const exitCode = item.exit_code;
        const text =
          (typeof item.aggregated_output === 'string' && item.aggregated_output) ||
          (typeof item.output === 'string' && item.output) ||
          (typeof item.text === 'string' && item.text) ||
          JSON.stringify(item, null, 2);

        return {
          type: 'tool_result',
          content: text,
          toolUseId: itemId || undefined,
          isError: (typeof exitCode === 'number' && exitCode !== 0) || (status === 'failed'),
        };
      }
    }

    // 3. Gemini / standard stream JSON events
    if (eventType === 'content' || eventType === 'text') {
      return { type: 'text', text: json.text || json.value || json.content || '' };
    }

    if (eventType === 'assistant.message_delta') {
      return {
        type: 'text',
        text: json?.data?.deltaContent || '',
        messageId: json?.data?.messageId || '',
        isDelta: true,
      };
    }

    if (eventType === 'assistant.message') {
      return {
        type: 'text',
        text: json?.data?.content || '',
        messageId: json?.data?.messageId || '',
        isFinal: true,
      };
    }

    if (eventType === 'tool_use' || eventType === 'tool_call' || eventType === 'functionCall') {
      return {
        type: 'tool_use',
        name: json.name || json.tool_name || json?.functionCall?.name || '',
        input: json.input || json.args || json.parameters || json?.functionCall?.args || {},
        toolUseId: json.tool_id || json.id || json?.functionCall?.id || '',
      };
    }

    if (eventType === 'tool_result' || eventType === 'tool' || eventType === 'functionResponse') {
      const content = json.output || json.content || json.value || json?.functionResponse?.response || '';
      return {
        type: 'tool_result',
        content: Array.isArray(content) ? content.map(c => c.text || '').join('') : (typeof content === 'object' ? JSON.stringify(content) : content),
        isError: !!json.is_error || !!json.error || json.status === 'error',
        toolUseId: json.tool_use_id || json.tool_id || json.id || '',
      };
    }

    if (eventType === 'error') {
      return {
        type: 'error',
        text: json.message || json.content || json.value || trimmed,
      };
    }

    if (eventType === 'system') {
      if (json.subtype === 'init') {
        return { type: 'system', text: `⚙️ [Init] Local workspace: ${json.cwd || "default"}\n` };
      }
      if (json.subtype === 'hook_started') {
        return { type: 'system', text: `⏱️ [Hook Start] ${json.hook_name || ""}\n` };
      }
      if (json.subtype === 'hook_response') {
        return { type: 'system', text: `✅ [Hook Done] ${json.hook_name || ""}\n` };
      }
    }

    return { type: 'json', payload: json };
  } catch (e) {
    return { type: 'text', text: line };
  }
}

function extensionFromMimeType(mimeType = ''): string {
  const normalized = String(mimeType).toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/bmp') return '.bmp';
  if (normalized === 'image/svg+xml') return '.svg';
  return '.img';
}

function sanitizeAttachmentName(name = ''): string {
  const safe = String(name)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return safe || 'clipboard-image';
}

function materializeImageAttachments(attachments?: Attachment[]): {
  dirPath: string | null;
  files: MaterializedAttachment[];
} {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { dirPath: null, files: [] };
  }

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-attachments-'));
  const files: MaterializedAttachment[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att) continue;
    const base64Data = typeof att.base64Data === 'string' ? att.base64Data.trim() : '';
    if (!base64Data) continue;

    try {
      const ext = extensionFromMimeType(att.mimeType || '');
      const safeName = sanitizeAttachmentName(att.name || `clipboard-image-${i + 1}`);
      const filePath = path.join(sessionDir, `${safeName}-${Date.now()}-${i + 1}${ext}`);
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      files.push({
        filePath,
        mimeType: att.mimeType || 'image/*',
        name: att.name || `clipboard-image-${i + 1}`
      });
    } catch (e) {
      // ignore
    }
  }

  if (files.length === 0) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (e) {}
    return { dirPath: null, files: [] };
  }

  return { dirPath: sessionDir, files };
}

function buildPromptWithImageFiles(prompt: string, files: Array<{ filePath: string; mimeType: string }>): string {
  if (!Array.isArray(files) || files.length === 0) return prompt;

  const lines = files.map((f, idx) => `${idx + 1}. ${f.filePath} (${f.mimeType})`);
  return `${prompt}

[Attached Clipboard Images]
The user attached ${files.length} image(s). The bridge has saved them as local files:
${lines.join('\n')}

Please inspect these image files directly and include them in your answer.`;
}

function runCliAgent(options: RunCliAgentOptions = {} as RunCliAgentOptions): Promise<RunCliAgentResult> {
  let finalOptions = { ...options };
  let materialized = null;

  if (Array.isArray(options.attachments) && options.attachments.length > 0) {
    materialized = materializeImageAttachments(options.attachments);
    if (materialized.files.length > 0) {
      finalOptions.prompt = buildPromptWithImageFiles(options.prompt, materialized.files);
    }
  }

  const invocation = buildCliInvocation(finalOptions);

  const sandbox = options.sandbox || {};
  const restrictToWorkspace = !!sandbox.restrictToWorkspace;
  const workspacePath = restrictToWorkspace ? path.resolve(invocation.cwd) : null;

  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || 0);
    let timedOut = false;
    let childError: (Error & { code?: string }) | null = null;

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const events: any[] = [];

    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    const onStdout = typeof options.onStdout === 'function' ? options.onStdout : null;
    const onStderr = typeof options.onStderr === 'function' ? options.onStderr : null;

    child.stdin && child.stdin.end();

    let timeoutHandle: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (e) {
          // ignore
        }
      }, timeoutMs);
    }

    const cleanUpTemp = () => {
      if (materialized && materialized.dirPath) {
        try {
          fs.rmSync(materialized.dirPath, { recursive: true, force: true });
        } catch (e) {
          // ignore
        }
      }
    };

    const deltaMessageIds = new Set<string>();

    const handleLine = (line: string) => {
      const parsed = parseAgentEvent(line);
      if (parsed) {
        const parsedEvents = Array.isArray(parsed) ? parsed : [parsed];
        for (const event of parsedEvents) {
          if (event.type === 'text' && event.messageId && event.isDelta) {
            deltaMessageIds.add(event.messageId);
          }
          if (event.type === 'text' && event.messageId && event.isFinal && deltaMessageIds.has(event.messageId)) {
            continue;
          }
          if (event.type === 'tool_use' && restrictToWorkspace && workspacePath) {
            if (!explicitlyRequestsExternalAccess(finalOptions.prompt || '', workspacePath)) {
              if (isAttemptingUnauthorizedAccess(event.name, event.input, workspacePath)) {
                child.kill('SIGKILL');
                timedOut = false;
                const securityErr = new Error(`[SECURITY VIOLATION] Agent attempted to access unauthorized path outside the workspace: ${JSON.stringify(event.input)}. Process killed.`) as Error & { code?: string };
                securityErr.code = 'SECURITY_VIOLATION';
                childError = securityErr;
                return;
              }
            }
          }
          events.push(event);
          if (onEvent) onEvent(event);
        }
      }
    };

    const stdoutBuffer = new LineBuffer((line) => {
      stdoutLines.push(line);
      if (onStdout) onStdout(line);
      handleLine(line);
    });

    const stderrBuffer = new LineBuffer((line) => {
      stderrLines.push(line);
      if (onStderr) onStderr(line);
      const parsed = parseAgentEvent(line);
      if (parsed) {
        const parsedEvents = Array.isArray(parsed) ? parsed : [parsed];
        for (const event of parsedEvents) {
          if (event.type === 'error') {
            events.push(event);
            if (onEvent) onEvent(event);
          }
        }
      }
    });

    child.stdout && child.stdout.on('data', (chunk) => stdoutBuffer.append(chunk.toString()));
    child.stderr && child.stderr.on('data', (chunk) => stderrBuffer.append(chunk.toString()));

    child.on('error', (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      cleanUpTemp();
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      stdoutBuffer.flush();
      stderrBuffer.flush();
      cleanUpTemp();

      if (childError) {
        reject(childError);
        return;
      }

      resolve({
        invocation,
        exitCode: code,
        signal,
        ok: code === 0,
        stdout: stdoutLines.join('\n').trim(),
        stderr: stderrLines.join('\n').trim(),
        events,
        timedOut,
        timeoutMs: timeoutMs > 0 ? timeoutMs : null,
      });
    });
  });
}

export {
  AGENT_DEFINITIONS,
  normalizeAgent,
  resolveCwd,
  findExecutable,
  getExecutableVersion,
  detectCliAgents,
  buildCliInvocation,
  buildAgentArgs,
  parseAgentEvent,
  runCliAgent,
  materializeImageAttachments,
  buildPromptWithImageFiles,
  isAttemptingUnauthorizedAccess,
  explicitlyRequestsExternalAccess,
};
