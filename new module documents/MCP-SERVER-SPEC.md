# qq-agent-mcp — MCP Server 需求规格

> **独立项目**，作为 PetGPT 的外部 MCP Server 运行。
> PetGPT 通过标准 MCP 协议 (stdio) 连接，**零侵入**。

---

## 1. 项目概览

### 1.1 定位

一个 Python 编写的 **MCP Server**，内部封装 NapCatQQ 无头客户端，对外通过 stdio 暴露标准 MCP Tools。任何支持 MCP 的 AI 客户端（包括但不限于 PetGPT）都可以接入。

### 1.2 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| MCP 框架 | `mcp` (Python SDK) | 官方 SDK，stdio 传输开箱即用 |
| QQ 协议 | NapCatQQ | 基于 NTQQ 的无头客户端，OneBot v11 接口 |
| HTTP 客户端 | `aiohttp` | 异步调用 NapCat 的 OneBot API |
| 消息缓冲 | `collections.deque` + 可选 SQLite | 内存优先，可选持久化 |
| 进程管理 | `asyncio.create_subprocess_exec` | 管理 NapCat 子进程生命周期 |
| 包管理 | `uv` / `pip` | 支持 `uvx qq-agent-mcp` 一键运行 |

### 1.3 项目结构

```
qq-agent-mcp/
├── pyproject.toml
├── README.md
├── LICENSE
├── src/
│   └── qq_agent_mcp/
│       ├── __init__.py
│       ├── __main__.py         # uvx / python -m 入口
│       ├── server.py           # MCP Server 主逻辑
│       ├── napcat.py           # NapCat 进程管理
│       ├── onebot.py           # OneBot v11 API 客户端
│       ├── context.py          # 消息缓冲区 & 上下文组装
│       ├── tools.py            # MCP Tools 定义
│       └── config.py           # 配置 & CLI 参数
└── napcat/                     # NapCat 运行时（或 Docker 配置）
    └── README.md
```

---

## 2. 启动与配置

### 2.1 启动方式

```bash
# 方式 1: uvx (推荐，发布到 PyPI 后)
uvx qq-agent-mcp --qq 123456789

# 方式 2: pip 安装后运行
pip install qq-agent-mcp
python -m qq_agent_mcp --qq 123456789

# 方式 3: 开发模式
cd qq-agent-mcp
uv run python -m qq_agent_mcp --qq 123456789
```

### 2.2 CLI 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--qq` | 是 | — | QQ 号码 |
| `--napcat-path` | 否 | 内置路径 | NapCat 可执行文件路径 |
| `--napcat-port` | 否 | `3000` | NapCat OneBot HTTP 端口 |
| `--ws-port` | 否 | `3001` | NapCat WebSocket 端口（用于接收推送） |
| `--groups` | 否 | 全部 | 监控的群号列表，逗号分隔。未指定则监控所有群 |
| `--friends` | 否 | 无 | 允许私聊的 QQ 号白名单，逗号分隔。未指定则不监控私聊 |
| `--buffer-size` | 否 | `100` | 每个群/私聊的消息缓冲条数（滑动窗口） |
| `--compress-every` | 否 | `30` | 每累积 N 条新消息时，自动压缩旧消息为摘要 |
| `--log-level` | 否 | `info` | 日志级别 |

### 2.3 PetGPT 侧配置

在 PetGPT MCP 设置中添加：

```json
{
  "name": "QQ Agent",
  "transport": "stdio",
  "command": "uvx",
  "args": ["qq-agent-mcp", "--qq", "123456789", "--groups", "111222,333444", "--friends", "555666,777888"]
}
```

---

## 3. MCP Tools 定义

### 3.1 `get_recent_context`

获取指定**已监控**群聊或**白名单**私聊的最近消息上下文。

**参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | string | 是 | 群号或私聊 QQ 号（必须在白名单中） |
| `target_type` | string | 否 | `"group"`（默认）或 `"private"` |
| `limit` | integer | 否 | 返回最近消息条数，默认 `20`，最大 `50` |

