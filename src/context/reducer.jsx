// import { getAllUsers, getAllAlbums, getAllSongs, getAllArtists } from "../api";

export const actionType = {

    SET_SUGGEST_TEXT:"SET_SUGGEST_TEXT",
    // Tab-based message management (方案 B)
    SET_TAB_MESSAGES: "SET_TAB_MESSAGES",       // 设置特定 tab 的消息
    ADD_TAB_MESSAGE: "ADD_TAB_MESSAGE",         // 添加消息到特定 tab
    UPDATE_TAB_MESSAGE: "UPDATE_TAB_MESSAGE",   // 更新特定 tab 的消息
    DELETE_TAB_MESSAGE: "DELETE_TAB_MESSAGE",   // 删除特定 tab 的消息
    CLEAR_TAB_MESSAGES: "CLEAR_TAB_MESSAGES",   // 清空特定 tab 的消息
    // Legacy (保留向后兼容，但内部会转发到 tab-based)
    ADD_MESSAGE: "ADD_MESSAGE",
    SET_MESSAGE: "SET_MESSAGE",
    UPDATE_MESSAGE: "UPDATE_MESSAGE",
    DELETE_MESSAGE: "DELETE_MESSAGE",
    CLEAR_MESSAGES: "CLEAR_MESSAGES",
    SET_CHARACTER_MOOD: "SET_CHARACTER_MOOD",
    ADD_STREAMING_REPLY: "ADD_STREAMING_REPLY",
    CLEAR_STREAMING_REPLY: "CLEAR_STREAMING_REPLY",
    SET_NAVBAR_CHAT:"SET_NAVBAR_CHAT",
    SET_CURRENT_CONVERSATION_ID: "SET_CURRENT_CONVERSATION_ID",
    SWITCH_CONVERSATION: "SWITCH_CONVERSATION",
    UPDATE_CONVERSATION_MESSAGES: "UPDATE_CONVERSATION_MESSAGES",
    TRIGGER_RUN_FROM_HERE: "TRIGGER_RUN_FROM_HERE",
    // MCP Tool Call Actions
    ADD_TOOL_CALL: "ADD_TOOL_CALL",
    UPDATE_TOOL_CALL: "UPDATE_TOOL_CALL",
    CLEAR_TOOL_CALLS: "CLEAR_TOOL_CALLS",
    // 时间注入管理
    UPDATE_TIME_INJECTION: "UPDATE_TIME_INJECTION",
    SET_API_PROVIDERS: "SET_API_PROVIDERS",
}

const reducer = (state, action) => {
    // console.log(action); // Disabled to reduce noise

    switch(action.type) {
        case actionType.SET_API_PROVIDERS:
            return {
                ...state,
                apiProviders: action.apiProviders,
            };
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
            console.log('[Reducer] SWITCH_CONVERSATION:', action.id);
            // 方案 B: 只更新 currentConversationId 和 tabMessages[id]
            return {
                ...state,
                currentConversationId: action.id,
                tabMessages: {
                    ...state.tabMessages,
                    [action.id]: action.userMessages || state.tabMessages[action.id] || []
                }
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
                suggestText: {
                    ...state.suggestText,
                    [action.conversationId]: action.suggestText
                }
            };
        // ============ Tab-based Message Management (方案 B) ============
        case actionType.SET_TAB_MESSAGES:
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [action.tabId]: action.messages || []
                }
            };
        case actionType.ADD_TAB_MESSAGE: {
            const tabId = action.tabId;
            const currentMessages = state.tabMessages[tabId] || [];
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: [...currentMessages, action.message]
                }
            };
        }
        case actionType.UPDATE_TAB_MESSAGE: {
            const tabId = action.tabId;
            const msgs = [...(state.tabMessages[tabId] || [])];
            if (action.index >= 0 && action.index < msgs.length) {
                msgs[action.index] = { ...msgs[action.index], ...action.message };
            }
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: msgs
                }
            };
        }
        case actionType.DELETE_TAB_MESSAGE: {
            const tabId = action.tabId;
            const filtered = (state.tabMessages[tabId] || []).filter((_, i) => i !== action.index);
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: filtered
                }
            };
        }
        case actionType.CLEAR_TAB_MESSAGES: {
            const tabId = action.tabId;
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: []
                }
            };
        }
        // ============ Legacy Actions (转发到 tab-based) ============
        case actionType.ADD_MESSAGE: {
            // 使用 currentConversationId 作为 tabId
            const tabId = state.currentConversationId;
            if (!tabId) {
                console.warn('[Reducer] ADD_MESSAGE without currentConversationId');
                return state;
            }
            const currentMessages = state.tabMessages[tabId] || [];
            console.log('[Reducer] ADD_MESSAGE to tab:', tabId, 'message:', action.message);
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: [...currentMessages, action.message]
                }
            };
        }
        case actionType.SET_MESSAGE: {
            // 使用 currentConversationId 或 action.tabId
            const tabId = action.tabId || state.currentConversationId;
            if (!tabId) {
                // 静默返回，不输出警告（初始化时这是正常的）
                return state;
            }
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: action.userMessages || []
                }
            };
        }
        case actionType.UPDATE_MESSAGE: {
            const tabId = action.tabId || state.currentConversationId;
            if (!tabId) return state;
            const msgs = [...(state.tabMessages[tabId] || [])];
            if (action.index >= 0 && action.index < msgs.length) {
                msgs[action.index] = { ...msgs[action.index], ...action.message };
            }
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: msgs
                }
            };
        }
        case actionType.DELETE_MESSAGE: {
            const tabId = action.tabId || state.currentConversationId;
            if (!tabId) return state;
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: (state.tabMessages[tabId] || []).filter((_, i) => i !== action.index)
                }
            };
        }
        case actionType.CLEAR_MESSAGES: {
            const tabId = action.tabId || state.currentConversationId;
            if (!tabId) return state;
            return {
                ...state,
                tabMessages: {
                    ...state.tabMessages,
                    [tabId]: []
                }
            };
        }

        case actionType.SET_CHARACTER_MOOD:
            return {
                ...state,
                characterMoods: {
                    ...state.characterMoods,
                    [action.conversationId || 'global']: action.characterMood
                }
            };
        case actionType.UPDATE_TIME_INJECTION:
            return {
                ...state,
                lastTimeInjection: {
                    ...state.lastTimeInjection,
                    [action.conversationId]: action.timestamp
                }
            };
        default :
        console.log(state);
                return state;
                
    }

    

};

export default reducer;