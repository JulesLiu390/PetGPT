import { UI_MESSAGES } from './messages.js';

export const DEFAULT_LANGUAGE = 'en';
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'zh-CN']);

let activeLanguage = DEFAULT_LANGUAGE;

export const normalizeLanguage = (value) => value === 'zh-CN' ? 'zh-CN' : DEFAULT_LANGUAGE;
export const getActiveLanguage = () => activeLanguage;
export const setActiveLanguage = (value) => {
  activeLanguage = normalizeLanguage(value);
};

const english = new Map();
const chinese = new Map();

for (const [en, zh] of UI_MESSAGES) {
  english.set(en, en);
  english.set(zh, en);
  chinese.set(en, zh);
  chinese.set(zh, zh);
}

// A few concise Chinese labels are shared by different English concepts.
// Prefer the canonical UI meaning when translating legacy Chinese source copy.
for (const [zh, en] of [
  ['设置', 'Settings'],
  ['截图', 'Screenshot'],
  ['可用', 'Available'],
  ['已启用', 'Enabled'],
  ['关闭', 'Close'],
  ['运行中', 'Running'],
  ['子 Agent', 'Subagent'],
  ['选择服务商', 'Select Provider'],
  ['选择模型', 'Select Model'],
  ['删除服务', 'Delete Server'],
  ['选择助手', 'Select Assistant'],
]) {
  english.set(zh, en);
}

