// import { getAllUsers, getAllAlbums, getAllSongs, getAllArtists } from "../api";

export const actionType = {

    SET_SUGGEST_TEXT:"SET_SUGGEST_TEXT",
    ADD_MESSAGE: "ADD_MESSAGE",         // 添加新消息
    SET_MESSAGE: "SET_MESSAGE",
    UPDATE_MESSAGE: "UPDATE_MESSAGE",   // 更新特定消息
    DELETE_MESSAGE: "DELETE_MESSAGE",   // 删除特定消息
    CLEAR_MESSAGES: "CLEAR_MESSAGES",   // 清空消息
    SET_CHARACTER_MOOD: "SET_CHARACTER_MOOD",
    ADD_STREAMING_REPLY: "ADD_STREAMING_REPLY",
    CLEAR_STREAMING_REPLY: "CLEAR_STREAMING_REPLY",
    SET_NAVBAR_CHAT:"SET_NAVBAR_CHAT",
    SET_CURRENT_CONVERSATION_ID: "SET_CURRENT_CONVERSATION_ID",
    SWITCH_CONVERSATION: "SWITCH_CONVERSATION",
    UPDATE_CONVERSATION_MESSAGES: "UPDATE_CONVERSATION_MESSAGES",
    TRIGGER_RUN_FROM_HERE: "TRIGGER_RUN_FROM_HERE", // New action
    // MCP Tool Call Actions
    ADD_TOOL_CALL: "ADD_TOOL_CALL",           // 添加工具调用
    UPDATE_TOOL_CALL: "UPDATE_TOOL_CALL",     // 更新工具调用状态
    CLEAR_TOOL_CALLS: "CLEAR_TOOL_CALLS",     // 清除工具调用
}

const reducer = (state, action) => {
    console.log(action);

    switch(action.type) {
        case actionType.TRIGGER_RUN_FROM_HERE:
            return {
                ...state,
                runFromHereTimestamp: Date.now(),
            };
        case actionType.UPDATE_CONVERSATION_MESSAGES:
            return {
                ...state,
                updatedConversation: {
                    id: action.id,
                    messages: action.messages,
                    title: action.title, // Include title in the update
                    timestamp: Date.now() // Ensure change detection
                }
            };
        case actionType.SWITCH_CONVERSATION:
            return {
                ...state,
                userMessages: action.userMessages,
                currentConversationId: action.id,
            };
        case actionType.SET_CURRENT_CONVERSATION_ID:
            return {
                ...state,
                currentConversationId: action.id,
            };
        case actionType.SET_NAVBAR_CHAT:
            return {
              ...state,
              navBarChats: action.navBarChats,
            };
        case actionType.ADD_STREAMING_REPLY:
            return {
              ...state,
              streamingReplies: {
                ...state.streamingReplies,
                [action.id]: (state.streamingReplies[action.id] || "") + action.content
              }
            };
          case actionType.CLEAR_STREAMING_REPLY:
            const newStreamingReplies = { ...state.streamingReplies };
            delete newStreamingReplies[action.id];
            return {
              ...state,
              streamingReplies: newStreamingReplies,
            };
        // MCP Tool Call cases
        case actionType.ADD_TOOL_CALL: {
            const toolCall = action.toolCall;
            return {
              ...state,
              liveToolCalls: {
                ...state.liveToolCalls,
                [action.conversationId]: [
                  ...(state.liveToolCalls?.[action.conversationId] || []),
                  {
                    id: toolCall.id,
                    toolName: toolCall.toolName,
                    args: toolCall.args,
                    status: toolCall.status || 'running',
                    startTime: toolCall.startTime || Date.now()
                  }
                ]
              }
            };
        }
        case actionType.UPDATE_TOOL_CALL: {
            const convCalls = state.liveToolCalls?.[action.conversationId] || [];
            const updatedCalls = convCalls.map((tc) => {
              // Match by id or by toolName (fallback for calls without specific id match)
              if (tc.id === action.toolCallId || 
                  (action.toolCallId && action.toolCallId.startsWith(tc.toolName))) {
                return {
                  ...tc,
                  ...action.updates,
                  duration: action.updates.endTime ? action.updates.endTime - tc.startTime : tc.duration
                };
              }
              return tc;
            });
            return {
              ...state,
              liveToolCalls: {
                ...state.liveToolCalls,
                [action.conversationId]: updatedCalls
              }
            };
        }
        case actionType.CLEAR_TOOL_CALLS: {
            const newLiveToolCalls = { ...state.liveToolCalls };
            delete newLiveToolCalls[action.conversationId];
            return {
              ...state,
              liveToolCalls: newLiveToolCalls,
            };
        }
        case actionType.SET_SUGGEST_TEXT:
            return {
                ...state,
                suggestText : action.suggestText,
            };
        case actionType.ADD_MESSAGE:
            return {
                ...state,
                userMessages: [...state.userMessages, action.message], // 👈 推入新项
            };
        case actionType.SET_MESSAGE:
            return {
                ...state,
                userMessages: action.userMessages,
            };

        case actionType.UPDATE_MESSAGE:
            const updatedMessages = [...state.userMessages];
            if (action.index >= 0 && action.index < updatedMessages.length) {
                updatedMessages[action.index] = {
                    ...updatedMessages[action.index],
                    ...action.message
                };
            }
            return {
                ...state,
                userMessages: updatedMessages,
            };

        case actionType.DELETE_MESSAGE:
            return {
                ...state,
                userMessages: state.userMessages.filter((_, i) => i !== action.index),
            };

        case actionType.CLEAR_MESSAGES:
            return {
                ...state,
                userMessages: [], // 👈 清空数组
            };

        case actionType.SET_CHARACTER_MOOD:
            return {
                ...state,
                characterMoods: {
                    ...state.characterMoods,
                    [action.conversationId || 'global']: action.characterMood
                }
            };
        default :
        console.log(state);
                return state;
                
    }

    

};

export default reducer;