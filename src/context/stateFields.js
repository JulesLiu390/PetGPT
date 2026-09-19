/**
 * 全局状态字段该走哪个 Context。
 *
 * 单独成文件（而不是留在 StateProvider.jsx）有两个原因：一是它是纯数据，
 * 二是测试要 import 它 —— node 的测试运行器不认 `.jsx`。
 *
 * 背景见 StateProvider：`streamingReplies` 在 AI 回复时每帧都变，必须与
 * 其余状态分开，否则每个 token 都会把所有 useContext 的消费者重渲染一遍。
 */

/**
 * 进入 StateContext 的字段，同时也是 slowState 那个 memo 的依赖来源。
 *
 * 要覆盖 reducer 写过的**所有**顶层字段，不只是 initialState 里的。
 * `runFromHereTimestamp` 就只在 reducer 出现 —— 漏掉它不会报错，只会让
 * 「从这里重跑」读到过期时间戳然后静默失灵。
 *
 * 加新的全局状态时必须同步到这里。两道防线会在漏掉时提醒：
 *   - StateProvider 里的开发期断言（覆盖运行时动态出现的字段）
 *   - context/__tests__/stateFields.test.mjs（覆盖 initialState）
 */
export const SLOW_FIELDS = [
  'suggestText',
  'navBarChats',
  'characterMoods',
  'tabMessages',
  'currentConversationId',
  'updatedConversation',
  'liveToolCalls',
  'lastTimeInjection',
  'apiProviders',
  'searchHighlight',
  'runFromHereTimestamp',
];

/** 不进 slowState 的字段：它们有自己的高频 Context。 */
export const FAST_FIELDS = ['streamingReplies'];

export default { SLOW_FIELDS, FAST_FIELDS };
