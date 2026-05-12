# Social Agent Prompt Cache Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-pet toggle that controls whether OpenAI-compatible LLM requests include `prompt_cache_key` + `prompt_cache_retention`, plus per-call `usage` log entries and a session cache-stats panel in SocialPage.

**Architecture:** A new `src/utils/promptCache.js` provides pure helpers (cache key + log-line formatter + scope check). The openai-compatible adapter injects params when `options.explicitCache` is true. `callLLMWithTools` gains an `onUsageLogged(record)` callback so each LLM call emits a unified `usage` record. `socialAgent.js` wires all call sites to pass `options.explicitCache` + `options.cacheKey` and to call `addLog('usage', …)` via the callback. SocialPage accumulates stats from `social-log-entry` events of level `usage` and clears them on a `social-cache-stats-reset` event that the agent emits on start.

**Tech Stack:** React 19 + Vite + Tailwind v4 (frontend), plain JS/JSX, Tauri events (`@tauri-apps/api/event`), existing adapter pattern in `src/utils/llm/adapters/`.

**Spec:** [docs/superpowers/specs/2026-04-15-social-agent-prompt-cache-toggle-design.md](../specs/2026-04-15-social-agent-prompt-cache-toggle-design.md)

---

### Task 1: Create `src/utils/promptCache.js` pure helper module

**Files:**
- Create: `src/utils/promptCache.js`

- [ ] **Step 1: Create the file with three pure helpers**

Write `src/utils/promptCache.js`:

```js
/**
 * promptCache.js — 纯辅助函数，不持有状态
 *
 * 服务于 Social Agent 的 OpenAI 显式 prompt caching 开关：
 * - buildCacheKey：生成 prompt_cache_key
 * - shouldUseExplicitCache：判断当前 apiFormat + 开关状态是否应传缓存参数
 * - formatUsageLogMessage：把 usage 记录格式化为一行 addLog 文本
 */

/**
 * 将 label（如 "Intent:msg" / "Compress:daily"）规范化为 snake_case 字符串，
 * 用于 prompt_cache_key 组装。
 */
function normalizeLabel(label) {
  return String(label || 'unknown')
    .toLowerCase()
    .replace(/:/g, '_')
    .replace(/[^a-z0-9_]/g, '_');
}

/**
 * 组装 OpenAI prompt_cache_key。
 * 格式：petgpt-{petId}-{targetId|global}-{label_snake}
 */
export function buildCacheKey(petId, targetId, label) {
  const pet = String(petId || 'unknown');
  const tgt = targetId ? String(targetId) : 'global';
  return `petgpt-${pet}-${tgt}-${normalizeLabel(label)}`;
}

/**
 * 判断本次调用是否应向 OpenAI 兼容 adapter 传显式缓存参数。
 * - socialConfig.explicitPromptCache 缺失时按 true 解读（向后兼容）
 * - 只对 OpenAI 兼容 adapter 生效；anthropic_native 和 gemini_official 不受影响
 */
export function shouldUseExplicitCache(socialConfig, apiFormat) {
  const enabled = socialConfig?.explicitPromptCache ?? true;
  if (!enabled) return false;
  return apiFormat !== 'gemini_official' && apiFormat !== 'anthropic_native';
}

/**
 * 把一条 usage 记录格式化为单行 addLog 文本。
 *
 * 输入: { label, model, inputTokens, outputTokens, cachedTokens, durationMs }
 * 输出示例:
 *   "Intent:msg  in=5120 (cached 4820, 94%) out=240  3.2s  gpt-4o"
 *   "Reply       in=4980 (cached 0)         out=185  2.1s  gpt-4o"
 */
export function formatUsageLogMessage({ label, model, inputTokens, outputTokens, cachedTokens, durationMs }) {
  const inTok = inputTokens ?? 0;
  const outTok = outputTokens ?? 0;
  const cached = cachedTokens ?? 0;
  const sec = ((durationMs ?? 0) / 1000).toFixed(1);
  const cachedPart = cached > 0
    ? `(cached ${cached}, ${Math.round((cached / Math.max(inTok, 1)) * 100)}%)`
    : `(cached 0)`;
  return `${label}  in=${inTok} ${cachedPart} out=${outTok}  ${sec}s  ${model || ''}`.trim();
}
```

