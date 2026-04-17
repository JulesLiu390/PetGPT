# Intent Training Data Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect complete Intent LLM call trajectories (messages, tool calls, reasoning) as JSONL, exportable to Unsloth HF messages + tools format for fine-tuning a local Qwen model.

**Architecture:** New `onTrace` callback in `callLLMWithTools` captures full trajectory on loop exit (all paths). Intent loop in `socialAgent.js` opts in via global toggle + per-target whitelist; writes JSONL via `intentTraining.js`. Export script `scripts/export_intent_training.mjs` filters, redacts, and converts raw records to HF format. Rust command spawns the Node script from a UI button.

**Tech Stack:** Plain JS (no TS), React 19, Tailwind, Tauri v2 (Rust), Node.js 18+ for export script.

**Spec:** [docs/superpowers/specs/2026-04-17-intent-training-data-collection-design.md](../specs/2026-04-17-intent-training-data-collection-design.md)

---

## File Structure

### Create
| File | Responsibility |
|---|---|
| `src/utils/intentTraining.js` | Build schema record from trace + append to JSONL |
| `scripts/export_intent_training.mjs` | CLI: filter + redact + convert to HF format |
| `scripts/__tests__/export_intent_training.test.mjs` | Tests for export script (Node `--test`) |
| `src-tauri/src/commands/training_export.rs` | Tauri command spawning Node export script |
| `docs/superpowers/plans/2026-04-17-intent-training-data-collection.md` | This plan |

### Modify
| File | What changes |
|---|---|
| `src/utils/llm/adapters/anthropicNative.js` | Extract `thinking` blocks → `reasoningContent` in parseResponse |
| `src/utils/mcp/toolExecutor.js` | Add `onTrace` callback; collect iterations/toolResults; fire in `finally` |
| `src/utils/socialAgent.js` | Resolve `trainingEnabled` per-target + pass `onTrace` to Intent `callLLMWithTools` |
| `src/utils/useSettings.js` | Default `trainingCollectionEnabled: false` |
| `src/pages/SocialPage.jsx` | Training Data Collection card + per-target toggle + stats + buttons |
| `src-tauri/src/lib.rs` | Register new `run_training_export` command |

---

## Preparation: Create Worktree

- [ ] **Create and enter worktree**

```bash
git worktree add .worktrees/intent-training -b feature/intent-training
cd .worktrees/intent-training
```

All subsequent tasks run in the worktree.

- [ ] **Verify clean state**

```bash
git status
# expected: On branch feature/intent-training, working tree clean
```

---

## Task 1: Extract thinking blocks in Anthropic adapter

**Files:**
- Modify: `src/utils/llm/adapters/anthropicNative.js:399-438` (parseResponse)

Anthropic returns `thinking` blocks in the `content` array alongside `text` and `tool_use` blocks. Current parseResponse ignores them. Add extraction so `reasoningContent` is consistent with OpenAI-compat adapter.

- [ ] **Step 1: Read existing parseResponse**

```bash
sed -n '395,440p' src/utils/llm/adapters/anthropicNative.js
```

Confirm the block loop structure (iterating `data.content[]` by block type).

- [ ] **Step 2: Add extraction**

Replace the block loop in `parseResponse` (around lines 400-414) so that `thinking` blocks accumulate into a `thinkingContent` string:

```js
export const parseResponse = (data) => {
  const blocks = data?.content || [];
  let textContent = '';
  let thinkingContent = '';
  const toolCalls = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textContent += block.text || '';
    } else if (block.type === 'thinking') {
      thinkingContent += block.thinking || '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      });
    }
  }

  const u = data?.usage || {};
  const usage = {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    prompt_tokens_details: u.cache_read_input_tokens
      ? { cached_tokens: u.cache_read_input_tokens }
      : undefined,
  };

  return {
    content: textContent,
    reasoningContent: thinkingContent || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    finishReason: data?.stop_reason || null,
    usage,
    raw: data,
  };
};
```

- [ ] **Step 3: Manual sanity check**

```bash
node -e "
  const { parseResponse } = await import('./src/utils/llm/adapters/anthropicNative.js');
  const r = parseResponse({ content: [
    { type: 'thinking', thinking: 'I should read the rule file first.' },
    { type: 'tool_use', id: 'call_1', name: 'social_read', input: { path: 'social/group/RULE_1.md' } },
  ], usage: {} });
  console.log(JSON.stringify(r, null, 2));
"
```

Expected: `reasoningContent: "I should read the rule file first."`, `toolCalls[0].name: "social_read"`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/llm/adapters/anthropicNative.js
git commit -m "feat(anthropic-adapter): extract thinking blocks as reasoningContent"
```

---

## Task 2: Create `intentTraining.js` module

**Files:**
- Create: `src/utils/intentTraining.js`

Builds the JSONL record from a trace object + metadata, then appends to `social/training/intent/{date}.jsonl`. No settings access (caller decides whether to invoke this).

- [ ] **Step 1: Write the module**

Create `src/utils/intentTraining.js`:

```js
/**
 * intentTraining.js — Build + append Intent eval training records.
 *
 * Called from socialAgent.js when training collection is enabled for the
 * target. Writes one JSONL line per Intent eval to
 * social/training/intent/{YYYY-MM-DD}.jsonl.
 *
 * Schema version 1 — see docs/superpowers/specs/2026-04-17-intent-training-data-collection-design.md
 */

import * as tauri from './tauri';

const SCHEMA_VERSION = 1;

