/**
 * subagentManager.js — 全局 CC Subagent 状态管理
 *
 * 被 socialAgent.js（社交代理）和 ChatboxInputBox.jsx（聊天窗口）共享。
 * Rust 端 SubagentPool 天然全局，JS 侧也统一管理。
 */

import * as tauri from './tauri';
import { matchesSubagentScope } from './subagentCapability.js';

export { matchesSubagentScope } from './subagentCapability.js';

/** taskId → { status, task, target, targetType, dir, outputPath, source, createdAt, readByIntent, error, result, terminalAt, surfacedToIntent } */
export const subagentRegistry = new Map();

/** 非 running 的终态，只有终态条目才会被回收 */
export const TERMINAL_SUBAGENT_STATUSES = new Set(['done', 'failed', 'timeout']);

/**
 * 终态条目被注入 Intent prompt 这么多次后回收。
 *
 * 一次 eval 内部可能因 write_intent_plan 被拦截而重建多次 prompt，所以这里给的
 * 余量大于 1 —— 目的是「通报过就别再念了」，不是精确计数。
 */
export const MAX_INTENT_SURFACES = 3;

/** 兜底存活时间：没有任何一方来收的条目（例如聊天窗口派的）自己过期 */
export const TERMINAL_ENTRY_TTL_MS = 30 * 60 * 1000;

/** registry 总条数硬上限，超出时按完成时间淘汰最老的终态条目 */
export const REGISTRY_HARD_CAP = 200;

const _listeners = new Set();

export function onSubagentChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function _notify(eventType, payload) {
  for (const cb of _listeners) {
    try { cb(eventType, payload); } catch { /* ignore */ }
  }
}

export function notifySubagentChange(eventType, payload) {
  _notify(eventType, payload);
}

let _unlisteners = [];
let _initialized = false;

/**
 * Initialize subagent event listeners (idempotent — only runs once globally)
 */
