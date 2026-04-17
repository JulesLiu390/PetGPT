# Intent 训练数据采集 Design Spec

**日期**：2026-04-17
**状态**：Design approved, pending implementation plan
**目标**：采集 Intent loop 的完整调用轨迹（含模型 thinking + 工具调用序列），用于本地 Qwen 模型工具调用能力微调。

---

## 1. Summary

为社交 Agent 的 Intent 循环新增一个可选采集管线：每次 Intent eval 结束时，把完整的多轮 messages 链（system prompt、tool schemas、每轮 assistant content + reasoning_content + tool_calls、tool results、终止状态）写入 JSONL 文件。采集在 Intent LLM 调用层通过 `callLLMWithTools` 的新 `onTrace` 回调触发，支持 success/failed/partial/timeout 所有路径。全局开关默认关，需用户显式开启，并且按 target 白名单生效。采集时不脱敏，导出环节通过独立 Node 脚本转换成 Unsloth/HuggingFace 兼容格式，支持 QQ/群号/昵称脱敏。

采集目标：**Intent only**，重点学习工具调用链路（social_read → chat_search → social_edit → write_intent_plan 这类序列决策）。

---

## 2. Goals & Non-goals

### Goals
- 每次 Intent eval 产出一条 provider-neutral JSONL 记录，信息无损
- 保留每轮 LLM 内部 reasoning（A 类 thought，Qwen thinking 模式的 `reasoning_content`）
- 捕获成功、失败、部分完成、超时所有终止路径
- 产出数据能直通 Unsloth `SFTTrainer` + Qwen3 chat template 微调流水线
- 用户可灵活控制：全局开关 + 按群白名单；导出时再做脱敏

### Non-goals
- 不采集 Reply / Observer / Vision 循环（未来可扩展，当前仅 Intent）
- 不做运行时压缩、自动轮转、体积限流（YAGNI，量级估算下 3-12 月量级可接受）
- 不在采集时脱敏（原始数据本地保真，导出再处理）
- 不做 per-target 独立开关之外的细粒度过滤（例如按 willingness 分层）

---

## 3. 决策记录（来自 brainstorming）

| # | 决策点 | 选择 | 备注 |
|---|---|---|---|
| 1 | 采集范围 | 只 Intent | 重点工具调用能力微调 |
| 2 | 样本粒度 | 一次完整 eval = 一条样本 | 多轮 messages 链 |
| 3 | Thought | A+B 都要；B 在 tool_call args 里天然保留 | 仅需额外抓 A 类 reasoning_content |
| 3.1 | Thought 字段命名 | 维持 `reasoning_content` | 与 OpenAI/Qwen 原生响应对齐 |
| 4 | 落盘格式 | provider-neutral JSONL + 独立导出脚本 | 避免绑定微调框架 |
| 5 | 脱敏时机 | 采集时保真，导出时脱敏 | 灵活、可重导 |
| 6a | 全局开关默认 | **关** | opt-in |
| 6b | 失败/不完整 eval | 全存，打 `status` 标记 | 便于失败模式分析 |
| 6c | 粒度 | 全局开关 + per-target 白名单勾选 | 两个都 ON 才采集 |
| 7 | 导出目标格式 | Unsloth/HuggingFace messages + tools | Unsloth 自己用 `apply_chat_template` 渲染 |

---

## 4. 架构

### 4.1 数据流
```
Intent Loop (socialAgent.js)
      │
      ├── 判定：globalTrainingEnabled && targetConfig.trainingEnabled
      │   false → 不传 onTrace，callLLMWithTools 零开销
      │   true  → 传 onTrace 回调
      ▼
callLLMWithTools(..., onTrace?)      ← 新可选回调参数
      │
      │  若 onTrace 存在：内部维护 reasoningHistory[]、每轮 assistant
      │  循环退出（任何路径）→ try/finally 保障
      ▼
onTrace(trace)                        ← 触发
      │
      ▼
writeIntentTrace(petId, meta, trace)  ← 新模块 intentTraining.js
      │
      ├── buildRecord(meta, trace)    ← 组装 schema 记录
      └── workspaceAppend(petId, "social/training/intent/{date}.jsonl", line)
                                       ↓ fire-and-forget
                                       异常 console.warn 不阻塞 Intent
```

