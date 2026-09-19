import test from 'node:test';
import assert from 'node:assert/strict';

import { ROW_HEIGHT, flattenTree, visibleRange } from '../fileTreeRows.js';

const dir = (name, path) => ({ name, path, isDir: true, size: 0, noisy: false });
const file = (name, path) => ({ name, path, isDir: false, size: 1, noisy: false });

const listings = {
  '': { entries: [dir('src', 'src'), dir('docs', 'docs'), file('README.md', 'README.md')], truncated: false },
  src: { entries: [file('main.js', 'src/main.js'), dir('utils', 'src/utils')], truncated: false },
  'src/utils': { entries: [file('helper.js', 'src/utils/helper.js')], truncated: false },
  docs: { entries: [file('guide.md', 'docs/guide.md')], truncated: false },
};

test('只展开根目录时不会带出子项', () => {
  const rows = flattenTree({ listings, expanded: { '': true } });
  assert.deepEqual(rows.map((r) => r.key), ['src', 'docs', 'README.md']);
  assert.ok(rows.every((r) => r.depth === 0));
});

test('展开的目录按深度依次插在父项后面', () => {
  const rows = flattenTree({ listings, expanded: { '': true, src: true } });
  assert.deepEqual(rows.map((r) => r.key), ['src', 'src/main.js', 'src/utils', 'docs', 'README.md']);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 1, 0, 0]);
});

test('多层嵌套的深度正确累加', () => {
  const rows = flattenTree({ listings, expanded: { '': true, src: true, 'src/utils': true } });
  const helper = rows.find((r) => r.key === 'src/utils/helper.js');
  assert.equal(helper.depth, 2);
});

test('正在加载的目录占一行，而不是凭空消失', () => {
  const rows = flattenTree({
    listings: { '': listings[''] },
    expanded: { '': true, src: true },
    loading: { src: true },
  });
  const placeholder = rows.find((r) => r.kind === 'loading');
  assert.ok(placeholder, '应有 loading 占位行');
  assert.equal(placeholder.depth, 1, '占位行应缩进到子层');
});

test('展开了但既没内容也没在加载时不插空行', () => {
  const rows = flattenTree({ listings: { '': listings[''] }, expanded: { '': true, src: true } });
  assert.equal(rows.filter((r) => r.kind === 'loading').length, 0);
});

test('截断标记跟在该目录的条目之后', () => {
  const rows = flattenTree({
    listings: { '': { entries: [file('a', 'a')], truncated: true } },
    expanded: { '': true },
  });
  assert.deepEqual(rows.map((r) => r.kind), ['entry', 'truncated']);
});

test('过滤保留目录：否则无从展开到匹配的子项', () => {
  const rows = flattenTree({ listings, expanded: { '': true, src: true }, filter: 'main' });
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes('src/main.js'), '匹配的文件要在');
  assert.ok(keys.includes('src'), '目录要留着，否则展不开');
  assert.ok(!keys.includes('README.md'), '不匹配的文件要滤掉');
});

test('过滤大小写不敏感', () => {
  const rows = flattenTree({ listings, expanded: { '': true }, filter: 'README' });
  assert.ok(rows.some((r) => r.key === 'README.md'));
  const lower = flattenTree({ listings, expanded: { '': true }, filter: 'readme' });
  assert.ok(lower.some((r) => r.key === 'README.md'));
});

test('空输入不炸', () => {
  assert.deepEqual(flattenTree(), []);
  assert.deepEqual(flattenTree({}), []);
  assert.deepEqual(flattenTree({ listings: {}, expanded: { '': true } }), []);
});

