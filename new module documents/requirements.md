# Future Gadget No. 9: QQ Neural Link (Project Penguin)

## 1. 核心目标 (Mission)

赋予 **PetGPT** 接入 QQ 网络的社交能力，使其能够作为 **独立 Agent** 在后台运行，自主参与群聊互动，而不干扰主界面的正常对话。

---

## 2. 架构设计 (Architecture)

采用 **两层架构**：PetGPT 作为 MCP 客户端，连接一个**独立的 QQ MCP Server 项目**。MCP Server 内部封装 NapCatQQ 无头客户端，对外只暴露标准 MCP 接口。

### 2.1 两层架构图

```
┌──────────────────────────────────┐
│  PetGPT (MCP Client / Brain)    │  ← 已有，无需改动
│  - Agent Mode 后台线程           │
│  - 轮询上下文 → LLM 决策 → 回复  │
├────────── MCP (stdio) ──────────┤
│  qq-agent-mcp (独立项目)         │  ← 新建独立仓库
│  ┌─ MCP Server (Python)        │
│  │  - 暴露 MCP Tools            │
│  │  - 消息缓冲 & 上下文组装      │
│  ├─ NapCatQQ (子进程)           │
│  │  - QQ 协议通信               │
│  │  - OneBot v11 localhost API  │
│  └──────────────────────────────┘
└──────────────────────────────────┘
```

### 2.2 组件概览

| 组件 | 位置 | 职责 |
|------|------|------|
| **PetGPT** | 已有主程序 | MCP 客户端 + Agent Mode 决策引擎，**零代码改动** |
| **qq-agent-mcp** | 独立 Python 项目 | MCP Server + NapCat 进程管理 + 消息清洗 |

### 2.3 为什么是独立项目

*   PetGPT 已有完整的 MCP 客户端（stdio + HTTP/SSE），直接复用
*   NapCat 作为 MCP Server 的子进程管理，外部无需感知
*   单个 `pip install` 或 `uvx` 即可部署，PetGPT 只需添加一行 MCP 配置
*   独立开发、独立版本、独立发布，不耦合 PetGPT 主仓库

---

## 3. PetGPT 侧：Agent Mode (The Brain)

> PetGPT 主项目 **不需要代码改动**，以下描述 Agent Mode 如何利用已有 MCP 能力工作。

*   **独立运行:** 作为一个 **后台线程** 运行，不占用主聊天窗口。
*   **群监控范围:** 通过 MCP Server 的 `--groups` 参数指定监控的 QQ 群，**只有指定群的消息才会被缓冲和处理**，其他群完全忽略。
*   **私聊白名单:** 通过 `--friends` 参数指定允许私聊的 QQ 号。**默认不监控私聊**，只有白名单内的好友消息才会被接收和回复。
*   **感知循环 (The Loop):**
    *   定期调用 MCP 的 `get_recent_context()`，获取指定群或私聊的滑动窗口消息 + 历史压缩摘要。
    *   **静默思考:** 在后台调用 LLM 分析上下文，不产生可见的 Token 流。
*   **合一决策 (Unified Decision):** 采用单轮 LLM 调用完成「判断 + 生成 + 执行」。System prompt 中写入决策规则，LLM 自行决定是否调用 `send_message` 工具。不需要回复时直接返回空文本，不调用任何工具。**整个决策链路只有 1 次 LLM 往返（1-5 秒）**，无需额外的前置判断调用。
*   **决策规则 (在 System Prompt 中):**
    *   **Mandatory (强制):** 被 @提及 → **必须回复**，无条件触发。
    *   **Vibe Check (兴趣):** 上下文中检测到感兴趣的话题 → 可选择回复。
    *   **Ignore (忽略):** 无关内容 → 不调用任何工具，直接结束。
*   **UI 反馈:** 状态栏显示 Agent 状态 (潜水中/吃瓜中)，可选弹窗通知。

### 3.1 消息上下文策略

Agent 拿到的上下文由 MCP Server 管理，采用**滑动窗口 + 自动压缩**：

```
┌─────────────────────────────────────┐
│  compressed_summary (历史摘要)       │  ← 旧消息自动压缩成的文本
│  "讨论了 Tauri 性能优化..."          │
├─────────────────────────────────────┤
│  messages (最近 N 条原始消息)        │  ← 滑动窗口，完整保留
│  msg_081 ... msg_100                │
└─────────────────────────────────────┘
```

*   **滑动窗口:** 保留最近 100 条消息原文，LLM 可以看到完整内容
*   **自动压缩:** 每累积 30 条新消息时，自动将最旧的消息压缩为一段摘要
*   **摘要拼接:** `compressed_summary` + 最近消息 = LLM 拿到的完整上下文
*   这样既保证了 LLM 能看到近期细节，又不会因为消息量增长导致 token 爆炸

### 3.2 PetGPT 接入方式

用户在 MCP 设置页面添加 stdio 类型的 Server：

```json
{
  "name": "QQ Agent",
  "transport": "stdio",
  "command": "uvx",
  "args": ["qq-agent-mcp", "--qq", "123456789", "--groups", "111222,333444", "--friends", "555666"]
}
```

PetGPT 启动该 MCP Server 后，AI 自动发现 `get_recent_context` / `send_message` / `check_status` 三个工具。只有 `--groups` 中指定的群和 `--friends` 中指定的好友会被监控。

---

## 4. 交互流程 (Interaction Flow)

1.  **启动:** 用户在 PetGPT 的 MCP 设置中添加并启动 `qq-agent-mcp` → MCP Server 自动拉起 NapCatQQ → 扫码登录。
2.  **监听:** NapCat 接收群消息 → 存入 MCP Server 内部缓冲区。
3.  **轮询:** PetGPT Agent 线程每隔 X 秒调用 `get_recent_context()` 获取上下文。
4.  **决策:** LLM 分析上下文 → 判断是否回复 → 如果 Yes，生成回复内容。
5.  **执行:** PetGPT 调用 `send_message()` → MCP Server 通过 OneBot API → NapCat 发送到 QQ 群。
6.  **反馈:** (可选) PetGPT 通知栏提示回复事件。

---

## 5. 关键约束 (Constraints)

*   **非阻塞:** Agent 模式绝不能卡顿主界面的 UI 或对话。
*   **防风控:** 必须控制轮询频率和回复频率，模拟人类操作间隔。
*   **安全性:** NapCat OneBot API 仅监听 localhost，不暴露公网端口。
*   **解耦:** PetGPT 侧零代码改动，所有 QQ 逻辑封装在独立 MCP Server 中。

---

## 6. 相关文档

*   **MCP Server 详细需求:** 见 [MCP-SERVER-SPEC.md](./MCP-SERVER-SPEC.md)
