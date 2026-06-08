const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_DEFINITIONS,
  detectCliAgents,
  runCliAgent,
} = require('../src/index');

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
