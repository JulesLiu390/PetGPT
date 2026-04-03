# Intent/Reply Parallel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Intent/Reply mutual exclusion so they run in parallel, add idle sleep when 3min no messages, add prompt file caching with parallel reads.

**Architecture:** Delete `processorBusy` Map and `intentGate` mechanism. Intent fire-and-forgets Reply via `replyWakeFlag`. Add idle detection in Intent loop. Add cached file reader in socialPromptBuilder with 30s TTL and cache invalidation on writes.

**Tech Stack:** JavaScript (socialAgent.js, socialPromptBuilder.js, socialToolExecutor.js)

**Spec:** `docs/superpowers/specs/2026-04-01-intent-reply-parallel-design.md`

---

### Task 1: Remove processorBusy + intentGate, make Intent fire-and-forget Reply

**Files:**
- Modify: `src/utils/socialAgent.js`

This is the core change. Remove all mutual exclusion between Intent and Reply loops.

- [ ] **Step 1: Delete processorBusy and intentGate declarations**

Find and delete these lines (around line 1756-1772):

```javascript
// DELETE these 3 lines:
const processorBusy = new Map(); // target → 'intent' | 'reply' | null
const intentGate = new Map();                  // target → lock timestamp
const INTENT_GATE_TIMEOUT_MS = 30 * 1000;      // 门控安全超时
```

- [ ] **Step 2: Clean up Intent loop — remove mutex acquire and Reply wait**

In the `intentLoop` function, find the "互斥：等待 Reply 完成" block (around line 2207-2216) and delete it entirely:

```javascript
// DELETE this entire block:
        if (processorBusy.get(target) === 'reply') {
          if (!state._waitingForReply) {
            state._waitingForReply = true;
            addLog('intent', `🧠 [${tName()}] waiting for Reply to finish`, null, target);
          }
          await sleepInterruptible(state, 500);
          continue;
        }
        state._waitingForReply = false;
        processorBusy.set(target, 'intent');
```

- [ ] **Step 3: Clean up Intent error path**

Find the error handler (around line 2350-2351) and remove `intentGate.delete` and `processorBusy.delete`:

```javascript
// BEFORE:
        if (intentResult.error) {
          addLog('intent', `Intent LLM error [${tName()}]: ${intentResult.content}`, null, target);
          intentGate.delete(target);
          processorBusy.delete(target);
          await sleepInterruptible(state, 2000);
          continue;
        }

// AFTER:
        if (intentResult.error) {
          addLog('intent', `Intent LLM error [${tName()}]: ${intentResult.content}`, null, target);
          await sleepInterruptible(state, 2000);
          continue;
        }
```

- [ ] **Step 4: Remove intentGate unlock after eval**

Find the intentGate check after successful eval (around line 2369-2371) and delete:

```javascript
// DELETE this block:
        if (intentGate.has(target)) {
          intentGate.delete(target);
          addLog('intent', `🔓 [${tName()}] intent gate unlocked`, null, target);
        }
```

- [ ] **Step 5: Simplify Intent's reply dispatch — fire and forget**

Find the reply dispatch block (around line 2414-2436). Replace the entire block with a simple fire-and-forget:

```javascript
// BEFORE (the whole block with processorBusy.delete, replyWakeFlag, polling for Reply lock, etc.):
        // 先释放锁，再唤醒 Reply...
        processorBusy.delete(target);
        if (replyAction) {
          replyWakeFlag.set(target, { atMe: false });
          addLog('send', `💬 reply → ${tName()}`, null, target);
          // 等待 Reply 拿到锁并开始执行...
          for (let _w = 0; _w < 30; _w++) { ... }
          // Reply 正在执行 → 等它完成
          if (processorBusy.get(target) === 'reply') { ... }
        } else {
          await sleepInterruptible(state, 500);
        }

// AFTER:
        if (replyAction) {
          replyWakeFlag.set(target, { atMe: false });
          addLog('send', `💬 reply → ${tName()}`, null, target);
        }
        await sleepInterruptible(state, 500);
```

- [ ] **Step 6: Clean up Reply loop — remove mutex checks**

In the `replyLoop`, find and delete the Intent mutex wait (around line 2789-2795):

```javascript
// DELETE this block:
        if (processorBusy.get(target) === 'intent') {
          if (!waitingForIntent) {
            waitingForIntent = true;
            addLog('info', `⏳ Reply ${label}: waiting for Intent to finish`, null, target);
          }
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        waitingForIntent = false;
```

