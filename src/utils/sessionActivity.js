/**
 * 会话活动状态的纯逻辑：把「PTY 最近什么时候有输出」翻译成 UI 的三态。
 *
 * 判定依据刻意选用「有没有输出」而不是去猜 agent 内部状态 —— 后者需要解析
 * 它的 TUI 或协议，既脆弱又要随 CLI 升级返工；而「有输出就是在跑」零成本、
 * 对任何 CLI 都成立。
 */

/** 多久没有输出就算从「运行中」回到「空闲」。 */
export const ACTIVITY_IDLE_MS = 900;

export const SESSION_STATE = Object.freeze({
  RUNNING: 'running',   // 正在输出，显示运动动画
  IDLE: 'idle',         // 进程活着但安静，显示静态点
  EXITED: 'exited',     // 进程已退出，显示灰圈
});

/**
 * @param session      { alive } PTY 会话
 * @param lastOutputAt 该会话最近一次输出的时间戳，没有则 0/undefined
 */
export const sessionStateOf = (session, lastOutputAt, now = Date.now(), idleMs = ACTIVITY_IDLE_MS) => {
  if (!session || session.alive === false) return SESSION_STATE.EXITED;
  const last = Number(lastOutputAt);
  if (!Number.isFinite(last) || last <= 0) return SESSION_STATE.IDLE;
  // 时钟回拨时 now < last，按「刚刚有输出」处理而不是判成空闲
  if (now < last) return SESSION_STATE.RUNNING;
  return now - last < idleMs ? SESSION_STATE.RUNNING : SESSION_STATE.IDLE;
};

/**
 * 从活动时间表算出当前「正在跑」的会话集合。
 *
 * 之所以返回集合而不是逐个判断：输出事件可能每秒几十次，直接把时间戳塞进
 * React state 会让整棵树疯狂重渲染。调用方应把时间戳记在 ref 里，定时用
 * 这个函数算出集合，只有集合真的变化时才 setState。
 */
export const runningSessionIds = (activity = {}, now = Date.now(), idleMs = ACTIVITY_IDLE_MS) => {
  const out = new Set();
  for (const [id, ts] of Object.entries(activity)) {
    const last = Number(ts);
    if (!Number.isFinite(last) || last <= 0) continue;
    if (now < last || now - last < idleMs) out.add(id);
  }
  return out;
};

/**
 * 用 `runningSessionIds` 算好的集合判定三态。
 *
 * 与 `sessionStateOf` 的区别是它不吃时间戳，所以调用方不需要为了刷新状态
 * 而持有一个每帧都在变的 `now` —— 那个 `now` 正是让整棵树每 400ms 重渲染
 * 一次的东西。集合只在真的有会话跨越运行/空闲边界时才换引用。
 */
export const sessionStateIn = (session, runningIds, sessionId) => {
  if (!session || session.alive === false) return SESSION_STATE.EXITED;
  return runningIds?.has(sessionId) ? SESSION_STATE.RUNNING : SESSION_STATE.IDLE;
};

/** 两个集合是否相同。用来决定要不要 setState。 */
export const sameIdSet = (left, right) => {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
};

/**
 * 把「活着的 PTY 会话」和「绑定记录」合成侧边栏要显示的**单一列表**。
 *
 * 刻意不分「活跃 / 历史」两段：同一个对话在两段里各出现一次，用户看到的是
 * 重复条目，分不清哪个才是它。这里以 agent 会话为身份（没认领到 id 的就用
 * PTY 会话 id 兜底），活着的记录覆盖已退出的同一条，所以一个对话永远只有
 * 一行 —— 位置不变，状态在跑/空闲/已退出之间切换。
 *
 * `shell` 不参与：纯终端没有可恢复的会话身份，它只在活着的时候出现。
 */
export const projectSessionList = ({
  liveSessions = [],
  bound = [],
  agentSessions = [],
} = {}) => {
  const knownAgentIds = new Set(
    agentSessions.map((record) => record?.agentId).filter(Boolean),
  );
  // 对话的第一句 prompt 作为标题，比一律显示 "Claude" 有信息量得多
  const promptByAgentId = new Map(
    agentSessions
      .filter((record) => record?.agentId && record.firstPrompt)
      .map((record) => [record.agentId, record.firstPrompt]),
  );
  const boundBySessionId = new Map();
  for (const entry of bound) {
    if (entry?.id) boundBySessionId.set(entry.id, entry);
  }

  // 身份键：优先用 agent 会话 id，这样「同一个对话」在被 resume 成新的 PTY
  // 会话之后仍然折叠成同一行，而不是又多出一条。
  const identity = (agentId, sessionId) => (agentId ? `agent:${agentId}` : `pty:${sessionId}`);
  const merged = new Map();

  const put = (row) => {
    const existing = merged.get(row.key);
    if (!existing) {
      merged.set(row.key, row);
      return;
    }
    // 活着的覆盖已退出的；都活着或都退了就留更近的那条
    if (row.alive && !existing.alive) merged.set(row.key, row);
    else if (row.alive === existing.alive && row.lastActiveAt > existing.lastActiveAt) {
      merged.set(row.key, row);
    }
  };

  for (const session of liveSessions) {
    if (!session?.id) continue;
    const entry = boundBySessionId.get(session.id);
    const agentId = entry?.agentId || null;
    put({
      key: identity(agentId, session.id),
      sessionId: session.id,
      agentId,
      kind: session.kind,
      // 优先级：用户改过的名字 > 第一句 prompt > 留空（界面退回 agent 名）
      title: entry?.title || (agentId ? promptByAgentId.get(agentId) : null) || null,
      alive: session.alive !== false,
      // 活着的会话即使还没认领到 id 也要显示 —— 它就在眼前跑着
      resumable: Boolean(agentId) && knownAgentIds.has(agentId),
      lastActiveAt: entry?.lastActiveAt ?? Date.now(),
    });
  }

  for (const entry of bound) {
    if (!entry?.id || entry.kind === 'shell') continue;
    // 没认领到 agent id 的已退出记录无从恢复，列出来只是个点不动的条目
    if (!entry.agentId) continue;
    put({
      key: identity(entry.agentId, entry.id),
      sessionId: entry.id,
      agentId: entry.agentId,
      kind: entry.kind,
      title: entry.title || promptByAgentId.get(entry.agentId) || null,
      alive: false,
      resumable: knownAgentIds.has(entry.agentId),
      lastActiveAt: entry.lastActiveAt ?? entry.createdAt ?? 0,
    });
  }

  return [...merged.values()].sort((a, b) => {
    // 活着的排在前面，其余按最近活动倒序
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
};

export default {
  ACTIVITY_IDLE_MS,
  SESSION_STATE,
  sessionStateOf,
  sessionStateIn,
  runningSessionIds,
  sameIdSet,
  projectSessionList,
};
