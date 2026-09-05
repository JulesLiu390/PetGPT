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
