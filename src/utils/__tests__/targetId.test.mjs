import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTargetId, normalizeTargetIds } from '../social/targetId.js';

// 和 telegram-mcp 的 test_pasted_telegram_links_become_canonical_targets 同一张表——两边必须一致
const CASES = [
  // 线上就是这么填的，结果一直 Waiting for the first turn
  ['https://t.me/c/3809923344/13288', '-1003809923344:13288'],
  ['t.me/c/3809923344/13288/99999', '-1003809923344:13288'],
  ['https://t.me/c/3809923344', '-1003809923344'],
  ['https://t.me/c/3809923344/13288?single', '-1003809923344:13288'],
  ['https://t.me/GlitchTestGroup', '@GlitchTestGroup'],
  ['t.me/GlitchTestGroup/45', '@GlitchTestGroup:45'],
  ['-1003809923344:13288', '-1003809923344:13288'],
  ['@GlitchTestGroup', '@GlitchTestGroup'],
  ['https://t.me/+AbCdEf123', 'https://t.me/+AbCdEf123'],
  ['https://t.me/joinchat/AbCdEf', 'https://t.me/joinchat/AbCdEf'],
  // QQ 群号不受影响
  ['902317662', '902317662'],
];

for (const [raw, expected] of CASES) {
  test(`${raw} → ${expected}`, () => {
    assert.equal(normalizeTargetId(raw), expected);
  });
}

test('规范化之后不再含 /，以 target 命名的文件才写得进去', () => {
  assert.ok(!normalizeTargetId('https://t.me/c/3809923344/13288').includes('/'));
});

test('一组 ID：去空、去重、保持顺序——同一个话题贴了链接又贴了 ID 只留一份', () => {
  assert.deepEqual(
    normalizeTargetIds([' @GlitchTestGroup ', '', 'https://t.me/c/3809923344/13288', '-1003809923344:13288']),
    ['@GlitchTestGroup', '-1003809923344:13288'],
  );
  assert.deepEqual(normalizeTargetIds(undefined), []);
});