/** Time-sortable ID, no external dep. */
function generateTraceId() {
  return `itr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the full schema record from meta + trace.
 * Exported for unit testing.
 */
export function buildRecord(meta, trace) {
  const messages = [];
  if (trace.initialUserMessage != null) {
    messages.push({ role: 'user', content: trace.initialUserMessage });
  }

  for (const iter of trace.iterations) {
    const assistantMsg = {
      role: 'assistant',
      content: iter.content ?? null,
    };
    if (iter.reasoning_content) {
      assistantMsg.reasoning_content = iter.reasoning_content;
    }
    if (iter.tool_calls && iter.tool_calls.length > 0) {
      assistantMsg.tool_calls = iter.tool_calls;
    }
    messages.push(assistantMsg);

    for (const tc of iter.tool_calls || []) {
      const res = trace.toolResults.find(r => r.tool_call_id === tc.id);
      if (res) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: res.content });
      }
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    id: generateTraceId(),
    ts: new Date(Date.now() - (trace.durationMs || 0)).toISOString(),
    duration_ms: trace.durationMs || 0,
    target_id: meta.target_id,
    target_type: meta.target_type,
    pet_id: meta.pet_id,
    provider: meta.provider,
    model: meta.model,
    label: meta.label,
    system: trace.systemPrompt,
    tools: trace.tools,
    messages,
    status: trace.status,
    termination: trace.termination,
    error: trace.error || null,
    iterations: trace.iterations.length,
    tool_calls_total: trace.iterations.reduce((n, it) => n + (it.tool_calls?.length || 0), 0),
  };
}

/**
 * Append one training record for the Intent eval.
 * Fire-and-forget: exceptions are logged but not thrown.
 */
export async function writeIntentTrace(petId, meta, trace) {
  if (!petId) return;
  try {
    const record = buildRecord(meta, trace);
    const date = new Date().toISOString().slice(0, 10);
    const path = `social/training/intent/${date}.jsonl`;
    await tauri.workspaceAppend(petId, path, JSON.stringify(record) + '\n');
  } catch (e) {
    console.warn('[IntentTraining] write failed:', e);
  }
}
```

- [ ] **Step 2: Write the test file**

Create `src/utils/__tests__/intentTraining.test.mjs`:

```js
// Run with: node --test --experimental-vm-modules src/utils/__tests__/intentTraining.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub tauri module since we only test the record builder shape.
// If the project has no existing test runner, follow any test file pattern
// (vitest / jest) present elsewhere. This is a minimal example.

const stubModule = `
  export const workspaceAppend = async () => {};
`;

test('buildRecord produces schema-correct records', async () => {
  // Dynamic import after stub injection, or use import assertion.
  // Simplest: import directly and rely on tauri.workspaceAppend not being called in buildRecord.
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

  // messages ordering: user, assistant, tool, assistant (no tool after final)
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

  // assistant message should NOT have reasoning_content field
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
  assert.equal(record.messages.length, 1); // just initial user
});
```

- [ ] **Step 3: Run tests — expect pass**

```bash
node --test src/utils/__tests__/intentTraining.test.mjs
```

Expected: all 3 tests pass. If the existing project uses vitest instead, adapt the test file syntax (the project has ESM `.mjs` so `node --test` should work standalone).

- [ ] **Step 4: Commit**

```bash
git add src/utils/intentTraining.js src/utils/__tests__/intentTraining.test.mjs
git commit -m "feat(intentTraining): add record builder + JSONL writer"
```

---

## Task 3: Add `onTrace` callback to `callLLMWithTools`

**Files:**
- Modify: `src/utils/mcp/toolExecutor.js:490-840` (callLLMWithTools function)

Add a new `onTrace` parameter. When set, the loop collects each iteration's assistant content/reasoning/tool_calls plus each tool result; on exit (success / stopAfterTool / max iterations / exception) it fires `onTrace(trace)` exactly once. When not set, zero overhead.

- [ ] **Step 1: Add param to destructure**

Locate the param list around line 490-510. Add after `onUsageLogged`:

```js
  onUsageLogged,    // existing
  onTrace,          // optional (trace) => void — full trajectory, fires once on exit
}) => {
```

- [ ] **Step 2: Initialize trace buckets inside the function**

Right after `const usageStartTime = Date.now();` (around line 526), add:

```js
  // ── Trace collection (only when onTrace is set) ──
  const _trace = onTrace ? {
    systemPrompt: null,
    tools: null,
    initialUserMessage: null,
    iterations: [],
    toolResults: [],
    status: 'partial',          // overwritten before onTrace fires
    termination: 'unknown',
    error: null,
    durationMs: 0,
  } : null;

  if (_trace) {
    // Capture system + tools + initial user from initialMessages
    const sys = initialMessages.find(m => m.role === 'system');
    _trace.systemPrompt = sys ? (typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content)) : '';
    _trace.tools = mcpTools;   // raw provider-neutral tool schemas passed in
    const lastUser = [...initialMessages].reverse().find(m => m.role === 'user');
    _trace.initialUserMessage = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
  }

  const _fireTrace = (status, termination, error) => {
    if (!_trace || !onTrace) return;
    _trace.status = status;
    _trace.termination = termination;
    if (error) _trace.error = typeof error === 'string' ? error : (error?.message || String(error));
    _trace.durationMs = Date.now() - usageStartTime;
    try { onTrace(_trace); } catch (_) { /* ignore */ }
  };
```

- [ ] **Step 3: Capture each iteration after parseResponse**

Locate the `const result = adapter.parseResponse(data);` line (around 585). Immediately after the existing `onLLMText` block (lines 593-602), add:

```js
    if (_trace) {
      // assistant turn for this iteration
      const toolCallsForTrace = (result.toolCalls || []).map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          // Keep args as JSON string for schema consistency (OpenAI-native shape).
          // Export script parses to object.
          arguments: typeof tc.arguments === 'string'
            ? tc.arguments
            : JSON.stringify(tc.arguments || {}),
        },
      }));
      _trace.iterations.push({
        content: result.content || null,
        reasoning_content: result.reasoningContent || undefined,
        tool_calls: toolCallsForTrace,
      });
    }
```

- [ ] **Step 4: Capture each tool result**

Locate where tool results are appended to `currentMessages` in the loop (search for where `toolCallHistory.push(...)` happens after executing a tool). Near that append, also push into trace:

```js
    // After obtaining toolResultContent (the string that goes back to the LLM)
    if (_trace) {
      _trace.toolResults.push({
        tool_call_id: toolCallId,
        name: call.name,
        content: typeof toolResultContent === 'string'
          ? toolResultContent
          : JSON.stringify(toolResultContent),
      });
    }
```

Engineer note: search inside `callLLMWithTools` for where tool results are collected (variables named like `toolResult`, `toolResultContent`, or `textResult`). Add the `_trace.toolResults.push(...)` once per executed tool call, after the result string is finalized.

- [ ] **Step 5: Wrap main loop in try/finally for exception path**

Currently the `while` loop at line 545 is not wrapped in try/finally. Wrap the entire `while (...) { ... }` block plus the post-loop `return` paths:

```js
  try {
    while (totalIterations < MAX_TOTAL_ITERATIONS) {
      // ... existing body ...
    }

    // Max iterations path (existing code around line 830)
    console.warn('[MCP] Max total iterations reached');
    _writeUsage({ /* existing */ });
    _fireTrace('partial', 'max_iterations', null);
    return {
      content: '[Maximum tool call iterations reached]',
      toolCallHistory,
      usage: totalUsage,
    };
  } catch (err) {
    _fireTrace('failed', 'error', err);
    throw err;
  }
```

And at each existing return path inside the loop that indicates normal end, add the `_fireTrace(...)` call **before** returning:

| Return path | Location | status | termination |
|---|---|---|---|
| No more tool calls (normal end) | ~line 620 | `'success'` | `'end_turn'` (no terminating tool) |
| `stopAfterTool` matched | ~line 817 | `'success'` | the tool name |

Example for the "no tool calls" return:

```js
    if (!result.toolCalls || result.toolCalls.length === 0) {
      _writeUsage({ /* existing */ });
      _fireTrace('success', 'end_turn', null);
      return {
        content: result.content,
        reasoningContent: result.reasoningContent,
        toolCallHistory,
        usage: totalUsage,
      };
    }
```

Example for `stopAfterTool`:

```js
    if (stopEarly) {
      // ... existing ...
      _fireTrace('success', typeof stopAfterTool === 'string' ? stopAfterTool : 'stopAfterTool', null);
      return { /* existing */ };
    }
```

- [ ] **Step 6: Write a smoke test**

Create `src/utils/mcp/__tests__/toolExecutor.onTrace.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// This is a minimal smoke test — it mocks adapter and llmProxyCall to simulate
// a 2-iteration tool loop and asserts onTrace fires with the expected shape.
// If the project has heavier mocking infra, adapt accordingly.

test('onTrace fires with correct status on stopAfterTool path', async () => {
  // Full mock-based test is substantial — the engineer should:
  // 1. Create a stub adapter returning {content, toolCalls, reasoningContent, usage}
  //    scripted per iteration.
  // 2. Mock llmProxyCall (import.meta-based interception or module mock).
  // 3. Call callLLMWithTools with onTrace collecting; assert single fire,
  //    status === 'success', termination matches stopAfterTool name,
  //    iterations.length === 2, toolResults.length === 1.
  //
  // If mocking llmProxyCall is non-trivial in this codebase, skip this test
  // and rely on manual verification in Task 4 instead. Document which path
  // was taken.
  assert.ok(true, 'stub — see comment for implementation guidance');
});
```

Engineer judgment: if `llmProxyCall` module-level mock is hard to set up, skip the unit test here and instead write the **integration verification script** at Task 4 step 3 which runs the real Intent loop and inspects the JSONL output.

- [ ] **Step 7: Manual smoke verification**

Skip if step 6 was implemented. Otherwise: verify lint still passes.

```bash
npm run lint
```

Expected: no new errors in the files touched. Existing errors in unrelated files are fine.

- [ ] **Step 8: Commit**

```bash
git add src/utils/mcp/toolExecutor.js src/utils/mcp/__tests__/toolExecutor.onTrace.test.mjs 2>/dev/null
git commit -m "feat(toolExecutor): onTrace callback for full trajectory capture"
```

---

## Task 4: Wire `onTrace` into Intent loop

**Files:**
- Modify: `src/utils/socialAgent.js` (Intent eval callLLMWithTools call — search for "Intent" + "callLLMWithTools")

Add per-target `trainingEnabled` resolution + a global `trainingCollectionEnabled` check; pass `onTrace` only when both are true.

- [ ] **Step 1: Add per-target training whitelist state**

Find the existing per-target state maps in `socialAgent.js` (similar to `intentMap`, `replyWakeFlag`). Near those, add:

```js
  // target → boolean; opt-in whitelist for training data collection
  const trainingTargetsMap = new Map();
```

- [ ] **Step 2: Add event listener to sync whitelist from UI**

In the section that sets up event listeners (search `emit('social-set-lurk-mode'` or `listen('social-set-lurk-mode'` pattern), add a listener for a new event `social-set-training-enabled`:

```js
  const unlistenTraining = await listen('social-set-training-enabled', (e) => {
    const { target, enabled } = e.payload || {};
    if (target == null) return;
    trainingTargetsMap.set(String(target), !!enabled);
    addLog('info', `Training collection ${enabled ? 'enabled' : 'disabled'} for ${target}`, null, target);
  });
  // Include unlistenTraining in the cleanup path.
```

Also, on startup, seed `trainingTargetsMap` from `config.trainingTargets` if passed by UI (similar to how existing lurk modes seed).

- [ ] **Step 3: Pass onTrace into Intent's callLLMWithTools**

Locate the Intent eval call to `callLLMWithTools` (around socialAgent.js:2337 — `onUsageLogged: logUsageRecord,` context). Before the call, resolve the flag:

```js
import { writeIntentTrace } from './intentTraining';

// ... inside the Intent eval function, before callLLMWithTools:
const targetStr = String(target);
const shouldCollectTraining =
  !!config.trainingCollectionEnabled && !!trainingTargetsMap.get(targetStr);

const onTraceFn = shouldCollectTraining
  ? (trace) => writeIntentTrace(config.petId, {
      target_id: targetStr,
      target_type: targetTypeOf(target),   // existing helper, or: target.includes('-') ? 'group' : 'friend'
      label: evalMode === 'idle' ? 'Intent:idle' : 'Intent:msg',
      provider: intentLLM.apiFormat,
      model: intentLLM.modelName,
      pet_id: config.petId,
    }, trace)
  : undefined;
```

Then add to the `callLLMWithTools({...})` call:

```js
onTrace: onTraceFn,
```

Note: `targetTypeOf` might not exist. The codebase distinguishes group vs friend somehow — look for `type === 'group'` or `groupId` vs `userId` in existing code. Use the actual pattern; do not invent a helper if one isn't already used. If needed, inline: `const tType = targetIsGroup ? 'group' : 'friend';`.

- [ ] **Step 4: Add `trainingCollectionEnabled` to config shape**

Search for where `config` is destructured at the top of `startSocialLoop`. Add `trainingCollectionEnabled` alongside existing fields like `replyInterval`, `observerInterval`:

```js
const {
  petId,
  replyInterval,
  observerInterval,
  trainingCollectionEnabled = false,
  trainingTargets = {},  // { [targetId]: boolean }
  // ... existing fields ...
} = config;
```

And seed the whitelist map from `trainingTargets`:

```js
for (const [tid, enabled] of Object.entries(trainingTargets)) {
  trainingTargetsMap.set(String(tid), !!enabled);
}
```

- [ ] **Step 5: Manual integration verification**

This is the integration test for Tasks 1–4.

```bash
npm run tauri:dev
```

Steps in the running app:
1. Open SocialPage (new UI from Task 6 isn't built yet — use `localStorage` or direct settings patch to enable collection manually for this verification):
   ```js
   // In browser devtools console on SocialPage:
   await window.__TAURI__.invoke('save_setting', { key: 'trainingCollectionEnabled', value: true });
   ```
   Or temporarily hardcode `config.trainingCollectionEnabled = true` and `trainingTargets = { '<your-test-group-id>': true }` for this verification.
2. Trigger an Intent eval (send a message to the test group).
3. In a terminal:
   ```bash
   ls "$HOME/Library/Application Support/com.petgpt.app/workspace/<petId>/social/training/intent/"
   # expected: today's YYYY-MM-DD.jsonl exists
   cat "$HOME/Library/Application Support/com.petgpt.app/workspace/<petId>/social/training/intent/$(date +%Y-%m-%d).jsonl" | head -1 | python3 -m json.tool
   # expected: full schema with messages, tools, status, etc.
   ```

Remove any hardcoded flags before commit.

- [ ] **Step 6: Commit**

```bash
git add src/utils/socialAgent.js
git commit -m "feat(socialAgent): wire onTrace callback into Intent loop"
```

---

## Task 5: Add settings + target config

**Files:**
- Modify: `src/utils/useSettings.js`
- Modify: `src/pages/SocialPage.jsx` (state + event handler)

- [ ] **Step 1: Default setting key**

Open `src/utils/useSettings.js`. Find the setup where defaults are defined (search for `trainingCollectionEnabled` — if not present, find where similar booleans like `explicitPromptCache` are defaulted). Add:

```js
// In the default settings map:
trainingCollectionEnabled: false,
```

If defaults are stored server-side (Rust), add to the same place. Check `src-tauri/src/settings.rs` or `lib.rs` for existing default settings; mirror the pattern.

- [ ] **Step 2: Add local state + event emitter in SocialPage**

In `src/pages/SocialPage.jsx`, near the existing `lurkModes` state (line 64):

```js
const [trainingTargets, setTrainingTargets] = useState({}); // { [target]: true }
```

Add helper (near `setTargetLurkMode` at line 677):

```js
const setTargetTrainingEnabled = (target, enabled) => {
  emit('social-set-training-enabled', { target, enabled });
  setTrainingTargets(prev => ({ ...prev, [target]: enabled }));
};
```

- [ ] **Step 3: Pass `trainingCollectionEnabled` + `trainingTargets` into `social-start` payload**

Find where SocialPage emits `social-start` (search for `emit('social-start'`). Add the new fields to the payload:

```js
emit('social-start', {
  petId,
  // ... existing fields ...
  trainingCollectionEnabled: settings?.trainingCollectionEnabled || false,
  trainingTargets,
});
```

- [ ] **Step 4: Commit**

```bash
git add src/utils/useSettings.js src/pages/SocialPage.jsx
git commit -m "feat(settings): trainingCollectionEnabled + per-target training whitelist"
```

---

## Task 6: Training Data Collection card in SocialPage

**Files:**
- Modify: `src/pages/SocialPage.jsx` (render tree — Prompt Cache card area)

Add a new card below the existing Prompt Cache card. Global toggle + description + stats + buttons.

- [ ] **Step 1: Locate the Prompt Cache card**

Search:

```bash
grep -n "Prompt Cache\|PromptCachePanel" src/pages/SocialPage.jsx | head
```

Identify where the card is rendered so the new card goes right after it.

- [ ] **Step 2: Add component**

In a reasonable nearby spot (same file unless the Prompt Cache card is its own component — then create a peer component file in the same directory), add:

```jsx
const TrainingDataCard = ({ settings, trainingTargets, onToggleGlobal, onOpenFolder, onExport }) => {
  const globalEnabled = !!settings?.trainingCollectionEnabled;
  const enabledTargets = Object.entries(trainingTargets || {})
    .filter(([_, v]) => v)
    .map(([id]) => id);

  return (
    <div className="rounded-lg border border-gray-200 p-4 bg-white">
      <h3 className="font-semibold text-sm mb-2">Training Data Collection</h3>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={globalEnabled}
          onChange={(e) => onToggleGlobal(e.target.checked)}
        />
        <span className="text-sm">Enable collection (global)</span>
      </label>

      <p className="text-xs text-gray-500 mt-2">
        Only targets marked below are collected. Raw data — redact at export time.
      </p>

      {globalEnabled && (
        <>
          <div className="mt-3">
            <div className="text-xs font-medium text-gray-700">Enabled targets ({enabledTargets.length}):</div>
            {enabledTargets.length === 0 ? (
              <div className="text-xs text-gray-400 mt-1">None — toggle 📊 on a target card.</div>
            ) : (
              <ul className="text-xs text-gray-600 mt-1 space-y-0.5">
                {enabledTargets.map(id => (<li key={id}>· {id}</li>))}
              </ul>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={onOpenFolder}
              className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
            >
              Open folder
            </button>
            <button
              onClick={onExport}
              className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
            >
              Export for Qwen
            </button>
          </div>
        </>
      )}
    </div>
  );
};
```

- [ ] **Step 3: Wire it into the render tree**

Below the Prompt Cache card in the render output:

```jsx
<TrainingDataCard
  settings={settings}
  trainingTargets={trainingTargets}
  onToggleGlobal={async (v) => {
    await tauri.saveSetting?.('trainingCollectionEnabled', v)
      ?? tauri.invoke('save_setting', { key: 'trainingCollectionEnabled', value: v });
    // settings hook should refresh via existing listener; if not, force reload:
    reloadSettings?.();
  }}
  onOpenFolder={() => openTrainingFolder(petId)}
  onExport={() => openExportModal()}
/>
```

Placeholders `openTrainingFolder` and `openExportModal` are implemented in Tasks 8 and 13. For now stub them to `() => alert('TBD')` if needed; remove before Task 8/13.

Engineer note: this plan stubs with `alert` as a temporary. Do NOT commit with these alerts — they are replaced in later tasks.

- [ ] **Step 4: Manual UI check**

```bash
npm run tauri:dev
```

Navigate to SocialPage. Verify the Training Data Collection card appears below the Prompt Cache card. Toggle the global checkbox and confirm it persists across page reload.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SocialPage.jsx
git commit -m "feat(SocialPage): add Training Data Collection card with global toggle"
```

---

## Task 7: Per-target training toggle

**Files:**
- Modify: `src/pages/SocialPage.jsx` (target card render — around line 1548)

- [ ] **Step 1: Locate target card render**

The existing target card around line 1548 renders lurk mode and pause. Add a training toggle button in the same button row.

- [ ] **Step 2: Add toggle**

Near the lurk mode dropdown (around line 1548):

```jsx
{settings?.trainingCollectionEnabled && (
  <button
    title={trainingTargets[t.id] ? 'Training: ON' : 'Training: OFF'}
    onClick={() => setTargetTrainingEnabled(t.id, !trainingTargets[t.id])}
    className={`px-2 py-0.5 text-xs rounded border ${
      trainingTargets[t.id]
        ? 'border-emerald-500 text-emerald-700 bg-emerald-50'
        : 'border-gray-300 text-gray-400 bg-white'
    }`}
  >
    📊 {trainingTargets[t.id] ? '●' : '○'}
  </button>
)}
```

- [ ] **Step 3: Seed `trainingTargets` from persisted state on mount**

Training targets persist per-pet. Add to the settings/config load path:

```js
// On mount / after settings load:
const saved = settings?.trainingTargets || {};
setTrainingTargets(saved);
```

And when toggling, also persist:

```js
const setTargetTrainingEnabled = (target, enabled) => {
  emit('social-set-training-enabled', { target, enabled });
  setTrainingTargets(prev => {
    const next = { ...prev, [target]: enabled };
    tauri.invoke('save_setting', { key: 'trainingTargets', value: next });
    return next;
  });
};
```

- [ ] **Step 4: Manual UI check**

Enable global toggle. Verify the 📊 button appears on each target card. Click to toggle; check that the "Enabled targets" list in the main card updates in real-time. Reload the app — state should persist.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SocialPage.jsx
git commit -m "feat(SocialPage): per-target training whitelist toggle"
```

---

## Task 8: Stats display + Open folder button

**Files:**
- Modify: `src/pages/SocialPage.jsx`
- Modify: `src/utils/tauri.js` (if `openPath` wrapper doesn't exist yet)

- [ ] **Step 1: Add stats computation**

Above `TrainingDataCard`:

```jsx
const useTrainingStats = (petId, globalEnabled) => {
  const [stats, setStats] = useState({ count: 0, bytes: 0 });

  useEffect(() => {
    if (!globalEnabled || !petId) return;
    const date = new Date().toISOString().slice(0, 10);
    const path = `social/training/intent/${date}.jsonl`;
    tauri.workspaceRead(petId, path).then(text => {
      if (!text) return;
      const lines = text.split('\n').filter(Boolean);
      setStats({ count: lines.length, bytes: new Blob([text]).size });
    }).catch(() => { /* file not yet created */ });
  }, [petId, globalEnabled]);

  return stats;
};
```

Call in `TrainingDataCard`:

```jsx
const stats = useTrainingStats(petId, globalEnabled);
// ... in the JSX, before the buttons:
<div className="text-xs text-gray-500 mt-2">
  Today: {stats.count} traces · {(stats.bytes / 1024).toFixed(1)} KB
</div>
```

- [ ] **Step 2: Open folder**

Check if Tauri shell plugin's `openPath` is wrapped. Search:

```bash
grep -n "openPath\|shell.open\|open_folder" src/utils/tauri.js
```

If missing, add to `src/utils/tauri.js`:

```js
export const openPath = async (absolutePath) => {
  return invoke('open_path_in_finder', { path: absolutePath });
};
```

And Rust side — if no such command, add to `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn open_path_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&path).spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Register in .invoke_handler(tauri::generate_handler![ ..., open_path_in_finder, ])
```

- [ ] **Step 3: Hook into `onOpenFolder`**

```js
const openTrainingFolder = async (petId) => {
  const base = await tauri.invoke('get_workspace_path', { petId });
  await tauri.openPath(`${base}/social/training/intent`);
};
```

If `get_workspace_path` doesn't exist, reuse an existing path helper. Grep for how `workspace/` paths are resolved.

- [ ] **Step 4: Manual verification**

```bash
npm run tauri:dev
```

1. Enable global toggle.
2. Enable a target.
3. Run Intent eval; verify stats update ("Today: 1 traces · ~5 KB").
4. Click "Open folder"; Finder/Explorer should open to `.../social/training/intent/`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SocialPage.jsx src/utils/tauri.js src-tauri/src/lib.rs
git commit -m "feat(SocialPage): training stats display + Open folder button"
```

---

## Task 9: Export script — CLI skeleton + filtering

**Files:**
- Create: `scripts/export_intent_training.mjs`
- Create: `scripts/__tests__/export_intent_training.test.mjs`
- Create: `scripts/__tests__/fixtures/sample_traces.jsonl`

- [ ] **Step 1: Create fixtures**

`scripts/__tests__/fixtures/sample_traces.jsonl`:

```jsonl
{"schema_version":1,"id":"itr_a","ts":"2026-04-17T10:00:00Z","duration_ms":1000,"target_id":"11111","target_type":"group","pet_id":"p","provider":"openai_compatible","model":"Qwen3","label":"Intent:msg","system":"sys","tools":[{"type":"function","function":{"name":"social_read","description":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}],"messages":[{"role":"user","content":"hi"},{"role":"assistant","reasoning_content":"thinking","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"social_read","arguments":"{\"path\":\"a.md\"}"}}]},{"role":"tool","tool_call_id":"c1","content":"file body"},{"role":"assistant","reasoning_content":"done","content":null,"tool_calls":[{"id":"c2","type":"function","function":{"name":"write_intent_plan","arguments":"{\"willingness\":4}"}}]}],"status":"success","termination":"write_intent_plan","error":null,"iterations":2,"tool_calls_total":2}
{"schema_version":1,"id":"itr_b","ts":"2026-04-17T11:00:00Z","duration_ms":200,"target_id":"22222","target_type":"group","pet_id":"p","provider":"openai_compatible","model":"Qwen3","label":"Intent:idle","system":"sys","tools":[],"messages":[{"role":"user","content":"hi"}],"status":"failed","termination":"error","error":"LLM timeout","iterations":0,"tool_calls_total":0}
{"schema_version":1,"id":"itr_c","ts":"2026-04-18T09:00:00Z","duration_ms":500,"target_id":"11111","target_type":"group","pet_id":"p","provider":"openai_compatible","model":"Qwen3","label":"Intent:msg","system":"sys","tools":[],"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"reply directly","tool_calls":[]}],"status":"success","termination":"end_turn","error":null,"iterations":1,"tool_calls_total":0}
```

- [ ] **Step 2: Write CLI skeleton**

Create `scripts/export_intent_training.mjs`:

```js
#!/usr/bin/env node
/**
 * Export Intent training JSONL to Unsloth HF messages + tools format.
 *
 * Usage:
 *   node scripts/export_intent_training.mjs --input <dir> --output <file> [flags]
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function parseArgs(argv) {
  const args = {
    input: null, output: null,
    status: null, termination: null,
    redact: false,
    from: null, to: null,
    includeTargets: null, excludeTargets: null,
    template: 'hf-messages',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input': args.input = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
      case '--status': args.status = argv[++i]; break;
      case '--termination': args.termination = argv[++i]; break;
      case '--redact': args.redact = true; break;
      case '--from': args.from = argv[++i]; break;
      case '--to': args.to = argv[++i]; break;
      case '--include-targets': args.includeTargets = argv[++i].split(','); break;
      case '--exclude-targets': args.excludeTargets = argv[++i].split(','); break;
      case '--template': args.template = argv[++i]; break;
      default: if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.input) throw new Error('--input required');
  if (!args.output) throw new Error('--output required');
  return args;
}

export async function loadRecords(inputDir) {
  const files = (await readdir(inputDir)).filter(f => f.endsWith('.jsonl'));
  const records = [];
  for (const f of files) {
    const date = f.replace('.jsonl', ''); // YYYY-MM-DD
    const text = await readFile(join(inputDir, f), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        r._file_date = date;
        records.push(r);
      } catch (_) { /* skip malformed */ }
    }
  }
  return records;
}