export async function initSubagentListeners({ petId, addLog, wakeIntent }) {
  if (_initialized) return;
  _initialized = true;

  const ul1 = await tauri.onSubagentEvent('subagent-done', async ({ taskId, exitCode, stderr }) => {
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;

    const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
    const workspacePetId = entry.petId || petId;

    // === Reflect (lessons review) subagent: special handling ===
    if (entry.source === 'lessons') {
      try {
        const dir = entry.dir || 'group';
        const scratchPath = `social/${dir}/scratch_${entry.target}`;

        // 读取旧内容（用于 diff）
        const oldLessons = await tauri.workspaceRead(workspacePetId, `${scratchPath}/lessons.json`).catch(() => '');
        const oldPrinciples = await tauri.workspaceRead(workspacePetId, `${scratchPath}/principles.md`).catch(() => '');

        const lessonsOut = await tauri.workspaceRead(workspacePetId, `subagents/${taskId}/output/lessons.json`).catch(() => '');
        const principlesOut = await tauri.workspaceRead(workspacePetId, `subagents/${taskId}/output/principles.md`).catch(() => '');

        if (lessonsOut || principlesOut) {
          if (lessonsOut) {
            // 验证 JSON 有效性，无效则跳过
            let lessonsValid = false;
            try { JSON.parse(lessonsOut); lessonsValid = true; } catch {
              addLog?.('warn', `🪞 Reflect: lessons.json invalid, skipping`, null, entry.target);
            }
            if (lessonsValid) {
              await tauri.workspaceWrite(workspacePetId, `${scratchPath}/lessons.json`, lessonsOut);
            }
          }
          if (principlesOut) {
            await tauri.workspaceWrite(workspacePetId, `${scratchPath}/principles.md`, principlesOut);
          }
          entry.status = 'done';
          addLog?.('reflect', `🪞 Reflect done (${elapsed}s)`,
            JSON.stringify({
              taskId, elapsed, status: 'done',
              lessons: { before: oldLessons || '（空）', after: lessonsOut || '（无变化）' },
              principles: { before: oldPrinciples || '（空）', after: principlesOut || '（无变化）' },
            }),
            entry.target);
        } else {
          entry.status = 'failed';
          entry.error = 'No output files';
          addLog?.('reflect', `🪞 Reflect failed — no output`,
            JSON.stringify({ taskId, elapsed, status: 'failed', error: 'No output files' }),
            entry.target);
        }
      } catch (e) {
        entry.status = 'failed';
        entry.error = e.message || String(e);
        addLog?.('reflect', `🪞 Reflect error: ${entry.error}`,
          JSON.stringify({ taskId, elapsed, status: 'failed', error: entry.error }),
          entry.target);
      }
      _cleanupWorkspace(workspacePetId, taskId);
      markSubagentTerminal(entry);
      _notify('done', { taskId, entry });
      // reflect 结果已写入 workspace 文件，registry 条目到此没有任何消费方
      reapSubagentRegistry();
      return;
    }

    // === Normal CC subagent handling ===
    try {
      const result = await tauri.workspaceRead(workspacePetId, `subagents/${taskId}/output/result.md`).catch(() => '');
      if (result && result.trim()) {
        if (entry.outputPath) {
          await tauri.workspaceWrite(workspacePetId, entry.outputPath, result);
        }
        entry.status = 'done';
        entry.result = result;
        addLog?.('subagent', `✅ subagent done: ${taskId} (${elapsed}s, ${result.length}字)`,
          JSON.stringify({ taskId, task: entry.task, elapsed, resultPreview: result.substring(0, 500), resultLen: result.length, status: 'done' }),
          entry.target);
        // Append to cc_index.jsonl
        _appendIndex(workspacePetId, entry, { status: 'done', elapsed, resultLen: result.length });
      } else {
        entry.status = 'failed';
        const stderrPreview = stderr ? stderr.substring(0, 500) : '';
        entry.error = `CC exited (code=${exitCode}) no result.md${stderrPreview ? ` | stderr: ${stderrPreview}` : ''}`;
        addLog?.('subagent', `❌ subagent error: ${taskId}: ${entry.error}`,
          JSON.stringify({ taskId, task: entry.task, status: 'failed', error: entry.error, stderr: stderrPreview }),
          entry.target);
        _appendIndex(workspacePetId, entry, { status: 'failed', elapsed, error: entry.error });
      }
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message || String(e);
      addLog?.('error', `❌ subagent error: ${taskId}: ${entry.error}`, null, entry.target);
      _appendIndex(workspacePetId, entry, { status: 'failed', elapsed, error: entry.error });
    }

    _cleanupWorkspace(workspacePetId, taskId);
    markSubagentTerminal(entry);
    _notify('done', { taskId, entry });
    reapSubagentRegistry();
    if (entry.source === 'social' && wakeIntent) wakeIntent(entry.target);
  });
  _unlisteners.push(ul1);

  const ul2 = await tauri.onSubagentEvent('subagent-timeout', async ({ taskId }) => {
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;
    const workspacePetId = entry.petId || petId;
    entry.status = 'timeout';
    const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
    addLog?.('subagent', `⏰ subagent timeout: ${taskId} (${elapsed}s)`,
      JSON.stringify({ taskId, task: entry.task, status: 'timeout' }),
      entry.target);
    _appendIndex(workspacePetId, entry, { status: 'timeout', elapsed });
    _cleanupWorkspace(workspacePetId, taskId);
    markSubagentTerminal(entry);
    _notify('timeout', { taskId, entry });
    reapSubagentRegistry();
    if (entry.source === 'social' && wakeIntent) wakeIntent(entry.target);
  });
  _unlisteners.push(ul2);

  const ul3 = await tauri.onSubagentEvent('subagent-error', async ({ taskId, error }) => {
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;
    const workspacePetId = entry.petId || petId;
    entry.status = 'failed';
    entry.error = error;
    const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
    addLog?.('subagent', `❌ subagent error: ${taskId}: ${error}`,
      JSON.stringify({ taskId, task: entry.task, status: 'failed', error }),
      entry.target);
    _appendIndex(workspacePetId, entry, { status: 'failed', elapsed, error });
    _cleanupWorkspace(workspacePetId, taskId);
    markSubagentTerminal(entry);
    _notify('error', { taskId, entry });
    reapSubagentRegistry();
    if (entry.source === 'social' && wakeIntent) wakeIntent(entry.target);
  });
  _unlisteners.push(ul3);
}

export function destroySubagentListeners() {
  for (const ul of _unlisteners) ul();
  _unlisteners = [];
  _initialized = false;
}

export function killAll() {
  for (const [taskId, entry] of subagentRegistry) {
    if (entry.status === 'running') {
      tauri.subagentKill(taskId).catch(() => {});
    }
  }
  subagentRegistry.clear();
  _notify('clear', {});
}

export function killBySource(source) {
  for (const [taskId, entry] of subagentRegistry) {
    if (entry.source === source && entry.status === 'running') {
      tauri.subagentKill(taskId).catch(() => {});
      subagentRegistry.delete(taskId);
    }
  }
  _notify('clear', { source });
}