**返回（群聊）:**

```json
{
  "target": "123456",
  "target_type": "group",
  "group_name": "技术交流群",
  "compressed_summary": "【历史摘要】讨论了 Tauri 2 的性能优化，张三分享了benchmark结果...",
  "message_count": 20,
  "messages": [
    {
      "sender_id": "111222",
      "sender_name": "张三",
      "content": "有人用过 Tauri 吗？",
      "timestamp": "2026-02-15T14:30:00+08:00",
      "message_id": "msg_001"
    }
  ],
  "has_at_me": true,
  "at_me_messages": ["msg_003"]
}
```

**返回（私聊）:**

```json
{
  "target": "555666",
  "target_type": "private",
  "friend_name": "李四",
  "compressed_summary": "之前聊了关于PetGPT新功能的想法...",
  "message_count": 10,
  "messages": [
    {
      "sender_id": "555666",
      "sender_name": "李四",
      "content": "最近那个QQ Agent做得怎么样了？",
      "timestamp": "2026-02-15T15:00:00+08:00",
      "message_id": "msg_101"
    }
  ],
  "has_at_me": false,
  "at_me_messages": []
}
```

> **`compressed_summary`**: 滑动窗口之外的旧消息被自动压缩后的摘要（详见 §4.3）。首次启动或消息不足时为 `null`。

### 3.2 `send_message`

向指定**已监控**群聊或**白名单**私聊发送消息。

**参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | string | 是 | 群号或私聊 QQ 号（必须在白名单中） |
| `target_type` | string | 否 | `"group"`（默认）或 `"private"` |
| `content` | string | 是 | 消息内容（纯文本） |
| `reply_to` | string | 否 | 要回复的消息 ID（引用回复） |

**返回:**

```json
{
  "success": true,
  "message_id": "msg_sent_001",
  "target": "123456",
  "timestamp": "2026-02-15T14:31:00+08:00"
}
```

### 3.3 `check_status`

检查 QQ 登录状态和 NapCat 运行状态。

**参数:** 无

**返回:**

```json
{
  "napcat_running": true,
  "qq_logged_in": true,
  "qq_account": "123456789",
  "qq_nickname": "Glitch",
  "online_status": "online",
  "uptime_seconds": 3600,
  "monitored_groups": [
    { "group_id": "123456", "group_name": "技术交流群", "member_count": 150 }
  ],
  "monitored_friends": [
    { "user_id": "555666", "nickname": "李四" }
  ],
  "total_groups": 12,
  "buffer_stats": {
    "total_messages_buffered": 342,
    "groups_tracked": 5,
    "friends_tracked": 2
  }
}
```

### 3.4 `get_group_list`

获取已加入的群列表。

**参数:** 无

**返回:**

```json
{
  "groups": [
    { "group_id": "123456", "group_name": "技术交流群", "member_count": 150 },
    { "group_id": "789012", "group_name": "摸鱼乐园", "member_count": 42 }
  ]
}
```

---

## 4. 内部模块设计

### 4.1 napcat.py — NapCat 进程管理

**职责:** 管理 NapCat 子进程的完整生命周期。

| 功能 | 说明 |
|------|------|
| `start()` | MCP Server 启动时拉起 NapCat 子进程 |
| `stop()` | MCP Server 退出时发送 SIGTERM，超时后 SIGKILL |
| `health_check()` | 定期检测 NapCat 是否存活，崩溃则自动重启 |
| `wait_ready()` | 启动后轮询 OneBot `/get_login_info` 直到可用 |

**关键约束:**
*   使用 `asyncio.create_subprocess_exec` 启动，非阻塞
*   注册 `atexit` 和信号处理器，确保 MCP Server 被杀时 NapCat 也被清理
*   NapCat 的 stdout/stderr 重定向到日志

