export const initialState = {
    suggestText: {}, // { conversationId: [] } 按会话管理建议回复
    navBarChats: [],
    characterMoods: {}, // { conversationId: mood } 按会话管理表情状态
    tabMessages: {}, // { conversationId: Message[] } 按 tab 管理消息，替代全局 userMessages
    streamingReplies: {}, // 用于保存流式传输生成的部分回复，key 为 conversationId
    currentConversationId: null,
    updatedConversation: null, // 用于通知特定会话更新 { id, messages }
    liveToolCalls: {}, // { conversationId: [{ id, toolName, args, status, result, error }] }
    // 时间注入管理：记录每个会话上次注入时间的时间戳
    // { conversationId: timestamp }
    lastTimeInjection: {},
    apiProviders: [], // 全局可用 API 服务商列表
}