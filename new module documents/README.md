# 桌面宠物 AI 人格与记忆系统 — 设计文档

## 概述

本文档规划了桌面宠物聊天软件中 **人格（SOUL）、用户认知（USER）、记忆（MEMORY）** 持久化系统的重构方案。

**这是对现有系统的替换，不是新增模块。** 现有的记忆系统（`longTimeMemory()` + `processMemory()` + `pets.user_memory` JSON key-value）和人格系统（`pets.system_instruction` 纯文本字段）将被完全替代。

核心理念：通过本地 Markdown 文件赋予 AI 宠物 **持久的性格、对主人的了解、以及跨会话的记忆**。这些文件在每次对话时注入 system prompt，AI 可以通过内置的 write/edit 工具自主维护和更新它们。

## 替换的现有系统

| 现有组件 | 位置 | 替换为 |
|----------|------|--------|
| `pets.system_instruction` (DB TEXT) | Rust `pets.rs` / `ManagementPage.jsx` | **SOUL.md** (文件系统) |
| `pets.user_memory` (DB JSON key-value) | Rust `pets.rs` / `tauri.js` | **USER.md** + **MEMORY.md** (文件系统) |
| `longTimeMemory()` (额外 LLM 调用判断重要性) | `openai.js` | AI 通过 function calling 自主调用 `edit` 工具 |
| `processMemory()` (额外 LLM 调用生成描述) | `openai.js` | 直接全文注入，无需二次处理 |
| `getPetUserMemory()` / `updatePetUserMemory()` | `tauri.js` | 新的文件 read/write/edit Tauri 命令 |
| `ChatboxInputBox.jsx` 中 4 个分支的 prompt 拼接 | `ChatboxInputBox.jsx` L1300-1380 | 统一的 Prompt 构建器 |

## 设计灵感

参考 [OpenClaw](https://github.com/openclaw/openclaw) 的 Workspace Bootstrap Files 机制：

- 每次对话轮次从磁盘读取文件内容，注入 system prompt
- AI 通过通用的文件写入/编辑工具自主更新这些文件
- 文件存储在本地文件系统，用户可直接编辑
- 无需向量数据库或 RAG — 全文本注入，简单可靠

## 三个核心文件

| 文件 | 用途 | 谁来写 | 何时读取 | 受记忆开关控制 |
|------|------|--------|----------|---------------|
| **SOUL.md** | 宠物的人格、性格、语气、行为准则 | 用户创建/编辑，AI 可建议修改 | **始终读取**（不受记忆开关影响） | ❌ 始终生效 |
| **USER.md** | 宠物对主人的认知（姓名、偏好、习惯等） | AI 在对话中自主更新 | 记忆开启时读取 | ✅ 读取+写入 |
| **MEMORY.md** | 长期记忆（重要事件、决策、上下文） | AI 自主维护 | 记忆开启时读取 | ✅ 读取+写入 |

## 记忆开关（复用现有 UI）

现有聊天输入框旁的 **FaBrain 记忆按钮**（per-conversation toggle）将被保留，语义升级为控制 USER.md 和 MEMORY.md 的读写：

| 记忆开关 | SOUL.md | USER.md | MEMORY.md |
|----------|---------|---------|-----------|
| **ON** | ✅ 读取（始终） | ✅ 读取 + ✅ AI 可写入 | ✅ 读取 + ✅ AI 可写入 |
| **OFF** | ✅ 读取（始终） | ❌ 不读取 + ❌ 不可写入 | ❌ 不读取 + ❌ 不可写入 |

- **SOUL.md 不受记忆开关影响** — 宠物的性格始终生效，关记忆不等于失忆到忘记自己是谁
- **关闭记忆时**，不仅不注入 USER.md/MEMORY.md 到 prompt，也不注册针对这两个文件的 write/edit 工具
- **per-conversation 隔离** — 不同 tab 可独立开关，Settings 中 "Enable Memory by Default" 控制新 tab 默认值

## 文档导航

| 文档 | 内容 |
|------|------|
| [SOUL.md 定义](soul-definition.md) | 人格文件的定义、模板设计、设计意图 |
| [USER.md 定义](user-definition.md) | 用户画像文件的定义、模板设计、更新策略 |
| [MEMORY.md 定义](memory-definition.md) | 记忆文件的定义、记忆策略、生命周期管理 |
| [文件读写模块](file-operations.md) | 内置 write/edit 工具的设计 |
| [System Prompt 注入](system-prompt-injection.md) | 文件读取、截断、注入机制 |
| [需求与约束](requirements.md) | 功能需求、非功能需求、验收标准 |

## 整体架构

```
┌─────────────────────────────────────────────┐
│                 桌面宠物应用                    │
│                                             │
│  ┌─────────┐    ┌──────────┐    ┌────────┐  │
│  │ 对话 UI  │───▶│ 对话引擎  │───▶│ LLM API│  │
│  └─────────┘    └──────────┘    └────────┘  │
│                      │                       │
│              ┌───────┴───────┐               │
│              ▼               ▼               │
│    ┌──────────────┐  ┌──────────────┐        │
│    │ Prompt 构建器 │  │ 工具执行引擎  │        │
│    │              │  │              │        │
│    │ 读取并注入:   │  │ 内置工具:     │        │
│    │ • SOUL.md    │  │ • write      │        │
│    │ • USER.md    │  │ • edit       │        │
│    │ • MEMORY.md  │  │ • read       │        │
│    └──────┬───────┘  └──────┬───────┘        │
│           │                 │                │
│           └────────┬────────┘                │
│                    ▼                         │
│           ~/.app/workspace/                  │
│           ├── SOUL.md                        │
│           ├── USER.md                        │
│           └── MEMORY.md                      │
└─────────────────────────────────────────────┘
```

## 核心流程

1. **对话开始** → 始终读取 SOUL.md；如果记忆开启，则读取 USER.md 和 MEMORY.md → 拼接进 system prompt
2. **对话进行中** → 如果记忆开启，LLM 通过 function calling 调用内置 write/edit 工具更新 USER.md/MEMORY.md
3. **对话结束** → 文件已被实时更新，无需额外持久化步骤
4. **下次对话** → 重新读取文件，AI 宠物"记住"之前的一切

## 设计原则

1. **简单优先** — 纯 Markdown 文件 + 全文注入，不引入向量数据库
2. **用户可控** — 用户可以直接编辑任何文件，AI 的修改用户可见
3. **透明可审** — 所有 AI 的"记忆"和"人格"都是可读的文本文件
4. **渐进增强** — 先实现基础功能，未来可按需添加日记忆、向量搜索等
