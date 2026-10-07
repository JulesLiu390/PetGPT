/**
 * 保活：别让宿主 webview 被 macOS 挂起。
 *
 * ── 症状 ──
 * social agent 的每一层（Fetcher、Session 循环、Observer、看门狗自己）都是
 * setTimeout 驱动的，而 WKWebView 的 WebContent 是独立进程。系统一旦判定这个
 * 页面"没活动"，整个进程会被挂起——所有定时器同时停摆，同时复活。
 *
 * 2026-09-20 一晚实测（19:33→00:51，5h17m）断了 6 次：
 *
 *   20:30:09 → 20:38:56   8.8 分
 *   20:39:01 → 20:48:48   9.8 分
 *   22:02:22 → 22:13:57  11.6 分
 *   23:00:19 → 23:01:39   1.3 分
 *   00:05:34 → 00:10:55   5.3 分
 *   00:23:59 → 00:30:54   6.9 分
 *
 * 累计 43 分 45 秒，占运行时长 13.8%。每次都是最后一个 MCP 调用**正常返回**、
 * 然后什么都不发生、几分钟后自己活过来。日志里没有任何错误，因为根本没有代码
 * 在跑。恢复后看门狗第一个醒来，一算墙上时钟就误报"停滞 9 分钟，判定卡死"。
 *
 * ── 对策 ──
 * 让这个 webview 一直"在出声"。WebKit 给正在播放音频的页面保持前台断言，
 * 进程就不会被挂起。
 *
 * 用 Web Audio 而不是 <audio> 元素，两个原因：
 *   · <audio> 会注册进系统的 Now Playing，键盘上的播放/暂停键会被 PetGPT 抢走
 *   · AudioContext 不进 Now Playing，也没有媒体元素那一套加载/缓冲生命周期
 *
 * 增益取 1e-4（−80 dBFS）而不是 0：WebKit 判"有没有在出声"看的是实际输出，
 * 归零有被判成静音、进而不给断言的风险。−80 dBFS 在任何硬件上都听不见。
 *
 * ⚠️ 代价：系统的 idle 休眠会被阻止（`pmset -g assertions` 里能看到 WebCore
 * 的条目）。所以只在 agent 真正跑起来之后才开，stopSocialLoop 第一时间关掉。
 */

/** 振荡器频率（Hz）。次低频，配上极小增益，任何设备上都不可闻。 */
export const KEEP_AWAKE_FREQ_HZ = 30;

/** 输出增益。**非零是关键**，见文件头。−80 dBFS。 */
export const KEEP_AWAKE_GAIN = 0.0001;

/** 采样率。越低音频线程唤醒越少；硬件不认就退回默认值。 */
export const KEEP_AWAKE_SAMPLE_RATE = 8000;

/** 自动播放被拦时，用这些事件等一次用户交互再重试。 */
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'];

let ctx = null;          // AudioContext
let nodes = null;        // { osc, gain }
let wanted = false;      // 期望状态：true = 应该在响
let blocked = false;     // 曾被自动播放策略拦过，用于只在恢复时打一条日志
let gestureCleanup = null;
let logFn = null;

const log = (level, message, detail = null) => {
  try { logFn?.(level, message, detail); } catch { /* 日志不该拖垮保活 */ }
};

/**
 * 默认 AudioContext 工厂。拿不到构造器（Node、老 webview）就返回 null，
 * 由调用方降级——保活失败不该让 agent 起不来。
 */
const defaultAudioContextFactory = (options) => {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor(options);
  } catch {
    // 自定义 sampleRate 不被支持时退回硬件默认值，但尽量保住 latencyHint
    try { return new Ctor({ latencyHint: options?.latencyHint }); } catch { /* 再退一步 */ }
    try { return new Ctor(); } catch { return null; }
  }
};

const gestureTarget = () => {
  const t = globalThis.document || globalThis;
  return typeof t?.addEventListener === 'function' ? t : null;
};

function unbindGesture() {
  const cleanup = gestureCleanup;
  gestureCleanup = null;
  try { cleanup?.(); } catch { /* 解绑失败无所谓，监听器是 once */ }
}

