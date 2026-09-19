import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  translateUiText,
} from '../translator.js';

test('English is the default and unsupported locale values fall back to it', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(normalizeLanguage('fr'), 'en');
  assert.equal(normalizeLanguage('zh-CN'), 'zh-CN');
});

test('static UI copy translates in both directions without changing whitespace', () => {
  assert.equal(translateUiText('  Settings  ', 'zh-CN'), '  设置  ');
  assert.equal(translateUiText('搜索对话…', 'en'), 'Search conversations…');
  assert.equal(translateUiText('Ask anything', 'en'), 'Ask anything');
  assert.equal(translateUiText('关闭', 'en'), 'Close');
  assert.equal(translateUiText('截图', 'en'), 'Screenshot');
});

test('dynamic UI status copy translates while unknown user content is preserved', () => {
  assert.equal(translateUiText('QQ logged in: Jules', 'zh-CN'), 'QQ 已登录：Jules');
  assert.equal(translateUiText('3 tools pending...', 'zh-CN'), '3 个工具等待中…');
  assert.equal(translateUiText('Skills (2 enabled)', 'zh-CN'), '技能（已启用 2 个）');
  assert.equal(translateUiText('Send suggested reply: 保留原文', 'zh-CN'), '发送建议回复：保留原文');
  assert.equal(translateUiText('这是用户自己的消息', 'en'), '这是用户自己的消息');
});

test('confirmation copy is localized without translating user-authored file content', () => {
  const source = 'AI 想要修改你的人格文件 SOUL.md：\n\n旧文本：你好\n\n新文本：Hello\n\n是否允许？';
  assert.equal(
    translateUiText(source, 'en'),
    'AI wants to edit your personality file SOUL.md:\n\nOld text: 你好\n\nNew text: Hello\n\nAllow this change?',
  );
});

test('managed QQ connector surface has complete Chinese copy', () => {
  const expected = new Map([
    ['MCP Servers', 'MCP 服务'],
    ['Built-in QQ Connector', '内置 QQ 连接器'],
    ['Install Linux Dependencies', '安装 Linux 系统依赖'],
    ['Linux system dependencies are missing. Open the full setup to install them.', '缺少 Linux 系统依赖，请打开完整设置进行安装。'],
    ['Install managed runtimes', '安装托管运行环境'],
    ['Installing Chromium headless shell for QQ screenshots', '正在安装 QQ 截图所需的 Chromium 无头浏览器'],
    ['Verifying the QQ screenshot browser', '正在验证 QQ 截图浏览器'],
    ['Update Native NapCat', '更新原生 NapCat'],
    ['Prepare Isolated QQ + NapCat', '准备隔离 QQ + NapCat'],
    ['Rebuild Isolated QQ + Update NapCat', '重建隔离 QQ + 更新 NapCat'],
    ['Install and start native NapCat', '安装并启动原生 NapCat'],
    ['Start isolated QQ + NapCat', '启动隔离 QQ + NapCat'],
    ['Show Isolated QQ in Finder', '在 Finder 中显示隔离 QQ'],
    ['Used when the Windows native launcher supports quick login.', 'Windows 原生启动器支持快速登录时使用。'],
  ]);
  for (const [source, translated] of expected) {
    assert.equal(translateUiText(source, 'zh-CN'), translated);
  }
  assert.equal(
    translateUiText('启动隔离 QQ/NapCat 失败: permission denied', 'en'),
    'Failed to start isolated QQ/NapCat: permission denied',
  );
});

test('Linux startup diagnostics are localized while raw log details are preserved', () => {
  assert.equal(
    translateUiText('NapCat WebUI did not become ready within 60 seconds.\nloader: fixture\nLog: /private/log', 'zh-CN'),
    'NapCat WebUI 未能在 60 秒内就绪。\nloader: fixture\nLog: /private/log',
  );
  assert.equal(
    translateUiText('Dependency installation was cancelled or failed (exit status: 126). denied', 'zh-CN'),
    '系统依赖安装已取消或失败（exit status: 126）。denied',
  );
});

// ==================== 项目 / PTY 的后端错误 ====================
// 后端只出英文（messages.js 顶部：「Keep English first」），中文在渲染时生成。

test('project and PTY backend errors localize while paths and OS text are preserved', () => {
  const expected = new Map([
    ["Project 'abc-123' is not registered", '项目「abc-123」未登记'],
    ['Project folder no longer exists: /tmp/gone', '项目目录已不存在：/tmp/gone'],
    ['Not a directory: /tmp/file.txt', '不是一个目录：/tmp/file.txt'],
    ['Not found: src/a.js', '找不到：src/a.js'],
    ['Path escapes the project: ../../etc/passwd', '路径越出项目范围：../../etc/passwd'],
    ['Filesystem error: permission denied', '文件系统错误：permission denied'],
    ['src/utils is a directory', 'src/utils 是目录'],
    ["Session 'p1:claude:1:2' already exists", '会话「p1:claude:1:2」已存在'],
    ["Session 'p1:claude:1:2' does not exist", '会话「p1:claude:1:2」不存在'],
    ['Working directory does not exist: /tmp/gone', '工作目录不存在：/tmp/gone'],
    ['Unknown session kind: bash', '未知的会话类型：bash'],
    ['Failed to open PTY: out of ptys', '打开 PTY 失败：out of ptys'],
    ['Failed to write to PTY: broken pipe', '写入 PTY 失败：broken pipe'],
    ['Failed to resize PTY: bad size', '调整 PTY 尺寸失败：bad size'],
    // 无参数的几条走 messages.js 的静态词条
    ['Project name cannot be empty', '项目名不能为空'],
    ['Terminal sessions cannot be resumed', '终端会话不支持恢复'],
  ]);
  for (const [source, translated] of expected) {
    assert.equal(translateUiText(source, 'zh-CN'), translated);
  }
});

test('the conflict marker survives translation so FilePreview can still detect it', () => {
  // FilePreview 匹配的是**英文原文**（后端给什么就是什么），不是翻译结果。
  // 这条测试锁的是 Rust 侧 projects::CONFLICT_MARKER 与规则的措辞一致。
  const raw = 'File was changed by another program: src/a.js';
  assert.ok(raw.includes('was changed by another program'));
  assert.equal(translateUiText(raw, 'zh-CN'), '文件已被其它程序修改：src/a.js');
});

test('the generic "Failed to start" rule does not steal the social agent message', () => {
  // 新规则追加在 zh-CN 数组末尾，且 kind 写死成枚举 —— 两道保险。
  // 用 (.+) 的话这条会被翻成「启动 social agent 失败：…」
  assert.equal(
    translateUiText('Failed to start social agent: timeout', 'zh-CN'),
    '启动社交 Agent 失败：timeout',
  );
  assert.equal(
    translateUiText('Failed to start claude: No such file', 'zh-CN'),
    '启动 claude 失败：No such file',
  );
  assert.equal(
    translateUiText('Failed to start codex: No such file', 'zh-CN'),
    '启动 codex 失败：No such file',
  );
  // 不在枚举里的就不翻，总好过翻错
  assert.equal(
    translateUiText('Failed to start something else: x', 'zh-CN'),
    'Failed to start something else: x',
  );
});

test('English locale leaves the backend errors untouched', () => {
  for (const source of [
    "Project 'abc' is not registered",
    'Failed to open PTY: out of ptys',
    'Project name cannot be empty',
  ]) {
    assert.equal(translateUiText(source, 'en'), source);
  }
});
