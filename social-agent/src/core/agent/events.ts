import type { IntentActionLite } from '../prompts/social.ts';

/**
 * Agent event payloads + a single channel name.
 *
 * All agent events go through one EventEmitter channel ('agent') with a
 * tagged-union payload. Subscribers can dispatch on payload.type. This keeps
 * WS forwarding simple — one .on('agent', ...) feeds the websocket.
 */

export const AGENT_EVENT_CHANNEL = 'agent' as const;

/** Stable tag for event types so WS clients can render typed UIs. */
export type AgentEventType =
  | 'session:created'
  | 'session:stopped'
  | 'session:paused'
  | 'session:resumed'
  | 'eval:start'
  | 'eval:tool'
  | 'eval:plan'
  | 'eval:done'
  | 'eval:error';

interface BaseAgentEvent {
  type: AgentEventType;
  ts: number;
  targetId: string;
}

export interface SessionCreatedEvent extends BaseAgentEvent {
  type: 'session:created';
  petId: string;
  targetType: 'group' | 'friend';
  model: string;
  providerId: string;
}

export interface SessionStoppedEvent extends BaseAgentEvent {
  type: 'session:stopped';
}

export interface SessionPausedEvent extends BaseAgentEvent {
  type: 'session:paused';
}

export interface SessionResumedEvent extends BaseAgentEvent {
  type: 'session:resumed';
}

export interface EvalStartEvent extends BaseAgentEvent {
  type: 'eval:start';
  evalId: string;
  /** Length of the snapshot fed into this eval (for size signal in the UI). */
  snapshotLen: number;
}

export interface EvalToolEvent extends BaseAgentEvent {
  type: 'eval:tool';
  evalId: string;
  name: string;
  arguments: unknown;
  /** Truncated to keep WS payloads small; full content stays in eval result. */
  resultPreview: string;
  isError: boolean;
}

export interface EvalPlanEvent extends BaseAgentEvent {
  type: 'eval:plan';
  evalId: string;
  plan: { state: string; brief: string; actions: IntentActionLite[] };
}

export interface EvalDoneEvent extends BaseAgentEvent {
  type: 'eval:done';
  evalId: string;
  iterations: number;
  stoppedEarly: boolean;
  elapsedMs: number;
  hadPlan: boolean;
}

export interface EvalErrorEvent extends BaseAgentEvent {
  type: 'eval:error';
  evalId: string;
  message: string;
}

export type AgentEvent =
  | SessionCreatedEvent | SessionStoppedEvent | SessionPausedEvent | SessionResumedEvent
  | EvalStartEvent      | EvalToolEvent       | EvalPlanEvent     | EvalDoneEvent | EvalErrorEvent;