- [ ] **Step 2: Sanity-check formatting by hand**

Verify mentally / by eye that the three functions produce the strings described in the spec section "UI 每次调用日志".

- [ ] **Step 3: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors in `src/utils/promptCache.js`.

- [ ] **Step 4: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/utils/promptCache.js
git commit -m "feat: add promptCache helpers (key, scope check, log formatter)"
```

---

### Task 2: Inject `prompt_cache_key` + `prompt_cache_retention` in openai-compatible adapter

**Files:**
- Modify: `src/utils/llm/adapters/openaiCompatible.js:169-194`

- [ ] **Step 1: Update `buildRequest` to read cache options and inject into body**

Replace the body-build section in `src/utils/llm/adapters/openaiCompatible.js` (around line 173-184):

```js
  const body = {
    model,
    messages: convertedMessages,
    stream: options.stream || false,
    ...(options.temperature !== undefined && { temperature: options.temperature })
  };

  // 添加工具支持
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }

  // 显式 prompt caching（仅 OpenAI 官方识别；兼容网关如不识别可能报错）
  // 由上游 socialAgent 通过 options.explicitCache + options.cacheKey 控制。
  if (options.explicitCache && options.cacheKey) {
    body.prompt_cache_key = options.cacheKey;
    body.prompt_cache_retention = '24h';
  }

  return {
    endpoint: `${url}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body
  };
};
```

- [ ] **Step 2: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/utils/llm/adapters/openaiCompatible.js
git commit -m "feat(openai): inject prompt_cache_key + retention when explicitCache set"
```

---

### Task 3: Add `onUsageLogged` callback to `callLLMWithTools`

**Files:**
- Modify: `src/utils/mcp/toolExecutor.js` (multiple spots around lines 489-830)

`callLLMWithTools` writes `appendUsageLog(...)` in four places (success return at ~591, two error paths ~741 and ~809, final outer catch ~824). After each, also call the new `onUsageLogged(record)` if provided.

- [ ] **Step 1: Add `onUsageLogged` to the destructured options**

Find the destructure block starting near line 489 in `src/utils/mcp/toolExecutor.js`. Add `onUsageLogged` to it:

```js
  mcpTools,
  options = {},
  onToolCall,
  onToolResult,
  onLLMText,
  toolCallFilter,
  toolArgTransform,
  builtinToolContext,
  stopAfterTool,
  usageLabel,
  usageTarget,
  usagePetId,
  maxIterations,
  onUsageLogged,    // optional (record) => void — fires after appendUsageLog with the same record
}) => {
```

- [ ] **Step 2: Extract a local helper and call it next to every `appendUsageLog`**

Inside the function body (just after `const MAX_TOTAL_ITERATIONS = maxIterations ?? 100; let stopEarly = false;`), add a helper:

```js
  const _writeUsage = (record) => {
    const _petId = usagePetId || builtinToolContext?.petId;
    if (!_petId || !usageLabel) return;
    try { appendUsageLog(_petId, record); } catch (_) { /* ignore */ }
    if (typeof onUsageLogged === 'function') {
      try { onUsageLogged(record); } catch (_) { /* ignore */ }
    }
  };
```

Then find every existing `appendUsageLog(_petId, {...})` call in this file and replace the whole `if (usageLabel && _petId) { appendUsageLog(...) }` block with:

```js
  _writeUsage({
    ts: new Date().toISOString(),
    label: usageLabel,
    target: usageTarget || '',
    model: model || '',
    apiFormat: apiFormat || '',
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cachedTokens: totalUsage.cachedTokens,
    toolCalls: toolCallHistory.length,
    iterations: totalIterations,
    durationMs: Date.now() - usageStartTime,
  });
```

There are four sites total — normal return (~591), two error-path sites (~741, ~809) and the final fallback (~824). Locate each by searching for `appendUsageLog(` in this file. Keep the exact same record shape; only swap the two-line guard + call into `_writeUsage(...)`.

- [ ] **Step 3: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/utils/mcp/toolExecutor.js
git commit -m "feat(toolExecutor): add onUsageLogged callback to callLLMWithTools"
```

---

### Task 4: Add UI setting — Explicit Prompt Cache checkbox

**Files:**
- Modify: `src/pages/SocialPage.jsx` (settings panel)

- [ ] **Step 1: Locate the settings area**

Open `src/pages/SocialPage.jsx` and find the block that renders the bot-QQ / owner-QQ / ownerName input fields (search for `value={config.botQQ}` near line 805). Those fields form a settings panel that `saveSocialConfig` persists.

- [ ] **Step 2: Add a checkbox immediately after the owner-related fields**

Insert a new block near the existing settings fields — pick a natural spot right after the `ownerQQ` / `ownerName` / `ownerSecret` inputs and before the MCP / watched-targets blocks. The checkbox should bind to `config.explicitPromptCache` (default true when missing):

```jsx
<div className="mt-4 border-t border-slate-200 pt-4">
  <label className="flex items-start gap-2 text-sm select-none cursor-pointer">
    <input
      type="checkbox"
      className="mt-0.5"
      checked={config.explicitPromptCache ?? true}
      onChange={(e) => setConfig(prev => ({ ...prev, explicitPromptCache: e.target.checked }))}
    />
    <span className="flex-1">
      <div className="font-medium text-slate-700">启用显式 Prompt Cache（OpenAI 类 API）</div>
      <div className="text-xs text-slate-500 leading-relaxed">
        向 OpenAI 发送 prompt_cache_key + 24h 缓存保留参数，提升多轮调用的缓存命中率。
        Anthropic 始终启用，Gemini 依赖服务端自动缓存。
        如果你用的兼容网关对未知字段报错，请关闭此开关。
      </div>
    </span>
  </label>
</div>
```

- [ ] **Step 3: Verify `saveSocialConfig` already persists the whole config**

Existing calls to `saveSocialConfig(selectedPetId, config)` write the complete `config` object. `explicitPromptCache` as a new top-level field will be persisted automatically. No additional plumbing needed. Confirm by reading the two `saveSocialConfig` call sites (search for `saveSocialConfig(selectedPetId`).

- [ ] **Step 4: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/pages/SocialPage.jsx
git commit -m "feat(SocialPage): add explicitPromptCache setting checkbox"
```

---

### Task 5: Thread `explicitCache` + `cacheKey` + `onUsageLogged` through tool-loop call sites

**Files:**
- Modify: `src/utils/socialAgent.js` at each `callLLMWithTools` call

There are four tool-loop call sites (with `usageLabel`):
- Intent:msg — `usageLabel: 'Intent:msg'` (~line 2727)
- Reply / Observer — `usageLabel: role === 'observer' ? 'Observer' : 'Reply'` (~line 1078)
- Compress:daily (~line 1433)
- Compress:global (~line 1480)
- MdOrganizer (~line 2268)

Plus Intent:idle path if it exists separately — grep shows only `Intent:msg` was listed earlier but the label includes `'Intent:idle'` somewhere; verify by searching.

- [ ] **Step 1: Import the new helpers at the top of `src/utils/socialAgent.js`**

Add near the other `import` lines at the top:

```js
import { buildCacheKey, shouldUseExplicitCache, formatUsageLogMessage } from './promptCache';
```

- [ ] **Step 2: Add a `recordUsageLog` helper inside `src/utils/socialAgent.js`**

Right after the existing `addLog(...)` function definition (around line 131), add:

```js
/**
 * 把 usage record 转成一条 addLog('usage') 行；供 onUsageLogged 回调直接使用。
 */
function logUsageRecord(record) {
  if (!record) return;
  const message = formatUsageLogMessage({
    label: record.label,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens,
    durationMs: record.durationMs,
  });
  addLog('usage', message, record, record.target || undefined);
}
```

- [ ] **Step 3: Wire each `callLLMWithTools` call to pass the new options**

At each call site (search for `usageLabel:` in `src/utils/socialAgent.js`), locate the `callLLMWithTools({ ... })` args object and **add three fields** to it:

```js
  options: {
    ...options,                       // keep existing
    explicitCache: shouldUseExplicitCache(config, apiFormat),
    cacheKey: buildCacheKey(config.petId, target, usageLabel),
  },
  onUsageLogged: logUsageRecord,
```

If the call site already has `options: {...}`, merge the two new fields into that object (don't overwrite existing `temperature`, `tools`, etc.).

Apply this to all five call sites:
1. Intent (message path + idle path if both exist)
2. Reply
3. Observer
4. Compress:daily
5. Compress:global
6. MdOrganizer

Use the `usageLabel` in-scope at each site for both the log and the cache key. For call sites whose target may be empty string (Compress:global), pass the empty/undefined value — `buildCacheKey` already substitutes `'global'`.

For the `apiFormat` passed to `shouldUseExplicitCache`, use whichever variable is already in scope at that call site (most sites already have `apiFormat` as a local binding from earlier in the function).

- [ ] **Step 4: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/utils/socialAgent.js
git commit -m "feat(socialAgent): pass explicit cache opts + usage log callback to tool loop"
```

---

### Task 6: Wire Vision direct `callLLM` call

**Files:**
- Modify: `src/utils/socialAgent.js:385-411` (Vision call)

- [ ] **Step 1: Extend the Vision `callLLM` options**

In the Vision function (search for `// Log vision usage` around line 395), just before the `await callLLM({...})` call, add a `label` and compute the cache key. Replace the existing `callLLM` args to include `options.explicitCache` + `options.cacheKey`:

```js
  const label = 'Vision';
  const _visionStart = Date.now();
  const result = await callLLM({
    messages,
    apiFormat: visionLLMConfig.apiFormat,
    apiKey: visionLLMConfig.apiKey,
    model: visionLLMConfig.modelName,
    baseUrl: visionLLMConfig.baseUrl,
    options: {
      temperature: 0.2,
      explicitCache: shouldUseExplicitCache(config, visionLLMConfig.apiFormat),
      cacheKey: buildCacheKey(petId, '', label),
    },
    conversationId: `vision-desc-${Date.now()}`,
  });
```

Note: `config` is the social config in scope at Vision callers; if the Vision helper is invoked without access to `config`, pass `socialConfig` through from the caller (it already has `petId`; add one more param). Grep callers of the Vision helper and thread the socialConfig if needed.

- [ ] **Step 2: After the existing `appendUsageLog`, also emit an addLog('usage')**

Right after the existing `appendUsageLog(petId, {...})` block in the Vision function (around line 399-404), add:

```js
    logUsageRecord({
      ts: new Date().toISOString(),
      label,
      target: '',
      model: visionLLMConfig.modelName || '',
      apiFormat: visionLLMConfig.apiFormat || '',
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedTokens: u.cachedTokens,
      toolCalls: 0,
      iterations: 1,
      durationMs: Date.now() - _visionStart,
    });
```

- [ ] **Step 3: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/utils/socialAgent.js
git commit -m "feat(socialAgent): log Vision usage via addLog + pass cache opts"
```

---

### Task 7: Emit `social-cache-stats-reset` when an agent starts

**Files:**
- Modify: `src/utils/socialAgent.js` (agent start entry)

- [ ] **Step 1: Locate the agent start function**

Search for the function that is called when SocialPage's "start" button fires — typically named `startSocialAgent`, `startAgent`, or similar. Use:

```bash
cd /Users/jules/Documents/Projects/PetGPT && grep -n "export.*function.*start\|export const start" src/utils/socialAgent.js
```

- [ ] **Step 2: Emit the reset event at the top of the start function**

Inside the start function body (near where `sentMessagesCache.clear()` / `targetNamesCache.clear()` happen, around line 3494-3500), add:

```js
  // UI 侧累计统计需要清零
  tauri.emitToLabels(['social', 'management'], 'social-cache-stats-reset', { petId: config.petId });
```

Use the same `tauri.emitToLabels` helper that `addLog` already uses — import it from the same module if not already in scope.

- [ ] **Step 3: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/utils/socialAgent.js
git commit -m "feat(socialAgent): emit social-cache-stats-reset on agent start"
```

---

### Task 8: Render `usage` log entries + filter toggle in SocialPage

**Files:**
- Modify: `src/pages/SocialPage.jsx` (log renderer around line 1700 + filter controls)

- [ ] **Step 1: Add a renderer branch for `log.level === 'usage'`**

In `src/pages/SocialPage.jsx`, find the log-rendering switch in `reversedFilteredLogs.map(...)` (around line 1700). Add a new branch **before** the fallback `div`:

```jsx
                  ) : log.level === 'usage' ? (
                    <div key={log.id ?? log.timestamp} className="py-0.5 text-slate-600">
                      <span className="text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      {' '}
                      <span className="font-semibold text-emerald-600">[usage]</span>
                      {log.target && logFilter === 'all' && (
                        <span className="text-cyan-500 ml-1">[{log.target}]</span>
                      )}
                      {' '}
                      <span className="font-mono">{log.message}</span>
                    </div>
                  ) : log.level === 'subagent' ? (
```

- [ ] **Step 2: Add a `showUsage` state + filter chip**

Find the existing filter chips (search for `showIntent` to find where other log-level filters live). Add a sibling state/toggle for `showUsage` the same way the others are wired:

```jsx
// near other useState hooks, with a default of true
const [showUsage, setShowUsage] = useState(true);
```

Include the usage toggle next to the existing chips (copy the shape of the `showIntent` chip). In the filter predicate where other `log.level` checks live (around line 629), add:

```js
    if (log.level === 'usage') return showUsage && (logFilter === 'all' || logFilter === 'system' || log.target === logFilter);
```

- [ ] **Step 3: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/pages/SocialPage.jsx
git commit -m "feat(SocialPage): render usage log entries with filter toggle"
```

---

### Task 9: Build `PromptCachePanel` component and mount it in SocialPage

**Files:**
- Modify: `src/pages/SocialPage.jsx` (add component + mount it)

- [ ] **Step 1: Add a `PromptCachePanel` component at the bottom of `SocialPage.jsx`**

Add this component near the other helper components at the end of `src/pages/SocialPage.jsx` (after `ToolDetailsBlock` and the other helpers):

```jsx
function PromptCachePanel({ logs, resetCounter }) {
  // 每次 logs / resetCounter 变更，从 logs 里过滤 'usage' 级别累计
  const stats = React.useMemo(() => {
    const map = new Map();
    for (const log of logs) {
      if (log.level !== 'usage' || !log.details) continue;
      const { label, inputTokens = 0, outputTokens = 0, cachedTokens = 0 } = log.details;
      if (!label) continue;
      const cur = map.get(label) || { label, calls: 0, totalIn: 0, totalCached: 0, totalOut: 0 };
      cur.calls += 1;
      cur.totalIn += inputTokens;
      cur.totalCached += cachedTokens;
      cur.totalOut += outputTokens;
      map.set(label, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.calls - a.calls);
  }, [logs, resetCounter]);

  if (stats.length === 0) {
    return (
      <div className="text-xs text-slate-400 px-2 py-1">Prompt Cache: 暂无数据</div>
    );
  }
  return (
    <div className="border border-slate-200 rounded-md px-2 py-1 text-xs font-mono">
      <div className="font-semibold text-slate-700 mb-1">Prompt Cache（本次会话）</div>
      <table className="w-full">
        <tbody>
          {stats.map(s => {
            const rate = s.totalIn > 0 ? Math.round((s.totalCached / s.totalIn) * 100) + '%' : '—';
            return (
              <tr key={s.label}>
                <td className="pr-2">{s.label}</td>
                <td className="pr-2 text-slate-500">{s.calls} calls</td>
                <td className="pr-2 text-slate-500">{Math.round(s.totalIn / 1000)}k in</td>
                <td className="text-emerald-600">{rate} cached</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Add reset state, listener, and filtered logs to main SocialPage**

In the main SocialPage component body, add state + an effect near the existing `social-log-entry` listener (around line 305):

```jsx
const [cacheResetAt, setCacheResetAt] = useState(0);
const [cacheResetCounter, setCacheResetCounter] = useState(0);

useEffect(() => {
  let unlisten = null;
  (async () => {
    unlisten = await listen('social-cache-stats-reset', () => {
      setCacheResetAt(Date.now());
      setCacheResetCounter(c => c + 1);
    });
  })();
  return () => { if (unlisten) unlisten(); };
}, []);

const usageLogsAfterReset = React.useMemo(
  () => logs.filter(l => l.level === 'usage' && new Date(l.timestamp).getTime() >= cacheResetAt),
  [logs, cacheResetAt],
);
```

`cacheResetAt = 0` on first mount means all existing usage logs are included; after an agent-start event, only new logs are counted.

- [ ] **Step 3: Mount the panel**

Place `<PromptCachePanel logs={usageLogsAfterReset} resetCounter={cacheResetCounter} />` just above the log-panel container (pick a spot inside the existing layout, near where Agent status is rendered). The panel is small and should fit in the settings sidebar or at the top of the log panel.

- [ ] **Step 4: Run lint**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/jules/Documents/Projects/PetGPT
git add src/pages/SocialPage.jsx
git commit -m "feat(SocialPage): add PromptCachePanel aggregating usage logs"
```

---

### Task 10: Manual verification (no automated tests — project has none)

**Files:** none modified; this task runs the app and verifies the seven acceptance criteria from the spec.

- [ ] **Step 1: Run lint + build to catch any compile-time errors**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run lint && npm run build
```

Expected: lint clean; build succeeds.

- [ ] **Step 2: Start the dev app**

```bash
cd /Users/jules/Documents/Projects/PetGPT && npm run tauri:dev
```

Keep the dev server running.

- [ ] **Step 3: Verify the checkbox exists and defaults to checked**

1. Open SocialPage.
2. Select an existing pet (or create one).
3. Scroll to the settings area — confirm "启用显式 Prompt Cache（OpenAI 类 API）" checkbox is present.
4. For an **existing** pet, confirm it defaults to **checked** (the `?? true` fallback).

- [ ] **Step 4: Verify OpenAI request body contains the new params when switch ON**

1. Configure an OpenAI-format LLM as the Intent model.
2. Open DevTools on the Tauri webview (right-click → Inspect if enabled, or enable `devtools` in tauri.conf.json if needed).
3. Start the agent, let Intent fire once.
4. In the Network tab, open the `chat/completions` request body and confirm:
   - `prompt_cache_key` present and shaped `petgpt-{petId}-{targetId}-intent_msg`.
   - `prompt_cache_retention: "24h"` present.

- [ ] **Step 5: Verify OpenAI request body DOES NOT contain params when switch OFF**

1. Stop the agent, uncheck the switch, save config.
2. Restart the agent, let Intent fire.
3. Confirm neither `prompt_cache_key` nor `prompt_cache_retention` is in the body.

- [ ] **Step 6: Verify Anthropic / Gemini request bodies unchanged by the switch**

Repeat steps 4–5 with an Anthropic or Gemini model configured. The body should look identical with switch on vs off (Anthropic still has `cache_control`; Gemini has neither).

- [ ] **Step 7: Verify `usage` log lines appear in the SocialPage log panel**

After any LLM call, a line like:

```
[15:23:47] [usage] Intent:msg  in=5120 (cached 4820, 94%) out=240  3.2s  gpt-4o
```

Should appear in the log area.

- [ ] **Step 8: Verify the cache panel updates and resets**

1. Observe the `Prompt Cache（本次会话）` panel populate as Intent / Reply / Observer / Vision fire.
2. Stop the agent and start it again — panel should reset (via `social-cache-stats-reset` event).

- [ ] **Step 9: Verify `social/usage/{date}.jsonl` still writes `cachedTokens`**

```bash
cd /Users/jules/Documents/Projects/PetGPT
find "$HOME/Library/Application Support/com.petgpt.app/workspace" -name "*.jsonl" -path "*/usage/*" -newer /tmp -exec tail -n 3 {} \;
```

Expected: each record still contains a `cachedTokens` field and has the same shape as before this change.

- [ ] **Step 10: Final commit (if any touch-ups were needed)**

If any of the above required a fix, commit it as a separate "fix" commit referencing which acceptance check failed.

---

## Verification Summary

All seven acceptance criteria from the spec:

1. ✅ Checkbox visible in SocialPage settings, default checked (Task 4 + Task 10 step 3)
2. ✅ Switch ON + OpenAI: body has `prompt_cache_key` + `prompt_cache_retention: "24h"` (Task 2 + Task 5 + Task 10 step 4)
3. ✅ Switch OFF + OpenAI: body has neither (Task 2 + Task 10 step 5)
4. ✅ Anthropic / Gemini unaffected by switch (Task 10 step 6)
5. ✅ Each LLM call emits a `usage` log line (Task 3 + Task 5 + Task 6 + Task 8)
6. ✅ Panel shows per-label running totals, resets on restart (Task 7 + Task 9)
7. ✅ `social/usage/{date}.jsonl` format preserved (Task 3 preserves the `appendUsageLog` call; Task 10 step 9)
