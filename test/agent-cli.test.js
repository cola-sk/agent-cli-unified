const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAgent,
  resolveCwd,
  detectCliAgents,
  buildCliInvocation,
  parseAgentEvent,
  runCliAgent,
  materializeImageAttachments,
  buildPromptWithImageFiles,
  isAttemptingUnauthorizedAccess,
  explicitlyRequestsExternalAccess,
} = require('../src/index');
const fs = require('fs');

test('normalizeAgent resolves aliases and defaults', () => {
  assert.equal(normalizeAgent('codex-agent'), 'codex');
  assert.equal(normalizeAgent('claude-code'), 'claude');
  assert.equal(normalizeAgent('gemini-agent'), 'gemini');
  assert.equal(normalizeAgent('copilot-cli'), 'copilot');
  assert.equal(normalizeAgent('unknown'), 'claude');
});

test('resolveCwd returns home for empty input', () => {
  const home = require('os').homedir();
  assert.equal(resolveCwd(''), home);
  assert.equal(resolveCwd('   '), home);
  assert.equal(resolveCwd('/tmp/repo'), '/tmp/repo');
});

test('buildCliInvocation builds codex command', () => {
  const invocation = buildCliInvocation({
    agent: 'codex',
    prompt: 'fix tests',
    cwd: '/tmp/repo',
    commandPath: '/usr/local/bin/codex',
  });

  assert.equal(invocation.command, '/usr/local/bin/codex');
  assert.deepEqual(invocation.args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c', 'check_for_update_on_startup=false',
    '-C', '/tmp/repo',
    'fix tests',
  ]);
});

test('buildCliInvocation builds copilot command', () => {
  const invocation = buildCliInvocation({
    agent: 'copilot',
    prompt: 'refactor module',
    commandPath: '/usr/local/bin/copilot',
  });

  assert.deepEqual(invocation.args, [
    '--output-format', 'json',
    '--stream', 'on',
    '--yolo',
    '-p', 'refactor module',
  ]);
});

