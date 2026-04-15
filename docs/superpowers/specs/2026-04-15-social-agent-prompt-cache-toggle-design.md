# Social Agent — Prompt Cache 控制开关与可观测性

**Date:** 2026-04-15
**Status:** Draft

## 背景

Social Agent 每次 Intent / Reply / Observer / Vision / Compress / MdOrganizer 调用，都会向 LLM 发送相对稳定的大段 system prompt（人格、用户画像、记忆、群规则、工具说明、评估要求等），token 量可达数千到上万。目前：

- **Anthropic**：[src/utils/llm/adapters/anthropicNative.js](../../src/utils/llm/adapters/anthropicNative.js) 和 [src-tauri/src/llm/client.rs](../../src-tauri/src/llm/client.rs) 硬编码启用 `cache_control: { type: 'ephemeral' }`（system + tools）。
- **OpenAI / 兼容**：[src/utils/llm/adapters/openaiCompatible.js](../../src/utils/llm/adapters/openaiCompatible.js) 未传任何显式缓存参数。OpenAI 官方的 prompt caching 自动开启（prefix ≥1024 tokens），但未使用 `prompt_cache_key` / `prompt_cache_retention` 影响路由与 TTL。
- **Gemini**：[src/utils/llm/adapters/geminiOfficial.js](../../src/utils/llm/adapters/geminiOfficial.js) 未使用 `cachedContents` 显式缓存，依赖 2.5 系列隐式缓存。
- **使用统计**：[src/utils/mcp/toolExecutor.js](../../src/utils/mcp/toolExecutor.js) 的 `appendUsageLog` 已在 `social/usage/{date}.jsonl` 中写入 `cachedTokens` 字段，但 SocialPage UI 未展示缓存命中情况。

本次目标：**让 OpenAI 系 API 可选地使用显式缓存参数；在 UI 中实时可见每次调用的缓存命中情况；并提供会话级累计视图。** 本期不做 prompt 顺序重排、Gemini 显式 cachedContents、Anthropic 开关化、跨会话持久化命中率统计。

## 设计目标

1. 用户可在 SocialPage 设置里一键启用/关闭 OpenAI 类 API 的显式 prompt caching 参数。
2. 每次 LLM 调用结束后，UI 日志面板实时显示 input / cached / output tokens 与耗时。
3. SocialPage 提供一个本次会话累计的小面板，按 label 分组显示命中率与累计 token。
4. 不破坏任何现有行为（Anthropic 硬开保持、Gemini 隐式保持、usage.jsonl 格式兼容）。

## 范围

**覆盖 provider**：

| Provider | 开关开 | 开关关 |
|---|---|---|
| Anthropic | 不变（`cache_control` 硬编码） | 不变 |
| OpenAI / 兼容 | 请求 body 加 `prompt_cache_key` + `prompt_cache_retention: "24h"` | 不加 |
| Gemini | 不变（隐式缓存自动生效） | 不变 |

也就是说：**开关在语义上只门控 OpenAI 一家的两个参数**。Anthropic 与 Gemini 行为不受开关影响。这样实现最小、风险最低。

**覆盖调用类型（label）**：`Intent:msg` / `Intent:idle` / `Reply` / `Observer` / `Vision` / `Compress:daily` / `Compress:global` / `MdOrganizer`。所有已通过 `appendUsageLog` 记账的调用都纳入。

## 开关定义

### 存储

字段名：`explicitPromptCache: boolean`
位置：per-pet 的 `socialConfig` 对象（沿用现有 socialConfig 的存储机制）。
默认值：新宠物 `true`；已存在宠物读配置时 `explicitPromptCache` 字段缺失时按 `true` 解读（向后兼容）。

### UI

SocialPage 设置区域新增一个 checkbox，标签与帮助文字：

> ☑ 启用显式 Prompt Cache（OpenAI 类 API）
>
> 向 OpenAI 发送 `prompt_cache_key` + 24h 缓存保留参数，提升多轮调用的缓存命中率。Anthropic 始终启用，Gemini 依赖服务端自动缓存。如果你用的兼容网关对未知字段报错，请关闭此开关。

## OpenAI 参数注入

### cache key 公式

```js
prompt_cache_key = `petgpt-${petId}-${targetId || 'global'}-${label}`
```