### 4.2 onebot.py — OneBot v11 API 客户端

**职责:** 封装 NapCat 的 OneBot v11 HTTP API。

| 方法 | OneBot API | 说明 |
|------|-----------|------|
| `get_login_info()` | `/get_login_info` | 获取登录账号信息 |
| `get_group_list()` | `/get_group_list` | 获取群列表 |
| `get_group_msg_history()` | `/get_group_msg_history` | 拉取群历史消息 |
| `send_group_msg()` | `/send_group_msg` | 发送群消息 |
| `send_private_msg()` | `/send_private_msg` | 发送私聊消息 |

**关键约束:**
*   所有调用通过 `aiohttp.ClientSession`，target = `http://localhost:{napcat_port}`
*   统一错误处理：NapCat 返回 `retcode != 0` 时抛出明确异常
*   请求超时默认 10 秒

### 4.3 context.py — 消息缓冲 & 上下文组装

**职责:** 维护每个已监控群和白名单私聊的**滑动窗口 + 压缩摘要**，为 `get_recent_context` 提供数据。

**数据流:**

```
NapCat WebSocket 推送
  → 解析 OneBot 事件
  → 群消息：检查是否属于已监控群 (--groups 白名单)
  → 私聊消息：检查是否属于白名单好友 (--friends 白名单)
  → 过滤无效消息
  → 存入对应的滑动窗口 deque
  → 每 N 条新消息触发自动压缩
```

**白名单过滤:**
*   启动时加载 `--groups` 和 `--friends` 参数，分别解析为白名单 `Set[str]`
*   `--groups` 未指定 → 监控所有已加入的群
*   `--friends` 未指定 → **不监控任何私聊**（默认关闭私聊）
*   非白名单的群消息和私聊消息直接丢弃，不进入缓冲区
*   `send_message` / `get_recent_context` 会校验 target + target_type 是否在对应白名单中

**消息过滤规则:**
*   丢弃：系统消息、自己发的消息、撤回事件、入群通知
*   保留：普通文本、图片描述、@消息、回复引用

**滑动窗口 + 压缩策略:**

```
┌─────────────────────────────────────────────────┐
│              compressed_summary                 │  ← 旧消息压缩后的文本摘要
│  "讨论了 Tauri 性能，张三分享了 benchmark..."     │
├─────────────────────────────────────────────────┤
│              messages (滑动窗口)                  │  ← 最近 N 条原始消息
│  msg_081, msg_082, ... msg_100                  │
└─────────────────────────────────────────────────┘
```

*   每个群/私聊维护一个 `deque(maxlen=buffer_size)` 作为滑动窗口，默认保留最近 100 条
*   每累积 `compress_every`（默认 30）条新消息时，**自动触发压缩**：
    1. 将当前窗口中最旧的 N 条消息提取出来
    2. 用一次简短的 LLM 调用（或规则摘要）将它们压缩为一段文本摘要
    3. 将摘要追加到该群的 `compressed_summary` 字段
    4. 被压缩的消息从窗口中移除
*   `get_recent_context` 返回时，`compressed_summary` + `messages` 共同组成完整上下文
*   `compressed_summary` 本身也有长度上限（默认 2000 字符），超出时截断最旧的摘要段落

**消息格式标准化为:** `{ sender_id, sender_name, content, timestamp, message_id }`

### 4.4 server.py — MCP Server 入口

**职责:** 注册 Tools，编排启动/关闭流程。

**启动顺序:**

```
__main__.py 解析 CLI 参数
  → server.py 初始化 MCP Server (stdio)
    → napcat.py 启动 NapCat 子进程
      → napcat.wait_ready() 等待 OneBot API 可用
    → context.py 启动 WebSocket 监听
    → 注册 MCP Tools
    → 进入 MCP 事件循环
```

**关闭顺序:**

```
收到 EOF / SIGTERM / SIGINT
  → 停止 WebSocket 监听
  → napcat.stop() 关闭 NapCat
  → 退出
```