export function applyFilters(records, args) {
  return records.filter(r => {
    if (args.status && r.status !== args.status) return false;
    if (args.termination && r.termination !== args.termination) return false;
    if (args.from && r._file_date < args.from) return false;
    if (args.to && r._file_date > args.to) return false;
    if (args.includeTargets && !args.includeTargets.includes(r.target_id)) return false;
    if (args.excludeTargets && args.excludeTargets.includes(r.target_id)) return false;
    return true;
  });
}

// Placeholder — implemented in Task 11
export function convertToHFMessages(record) {
  throw new Error('convertToHFMessages not yet implemented');
}

export async function main(argv) {
  const args = parseArgs(argv);
  const records = await loadRecords(args.input);
  const filtered = applyFilters(records, args);

  if (!existsSync(dirname(args.output))) {
    await mkdir(dirname(args.output), { recursive: true });
  }

  const outputLines = [];
  let droppedInvalid = 0;
  for (const r of filtered) {
    try {
      const hf = args.template === 'raw' ? r : convertToHFMessages(r);
      outputLines.push(JSON.stringify(hf));
    } catch (e) {
      droppedInvalid++;
    }
  }

  await writeFile(args.output, outputLines.join('\n') + (outputLines.length ? '\n' : ''));

  console.log(`Input records: ${records.length}`);
  console.log(`After filter:  ${filtered.length}`);
  console.log(`Output:        ${outputLines.length}  (dropped ${droppedInvalid} invalid)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Write tests for filtering**

Create `scripts/__tests__/export_intent_training.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, loadRecords, applyFilters } from '../export_intent_training.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures');