- `label` 小写规范化，冒号替换为下划线：`Intent:msg` → `intent_msg`，`Compress:daily` → `compress_daily`。
- 无 target 的调用（如 `Compress:global`）取 `global`。
- 每个 `(pet, 群/好友, 调用类型)` 组合独享一个路由 bucket，最大化命中率，同时避免多组合互相冲击导致缓存溢出。

### retention

固定 `prompt_cache_retention: "24h"`。理由：Social Agent 轮询周期通常分钟级，默认 `in_memory` TTL（几分钟～1h）容易过期，24h 能让稳定 prefix 跨多小时保持。

### 注入位置

[src/utils/llm/adapters/openaiCompatible.js](../../src/utils/llm/adapters/openaiCompatible.js) 构建请求 body 时读取来自上游的 `explicitCache: boolean` 和 `cacheKey: string`。若 `explicitCache === true`：

```js
body.prompt_cache_key = cacheKey;
body.prompt_cache_retention = '24h';
```

否则不加这两个字段。

### 兼容性策略（C1）

用户选择的是**无脑传 + 报错自己关**策略。不做服务商白名单、不做自动降级。若兼容网关返回 4xx 且错误信息包含 `prompt_cache_key` / `prompt_cache_retention` 字样，由用户手动关闭开关。文档中在帮助文字里已提示此情况。

## 透传链路

```
socialAgent.js (决定 explicitCache & cacheKey)
  ↓ 作为 callLLM / callLLMWithTools 的 options 传入
mcp/toolExecutor.js (callLLMWithTools)
  ↓ 作为 llmCall / adapter 调用参数
llm/index.js → adapter (openaiCompatible.js)
  ↓ 写入 request body
```

- `socialAgent.js` 在每次 LLM 调用点（Intent / Reply / Observer / Vision / Compress / MdOrganizer）根据当前 `socialConfig.explicitPromptCache` 与 `(petId, targetId, label)` 生成 `{ explicitCache, cacheKey }`，透传到下游。
- `openaiCompatible.js` 是最终写入点，仅当 `apiFormat === 'openai'` 生效。
- Anthropic / Gemini adapter 不读这两个字段，行为不变。

## UI 每次调用日志

在 `addLog` 的级别列表里新增 `'usage'` 级别。每次调用写完 `appendUsageLog` 之后，同步写一行：

```
usage  {label}  in={input} (cached {cached}, {pct}%) out={output}  {sec}s  {model}
```

示例：

```
[15:23:47] usage  Intent:msg  in=5120 (cached 4820, 94%) out=240  3.2s  gpt-4o
[15:23:58] usage  Reply       in=4980 (cached 0)         out=185  2.1s  gpt-4o
[15:24:02] usage  Vision      in=1250 (cached 1100, 88%) out=120  0.9s  gemini-2.5-flash-lite
```

格式规则：
- `cached=0` 时写 `(cached 0)`，不算百分比。
- `cached>0` 时写 `(cached N, P%)`，`P = round(cached / input * 100)`。
- `input` / `output` 数值超 1000 时用 `5.1k` 省略形式；UI 展示时可保留原值，此为 addLog message 字符串建议。
- `target` 参数按调用原有 `target` 传入，日志面板原有过滤按 target 能继续工作。

数据来源：`normalizeUsage` 的结果字段 `inputTokens / outputTokens / cachedTokens`，三家 provider 已统一。

写入点（与 `appendUsageLog` 一一对应）：
- [toolExecutor.js:591 / 741 / 809 / 824](../../src/utils/mcp/toolExecutor.js)（Intent / Reply / Observer 等经由 `callLLMWithTools` 的调用）
- [socialAgent.js:399](../../src/utils/socialAgent.js)（Vision）
- [socialAgent.js:1433 / 1480](../../src/utils/socialAgent.js)（Compress）
- [socialAgent.js:2268](../../src/utils/socialAgent.js)（MdOrganizer）

具体封装方式：在 `appendUsageLog` 同文件或 `socialAgent.js` 提供一个小工具 `logUsageLine(record, addLogFn)`，避免重复拼字符串。

## UI 累计面板

### 状态存储

内存中一个对象：

```js
cacheStats = {
  'Intent:msg':    { calls: 0, totalIn: 0, totalCached: 0, totalOut: 0, durationMs: 0 },
  'Intent:idle':   { ... },
  'Reply':         { ... },
  'Observer':      { ... },
  'Vision':        { ... },
  'Compress:daily':{ ... },
  'Compress:global':{ ... },
  'MdOrganizer':   { ... },
}
```

