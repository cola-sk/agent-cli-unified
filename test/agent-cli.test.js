const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAgent,
  resolveCwd,
  detectCliAgents,
  buildCliInvocation,
  parseAgentEvent,
  runCliAgent,
} = require('../src/index');

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
    '-p', 'refactor module',
    '--yolo',
  ]);
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
  assert.equal(toolEvent.type, 'tool_call');
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
