# Intent/Reply 并行化 + 空闲休眠 + 文件缓存

## Summary

去掉 Intent 和 Reply 的 `processorBusy` 互斥锁，让它们并行运行。Intent 决定回复时 fire-and-forget spawn Reply，不等完成。加入空闲休眠（3 分钟无消息）和 prompt 文件缓存层。

## 目标

1. Intent 和 Reply 并行执行，不再互相阻塞
2. 3 分钟无新消息时 Intent 自动休眠，有新消息立刻唤醒
3. 文件读取缓存 + 并行化，减少重复 I/O

## 改动清单

### 1. 删除 `processorBusy` 互斥

**文件**: `src/utils/socialAgent.js`

**Intent 循环 (intentLoop):**
- 删除 `processorBusy.set(target, 'intent')`
- 删除对 `processorBusy === 'reply'` 的等待（第 2207-2214 行）
- 删除 Reply 完成后的等待逻辑（第 2420-2435 行，轮询等 Reply 拿锁 + 等 Reply 完成）
- 决定 reply 时：`replyWakeFlag.set()` 然后立刻 continue
- 删除所有 `processorBusy.delete(target)` 调用

**Reply 循环 (replyLoop):**
- 删除对 `processorBusy === 'intent'` 的等待（第 2789-2795 行）
- 删除 `processorBusy.set(target, 'reply')`
- 删除所有 `processorBusy.delete(target)` 调用

**全局:**
- 删除 `const processorBusy = new Map()` 声明（第 1756 行）

### 2. 删除 `intentGate` 机制

**文件**: `src/utils/socialAgent.js`

Intent 不再需要等 Reply 完成后才能 re-eval。连续发言抑制由 prompt 自然控制（模型看到"我刚发了消息"会自行决定是否继续发）。

- 删除 `const intentGate = new Map()` 和 `INTENT_GATE_TIMEOUT_MS`
- Intent 循环：删除 `intentGate.delete(target)` 和 `intentGate.has(target)` 相关代码
- Reply 循环：删除 `intentGate.set(target, Date.now())` 和 intentGate 检查（第 2816-2826 行）

### 3. Intent 决定 reply → fire-and-forget

**文件**: `src/utils/socialAgent.js`

当前（第 2420-2435 行）：
```
processorBusy.delete(target)
replyWakeFlag.set(target)
等 Reply 拿锁...
等 Reply 执行完...
```

改为：
```
replyWakeFlag.set(target)
// 不等，直接 continue 到下一轮循环
```

Reply 循环检测到 `replyWakeFlag` 后独立执行。

### 4. 空闲休眠（3 分钟无消息）

**文件**: `src/utils/socialAgent.js`

在 Intent 循环的"等待新消息"阶段（第 2188-2196 行），当检测到无新消息时，检查距最后一条非自己的消息的时间：

```javascript
// 现有逻辑：无新消息 → sleep 500ms → continue
// 改为：无新消息时检查空闲时间
const lastNonSelfTime = getLastNonSelfMessageTime(target);
const idleMs = Date.now() - lastNonSelfTime;
if (idleMs > INTENT_IDLE_SLEEP_MS) {  // 3 分钟 = 180000
  addLog('intent', `🧠 [${tName()}] idle sleep (${Math.round(idleMs/60000)}min no msgs)`, null, target);
  await sleepInterruptible(state, 30000); // 30s 长睡，可被 _wake() 唤醒
  continue;
}
await sleepInterruptible(state, 500);
continue;
```

`getLastNonSelfMessageTime(target)` 从 `dataBuffer` 找最后一条 `!is_self` 消息的 timestamp。

Fetcher 检测到新消息时已有 `state._wake()` 唤醒机制，直接复用。

### 5. Prompt 文件缓存

**文件**: `src/utils/socialPromptBuilder.js`

新增一个模块级的带 TTL 缓存层：

```javascript
const fileCache = new Map(); // path → { content, timestamp }
const FILE_CACHE_TTL = 30000; // 30s

async function cachedRead(readFn, cacheKey) {
  const cached = fileCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < FILE_CACHE_TTL) {
    return cached.content;
  }
  const content = await readFn();
  fileCache.set(cacheKey, { content, timestamp: Date.now() });
  return content;
}

// 供 socialToolExecutor 在 social_write/social_edit 后调用
export function invalidateFileCache(path) {
  for (const [key] of fileCache) {
    if (key.includes(path)) fileCache.delete(key);
  }
}
```

### 6. 并行文件读取

**文件**: `src/utils/socialPromptBuilder.js`

`buildIntentSystemPrompt` 里 9 个串行 await 改为 `Promise.all`：

```javascript
const [soulContent, userContent, memoryContent, groupRuleContent,
       contactsContent, peopleCacheContent, socialMemoryContent,
       intentStateContent, scratchNotes] = await Promise.all([
  cachedRead(() => readSoulFile(petId), `soul_${petId}`),
  cachedRead(() => readUserFile(petId), `user_${petId}`),
  cachedRead(() => readMemoryFile(petId), `memory_${petId}`),
  cachedRead(() => readGroupRuleFile(petId, targetId), `rule_${petId}_${targetId}`),
  cachedRead(() => readContactsFile(petId), `contacts_${petId}`),
  cachedRead(() => readPeopleCacheFile(petId, targetId, targetType), `people_${petId}_${targetId}`),
  cachedRead(() => readSocialMemoryFile(petId), `socmem_${petId}`),
  cachedRead(() => readIntentStateFile(petId, targetId, targetType), `intent_${petId}_${targetId}`),
  cachedRead(() => readScratchNotesFile(petId, targetId, targetType), `scratch_${petId}_${targetId}`),
]);
```

### 7. 缓存失效

**文件**: `src/utils/workspace/socialToolExecutor.js`

在 `social_write` 和 `social_edit` 执行成功后调用 `invalidateFileCache(path)`，确保下次读取拿到最新内容。

## 不改动的部分

- Fetcher 循环 — 不变
- Observer 循环 — 不变
- dataBuffer / watermark / compressedSummary — 不变
- buildIntentTurns / 消息格式化 — 不变
- 工具调用链 / callLLMWithTools — 不变
- Reply 冷却 `replyIntervalMs` — 保留
- `replyWakeFlag` — 保留（Intent 唤醒 Reply 的信号）
- `postReplyRestUntil` — 保留（Reply 完成后 Intent 休息 20s）
- UI / SocialPage — 不变
- MCP / LLM 层 — 不变