- 范围：**当前 SocialPage 所属 pet** 的 Agent 会话级数据；若同时运行多个宠物 Agent，按 `petId` 分别聚合，各自 SocialPage 只读本 pet 的统计。
- Agent 启动时该 pet 的数据重置（与现有 buffer 清理时机一致）。
- Agent 停止后保留，再次启动再清零。
- 不持久化到磁盘。

### 更新时机

与 `addLog('usage', ...)` 同点更新：每次 LLM 调用结束后累加。

### UI 展示

SocialPage 新增组件 `<PromptCachePanel cacheStats={cacheStats} />`，常驻小面板。建议位置：Agent 状态区附近或日志面板顶部（具体位置实现时再定）。形式：

```
┌─ Prompt Cache（本次会话） ──────────────────┐
│ Intent:msg  │ 32 calls │ 156k in │ 94% cached │
│ Reply       │ 14 calls │  72k in │ 82% cached │
│ Observer    │  5 calls │  28k in │ 91% cached │
│ Vision      │ 23 calls │  18k in │  0% cached │
└─────────────────────────────────────────────┘
```

- 按 label 分行，`calls = 0` 的 label 不显示。
- 命中率 = `totalCached / totalIn`；`totalIn === 0` 时显示 `—`。
- 字体配色与现有 SocialPage 日志面板一致（Tailwind + 项目现有样式）。
- UI 自动订阅 cacheStats 变更（React state 或 Zustand store，按项目现有模式）。

## 日志级别

[src/utils/socialAgent.js](../../src/utils/socialAgent.js) 的 `addLog(level, ...)` 目前支持：`info / warn / error / intent / send / memory / poll / llm`。

新增：`usage`。SocialPage 的日志筛选区加一个对应 filter chip（沿用其他级别的展示方式）。

## 文件层

不改动。`social/usage/{date}.jsonl` 保持现有格式，`cachedTokens` 字段本来就在，不需要新开文件。

## 不做（明确范围外）

- **Prompt 顺序重排**：当前 `当前时间` 在 system prompt 第 2 行，`INTENT 状态感知` 与 `PEOPLE_CACHE` 穿插在中段，会 bust cache。本期**不动**，留待独立一期处理。
- **Gemini `cachedContents` 显式缓存**：涉及缓存对象生命周期（创建 / TTL / 续期 / 清理 / 存储计费），复杂度高一个量级。
- **Anthropic `cache_control` 开关化**：当前硬编码，不加入本开关控制。
- **跨会话命中率持久化**：累计面板仅本次会话，不做今日/历史 aggregate UI（底层 jsonl 已有数据，将来可基于它做）。
- **自动降级 / 服务商白名单**：按 C1，用户自行管理。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 兼容网关拒收 `prompt_cache_key` | 帮助文字提示；用户关开关即可；开关默认开但 Anthropic / Gemini 不受影响，即便报错也只影响 OpenAI 路径 |
| `cachedTokens` 在某 provider 上口径不一 | 已有 `normalizeUsage` 兼容层，新字段不涉及 |
| UI `usage` 日志行刷屏 | 现有日志面板已有过滤；用户可关掉该级别 |
| cacheStats 内存泄漏 | 固定 label 集合，不按 target 聚合，上限是 label 数量，不随运行时间增长 |

## 验收标准

1. SocialPage 设置里可见 "启用显式 Prompt Cache" 复选框，新宠物默认勾选，旧宠物首次打开时也显示勾选。
2. 开关开 + OpenAI 请求：请求 body 包含 `prompt_cache_key` 与 `prompt_cache_retention: "24h"`。`prompt_cache_key` 值格式为 `petgpt-{petId}-{targetId|global}-{label_snake}`。
3. 开关关 + OpenAI 请求：请求 body 不包含上述两个字段。
4. Anthropic / Gemini 请求 body：开关开关前后完全相同。
5. 每次 LLM 调用结束，SocialPage 日志面板出现一行 `usage` 级别记录，含 in / cached / out / 耗时 / 模型。
6. SocialPage 常驻面板显示本次会话按 label 累计的调用数 / 总 input tokens / 缓存命中率；Agent 重启后清零。
7. `social/usage/{date}.jsonl` 格式与字段不变，`cachedTokens` 照常写入。
