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
