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
  | 'eval:error'
  | 'reply:spawn'
  | 'reply:skip'
  | 'reply:tool'
  | 'reply:sent'
  | 'reply:done'
  | 'reply:error'
  | 'reply:dispatched'
  | 'reply:dispatch-failed'
  | 'fetch:started'
  | 'fetch:tick'
  | 'fetch:error'
  | 'fetch:stopped';

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

export interface ReplySpawnEvent extends BaseAgentEvent {
  type: 'reply:spawn';
  replyId: string;
  /** Brief snapshot at dispatch time. */
  brief: string;
  /** Concurrency: this task's index + total in-flight at spawn. */
  inFlightCount: number;
}

export interface ReplySkipEvent extends BaseAgentEvent {
  type: 'reply:skip';
  reason: 'concurrency-limit' | 'no-brief' | 'paused' | 'other';
  inFlightCount: number;
}

export interface ReplyToolEvent extends BaseAgentEvent {
  type: 'reply:tool';
  replyId: string;
  name: string;
  arguments: unknown;
  resultPreview: string;
  isError: boolean;
}

export interface ReplySentEvent extends BaseAgentEvent {
  type: 'reply:sent';
  replyId: string;
  content: string;
  replyTo?: string;
}

export interface ReplyDoneEvent extends BaseAgentEvent {
  type: 'reply:done';
  replyId: string;
  /** Whether send_message was actually invoked during the run. */
  sent: boolean;
  iterations: number;
  elapsedMs: number;
}

export interface ReplyErrorEvent extends BaseAgentEvent {
  type: 'reply:error';
  replyId: string;
  message: string;
}

export interface ReplyDispatchedEvent extends BaseAgentEvent {
  type: 'reply:dispatched';
  replyId: string;
  mcpServerName: string;
  toolName: string;
  /** Vendor-specific MCP callTool result, kept opaque on the wire. */
  result: unknown;
}

export interface ReplyDispatchFailedEvent extends BaseAgentEvent {
  type: 'reply:dispatch-failed';
  replyId: string;
  mcpServerName: string;
  toolName: string;
  message: string;
}

export interface FetchStartedEvent extends BaseAgentEvent {
  type: 'fetch:started';
  mcpServerName: string;
  toolName: string;
  intervalMs: number;
}

export interface FetchTickEvent extends BaseAgentEvent {
  type: 'fetch:tick';
  newMessageCount: number;
  bufferSize: number;
  watermark: string | null;
}

export interface FetchErrorEvent extends BaseAgentEvent {
  type: 'fetch:error';
  message: string;
}

export interface FetchStoppedEvent extends BaseAgentEvent {
  type: 'fetch:stopped';
  reason: 'session-stopped' | 'session-paused' | 'config-missing';
}

export type AgentEvent =
  | SessionCreatedEvent | SessionStoppedEvent | SessionPausedEvent | SessionResumedEvent
  | EvalStartEvent      | EvalToolEvent       | EvalPlanEvent     | EvalDoneEvent | EvalErrorEvent
  | ReplySpawnEvent     | ReplySkipEvent      | ReplyToolEvent    | ReplySentEvent | ReplyDoneEvent | ReplyErrorEvent
  | ReplyDispatchedEvent | ReplyDispatchFailedEvent
  | FetchStartedEvent    | FetchTickEvent  | FetchErrorEvent | FetchStoppedEvent;
