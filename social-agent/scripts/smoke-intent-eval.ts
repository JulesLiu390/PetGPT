/**
 * Smoke test for runIntentEval (Phase 3e1).
 *
 * Mock Anthropic-shaped LLM endpoint that walks the LLM through a realistic
 * 3-round Intent eval:
 *   round 1 → get_situation()                  (read snapshot)
 *   round 2 → social_read(INTENT_*.md)          (read prior state, may not exist)
 *   round 3 → write_intent_plan(state, brief, actions=[reply])  (terminator)
 *
 * Verifies:
 *   - prompt builder ran without crashing
 *   - get_situation returned chatSnapshot + recent_self
 *   - write_intent_plan persisted INTENT.md + reply_brief.md to disk
 *   - capturedPlan returned to caller
 *   - stopAfterTool fires (loop ends after write_intent_plan)
 *
 * Run: bun run scripts/smoke-intent-eval.ts
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';
import { runIntentEval } from '../src/core/agent/intentEval.ts';
import type { Provider } from '../src/providers.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const home = mkdtempSync(join(tmpdir(), 'social-agent-intent-eval-'));
const platform = createNodePlatform(home);
const petId = 'pet-test';
const targetId = '111';

// Pre-create some pet files so the prompt builder has content
await platform.workspace.write(petId, 'SOUL.md', '# Soul\n你是一只猫娘助手。');
await platform.workspace.write(petId, 'social/group/RULE_111.md', '## 测试群规则\n群里讨论技术。');

// ── mock Anthropic server ──
let round = 0;
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/v1/messages') return new Response('not found', { status: 404 });
    round++;

    // Round 1: get_situation
    if (round === 1) {
      return Response.json({
        id: 'm1', type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_situation', input: { n: 60 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1000, output_tokens: 20 },
      });
    }

    // Round 2: social_read INTENT (may not exist — agent will get error)
    if (round === 2) {
      return Response.json({
        id: 'm2', type: 'message', role: 'assistant', model: 'm',
        content: [{
          type: 'tool_use', id: 'tu_2', name: 'social_read',
          input: { path: `social/group/INTENT_${targetId}.md` },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1500, output_tokens: 30 },
      });
    }

    // Round 3: terminator — write_intent_plan
    if (round === 3) {
      return Response.json({
        id: 'm3', type: 'message', role: 'assistant', model: 'm',
        content: [
          { type: 'text', text: '基于现场快照，决定回复。' },
          {
            type: 'tool_use', id: 'tu_3', name: 'write_intent_plan',
            input: {
              state:
                '【我刚做了】刚苏醒，第一次评估。\n' +
                '【群里情况】Bob 在问问题。\n' +
                '【我的判断】简短回应即可。',
              brief: '[闲扯]\n回应 Bob 的问题，淡定语气。',
              actions: [{ type: 'reply' }],
            },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1700, output_tokens: 80 },
      });
    }

    // Should never reach here — stopAfterTool='write_intent_plan' should bail.
    return Response.json({
      id: 'm-extra', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'text', text: 'unexpected extra round' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 10 },
    });
  },
});

const provider: Provider = {
  id: 'p', type: 'anthropic', name: 'mock',
  apiKey: 'sk-test', baseUrl: `http://localhost:${mock.port}`,
  createdAt: 0, updatedAt: 0,
};

console.log('\n── runIntentEval ──');
const result = await runIntentEval(platform, {
  petId, targetId, targetType: 'group',
  provider, model: 'claude-test',
  chatSnapshot:
    '[14:00:01] Bob(2222) [#abc1]: 这个问题怎么解决？\n' +
    '[14:00:30] Charlie(3333) [#abc2]: 我也想知道。',
  targetName: '测试群',
  botQQ: '99999',
  lurkMode: 'normal',
  maxIterations: 8,
});

check('iterations === 3',          result.iterations === 3);
check('stopped early (terminator)', result.stoppedEarly === true);
check('plan captured',             result.plan !== null);
check('plan.state non-empty',      !!result.plan?.state && result.plan.state.length > 0);
check('plan.brief non-empty',      !!result.plan?.brief && result.plan.brief.includes('[闲扯]'));
check('plan.actions has reply',    !!result.plan?.actions.some(a => a.type === 'reply'));

check('toolCalls: 3 entries',          result.toolCalls.length === 3);
check('toolCalls[0] is get_situation', result.toolCalls[0]?.name === 'get_situation');
check('toolCalls[1] is social_read',   result.toolCalls[1]?.name === 'social_read');
check('toolCalls[2] is write_intent_plan', result.toolCalls[2]?.name === 'write_intent_plan');

const getSitResult = result.toolCalls[0]?.resultContent ?? '';
check('get_situation returned chat snapshot', getSitResult.includes('Bob(2222)'));
check('get_situation returned recent_self placeholder', getSitResult.includes('（无最近动作）'));

const socialReadResult = result.toolCalls[1]?.resultContent ?? '';
const socialReadIsErr  = result.toolCalls[1]?.isError ?? false;
check('social_read missing → isError', socialReadIsErr === true);
check('social_read mentions filename', socialReadResult.includes('INTENT_111.md'));

// On-disk verification
const intentPath = join(home, 'pets', petId, 'workspace', 'social/group/INTENT_111.md');
const briefPath  = join(home, 'pets', petId, 'workspace', 'social/group/scratch_111/reply_brief.md');
check('INTENT_111.md persisted',   existsSync(intentPath));
check('reply_brief.md persisted',  existsSync(briefPath));
if (existsSync(intentPath)) {
  const intentContent = readFileSync(intentPath, 'utf8');
  check('INTENT content correct',  intentContent.includes('【我的判断】简短回应'));
}
if (existsSync(briefPath)) {
  const briefContent = readFileSync(briefPath, 'utf8');
  check('brief content correct',   briefContent.startsWith('[闲扯]'));
}

mock.stop(true);
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
