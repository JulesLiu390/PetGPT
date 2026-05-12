/**
 * intentTraining.js — Build + append Intent eval training records.
 *
 * Called from socialAgent.js when training collection is enabled for the
 * target. Writes one JSONL line per Intent eval to
 * social/training/intent/{YYYY-MM-DD}.jsonl.
 *
 * Schema version 1 — see docs/superpowers/specs/2026-04-17-intent-training-data-collection-design.md
 */

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
    // Lazy-load tauri to avoid import errors in test environments
    const tauri = await import('./tauri');
    await tauri.workspaceAppend(petId, path, JSON.stringify(record) + '\n');
  } catch (e) {
    console.warn('[IntentTraining] write failed:', e);
  }
}
