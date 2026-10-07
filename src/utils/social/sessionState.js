/**
 * Session / Turn / Window —— 社交 agent 的上下文状态机。
 *
 * 取代原先的 Intent loop + Reply loop 双层结构。层次照搬 Codex：
 *
 *   Session  一个 target 从 chatbot 启动到停止的整段对话。append-only 的 history。
 *   Turn     一次「新消息到达 → 不再有新消息可注入」的处理过程。
 *            一个 turn 内可以有多次 LLM 迭代、多次工具调用、多条发送。
 *
 *            终止**只有一个条件**：模型不再做事，且没有新消息可注入。
 *            没有轮数上限、没有条数上限、没有时间上限——和 Codex 一致
 *            （它的 turn 循环也只看"模型还调不调工具"，全仓库找不到任何
 *            max_turns / max_iterations / turn 超时）。
 *            积压过多时注入提醒，但提醒就只是提醒，不切断。
 *   Window   两次压缩之间的 turn 区间。压缩时封窗、换 id、留一份摘要。
 *
 * 这里只有纯状态，不碰 IO、不碰 LLM——好测，也好在别处复用。
 * 跨重启不持久化：session 边界就是进程边界。
 */

/**
 * 积压多少条未回应的消息时提醒模型收个尾。
 *
 * **这是提醒，不是上限。** 照搬 Codex 的做法：它的 turn 没有任何迭代上限、
 * 时间上限或 token 上限（`session/turn.rs` 的循环只在模型不再调工具时退出），
 * 只有一个 `reminder_threshold_tokens` —— 余量低于阈值就注入一句提醒，
 * 让模型自己决定何时收尾。系统只在真溢出时才介入。
 *
 * 计的是"**上次发消息以来**积压了多少条"，不是整个 turn 的累计。
 * 累计会惩罚健康的多轮交互：回一句 → 来消息 → 再回一句本来就是正常对话，
 * 不该被一个只增不减的计数器掐断。清零后它的含义才是"我欠了多少没回应"。
 */
export const BACKLOG_REMINDER_AT = 20;

/** turn_note 的档位标签。沿用原 write_intent_plan 的 brief 五档。 */
export const TURN_REGISTERS = ['接梗', '闲扯', '观点', '展开', '深答'];

/** 没有发言的 turn 记这个档位——沉默也是一种结果，要进 history。 */
export const REGISTER_SILENT = '沉默';

const newId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
};

/**
 * 新建一个 session。windowIds 一开始就有一个元素——当前窗口。
 */
export function createSession({ targetId, targetType, now = Date.now() } = {}) {
  const windowId = newId();
  return {
    sessionId: newId(),
    targetId,
    targetType,
    startedAt: now,
    /** append-only。每项带 turnId / windowId，压缩时按 windowId 切。 */
    history: [],
    /** 压缩链，末位永远是当前窗口。 */
    windowIds: [windowId],
    /** windowId → 该窗口的压缩摘要。只有被封的窗口才有。 */
    summaries: new Map(),
    turnSeq: 0,
    currentTurn: null,
    /** 静态材料被外部（Observer）改动后置位，下个 turn 开头做增量追加。 */
    materialsDirty: false,
  };
}

/** 当前窗口 id。 */
export function currentWindowId(session) {
  return session.windowIds[session.windowIds.length - 1];
}

/**
 * 开一个 turn。同一时刻一个 session 只能有一个活跃 turn——串行是这次重构的前提。
 */
export function beginTurn(session, { now = Date.now(), trigger = 'newmsg' } = {}) {
  if (session.currentTurn && !session.currentTurn.ended) {
    throw new Error(`session ${session.sessionId} 已有活跃 turn，不能并发开启`);
  }
  session.turnSeq += 1;
  const turn = {
    turnId: newId(),
    seq: session.turnSeq,
    windowId: currentWindowId(session),
    startedAt: now,
    endedAt: null,
    trigger,
    injections: 0,
    /** 全 turn 累计折入多少条，只用于遥测。 */
    injectedMessages: 0,
    /** 上次发消息以来积压了多少条未回应的。发送后清零——这才是"欠了多少"。 */
    backlog: 0,
    backlogReminded: false,
    sends: 0,
    toolCalls: 0,
    ended: false,
    note: null,
  };
  session.currentTurn = turn;
  return turn;
}

/**
 * 还能不能再注入新消息。
 *
 * 这是 turn 的核心边界判定：LLM 不再调工具、准备收尾时问一次。
 * 有新消息且没到上限就追加一条 user 消息继续跑，否则结束 turn。
 */
export function canInject(turn, newMessageCount) {
  if (!turn || turn.ended) return false;
  return !!newMessageCount && newMessageCount > 0;
}

