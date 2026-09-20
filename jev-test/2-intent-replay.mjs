/**
 * 把 PetGPT 的 Intent 决策改写成 Jev 的问题，用真实群聊场景对照。
 *
 *   node 2-intent-replay.mjs
 *
 * Intent loop 现在做的事，本质上是三个判断：要不要回、回多重、多相关。
 * 这正好是 Jev 的三种题型（noul / choice / score）各一个，而且一次调用就能
 * 全拿到 —— 它对同一份 state 并行独立地回答每个问题。
 *
 * 下面的场景全部摘自 2026-09-19 05:28–06:06 的真实运行日志，`expected` 是
 * 当时 gemini-3.8-flash 实际做出的决策（从 `write_intent_plan → actions=[...]`
 * 和 `brief=[档位]` 读出来的）。这不是"标准答案"，只是现状基线 —— 两者不一致
 * 时要人工看谁更合理，而不是默认 LLM 对。
 */

import { ask, printAnswers } from './jev.mjs';

/** Intent 的决策，用 Jev 的题型表达 */
const INTENT_QUESTIONS = {
  should_reply: {
    type: 'noul',
    instructions:
      '这个机器人现在应该开口回复吗。被 @ 或被直接提问时应该回；' +
      '群友之间互相聊天、刷梗接龙、或话题与机器人无关时不该插话。',
  },
  register: {
    type: 'choice',
    instructions: '如果要回复，用哪种力度',
    criteria: {
      接梗: '群里在玩梗或复读，跟一句就行',
      闲扯: '轻松的日常对话，随口接话',
      观点: '有人问了具体问题，给个明确判断',
      展开: '需要解释来龙去脉，几句话说清',
      深答: '技术问题需要考据、引用或分步骤拆解',
    },
  },
  addressed_to_bot: {
    type: 'noul',
    instructions: '最后一条消息是直接说给这个机器人听的（@了它，或明显在问它）',
  },
  topic_relevance: {
    type: 'score',
    instructions: '话题与机器人自身能力/身份的相关度',
    criteria: ['完全无关的群友闲聊', '沾边但没点名', '直接在讨论或测试这个机器人'],
  },
};

/** 真实场景。expected 是当时线上实际做出的决策。 */
const CASES = [
  {
    name: '被 @ 且直接提问（图片）',
    expected: { reply: true, register: '观点' },
    state: `群聊「ACM AI/Agent/LLM Developers」最近消息：
阿萨姆: 极限
阿萨姆: 最后一秒钟
我要吃鸭血粉丝汤😭: @机器人 [图片]这张图是什么？`,
  },
  {
    name: '群友复读接龙，没点名',
    expected: { reply: false },
    state: `群聊「ACM AI/Agent/LLM Developers」最近消息：
𝓕𝓸𝓻𝓶𝓾𝓵𝓪: 开 ultra fast
𝓧𝓮𝓻𝓸𝓷: 开 ultra fast
阿萨姆: 开 ultra fast
ㅤ: 开 ultra fast`,
  },
  {
    name: '被 @ 要求总结网页',
    expected: { reply: true, register: '展开' },
    state: `群聊「ACM AI/Agent/LLM Developers」最近消息：
七日之书: 反代
我要吃鸭血粉丝汤😭: 不是很容易被封号吗，antigravity
yesname: @机器人 https://www.anthropic.com/institute/econ-scenarios 看一下这个网页说了什么，总结一下`,
  },
  {
    name: '群友互相聊白嫖额度，与机器人无关',
    expected: { reply: false },
    state: `群聊「ACM AI/Agent/LLM Developers」最近消息：
七日之书: 我又嫖了一年
chanpin: 我被风控了
七日之书: 因为去年嫖的时候认证过了 今年直接点击就送
chanpin: 三个号
chanpin: 都是地区不符合`,
  },
  {
    name: '话题在讨论机器人自己，但没 @',
    expected: { reply: false },
    state: `群聊「ACM AI/Agent/LLM Developers」最近消息：
七日之书: glitch怎么复活了
我要吃鸭血粉丝汤😭: 前几天冲了25块钱
yesname: 建议大家做多gemini`,
  },
  {
    name: '追问式短句，延续上文测试',
    expected: { reply: true, register: '闲扯' },
    state: `群聊「ACM AI/Agent/LLM Developers」最近消息：
我要吃鸭血粉丝汤😭: @机器人 能看到图吗？
机器人: 看得到啦！是一只顶着谷歌彩色G标的企鹅meme
我要吃鸭血粉丝汤😭: 现在呢？`,
  },
];

const main = async () => {
  console.log(`对照 ${CASES.length} 个真实场景（基线 = 线上 gemini-3.8-flash 的实际决策）\n`);

  let agree = 0;
  let total = 0;
  let latencies = [];

  for (const c of CASES) {
    console.log('─'.repeat(70));
    console.log(`▸ ${c.name}`);
    console.log(`  线上基线: ${c.expected.reply ? `回复 [${c.expected.register}]` : '沉默'}`);

    let result;
    try {
      result = await ask(c.state, INTENT_QUESTIONS);
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      if (String(e.message).includes('401')) process.exit(1);
      continue;
    }

    latencies.push(result.latencyMs);
    console.log('  Jev:');
    printAnswers(result, { indent: '    ' });

    // noul 是概率，0.5 作为判定阈值只是起点 —— 真要上线应该扫一遍阈值看准确率曲线
    const jevReply = (result.answers?.should_reply?.noul ?? 0) >= 0.5;
    const match = jevReply === c.expected.reply;
    total += 1;
    if (match) agree += 1;
    console.log(`  → 判定 ${jevReply ? '回复' : '沉默'}：${match ? '✅ 与基线一致' : '❌ 与基线不一致'}`);
  }

  console.log('─'.repeat(70));
  console.log(`\n要不要回复：${agree}/${total} 与线上一致`);
  if (latencies.length) {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    console.log(`延迟：平均 ${avg}ms（线上 Intent 单轮 6000–36000ms）`);
  }
  console.log(`
注意：
  · 不一致的用例要人工看谁更合理，基线不等于正确答案。
  · 这里的 state 只有几行消息；线上 Intent 实际喂 90k–247k tokens
    （群规则 + 人物档案 + 历史摘要）。Jev 上下文只有 32K，装不下 ——
    真要替换，得先确认砍掉那些材料之后判断质量还剩多少。
`);
};

main();
