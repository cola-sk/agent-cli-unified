const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_AGENT = 'claude';

const AGENT_DEFINITIONS = Object.freeze({
  claude: {
    id: 'claude',
    aliases: ['claude-code', 'claude-agent'],
    binary: 'claude',
    label: 'Claude Code CLI',
    versionFlag: '--version',
    buildArgs: ({ prompt }) => [
      '-p', prompt,
      '--print',
      '--output-format=stream-json',
      '--include-hook-events',
      '--dangerously-skip-permissions',
      '--verbose',
    ],
  },
  codex: {
    id: 'codex',
    aliases: ['codex-agent'],
    binary: 'codex',
    label: 'Codex CLI',
    versionFlag: '-c check_for_update_on_startup=false --version',
    buildArgs: ({ prompt, cwd }) => [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c', 'check_for_update_on_startup=false',
      '-C', cwd,
      prompt,
    ],
  },
  gemini: {
    id: 'gemini',
    aliases: ['gemini-agent'],
    binary: 'gemini',
    label: 'Gemini CLI',
    versionFlag: '--version',
    buildArgs: ({ prompt }) => [
      '--output-format', 'stream-json',
      '--yolo',
      '--skip-trust',
      prompt,
    ],
  },
  copilot: {
    id: 'copilot',
    aliases: ['copilot-agent', 'copilot-cli'],
    binary: 'copilot',
    label: 'Copilot CLI',
    versionFlag: '--version',
    buildArgs: ({ prompt }) => [
      '--output-format', 'json',
      '--stream', 'on',
      '-p', prompt,
      '--yolo',
    ],
  },
});

const AGENT_ALIAS_MAP = Object.freeze(
  Object.values(AGENT_DEFINITIONS).reduce((acc, item) => {
    acc[item.id] = item.id;
    for (const alias of item.aliases) acc[alias] = item.id;
    return acc;
  }, {})
);

function normalizeAgent(agent) {
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return DEFAULT_AGENT;
  return AGENT_ALIAS_MAP[key] || DEFAULT_AGENT;
}

function resolveCwd(cwd) {
  if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
  return os.homedir();
}

function findExecutable(binary) {
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

function getExecutableVersion(execPath, versionFlag = '--version') {
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

function defaultEnv(extra = {}) {
  return {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    CI: '1',
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    DISABLE_AUTOUPDATER: '1',
    ...extra,
  };
}

function detectCliAgents(options = {}) {
  const find = options.findExecutable || findExecutable;
  const version = options.getVersion || getExecutableVersion;

  return Object.values(AGENT_DEFINITIONS).map((agent) => {
    const executablePath = find(agent.binary);
    if (!executablePath) {
      return {
        id: agent.id,
        label: agent.label,
        binary: agent.binary,
        available: false,
        executablePath: null,
        version: null,
      };
    }
    return {
      id: agent.id,
      label: agent.label,
      binary: agent.binary,
      available: true,
      executablePath,
      version: version(executablePath, agent.versionFlag) || 'unknown',
    };
  });
}

function buildCliInvocation(options = {}) {
  const prompt = String(options.prompt || '').trim();
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const agentId = normalizeAgent(options.agent);
  const agent = AGENT_DEFINITIONS[agentId];
  const cwd = resolveCwd(options.cwd);

  const commandPath =
    (typeof options.commandPath === 'string' && options.commandPath.trim()) ||
    (options.findExecutable || findExecutable)(agent.binary);

  if (!commandPath) {
    throw new Error(`Executable not found for ${agent.label} (${agent.binary})`);
  }

  const args = Array.isArray(options.argsOverride)
    ? [...options.argsOverride]
    : agent.buildArgs({ prompt, cwd });

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
  };
}

class LineBuffer {
  constructor(onLine) {
    this._buffer = '';
    this._onLine = onLine;
  }

  append(chunk) {
    this._buffer += chunk;
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';
    for (const line of lines) this._onLine(line);
  }

  flush() {
    if (this._buffer) {
      this._onLine(this._buffer);
      this._buffer = '';
    }
  }
}

function parseAgentEvent(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { type: 'text', text: line };
  }

  try {
    const json = JSON.parse(trimmed);

    if (typeof json.type === 'string' && (json.type === 'content' || json.type === 'text')) {
      return { type: 'text', text: json.text || json.value || json.content || '' };
    }

    if (json.type === 'assistant.message_delta') {
      return { type: 'text', text: json?.data?.deltaContent || '' };
    }

    if (json.type === 'assistant.message') {
      return { type: 'text', text: json?.data?.content || '' };
    }

    if (json.type === 'tool_call' || json.type === 'tool_use' || json.type === 'functionCall') {
      return {
        type: 'tool_call',
        name: json.name || json.tool_name || json?.functionCall?.name || '',
        input: json.input || json.args || json.parameters || json?.functionCall?.args || {},
      };
    }

    if (json.type === 'tool_result' || json.type === 'tool' || json.type === 'functionResponse') {
      return {
        type: 'tool_result',
        content: json.output || json.content || json.value || json?.functionResponse?.response || '',
        isError: !!json.is_error || !!json.error || json.status === 'error',
      };
    }

    if (json.type === 'error') {
      return {
        type: 'error',
        text: json.message || json.content || json.value || trimmed,
      };
    }

    return { type: 'json', payload: json };
  } catch (e) {
    return { type: 'text', text: line };
  }
}

function runCliAgent(options = {}) {
  const invocation = buildCliInvocation(options);

  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || 0);
    let timedOut = false;

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines = [];
    const stderrLines = [];
    const events = [];

    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    const onStdout = typeof options.onStdout === 'function' ? options.onStdout : null;
    const onStderr = typeof options.onStderr === 'function' ? options.onStderr : null;

    child.stdin && child.stdin.end();

    let timeoutHandle = null;
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

    const stdoutBuffer = new LineBuffer((line) => {
      stdoutLines.push(line);
      if (onStdout) onStdout(line);
      const event = parseAgentEvent(line);
      if (event) {
        events.push(event);
        if (onEvent) onEvent(event);
      }
    });

    const stderrBuffer = new LineBuffer((line) => {
      stderrLines.push(line);
      if (onStderr) onStderr(line);
      const event = parseAgentEvent(line);
      if (event && event.type === 'error') {
        events.push(event);
        if (onEvent) onEvent(event);
      }
    });

    child.stdout && child.stdout.on('data', (chunk) => stdoutBuffer.append(chunk.toString()));
    child.stderr && child.stderr.on('data', (chunk) => stderrBuffer.append(chunk.toString()));

    child.on('error', (error) => reject(error));

    child.on('close', (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      stdoutBuffer.flush();
      stderrBuffer.flush();

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

module.exports = {
  AGENT_DEFINITIONS,
  normalizeAgent,
  resolveCwd,
  findExecutable,
  getExecutableVersion,
  detectCliAgents,
  buildCliInvocation,
  parseAgentEvent,
  runCliAgent,
};
