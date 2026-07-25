import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntentOptionalToolLedger,
  describeIntentOptionalToolUse,
  formatIntentOptionalToolLedgerResume,
  isOptionalIntentTool,
  recordIntentOptionalToolUse,
} from '../intentToolLedger.js';

test('fixed Intent tools are excluded by exact full name', () => {
  const ledger = createIntentOptionalToolLedger();

  assert.equal(isOptionalIntentTool('get_situation'), false);
  assert.equal(isOptionalIntentTool('write_intent_plan'), false);
  assert.equal(recordIntentOptionalToolUse(ledger, { name: 'get_situation' }), '');
  assert.equal(recordIntentOptionalToolUse(ledger, { name: 'write_intent_plan' }), '');
  assert.equal(ledger.total, 0);

  // An external tool with a server prefix is not the fixed builtin.
  assert.equal(isOptionalIntentTool('external__get_situation'), true);
  const annotation = recordIntentOptionalToolUse(ledger, { name: 'external__get_situation' });
  assert.match(annotation, /external__get_situation/);
  assert.equal(ledger.total, 1);
});

test('optional Tavily and fetch tools produce concise model-facing descriptions', () => {
  const ledger = createIntentOptionalToolLedger();

  const tavily = recordIntentOptionalToolUse(ledger, {
    name: 'tavily__tavily_search',
    args: { query: 'Qwen 3.5 release benchmarks 2026' },
  });
  assert.match(tavily, /已使用 tavily__tavily_search/);
  assert.match(tavily, /联网搜索「Qwen 3\.5 release benchmarks 2026」/);
  assert.match(tavily, /可选工具 1 次/);

  const fetch = recordIntentOptionalToolUse(ledger, {
    name: 'fetch__fetch',
    args: { url: 'https://example.com/report?id=secret#section' },
  });
  assert.match(fetch, /抓取网页 https:\/\/example\.com\/report/);
  assert.doesNotMatch(fetch, /id=secret/);
  assert.match(fetch, /可选工具 2 次/);
  assert.equal(ledger.succeeded, 2);
  assert.equal(ledger.failed, 0);
});

test('optional calls keep order, count repeats, and distinguish failures', () => {
  const ledger = createIntentOptionalToolLedger();

  recordIntentOptionalToolUse(ledger, {
    name: 'chat_search',
    args: { keywords: '旧话题' },
  });
  const failed = recordIntentOptionalToolUse(ledger, {
    name: 'chat_search',
    args: { keywords: '新话题' },
    isError: true,
  });
  recordIntentOptionalToolUse(ledger, {
    name: 'dispatch_subagent',
    args: { task: '核对三个原始来源' },
  });

  assert.equal(ledger.total, 3);
  assert.equal(ledger.succeeded, 2);
  assert.equal(ledger.failed, 1);
  assert.equal(ledger.byTool.chat_search, 2);
  assert.deepEqual(ledger.entries.map(entry => entry.name), [
    'chat_search',
    'chat_search',
    'dispatch_subagent',
  ]);
  assert.match(failed, /尝试使用 chat_search/);
  assert.match(failed, /失败 1 次/);
  assert.equal(ledger.entries[2].status, '已派发');
});

test('a mixed tool-call batch annotates only optional calls and shares one cumulative count', () => {
  const ledger = createIntentOptionalToolLedger();
  const calls = [
    { name: 'get_situation' },
    { name: 'tavily__search', args: { query: 'Toronto weather' } },
    { name: 'fetch__fetch', args: { url: 'https://example.com/weather?key=private' } },
    { name: 'write_intent_plan' },
  ];

  const annotations = calls.map(call => recordIntentOptionalToolUse(ledger, call));

  assert.equal(annotations[0], '');
  assert.match(annotations[1], /可选工具 1 次/);
  assert.match(annotations[2], /可选工具 2 次/);
  assert.equal(annotations[3], '');
  assert.equal(ledger.total, 2);
  assert.deepEqual(ledger.entries.map(entry => entry.name), [
    'tavily__search',
    'fetch__fetch',
  ]);
});

test('retry resume contains only optional history and keeps fixed tools mandatory', () => {
  const ledger = createIntentOptionalToolLedger();
  recordIntentOptionalToolUse(ledger, { name: 'get_situation' });
  recordIntentOptionalToolUse(ledger, {
    name: 'social_read',
    args: { path: 'social/notes/topic.md' },
  });
  recordIntentOptionalToolUse(ledger, { name: 'write_intent_plan' });

  const resume = formatIntentOptionalToolLedgerResume(ledger);
  assert.match(resume, /此前共使用可选工具 1 次/);
  assert.match(resume, /social_read×1/);
  assert.match(resume, /读取社交文件 social\/notes\/topic\.md/);
  assert.match(resume, /固定流程工具 get_situation 与 write_intent_plan 不计入/);
  assert.equal(ledger.total, 1);
});

test('retry resume allows lost reads to run again but suppresses completed side effects', () => {
  const ledger = createIntentOptionalToolLedger();
  recordIntentOptionalToolUse(ledger, {
    name: 'fetch__fetch',
    args: { url: 'https://example.com/source' },
  });
  recordIntentOptionalToolUse(ledger, {
    name: 'voice_send',
    args: { text: 'do not copy this text' },
  });
  recordIntentOptionalToolUse(ledger, {
    name: 'external__custom_action',
    args: { secret: 'do not copy this secret' },
  });
  recordIntentOptionalToolUse(ledger, {
    name: 'chat_search',
    args: { keywords: 'failed lookup' },
    isError: true,
  });

  const resume = formatIntentOptionalToolLedgerResume(ledger);
  assert.match(resume, /读取\/搜索结果没有保留.*可以重新调用/);
  assert.match(resume, /fetch__fetch：抓取网页 https:\/\/example\.com\/source/);
  assert.match(resume, /可能产生副作用，不要因重试重复：voice_send：发送语音/);
  assert.match(resume, /外部工具的副作用未知.*external__custom_action/);
  assert.match(resume, /此前失败，可按需要修正参数后重试：chat_search/);
  assert.doesNotMatch(resume, /do not copy/);
});

test('descriptions do not copy write bodies or URL query parameters', () => {
  assert.equal(
    describeIntentOptionalToolUse('social_write', {
      path: 'social/notes/a.md',
      content: 'private body',
    }),
    '写入社交文件 social/notes/a.md',
  );
  assert.equal(
    describeIntentOptionalToolUse('fetch', {
      url: 'https://example.com/a?token=private',
    }),
    '抓取网页 https://example.com/a',
  );
  assert.equal(
    describeIntentOptionalToolUse('fetch', {
      url: 'not-a-standard-url/path?token=private#fragment',
    }),
    '抓取网页 not-a-standard-url/path',
  );
  assert.equal(
    describeIntentOptionalToolUse('external__social_write', {
      path: 'social/notes/a.md',
      content: 'private body',
    }),
    '执行外部可选工具',
  );
});
