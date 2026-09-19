import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeletedIndex,
  buildGitDecorations,
  decorateEntry,
  gitStatusSignature,
  summarizeGitCounts,
  toneForLetter,
} from '../gitDecorations.js';

const deco = (files) => buildGitDecorations(files);

test('一个改动文件自己带字母，祖先目录只着色', () => {
  const d = deco([{ path: 'src/utils/tauri.js', status: 'M', staged: false }]);

  assert.deepEqual(decorateEntry('src/utils/tauri.js', false, d), {
    letter: 'M',
    tone: 'modified',
  });
  assert.deepEqual(decorateEntry('src/utils', true, d), { letter: null, tone: 'dirty' });
  assert.deepEqual(decorateEntry('src', true, d), { letter: null, tone: 'dirty' });
});

test('没有改动的路径不返回装饰', () => {
  const d = deco([{ path: 'src/a.js', status: 'M' }]);
  assert.equal(decorateEntry('src/b.js', false, d), null);
  assert.equal(decorateEntry('docs', true, d), null);
});

test('未跟踪目录里的文件继承未跟踪状态', () => {
  // git -unormal 只报目录这一条，里面的文件一条都没有
  const d = deco([{ path: 'src-tauri/src/pty/', status: '?' }]);

  assert.deepEqual(decorateEntry('src-tauri/src/pty/mod.rs', false, d), {
    letter: '?',
    tone: 'untracked',
  });
  // 目录自己着色但不打字母 —— 里面每个文件都会各自显示
  assert.deepEqual(decorateEntry('src-tauri/src/pty', true, d), {
    letter: null,
    tone: 'untracked',
  });
});

test('前缀匹配要比到分隔符，不能把同前缀的兄弟目录算进去', () => {
  const d = deco([{ path: 'src/a/', status: '?' }]);
  // `src/app` 只是名字以 `src/a` 开头，不是 `src/a` 的子项
  assert.equal(decorateEntry('src/app/index.js', false, d), null);
  assert.equal(decorateEntry('src/app', true, d), null);
  assert.deepEqual(decorateEntry('src/a/x.js', false, d), { letter: '?', tone: 'untracked' });
});

test('未跟踪目录自己也算脏，折叠时才看得出来', () => {
  const d = deco([{ path: 'src/pty/', status: '?' }]);
  assert.ok(d.dirtyDirs.has('src'));
  assert.ok(d.dirtyDirs.has('src/pty'));
});

test('根目录下的文件不会把空字符串写进祖先集合', () => {
  const d = deco([{ path: 'README.md', status: 'M' }]);
  assert.equal(d.dirtyDirs.size, 0);
  assert.deepEqual(decorateEntry('README.md', false, d), { letter: 'M', tone: 'modified' });
});

test('每个状态字母都映射到自己的色调', () => {
  assert.equal(toneForLetter('M'), 'modified');
  assert.equal(toneForLetter('A'), 'added');
  assert.equal(toneForLetter('D'), 'deleted');
  assert.equal(toneForLetter('R'), 'renamed');
  assert.equal(toneForLetter('?'), 'untracked');
  assert.equal(toneForLetter('U'), 'conflict');
  // 认不出的字母退回 modified，而不是让这一行没有颜色
  assert.equal(toneForLetter('X'), 'modified');
});

test('重命名后的新路径带 R，旧路径不在树里也不影响', () => {
  const d = deco([{ path: 'src/context/initialState.js', status: 'R', staged: true }]);
  assert.deepEqual(decorateEntry('src/context/initialState.js', false, d), {
    letter: 'R',
    tone: 'renamed',
  });
});

test('空输入和脏输入都不炸', () => {
  assert.equal(decorateEntry('a.js', false, deco([])), null);
  assert.equal(decorateEntry('a.js', false, deco(null)), null);
  assert.equal(decorateEntry('a.js', false, undefined), null);
  assert.equal(decorateEntry('', false, deco([{ path: 'a.js', status: 'M' }])), null);
  // 只有一个斜杠的路径规约后是空串，应该被丢掉而不是变成根目录
  assert.equal(deco([{ path: '/', status: '?' }]).byPath.size, 0);
});

