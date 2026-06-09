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
} = require('../dist/index');
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

test('runCliAgent suppresses duplicate final assistant messages after deltas', async () => {
  const cmd = process.execPath;
  const textEvents = [];
  const result = await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: cmd,
    argsOverride: [
      '-e',
      [
        'console.log(JSON.stringify({type:"assistant.message_delta",data:{messageId:"msg_1",deltaContent:"Hel"}}));',
        'console.log(JSON.stringify({type:"assistant.message_delta",data:{messageId:"msg_1",deltaContent:"lo"}}));',
        'console.log(JSON.stringify({type:"assistant.message",data:{messageId:"msg_1",content:"Hello"}}));'
      ].join(' ')
    ],
    onEvent: (event) => {
      if (event.type === 'text') textEvents.push(event.text);
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(textEvents, ['Hel', 'lo']);
  assert.equal(result.events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello');
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

test('parseAgentEvent handles Copilot tool execution lifecycle events', () => {
  const startLine = JSON.stringify({
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call_1',
      toolName: 'bash',
      arguments: {
        command: 'pwd && ls',
        description: 'Show current directory and list files'
      }
    }
  });

  const startParsed = parseAgentEvent(startLine);
  assert.deepEqual(startParsed, {
    type: 'tool_use',
    name: 'bash',
    input: {
      command: 'pwd && ls',
      description: 'Show current directory and list files'
    },
    toolUseId: 'call_1'
  });

  const completeLine = JSON.stringify({
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'call_1',
      success: true,
      result: {
        content: '/tmp/probe\nprobe.txt\n<exited with exit code 0>',
        detailedContent: '/tmp/probe\nprobe.txt\n<exited with exit code 0>'
      }
    }
  });

  const completeParsed = parseAgentEvent(completeLine);
  assert.deepEqual(completeParsed, {
    type: 'tool_result',
    content: '/tmp/probe\nprobe.txt\n<exited with exit code 0>',
    isError: false,
    toolUseId: 'call_1'
  });
});

test('parseAgentEvent handles Codex final agent_message item as text', () => {
  const line = JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'agent_message',
      text: 'Final answer'
    }
  });

  const parsed = parseAgentEvent(line);
  assert.deepEqual(parsed, {
    type: 'text',
    text: 'Final answer'
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

// =====================================================================
// 🔴 High Priority — Error Paths
// =====================================================================

test('runCliAgent returns timedOut when process exceeds timeoutMs', async () => {
  const result = await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: process.execPath,
    argsOverride: ['-e', 'setTimeout(() => {}, 30000)'],
    timeoutMs: 500,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.timeoutMs, 500);
});

test('runCliAgent reports non-zero exit code', async () => {
  const result = await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: process.execPath,
    argsOverride: ['-e', 'process.exit(42)'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 42);
});

test('runCliAgent rejects on ENOENT for non-existent binary', async () => {
  await assert.rejects(
    () => runCliAgent({
      agent: 'claude',
      prompt: 'test',
      commandPath: '/nonexistent/binary-that-does-not-exist',
      argsOverride: [],
    }),
    (err) => err.code === 'ENOENT'
  );
});

// =====================================================================
// 🔴 High Priority — Streaming callback verification
// =====================================================================

test('runCliAgent invokes onStdout and onStderr callbacks', async () => {
  const stdoutLines = [];
  const stderrLines = [];
  await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: process.execPath,
    argsOverride: ['-e', 'console.log("stdout_marker"); console.error("stderr_marker");'],
    onStdout: (line) => stdoutLines.push(line),
    onStderr: (line) => stderrLines.push(line),
  });
  assert.ok(stdoutLines.some((l) => l.includes('stdout_marker')), 'onStdout should receive stdout lines');
  assert.ok(stderrLines.some((l) => l.includes('stderr_marker')), 'onStderr should receive stderr lines');
});

test('runCliAgent emits events in correct order for multi-step output', async () => {
  const eventTypes = [];
  await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: process.execPath,
    argsOverride: [
      '-e',
      [
        'console.log(JSON.stringify({type:"content",text:"step1"}));',
        'console.log(JSON.stringify({type:"tool_use",name:"bash",input:{cmd:"ls"}}));',
        'console.log(JSON.stringify({type:"tool_result",output:"file.txt",tool_use_id:"t1"}));',
        'console.log(JSON.stringify({type:"content",text:"step2"}));',
      ].join(' '),
    ],
    onEvent: (e) => eventTypes.push(e.type),
  });
  assert.deepEqual(eventTypes, ['text', 'tool_use', 'tool_result', 'text']);
});

// =====================================================================
// 🟡 Medium Priority — parseAgentEvent edge cases
// =====================================================================

test('parseAgentEvent returns null for empty or blank input', () => {
  assert.equal(parseAgentEvent(''), null);
  assert.equal(parseAgentEvent('   '), null);
  assert.equal(parseAgentEvent(null), null);
  assert.equal(parseAgentEvent(undefined), null);
});