test('buildCliInvocation supports model/system prompt and cliOptions toggles', () => {
  const claude = buildCliInvocation({
    agent: 'claude',
    prompt: 'say hi',
    systemPrompt: 'You are strict',
    model: 'claude-sonnet-4-5',
    commandPath: '/usr/local/bin/claude',
  });
  assert.ok(claude.args.includes('--system-prompt'));
  assert.ok(claude.args.includes('You are strict'));
  assert.ok(claude.args.includes('--model'));
  assert.ok(claude.args.includes('claude-sonnet-4-5'));

  const codex = buildCliInvocation({
    agent: 'codex',
    prompt: 'fix lint',
    commandPath: '/usr/local/bin/codex',
    cliOptions: {
      bypassConfirmations: false,
      disableUpdateCheck: false,
      skipGitRepoCheck: false,
    },
  });
  assert.equal(codex.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(codex.args.includes('--skip-git-repo-check'), false);
  assert.equal(codex.args.includes('-c'), false);

  const gemini = buildCliInvocation({
    agent: 'gemini',
    prompt: 'hello',
    commandPath: '/usr/local/bin/gemini',
  });
  // default aligns with cortex style: use -p prompt flag
  assert.ok(gemini.args.includes('-p'));
});

test('detectCliAgents supports injected discovery hooks', () => {
  const binaries = {
    claude: '/bin/claude',
    codex: '/bin/codex',
    gemini: '/bin/gemini',
    copilot: '/bin/copilot',
  };

  const list = detectCliAgents({
    findExecutable: (name) => binaries[name] || null,
    getVersion: () => '1.2.3',
  });

  assert.equal(list.length, 4);
  assert.ok(list.every((x) => x.available));
  assert.ok(list.every((x) => x.version === '1.2.3'));
});

test('parseAgentEvent parses text and tool payloads', () => {
  const textEvent = parseAgentEvent('{"type":"content","text":"hello"}');
  assert.equal(textEvent.type, 'text');
  assert.equal(textEvent.text, 'hello');

  const toolEvent = parseAgentEvent('{"type":"tool_call","name":"read_file","input":{"path":"a"}}');
  assert.equal(toolEvent.type, 'tool_use');
  assert.equal(toolEvent.name, 'read_file');
  assert.deepEqual(toolEvent.input, { path: 'a' });
});

test('runCliAgent executes a command and emits events', async () => {
  const cmd = process.execPath;
  const result = await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: cmd,
    argsOverride: [
      '-e',
      'console.log(JSON.stringify({type:"content",text:"ok"})); console.error("warn");',
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('"ok"'));
  assert.ok(result.stderr.includes('warn'));
  assert.ok(result.events.some((e) => e.type === 'text' && e.text === 'ok'));
});

test('buildCliInvocation supports argsTemplate with placeholders', () => {
  const invocation = buildCliInvocation({
    agent: 'claude',
    prompt: 'say hello',
    systemPrompt: 'Keep it short',
    model: 'claude-3-opus',
    commandPath: '/bin/claude',
    argsTemplate: ['--sys', '{{SYSTEM}}', '--run', '{{PROMPT}}', '--m', '{{MODEL}}']
  });

  assert.deepEqual(invocation.args, [
    '--sys', 'Keep it short',
    '--run', 'say hello',
    '--m', 'claude-3-opus'
  ]);
});

test('buildCliInvocation supports argsTemplate with missing prompt placeholder fallback', () => {
  const invocation = buildCliInvocation({
    agent: 'gemini',
    prompt: 'test prompt',
    systemPrompt: 'System rule',
    model: 'gemini-1.5-pro',
    commandPath: '/bin/gemini',
    argsTemplate: ['--verbose']
  });

  assert.ok(invocation.args.includes('--verbose'));
  assert.ok(invocation.args.includes('--skip-trust'));
  assert.ok(invocation.args.includes('-p'));
  assert.ok(invocation.args.includes('System rule\n\ntest prompt'));
});

test('parseAgentEvent handles Claude Code nested assistant event', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'Let me think' },
        { type: 'text', text: 'Hello world' },
        { type: 'tool_use', id: 'use_1', name: 'read_file', input: { path: 'a.txt' } }
      ]
    }
  });

  const parsed = parseAgentEvent(line);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { type: 'thinking', text: 'Let me think' });
  assert.deepEqual(parsed[1], { type: 'text', text: 'Hello world' });
  assert.deepEqual(parsed[2], { type: 'tool_use', toolUseId: 'use_1', name: 'read_file', input: { path: 'a.txt' } });
});

test('parseAgentEvent handles Gemini nested, flat message, and result events', () => {
  const nestedLine = JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Hello!' },
      { type: 'tool_call', name: 'search', args: { query: 'test' } }
    ]
  });
  const nestedParsed = parseAgentEvent(nestedLine);
  assert.ok(Array.isArray(nestedParsed));
  assert.equal(nestedParsed.length, 2);
  assert.deepEqual(nestedParsed[0], { type: 'text', text: 'Hello!' });
  assert.deepEqual(nestedParsed[1], { type: 'tool_use', toolUseId: '', name: 'search', input: { query: 'test' } });

  const flatLine = JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: 'Greeting'
  });
  const flatParsed = parseAgentEvent(flatLine);
  assert.deepEqual(flatParsed, { type: 'text', text: 'Greeting' });

  const resultLine = JSON.stringify({
    type: 'result',
    result: 'Final Output Summary'
  });
  const resultParsed = parseAgentEvent(resultLine);
  assert.deepEqual(resultParsed, { type: 'text', text: 'Final Output Summary' });
});

test('parseAgentEvent handles Claude Code nested user event', () => {
  const line = JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', id: 'use_1', content: 'file content', is_error: false }
      ]
    }
  });

  const parsed = parseAgentEvent(line);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { type: 'tool_result', toolUseId: 'use_1', content: 'file content', isError: false });
});