### 4.2 离线导出
```
scripts/export_intent_training.mjs
      │
      ├── glob social/training/intent/*.jsonl
      ├── filter (status / termination / 日期 / target)
      ├── redact (可选)
      │     ├── 全链路字段扫描（content / arguments / system）
      │     └── 映射表持久化 redaction_map.json
      ├── 转 HF messages 格式
      │     ├── reasoning_content → <think>...</think> 合入 content
      │     ├── tool_calls arguments 解析为 JSON object
      │     ├── tool message 回填 name
      │     └── tools schema → HF style
      └── schema 校验 + summary 输出
                ↓
         dataset/qwen_intent.jsonl  →  喂 Unsloth SFTTrainer
```

### 4.3 模块 boundary
| 模块 | 职责 | 依赖 |
|---|---|---|
| `callLLMWithTools` (toolExecutor.js) | 循环状态追踪 + 构造 trace + 触发 onTrace | 无新增 |
| adapters (openaiCompatible / anthropic) | 从 response 抽 reasoning_content | 无新增 |
| `intentTraining.js` (新) | 构造 record + 写盘 | tauri |
| socialAgent.js Intent loop | 判定采集 + 传入 onTrace 回调 | intentTraining, 现有 settings/target config |
| SocialPage.jsx | 全局开关 UI + per-target toggle + 快捷按钮 | intentTraining |
| export_intent_training.mjs (新) | 过滤 + 脱敏 + HF 格式转换 + 校验 | Node stdlib only |
| training_export.rs (新) | 后端命令，spawn Node 脚本 | std::process::Command |

---

## 5. 数据 Schema

Provider-neutral JSONL，每行一条 Intent eval 完整记录：

```jsonc
{
  "schema_version": 1,
  "id": "itr_<nanoid>",
  "ts": "2026-04-17T14:32:08.512Z",
  "duration_ms": 4820,

  "target_id": "123456789",
  "target_type": "group",
  "pet_id": "pet_xxx",
  "provider": "openai_compatible",
  "model": "Qwen3-32B-thinking",
  "label": "Intent:msg",

  "system": "<Intent 系统 prompt 原文>",
  "tools": [ /* provider-agnostic tool schemas */ ],

  "messages": [
    { "role": "user", "content": "<首轮 user>" },

    {
      "role": "assistant",
      "reasoning_content": "<模型 thinking>",
      "content": null,
      "tool_calls": [
        { "id": "call_1", "type": "function",
          "function": { "name": "social_read",
            "arguments": "{\"path\":\"social/group/RULE_123.md\"}" } }
      ]
    },
    { "role": "tool", "tool_call_id": "call_1", "content": "<工具返回>" },

    // ...更多 assistant/tool 轮

    {
      "role": "assistant",
      "reasoning_content": "<终局 thinking>",
      "content": null,
      "tool_calls": [
        { "id": "call_N", "type": "function",
          "function": { "name": "write_intent_plan",
            "arguments": "{\"willingness\":4,\"actions\":[...]}" } }
      ]
    }
  ],

  "status": "success",
  "termination": "write_intent_plan",
  "error": null,
  "iterations": 4,
  "tool_calls_total": 5
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `schema_version` | 整数，当前为 1。schema 变更时递增 |
| `id` | `itr_` 前缀 + nanoid，便于去重 |
| `ts` | ISO 8601，eval 开始时间 |
| `duration_ms` | 从 Intent loop 启动到 onTrace 触发的毫秒数 |
| `target_id/type` | 群号/好友号 + `"group"` / `"friend"` |
| `pet_id` | 当前 Pet 的 ID（workspace 隔离的主键） |
| `provider` | `apiFormat`：`"openai_compatible"` / `"anthropic"` / `"gemini_official"` 等 |
| `model` | 具体模型名 |
| `label` | `"Intent:msg"`（消息触发）或 `"Intent:idle"`（idle 周期触发） |
| `system` | 完整 Intent system prompt 文本，**不含 prompt_cache_key / cache_control** 等 cache 控制字段 |
| `tools` | 传给 `callLLMWithTools` 的 `mcpTools`，provider-neutral schema |
| `messages` | 从首轮 user 开始的完整链，不含 system（system 单独字段存） |
| `messages[].reasoning_content` | assistant 轮内可选；无则省略字段 |
| `messages[].tool_calls[].function.arguments` | **保留为字符串形式**（OpenAI 原生返回即字符串），导出时解析 |
| `status` | `"success"` \| `"failed"` \| `"partial"` \| `"timeout"` |
| `termination` | 正常：终止工具名（如 `"write_intent_plan"`）；异常：`"error"` / `"max_iterations"` / `"timeout"` |
| `error` | status ≠ success 时为字符串错误摘要，否则 `null` |
| `iterations` | LLM 轮次数 |
| `tool_calls_total` | 所有轮 tool_calls 总数 |

### 状态语义
- `success`：循环通过 `stopAfterTool` 正常退出，termination = 该工具名
- `partial`：到达 `maxIterations` 上限，LLM 没来得及调终止工具
- `failed`：LLM 报错或工具执行抛异常
- `timeout`：单次 tool 执行超时（`TOOL_EXECUTION_TIMEOUT_MS`）

---

## 6. 采集 Hook 实现

### 6.1 新增 `onTrace` 回调

在 `callLLMWithTools` ([src/utils/mcp/toolExecutor.js](../../../src/utils/mcp/toolExecutor.js)) 入参里加：

```js
onTrace,  // optional (trace) => void — fires once at loop exit (success/failure/partial/timeout)
```

### 6.2 Trace 对象结构

```js
{
  systemPrompt: string,
  tools: Array<ToolSchema>,
  initialUserMessage: string,
  iterations: [
    {
      content: string | null,
      reasoning_content: string | null,
      tool_calls: Array<{ id, type, function: { name, arguments: string } }>
    }
  ],
  toolResults: [
    { tool_call_id: string, name: string, content: string }
  ],
  status: "success" | "failed" | "partial" | "timeout",
  termination: string,
  error: string | null,
  durationMs: number,
}
```

### 6.3 实现要点

1. **reasoning 抽取**：各 adapter 在 LLM 响应里抽 reasoning
   - `openaiCompatible.js`：`response.choices[0].message.reasoning_content`
   - `anthropic.js`：content blocks 里 `type === "thinking"` 块的 `thinking` 字段
   - `gemini`：`thought_signature` 不透明，**跳过**
2. **异常路径保障**：`callLLMWithTools` 主循环用 `try { ... } finally { if (onTrace) onTrace(trace) }` 包住。现有代码用 try/catch，不会与 finally 冲突
3. **顺序触发**：在 `appendUsageLog` 和 `onUsageLogged` 之后，确保 trace 数据构造完毕
4. **不干扰现有返回值**：`onTrace` 只是副作用回调，不改 `callLLMWithTools` 的返回结构
5. **零开销原则**：`onTrace` 未传入时，完全跳过 reasoning 收集和 trace 对象构造；仅当传入时才累积

### 6.4 新模块 `src/utils/intentTraining.js`

**职责边界**：此模块只管**构造 record + 写盘**。是否采集的判定由 caller（socialAgent.js）负责，以避免在非 React 环境里读 React hook 状态。

```js
import * as tauri from './tauri';

