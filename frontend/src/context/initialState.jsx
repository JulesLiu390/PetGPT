export const initialState = {
    suggestText: [],
    navBarChats: [],
    characterMoods: {}, // { conversationId: mood } 按会话管理表情状态
    userMessages: [],
    streamingReplies: {}, // 用于保存流式传输生成的部分回复，key 为 conversationId
    currentConversationId: null,
    updatedConversation: null, // 用于通知特定会话更新 { id, messages }
    liveToolCalls: {}, // { conversationId: [{ id, toolName, args, status, result, error }] }
}