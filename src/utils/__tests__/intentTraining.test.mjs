import { test } from 'node:test';
import assert from 'node:assert/strict';

test('buildRecord produces schema-correct records', async () => {
  const { buildRecord } = await import('../intentTraining.js');

  const meta = {
    target_id: '12345',
    target_type: 'group',
    pet_id: 'pet_a',
    provider: 'openai_compatible',
    model: 'Qwen3-32B-thinking',
    label: 'Intent:msg',
  };

  const trace = {
    systemPrompt: 'you are a friendly pet',
    tools: [{ name: 'social_read', description: '...', parameters: {} }],
    initialUserMessage: 'buffer: msg1, msg2, msg3',
    iterations: [
      {
        content: null,
        reasoning_content: 'I should read the rule first',
        tool_calls: [
          { id: 'call_1', type: 'function',
            function: { name: 'social_read',
              arguments: '{"path":"social/group/RULE_12345.md"}' } },
        ],
      },
      {
        content: null,
        reasoning_content: 'now I know the rule, write plan',
        tool_calls: [
          { id: 'call_2', type: 'function',
            function: { name: 'write_intent_plan',
              arguments: '{"willingness":4,"actions":[]}' } },
        ],
      },
    ],
    toolResults: [
      { tool_call_id: 'call_1', name: 'social_read', content: '<rule text>' },
    ],
    status: 'success',
    termination: 'write_intent_plan',
    error: null,
    durationMs: 4820,
  };

  const record = buildRecord(meta, trace);

  assert.equal(record.schema_version, 1);
  assert.match(record.id, /^itr_/);
  assert.equal(record.target_id, '12345');
  assert.equal(record.status, 'success');
  assert.equal(record.iterations, 2);
  assert.equal(record.tool_calls_total, 2);

  assert.equal(record.messages.length, 4);
  assert.equal(record.messages[0].role, 'user');
  assert.equal(record.messages[1].role, 'assistant');
  assert.equal(record.messages[1].reasoning_content, 'I should read the rule first');
  assert.equal(record.messages[2].role, 'tool');
  assert.equal(record.messages[2].tool_call_id, 'call_1');
  assert.equal(record.messages[3].role, 'assistant');
  assert.equal(record.messages[3].tool_calls[0].function.name, 'write_intent_plan');
});

test('buildRecord omits reasoning_content when absent', async () => {
  const { buildRecord } = await import('../intentTraining.js');

  const record = buildRecord(
    { target_id: 'x', target_type: 'friend', pet_id: 'p', provider: 'o', model: 'm', label: 'Intent:idle' },
    {
      systemPrompt: 's',
      tools: [],
      initialUserMessage: 'u',
      iterations: [{ content: 'hello', tool_calls: [] }],
      toolResults: [],
      status: 'success',
      termination: 'end',
      durationMs: 100,
    }
  );

  const assistant = record.messages.find(m => m.role === 'assistant');
  assert.equal('reasoning_content' in assistant, false);
});

test('buildRecord handles failed status with error', async () => {
  const { buildRecord } = await import('../intentTraining.js');

  const record = buildRecord(
    { target_id: 'x', target_type: 'group', pet_id: 'p', provider: 'o', model: 'm', label: 'Intent:msg' },
    {
      systemPrompt: 's',
      tools: [],
      initialUserMessage: 'u',
      iterations: [],
      toolResults: [],
      status: 'failed',
      termination: 'error',
      error: 'LLM timeout',
      durationMs: 64000,
    }
  );

  assert.equal(record.status, 'failed');
  assert.equal(record.error, 'LLM timeout');
  assert.equal(record.iterations, 0);
  assert.equal(record.messages.length, 1);
});
