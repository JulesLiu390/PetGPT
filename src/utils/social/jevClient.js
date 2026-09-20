/**
 * TypeSafe Jev 的共享传输层。
 *
 * 消息打标（moodTag）和群气压计（barometer）都用它。两者的**问题集**完全不同，
 * 但发请求、超时、错误处理、以及"必须绕开 CORS"这件事是一样的。
 *
 * ⚠️ 应用里不能用前端 fetch：TypeSafe 网关有 origin 白名单，webview 发出的
 * 带 Authorization 的请求会触发 CORS 预检，预检返回
 * `400 Disallowed CORS origin`（响应里没有 access-control-allow-origin），
 * 于是 fetch 在几百毫秒内直接失败。Node 不做 CORS，所以沙盒里跑得通——
 * 这个差异坑过一次，日志里表现为"0/5 条（248ms，5 次失败）"。
 *
 * API 契约见 https://docs.typesafe.ai/api.md
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';

/**
 * 用原生 fetch 发一次。**只给 Node 侧的沙盒和测试用**，理由见文件头。
 */
export const makeFetchRequest = (fetchImpl, endpoint = JEV_ENDPOINT) =>
  async ({ apiKey, model, state, questions, timeoutMs }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model, questions }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`Jev HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  };

/** 应用里的默认通道：走 Rust 的 reqwest，不受同源策略约束。 */
async function tauriRequest({ apiKey, model, state, questions }) {
  const tauri = await import('../tauri.js');
  return tauri.moodTagProxyCall(JEV_ENDPOINT, apiKey, { state, model, questions });
}

export const resolveJevRequest = (opts = {}) => {
  if (typeof opts.request === 'function') return opts.request;
  if (typeof opts.fetchImpl === 'function') return makeFetchRequest(opts.fetchImpl, opts.endpoint);
  return tauriRequest;
};

/**
 * 问一次。失败一律返回 null —— Jev 是增强，不是依赖，绝不能让它拖垮主流程。
 *
 * @returns answers 对象，或 null
 */
export async function askJev(state, questions, opts = {}) {
  const { apiKey, model = JEV_DEFAULT_MODEL, timeoutMs = 1000, onError = null } = opts;
  if (!state || !apiKey || !questions) return null;
  try {
    const body = await resolveJevRequest(opts)({ apiKey, model, state, questions, timeoutMs });
    return body?.answers || null;
  } catch (e) {
    onError?.(e);
    return null;
  }
}

// ── 响应解析的共用小工具 ──

/**
 * 从 choice 答案里取值，并按白名单校验。
 *
 * Jev 结构上给不出 schema 外的值，但 API 异常、或者我们自己把 criteria 的 key
 * 和渲染映射写岔了，都会走到这里。这些值最终要插进 prompt 的可信区，必须过一道。
 */
export function pickChoice(answer, labels) {
  const raw = typeof answer?.choice === 'string' ? answer.choice.trim() : '';
  return Object.prototype.hasOwnProperty.call(labels, raw) ? raw : null;
}

/**
 * 把 score 答案落到刻度桶。
 *
 * Jev 的 score 是 criteria 索引上的浮点（N 档 → [0, N-1]），同时还给了各档的
 * probabilities。优先取概率最大的那一档——那才是模型真正的判断；score 只是
 * 期望值，在双峰分布下会落到一个两边都不像的中间位置。
 * 没有 probabilities 时退回对 score 取最近邻。
 */
export function bucketScore(answer, levels) {
  const probs = answer?.probabilities;
  if (probs && typeof probs === 'object') {
    let best = null;
    let bestP = -1;
    for (const [k, v] of Object.entries(probs)) {
      const idx = Number(k);
      const p = Number(v);
      if (!Number.isInteger(idx) || !Number.isFinite(p)) continue;
      if (p > bestP) { bestP = p; best = idx; }
    }
    if (best !== null) return Math.max(0, Math.min(levels - 1, best));
  }
  const raw = Number(answer?.score);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(levels - 1, Math.round(raw)));
}
