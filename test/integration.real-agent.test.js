const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  AGENT_DEFINITIONS,
  detectCliAgents,
  runCliAgent,
} = require('../dist/index');

const RUN_REAL = process.env.RUN_REAL_AGENT_E2E === '1';
const REQUESTED_AGENTS = (process.env.REAL_AGENT_LIST || 'codex,claude,gemini,copilot')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const REAL_TIMEOUT_MS = Number(process.env.REAL_AGENT_TIMEOUT_MS || 120000);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const agentId of REQUESTED_AGENTS) {
  test(
    `real e2e: ${agentId} should be invoked and return expected token`,
    {
      skip: RUN_REAL ? false : 'Set RUN_REAL_AGENT_E2E=1 to run real agent CLI integration tests.',
      timeout: REAL_TIMEOUT_MS + 5000,
    },
    async (t) => {
      if (!AGENT_DEFINITIONS[agentId]) {
        t.skip(`Unknown agent "${agentId}"`);
        return;
      }

      const detected = detectCliAgents().find((x) => x.id === agentId);
      if (!detected || !detected.available) {
        t.skip(`${agentId} CLI is not installed or not found in PATH`);
        return;
      }

      const marker = `E2E_OK_${agentId.toUpperCase()}_${Date.now()}`;
      const streamedText = [];

      const result = await runCliAgent({
        agent: agentId,
        prompt: [
          'You are in an automated integration test.',
          `Return this exact token in your final answer: ${marker}`,
          'Prefer a single-line response and do not omit the token.',
        ].join('\n'),
        timeoutMs: REAL_TIMEOUT_MS,
        onEvent: (event) => {
          if (event && event.type === 'text' && typeof event.text === 'string' && event.text.trim()) {
            streamedText.push(event.text);
          }
        },
      });

      assert.equal(
        result.timedOut,
        false,
        `${agentId} invocation timed out after ${REAL_TIMEOUT_MS}ms.\nSTDERR:\n${result.stderr || '(empty)'}`
      );
      assert.equal(
        result.ok,
        true,
        `${agentId} exited with code ${result.exitCode}.\nSTDERR:\n${result.stderr || '(empty)'}`
      );

      const combinedOutput = [result.stdout, ...streamedText].join('\n');
      assert.ok(
        combinedOutput.trim().length > 0,
        `${agentId} returned empty output`
      );
      assert.match(
        combinedOutput,
        new RegExp(escapeRegExp(marker)),
        `${agentId} output did not include expected token "${marker}".\nOUTPUT:\n${combinedOutput}`
      );
      assert.ok(
        result.events.length > 0,
        `${agentId} produced no parsed stream events`
      );
    }
  );
}

const claudeDetected = detectCliAgents().find((x) => x.id === 'claude');
const claudeAvailable = claudeDetected && claudeDetected.available;

test(
  'real e2e: claude should process images and reply',
  {
    skip: RUN_REAL && claudeAvailable ? false : 'Set RUN_REAL_AGENT_E2E=1 and install Claude Code to run.',
    timeout: REAL_TIMEOUT_MS + 5000,
  },
  async () => {
    // 1x1 pixel green PNG Base64
    const greenPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    
    const result = await runCliAgent({
      agent: 'claude',
      prompt: 'What color is the attached image? Answer with exactly one word: Red, Green, or Blue.',
      attachments: [
        {
          name: 'test-color.png',
          mimeType: 'image/png',
          base64Data: greenPngBase64
        }
      ],
      timeoutMs: REAL_TIMEOUT_MS,
    });

    assert.equal(result.ok, true);
    assert.match(result.stdout, /green/i, 'Agent should detect that the image is green');
  }
);

test(
  'real e2e: claude should generate structured tool_use events',
  {
    skip: RUN_REAL && claudeAvailable ? false : 'Set RUN_REAL_AGENT_E2E=1 and install Claude Code to run.',
    timeout: REAL_TIMEOUT_MS + 5000,
  },
  async () => {
    const result = await runCliAgent({
      agent: 'claude',
      prompt: 'Check if package.json exists in the current directory using your file list or search tool.',
      cwd: path.resolve(__dirname, '..'),
      timeoutMs: REAL_TIMEOUT_MS,
    });

    assert.equal(result.ok, true);
    const hasToolUse = result.events.some(e => e.type === 'tool_use');
    assert.ok(hasToolUse, 'Should have logged at least one structured tool_use event');
  }
);

// =====================================================================
// All-agent tool_use event verification
// =====================================================================

for (const agentId of REQUESTED_AGENTS) {
  test(
    `real e2e: ${agentId} should emit tool_use events when using tools`,
    {
      skip: RUN_REAL ? false : 'Set RUN_REAL_AGENT_E2E=1 to run real agent CLI integration tests.',
      timeout: REAL_TIMEOUT_MS + 5000,
    },
    async (t) => {
      if (!AGENT_DEFINITIONS[agentId]) {
        t.skip(`Unknown agent "${agentId}"`);
        return;
      }

      const detected = detectCliAgents().find((x) => x.id === agentId);
      if (!detected || !detected.available) {
        t.skip(`${agentId} CLI is not installed or not found in PATH`);
        return;
      }

      const eventSequence = [];

      const result = await runCliAgent({
        agent: agentId,
        prompt: [
          'You are in an automated integration test.',
          'List the files in the current directory using your shell or file listing tool.',
          'Then report what you found.',
        ].join('\n'),
        cwd: path.resolve(__dirname, '..'),
        timeoutMs: REAL_TIMEOUT_MS,
        onEvent: (event) => {
          if (event && event.type) {
            eventSequence.push(event.type);
          }
        },
      });

      assert.equal(
        result.timedOut,
        false,
        `${agentId} timed out. STDERR:\n${result.stderr || '(empty)'}`
      );
      assert.equal(
        result.ok,
        true,
        `${agentId} exited with code ${result.exitCode}. STDERR:\n${result.stderr || '(empty)'}`
      );

      const hasToolUse = eventSequence.includes('tool_use');
      assert.ok(
        hasToolUse,
        `${agentId} should emit tool_use events. Got event types: ${[...new Set(eventSequence)].join(', ')}`
      );
    }
  );
}

