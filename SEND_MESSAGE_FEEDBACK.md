# send_message 轮内反馈需求

## 背景

当前 social agent 的 LLM 工具循环中，`send_message` 成功后返回的结果仅包含 `{ success, message_ids, chunks }`。LLM 无法在同一轮循环内看到：

1. 自己的消息被 qq-mcp 切分后实际发了几条、每条内容是什么
2. 群友在 bot 发言后的实时反馈（如"够了别说了"）

这导致 LLM 可能连续调用多次 `send_message`，在群内造成刷屏。

## 需求

在 `send_message` 工具返回结果中，附带当前群的最近几条消息（包含 bot 自己的消息）。

### 返回格式示例

```json
{
  "success": true,
  "message_ids": ["137913905", "1424313551"],
  "chunks": 2,
  "recent_group_messages": [
    "[群友A] 你说的对",
    "[bot(你自己)] 熔断是电路保护，你脑子里只有动漫？",
    "[bot(你自己)] 看来你的算力也就够看个番了。",
    "[群友B] 哈哈哈笑死",
    "[群友C] 够了别说了"
  ]
}
```

### 关键要求

- `recent_group_messages` 中**包含 bot 自己的消息**，并明确标注为 `[bot(你自己)]`，让 LLM 看到切分后的实际效果
- 消息按时间顺序排列
- 拉取最近 5-8 条消息即可（`get_recent_context` limit=8）
- bot 自己的消息通过 `is_self` 字段识别

### 触发条件

- 仅在 `sendCount >= 2`（本轮已发送 2 条及以上）时附带，第一条回复不需要
- 或者 `chunks > 1`（消息被切分）时也附带

### 实现位置

在 `socialAgent.js` 的 `onToolResult` 回调中，当 `send_message` 成功后：

1. 异步调用 `executeToolByName(get_recent_context, { target, target_type, limit: 8 })`
2. 解析返回的消息列表
3. 格式化每条消息：`is_self` 的标为 `[bot(你自己)]`，其他标为 `[{sender_name}]`
4. 将 `recent_group_messages` 数组拼接到原始工具返回结果中

### 注意事项

- `get_recent_context` 调用会增加约 100-500ms 延迟，可接受
- 可选：在拉取前加 1s sleep，让群友有时间回复
- 不需要新增暴露给 LLM 的工具，改动仅在 `onToolResult` 内部
