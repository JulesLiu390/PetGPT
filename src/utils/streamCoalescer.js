/**
 * 把逐 token 的流式回调压成「按帧一次」的更新。
 *
 * 为什么需要：LLM 的 onChunk 是一个 token 调一次，50–100 次/秒。而每次
 * dispatch 都会让全局 reducer 返回新 state，Context 的 value 换新引用，
 * 于是每个 useStateValue 的消费者（ChatboxBody、ChatboxInputBox、
 * ChatboxMessageArea 都是几千行的组件）整棵重渲染一遍，消息列表里每条消息
 * 还要重新过一次 markdown 和语法高亮。比屏幕刷新率更密的更新是纯浪费 ——
 * 画面一帧只能显示一次。
 *
 * 用 rAF 而不是定时器，是为了对齐真实的渲染时机。窗口被隐藏时 rAF 不触发，
 * 内容会攒在 pending 里 —— 这是想要的行为：后台对话不需要逐帧刷新，等窗口
 * 回来或者流结束时一次性补上即可，一个字都不会丢（见 `flush`）。
 */

const hasRaf = typeof requestAnimationFrame === 'function';
const defaultSchedule = hasRaf ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
const defaultCancel = hasRaf ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h);

/**
 * @param onFlush  合并后的文本回调，每帧最多调一次
 * @param options  `schedule` / `cancel` 可注入，测试用同步调度器替换
 */
export const createStreamCoalescer = (onFlush, options = {}) => {
  const schedule = options.schedule || defaultSchedule;
  const cancel = options.cancel || defaultCancel;

  let pending = '';
  // rAF 的 id 从 1 开始，不会与 null 混淆
  let handle = null;

  const emit = () => {
    handle = null;
    if (!pending) return;
    const batch = pending;
    // 先清空再回调：onFlush 里如果又 push（重入），新内容应该进下一批而不是
    // 被这一批的清空动作吞掉
    pending = '';
    onFlush(batch);
  };

  return {
    push(delta) {
      if (typeof delta !== 'string' || delta === '') return;
      pending += delta;
      if (handle === null) handle = schedule(emit);
    },

    /**
     * 立刻冲掉尾巴。重复调用是安全的。
     */
    flush() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      emit();
    },

    /**
     * 丢掉还没发出去的内容，并取消已排队的帧。
     *
     * 流式文本只是生成过程中的临时显示，收尾时会被 CLEAR_STREAMING_REPLY
     * 整个清掉、换成完整的最终消息。所以收尾路径要的是 discard 而不是
     * flush：清除之后再冒出一帧延迟的追加，屏幕上会留下一段本该消失的残影。
     */
    discard() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      pending = '';
    },

    /** 仅供测试与诊断 */
    get pendingLength() {
      return pending.length;
    },
  };
};

export default { createStreamCoalescer };