test('parseArgs reads flags', () => {
  const a = parseArgs(['--input', 'in', '--output', 'out', '--redact', '--status', 'success']);
  assert.equal(a.input, 'in');
  assert.equal(a.output, 'out');
  assert.equal(a.redact, true);
  assert.equal(a.status, 'success');
});

test('parseArgs errors on missing required', () => {
  assert.throws(() => parseArgs(['--input', 'x']), /--output required/);
});

test('loadRecords reads all JSONL in dir', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  assert.equal(records.length, 3);
  assert.equal(records[0].id, 'itr_a');
});

test('applyFilters by status', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const out = applyFilters(records, { status: 'success' });
  assert.equal(out.length, 2);
  assert.ok(out.every(r => r.status === 'success'));
});

test('applyFilters by termination', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const out = applyFilters(records, { termination: 'write_intent_plan' });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'itr_a');
});

test('applyFilters by target include/exclude', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  assert.equal(applyFilters(records, { includeTargets: ['11111'] }).length, 2);
  assert.equal(applyFilters(records, { excludeTargets: ['11111'] }).length, 1);
});

test('applyFilters by date window', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  assert.equal(applyFilters(records, { from: '2026-04-18' }).length, 1);
  assert.equal(applyFilters(records, { to: '2026-04-17' }).length, 2);
});
```

- [ ] **Step 4: Run tests — expect pass**

```bash
node --test scripts/__tests__/export_intent_training.test.mjs
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/export_intent_training.mjs scripts/__tests__/
git commit -m "feat(export): CLI skeleton with filtering + tests"
```

---

## Task 10: Redaction logic

**Files:**
- Modify: `scripts/export_intent_training.mjs`
- Modify: `scripts/__tests__/export_intent_training.test.mjs`

- [ ] **Step 1: Add redaction functions**

In `scripts/export_intent_training.mjs`, add near the top (below `loadRecords`):

```js
import { createHash } from 'node:crypto';

