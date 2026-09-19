import React, { createContext, useContext, useMemo, useReducer } from "react"
import { SLOW_FIELDS, FAST_FIELDS } from "./stateFields.js"

/**
 * 全局状态拆成三个 Context，而不是一个 `[state, dispatch]`。
 *
 * 原因是流式回复。`streamingReplies` 在 AI 生成时每帧都在变，而原来整个
 * state 和 dispatch 打包在一个 Provider 的 value 里 —— `useReducer` 每次
 * 都返回新数组，于是每次 dispatch 都换 value 引用，**所有** useContext 的
 * 消费者全部重渲染。这里面有 ChatboxBody(1900 行)、ChatboxInputBox(2900 行)、
 * ChatboxMessageArea(1190 行)，还有只想拿个 dispatch 的 App 和
 * ManagementPage(5080 行)。
 *
 * 注意 React.memo 对这条路径无效：memo 只比较 props，组件只要 useContext，
 * context value 一变就必定重渲染。ChatboxMessageArea 上那个 memo 之前就是
 * 这么被绕过去的。
 *
 * 拆开之后：
 *   DispatchContext  —— dispatch 恒定，只要 dispatch 的组件永不因状态变化重渲染
 *   StreamingContext —— 只有 streamingReplies，高频，订阅者应尽量靠近叶子
 *   StateContext     —— 其余状态，低频
 */

export const StateContext = createContext();
export const DispatchContext = createContext();
export const StreamingContext = createContext();

// 字段清单见 stateFields.js（纯数据，独立成文件以便测试直接 import）

export const StateProvider = ({ reducer, initialState, children }) => {
    const [state, dispatch] = useReducer(reducer, initialState);

    if (import.meta.env?.DEV) {
        const tracked = new Set([...SLOW_FIELDS, ...FAST_FIELDS]);
        const missing = Object.keys(state).filter((k) => !tracked.has(k));
        if (missing.length > 0) {
            console.error(
                '[StateProvider] 这些字段不在 SLOW_FIELDS 里，它们的更新不会传播到订阅者：',
                missing,
                '— 请加进 SLOW_FIELDS。',
            );
        }
    }

    // 依赖里刻意不含 streamingReplies：流式 token 刷新时这里返回的是上一次
    // 的同一个引用，订阅 StateContext 的组件因此不会被吵醒。
    //
    // 代价是这个引用上挂的 streamingReplies 是过期的 —— 所以流式内容一律从
    // StreamingContext 取，不要从这里读。
    //
    // eslint 会说这里缺 `state` 依赖。**不要照它说的加** —— 把 state 放进
    // 依赖数组就等于每次 dispatch 都换引用，这个 memo 也就白写了。
    // SLOW_FIELDS 是模块级常量，所以依赖数组长度在各次渲染间是稳定的。
    //
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const slowState = useMemo(() => state, SLOW_FIELDS.map((k) => state[k]));

    return (
        <DispatchContext.Provider value={dispatch}>
            <StateContext.Provider value={slowState}>
                <StreamingContext.Provider value={state.streamingReplies}>
                    {children}
                </StreamingContext.Provider>
            </StateContext.Provider>
        </DispatchContext.Provider>
    );
};

/**
 * 兼容原有写法 `const [state, dispatch] = useStateValue()`。
 *
 * 订阅的是低频的 StateContext，所以不会被流式刷新带着跑。需要流式内容的
 * 组件改用 `useStreamingReplies`。
 */
export const useStateValue = () => {
    const state = useContext(StateContext);
    const dispatch = useContext(DispatchContext);
    return useMemo(() => [state, dispatch], [state, dispatch]);
};

/** 只要 dispatch 时用这个 —— dispatch 引用恒定，组件不会因任何状态变化重渲染。 */
export const useDispatch = () => useContext(DispatchContext);

/** 流式回复表。高频变化，只在真正要显示流式文本的地方订阅。 */
export const useStreamingReplies = () => useContext(StreamingContext);
