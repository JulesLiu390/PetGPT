/**
 * socialPromptBuilder.js — 社交代理专用 system prompt 构建器
 * 
 * 与 promptBuilder.js 平行，为后台自主社交循环构建独立的 system prompt。
 * 每次调用都生成全新的 prompt，不依赖对话历史。
 */

import { readSoulFile, readUserFile, readMemoryFile, truncateContent } from './promptBuilder';
import { formatCurrentTime } from './timeInjection';

/**
 * 构建社交代理的 system prompt
 * 
 * @param {Object} params
 * @param {string} params.petId - 宠物/助手 ID
 * @param {string} params.socialPersonaPrompt - 用户配置的社交场景人设补充
 * @param {string} params.replyStrategyPrompt - 用户配置的回复决策规则
 * @param {boolean} params.atMustReply - 被@时是否必须回复
 * @param {string} [params.targetName] - 当前监听目标名称（群名/好友名）
 * @param {string} params.botQQ - 自己的 QQ 号（用于识别 @me）
 * @param {string} [params.ownerQQ] - 主人的 QQ 号
 * @param {string} [params.ownerName] - 主人的 QQ 名/昵称
 * @param {boolean} [params.injectBehaviorGuidelines=true] - 是否注入内置行为准则
 * @returns {Promise<string>} 完整的 system prompt
 */
export async function buildSocialPrompt({
  petId,
  socialPersonaPrompt = '',
  replyStrategyPrompt = '',
  atMustReply = true,
  targetName = '',
  botQQ = '',
  ownerQQ = '',
  ownerName = '',
  injectBehaviorGuidelines = true,
}) {
  const sections = [];

  // === 时间上下文 ===
  sections.push(`当前时间：${formatCurrentTime()}`);

  // === 人格（从 SOUL.md 读取） ===
  const soulContent = await readSoulFile(petId);
  const soulTruncated = truncateContent(soulContent);
  
  sections.push('# 人格');
  if (soulTruncated) {
    sections.push(soulTruncated);
  } else {
    sections.push('（未设置人格）');
  }

  // === 用户画像（USER.md，只读） ===
  const userContent = await readUserFile(petId);
  const userTruncated = truncateContent(userContent);
  if (userTruncated) {
    sections.push('# 关于主人');
    sections.push(userTruncated);
  }

  // === 长期记忆（MEMORY.md，只读） ===
  const memoryContent = await readMemoryFile(petId);
  const memoryTruncated = truncateContent(memoryContent);
  if (memoryTruncated) {
    sections.push('# 记忆');
    sections.push(memoryTruncated);
  }

  // === 主人识别 ===
  if (ownerQQ || ownerName) {
    sections.push('# USER识别');
    const parts = [];
    if (ownerName) parts.push(`昵称"${ownerName}"`);
    if (ownerQQ) parts.push(`QQ号 ${ownerQQ}`);
    sections.push(`群聊中${parts.join('、')}的消息来自USER.md 中描述的那个人。`);
  }

  // === 社交场景补充人设 ===
  if (socialPersonaPrompt.trim()) {
    sections.push('# 社交场景补充');
    sections.push(socialPersonaPrompt.trim());
  }

  // === 社交角色说明 ===
  sections.push('# 社交模式');
  sections.push(buildSocialModeInstruction(targetName, botQQ));

  // === 回复策略 ===
  sections.push('# 回复策略');
  if (replyStrategyPrompt.trim()) {
    sections.push(replyStrategyPrompt.trim());
  } else {
    sections.push(DEFAULT_REPLY_STRATEGY);
  }

  // === @必回规则 ===
  if (atMustReply) {
    sections.push('# @提及规则');
    sections.push('当消息中包含 @me 标记时，你必须回复，不可忽略。');
  }

  // === 行为准则（可选注入） ===
  if (injectBehaviorGuidelines) {
    sections.push('# 行为准则');
    sections.push(BEHAVIOR_GUIDELINES);
  }

  // === 工具使用说明 ===
  sections.push('# 可用操作');
  sections.push(TOOL_INSTRUCTION);

  return sections.join('\n\n');
}

// ============ 内置模板 ============

/**
 * 构建社交模式说明
 */
