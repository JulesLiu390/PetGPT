import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSplitTags, stripSplitTagsForSpeech, SPLIT_TAG } from '../social/outgoingText.js';

test('线上原样发出去的那条：‹/分段› 归一成 MCP 认的 </分段>', () => {
  assert.equal(
    normalizeSplitTags('喂，gemini 怎么了，明明聪明得很好不好。‹/分段›别拆我台啊姐姐'),
    `喂，gemini 怎么了，明明聪明得很好不好。${SPLIT_TAG}别拆我台啊姐姐`,
  );
});

for (const variant of ['‹/分段›', '＜/分段＞', '〈/分段〉', '《/分段》', '«/分段»', '</ 分段 >', '<分段>', '</分段>', '<／分段>', '‹分段›']) {
  test(`变体 ${variant}`, () => {
    assert.equal(normalizeSplitTags(`a${variant}b`), `a${SPLIT_TAG}b`);
  });
}

test('不是分段标记的东西不动', () => {
  for (const s of ['<b>粗体</b>', '分段落来讲', '‹abc123›', '我说分段吧', 'a < 分 b']) {
    assert.equal(normalizeSplitTags(s), s);
  }
});

test('语音：分段换成停顿，不会被念成「分段」', () => {
  assert.equal(stripSplitTagsForSpeech('真的假的‹/分段›离谱了'), '真的假的，离谱了');
  // 前面已经有句号就不再叠一个逗号
  assert.equal(stripSplitTagsForSpeech('好的。</分段>马上'), '好的。马上');
  // 开头结尾的标记直接去掉
  assert.equal(stripSplitTagsForSpeech('</分段>你好</分段>'), '你好');
  assert.equal(stripSplitTagsForSpeech('没有标记'), '没有标记');
});
