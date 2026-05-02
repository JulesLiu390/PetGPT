import type { TargetType, LurkMode, IntentActionLite } from '../prompts/social.ts';

/** Per-session config — what the agent uses to build prompts and call LLMs. */
export interface SessionConfig {
  petId: string;
  targetId: string;
  targetType?: TargetType;

  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxIterations?: number;

  // forwarded to buildIntentSystemPrompt
  targetName?: string;
  socialPersonaPrompt?: string;
  botQQ?: string;
  ownerQQ?: string;
  ownerName?: string;
  ownerSecret?: string;
  nameDelimiterL?: string;
  nameDelimiterR?: string;
  msgDelimiterL?: string;
  msgDelimiterR?: string;
  lurkMode?: LurkMode;
  voiceEnabled?: boolean;
  imageGenEnabled?: boolean;
  customGroupRules?: string;

  // ─── MCP dispatch (Phase 5c) ───
  /** When set, captured Reply content is forwarded to this MCP server. */
  mcpServerName?: string;
  /** Tool name to invoke on the MCP server. Default 'send_message'. */
  mcpSendTool?: string;
}

export type SessionStatus = 'idle' | 'evaluating' | 'paused';

/** Live state of a session (internal — exported for read-only consumption). */
export interface SessionState {
  config: SessionConfig;
  status: SessionStatus;
  /** epoch ms of the last eval start; null if never evaluated. */
  lastEvalAt: number | null;
  /** Total evals run since session was created. */
  evalCount: number;
  /** Last successfully captured plan, or null. */
  lastPlan: { state: string; brief: string; actions: IntentActionLite[] } | null;
  /** Queued chat snapshot waiting to be evaluated. Populated by feedChat
   *  while another eval is in progress; consumed when the active eval ends. */
  pendingSnapshot: string | null;
  /** Currently-running eval's snapshot (if status === 'evaluating'). */
  activeSnapshot: string | null;
  createdAt: number;
}

/** Read-only view safe to send over the wire. */
export interface SessionView {
  config: SessionConfig;
  status: SessionStatus;
  lastEvalAt: number | null;
  evalCount: number;
  lastPlan: { state: string; brief: string; actions: IntentActionLite[] } | null;
  hasPendingSnapshot: boolean;
  createdAt: number;
}