test('parseAgentEvent handles Codex item.started and item.completed', () => {
  const startLine = JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      id: 'cmd_1',
      command: '/bin/zsh -lc \'ls\''
    }
  });
  const startParsed = parseAgentEvent(startLine);
  assert.deepEqual(startParsed, {
    type: 'tool_use',
    name: 'command_execution',
    toolUseId: 'cmd_1',
    input: { command: 'ls' }
  });

  const completeLine = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      id: 'cmd_1',
      exit_code: 0,
      aggregated_output: 'file1\nfile2'
    }
  });
  const completeParsed = parseAgentEvent(completeLine);
  assert.deepEqual(completeParsed, {
    type: 'tool_result',
    toolUseId: 'cmd_1',
    content: 'file1\nfile2',
    isError: false
  });
});

test('path verification functions validate path boundaries', () => {
  const workspace = '/tmp/my-workspace';
  
  // 1. isAttemptingUnauthorizedAccess
  assert.equal(isAttemptingUnauthorizedAccess('read_file', { path: 'src/index.js' }, workspace), false);
  assert.equal(isAttemptingUnauthorizedAccess('read_file', { path: '../outside.js' }, workspace), true);
  assert.equal(isAttemptingUnauthorizedAccess('bash', { command: 'cat /etc/passwd' }, workspace), true);
  assert.equal(isAttemptingUnauthorizedAccess('bash', { command: 'cat src/index.js' }, workspace), false);

  // 2. explicitlyRequestsExternalAccess
  assert.equal(explicitlyRequestsExternalAccess('Show me /etc/passwd', workspace), true);
  assert.equal(explicitlyRequestsExternalAccess('Search outside of workspace', workspace), true);
  assert.equal(explicitlyRequestsExternalAccess('Format this code', workspace), false);
});

test('buildCliInvocation appends sandbox rules', () => {
  const invocation = buildCliInvocation({
    agent: 'claude',
    prompt: 'say hi',
    cwd: '/tmp/repo',
    commandPath: '/bin/claude',
    sandbox: { restrictToWorkspace: true }
  });

  assert.ok(invocation.prompt.includes('[SECURITY POLICY - WORKSPACE LOCK]'));
});

test('materializeImageAttachments saves image files to disk', () => {
  const attachments = [
    {
      name: 'test-img',
      mimeType: 'image/png',
      base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    }
  ];

  const materialized = materializeImageAttachments(attachments);
  assert.ok(materialized.dirPath);
  assert.equal(materialized.files.length, 1);
  assert.ok(materialized.files[0].filePath.endsWith('.png'));
  assert.ok(fs.existsSync(materialized.files[0].filePath));

  // Clean up
  fs.rmSync(materialized.dirPath, { recursive: true, force: true });
});

test('buildPromptWithImageFiles formats the prompt correctly', () => {
  const files = [
    { filePath: '/tmp/image.png', mimeType: 'image/png' }
  ];
  const prompt = 'describe this';
  const extended = buildPromptWithImageFiles(prompt, files);
  
  assert.ok(extended.includes('describe this'));
  assert.ok(extended.includes('[Attached Clipboard Images]'));
  assert.ok(extended.includes('/tmp/image.png'));
});

test('runCliAgent enforces active-kill sandbox on unauthorized access', async () => {
  const cmd = process.execPath;
  let errorCaught = null;
  
  try {
    await runCliAgent({
      agent: 'claude',
      prompt: 'do something',
      commandPath: cmd,
      sandbox: { restrictToWorkspace: true },
      cwd: require('os').tmpdir(),
      argsOverride: [
        '-e',
        'console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"1",name:"read_file",input:{path:"../../secret.txt"}}]}})); setTimeout(() => {}, 2000);',
      ]
    });
  } catch (err) {
    errorCaught = err;
  }
  
  assert.ok(errorCaught);
  assert.equal(errorCaught.code, 'SECURITY_VIOLATION');
  assert.ok(errorCaught.message.includes('unauthorized path'));
});

