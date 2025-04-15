// import { getAllUsers, getAllAlbums, getAllSongs, getAllArtists } from "../api";

export const actionType = {

    SET_SUGGEST_TEXT:"SET_SUGGEST_TEXT",
    ADD_MESSAGE: "ADD_MESSAGE",         // 添加新消息
    SET_MESSAGE: "SET_MESSAGE",
    CLEAR_MESSAGES: "CLEAR_MESSAGES",   // 清空消息
    SET_CHARACTER_MOOD: "SET_CHARACTER_MOOD",
    ADD_STREAMING_REPLY: "ADD_STREAMING_REPLY",
    CLEAR_STREAMING_REPLY: "CLEAR_STREAMING_REPLY",
}

const reducer = (state, action) => {
    console.log(action);

    switch(action.type) {
        case actionType.ADD_STREAMING_REPLY:
            return {
              ...state,
              streamingReply: (state.streamingReply || "") + action.content,
            };
          case actionType.CLEAR_STREAMING_REPLY:
            return {
              ...state,
              streamingReply: "",
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