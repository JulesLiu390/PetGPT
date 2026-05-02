import { randomUUID } from 'node:crypto';
import type { Platform } from '../../platform/index.ts';
import type { Provider } from '../../providers.ts';
import { runIntentEval } from './intentEval.ts';
import { runReply } from './replyTask.ts';
import type { SessionConfig, SessionState, SessionView } from './types.ts';
import { AGENT_EVENT_CHANNEL, type AgentEvent } from './events.ts';
import type { InFlightReplyView } from '../tools/intent.ts';

/**
 * Continuous Intent loop manager (Phase 3e2).
 *
 * Owns one SessionState per (petId, targetId). Drives runIntentEval whenever
 * fresh chat content arrives via feedChat(). While an eval is running, new
 * snapshots overwrite `pendingSnapshot`; the loop picks them up at the end of
 * the current eval, so multiple bursts of chat collapse into one evaluation.
 *
 * Emits AgentEvent on platform.events under channel='agent'. WS clients
 * subscribe once and receive every session's events; UIs filter by targetId.
 */

export interface AgentManager {
  start(config: SessionConfig): SessionView;
  stop(targetId: string): boolean;
  pause(targetId: string): boolean;
  resume(targetId: string): boolean;
  feedChat(targetId: string, chatSnapshot: string): boolean;
  list(): SessionView[];
  get(targetId: string): SessionView | undefined;
}

export interface AgentManagerOptions {
  /** How the manager looks up a Provider record (incl. apiKey) by id. */
  providerLookup: (providerId: string) => Promise<Provider | undefined>;
}

const PREVIEW_MAX = 280;
const MAX_CONCURRENT_REPLY = 3;

