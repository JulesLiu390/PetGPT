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

  const ul1 = await tauri.onSubagentEvent('subagent-done', async ({ taskId, exitCode }) => {
    const entry = subagentRegistry.get(taskId);
    if (!entry) return;

    try {
      const result = await tauri.workspaceRead(petId, `subagents/${taskId}/output/result.md`).catch(() => '');
      if (result && result.trim()) {
        if (entry.outputPath) {
          await tauri.workspaceWrite(petId, entry.outputPath, result);
        }
        entry.status = 'done';
        entry.result = result;
        const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
        addLog?.('subagent', `✅ subagent done: ${taskId} (${elapsed}s, ${result.length}字)`,
          JSON.stringify({ taskId, task: entry.task, elapsed, resultPreview: result.substring(0, 500), resultLen: result.length, status: 'done' }),
          entry.target);
      } else {
        entry.status = 'failed';
        entry.error = `CC exited (code=${exitCode}) but no result.md`;
        addLog?.('subagent', `❌ subagent error: ${taskId}: no output`,
          JSON.stringify({ taskId, task: entry.task, status: 'failed', error: entry.error }),
          entry.target);
      }
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message || String(e);
      addLog?.('error', `❌ subagent error: ${taskId}: ${entry.error}`, null, entry.target);
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
    addLog?.('subagent', `❌ subagent error: ${taskId}: ${error}`,
      JSON.stringify({ taskId, task: entry.task, status: 'failed', error }),
      entry.target);
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
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/output/.gitkeep`).catch(() => {});
    await tauri.workspaceDeleteFile(petId, `subagents/${taskId}/CLAUDE.md`).catch(() => {});
  } catch { /* best-effort */ }
}
