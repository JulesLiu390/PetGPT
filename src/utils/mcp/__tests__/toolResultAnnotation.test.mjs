import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendToolResultAnnotation } from '../toolResultAnnotation.js';

test('appends runtime annotation after the original tool result', () => {
  const result = appendToolResultAnnotation(
    '{"success":true}',
    '<runtime_optional_tool_ledger>\n本次 Intent 共使用可选工具 1 次。\n</runtime_optional_tool_ledger>',
  );

  assert.equal(
    result,
    '{"success":true}\n\n<runtime_optional_tool_ledger>\n本次 Intent 共使用可选工具 1 次。\n</runtime_optional_tool_ledger>',
  );
});

test('does not alter tool results when no annotation is produced', () => {
  assert.equal(appendToolResultAnnotation('raw result', ''), 'raw result');
  assert.equal(appendToolResultAnnotation('raw result', null), 'raw result');
});