test('摘要按出现的类别拼，全干净时是空串', () => {
  assert.equal(
    summarizeGitCounts({ isRepo: true, staged: 3, unstaged: 12, untracked: 5, conflicted: 0 }),
    '3 staged, 12 modified, 5 untracked',
  );
  assert.equal(summarizeGitCounts({ isRepo: true, staged: 0, unstaged: 0, untracked: 0 }), '');
  assert.equal(summarizeGitCounts({ isRepo: false }), '');
  assert.equal(summarizeGitCounts(null), '');
});

test('摘要走 t() 翻译，不硬编码英文', () => {
  const t = (s) => ({ staged: '已暂存', modified: '已修改', untracked: '未跟踪' }[s] || s);
  assert.equal(
    summarizeGitCounts({ isRepo: true, staged: 1, unstaged: 2, untracked: 0 }, t),
    '1 已暂存, 2 已修改',
  );
});

test('内容相同的两次轮询给出同一个签名', () => {
  const a = {
    isRepo: true, branch: 'main', ahead: 0, behind: 0,
    files: [{ path: 'a.js', status: 'M', staged: false }],
  };
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(gitStatusSignature(a), gitStatusSignature(b));
});

test('任何一项变化都会改变签名', () => {
  const base = {
    isRepo: true, branch: 'main', ahead: 0, behind: 0,
    files: [{ path: 'a.js', status: 'M', staged: false }],
  };
  const sig = gitStatusSignature(base);

  assert.notEqual(sig, gitStatusSignature({ ...base, branch: 'dev' }), '换分支');
  assert.notEqual(sig, gitStatusSignature({ ...base, ahead: 1 }), 'ahead 变化');
  assert.notEqual(sig, gitStatusSignature({ ...base, behind: 1 }), 'behind 变化');
  assert.notEqual(
    sig,
    gitStatusSignature({ ...base, files: [{ path: 'a.js', status: 'D', staged: false }] }),
    '状态字母变化',
  );
  assert.notEqual(
    sig,
    gitStatusSignature({ ...base, files: [{ path: 'a.js', status: 'M', staged: true }] }),
    '暂存与否变化 —— git add 之后界面要跟着变',
  );
  assert.notEqual(
    sig,
    gitStatusSignature({ ...base, files: [{ path: 'b.js', status: 'M', staged: false }] }),
    '换了文件',
  );
});

test('非仓库的签名是稳定的常量，不会每轮都触发重渲染', () => {
  assert.equal(gitStatusSignature({ isRepo: false }), gitStatusSignature({ isRepo: false }));
  assert.equal(gitStatusSignature(null), gitStatusSignature({ isRepo: false }));
});

test('已删除的文件按所在目录分组，根目录用空串当 key', () => {
  const idx = buildDeletedIndex([
    { path: 'src/old.js', status: 'D' },
    { path: 'README.md', status: 'D' },
    { path: 'src/a.js', status: 'M' },
    { path: 'src/another.js', status: 'D' },
  ]);

  assert.deepEqual(idx.get(''), [{ name: 'README.md', path: 'README.md' }]);
  // 同一目录内按名字排序
  assert.deepEqual(idx.get('src'), [
    { name: 'another.js', path: 'src/another.js' },
    { name: 'old.js', path: 'src/old.js' },
  ]);
  // 只有 D 进索引
  assert.equal(idx.size, 2);
});

test('没有删除时索引是空的', () => {
  assert.equal(buildDeletedIndex([{ path: 'a.js', status: 'M' }]).size, 0);
  assert.equal(buildDeletedIndex([]).size, 0);
  assert.equal(buildDeletedIndex(null).size, 0);
});
