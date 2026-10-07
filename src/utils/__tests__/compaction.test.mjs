import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens, estimateItemsTokens, prepareRequestItems, budgetSnapshot,
  COMPACT_THRESHOLD_TOKENS, TOOL_OUTPUT_BUDGET_RATIO,
} from '../social/compaction.js';
import { createSession, beginTurn, endTurn, appendHistory, latestSummary } from '../social/sessionState.js';

const mk = () => createSession({ targetId: '902317662', targetType: 'group', now: 1000 });

const fill = (session, items) => {
  const t = beginTurn(session);
  for (const it of items) appendHistory(session, it);
  endTurn(session, t);
};
const toolResult = (chars, toolName = 'tavily_search') => ({
  kind: 'tool_result', role: 'tool', toolName, content: 'x'.repeat(chars),
});

test('阈值 64k —— 倒推自"估算比真实低约 33k"这个实测偏差', () => {
  assert.equal(COMPACT_THRESHOLD_TOKENS, 64_000);
  // 线上：阈值 96k 时真实触发点落在 128–129k。少算的是工具 schema（~4.5k）、
  // 图片（记 0）、气压计块。64 + 33 ≈ 97k 真实，压在 100k 延迟拐点之前。
  assert.ok(COMPACT_THRESHOLD_TOKENS > 36_000, '仍要明显大于静态前缀，否则一开机就压');
});

test('中文按 1 字 1 token，拉丁按 4 字符 1 token', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('你好abcd'), 2 + 1);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
});

test('没超阈值就原样返回，不调 summarize', async () => {
  const s = mk();
  fill(s, [{ role: 'user', content: '在吗' }]);
  let called = false;
  const r = await prepareRequestItems(s, { summarize: async () => { called = true; return 'x'; } });
  assert.equal(called, false);
  assert.equal(r.trimmed, null);
  assert.equal(r.compacted, null);
  assert.equal(r.items.length, 1);
});

test('先裁工具输出；裁够了就不压缩', async () => {
  const s = mk();
  const threshold = 1000;
  // 三条大工具输出（每条 4000 拉丁字符 = 1000 token），外加豁免用的小输出
  fill(s, [
    { role: 'user', content: '查一下' },
    toolResult(4000), toolResult(4000), toolResult(4000),
    toolResult(20), toolResult(20),
  ]);
  let summarizeCalls = 0;
  const r = await prepareRequestItems(s, {
    thresholdTokens: threshold,
    summarize: async () => { summarizeCalls += 1; return '摘要'; },
  });
  assert.ok(r.trimmed && r.trimmed.trimmedCount > 0, '应该裁到东西');
  assert.equal(summarizeCalls, 0, '裁剪够用就不该花钱压缩');
  assert.equal(r.compacted, null);
});

test('裁不够才压缩，并封窗换 id', async () => {
  const s = mk();
  // 全是对话消息 —— 裁剪动不了，只能压缩
  fill(s, [
    { role: 'user', content: '啊'.repeat(2000) },
    { role: 'assistant', content: '哦'.repeat(2000) },
  ]);
  const windowsBefore = s.windowIds.length;
  const r = await prepareRequestItems(s, {
    thresholdTokens: 500,
    summarize: async ({ priorSummary, items }) => {
      assert.equal(priorSummary, null, '第一次压缩没有前序摘要');
      assert.ok(items.length >= 2);
      return '摘要：两句废话';
    },
  });
  assert.ok(r.compacted, '应该压缩了');
  assert.equal(s.windowIds.length, windowsBefore + 1, '换了新窗口');
  assert.equal(latestSummary(s), '摘要：两句废话');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'summary');
  assert.ok(r.tokens < 500, '压缩后应降到阈值以下');
});

test('滚动摘要：第二次压缩拿得到上一份', async () => {
  const s = mk();
  fill(s, [{ role: 'user', content: '啊'.repeat(2000) }]);
  await prepareRequestItems(s, { thresholdTokens: 300, summarize: async () => '摘要1' });

  fill(s, [{ role: 'user', content: '哦'.repeat(2000) }]);
  let seenPrior = 'unset';
  await prepareRequestItems(s, {
    thresholdTokens: 300,
    summarize: async ({ priorSummary }) => { seenPrior = priorSummary; return '摘要2'; },
  });
  assert.equal(seenPrior, '摘要1', '第二次压缩必须看到第一份，否则会丢历史');
  assert.equal(latestSummary(s), '摘要2');
});

test('没有 summarizer 时不崩，原样返回并报事件', async () => {
  const s = mk();
  fill(s, [{ role: 'user', content: '啊'.repeat(2000) }]);
  const events = [];
  const r = await prepareRequestItems(s, {
    thresholdTokens: 100,
    summarize: null,
    onEvent: (t, d) => events.push([t, d]),
  });
  assert.equal(r.compacted, null);
  assert.ok(events.some(([t]) => t === 'compact-skipped'));
});

test('总结器返回空串时保持原状，不封窗', async () => {
  const s = mk();
  fill(s, [{ role: 'user', content: '啊'.repeat(2000) }]);
  const before = s.windowIds.length;
  const events = [];
  const r = await prepareRequestItems(s, {
    thresholdTokens: 100,
    summarize: async () => '   ',
    onEvent: (t) => events.push(t),
  });
  assert.equal(r.compacted, null);
  assert.equal(s.windowIds.length, before, '空摘要不能把历史换掉');
  assert.ok(events.includes('compact-failed'));
});

test('静态前缀计入预算', async () => {
  const s = mk();
  fill(s, [{ role: 'user', content: '短' }]);
  let called = false;
  await prepareRequestItems(s, {
    thresholdTokens: 1000,
    staticPrefixTokens: 5000,   // 光前缀就超了
    summarize: async () => { called = true; return '摘要'; },
  });
  assert.equal(called, true, '前缀撑爆预算时也要压缩');
});

test('onEvent 抛异常不影响主流程', async () => {
  const s = mk();
  fill(s, [{ role: 'user', content: '啊'.repeat(2000) }]);
  const r = await prepareRequestItems(s, {
    thresholdTokens: 100,
    summarize: async () => '摘要',
    onEvent: () => { throw new Error('日志炸了'); },
  });
  assert.ok(r.compacted);
});

test('budgetSnapshot 给出可读画像', () => {
  const s = mk();
  fill(s, [{ role: 'user', content: '你好' }, toolResult(400)]);
  const snap = budgetSnapshot(s, { thresholdTokens: 1000 });
  assert.equal(snap.items, 2);
  assert.equal(snap.toolChars, 400);
  assert.equal(snap.chars, 402);
  assert.equal(snap.overBy, 0);
  assert.ok(snap.pct >= 0 && snap.pct <= 100);
});

test('工具输出预算比例是 35%', () => {
  assert.equal(TOOL_OUTPUT_BUDGET_RATIO, 0.35);
});

test('estimateItemsTokens 处理多模态与空内容', () => {
  assert.equal(estimateItemsTokens([{ content: [{ type: 'text', text: '你好' }, { type: 'image' }] }]), 2);
  assert.equal(estimateItemsTokens([{ content: null }]), 0);
  assert.equal(estimateItemsTokens(null), 0);
});
