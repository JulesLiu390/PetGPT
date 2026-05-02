import type { Platform } from '../../platform/index.ts';
import type { ToolDefinition } from '../llm/index.ts';
import type { ToolHandler } from '../llm/tool-loop.ts';
import type { TargetType, IntentActionLite } from '../prompts/social.ts';

/**
 * Intent-mode tool set — get_situation + write_intent_plan.
 *
 * These two tools are tightly coupled to the social-agent eval loop:
 *   - get_situation  : Intent's mandatory first step. Returns the chat snapshot
 *                      + recent_self.md so the LLM can see what's happening
 *                      and what it has already said.
 *   - write_intent_plan : Intent's terminator. The LLM submits state + brief
 *                      + actions in one atomic call. Caller pairs it with
 *                      callWithTools({ stopAfterTool: 'write_intent_plan' })
 *                      and reads the captured plan from `ctx.capturedPlan`.
 *
 * MVP scope: in-flight reply injection (the multi-entry "在途 reply N/M" block
 * from the Tauri-era code) is omitted here; this primitive is for one-shot
 * evaluation, not continuous looping. Phase 3e2/3e3 will reintroduce it once
 * the spawn-reply loop lives in this codebase.
 */

export interface IntentToolsContext {
  petId: string;
  targetId: string;
  targetType: TargetType;
  /** Chat block to surface when the LLM calls get_situation. The host
   *  (Fetcher / API caller) renders messages → string and passes it here. */
  chatSnapshot: string;
  /** Mutated when the LLM calls write_intent_plan. Caller reads it after
   *  callWithTools resolves. */
  capturedPlan: { state: string; brief: string; actions: IntentActionLite[] } | null;
}

export function createIntentTools(platform: Platform, ctx: IntentToolsContext): {
  definitions: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
} {
  const ws = platform.workspace;
  const dir = ctx.targetType === 'friend' ? 'friend' : 'group';
  const intentPath  = `social/${dir}/INTENT_${ctx.targetId}.md`;
  const briefPath   = `social/${dir}/scratch_${ctx.targetId}/reply_brief.md`;
  const recentPath  = `social/${dir}/scratch_${ctx.targetId}/recent_self.md`;

  const definitions: ToolDefinition[] = [
    {
      name: 'get_situation',
      description: '获取当前现场快照——返回最近 N 条群聊记录 + 你最近的动作（recent_self.md）。Intent 评估的**第一步必做**。',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: '最多返回多少条群消息（默认 60）。chatSnapshot 已是预渲染文本，此参数仅作信号。' },
        },
      },
    },
    {
      name: 'write_intent_plan',
      description: '提交本次评估的**完整决策**——一次原子写入 INTENT 状态文件 + reply_brief（如有 reply 动作）+ 派发 actions。这是 eval 的最后一步，调用后 eval 立即结束。',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            description: '完整的 INTENT 状态文件内容（覆盖式写入）。包含【我刚做了】【效果复盘】【群里情况】【我的判断】【策略】等段。',
          },
          brief: {
            type: 'string',
            description: '完整的 reply_brief 内容（覆盖式写入）。**仅当 actions 含 reply 时才填**，否则不传或传空字符串。第 1 行必须是档位标签 [接梗] / [闲扯] / [观点] / [展开] / [深答]，正文 ≤150 字。',
          },
          actions: {
            type: 'array',
            description: '本轮要执行的动作。可包含 reply / sticker / image / wait 等。',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['reply', 'sticker', 'image', 'wait', 'intent', 'dispatch_subagent'] },
                id:   { type: ['string', 'number'] },
                file: { type: 'string' },
                atTarget: { type: 'string' },
                replyTo:  { type: 'string' },
                task:     { type: 'string' },
              },
            },
          },
        },
        required: ['state', 'actions'],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async get_situation(_args: any) {
      // Read recent_self.md (may not exist — that's fine)
      let recent = '';
      try { recent = (await ws.read(ctx.petId, recentPath)) || ''; } catch { /* missing */ }

      const chat = ctx.chatSnapshot.trim() || '（暂无群消息）';
      const out = [
        '# 当前情况快照',
        '',
        '## 群聊记录',
        chat,
        '',
        '## 你最近的动作 / 在途任务（recent_self）',
        recent.trim() || '（无最近动作）',
        '',
        '⚠️ eval 中途若有新消息，write_intent_plan 提交时会自动拦截，把增量新消息塞给你看，要求重新评估再次提交。所以你专注思考决策即可，不需要中途主动检查。',
      ].join('\n');

      return { content: out };
    },

    async write_intent_plan(args: any) {
      const state   = String(args?.state ?? '').trim();
      const briefRaw = String(args?.brief ?? '').trim();
      const actions = Array.isArray(args?.actions) ? (args.actions as IntentActionLite[]) : [];

      if (!state) {
        return { content: 'Error: state is required (the full INTENT.md content)', isError: true };
      }

      // Auto-fix: brief non-empty but actions has no reply → silently append a reply action.
      // Mirrors the Tauri-era autoFixPlanArgs to avoid surprising the LLM.
      const fixedActions = [...actions];
      if (briefRaw && !fixedActions.some(a => a?.type === 'reply')) {
        fixedActions.push({ type: 'reply' });
      }

      // Validate: actions has reply but brief empty
      const hasReply = fixedActions.some(a => a?.type === 'reply');
      if (hasReply && !briefRaw) {
        return {
          content: 'Error: actions 含 reply 但 brief 为空——必须提供完整 reply_brief（第 1 行档位标签，正文 ≤150 字），否则 Reply 层不知道说什么',
          isError: true,
        };
      }

      // Write INTENT state
      try {
        await ws.write(ctx.petId, intentPath, state);
      } catch (e: any) {
        return { content: `Error writing INTENT file: ${e?.message ?? String(e)}`, isError: true };
      }

      // Write reply_brief if needed
      if (hasReply) {
        try {
          await ws.write(ctx.petId, briefPath, briefRaw);
        } catch (e: any) {
          return { content: `Error writing reply_brief: ${e?.message ?? String(e)}`, isError: true };
        }
      }

      // Capture for caller
      ctx.capturedPlan = { state, brief: briefRaw, actions: fixedActions };

      const summary = [
        `✓ plan 已提交`,
        `  INTENT(${state.length}字) 写入 ${intentPath}`,
        hasReply ? `  brief(${briefRaw.length}字) 写入 ${briefPath}` : null,
        `  actions=[${fixedActions.map(a => a.type).join(',')}]`,
      ].filter(Boolean).join('\n');

      return { content: summary };
    },
  };

  return { definitions, handlers };
}
