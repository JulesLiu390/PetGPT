/**
 * 冒烟测试：key 通不通，三种题型分别长什么样。
 *
 *   node 1-smoke.mjs
 */

import { ask, printAnswers } from './jev.mjs';

const STATE = `用户消息：你好，我三天前就在试着连 Stripe 账号了，文档照着做了三遍还是报错，
明天就要上线了，这边能不能给个准话？`;

const QUESTIONS = {
  // choice：多选一。criteria 是 { 选项: 该选项什么时候适用 }
  department: {
    type: 'choice',
    instructions: '这条消息该由哪个团队处理',
    criteria: {
      billing: '付款或订阅相关',
      technical: 'Bug 或集成问题',
      sales: '定价或账户咨询',
    },
  },
  // score：打分。criteria 是从低到高的刻度说明
  frustration: {
    type: 'score',
    instructions: '用户的不满程度',
    criteria: ['平静，只是陈述事实', '有情绪但还客气', '非常愤怒'],
  },
  // noul：0–1 的概率，不需要 criteria
  is_urgent: {
    type: 'noul',
    instructions: '这条消息表达了紧迫性或时间压力',
  },
};

const main = async () => {
  console.log('state:');
  console.log(STATE.split('\n').map((l) => '  ' + l.trim()).join('\n'));
  console.log('\n一次调用，三个问题并行评估：\n');

  try {
    const result = await ask(STATE, QUESTIONS);
    printAnswers(result);
    console.log('\n原始响应：');
    console.log(JSON.stringify({ answers: result.answers, usage: result.usage }, null, 2));
  } catch (e) {
    console.error('\n✗', e.message);
    if (String(e.message).includes('401')) {
      console.error('  → key 无效或过期，检查 .env 里的 TYPESAFE_API_KEY');
    }
    process.exitCode = 1;
  }
};

main();
