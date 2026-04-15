/**
 * toolDocs.js — Intent 工具详细说明的默认内容（按需渐进披露）
 *
 * 设计：
 * - 每个 .md 自包含，不允许再延伸引用其他 .md
 * - 硬规则与触发条件仍在 Intent prompt 里保留，此处放参数、语法、反模式、例子
 * - Agent 启动时 seed 到 workspace `social/tools/{name}.md`（若不存在才写）
 * - 用户可在 workspace 覆盖定制，代码更新默认版本不会覆盖用户已改的文件
 *
 * 使用方式：LLM 通过 social_read("social/tools/{name}.md") 按需读取。
 */

import * as tauri from './tauri';

/** 默认 .md 内容（代码自带，随版本更新） */
export const DEFAULT_TOOL_DOCS = {
  image: `# 图片工具族完整指南（screenshot / webshot / webshot_send / image_list / image_send）

## 工具总览与差异
| 工具 | 作用 | 是否立即发送 |
|---|---|:---:|
| screenshot | 截 QQ 聊天记录图 → 保存 | ❌ |
| webshot | 截网页内容块图 → 保存 | ❌ |
| webshot_send | 截网页图 → 保存 + 立即发群 | ✅ |
| image_list | 列出已保存的图片 | — |
| image_send | 发送已保存的图片到当前群 | ✅ |

## screenshot(desc, message_id)
- desc — 截图描述（自己日后认图用）
- message_id — 对话记录中 [#数字] 的数字，决定从哪条消息开始截

截图会自动渲染为 QQ 风格并保存到 \`social/images/\`。
仅保存，不会自动发送；要发到群里，需要在 write_intent_plan 的 actions 里加：
\`\`\`json
{"type": "image", "file": "截图文件名"}
\`\`\`

## webshot(url, keyword, desc?)
- url — 网页完整 URL
- keyword — 要截取的关键词所在内容块
- desc — 可选描述

### keyword 选择规则
用 CC 报告或搜索结果中出现的**有意义的英文/中文短语**：
- ✅ 好：\`"faculty searches"\` / \`"hiring decline"\` / \`"教职招聘"\` / \`"Gemini benchmark"\`
- ❌ 烂：纯数字、特殊符号、太短（<3 字）、太宽泛（如 "the"、"中国"）

失败可换词重试；关键词没命中会返回错误。

## webshot_send(url, keyword, desc?)
和 webshot 一致，但截完立即发送到群里。适合：
- 辩论中甩数据打脸
- 分享 CC 研究引用来源
- 佐证观点（"看这里原文..."）

会自动：保存 → 发送 → 更新状态（不用额外 image_send）。

## image_list()
返回所有已保存图片的 {file, desc, date} 列表。
发送前先看有哪些可用，尤其是想翻旧截图打脸时。

## image_send(file)
- file — social/images/ 下的文件名（不含路径前缀）

发送指定图片到当前群聊。

## 组合模式
### 模式 A：截图存档 → 事后使用
1. 当下：screenshot(desc="群友否认说过XX", message_id=12345)
2. 几轮后他否认：image_list() 找那张
3. image_send(file="screenshot_xxx.png")

### 模式 B：网页数据佐证（一步到位）
- 直接 webshot_send(url, keyword)

### 模式 C：网页数据保留后多次用
1. webshot(url, keyword) → 保存
2. 第一次发：actions 里 {"type":"image", "file":"..."}
3. 第二次发：image_send(file)

## 反模式
- ❌ 用 screenshot 后忘记加 image action → 图片没发出去
- ❌ webshot 后又调 image_send 发同一张（重复步骤，直接用 webshot_send）
- ❌ keyword 用纯数字或超短词 → 截图失败
- ❌ 一次发很多张（5+）刷屏
- ❌ 每次回答都配图（图片应该有信息量）
`,
  voice_send: `# voice_send 完整指南

## 签名
voice_send(text: string)

## 参数
- text — 要朗读的文字。硬限 50 字（含标点和空格），超 1 字都会被系统拒绝。**实际请控制在 30-40 字以内**给自己留容错。

## 核心定位
voice ≠ reply 的语音版。voice 是氛围 / 情绪 / 卖萌的副通道，不用来传递信息。
- 所有"内容 / 观点 / 解释 / 回答"必须走 reply 文字
- 语音只承载短促的情绪表达

## 调用方式
voice_send 是即时调用，不要写进 write_intent_plan.actions。
直接在 Intent 这一轮里 call 这个 tool 即可，发送会立刻完成。
与 webshot_send / sticker_send 同类（都是"即时副通道"工具）。

## voice 和 reply 可以并行
想"发语音 + 发干货回复"时：
1. 先 voice_send 一句短的（"早呀～" / "嘿嘿来啦"）
2. 然后在 plan 里照常写 reply action 发文字

不要把所有想说的话都塞进 voice 然后省略 reply！长内容用 voice 会丢信息。

## 每轮限制
每轮 Intent 最多 voice_send 一次。已经发过别再发。

## 适合场景
- 群友明确说"发个语音听听" → voice_send 一句简短问候或卖萌（≤30 字），同时 reply 发完整回答
- 适合配音的短句：打招呼、撒娇、惊呼、感叹、自嘲
  - 例："啊啊啊我懂了" / "嘿嘿被发现了" / "早呀～" / "我来啦"

## 不适合场景
- 解释概念 → 走 reply
- 引用 URL → 走 reply（语音读 URL 是灾难）
- 回答技术问题 → 走 reply
- @多人 → 走 reply
- 长篇叙述 → 走 reply

## 字数控制技巧
写 voice text 之前先数一遍字数。超过 40 就立刻砍短或重写：
- 去掉描述性形容词
- 去掉补充说明（括号内容）
- 合并同义短句

## 反模式
- ❌ 把 reply 的内容塞进 voice："关于这个问题我觉得呢，主要是..."（直接爆字数）
- ❌ 每轮都发一个 voice（刷屏）
- ❌ voice 里放 URL / 代码 / 英文长词（TTS 朗读会很奇怪）
- ❌ 把 voice 当成 reply 的替代品，不发 reply 只发 voice → 错过信息传递
`,
  dispatch_subagent: `# dispatch_subagent 完整指南

## 签名
dispatch_subagent(task: string, maxLen: number = 500)

## 参数
- task — 明确的研究任务描述。CC 会在独立沙箱里按这个任务自主使用 web search / 读取工具完成。越具体越好：含关键词、时间锚点、想要的结论形式。
- maxLen — 结果长度上限（tokens），默认 500。简单问题 200-300；技术深度研究 500-1000。

## 派前必须 tavily 预检（硬规则）
涉及 AI 模型 / 公司 / 人物 / 产品 / 时事等时效性强的话题时，必须先 tavily_search 做一次轻量预检，确认：
- 你脑中记得的版本号 / 事实方向是否仍然有效
- 关键人物的角色/立场是否变化
- 时间锚点对不对

### 预检例子
- 想派"查 Gemini Pro 架构"：先 tavily_search("latest Gemini model 2026") 看最新版本
- 想派"Claude 3.5 benchmarks"：先 tavily_search("Claude latest version 2026") 看当前是 3.5 还是更新
- 想派"OpenAI 新发布"：先 tavily_search("OpenAI news April 2026") 定位时间

预检若发现你脑中过时 → 调整 task 指令，告诉 CC "注意当前最新版本是 X"。

## 派出之后（硬规则）
1. 不再用 tavily_search 搜同一话题 — CC 会搜得更全面，重复浪费且可能冲突
2. 在状态感知里写明"已派 CC 查 XXX，等结果再给结论" — 让下轮 Intent 知道在等什么
3. 不编造搜索结果 — 可以回复"让我查查"，但不能凭想象说 CC 的结论
4. 等 CC 完成回调 — 会通过 subagent 状态通知；不要再次 dispatch 同一任务

## 反模式
- 模糊任务："查下 AI 最近怎样" → CC 不知道查什么
- 时序错乱："查 Gemini 1.5 架构"（预检都会告诉你 Gemini 3 已经出了）
- 派完立刻对群友下结论："我派了 CC，结论是..." — 你根本还没拿到结果
- 同一话题连派 2-3 次 — 耐心等第一次结果

## 好的 task 指令例子
- "查 Google Gemini 系列模型 2026 年最新架构，重点：推理模式、视觉理解、Mixture-of-Experts 细节。引用来源要有 URL。"
- "查 Anthropic 2026 年 1-4 月 Claude 新特性发布时间线，按时间排列，每项包含日期 + 简述。"

## 任务长度建议
- task 建议 50-200 字；太短信息不够，太长反而让 CC 跑偏
- maxLen 选择：引用型 200-400；报告型 500-800；深度分析 1000+

## 配合工具
- cc_history() — 派前先查是否有现成结果可复用
- cc_read(file) — CC 完成后读取结果文件
- 完成后回复群里时：基于结果详细展开，引用关键数据附 URL
`,
};

/**
 * 把默认 .md 内容写入 workspace（若文件不存在）。
 * 用户已经修改过的文件不会被覆盖。
 *
 * 在 startSocialLoop 启动时调一次即可。
 */
export async function seedToolDocs(petId) {
  if (!petId) return;
  for (const [name, content] of Object.entries(DEFAULT_TOOL_DOCS)) {
    const path = `social/tools/${name}.md`;
    try {
      const existing = await tauri.workspaceRead(petId, path).catch(() => '');
      if (existing && existing.trim()) continue; // 用户已有，跳过
      await tauri.workspaceWrite(petId, path, content);
    } catch (e) {
      console.warn(`[toolDocs] Failed to seed ${path}:`, e);
    }
  }
}