test('parseAgentEvent returns text for non-JSON plain text', () => {
  const r = parseAgentEvent('this is plain text');
  assert.equal(r.type, 'text');
  assert.equal(r.text, 'this is plain text');
});

test('parseAgentEvent returns text for malformed JSON', () => {
  const r = parseAgentEvent('{"truncated": tru');
  assert.equal(r.type, 'text');
  assert.ok(r.text.includes('truncated'));
});

test('parseAgentEvent handles error event', () => {
  const e = parseAgentEvent('{"type":"error","message":"something broke"}');
  assert.equal(e.type, 'error');
  assert.equal(e.text, 'something broke');
});

test('parseAgentEvent handles error event with content field', () => {
  const e = parseAgentEvent('{"type":"error","content":"fatal crash"}');
  assert.equal(e.type, 'error');
  assert.equal(e.text, 'fatal crash');
});

test('parseAgentEvent handles system init event', () => {
  const e = parseAgentEvent('{"type":"system","subtype":"init","cwd":"/tmp/workspace"}');
  assert.equal(e.type, 'system');
  assert.ok(e.text.includes('/tmp/workspace'));
});

test('parseAgentEvent handles system hook_started event', () => {
  const e = parseAgentEvent('{"type":"system","subtype":"hook_started","hook_name":"pre-commit"}');
  assert.equal(e.type, 'system');
  assert.ok(e.text.includes('pre-commit'));
});

test('parseAgentEvent handles system hook_response event', () => {
  const e = parseAgentEvent('{"type":"system","subtype":"hook_response","hook_name":"post-run"}');
  assert.equal(e.type, 'system');
  assert.ok(e.text.includes('post-run'));
});

test('parseAgentEvent handles assistant.reasoning (thinking)', () => {
  const e = parseAgentEvent('{"type":"assistant.reasoning","data":{"content":"Let me think about this..."}}');
  assert.equal(e.type, 'thinking');
  assert.equal(e.text, 'Let me think about this...');
});

test('parseAgentEvent handles assistant.reasoning with top-level content', () => {
  const e = parseAgentEvent('{"type":"assistant.reasoning","content":"Reasoning here"}');
  assert.equal(e.type, 'thinking');
  assert.equal(e.text, 'Reasoning here');
});

test('parseAgentEvent handles direct tool_use event', () => {
  const e = parseAgentEvent('{"type":"tool_use","name":"write_file","input":{"path":"a.txt","content":"hello"},"id":"tu_1"}');
  assert.equal(e.type, 'tool_use');
  assert.equal(e.name, 'write_file');
  assert.deepEqual(e.input, { path: 'a.txt', content: 'hello' });
  assert.equal(e.toolUseId, 'tu_1');
});

test('parseAgentEvent handles direct functionCall event (Gemini style)', () => {
  const e = parseAgentEvent('{"type":"functionCall","name":"search","input":{"q":"test"},"id":"fc_1"}');
  assert.equal(e.type, 'tool_use');
  assert.equal(e.name, 'search');
  assert.deepEqual(e.input, { q: 'test' });
  assert.equal(e.toolUseId, 'fc_1');
});

test('parseAgentEvent handles direct tool_result event', () => {
  const e = parseAgentEvent('{"type":"tool_result","output":"file contents here","tool_use_id":"t1"}');
  assert.equal(e.type, 'tool_result');
  assert.equal(e.content, 'file contents here');
  assert.equal(e.toolUseId, 't1');
  assert.equal(e.isError, false);
});

test('parseAgentEvent handles direct tool_result with error', () => {
  const e = parseAgentEvent('{"type":"tool_result","output":"not found","tool_use_id":"t2","is_error":true}');
  assert.equal(e.type, 'tool_result');
  assert.equal(e.isError, true);
});

test('parseAgentEvent handles functionResponse event (Gemini style)', () => {
  const e = parseAgentEvent('{"type":"functionResponse","functionResponse":{"response":"result data"},"id":"fr_1"}');
  assert.equal(e.type, 'tool_result');
  assert.equal(e.content, 'result data');
  assert.equal(e.toolUseId, 'fr_1');
});

test('parseAgentEvent handles type "text" event', () => {
  const e = parseAgentEvent('{"type":"text","text":"direct text event"}');
  assert.equal(e.type, 'text');
  assert.equal(e.text, 'direct text event');
});

test('parseAgentEvent handles type "text" event with value field', () => {
  const e = parseAgentEvent('{"type":"text","value":"value text"}');
  assert.equal(e.type, 'text');
  assert.equal(e.text, 'value text');
});

test('parseAgentEvent falls back to json type for unknown event types', () => {
  const e = parseAgentEvent('{"type":"unknown_custom_event","data":"something"}');
  assert.equal(e.type, 'json');
  assert.deepEqual(e.payload, { type: 'unknown_custom_event', data: 'something' });
});

test('parseAgentEvent falls back to json type for JSON without type field', () => {
  const e = parseAgentEvent('{"foo":"bar","baz":42}');
  assert.equal(e.type, 'json');
  assert.deepEqual(e.payload, { foo: 'bar', baz: 42 });
});