const SCHEMA_VERSION = 1;

/** 无依赖 ID 生成：时间戳 base36 + 8 字符随机 */
function generateTraceId() {
  return `itr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function writeIntentTrace(petId, meta, trace) {
  const record = buildRecord(meta, trace);
  const date = new Date().toISOString().slice(0, 10);
  const path = `social/training/intent/${date}.jsonl`;
  try {
    await tauri.workspaceAppend(petId, path, JSON.stringify(record) + '\n');
  } catch (e) {
    console.warn('[IntentTraining] write failed:', e);
  }
}

function buildRecord(meta, trace) {
  const messages = [];
  messages.push({ role: 'user', content: trace.initialUserMessage });
  // 交织 assistant + tool turns
  for (let i = 0; i < trace.iterations.length; i++) {
    const iter = trace.iterations[i];
    messages.push({
      role: 'assistant',
      ...(iter.reasoning_content ? { reasoning_content: iter.reasoning_content } : {}),
      content: iter.content ?? null,
      ...(iter.tool_calls?.length ? { tool_calls: iter.tool_calls } : {}),
    });
    // 把对应的 tool results 插入 assistant 之后
    if (iter.tool_calls?.length) {
      for (const tc of iter.tool_calls) {
        const res = trace.toolResults.find(r => r.tool_call_id === tc.id);
        if (res) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: res.content });
        }
      }
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    id: generateTraceId(),
    ts: new Date(Date.now() - trace.durationMs).toISOString(),
    duration_ms: trace.durationMs,
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
    error: trace.error,
    iterations: trace.iterations.length,
    tool_calls_total: trace.iterations.reduce((n, it) => n + (it.tool_calls?.length || 0), 0),
  };
}
```

### 6.5 在 Intent Loop 接入

[socialAgent.js:2337](../../../src/utils/socialAgent.js#L2337) 附近的 `callLLMWithTools` 调用：

```js
// 判定：全局开关 + 该 target 白名单（socialAgent 启动时已解析到 config 里）
const shouldCollectTraining =
  config.trainingCollectionEnabled && targetConfig.trainingEnabled;

const onTrace = shouldCollectTraining
  ? (trace) => writeIntentTrace(config.petId, {
      target_id: target,
      target_type: /* group|friend */,
      label: evalMode === 'idle' ? 'Intent:idle' : 'Intent:msg',
      provider: intentLLM.apiFormat,
      model: intentLLM.modelName,
      pet_id: config.petId,
    }, trace)
  : undefined;
```

**数据来源**：
- `config.trainingCollectionEnabled`：从主应用 `useSettings` 读出后传入 `startSocialLoop`；开关切换时通过现有的 settings 变更监听通知 loop
- `targetConfig.trainingEnabled`：per-target 配置，随 `socialTargets[...]` 结构一同加载

**优化**：`shouldCollectTraining` 为 false 时 `onTrace` 不传入，`callLLMWithTools` 内部就不构造 trace 对象，热路径开销为零。

### 6.6 改动规模
- `toolExecutor.js`：+60 行（reasoning 收集、trace 构造、finally 保障、onTrace 触发）
- `openaiCompatible.js`：+5 行（抽 reasoning_content）
- `anthropic.js`（如存在对应 adapter）：+5 行
- `intentTraining.js`：新文件 ~100 行
- `socialAgent.js` Intent 调用处：+10 行

---

## 7. 存储 / 文件布局

```
<workspace>/
└── social/
    └── training/
        └── intent/
            ├── 2026-04-17.jsonl
            ├── 2026-04-18.jsonl
            └── ...
```

- **按日期分文件**：与现有 `social/usage/` 节奏一致
- **单独子目录 `social/training/intent/`**：为未来 Reply/Observer 扩展预留
- **追加写入**：`tauri.workspaceAppend`，路径自动创建
- **fire-and-forget**：异常 console.warn，不阻塞 Intent loop
- **不自动清理**：默认永久保留；`maxTrainingLogDays` 配置预留但首版不实现

### 体积估算
- 单条 Intent eval：~5-30 KB（取决于 buffer 消息量、工具轮数、reasoning 长度）
- 单群 ~50-200 条/天 → 0.5-5 MB/天
- 多群 + 全量数据 → 数十 MB/天级别，月度 GB 量级不会触发
- 体积失控前先手动清理或打包

### 不做的事
- 不做运行时 gzip（训练前离线压缩即可）
- 不加 rotation 策略（YAGNI）
- 不进 git（workspace 本来就在 Application Support 外部）

### Prompt Cache 相关
采集时 **system 字段必须是 prompt 原文**，不含：
- Anthropic `cache_control` 块标记
- OpenAI `prompt_cache_key` 参数
- 任何 cache retention 配置

`buildRecord()` 里 `system` 直接从 `socialPromptBuilder` 输出拿，不从实际 request body 扒。

---

## 8. UI 设计

### 8.1 Training Data Collection Card（SocialPage 主面板）

位置：[SocialPage.jsx](../../../src/pages/SocialPage.jsx) 的 Prompt Cache card **下方**，与 Prompt Cache 同级独立块。

```
┌── Training Data Collection ─────────────────┐
│  [ ] Enable collection (global)            │
│                                             │
│  Only targets marked below are collected.  │
│  Raw data — redact at export time.          │
│                                             │
│  Enabled targets (3):                       │
│    · 群A [12345]                           │
│    · 群B [67890]                           │
│    · 好友小橙 [98765]                       │
│                                             │
│  Today: 47 traces · 312 KB                  │
│  [Open folder] [Export for Qwen]           │
└─────────────────────────────────────────────┘
```

### 8.2 Per-target Toggle（每个 target 卡片）

现有 target 卡片上，与 lurk mode、pause 控件**同排**加一个 Training toggle：

```
target 卡片：
  [Normal ▾] [Pause] [📊 Training: ●]
```

- ● 亮色 = 已勾选（该 target 的 `trainingEnabled: true`）
- ○ 暗色 = 未勾选
- 点击即翻转

### 8.3 数据结构
在 `socialTargets` 里每个 target 加字段 `trainingEnabled: boolean`，默认 `false`。

### 8.4 判定逻辑
```
shouldCollect = globalTrainingEnabled && target.trainingEnabled
```

| 全局 | Target | 结果 |
|---|---|---|
| ON | ON | 采集 ✅ |
| ON | OFF | 跳过 |
| OFF | * | 跳过（全局 kill switch） |

### 8.5 辅助功能
- **Today 统计**：页面加载时读当天 `social/training/intent/{YYYY-MM-DD}.jsonl`，统计行数和文件大小。仅全局开关 ON 时显示
- **Open folder**：调 `tauri.openPath` 打开 `social/training/intent/` 目录
- **Export for Qwen**：弹 modal 让用户选脱敏/过滤选项，提交后调 `tauri.invoke('run_training_export', ...)` 触发后端 spawn 导出脚本

### 8.6 交互原则
- 开关实时生效（下次 Intent eval 按新状态，无需重启 agent）
- 采集过程不打扰（无 toast/log 污染）
- 首次启用 + 首次写入时，`addLog('info', 'Training collection enabled, first trace written')` 打一条确认；之后静默

### 8.7 改动规模
- `socialTargets` reducer/hook：+10 行（`trainingEnabled` 字段）
- 每个 target 卡片渲染：+15 行（toggle）
- 主 card 组件：+40 行（新组件 + 统计 + 按钮）
- `useSettings` 新增 `trainingCollectionEnabled` 持久化字段：+5 行

---

## 9. 导出脚本（Unsloth-ready）

文件：[scripts/export_intent_training.mjs](../../../scripts/export_intent_training.mjs)

### 9.1 CLI
```bash
node scripts/export_intent_training.mjs \
  --input  <workspace>/social/training/intent/ \
  --output ./dataset/qwen_intent.jsonl \
  [--status success] [--termination write_intent_plan] \
  [--redact] [--from 2026-04-01] [--to 2026-04-30] \
  [--include-targets 12345,67890] \
  [--exclude-targets 11111] \
  [--template hf-messages]
```

### 9.2 输出格式（Unsloth HF messages + tools）

每行一条 JSON：

```jsonc
{
  "messages": [
    { "role": "system", "content": "<Intent system prompt>" },
    { "role": "user", "content": "<首轮 user>" },
    {
      "role": "assistant",
      "content": "<think>\n<reasoning_content>\n</think>",
      "tool_calls": [
        { "id": "call_1", "type": "function",
          "function": { "name": "social_read",
            "arguments": { "path": "social/group/RULE_123.md" } } }
      ]
    },
    { "role": "tool", "tool_call_id": "call_1", "name": "social_read",
      "content": "<RULE 文件内容>" },

    // ...更多轮

    {
      "role": "assistant",
      "content": "<think>\n<终局 reasoning>\n</think>",
      "tool_calls": [
        { "id": "call_N", "type": "function",
          "function": { "name": "write_intent_plan",
            "arguments": { "willingness": 4, "actions": [...] } } }
      ]
    }
  ],
  "tools": [
    { "type": "function", "function": {
      "name": "social_read",
      "description": "...",
      "parameters": { "type": "object", "properties": {...}, "required": [...] }
    }}
    // 其余工具
  ]
}
```

### 9.3 转换管线

对每条原始记录：

1. **过滤**
   - `--status` / `--termination`
   - `--from` / `--to` 日期窗口
   - `--include-targets` / `--exclude-targets`
2. **脱敏**（仅 `--redact`）
   - QQ 号正则 `\b\d{5,12}\b` → `U_<stable_hash8>`（同一原值 → 同一占位符，保一致性）
   - 群号同理 → `G_<stable_hash8>`
   - 昵称：从 workspace 的 `SOCIAL_MEMORY.md` / `CONTACTS.md` 提取已知昵称清单，最长匹配优先 → `nick_<stable_hash4>`
   - 字段覆盖：`system`、`messages[].content`、`tool_calls[].function.arguments`（字符串化后替换再解析回对象）、`tool` 消息 content
   - 映射表写 `redaction_map.json`（本地保留，**不入仓库**；脚本运行时提示用户加入 .gitignore）
3. **转 HF 格式**
   - `assistant`：`reasoning_content` → `<think>...</think>` 前置进 `content`；原 content 非空则 `<think>...</think>\n<content>`
   - `tool_calls[].function.arguments`：若字符串则 `JSON.parse`；对象直接用
   - `tool`：根据 `tool_call_id` 回查对应 `tool_calls[].function.name` 填 `name` 字段
   - `tools` 数组：每项转 `{type:"function", function:{name, description, parameters}}`
4. **Schema 校验**（丢弃不合格条目）
   - `arguments` JSON 解析失败
   - `tool` 无法对应任何 assistant tool_call
   - assistant turn 无 `<think>` 块（**Unsloth FunctionGemma notebook 原则：有 thought 的才是有效样本**）
5. **汇总**：输入 N → 过滤后 M → 校验后 K，打印 dropped reasons count

### 9.4 模板选项
`--template`（默认 `hf-messages`）：
- `hf-messages`：上述 HF 格式（**推荐**，直通 Unsloth `SFTTrainer`）
- `raw`：不转换，输出原始 provider-neutral 形态（调试/备份用）

### 9.5 后端集成（UI "Export for Qwen" 按钮）

Rust 侧新增命令 `src-tauri/src/commands/training_export.rs`（~50 行）：

```rust
#[tauri::command]
pub async fn run_training_export(
    pet_id: String,
    options: ExportOptions,
) -> Result<ExportSummary, String> {
    let script = /* scripts/export_intent_training.mjs 路径 */;
    let args = build_args(&options);
    let output = Command::new("node").arg(script).args(&args).output()?;
    parse_summary(&output.stdout)
}
```

仅 spawn Node 脚本，**脱敏 + 转换逻辑全在 JS 脚本里**，不在 Rust 侧重复实现。

### 9.6 为什么不预渲染 ChatML 字符串

查了 Unsloth + Qwen3 的当前状态（2026 Q1）：
- Qwen3.5 chat template 的 tool-call + reasoning_content bug **2026 年初才修**
- 我们预渲染 `<|im_start|>...<|im_end|>` 会锁死模板版本
- HF messages + tools 是更稳定的中间层，由 `apply_chat_template` 渲染

### 9.7 测试
文件：`scripts/__tests__/export_intent_training.test.mjs`（Node 内置 `node --test`）

Fixtures：3-5 条原始 JSONL，覆盖：
- success + write_intent_plan
- failed + LLM error
- partial + max_iterations
- 有 / 无 reasoning_content
- 2-3 种工具链长度

断言：
- 过滤逻辑正确
- 脱敏后原始 QQ/群号不在输出任何字段
- 每条输出 messages 结构合规：
  - `tool_calls[].function.arguments` 是 object
  - `tool` 消息有 `name`
  - assistant content 含 `<think>` 块
- 映射表可反查（输入 QQ → 占位符一致）
- dropped reason 汇总准确

---

## 10. 测试策略总览

| 层 | 测试内容 | 工具 |
|---|---|---|
| `callLLMWithTools` onTrace | trace 在 success/failed/partial/timeout 四种路径都触发；字段完整 | 现有 tests 模式，mock adapter |
| `intentTraining.js` | `isTrainingCollectionEnabled` 判定矩阵；`buildRecord` schema 一致性；workspaceAppend 失败不抛 | 单元测试 |
| adapters 的 reasoning 抽取 | OpenAI-compat reasoning_content、Anthropic thinking block | 单元测试 |
| 导出脚本 | 见 9.7 | `node --test` |
| 集成 | Intent loop 端到端跑一次，文件落盘内容校验 | 手工 or Tauri integration test |

---

## 11. Out of Scope / Future Work

- Reply / Observer / Vision 循环的采集（架构已为扩展预留 `social/training/<loop>/` 路径）
- 运行时压缩与日志轮转
- UI 内置的训练流水线触发（现在只有导出脚本，用户自己在 Unsloth 里跑训练）
- Multi-modal（图片）训练数据 —— Intent 现在只看图片描述文字，不采原图
- 强化学习标注（对 Intent 决策打分，用于 DPO/GRPO） —— 可在本 schema 上扩字段，但当前只做 SFT

---

## 12. Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| 原始 QQ/昵称出现在训练数据 → 模型记忆个人信息 | 导出时 `--redact`；敏感群体可直接不勾 per-target toggle |
| 失败 eval 占比高 → 训练集噪声 | 默认导出带 `--status success`；partial/failed 可用于离线分析 |
| Schema 演进需要回填历史数据 | `schema_version` 字段在记录里；导出脚本按版本分发处理逻辑 |
| Qwen 模板升级导致预渲染格式过时 | 存 HF messages 中间层，不预渲染；导出时现转，模板变更只需改一次 |
| workspaceAppend 频繁 IO 卡主线程 | 已是 fire-and-forget 异步；Intent loop 不等 |
| 采集侵入 `callLLMWithTools` 增加维护负担 | 只新增 `onTrace` 回调，不改现有返回结构；默认不传即不触发 |