test('行 key 唯一，React 才不会错位复用', () => {
  const rows = flattenTree({ listings, expanded: { '': true, src: true, 'src/utils': true, docs: true } });
  const keys = rows.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('可见区间随滚动前移，并在两端留出 overscan', () => {
  const r = visibleRange({ scrollTop: 100 * ROW_HEIGHT, viewportHeight: 10 * ROW_HEIGHT, rowCount: 1000, overscan: 5 });
  assert.equal(r.start, 95);
  assert.equal(r.end, 115);
});

test('可见区间不会越出两端', () => {
  const top = visibleRange({ scrollTop: 0, viewportHeight: 10 * ROW_HEIGHT, rowCount: 1000, overscan: 5 });
  assert.equal(top.start, 0, '顶部不能是负数');

  const bottom = visibleRange({ scrollTop: 995 * ROW_HEIGHT, viewportHeight: 10 * ROW_HEIGHT, rowCount: 1000, overscan: 5 });
  assert.equal(bottom.end, 1000, '底部不能超过总行数');
});

test('一个 2000 条目的目录只渲染几十行', () => {
  const big = { '': { entries: Array.from({ length: 2000 }, (_, i) => file('f' + i, 'f' + i)), truncated: true } };
  const rows = flattenTree({ listings: big, expanded: { '': true } });
  assert.equal(rows.length, 2001, '2000 条 + 截断提示');

  const r = visibleRange({ scrollTop: 0, viewportHeight: 600, rowCount: rows.length });
  const rendered = r.end - r.start;
  // 断言写成相对值：overscan 是可调的（为了滚动手感给得比较宽），
  // 这里要守住的是「虚拟化生效」而不是某个具体行数
  assert.ok(
    rendered < rows.length / 10,
    `应远少于总行数 ${rows.length}，实际 ${rendered}`,
  );
});

test('overscan 给得宽，但仍与视口成正比而非与总行数成正比', () => {
  const small = visibleRange({ scrollTop: 0, viewportHeight: 600, rowCount: 100 });
  const huge = visibleRange({ scrollTop: 0, viewportHeight: 600, rowCount: 100000 });
  // 同样的视口，总行数翻一千倍，渲染量不该跟着涨
  assert.equal(huge.end - huge.start, small.end - small.start);
});

test('高度未知时先给一屏，避免首帧空白', () => {
  const r = visibleRange({ scrollTop: 0, viewportHeight: 0, rowCount: 500, overscan: 8 });
  assert.ok(r.end > 0, '还没测到高度也要渲染一些');
  assert.ok(r.end <= 500);
});

// ==================== 已删除文件的幽灵行 ====================
// 删掉的文件不在磁盘上，list_dir 不会返回它们。不补进来的话，
// 「删了什么」在树上完全没有痕迹。

const deleted = (pairs) => new Map(pairs);

test('已删除的文件补在所属目录的真实条目之后', () => {
  const rows = flattenTree({
    listings,
    expanded: { '': true, src: true },
    deletedByDir: deleted([['src', [{ name: 'gone.js', path: 'src/gone.js' }]]]),
  });

  assert.deepEqual(rows.map((r) => r.key), [
    'src',
    'src/main.js',
    'src/utils',
    'deleted:src/gone.js',
    'docs',
    'README.md',
  ]);
});

test('幽灵行的 kind 和缩进与同级真实条目一致', () => {
  const rows = flattenTree({
    listings,
    expanded: { '': true, src: true },
    deletedByDir: deleted([['src', [{ name: 'gone.js', path: 'src/gone.js' }]]]),
  });
  const ghost = rows.find((r) => r.key === 'deleted:src/gone.js');
  const sibling = rows.find((r) => r.key === 'src/main.js');

  assert.equal(ghost.kind, 'deleted');
  assert.equal(ghost.depth, sibling.depth, '和同目录的真实文件同一层');
  assert.deepEqual(ghost.entry, { name: 'gone.js', path: 'src/gone.js' });
});

test('目录没展开时它里面的幽灵行不出现', () => {
  const rows = flattenTree({
    listings,
    expanded: { '': true },
    deletedByDir: deleted([['src', [{ name: 'gone.js', path: 'src/gone.js' }]]]),
  });
  assert.ok(!rows.some((r) => r.kind === 'deleted'));
});

test('根目录下的删除挂在空串 key 上', () => {
  const rows = flattenTree({
    listings,
    expanded: { '': true },
    deletedByDir: deleted([['', [{ name: 'LICENSE', path: 'LICENSE' }]]]),
  });
  assert.equal(rows.at(-1).key, 'deleted:LICENSE');
  assert.equal(rows.at(-1).depth, 0);
});

test('过滤词同样作用在幽灵行上', () => {
  const deletedByDir = deleted([[
    'src',
    [
      { name: 'gone.js', path: 'src/gone.js' },
      { name: 'other.txt', path: 'src/other.txt' },
    ],
  ]]);
  const rows = flattenTree({ listings, expanded: { '': true, src: true }, filter: 'gone', deletedByDir });
  const ghosts = rows.filter((r) => r.kind === 'deleted');
  assert.deepEqual(ghosts.map((r) => r.entry.name), ['gone.js']);
});

test('幽灵行排在截断提示之前', () => {
  const rows = flattenTree({
    listings: { '': { entries: [], truncated: true } },
    expanded: { '': true },
    deletedByDir: deleted([['', [{ name: 'gone.js', path: 'gone.js' }]]]),
  });
  assert.deepEqual(rows.map((r) => r.kind), ['deleted', 'truncated']);
});

test('不传 deletedByDir 时行为与从前完全一致', () => {
  const before = flattenTree({ listings, expanded: { '': true, src: true } });
  const after = flattenTree({ listings, expanded: { '': true, src: true }, deletedByDir: null });
  assert.deepEqual(before, after);
  assert.deepEqual(
    flattenTree({ listings, expanded: { '': true, src: true }, deletedByDir: new Map() }),
    before,
  );
});