// Nested Gemini content block with "content" type (alternative to "text")
test('parseAgentEvent handles Gemini nested content block with "content" type', () => {
  const line = JSON.stringify({
    type: 'message',
    role: 'model',
    content: [
      { type: 'content', content: 'Model output text' },
    ],
  });
  const parsed = parseAgentEvent(line);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].type, 'text');
  assert.equal(parsed[0].text, 'Model output text');
});

// =====================================================================
// 🟡 Medium Priority — buildCliInvocation edge cases
// =====================================================================

test('buildCliInvocation throws when prompt is empty', () => {
  assert.throws(
    () => buildCliInvocation({ agent: 'claude', prompt: '', commandPath: '/bin/claude' }),
    /prompt is required/
  );
});

test('buildCliInvocation throws when prompt is whitespace-only', () => {
  assert.throws(
    () => buildCliInvocation({ agent: 'claude', prompt: '   ', commandPath: '/bin/claude' }),
    /prompt is required/
  );
});

test('buildCliInvocation throws when executable not found', () => {
  assert.throws(
    () => buildCliInvocation({
      agent: 'claude',
      prompt: 'test',
      findExecutable: () => null,
    }),
    /Executable not found/
  );
});

test('buildCliInvocation supports argsOverride', () => {
  const invocation = buildCliInvocation({
    agent: 'claude',
    prompt: 'test',
    commandPath: '/bin/claude',
    argsOverride: ['--custom-flag', 'value'],
  });
  assert.deepEqual(invocation.args, ['--custom-flag', 'value']);
});

test('buildCliInvocation appends extraArgs', () => {
  const invocation = buildCliInvocation({
    agent: 'claude',
    prompt: 'test',
    commandPath: '/bin/claude',
    extraArgs: ['--extra1', '--extra2'],
  });
  assert.ok(invocation.args.includes('--extra1'));
  assert.ok(invocation.args.includes('--extra2'));
  // extraArgs should be at the end
  const idx1 = invocation.args.indexOf('--extra1');
  assert.equal(invocation.args[idx1 + 1], '--extra2');
});

test('buildCliInvocation supports geminiPromptStyle positional', () => {
  const invocation = buildCliInvocation({
    agent: 'gemini',
    prompt: 'hello world',
    commandPath: '/bin/gemini',
    cliOptions: { geminiPromptStyle: 'positional' },
  });
  // Should NOT use -p flag; prompt should appear as positional arg
  const pIndex = invocation.args.indexOf('-p');
  assert.equal(pIndex, -1, 'Should not use -p flag in positional mode');
  assert.ok(invocation.args.includes('hello world'), 'Prompt should be a positional argument');
});

test('buildCliInvocation supports copilot custom output format and stream mode', () => {
  const invocation = buildCliInvocation({
    agent: 'copilot',
    prompt: 'test',
    commandPath: '/bin/copilot',
    cliOptions: {
      copilotOutputFormat: 'text',
      copilotStreamMode: 'off',
    },
  });
  const fmtIdx = invocation.args.indexOf('--output-format');
  assert.equal(invocation.args[fmtIdx + 1], 'text');
  const streamIdx = invocation.args.indexOf('--stream');
  assert.equal(invocation.args[streamIdx + 1], 'off');
});

// =====================================================================
// 🟡 Medium Priority — resolveCwd tilde expansion
// =====================================================================

test('resolveCwd expands ~ to home directory', () => {
  const home = require('os').homedir();
  const resolved = resolveCwd('~/projects');
  assert.equal(resolved, require('path').join(home, 'projects'));
});

test('resolveCwd expands ~/nested/path correctly', () => {
  const home = require('os').homedir();
  const resolved = resolveCwd('~/a/b/c');
  assert.equal(resolved, require('path').join(home, 'a/b/c'));
});

// =====================================================================
// 🟡 Medium Priority — stderr error event propagation
// =====================================================================

test('runCliAgent captures error events from stderr into events array', async () => {
  const result = await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: process.execPath,
    argsOverride: [
      '-e',
      'console.error(JSON.stringify({type:"error",message:"stderr error msg"}));',
    ],
  });
  const errorEvents = result.events.filter((e) => e.type === 'error');
  assert.ok(errorEvents.length > 0, 'Should capture error events from stderr');
  assert.equal(errorEvents[0].text, 'stderr error msg');
});

test('runCliAgent does not capture non-error events from stderr', async () => {
  const result = await runCliAgent({
    agent: 'claude',
    prompt: 'ignored',
    commandPath: process.execPath,
    argsOverride: [
      '-e',
      'console.error(JSON.stringify({type:"content",text:"not an error"}));',
    ],
  });
  // "content" type from stderr should NOT be added to events
  const contentEvents = result.events.filter((e) => e.type === 'text');
  assert.equal(contentEvents.length, 0, 'Non-error events from stderr should not be in events array');
});
