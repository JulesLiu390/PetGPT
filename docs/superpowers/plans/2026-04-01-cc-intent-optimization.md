# CC Intent Optimization: Pre-load Context + --bare

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Claude CLI intent eval from ~2.5 minutes to ~30-40s by pre-loading read-only data into the prompt and adding `--bare` flag to CLI spawns.

**Architecture:** Before calling the LLM, JS-side pre-fetches all data that the model currently retrieves via `social_read`/`history`/`groupLog` tools and injects it into the system prompt. Only write tools (`social_edit`, `write_intent_plan`) remain as callable tools. Combined with `--bare` flag (~13x spawn speedup), this reduces from 4-5 CLI rounds to 2.

**Tech Stack:** Rust (Tauri CLI args), JavaScript (socialAgent.js, socialPromptBuilder.js)

---

### Task 1: Add `--bare` flag to all CLI spawns

**Files:**
- Modify: `src-tauri/src/llm/claude_cli.rs:182-186` (session execute_cli_turn)
- Modify: `src-tauri/src/llm/claude_cli.rs:492-496` (legacy llm_claude_cli_call)

- [ ] **Step 1: Add `--bare` to `execute_cli_turn` args**

In `src-tauri/src/llm/claude_cli.rs`, the `execute_cli_turn` function around line 182:

```rust
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(), "json".to_string(),
        "--max-turns".to_string(), "0".to_string(),
        "--allowedTools".to_string(), "".to_string(),
        "--bare".to_string(),
    ];
```

- [ ] **Step 2: Add `--bare` to legacy `llm_claude_cli_call` args**

In `src-tauri/src/llm/claude_cli.rs`, the `llm_claude_cli_call` function around line 492:

