// import { getAllUsers, getAllAlbums, getAllSongs, getAllArtists } from "../api";

export const actionType = {

    SET_SUGGEST_TEXT:"SET_SUGGEST_TEXT",
    ADD_MESSAGE: "ADD_MESSAGE",         // 添加新消息
    SET_MESSAGE: "SET_MESSAGE",
    CLEAR_MESSAGES: "CLEAR_MESSAGES",   // 清空消息
    SET_CHARACTER_MOOD: "SET_CHARACTER_MOOD",
    ADD_STREAMING_REPLY: "ADD_STREAMING_REPLY",
    CLEAR_STREAMING_REPLY: "CLEAR_STREAMING_REPLY",
    SET_NAVBAR_CHAT:"SET_NAVBAR_CHAT",
    SET_CURRENT_CONVERSATION_ID: "SET_CURRENT_CONVERSATION_ID",
    SWITCH_CONVERSATION: "SWITCH_CONVERSATION",
    UPDATE_CONVERSATION_MESSAGES: "UPDATE_CONVERSATION_MESSAGES",
}

const reducer = (state, action) => {
    console.log(action);

    switch(action.type) {
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

        case actionType.CLEAR_MESSAGES:
            return {
                ...state,
                userMessages: [], // 👈 清空数组
            };

        case actionType.SET_CHARACTER_MOOD:
            return {
                ...state,
                characterMood: action.characterMood, // 👈 清空数组
            };
        default :
        console.log(state);
                return state;
                
    }

    

};

export default reducer;