export function createAgentManager(platform: Platform, opts: AgentManagerOptions): AgentManager {
  const sessions = new Map<string, SessionState>();
  /** target → array of in-flight reply tasks (max MAX_CONCURRENT_REPLY each).
   *  Brief is snapshotted at dispatch so intent layer's reply_brief.md
   *  rewrites don't mutate live tasks. */
  const inFlightReplies = new Map<string, InFlightReplyView[]>();

  const emit = (e: AgentEvent) => platform.events.emit(AGENT_EVENT_CHANNEL, e);

  function toView(s: SessionState): SessionView {
    return {
      config: s.config,
      status: s.status,
      lastEvalAt: s.lastEvalAt,
      evalCount: s.evalCount,
      lastPlan: s.lastPlan,
      hasPendingSnapshot: s.pendingSnapshot !== null,
      createdAt: s.createdAt,
    };
  }

  function preview(s: string): string {
    if (s.length <= PREVIEW_MAX) return s;
    return s.slice(0, PREVIEW_MAX) + `\n…(+${s.length - PREVIEW_MAX} chars)`;
  }

  function getInFlight(targetId: string): InFlightReplyView[] {
    return inFlightReplies.get(targetId) || [];
  }

  /**
   * Fire-and-forget Reply task launcher.
   * Pushes an entry onto inFlightReplies (snapshotting brief at dispatch),
   * runs runReply, splices the entry on completion.
   */
  async function spawnReplyTask(targetId: string, snapshot: string): Promise<void> {
    const s = sessions.get(targetId);
    if (!s) return;
    if (s.status === 'paused') {
      platform.events.emit<AgentEvent>(AGENT_EVENT_CHANNEL, {
        type: 'reply:skip', ts: Date.now(), targetId,
        reason: 'paused', inFlightCount: getInFlight(targetId).length,
      });
      return;
    }

    const list = getInFlight(targetId);
    if (list.length >= MAX_CONCURRENT_REPLY) {
      emit({
        type: 'reply:skip', ts: Date.now(), targetId,
        reason: 'concurrency-limit', inFlightCount: list.length,
      });
      return;
    }

    // Snapshot brief at dispatch — protects against Intent's next reply_brief.md overwrite.
    const dir = (s.config.targetType ?? 'group') === 'friend' ? 'friend' : 'group';
    const briefPath = `social/${dir}/scratch_${targetId}/reply_brief.md`;
    let briefSnapshot = '';
    try { briefSnapshot = (await platform.workspace.read(s.config.petId, briefPath)) || ''; }
    catch { /* missing — emit skip */ }

    if (!briefSnapshot.trim()) {
      emit({
        type: 'reply:skip', ts: Date.now(), targetId,
        reason: 'no-brief', inFlightCount: list.length,
      });
      return;
    }

    const replyId = randomUUID();
    const entry: InFlightReplyView = { id: replyId, brief: briefSnapshot.trim(), createdAt: Date.now() };
    list.push(entry);
    inFlightReplies.set(targetId, list);

    emit({
      type: 'reply:spawn', ts: Date.now(), targetId, replyId,
      brief: entry.brief, inFlightCount: list.length,
    });

    let provider: Provider | undefined;
    let sent = false;
    let iterations = 0;
    const startedAt = Date.now();
    try {
      provider = await opts.providerLookup(s.config.providerId);
      if (!provider) throw new Error(`provider not found: ${s.config.providerId}`);

      const r = await runReply(platform, {
        petId: s.config.petId, targetId, targetType: s.config.targetType,
        provider, model: s.config.model,
        temperature: s.config.temperature, maxTokens: s.config.maxTokens,
        timeoutMs: s.config.timeoutMs,
        chatSnapshot: snapshot,
        socialPersonaPrompt: s.config.socialPersonaPrompt,
        targetName: s.config.targetName, botQQ: s.config.botQQ,
        ownerQQ: s.config.ownerQQ, ownerName: s.config.ownerName, ownerSecret: s.config.ownerSecret,
        nameDelimiterL: s.config.nameDelimiterL, nameDelimiterR: s.config.nameDelimiterR,
        msgDelimiterL: s.config.msgDelimiterL, msgDelimiterR: s.config.msgDelimiterR,
        lurkMode: s.config.lurkMode,
      });
      iterations = r.iterations;

      for (const t of r.toolCalls) {
        emit({
          type: 'reply:tool', ts: Date.now(), targetId, replyId,
          name: t.name, arguments: t.arguments,
          resultPreview: preview(t.resultContent),
          isError: t.isError,
        });
      }

      if (r.captured) {
        sent = true;
        emit({
          type: 'reply:sent', ts: Date.now(), targetId, replyId,
          content: r.captured.content,
          replyTo: r.captured.replyTo,
        });
      }

      emit({
        type: 'reply:done', ts: Date.now(), targetId, replyId,
        sent, iterations, elapsedMs: Date.now() - startedAt,
      });
    } catch (e: any) {
      emit({
        type: 'reply:error', ts: Date.now(), targetId, replyId,
        message: e?.message ?? String(e),
      });
    } finally {
      // Splice entry from in-flight list, even on error/skip — list is the
      // source of truth and must drain.
      const cur = inFlightReplies.get(targetId);
      if (cur) {
        const idx = cur.findIndex(x => x.id === replyId);
        if (idx >= 0) {
          cur.splice(idx, 1);
          if (cur.length === 0) inFlightReplies.delete(targetId);
          else inFlightReplies.set(targetId, cur);
        }
      }
    }
  }

  /**
   * Async eval driver. Picks up `pendingSnapshot`, runs runIntentEval, emits
   * events. After the eval ends, if a NEW snapshot arrived during the run,
   * recurses (no recursion in async terms — just re-enters via setImmediate).
   */
  async function runEvalIfNeeded(targetId: string): Promise<void> {
    const s = sessions.get(targetId);
    if (!s) return;
    if (s.status !== 'idle') return;            // paused or already evaluating
    if (s.pendingSnapshot === null) return;      // nothing to do

    // Promote pending → active
    const snapshot = s.pendingSnapshot;
    s.pendingSnapshot = null;
    s.activeSnapshot  = snapshot;
    s.status = 'evaluating';

    const evalId = randomUUID();
    const startedAt = Date.now();
    s.lastEvalAt = startedAt;
    s.evalCount  += 1;

    emit({ type: 'eval:start', ts: startedAt, targetId, evalId, snapshotLen: snapshot.length });

    let provider: Provider | undefined;
    try {
      provider = await opts.providerLookup(s.config.providerId);
      if (!provider) throw new Error(`provider not found: ${s.config.providerId}`);

      const result = await runIntentEval(platform, {
        petId:               s.config.petId,
        targetId:            s.config.targetId,
        targetType:          s.config.targetType,
        provider,
        model:               s.config.model,
        temperature:         s.config.temperature,
        maxTokens:           s.config.maxTokens,
        timeoutMs:           s.config.timeoutMs,
        maxIterations:       s.config.maxIterations,
        chatSnapshot:        snapshot,
        targetName:          s.config.targetName,
        socialPersonaPrompt: s.config.socialPersonaPrompt,
        botQQ:               s.config.botQQ,
        ownerQQ:             s.config.ownerQQ,
        ownerName:           s.config.ownerName,
        ownerSecret:         s.config.ownerSecret,
        nameDelimiterL:      s.config.nameDelimiterL,
        nameDelimiterR:      s.config.nameDelimiterR,
        msgDelimiterL:       s.config.msgDelimiterL,
        msgDelimiterR:       s.config.msgDelimiterR,
        lurkMode:            s.config.lurkMode,
        voiceEnabled:        s.config.voiceEnabled,
        imageGenEnabled:     s.config.imageGenEnabled,
        customGroupRules:    s.config.customGroupRules,
        sinceLastEvalMin:    s.lastEvalAt
          ? Math.max(0, Math.round((startedAt - s.lastEvalAt) / 60000))
          : 0,
        inFlightReplies:     getInFlight(targetId),
      });

      // Mid-stream events: each tool result becomes one eval:tool event.
      for (const t of result.toolCalls) {
        emit({
          type: 'eval:tool', ts: Date.now(), targetId, evalId,
          name: t.name, arguments: t.arguments,
          resultPreview: preview(t.resultContent),
          isError: t.isError,
        });
      }

      if (result.plan) {
        s.lastPlan = result.plan;
        emit({ type: 'eval:plan', ts: Date.now(), targetId, evalId, plan: result.plan });

        // If the plan contains a reply action, fire-and-forget the Reply task.
        // Concurrency / pause / brief-empty checks live inside spawnReplyTask.
        const hasReply = result.plan.actions.some(a => a?.type === 'reply');
        if (hasReply) {
          spawnReplyTask(targetId, snapshot).catch(() => { /* error already emitted */ });
        }
      }

      emit({
        type: 'eval:done', ts: Date.now(), targetId, evalId,
        iterations: result.iterations, stoppedEarly: result.stoppedEarly,
        elapsedMs: result.elapsedMs, hadPlan: result.plan !== null,
      });
    } catch (e: any) {
      emit({
        type: 'eval:error', ts: Date.now(), targetId, evalId,
        message: e?.message ?? String(e),
      });
    } finally {
      // Re-check session in case it was stopped during the eval
      const cur = sessions.get(targetId);
      if (!cur) return;
      cur.activeSnapshot = null;
      // Only clear the evaluating flag if we own the eval (status not changed by stop/pause)
      if (cur.status === 'evaluating') {
        cur.status = 'idle';
      }
      // If a new snapshot arrived while we were evaluating, kick another round.
      if (cur.status === 'idle' && cur.pendingSnapshot !== null) {
        // Defer to next tick so consumers see eval:done before the next eval:start.
        setImmediate(() => { runEvalIfNeeded(targetId).catch(() => { /* logged via events */ }); });
      }
    }
  }

  return {
    start(config: SessionConfig): SessionView {
      if (sessions.has(config.targetId)) {
        throw new Error(`session already exists for targetId=${config.targetId}`);
      }
      const s: SessionState = {
        config,
        status: 'idle',
        lastEvalAt: null,
        evalCount: 0,
        lastPlan: null,
        pendingSnapshot: null,
        activeSnapshot: null,
        createdAt: Date.now(),
      };
      sessions.set(config.targetId, s);
      emit({
        type: 'session:created',
        ts: Date.now(),
        targetId: config.targetId,
        petId: config.petId,
        targetType: config.targetType ?? 'group',
        model: config.model,
        providerId: config.providerId,
      });
      return toView(s);
    },

    stop(targetId: string): boolean {
      const s = sessions.get(targetId);
      if (!s) return false;
      sessions.delete(targetId);
      // Forget queued in-flight reply views — running tasks will still attempt
      // to splice their entry on completion (no-op if the list is gone).
      inFlightReplies.delete(targetId);
      emit({ type: 'session:stopped', ts: Date.now(), targetId });
      return true;
    },

    pause(targetId: string): boolean {
      const s = sessions.get(targetId);
      if (!s) return false;
      if (s.status === 'paused') return false;
      // Only flip the bit; an active eval continues to completion. New feeds
      // will queue but not trigger new evals while paused.
      const wasIdle = s.status === 'idle';
      s.status = 'paused';
      void wasIdle;
      emit({ type: 'session:paused', ts: Date.now(), targetId });
      return true;
    },

    resume(targetId: string): boolean {
      const s = sessions.get(targetId);
      if (!s) return false;
      if (s.status !== 'paused') return false;
      s.status = 'idle';
      emit({ type: 'session:resumed', ts: Date.now(), targetId });
      // Pick up any queued snapshot
      if (s.pendingSnapshot !== null) {
        setImmediate(() => { runEvalIfNeeded(targetId).catch(() => { /* logged */ }); });
      }
      return true;
    },

    feedChat(targetId: string, chatSnapshot: string): boolean {
      const s = sessions.get(targetId);
      if (!s) return false;
      // Replace, not append — eval consumes the latest snapshot wholesale.
      s.pendingSnapshot = chatSnapshot;
      // Trigger eval if idle. If evaluating, the active eval will pick this up
      // on completion. If paused, it sits in pendingSnapshot until resume().
      if (s.status === 'idle') {
        setImmediate(() => { runEvalIfNeeded(targetId).catch(() => { /* logged */ }); });
      }
      return true;
    },

    list(): SessionView[] {
      return Array.from(sessions.values()).map(toView);
    },

    get(targetId: string): SessionView | undefined {
      const s = sessions.get(targetId);
      return s ? toView(s) : undefined;
    },
  };
}