```rust
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(), "json".to_string(),
        "--max-turns".to_string(), "0".to_string(),
        "--allowedTools".to_string(), "".to_string(),
        "--bare".to_string(),
    ];
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished` with no errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/llm/claude_cli.rs
git commit -m "perf: add --bare flag to Claude CLI spawns for faster startup"
```

---

### Task 2: Pre-load read-only context for CC Intent

**Files:**
- Modify: `src/utils/socialAgent.js:2236-2256` (intent tool list construction)
- Modify: `src/utils/socialPromptBuilder.js:624-796` (buildIntentSystemPrompt)

The Intent system prompt already contains most read-only data (SOUL.md, USER.md, MEMORY.md, CONTACTS.md, group rules, people cache, social memory, intent state, sticker index). The model currently calls these tools during Intent eval:

1. `social_read` — reads workspace files (INTENT state, CONTACTS, etc.) — **already in prompt** via `buildIntentSystemPrompt`
2. `history_read` / `daily_read` / `daily_list` — history queries — **need pre-fetch**
3. `group_log_list` / `group_log_read` — cross-group logs — **rarely used, can omit**

The only tools the model truly needs to *call* are:
- `social_edit` — write updated intent state
- `write_intent_plan` — submit the decision

- [ ] **Step 1: Add `apiFormat` parameter to `buildIntentSystemPrompt`**

In `src/utils/socialPromptBuilder.js`, add `apiFormat` to the function signature at line 624:

```javascript
export async function buildIntentSystemPrompt({
  petId, targetName = '', targetId = '', targetType = 'group', sinceLastEvalMin = 0,
  socialPersonaPrompt = '', botQQ = '', ownerQQ = '', ownerName = '', ownerSecret = '',
  nameDelimiterL = '', nameDelimiterR = '', msgDelimiterL = '', msgDelimiterR = '',
  lurkMode = 'normal',
  apiFormat = '',
}) {
```

- [ ] **Step 2: Pass `apiFormat` from socialAgent.js**

In `src/utils/socialAgent.js` around line 2302, add `apiFormat` to the `buildIntentSystemPrompt` call:

```javascript
          const intentPrompt = await buildIntentSystemPrompt({
            petId: config.petId,
            targetName: tName(),
            targetId: target,
            targetType,
            sinceLastEvalMin: sinceMin,
            socialPersonaPrompt: promptConfig.socialPersonaPrompt,
            botQQ: promptConfig.botQQ,
            // ... existing params ...
            apiFormat: intentLLMConfig.apiFormat,
          });
```

- [ ] **Step 3: Adjust tool description section for CC mode**

In `src/utils/socialPromptBuilder.js`, replace the tool description section (around line 774-796). After the sticker section, modify the `# 可用工具` section:

```javascript
  // === 工具说明 ===
  const isCcMode = apiFormat === 'claude_cli';

  if (isCcMode) {
    // CC 模式：只保留写入工具，只读数据已全部在 prompt 中
    sections.push(`# 可用工具

你只需要使用以下两个工具：

1. social_edit(path, old_text, new_text)：更新状态感知文件。path 使用 social/${intentStateDir}/INTENT_${targetId}.md
2. write_intent_plan(actions)：提交行动计划。有 reply 或 sticker 时无需额外添加 wait；若无行动则 actions 传空数组。

⚠️ 先用 social_edit 更新状态感知文件，然后调用 write_intent_plan 提交决策。
⚠️ 所有只读信息（联系人、社交记忆、群规则、历史等）已在上方提供，无需查询。`);
  } else {
    sections.push(`# 可用工具

计划工具（思考完毕后调用一次，且只调用一次）：
- write_intent_plan(state, actions)：提交状态感知和下一步行动计划。有 reply 或 sticker 时无需额外添加 wait；若无行动则 actions 传空数组。
- ⚠️ 先完成所有思考和工具查询，最后才调用 write_intent_plan。中途不要提前提交。

文件工具（按需使用）：
- social_read(path)：按需读取其他社交文件（如 social/notes/、social/REPLY_STRATEGY.md 等）。当前对话成员档案已自动注入上方，无需手动读取。

历史查询工具（只读，按需使用）：
- history_read(query, start_time, end_time?)：搜索${groupLabel}的历史聊天原文，按关键词 + 时间范围过滤
- daily_read(date?, target?)：读取每日摘要。传 target 读该群详细日报，不传读全局跨群日报
- daily_list()：列出有哪些日期的日报可读

跨群日志工具（只读）：
- group_log_list()：列出所有有日志记录的群
- group_log_read(targets, query?, start_time?, end_time?)：搜索指定群的 Observer 日志

外部搜索工具（如果已配置）：
- 你可能还有 tavily_search、fetch 等外部搜索工具可用。当群友在辩论中引用了事实、数据或信息源，而你不确定真假时，用这些工具核实后再下判断

⚠️ 历史查询和搜索工具只在这些情况下使用：(1) 聊天中出现你不了解的背景信息；(2) 有人用事实论据反驳你，你需要核实真伪。`);
  }
```

- [ ] **Step 4: Filter Intent tools for CC mode in socialAgent.js**

In `src/utils/socialAgent.js` around line 2236-2256, filter out read-only tools when using CC:

```javascript
        // 构建工具集
        const intentPlanDefs = getIntentPlanToolDefinitions();
        const isCliMode = intentLLMConfig.apiFormat === 'claude_cli';

        // CC 模式只保留写入工具（social_edit + write_intent_plan），只读数据已在 prompt 中
        const intentFileDefs = isCliMode
          ? getSocialFileToolDefinitions().filter(t => t.function.name === 'social_edit')
          : getSocialFileToolDefinitions().filter(t => ['social_read', 'social_edit', 'social_write'].includes(t.function.name));

        const intentToolDefs = isCliMode
          ? [...intentPlanDefs, ...intentFileDefs]
          : [...intentPlanDefs, ...intentFileDefs, ...getHistoryToolDefinitions(), ...getGroupLogToolDefinitions()];

        let intentMcpTools = intentToolDefs.map(t => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
          serverName: null,
        }));

        // 注入外部 MCP 工具（CC 模式下跳过，减少工具数量）
        if (!isCliMode) {
          try {
            const allTools = await getMcpTools();
            const extraServers = new Set(promptConfig.enabledMcpServers || []);
            const externalTools = allTools.filter(t =>
              extraServers.has(t.serverName) && t.serverName !== config.mcpServerName
            );
            if (externalTools.length > 0) {
              intentMcpTools = [...intentMcpTools, ...externalTools];
            }
          } catch { /* 非致命 */ }
        }
```

- [ ] **Step 5: Verify syntax**

Run: `node -c src/utils/socialAgent.js && node -c src/utils/socialPromptBuilder.js`
Expected: No output (success)

- [ ] **Step 6: Commit**

```bash
git add src/utils/socialAgent.js src/utils/socialPromptBuilder.js
git commit -m "perf: pre-load read-only context for CC intent, reduce tool calls from 5 to 2"
```

---

### Task 3: Verify end-to-end

- [ ] **Step 1: Restart tauri:dev**

Run: `npm run tauri:dev`

- [ ] **Step 2: Test CC chat (no tools)**

Open a new conversation with CC haiku/sonnet, send "hello". Verify text response appears.

- [ ] **Step 3: Test CC Intent (social agent)**

Set social agent Intent model to CC sonnet. Start agent on a group. Verify in logs:
- `[MCP] CLI session (non-stream) turn 1` — first turn (should output social_edit)
- `[MCP] CLI session (non-stream) turn 2` — second turn (should output write_intent_plan)
- Total time from "eval starting" to result should be ~30-40s (down from 2.5 min)
- No `social_read`, `history_read`, `social_tree` tool calls in logs

- [ ] **Step 4: Test non-CC models unaffected**

Switch Intent model back to Gemini. Verify social agent works as before with full tool set.