function shortHash(s, len = 8) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, len);
}

/**
 * Redact QQ numbers (5-12 digits) and known nicknames from a string.
 * Uses the provided mapping table (built up across records for stability).
 */
export function redactString(s, mapping) {
  if (typeof s !== 'string') return s;
  // QQ numbers
  return s.replace(/\b(\d{5,12})\b/g, (_, qq) => {
    if (!mapping.qq[qq]) mapping.qq[qq] = `U_${shortHash(qq, 8)}`;
    return mapping.qq[qq];
  });
}

/**
 * Apply redaction to all string fields in a record.
 * Returns a deep-copied record with redaction applied.
 * Updates `mapping` (shared across calls).
 */
export function redactRecord(record, mapping) {
  const copy = JSON.parse(JSON.stringify(record));
  copy.target_id = redactString(copy.target_id, mapping);
  copy.system = redactString(copy.system, mapping);
  for (const m of copy.messages || []) {
    if (typeof m.content === 'string') {
      m.content = redactString(m.content, mapping);
    }
    for (const tc of m.tool_calls || []) {
      if (typeof tc.function?.arguments === 'string') {
        tc.function.arguments = redactString(tc.function.arguments, mapping);
      }
    }
  }
  return copy;
}

export function createRedactionMapping() {
  return { qq: {}, nick: {}, group: {} };
}
```

- [ ] **Step 2: Wire redaction into main**

In `main`:

```js
  const mapping = createRedactionMapping();
  const filtered = applyFilters(records, args)
    .map(r => args.redact ? redactRecord(r, mapping) : r);