export function killByConversation(conversationId) {
  const targetId = String(conversationId || 'temp');
  for (const [taskId, entry] of subagentRegistry) {
    if (
      entry.source === 'chat'
      && entry.status === 'running'
      && String(entry.conversationId || 'temp') === targetId
    ) {
      tauri.subagentKill(taskId).catch(() => {});
      subagentRegistry.delete(taskId);
    }
  }
  _notify('clear', { source: 'chat', conversationId: targetId });
}

export function getActiveCount(scope = {}) {
  let n = 0;
  for (const entry of subagentRegistry.values()) {
    if (entry.status === 'running' && matchesSubagentScope(entry, scope)) n++;
  }
  return n;
}

/**
 * 记录条目进入终态的时刻。回收全部以 terminalAt 为准，所以每条终态事件都要调它。
 */
export function markSubagentTerminal(entry, now = Date.now()) {
  if (!entry || !TERMINAL_SUBAGENT_STATUSES.has(entry.status)) return entry;
  if (!entry.terminalAt) entry.terminalAt = now;
  return entry;
}

/**
 * 判断一个终态条目是否已经没人需要了。
 *
 * running 永不回收（还在跑）。终态条目在以下任一情况下回收：
 *  - source==='lessons'：结果直接落 workspace 文件，registry 条目没有任何消费方
 *    （它甚至不该出现在 Intent prompt 里 —— 之前因为带 target 而被误注入）
 *  - readByIntent：Intent 已经读走了输出文件
 *  - 已经向 Intent 通报过 MAX_INTENT_SURFACES 次：失败/超时说一遍就够了
 *  - 超过 TERMINAL_ENTRY_TTL_MS：没有任何一方来收，兜底过期
 */
export function isSubagentEntryReapable(entry, now = Date.now()) {
  if (!entry || !TERMINAL_SUBAGENT_STATUSES.has(entry.status)) return false;
  if (entry.source === 'lessons') return true;
  if (entry.readByIntent) return true;
  if ((entry.surfacedToIntent || 0) >= MAX_INTENT_SURFACES) return true;
  return now - (entry.terminalAt || entry.createdAt || 0) > TERMINAL_ENTRY_TTL_MS;
}

/**
 * 回收 registry 中不再被需要的终态条目，返回被删除的 taskId 列表。
 *
 * 在每次终态事件后、以及每轮 Intent eval 前调用。硬上限那一步是最后一道保险：
 * 即使某类条目的回收规则将来出了漏洞，registry 也不会无限增长。
 */
export function reapSubagentRegistry({ now = Date.now(), registry = subagentRegistry } = {}) {
  const reaped = [];
  for (const [taskId, entry] of registry) {
    if (isSubagentEntryReapable(entry, now)) {
      registry.delete(taskId);
      reaped.push(taskId);
    }
  }

  if (registry.size > REGISTRY_HARD_CAP) {
    const terminal = [];
    for (const [taskId, entry] of registry) {
      if (TERMINAL_SUBAGENT_STATUSES.has(entry?.status)) {
        terminal.push([taskId, entry.terminalAt || entry.createdAt || 0]);
      }
    }
    terminal.sort((a, b) => a[1] - b[1]);
    for (const [taskId] of terminal) {
      if (registry.size <= REGISTRY_HARD_CAP) break;
      registry.delete(taskId);
      reaped.push(taskId);
    }
  }

  return reaped;
}

async function _cleanupWorkspace(petId, taskId) {
  try {
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/result.md`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/lessons.md`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/lessons.json`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/principles.md`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/.gitkeep`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/CLAUDE.md`).catch(() => {});
  } catch { /* best-effort */ }
}

/** Append a completed task entry to cc_index.jsonl in the target's scratch dir */
async function _appendIndex(petId, entry, extra) {
  if (!entry.target || entry.target === 'chat') return;
  try {
    const dir = entry.targetType === 'friend' ? 'friend' : 'group';
    const indexPath = `social/${dir}/scratch_${entry.target}/cc_index.jsonl`;
    // Find taskId from registry
    let taskId = '';
    for (const [k, v] of subagentRegistry) {
      if (v === entry) { taskId = k; break; }
    }
    const line = JSON.stringify({
      taskId,
      task: entry.task,
      file: entry.resultFileName || null,
      createdAt: new Date(entry.createdAt).toISOString(),
      completedAt: new Date().toISOString(),
      ...extra,
    });
    await tauri.workspaceAppend(petId, indexPath, line + '\n');
  } catch { /* best-effort */ }
}