Also delete the `let waitingForIntent = false;` declaration if it exists nearby.

- [ ] **Step 7: Remove intentGate check from Reply loop**

Find and delete the intentGate block in Reply (around line 2816-2826):

```javascript
// DELETE this block:
        const gateLockTime = intentGate.get(target);
        if (gateLockTime) {
          if (Date.now() - gateLockTime < INTENT_GATE_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          intentGate.delete(target);
          addLog('warn', `🔓 Reply ${label}: intent gate timeout-unlocked (${INTENT_GATE_TIMEOUT_MS / 1000}s)`, null, target);
        }
```

- [ ] **Step 8: Remove processorBusy from Reply execution**

Find `processorBusy.set(target, 'reply')` (around line 2848) and delete it.

Find `processorBusy.delete(target)` in Reply's finally block (around line 2891) and delete it.

Find the safety cleanup comment and `processorBusy.delete(target)` (around line 2901-2903) and delete.

- [ ] **Step 9: Remove intentGate.set from Reply success path**

Find `intentGate.set(target, Date.now())` (around line 2881) and the associated log line, delete them:

```javascript
// DELETE these 2 lines:
              intentGate.set(target, Date.now());
              addLog('info', `🔒 Reply ${label}: gate locked`, null, target);
```

- [ ] **Step 10: Verify syntax**

Run: `node -c src/utils/socialAgent.js`
Expected: no output (success)

- [ ] **Step 11: Commit**

```bash
git add src/utils/socialAgent.js
git commit -m "refactor: remove Intent/Reply mutual exclusion, fire-and-forget Reply dispatch"
```

---

### Task 2: Add idle sleep (3min no messages)

**Files:**
- Modify: `src/utils/socialAgent.js`

- [ ] **Step 1: Add INTENT_IDLE_SLEEP_MS constant**

Find the timing constants section (around line 1769-1773, near `INTENT_MIN_INTERVAL_MS`). Add:

```javascript
const INTENT_IDLE_SLEEP_MS = 3 * 60 * 1000;    // 3 分钟无新消息 → 休眠
```

- [ ] **Step 2: Add getLastNonSelfMessageTime helper**

Add this helper function near the other utility functions in the social agent (e.g. near `hasNewNonSelfMessages` or `detectChange`):

```javascript
  /** 获取目标的最后一条非自己消息的时间戳（毫秒），用于空闲检测 */
  function getLastNonSelfMessageTime(target) {
    const buf = dataBuffer.get(target);
    if (!buf || buf.messages.length === 0) return 0;
    for (let i = buf.messages.length - 1; i >= 0; i--) {
      const msg = buf.messages[i];
      if (!msg.is_self && msg.timestamp) {
        return new Date(msg.timestamp).getTime() || 0;
      }
    }
    return 0;
  }
```

- [ ] **Step 3: Add idle sleep logic to Intent loop**

In the Intent loop, find the "no new messages" sleep (around line 2188-2190 in the `if (!hasNewMessages)` block):

```javascript
// BEFORE:
            if (!hasNewMessages) {
              await sleepInterruptible(state, 500);
              continue;
            }

// AFTER:
            if (!hasNewMessages) {
              const lastNonSelfTime = getLastNonSelfMessageTime(target);
              const idleMs = lastNonSelfTime > 0 ? Date.now() - lastNonSelfTime : 0;
              if (idleMs > INTENT_IDLE_SLEEP_MS) {
                addLog('intent', `🧠 [${tName()}] idle sleep (${Math.round(idleMs / 60000)}min no msgs)`, null, target);
                await sleepInterruptible(state, 30000); // 30s 长睡，可被 _wake() 唤醒
                continue;
              }
              await sleepInterruptible(state, 500);
              continue;
            }
```

- [ ] **Step 4: Verify syntax**

Run: `node -c src/utils/socialAgent.js`
Expected: no output (success)

- [ ] **Step 5: Commit**

```bash
git add src/utils/socialAgent.js
git commit -m "feat: add Intent idle sleep after 3min no messages"
```

---

### Task 3: Prompt file caching + parallel reads

**Files:**
- Modify: `src/utils/socialPromptBuilder.js`
- Modify: `src/utils/workspace/socialToolExecutor.js`

- [ ] **Step 1: Add cached file reader to socialPromptBuilder.js**