```

After writing output, dump the mapping if `--redact`:

```js
  if (args.redact) {
    const mapPath = join(dirname(args.output), 'redaction_map.json');
    await writeFile(mapPath, JSON.stringify(mapping, null, 2));
    console.log(`Redaction map: ${mapPath}  (KEEP LOCAL, add to .gitignore)`);
  }
```

- [ ] **Step 3: Write tests for redaction**

Append to `scripts/__tests__/export_intent_training.test.mjs`:

```js
import { redactString, redactRecord, createRedactionMapping } from '../export_intent_training.mjs';

test('redactString replaces QQ numbers with stable placeholders', () => {
  const m = createRedactionMapping();
  const out1 = redactString('Hello 123456789 and 987654321', m);
  const out2 = redactString('Again 123456789', m);
  assert.match(out1, /^Hello U_[a-f0-9]{8} and U_[a-f0-9]{8}$/);
  // Same QQ → same placeholder
  const first = out1.match(/U_[a-f0-9]{8}/)[0];
  assert.ok(out2.includes(first));
});

test('redactRecord removes raw QQ from all fields', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const mapping = createRedactionMapping();
  const r = records.find(r => r.id === 'itr_a');
  r.system = 'system mentions 123456789';
  r.messages[0].content = 'user 123456789 says hi';
  const redacted = redactRecord(r, mapping);
  // No raw 123456789 anywhere
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('123456789'), false);
});
```

- [ ] **Step 4: Run tests — expect pass**

```bash
node --test scripts/__tests__/export_intent_training.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add scripts/export_intent_training.mjs scripts/__tests__/
git commit -m "feat(export): add redaction (QQ numbers) + stable mapping table"
```

---

## Task 11: HF messages format conversion

**Files:**
- Modify: `scripts/export_intent_training.mjs`
- Modify: `scripts/__tests__/export_intent_training.test.mjs`

Replace the placeholder `convertToHFMessages`.

- [ ] **Step 1: Implement converter**

In `scripts/export_intent_training.mjs`, replace the placeholder:

```js
export function convertToHFMessages(record) {
  const messages = [];
  // 1. System
  if (record.system) {
    messages.push({ role: 'system', content: record.system });
  }

  // 2. Body — prepend user, then walk assistant + tool
  // Build tool_call_id → name map first (for tool role 'name' inference)
  const idToName = {};
  for (const m of record.messages || []) {
    for (const tc of m.tool_calls || []) {
      const id = tc.id || tc.tool_call_id;
      const name = tc.function?.name;
      if (id && name) idToName[id] = name;
    }
  }

  for (const m of record.messages || []) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      // Build content with <think> prefix
      const think = m.reasoning_content
        ? `<think>\n${m.reasoning_content}\n</think>`
        : '';
      const body = m.content ?? '';
      const content = think && body ? `${think}\n${body}` : (think || body);

      // Normalize tool_calls
      const toolCalls = (m.tool_calls || []).map(tc => {
        const argsRaw = tc.function?.arguments;
        let args = argsRaw;
        if (typeof argsRaw === 'string') {
          args = JSON.parse(argsRaw); // throws on bad JSON → caller drops record
        }
        return {
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: args },
        };
      });

      const msg = { role: 'assistant', content };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: m.tool_call_id,
        name: idToName[m.tool_call_id] || 'unknown_tool',
        content: m.content ?? '',
      });
    }
  }

  // 3. Tools schema — normalize to HF style
  const tools = (record.tools || []).map(t => {
    if (t.type === 'function' && t.function) return t;
    return {
      type: 'function',
      function: {
        name: t.name || '',
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    };
  });

  return { messages, tools };
}
```

- [ ] **Step 2: Write tests**

Append to `scripts/__tests__/export_intent_training.test.mjs`:

```js
import { convertToHFMessages } from '../export_intent_training.mjs';

test('convertToHFMessages wraps reasoning in <think> and parses arguments', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const r = records.find(r => r.id === 'itr_a');
  const hf = convertToHFMessages(r);

  // system present
  assert.equal(hf.messages[0].role, 'system');
  // user
  assert.equal(hf.messages[1].role, 'user');
  // first assistant has <think>
  const firstA = hf.messages[2];
  assert.equal(firstA.role, 'assistant');
  assert.match(firstA.content, /<think>[\s\S]*<\/think>/);
  // arguments parsed to object
  assert.equal(typeof firstA.tool_calls[0].function.arguments, 'object');
  assert.equal(firstA.tool_calls[0].function.arguments.path, 'a.md');
  // tool role has name filled
  const toolMsg = hf.messages[3];
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.name, 'social_read');
  assert.equal(toolMsg.tool_call_id, 'c1');
});