---

## 5. 决策模式：合一调用

QQ Agent 的「是否回复」判断 **不是独立步骤**，而是与回复生成合并为 **单轮 LLM 调用**：

```
PetGPT Agent 线程定时触发
  → 调用 get_recent_context() 获取最近群聊消息
  → 将消息 + System Prompt（含决策规则）发给 LLM
  → LLM 自行决定：
     ├─ 需要回复 → 调用 send_message() 工具 → MCP 执行发送 → 结束
     └─ 不需要回复 → 返回空文本，不调用任何工具 → 结束
```

**性能：1 次 LLM 往返（1-5 秒），无前置判断调用。**

### 5.1 为什么不分两步

| 方案 | LLM 调用次数 | 延迟 | 问题 |
|------|-------------|------|------|
| ❌ 先判断再生成 | 2 次 | 2-10s | 浪费一次 API 调用，增加延迟和成本 |
| ✅ 合一调用 | 1 次 | 1-5s | LLM 直接看上下文 → 决定是否调用 `send_message` |

合一调用利用了 PetGPT 已有的 MCP 工具执行循环（`callLLMStreamWithTools` 的 while 循环）：
- LLM 流式输出时如果产生 `send_message` tool_call → 本地执行 → 结束
- LLM 流式输出但不产生任何 tool_call → 直接返回 → 结束（宠物选择潜水）

### 5.2 System Prompt 中的决策规则示例

```
你正在监控一个 QQ 群。根据以下规则决定是否回复：

1. **必须回复：** 有人 @你 或直接提到你的名字
2. **可以回复：** 话题与你擅长/感兴趣的领域相关，且你有有价值的内容可以贡献
3. **保持沉默：** 与你无关的闲聊、看不懂的内容、纯表情包

如果你决定回复，使用 send_message 工具发送消息。
如果你决定沉默，直接说"[skip]"即可，不要调用任何工具。
```

---

## 6. 安全约束

| 约束 | 实现 |
|------|------|
| NapCat 仅 localhost | OneBot HTTP/WS 绑定 `127.0.0.1`，不暴露公网 |
| 发送频率限制 | `send_message` 内置 rate limiter，默认最快 3 秒/条 |
| 不泄露 QQ 密码 | NapCat 使用扫码登录，MCP Server 不接触凭据 |
| 进程隔离 | NapCat 作为子进程运行，崩溃不影响 MCP Server |

---

## 7. 非功能需求

| 指标 | 要求 |
|------|------|
| 启动时间 | NapCat 就绪 < 30 秒（不含扫码） |
| `get_recent_context` 延迟 | < 50ms（内存读取） |
| `send_message` 延迟 | < 2s（含 NapCat 发送） |
| 内存占用 | MCP Server 本体 < 50MB（不含 NapCat） |
| 崩溃恢复 | NapCat 崩溃后 10 秒内自动重启 |

---

## 8. 实现阶段

### Phase 1: 骨架 & 基础连通

*   [ ] 项目脚手架（pyproject.toml, `__main__.py`）
*   [ ] MCP Server stdio 骨架（`mcp` SDK）
*   [ ] NapCat 子进程管理（启动/停止/健康检查）
*   [ ] `check_status` Tool

### Phase 2: 消息流

*   [ ] OneBot HTTP 客户端封装
*   [ ] WebSocket 消息监听 & 推送解析
*   [ ] 消息缓冲区（`deque`）
*   [ ] `get_recent_context` Tool

### Phase 3: 发送 & 完善

*   [ ] `send_message` Tool（含 rate limiter）
*   [ ] `get_group_list` Tool
*   [ ] 引用回复支持
*   [ ] 错误处理 & 日志完善

### Phase 4: 发布

*   [ ] PyPI 打包 & `uvx` 支持
*   [ ] README 文档
*   [ ] PetGPT 接入测试（端到端验证）