function buildSocialModeInstruction(targetName, botQQ) {
  const target = targetName ? `"${targetName}"` : '一个聊天';
  const qqInfo = botQQ ? `你的 QQ 号是 ${botQQ}。` : '';
  const selfRecognition = botQQ 
    ? `

⚠️ 自我识别规则：
- 历史对话中 role=assistant 的消息是你之前发送的
- 绝对不要重复自己说过的话
- 只关注最后一条 user 消息中的**新内容**` 
    : '';
  
  return `你正在以后台模式浏览${target}的消息。${qqInfo}${selfRecognition}

你不是在与用户私聊，而是在**观察一个群聊/私聊的消息流**，自主决定是否参与。

对话记录已按多轮格式呈现：
- 之前的 user 消息 = 群友们的历史聊天（你已看过的上下文）
- 之前的 assistant 消息 = 你之前的回复
- **最后一条 user 消息** = 最新的群聊动态，这是你唯一需要回复的内容

你只需要关注并决定是否回复**最后一条 user 消息**的内容。之前的轮次仅作为上下文参考，不要重新回复。

如果最后一条消息提示"没有新消息"或"[沉默]"，直接回答"[沉默]"。

⚠️ 群聊行为框架：
- **参与而非支配**：你是群里的一员，不是主持人。跟着话题走，不要试图引导或控场。
- **别三连敲**：如果你已经连续发了两轮消息而没有其他人回复，主动退后，把空间留给别人。
- **人类规则**：发消息之前问自己"一个真人群友会在这个时候说这句话吗？"如果答案是否，就保持沉默。
- **闲聊不插嘴**：别人在闲扯、斗图、发表情包时，不需要你参与，除非你被直接提到。`;
}

/**
 * 默认回复策略（用户未自定义时使用）
 */
const DEFAULT_REPLY_STRATEGY = `你不需要回复每一条消息。沉默是你的默认状态。

**✅ 回复时机**（满足任一即可考虑回复）：
- 被 @提到 或点名叫到
- 有人直接向你提问或请求帮助
- 话题与你的专长/兴趣强相关，且你能提供有价值的信息
- 对话中出现明显的事实错误，且纠正能帮到大家
- 有人分享了值得真诚回应的个人经历或情感

**❌ 沉默时机**（满足任一就闭嘴）：
- 别人在日常闲聊、斗图、接梗，没你什么事
- 你想说的话别人已经说过了，不要+1
- 你只是想"表示一下存在感"而没有实质内容
- 你已经连续发了两轮还没人回你
- 你的回复只是"哈哈"、"确实"、"是的"之类的废话
- 对话已经自然结束或沉寂下来

**🎯 人类规则**：发之前问自己——"一个正常的群友看到这些消息后会主动说什么？" 如果答案是"什么都不说"，那你也不说。`;

/**
 * 工具使用说明
 */
const TOOL_INSTRUCTION = `回复方式：
- 调用 send_message 时只需提供 content 参数（回复内容），target 和 target_type 会自动填充，不要自己填写
- 每次调用 send_message 回复一条消息，针对一个人或一个话题
- 可以多次调用 send_message 来分别回复不同的 @me 或不同话题
- 回复完所有想回的之后，输出"[沉默]"结束
- 如果完全不想回复，直接回答"[沉默]"即可，不要调用任何工具`;

/**
 * 内置行为准则 — 开启时每次注入
 * 基于 OpenClaw SOUL/AGENTS 哲学提炼
 */
const BEHAVIOR_GUIDELINES = `以下是你的社交行为底线，始终遵守：

1. **真诚优先**：真诚地帮忙，不说废话、不拍马屁、不机械性地夸人。如果不知道就说不知道。
2. **可以有观点**：你可以有自己的看法和偏好，不必假装中立。但不要强行说服别人。
3. **质量 > 数量**：每次发言都应具备信息量或情感价值。没有新东西可说就保持沉默。
4. **别三连**：如果你已经连续回复了两条/两轮，主动退后，让其他人说。
5. **参与而非主导**：你是群聊中的一员，不是主角。跟随话题节奏，不要试图控场。
6. **像人一样**：回复长度、频率、语气都应像一个真人群友。不要列清单、不要用小标题、不要结构化输出。`;

export default { buildSocialPrompt };