test('convertToHFMessages normalizes tools schema to HF shape', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const r = records.find(r => r.id === 'itr_a');
  const hf = convertToHFMessages(r);
  assert.equal(hf.tools[0].type, 'function');
  assert.equal(hf.tools[0].function.name, 'social_read');
  assert.ok(hf.tools[0].function.parameters);
});

test('convertToHFMessages handles record without assistant reasoning', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const r = records.find(r => r.id === 'itr_c'); // has plain assistant content, no reasoning
  const hf = convertToHFMessages(r);
  const assistant = hf.messages.find(m => m.role === 'assistant');
  assert.equal(assistant.content, 'reply directly');
  assert.equal(assistant.content.includes('<think>'), false);
});
```

- [ ] **Step 3: Run tests — expect pass**

```bash
node --test scripts/__tests__/export_intent_training.test.mjs
```

- [ ] **Step 4: Commit**

```bash
git add scripts/export_intent_training.mjs scripts/__tests__/
git commit -m "feat(export): convert to Unsloth HF messages + tools format"
```

---

## Task 12: Schema validation + drop-reason summary

**Files:**
- Modify: `scripts/export_intent_training.mjs`
- Modify: `scripts/__tests__/export_intent_training.test.mjs`

Add strict validation (drop records with bad JSON args, broken tool_call_id links, or missing `<think>` blocks per Unsloth FunctionGemma convention).

- [ ] **Step 1: Add validator**

In `scripts/export_intent_training.mjs`:

```js
/**
 * Validate an HF messages record per Unsloth convention.
 * Returns { valid: boolean, reason?: string }.
 *
 * Rules:
 *   - Every tool message has a matching earlier assistant tool_call with same id
 *   - Every assistant with tool_calls must have non-empty <think> block (per Unsloth FunctionGemma convention)
 *   - All tool_calls[].function.arguments must be parsed objects (not strings)
 */
export function validateHFRecord(hf) {
  const toolCallIds = new Set();
  for (const m of hf.messages) {
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        if (!/<think>[\s\S]*?<\/think>/.test(m.content || '')) {
          return { valid: false, reason: 'assistant_with_tool_calls_missing_think' };
        }
        for (const tc of m.tool_calls) {
          if (typeof tc.function?.arguments !== 'object') {
            return { valid: false, reason: 'tool_call_arguments_not_object' };
          }
          toolCallIds.add(tc.id);
        }
      }
    } else if (m.role === 'tool') {
      if (!toolCallIds.has(m.tool_call_id)) {
        return { valid: false, reason: 'tool_message_without_matching_call' };
      }
    }
  }
  return { valid: true };
}
```

- [ ] **Step 2: Wire into main + summary**

Replace the main-loop `try` block:

```js
  const droppedReasons = {};
  const outputLines = [];
  for (const r of filteredRecords) {
    let hf;
    try {
      hf = args.template === 'raw' ? r : convertToHFMessages(r);
    } catch (e) {
      droppedReasons.conversion_error = (droppedReasons.conversion_error || 0) + 1;
      continue;
    }
    if (args.template !== 'raw') {
      const v = validateHFRecord(hf);
      if (!v.valid) {
        droppedReasons[v.reason] = (droppedReasons[v.reason] || 0) + 1;
        continue;
      }
    }
    outputLines.push(JSON.stringify(hf));
  }

  // ... write output file ...

  console.log(`Input records:  ${records.length}`);
  console.log(`After filter:   ${filteredRecords.length}`);
  console.log(`Output:         ${outputLines.length}`);
  if (Object.keys(droppedReasons).length) {
    console.log('Dropped:');
    for (const [r, n] of Object.entries(droppedReasons)) {
      console.log(`  ${r}: ${n}`);
    }
  }
```

- [ ] **Step 3: Write tests**

```js
import { validateHFRecord } from '../export_intent_training.mjs';

test('validateHFRecord rejects assistant with tool_calls but no <think>', () => {
  const v = validateHFRecord({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'no think here',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: {} } }] },
    ],
    tools: [],
  });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'assistant_with_tool_calls_missing_think');
});

test('validateHFRecord rejects tool message without matching call', () => {
  const v = validateHFRecord({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'tool', tool_call_id: 'missing', name: 'f', content: 'r' },
    ],
    tools: [],
  });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'tool_message_without_matching_call');
});

test('validateHFRecord accepts well-formed record', () => {
  const v = validateHFRecord({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant',
        content: '<think>\nplan\n</think>',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: { x: 1 } } }] },
      { role: 'tool', tool_call_id: 'a', name: 'f', content: 'r' },
    ],
    tools: [],
  });
  assert.equal(v.valid, true);
});
```

- [ ] **Step 4: Run tests**

```bash
node --test scripts/__tests__/export_intent_training.test.mjs
```

All 13+ tests pass.

- [ ] **Step 5: Integration run against fixtures**

```bash
mkdir -p /tmp/intent-export-test
node scripts/export_intent_training.mjs \
  --input scripts/__tests__/fixtures/ \
  --output /tmp/intent-export-test/out.jsonl \
  --status success --termination write_intent_plan
cat /tmp/intent-export-test/out.jsonl | head -1 | python3 -m json.tool
```

Expected: 1 HF-formatted record with `<think>` block and properly-nested tool_calls.

- [ ] **Step 6: Commit**

```bash
git add scripts/export_intent_training.mjs scripts/__tests__/
git commit -m "feat(export): schema validation + drop-reason summary"
```

---

## Task 13: Rust command + UI export button

**Files:**
- Create: `src-tauri/src/commands/training_export.rs`
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src/pages/SocialPage.jsx` (wire Export button + modal)

- [ ] **Step 1: Create Rust command**

`src-tauri/src/commands/training_export.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Deserialize)]
pub struct ExportOptions {
    pub pet_id: String,
    pub output_path: String,
    pub redact: bool,
    pub status: Option<String>,
    pub termination: Option<String>,
}

#[derive(Serialize)]
pub struct ExportSummary {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

#[tauri::command]
pub async fn run_training_export(
    app: tauri::AppHandle,
    options: ExportOptions,
) -> Result<ExportSummary, String> {
    // Resolve workspace path (project already has a helper — reuse)
    let base = crate::workspace::get_workspace_root(&app, &options.pet_id)
        .map_err(|e| e.to_string())?;
    let input_dir = base.join("social").join("training").join("intent");
    let input = input_dir.to_string_lossy().to_string();

    // Resolve script path (bundled with app or use dev path)
    let script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("scripts")
        .join("export_intent_training.mjs");
    let script_str = script.to_string_lossy().to_string();

    let mut cmd = Command::new("node");
    cmd.arg(script_str)
        .arg("--input").arg(&input)
        .arg("--output").arg(&options.output_path);

    if options.redact { cmd.arg("--redact"); }
    if let Some(s) = &options.status { cmd.arg("--status").arg(s); }
    if let Some(t) = &options.termination { cmd.arg("--termination").arg(t); }

    let output = cmd.output().map_err(|e| format!("spawn failed: {e}"))?;

    Ok(ExportSummary {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}
```

Engineer note: if `crate::workspace::get_workspace_root` doesn't exist with that exact name, search in `src-tauri/src/workspace.rs` or `engine.rs` for the actual function that resolves the workspace root. Use that.

