// import { getAllUsers, getAllAlbums, getAllSongs, getAllArtists } from "../api";

export const actionType = {

    SET_USER_TEXT:"SET_USER_TEXT",
    ADD_MESSAGE: "ADD_MESSAGE",         // 添加新消息
    CLEAR_MESSAGES: "CLEAR_MESSAGES",   // 清空消息
    SET_CHARACTER_MOOD: "SET_CHARACTER_MOOD",
}

const reducer = (state, action) => {
    console.log(action);

    switch(action.type) {
        case actionType.SET_USER_TEXT:
            return {
                ...state,
                userText : action.userText,
            };
        case actionType.ADD_MESSAGE:
            return {
                ...state,
                userMessages: [...state.userMessages, action.message], // 👈 推入新项
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