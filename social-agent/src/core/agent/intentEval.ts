import type { Platform } from '../../platform/index.ts';
import type { Provider } from '../../providers.ts';
import type { ChatMessage, ToolCall } from '../llm/index.ts';
import { createLLMClient, callWithTools } from '../llm/index.ts';
import { createSocialPromptBuilders, type LurkMode, type TargetType, type IntentActionLite } from '../prompts/social.ts';
import { createWorkspaceTools } from '../tools/workspace.ts';
import { createIntentTools, type InFlightReplyView } from '../tools/intent.ts';

/**
 * One-shot Intent evaluation.
 *
 * Given a chat snapshot + LLM provider, run the full Intent loop:
 *   1. build the (huge) Intent system prompt via createSocialPromptBuilders
 *   2. register tools: workspace I/O (social_read/write/edit/list)
 *      + intent-only (get_situation, write_intent_plan)
 *   3. callWithTools with stopAfterTool='write_intent_plan'
 *   4. read back the captured plan and return it alongside the tool transcript
 *
 * This is the building block for the eventual continuous Intent loop. It does
 * not poll MCP, dispatch Reply tasks, or run Observer — those layers live in
 * separate phases.
 */

export interface RunIntentEvalOptions {
  petId: string;
  targetId: string;
  targetType?: TargetType;

  provider: Provider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxIterations?: number;

  /** Pre-rendered chat snapshot fed to the LLM via get_situation. Caller owns
   *  the rendering format (timestamps, sender names, [#message-id], etc.) */
  chatSnapshot: string;

  // Forwarded to buildIntentSystemPrompt
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
  sinceLastEvalMin?: number;

  /** Override the user-facing kickoff message. Default: a single-character "go"
   *  prompt — the system prompt instructs the LLM to call get_situation first. */
  userPrompt?: string;

  /** Snapshot of currently in-flight replies for this target, surfaced via
   *  get_situation as "在途 reply N/M" blocks. Caller (AgentManager) owns
   *  this list; intentEval is read-only. */
  inFlightReplies?: InFlightReplyView[];
}

export interface IntentToolTrace {
  name: string;
  arguments: unknown;
  resultContent: string;
  isError: boolean;
}

export interface IntentEvalResult {
  /** Captured write_intent_plan args. null if the LLM never submitted a plan. */
  plan: { state: string; brief: string; actions: IntentActionLite[] } | null;
  /** Trace of every tool call + its result, in order. */
  toolCalls: IntentToolTrace[];
  /** Last assistant message content (often empty when terminator tool fires). */
  finalContent: string;
  iterations: number;
  stoppedEarly: boolean;
  /** Total token usage across the loop. */
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  /** Full transcript including assistant + tool turns — useful for debugging. */
  messages: ChatMessage[];
}

export async function runIntentEval(
  platform: Platform,
  opts: RunIntentEvalOptions,
): Promise<IntentEvalResult> {
  const targetType = opts.targetType ?? 'group';

  // 1. Build the Intent system prompt (uses platform.workspace internally)
  const promptBuilders = createSocialPromptBuilders(platform);
  const systemPrompt = await promptBuilders.buildIntentSystemPrompt({
    petId: opts.petId,
    targetId: opts.targetId,
    targetType,
    targetName: opts.targetName,
    socialPersonaPrompt: opts.socialPersonaPrompt,
    botQQ: opts.botQQ,
    ownerQQ: opts.ownerQQ,
    ownerName: opts.ownerName,
    ownerSecret: opts.ownerSecret,
    nameDelimiterL: opts.nameDelimiterL,
    nameDelimiterR: opts.nameDelimiterR,
    msgDelimiterL: opts.msgDelimiterL,
    msgDelimiterR: opts.msgDelimiterR,
    lurkMode: opts.lurkMode,
    voiceEnabled: opts.voiceEnabled,
    imageGenEnabled: opts.imageGenEnabled,
    customGroupRules: opts.customGroupRules,
    sinceLastEvalMin: opts.sinceLastEvalMin,
  });

  // 2. Tools: workspace + intent
  const wsTools     = createWorkspaceTools(platform, opts.petId);
  const intentCtx   = {
    petId: opts.petId,
    targetId: opts.targetId,
    targetType,
    chatSnapshot: opts.chatSnapshot,
    capturedPlan: null as IntentEvalResult['plan'],
    inFlightReplies: opts.inFlightReplies ?? [],
  };
  const intentTools = createIntentTools(platform, intentCtx);

  const tools    = [...wsTools.definitions, ...intentTools.definitions];
  const handlers = { ...wsTools.handlers, ...intentTools.handlers };

  // 3. Run the loop
  const t0 = Date.now();
  const trace: IntentToolTrace[] = [];

  const client = createLLMClient(platform, opts.provider);
  const result = await callWithTools({
    client,
    model: opts.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: opts.userPrompt ?? '现在评估一下，按系统 prompt 的步骤先 get_situation，最后 write_intent_plan。' },
    ],
    tools,
    handlers,
    maxIterations: opts.maxIterations ?? 10,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
    stopAfterTool: 'write_intent_plan',
    onToolResult(call: ToolCall, r) {
      trace.push({
        name: call.name,
        arguments: call.arguments,
        resultContent: r.content,
        isError: !!r.isError,
      });
    },
  });

  // 4. Aggregate token usage from raw responses (Anthropic / OpenAI / Gemini all
  //    surface input/output counts on each chat() call; we sum across iterations.)
  let inputTokens = 0, outputTokens = 0;
  for (const m of result.messages) {
    // Each assistant message corresponds to one chat() round — but our type doesn't
    // carry usage. We fall back to 0 if not exposed; future improvement is to thread
    // per-iteration usage through callWithTools result.
    void m;
  }
  // The current callWithTools doesn't expose per-iteration usage. Leave 0 for now;
  // Phase 3e2 will surface it via onIterationStart hook returning the chat().usage.

  return {
    plan: intentCtx.capturedPlan,
    toolCalls: trace,
    finalContent: result.finalContent,
    iterations: result.iterations,
    stoppedEarly: result.stoppedEarly,
    inputTokens,
    outputTokens,
    elapsedMs: Date.now() - t0,
    messages: result.messages,
  };
}