At the top of `src/utils/socialPromptBuilder.js`, after the existing imports (around line 11), add:

```javascript
// ── Prompt file cache (30s TTL) ──
const _fileCache = new Map(); // cacheKey → { content, ts }
const _FILE_CACHE_TTL = 30000;

async function cachedRead(readFn, cacheKey) {
  const entry = _fileCache.get(cacheKey);
  if (entry && Date.now() - entry.ts < _FILE_CACHE_TTL) return entry.content;
  const content = await readFn();
  _fileCache.set(cacheKey, { content, ts: Date.now() });
  return content;
}

/** Invalidate cache entries whose key contains the given path fragment */
export function invalidatePromptFileCache(pathFragment) {
  if (!pathFragment) return;
  for (const key of _fileCache.keys()) {
    if (key.includes(pathFragment)) _fileCache.delete(key);
  }
}
```

- [ ] **Step 2: Parallelize file reads in buildIntentSystemPrompt**

In `buildIntentSystemPrompt` (around line 650-710), replace the sequential awaits with `Promise.all`:

```javascript
// BEFORE (9 sequential awaits):
  const soulContent = await readSoulFile(petId);
  // ... (8 more sequential reads) ...
  const scratchNotes = await readScratchNotesFile(petId, targetId, targetType);

// AFTER:
  const [
    soulContent, userContent, memoryContent, groupRuleContent,
    contactsContent, peopleCacheContent, socialMemoryContent,
    intentStateContent, scratchNotes
  ] = await Promise.all([
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

Then keep the subsequent `truncateContent` and `sections.push` logic exactly as-is, just referencing the same variable names.

Note: `readStickerIndexForPrompt` (line 762) is called later inside a conditional — leave it as a standalone await (not worth caching, called once).

- [ ] **Step 3: Also parallelize reads in buildSocialPrompt**

In `buildSocialPrompt` (the Reply prompt builder, around line 237-295), apply the same pattern. Find the sequential reads:

```javascript
  const soulContent = await readSoulFile(petId);
  // ...
  const userContent = await readUserFile(petId);
  // ...
  const memoryContent = await readMemoryFile(petId);
  // ...
  const groupRuleContent = await readGroupRuleFile(petId, targetId);
  // ...
  const contactsContent = await readContactsFile(petId);
  // ...
  const socialMemoryContent = await readSocialMemoryFile(petId);
```

Replace with `Promise.all` using `cachedRead`, same pattern as Step 2. Use the same cache keys (Reply will hit Intent's warm cache).

- [ ] **Step 4: Add cache invalidation to socialToolExecutor**

In `src/utils/workspace/socialToolExecutor.js`, add the import at the top:

```javascript
import { invalidatePromptFileCache } from '../socialPromptBuilder.js';
```

Then in `executeSocialFileTool` (around line 330), add invalidation after write/edit operations:

```javascript
export async function executeSocialFileTool(toolName, args, context) {
  const { petId } = context;
  if (!petId) {
    return { error: '缺少 petId，无法执行社交文件操作。' };
  }

  console.log(`[SocialFile] Executing ${toolName}`, { petId, path: args?.path });

  let result;
  switch (toolName) {
    case 'social_tree':
      result = await executeSocialTree(petId);
      break;
    case 'social_read':
      result = await executeSocialRead(petId, args);
      break;
    case 'social_write':
      result = await executeSocialWrite(petId, args);
      if (args?.path) invalidatePromptFileCache(args.path);
      break;
    case 'social_edit':
      result = await executeSocialEdit(petId, args);
      if (args?.path) invalidatePromptFileCache(args.path);
      break;
    case 'social_delete':
      result = await executeSocialDelete(petId, args);
      if (args?.path) invalidatePromptFileCache(args.path);
      break;
    case 'social_rename':
      result = await executeSocialRename(petId, args);
      break;
    default:
      return { error: `未知的社交文件工具: ${toolName}` };
  }
  return result;
}
```

- [ ] **Step 5: Verify syntax**

```bash
node -c src/utils/socialPromptBuilder.js && node -c src/utils/workspace/socialToolExecutor.js && echo "OK"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/utils/socialPromptBuilder.js src/utils/workspace/socialToolExecutor.js
git commit -m "perf: add prompt file caching (30s TTL) + parallel reads in buildIntentSystemPrompt and buildSocialPrompt"
```