// =====================================================================
// All-agent tool_result event verification
// =====================================================================

for (const agentId of REQUESTED_AGENTS) {
  test(
    `real e2e: ${agentId} should emit tool_result events after tool execution`,
    {
      skip: RUN_REAL ? false : 'Set RUN_REAL_AGENT_E2E=1 to run real agent CLI integration tests.',
      timeout: REAL_TIMEOUT_MS + 5000,
    },
    async (t) => {
      if (!AGENT_DEFINITIONS[agentId]) {
        t.skip(`Unknown agent "${agentId}"`);
        return;
      }

      const detected = detectCliAgents().find((x) => x.id === agentId);
      if (!detected || !detected.available) {
        t.skip(`${agentId} CLI is not installed or not found in PATH`);
        return;
      }

      const eventSequence = [];

      const result = await runCliAgent({
        agent: agentId,
        prompt: [
          'You are in an automated integration test.',
          'Read the contents of the file named "package.json" in the current directory.',
          'Report the "name" field from the file.',
        ].join('\n'),
        cwd: path.resolve(__dirname, '..'),
        timeoutMs: REAL_TIMEOUT_MS,
        onEvent: (event) => {
          if (event && event.type) {
            eventSequence.push(event.type);
          }
        },
      });

      assert.equal(result.ok, true, `${agentId} exited with code ${result.exitCode}`);

      const hasToolResult = eventSequence.includes('tool_result');
      assert.ok(
        hasToolResult,
        `${agentId} should emit tool_result events. Got event types: ${[...new Set(eventSequence)].join(', ')}`
      );
    }
  );
}

// =====================================================================
// Streaming onStdout callback verification
// =====================================================================

for (const agentId of REQUESTED_AGENTS) {
  test(
    `real e2e: ${agentId} onStdout fires during streaming`,
    {
      skip: RUN_REAL ? false : 'Set RUN_REAL_AGENT_E2E=1 to run real agent CLI integration tests.',
      timeout: REAL_TIMEOUT_MS + 5000,
    },
    async (t) => {
      if (!AGENT_DEFINITIONS[agentId]) {
        t.skip(`Unknown agent "${agentId}"`);
        return;
      }

      const detected = detectCliAgents().find((x) => x.id === agentId);
      if (!detected || !detected.available) {
        t.skip(`${agentId} CLI is not installed or not found in PATH`);
        return;
      }

      const stdoutCalls = [];

      const result = await runCliAgent({
        agent: agentId,
        prompt: [
          'You are in an automated integration test.',
          'Say "hello world" and nothing else.',
        ].join('\n'),
        timeoutMs: REAL_TIMEOUT_MS,
        onStdout: (line) => stdoutCalls.push(line),
      });

      assert.equal(result.ok, true, `${agentId} exited with code ${result.exitCode}`);
      assert.ok(
        stdoutCalls.length > 0,
        `${agentId}: onStdout should fire at least once during streaming. Got 0 calls.`
      );
    }
  );
}

// =====================================================================
// Event sequence ordering verification
// =====================================================================

for (const agentId of REQUESTED_AGENTS) {
  test(
    `real e2e: ${agentId} events follow logical ordering (tool_use before tool_result)`,
    {
      skip: RUN_REAL ? false : 'Set RUN_REAL_AGENT_E2E=1 to run real agent CLI integration tests.',
      timeout: REAL_TIMEOUT_MS + 5000,
    },
    async (t) => {
      if (!AGENT_DEFINITIONS[agentId]) {
        t.skip(`Unknown agent "${agentId}"`);
        return;
      }

      const detected = detectCliAgents().find((x) => x.id === agentId);
      if (!detected || !detected.available) {
        t.skip(`${agentId} CLI is not installed or not found in PATH`);
        return;
      }

      const eventSequence = [];

      const result = await runCliAgent({
        agent: agentId,
        prompt: [
          'You are in an automated integration test.',
          'List files in the current directory using a tool, then summarize what you see.',
        ].join('\n'),
        cwd: path.resolve(__dirname, '..'),
        timeoutMs: REAL_TIMEOUT_MS,
        onEvent: (event) => {
          if (event && event.type) {
            eventSequence.push(event.type);
          }
        },
      });

      assert.equal(result.ok, true, `${agentId} exited with code ${result.exitCode}`);

      const firstToolUse = eventSequence.indexOf('tool_use');
      const firstToolResult = eventSequence.indexOf('tool_result');

      if (firstToolUse >= 0 && firstToolResult >= 0) {
        assert.ok(
          firstToolUse < firstToolResult,
          `${agentId}: tool_use (index ${firstToolUse}) should appear before tool_result (index ${firstToolResult}). Sequence: ${eventSequence.join(' → ')}`
        );
      }
    }
  );
}