/**
 * 该不该提醒模型"你欠了一堆没回应"。一次积压只提醒一次，发过消息后重新计。
 */
export function shouldRemindBacklog(turn) {
  return !!turn && !turn.backlogReminded && turn.backlog >= BACKLOG_REMINDER_AT;
}

export function markBacklogReminded(turn) {
  if (turn) turn.backlogReminded = true;
}

export function recordInjection(turn, messageCount = 1) {
  const n = Math.max(0, messageCount);
  turn.injections += 1;
  turn.injectedMessages += n;
  turn.backlog += n;
  return turn.injections;
}

/**
 * 记一次成功发送。
 *
 * **没有任何限流。** 运行时的三道闸（60 秒 3 条滑动窗口、开口前强制
 * check_new_messages、同一张表情 60 秒冷却）都已按要求移除——发多少、发多快
 * 完全交给模型自己把握，prompt 里讲清楚就行。这里只留计数：turn.sends 供
 * turn_note 和遥测用，backlog 清零是"上次发消息以来"这个语义的一部分。
 */
export function recordSend(session, turn) {
  if (!turn) return;
  turn.sends += 1;
  turn.backlog = 0;
  turn.backlogReminded = false;
}

/**
 * 往 history 追加一项。自动打上当前 turn / window 标记。
 *
 * item: { role, content, kind?, toolName?, toolCallId? }
 *   kind: 'message' | 'tool_call' | 'tool_result' | 'injection' | 'note'
 */
export function appendHistory(session, item) {
  const entry = {
    id: newId(),
    at: item.at ?? Date.now(),
    turnId: session.currentTurn?.turnId ?? null,
    windowId: currentWindowId(session),
    kind: item.kind || 'message',
    ...item,
  };
  session.history.push(entry);
  return entry;
}

/**
 * 收尾。note 由 turn_note 工具产出；没调就按有没有发过消息兜底。
 */
export function endTurn(session, turn, { now = Date.now(), note = null } = {}) {
  if (!turn || turn.ended) return turn;
  turn.ended = true;
  turn.endedAt = now;
  turn.note = note || {
    register: turn.sends > 0 ? null : REGISTER_SILENT,
    summary: turn.sends > 0 ? `发送 ${turn.sends} 条` : '未发言',
    inferred: true,
  };
  if (session.currentTurn === turn) session.currentTurn = null;
  return turn;
}

/**
 * 封当前窗口、开新窗口。压缩时调用。
 * summary 写在被封的窗口名下，后续请求用它代替该窗口的原始 history。
 */
export function sealWindow(session, summary) {
  const sealed = currentWindowId(session);
  session.summaries.set(sealed, summary);
  session.windowIds.push(newId());
  return { sealedWindowId: sealed, newWindowId: currentWindowId(session) };
}

/** 某个窗口是否已被压缩封存。 */
export function isWindowSealed(session, windowId) {
  return session.summaries.has(windowId);
}

/**
 * 组装要发给模型的 history：已封窗口的原始条目全部换成一块摘要，未封窗口原样保留。
 *
 * 摘要是滚动的——每次压缩都把「上一份摘要 + 这段 live 条目」一起总结成新的一份，
 * 所以只需要发最后一份。保留整条 summaries 链只是为了排查和日志。
 *
 * 返回的是 history 条目（未转成 provider 格式）——转换在调用方做，
 * 因为 Gemini / OpenAI / Anthropic 对连续同 role 的容忍度不同。
 */
export function buildRequestItems(session) {
  const latestSealed = [...session.windowIds]
    .reverse()
    .find(id => session.summaries.has(id));

  const out = [];
  if (latestSealed) {
    out.push({
      id: `summary-${latestSealed}`,
      kind: 'summary',
      role: 'user',
      windowId: latestSealed,
      content: session.summaries.get(latestSealed),
    });
  }
  for (const entry of session.history) {
    if (session.summaries.has(entry.windowId)) continue;
    out.push(entry);
  }
  return out;
}

/** 最近一份滚动摘要（没压缩过则为 null）。压缩时要把它喂给下一次总结。 */
export function latestSummary(session) {
  const latestSealed = [...session.windowIds]
    .reverse()
    .find(id => session.summaries.has(id));
  return latestSealed ? session.summaries.get(latestSealed) : null;
}

/** 某个 turn 的全部 history 条目。lessons review / 调试用。 */
export function itemsOfTurn(session, turnId) {
  return session.history.filter(e => e.turnId === turnId);
}

export function sessionStats(session) {
  const sealedCount = session.summaries.size;
  return {
    sessionId: session.sessionId,
    turns: session.turnSeq,
    historyItems: session.history.length,
    windows: session.windowIds.length,
    sealedWindows: sealedCount,
    liveItems: session.history.filter(e => !session.summaries.has(e.windowId)).length,
  };
}