Also: `scripts/` bundling via `tauri::path::resource_dir` requires adding the folder to `tauri.conf.json` `bundle.resources`. Check the current `tauri.conf.json` for existing resource entries and follow the same pattern:

```json
// tauri.conf.json
{
  "bundle": {
    "resources": ["scripts/**/*"]
  }
}
```

For dev mode where `resource_dir` points at a different path, fall back to the project root:

```rust
// If script doesn't exist at resource_dir path (dev mode), try project-relative
if !script.exists() {
    script = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .join("scripts")
        .join("export_intent_training.mjs");
}
```

- [ ] **Step 2: Register command in `lib.rs`**

Find the existing `tauri::generate_handler![...]` macro call. Add `run_training_export` to the list:

```rust
mod commands {
    pub mod training_export;
}

// in the invoke_handler:
.invoke_handler(tauri::generate_handler![
    // ... existing ...
    commands::training_export::run_training_export,
])
```

- [ ] **Step 3: Add Tauri wrapper + UI modal in SocialPage**

Add to `src/utils/tauri.js`:

```js
export const runTrainingExport = async (options) => {
  return invoke('run_training_export', { options });
};
```

Add to `src/pages/SocialPage.jsx`:

```jsx
const [exportModalOpen, setExportModalOpen] = useState(false);
const [exportOptions, setExportOptions] = useState({
  redact: true,
  status: 'success',
  termination: 'write_intent_plan',
});
const [exportResult, setExportResult] = useState(null);

const openExportModal = () => setExportModalOpen(true);

const runExport = async () => {
  const homeDir = await tauri.invoke('get_home_dir'); // or reuse existing helper
  const outputPath = `${homeDir}/Downloads/qwen_intent_${Date.now()}.jsonl`;
  const result = await tauri.runTrainingExport({
    pet_id: petId,
    output_path: outputPath,
    redact: exportOptions.redact,
    status: exportOptions.status,
    termination: exportOptions.termination,
  });
  setExportResult({ ...result, outputPath });
};
```

And the modal JSX:

```jsx
{exportModalOpen && (
  <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
    <div className="bg-white rounded-lg p-6 max-w-md">
      <h3 className="font-semibold mb-3">Export Intent Training Data</h3>

      <label className="flex items-center gap-2 text-sm mt-2">
        <input type="checkbox" checked={exportOptions.redact}
          onChange={(e) => setExportOptions({ ...exportOptions, redact: e.target.checked })} />
        Redact QQ numbers (recommended)
      </label>
      <label className="flex items-center gap-2 text-sm mt-2">
        <input type="checkbox" checked={exportOptions.status === 'success'}
          onChange={(e) => setExportOptions({ ...exportOptions, status: e.target.checked ? 'success' : null })} />
        Only successful evals
      </label>

      {exportResult && (
        <pre className="mt-3 text-xs bg-gray-100 p-2 rounded overflow-auto max-h-40">
          {exportResult.stdout}
          {exportResult.stderr && `\nErrors:\n${exportResult.stderr}`}
        </pre>
      )}

      <div className="flex gap-2 mt-4">
        <button onClick={runExport}
          className="px-3 py-1 bg-blue-500 text-white rounded text-sm">Run</button>
        <button onClick={() => { setExportModalOpen(false); setExportResult(null); }}
          className="px-3 py-1 border rounded text-sm">Close</button>
      </div>
    </div>
  </div>
)}
```

Replace the earlier `alert('TBD')` placeholder from Task 6 with this flow.

- [ ] **Step 4: Manual verification**

```bash
npm run tauri:dev
```

1. Have some Intent traces already (run the agent a while with training enabled).
2. Click "Export for Qwen" → modal opens.
3. Keep defaults (redact ON, success only) → Run.
4. Verify output file appears in `~/Downloads/qwen_intent_*.jsonl`.
5. Verify `cat` of the file shows Unsloth-ready records with no raw QQ numbers.
6. Verify `redaction_map.json` exists next to output.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/training_export.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json src/utils/tauri.js src/pages/SocialPage.jsx
git commit -m "feat(export): Rust command + UI button to run export from SocialPage"
```

---

## Final verification

- [ ] **End-to-end test**

Full flow from scratch:

1. Reset workspace (remove old `social/training/` data or use a fresh petId).
2. Start app, enable global collection, enable training on one test group.
3. Chat in the test group to trigger multiple Intent evals (mix success + failure if possible — e.g. temporarily kill LLM API briefly to induce failure).
4. After ~20 evals:
   - `wc -l ~/Library/Application\ Support/com.petgpt.app/workspace/<pet>/social/training/intent/$(date +%Y-%m-%d).jsonl` should match the count shown in the UI stats.
   - Click "Export for Qwen" → modal → Run → verify output file has HF records.
5. Open exported file in Python:
   ```python
   import json
   with open('/path/to/qwen_intent_*.jsonl') as f:
       records = [json.loads(l) for l in f if l.strip()]
   assert all('messages' in r and 'tools' in r for r in records)
   assert all(any('<think>' in (m.get('content') or '') for m in r['messages'] if m.get('tool_calls'))
              for r in records)
   print(f'{len(records)} valid records ready for Unsloth')
   ```

- [ ] **Run full test suite**

```bash
node --test src/utils/__tests__/intentTraining.test.mjs
node --test scripts/__tests__/export_intent_training.test.mjs
npm run lint
```

All pass.

- [ ] **PR prep**

```bash
git log --oneline main..HEAD
```

Should show 13 commits, one per task (plus adapter + module setup).

- [ ] **Optional: push + PR**

```bash
git push -u origin feature/intent-training
gh pr create --title "feat: Intent training data collection for Qwen fine-tuning" --body "$(cat <<'EOF'
## Summary
- New \`onTrace\` callback in callLLMWithTools captures full Intent trajectories
- Per-target opt-in UI toggle in SocialPage; global kill switch in settings
- Export script converts raw JSONL → Unsloth HF messages + tools format with optional QQ redaction
- Rust command + UI button to run export with one click

## Test plan
- [ ] Intent traces append to \`social/training/intent/{date}.jsonl\` only when both global + per-target toggle are on
- [ ] Failed/partial/timeout evals also captured with \`status\` tag
- [ ] Export button produces valid HF records with \`<think>\` blocks and parsed tool_calls
- [ ] Redaction removes raw QQ numbers; mapping table written locally

Spec: [docs/superpowers/specs/2026-04-17-intent-training-data-collection-design.md](docs/superpowers/specs/2026-04-17-intent-training-data-collection-design.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the implementing engineer

- **TDD discipline**: don't skip the "run test and watch it fail" step — it verifies the test is actually exercising the code.
- **Lint as you go**: `npm run lint` catches most style issues before commit.
- **Worktree cleanup**: after merge, `git worktree remove .worktrees/intent-training` + `git branch -d feature/intent-training`.
- **Do not**: refactor unrelated code, add error handling beyond what the tasks specify, or introduce TypeScript into JS files.
- **If a task step references a function/file that doesn't exist as written**, search the codebase for the actual name (naming conventions evolve). Don't invent a new utility — use what's there.
- **Manual verification in Task 4 step 5 is load-bearing**: the unit tests for `callLLMWithTools.onTrace` in Task 3 are optional if mocking is expensive; integration via Intent loop + inspecting the JSONL is the real validation.