const dynamicRules = {
  en: [
    [/^AI 想要覆盖你的人格文件 SOUL\.md：\n\n([\s\S]*?)\n\n是否允许？$/u, (_, preview) => `AI wants to overwrite your personality file SOUL.md:\n\n${preview.replace(/\n\.\.\.\(内容过长已截断\)$/u, '\n...(content truncated)')}\n\nAllow this change?`],
    [/^AI 想要修改你的人格文件 SOUL\.md：\n\n旧文本：([\s\S]*?)\n\n新文本：([\s\S]*?)\n\n是否允许？$/u, (_, oldText, newText) => `AI wants to edit your personality file SOUL.md:\n\nOld text: ${oldText}\n\nNew text: ${newText}\n\nAllow this change?`],
    [/^QQ (\d+) 已注册为 MCP 服务 (.+)$/u, (_, uin, server) => `QQ ${uin} was registered as MCP server ${server}`],
    [/^QQ 已登录：(.*)$/u, (_, account) => `QQ logged in: ${account}`],
    [/^刷新失败: (.*)（仍可使用兜底列表）$/u, (_, error) => `Refresh failed: ${error} (fallback list remains available)`],
    [/^(\d+) 个模型可选$/u, (_, count) => `${count} models available`],
    [/^~(\d+)字$/u, (_, count) => `~${count} chars`],
    [/^(\d+)字$/u, (_, count) => `${count} chars`],
    [/^正在下载 (.+)$/u, (_, asset) => `Downloading ${asset}`],
    [/^下载 (.+) 失败: (.+)$/u, (_, asset, error) => `Failed to download ${asset}: ${error}`],
    [/^读取 (.+) 版本失败: (.+)$/u, (_, repo, error) => `Failed to read ${repo} release: ${error}`],
    [/^解析 (.+) 版本失败: (.+)$/u, (_, repo, error) => `Failed to parse ${repo} release: ${error}`],
    [/^NapCat (.+) 缺少 NapCat\.Shell\.zip$/u, (_, version) => `NapCat ${version} does not include NapCat.Shell.zip`],
    [/^读取官方 QQ 入口失败: (.+)$/u, (_, error) => `Failed to read the official QQ entry: ${error}`],
    [/^创建隔离 QQ 副本失败: (.+)$/u, (_, error) => `Failed to create the isolated QQ copy: ${error}`],
    [/^恢复隔离副本的原版入口失败: (.+)$/u, (_, error) => `Failed to restore the original entry in the isolated copy: ${error}`],
    [/^复核官方 QQ 入口失败: (.+)$/u, (_, error) => `Failed to verify the official QQ entry: ${error}`],
    [/^打开隔离 QQ 日志失败: (.+)$/u, (_, error) => `Failed to open the isolated QQ log: ${error}`],
    [/^启动隔离 QQ\/NapCat 失败: (.+)$/u, (_, error) => `Failed to start isolated QQ/NapCat: ${error}`],
    [/^检查隔离 QQ\/NapCat 状态失败: (.+)$/u, (_, error) => `Failed to check isolated QQ/NapCat: ${error}`],
    [/^记录隔离 QQ 进程失败: (.+)$/u, (_, error) => `Failed to record the isolated QQ process: ${error}`],
    [/^隔离 QQ\/NapCat 启动后立即退出（(.+)）([\s\S]*)$/u, (_, status, details) => `Isolated QQ/NapCat exited immediately (${status})${details.replace(/^：/u, ':')}`],
    [/^创建隔离 QQ 版本目录失败: (.+)$/u, (_, error) => `Failed to create the isolated QQ version directory: ${error}`],
    [/^生成隔离 QQ 版本配置失败: (.+)$/u, (_, error) => `Failed to generate the isolated QQ version configuration: ${error}`],
    [/^写入隔离 QQ 版本配置失败: (.+)$/u, (_, error) => `Failed to write the isolated QQ version configuration: ${error}`],
    [/^检查隔离 QQ 版本配置失败: (.+)$/u, (_, error) => `Failed to inspect the isolated QQ version configuration: ${error}`],
    [/^替换隔离 QQ 版本配置失败: (.+)$/u, (_, error) => `Failed to replace the isolated QQ version configuration: ${error}`],
    [/^启用隔离 QQ 版本配置失败: (.+)$/u, (_, error) => `Failed to activate the isolated QQ version configuration: ${error}`],
    [/^隔离 QQ\/NapCat 启动超时：20 秒内未能连接本机 WebUI([\s\S]*)$/u, (_, details) => `Isolated QQ/NapCat startup timed out because the local WebUI was not reachable within 20 seconds${details.replace(/^：/u, ':')}`],
  ],
  'zh-CN': [
    [/^NapCat exited during startup \((.+)\)\.([\s\S]*)$/u, (_, status, details) => `NapCat 启动时退出（${status}）。${details}`],
    [/^NapCat WebUI did not become ready within (\d+) seconds\.([\s\S]*)$/u, (_, seconds, details) => `NapCat WebUI 未能在 ${seconds} 秒内就绪。${details}`],
    [/^Dependency installation was cancelled or failed \((.+)\)\. ([\s\S]*)$/u, (_, status, details) => `系统依赖安装已取消或失败（${status}）。${details}`],
    [/^Could not start the dependency installer: ([\s\S]+)$/u, (_, error) => `无法启动系统依赖安装程序：${error}`],
    [/^Could not start NapCat AppImage: ([\s\S]+)$/u, (_, error) => `无法启动 NapCat AppImage：${error}`],
    [/^Cannot open NapCat log: ([\s\S]+)$/u, (_, error) => `无法打开 NapCat 日志：${error}`],
    [/^Cannot read the saved NapCat WebUI configuration: ([\s\S]+)$/u, (_, error) => `无法读取保存的 NapCat WebUI 配置：${error}`],
    [/^AI wants to overwrite your personality file SOUL\.md:\n\n([\s\S]*?)\n\nAllow this change\?$/u, (_, preview) => `AI 想要覆盖你的人格文件 SOUL.md：\n\n${preview.replace(/\n\.\.\.\(content truncated\)$/u, '\n...(内容过长已截断)')}\n\n是否允许？`],
    [/^AI wants to edit your personality file SOUL\.md:\n\nOld text: ([\s\S]*?)\n\nNew text: ([\s\S]*?)\n\nAllow this change\?$/u, (_, oldText, newText) => `AI 想要修改你的人格文件 SOUL.md：\n\n旧文本：${oldText}\n\n新文本：${newText}\n\n是否允许？`],
    [/^QQ (\d+) was registered as MCP server (.+)$/u, (_, uin, server) => `QQ ${uin} 已注册为 MCP 服务 ${server}`],
    [/^QQ logged in: (.*)$/u, (_, account) => `QQ 已登录：${account}`],
    [/^Refresh failed: (.*) \(fallback list remains available\)$/u, (_, error) => `刷新失败：${error}（仍可使用兜底列表）`],
    [/^(\d+) models available$/u, (_, count) => `${count} 个模型可选`],
    [/^~(\d+) chars$/u, (_, count) => `~${count}字`],
    [/^(\d+) chars$/u, (_, count) => `${count}字`],
    [/^(Enable|Disable) (.+)$/u, (_, action, label) => `${action === 'Enable' ? '启用' : '禁用'}${translateCore(label, 'zh-CN')}`],
    [/^Off · (\d+) finishing$/u, (_, count) => `已关闭 · ${count} 个任务正在收尾`],
    [/^Send suggested reply: ([\s\S]+)$/u, (_, reply) => `发送建议回复：${reply}`],
    [/^Skills \((\d+) enabled\)$/u, (_, count) => `技能（已启用 ${count} 个）`],
    [/^(\d+) keys configured$/u, (_, count) => `已配置 ${count} 个 Key`],
    [/^(.+) Identity$/u, (_, server) => `${server} 身份`],
    [/^Bot (.+) ID$/u, (_, server) => `机器人 ${server} ID`],
    [/^Owner (.+) ID$/u, (_, server) => `主人 ${server} ID`],
    [/^Your bot's ID on (.+), used to detect @mentions$/u, (_, server) => `机器人在 ${server} 上的 ID，用于识别 @提及`],
    [/^Your personal ID on (.+), so the bot can recognize you$/u, (_, server) => `你在 ${server} 上的个人 ID，用于让机器人识别你`],
    [/^(\d+) CC subagent\(s\) running$/u, (_, count) => `${count} 个 CC 子 Agent 正在运行`],
    [/^Error: ([\s\S]+)$/u, (_, error) => `错误：${error}`],
    [/^Reset to normal after (\d+)s$/u, (_, seconds) => `${seconds} 秒后恢复正常`],
    [/^(\d+) controls$/u, (_, count) => `${count} 项控制`],
    [/^(\d+) tools? pending\.\.\.$/u, (_, count) => `${count} 个工具等待中…`],
    [/^View (\d+) running ›$/u, (_, count) => `查看 ${count} 个运行中任务 ›`],
    [/^Calling (.+)\.\.\.$/u, (_, tool) => `正在调用 ${tool}…`],
    [/^Downloading (.+)$/u, (_, asset) => `正在下载 ${asset}`],
    [/^Are you sure you want to delete "(.+)"\?$/u, (_, name) => `确定要删除“${name}”吗？`],
    [/^Failed to save settings: (.+)$/u, (_, error) => `保存设置失败：${error}`],
    [/^Failed to save social config: (.+)$/u, (_, error) => `保存社交配置失败：${error}`],
    [/^Failed to save: (.+)$/u, (_, error) => `保存失败：${error}`],
    [/^Failed to delete server: (.+)$/u, (_, error) => `删除服务失败：${error}`],
    [/^Failed to delete assistant: (.+)$/u, (_, error) => `删除助手失败：${error}`],
    [/^Failed to delete skin: (.+)$/u, (_, error) => `删除皮肤失败：${error}`],
    [/^Failed to restore skin: (.+)$/u, (_, error) => `恢复皮肤失败：${error}`],
    [/^Failed to import skin: (.+)$/u, (_, error) => `导入皮肤失败：${error}`],
    [/^Failed to export skin: (.+)$/u, (_, error) => `导出皮肤失败：${error}`],
    [/^Failed to start social agent: (.+)$/u, (_, error) => `启动社交 Agent 失败：${error}`],
    [/^Failed to stop social agent: (.+)$/u, (_, error) => `停止社交 Agent 失败：${error}`],
    [/^MCP server "(.+)" no longer exists\. Select another server or register it again\.$/u, (_, server) => `MCP 服务“${server}”已不存在。请另选一个服务，或重新注册。`],
    [/^MCP server "(.+)" not found$/u, (_, server) => `未找到 MCP 服务“${server}”`],
  ],
};

const translateCore = (value, language) => {
  const dictionary = language === 'zh-CN' ? chinese : english;
  const direct = dictionary.get(value);
  if (direct !== undefined) return direct;
  for (const [pattern, render] of dynamicRules[language]) {
    const match = value.match(pattern);
    if (match) return render(...match);
  }
  return value;
};

export const translateUiText = (value, language = DEFAULT_LANGUAGE) => {
  if (typeof value !== 'string' || value.length === 0) return value;
  const locale = normalizeLanguage(language);
  const match = value.match(/^(\s*)([\s\S]*?)(\s*)$/u);
  if (!match || !match[2]) return value;
  return `${match[1]}${translateCore(match[2], locale)}${match[3]}`;
};
