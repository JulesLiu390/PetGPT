/**
 * subagentManager.js — 全局 CC Subagent 状态管理
 *
 * 被 socialAgent.js（社交代理）和 ChatboxInputBox.jsx（聊天窗口）共享。
 * Rust 端 SubagentPool 天然全局，JS 侧也统一管理。
 */

import * as tauri from './tauri';

/** taskId → { status, task, target, targetType, dir, outputPath, source, createdAt, readByIntent, error, result } */
export const subagentRegistry = new Map();

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

    // === Reflect (lessons review) subagent: special handling ===
    if (entry.source === 'lessons') {
      try {
        const dir = entry.dir || 'group';
        const scratchPath = `social/${dir}/scratch_${entry.target}`;

        // 读取旧内容（用于 diff）
        const oldLessons = await tauri.workspaceRead(petId, `${scratchPath}/lessons.json`).catch(() => '');
        const oldPrinciples = await tauri.workspaceRead(petId, `${scratchPath}/principles.md`).catch(() => '');

        const lessonsOut = await tauri.workspaceRead(petId, `subagents/${taskId}/output/lessons.json`).catch(() => '');
        const principlesOut = await tauri.workspaceRead(petId, `subagents/${taskId}/output/principles.md`).catch(() => '');

        if (lessonsOut || principlesOut) {
          if (lessonsOut) {
            // 验证 JSON 有效性，无效则跳过
            let lessonsValid = false;
            try { JSON.parse(lessonsOut); lessonsValid = true; } catch {
              addLog?.('warn', `🪞 Reflect: lessons.json invalid, skipping`, null, entry.target);
            }
            if (lessonsValid) {
              await tauri.workspaceWrite(petId, `${scratchPath}/lessons.json`, lessonsOut);
            }
          }
          if (principlesOut) {
            await tauri.workspaceWrite(petId, `${scratchPath}/principles.md`, principlesOut);
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
      _cleanupWorkspace(petId, taskId);
      _notify('done', { taskId, entry });
      return;
    }

    // === Normal CC subagent handling ===
    try {
      const result = await tauri.workspaceRead(petId, `subagents/${taskId}/output/result.md`).catch(() => '');
      if (result && result.trim()) {
        if (entry.outputPath) {
          await tauri.workspaceWrite(petId, entry.outputPath, result);
        }
        entry.status = 'done';
        entry.result = result;
        addLog?.('subagent', `✅ subagent done: ${taskId} (${elapsed}s, ${result.length}字)`,
          JSON.stringify({ taskId, task: entry.task, elapsed, resultPreview: result.substring(0, 500), resultLen: result.length, status: 'done' }),
          entry.target);
        // Append to cc_index.jsonl
        _appendIndex(petId, entry, { status: 'done', elapsed, resultLen: result.length });
      } else {
        entry.status = 'failed';
        const stderrPreview = stderr ? stderr.substring(0, 500) : '';
        entry.error = `CC exited (code=${exitCode}) no result.md${stderrPreview ? ` | stderr: ${stderrPreview}` : ''}`;
        addLog?.('subagent', `❌ subagent error: ${taskId}: ${entry.error}`,
          JSON.stringify({ taskId, task: entry.task, status: 'failed', error: entry.error, stderr: stderrPreview }),
          entry.target);
        _appendIndex(petId, entry, { status: 'failed', elapsed, error: entry.error });
      }
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message || String(e);
      addLog?.('error', `❌ subagent error: ${taskId}: ${entry.error}`, null, entry.target);
      _appendIndex(petId, entry, { status: 'failed', elapsed, error: entry.error });
    }

    _cleanupWorkspace(petId, taskId);
    _notify('done', { taskId, entry });
    if (entry.source === 'social' && wakeIntent) wakeIntent(entry.target);
  });
  _unlisteners.push(ul1);

  const ul2 = await tauri.onSubagentEvent('subagent-timeout', async ({ taskId }) => {
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;
    entry.status = 'timeout';
    const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
    addLog?.('subagent', `⏰ subagent timeout: ${taskId} (${elapsed}s)`,
      JSON.stringify({ taskId, task: entry.task, status: 'timeout' }),
      entry.target);
    _appendIndex(petId, entry, { status: 'timeout', elapsed });
    _cleanupWorkspace(petId, taskId);
    _notify('timeout', { taskId, entry });
    if (entry.source === 'social' && wakeIntent) wakeIntent(entry.target);
  });
  _unlisteners.push(ul2);

  const ul3 = await tauri.onSubagentEvent('subagent-error', async ({ taskId, error }) => {
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;
    entry.status = 'failed';
    entry.error = error;
    const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
    addLog?.('subagent', `❌ subagent error: ${taskId}: ${error}`,
      JSON.stringify({ taskId, task: entry.task, status: 'failed', error }),
      entry.target);
    _appendIndex(petId, entry, { status: 'failed', elapsed, error });
    _cleanupWorkspace(petId, taskId);
    _notify('error', { taskId, entry });
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

export function getActiveCount() {
  let n = 0;
  for (const entry of subagentRegistry.values()) {
    if (entry.status === 'running') n++;
  }
  return n;
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