function bindGesture() {
  if (gestureCleanup) return;
  const target = gestureTarget();
  if (!target) return;
  const once = () => { unbindGesture(); ensureRunning(); };
  for (const ev of GESTURE_EVENTS) {
    target.addEventListener(ev, once, { once: true, capture: true });
  }
  gestureCleanup = () => {
    for (const ev of GESTURE_EVENTS) {
      target.removeEventListener(ev, once, { capture: true });
    }
  };
}

/**
 * 把 context 推到 running。已经在跑就什么都不做。
 *
 * wry 默认把 mediaTypesRequiringUserActionForPlayback 设成 None，所以这里
 * 基本不会撞上自动播放策略；真撞上了就挂一次性手势监听，等用户点一下再试。
 */
async function ensureRunning() {
  if (!ctx) return false;
  if (ctx.state === 'running') {
    unbindGesture();
    if (blocked) {
      blocked = false;
      log('info', '🔊 webview 保活已恢复');
    }
    return true;
  }
  try { await ctx.resume(); } catch { /* 下面按 state 兜底 */ }
  if (!ctx) return false;                  // resume 期间被 stop 掉了
  if (ctx.state === 'running') {
    unbindGesture();
    if (blocked) {
      blocked = false;
      log('info', '🔊 webview 保活已恢复');
    }
    return true;
  }
  if (!blocked) {
    blocked = true;
    log('warn', `🔇 webview 保活被挡住（AudioContext 处于 ${ctx.state}），等一次用户交互后重试`);
  }
  bindGesture();
  return false;
}

function teardown() {
  const c = ctx;
  const n = nodes;
  ctx = null;
  nodes = null;
  blocked = false;
  if (c) c.onstatechange = null;
  try { n?.osc?.stop?.(); } catch { /* 没 start 过或已停 */ }
  try { n?.osc?.disconnect?.(); } catch { /* ignore */ }
  try { n?.gain?.disconnect?.(); } catch { /* ignore */ }
  try {
    const p = c?.close?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* 关不掉就算了 */ });
  } catch { /* ignore */ }
}

/**
 * 开始保活。幂等——已经在跑就只确认一下状态。
 *
 * @param opts.audioContextFactory 测试注入用
 * @param opts.onLog (level, message, detail) => void
 * @returns 见 keepAwakeStatus()
 */
export async function startKeepAwake({
  audioContextFactory = defaultAudioContextFactory,
  onLog = null,
} = {}) {
  logFn = onLog;
  wanted = true;

  if (ctx) {
    await ensureRunning();
    return keepAwakeStatus();
  }

  const created = audioContextFactory({
    sampleRate: KEEP_AWAKE_SAMPLE_RATE,
    latencyHint: 'playback',
  });
  if (!created) {
    log('warn', '🔇 这个环境没有 Web Audio，webview 保活未启用——长时间无人说话时 agent 可能被系统挂起');
    return keepAwakeStatus();
  }
  ctx = created;

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = KEEP_AWAKE_FREQ_HZ;
    gain.gain.value = KEEP_AWAKE_GAIN;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    nodes = { osc, gain };
  } catch (e) {
    log('warn', `🔇 webview 保活建图失败：${e?.message || e}`);
    teardown();
    return keepAwakeStatus();
  }

  // 系统可能因为来电、切换音频设备等原因把 context 打断，掉了就自己爬起来
  ctx.onstatechange = () => {
    if (wanted && ctx && ctx.state !== 'running') ensureRunning();
  };

  await ensureRunning();
  return keepAwakeStatus();
}

/** 停止保活并释放 AudioContext。幂等。 */
export function stopKeepAwake() {
  wanted = false;
  unbindGesture();
  teardown();
}

/** 当前状态。state 取 AudioContext 的 state，没有 context 时是 'closed'。 */
export function keepAwakeStatus() {
  return {
    wanted,
    present: !!ctx,
    state: ctx ? ctx.state : 'closed',
    running: !!ctx && ctx.state === 'running',
  };
}
