import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import * as tauri from '../../utils/tauri';

/**
 * 拖动停止多久之后才把新尺寸下发给 PTY。
 *
 * 只影响 SIGWINCH 的下发节奏，不影响本地 xterm 的视觉跟手。取值要短到松手
 * 时察觉不出延迟，又长到能盖住一次连续拖动。
 */
const PTY_RESIZE_DEBOUNCE_MS = 120;

/**
 * 把 `--petgpt-mono` 解析成真实的字体栈。
 *
 * 不能把 `var(--petgpt-mono, …)` 原样交给 xterm：这个值有两个去处，一个是
 * 元素的 style.fontFamily（CSS，var 有效），另一个是 canvas 的 ctx.font ——
 * WebGL 渲染器要用它把字形光栅化进纹理图集，而 canvas 的 font 不认 CSS
 * 变量，赋值会被整条丢掉、退回默认的 10px sans-serif。结果是字宽按等宽
 * 字体测、字形按 sans-serif 画，每个字符后面拖一片空隙。
 */
const resolveMonoFontStack = () => {
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue('--petgpt-mono')
    .trim();
  // 变量取不到时给一个自带 CJK 等宽回退的栈：xterm 按字符数算列宽，
  // 中文落到非等宽字体上整个终端的列对齐都会崩
  return declared || 'ui-monospace, SFMono-Regular, Menlo, "PingFang SC", monospace';
};

/**
 * 挂上 WebGL 渲染器，失败时静默退回 xterm 自带的 DOM 渲染器。
 *
 * DOM 渲染器每帧都要重建可见行的 span，agent 的 TUI 刷屏时这既是主线程上
 * 最大的一笔开销，也会喂给全局的 i18n MutationObserver 成批的变更记录。
 *
 * 退回是必须留的：WebGL 上下文拿不到（软件渲染、上下文数量超限）时构造
 * 就会抛，而终端能用远比它画得快重要。上下文丢失时同样要退回 —— 丢了不
 * 处理的话屏幕会直接停在最后一帧。
 */
const attachWebglRenderer = (term) => {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      try { addon.dispose(); } catch { /* 已经没了，DOM 渲染器会接手 */ }
    });
    term.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
};

/**
 * 一个 PTY 会话的 xterm 视图。
 *
 * 两个刻意的设计：
 *
 * 1. `hidden` 时用 CSS 隐藏而不是卸载组件。小标签切走再切回来，滚动缓冲和
 *    PTY 尺寸都必须原样保留 —— 卸载会丢掉 xterm 实例里的历史，而重建之后
 *    的 fit() 又会触发一次 SIGWINCH，正在跑的 TUI 会重排闪烁。
 *
 * 2. resize 只在可见时下发。隐藏的面板宽度为 0，若照样 fit() 会把 PTY
 *    压到最小列数，切回来时 agent 的输出已经按错误宽度折行了。
 *
 * 3. 挂载时先回放 Rust 侧的输出快照。关掉 project 标签会 dispose xterm，
 *    但进程还在跑 —— 重开时新建的 xterm 是空的，而 agent 的 TUI 正在做
 *    基于旧屏幕状态的局部重绘，直接接上去屏幕就花了。回放期间到达的实时
 *    输出先排队，按 seq 去重后再补写，既不漏也不重。
 */
function TerminalPane({ session, hidden, onExit }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const sessionIdRef = useRef(session?.id);
  // 快照回放完成前，实时输出先排队
  const pendingRef = useRef([]);
  const replayedRef = useRef(false);

  sessionIdRef.current = session?.id;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !session?.id) return undefined;

    const term = new Terminal({
      fontFamily: resolveMonoFontStack(),
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      // 实测每个终端的缓冲开销：5000 行 × 200 列约 12MB，10000 行约 24MB。
      // 刻意选大的：agent 的一次长任务输出很容易冲掉几千行，能往回翻到开头
      // 比省这几十 MB 有价值。Rust 侧另有 512KB 的快照缓冲，那个管的是重新
      // 附着时的屏幕状态，与这里的滚动历史是两回事。
      scrollback: 10000,
      allowProposedApi: true,
      // 终端必须画不透明底：窗口本身是半透明加毛玻璃的，
      // 文字压在上面可读性会明显下降。
      theme: {
        background: '#1b1b1f',
        foreground: '#e6e4e0',
        cursor: '#e6e4e0',
        selectionBackground: '#3a3a42',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // WebGL 只能在 open() 之后挂：它要拿终端已经建好的那个 canvas 层
    const webgl = attachWebglRenderer(term);
    termRef.current = term;
    fitRef.current = fit;

    const keyDisposable = term.onData((data) => {
      const id = sessionIdRef.current;
      if (id) tauri.ptyWrite(id, data).catch(() => {});
    });

    return () => {
      keyDisposable.dispose();
      // 先收渲染器再 dispose 终端，反过来会在已经拆掉的 canvas 上收尾
      try { webgl?.dispose(); } catch { /* 上下文丢失时已经自己 dispose 过 */ }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [session?.id]);

  // PTY 输出 → xterm
  useEffect(() => {
    if (!session?.id) return undefined;
    const unlisten = tauri.onPtyOutput((payload) => {
      if (payload?.sessionId !== session.id) return;
      if (!replayedRef.current) {
        pendingRef.current.push({ seq: payload.seq ?? 0, data: payload.data ?? '' });
        return;
      }
      termRef.current?.write(payload.data ?? '');
    });
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, [session?.id]);

  // 挂载后回放快照，再补写回放期间排队的实时输出
  useEffect(() => {
    if (!session?.id) return undefined;
    let cancelled = false;
    pendingRef.current = [];
    replayedRef.current = false;

    tauri.ptySnapshot(session.id)
      .then((snapshot) => {
        if (cancelled) return;
        const term = termRef.current;
        if (!term) return;
        if (snapshot?.data) term.write(snapshot.data);
        const upTo = Number(snapshot?.seq ?? 0);
        // 快照里已经含 seq <= upTo 的输出，只补写更新的那些
        for (const chunk of pendingRef.current) {
          if (chunk.seq > upTo) term.write(chunk.data);
        }
      })
      .catch(() => {
        // 拿不到快照就直接进实时模式，至少不丢新输出
      })
      .finally(() => {
        if (cancelled) return;
        pendingRef.current = [];
        replayedRef.current = true;
      });

    return () => { cancelled = true; };
  }, [session?.id]);

  // 进程退出 → 提示 + 通知外层灭掉存活点
  useEffect(() => {
    if (!session?.id) return undefined;
    const unlisten = tauri.onPtyExit((payload) => {
      if (payload?.sessionId !== session.id) return;
      const code = payload.exitCode;
      termRef.current?.write(`\r\n\x1b[90m[process exited${code == null ? '' : ` with code ${code}`}]\x1b[0m\r\n`);
      onExit?.(session.id, code);
    });
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, [session?.id, onExit]);

  // 尺寸同步。隐藏时跳过，避免把 PTY 压成 0 宽。
  useEffect(() => {
    if (hidden || !session?.id) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;

    // 本地 fit 每次都做，终端才跟得上拖动；但下发给 PTY 的尺寸要防抖。
    //
    // 每帧 ptyResize 意味着每帧给子进程发一次 SIGWINCH，而 claude/codex 这类
    // TUI 收到就会重排并重绘整屏 —— 拖一次窗口能逼它重绘上百次，卡的是
    // agent 进程那边，前端再快也没用。停手之后再发一次最终尺寸就够了。
    let resizeTimer = null;
    const pushSizeToPty = (cols, rows) => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        tauri.ptyResize(session.id, cols, rows).catch(() => {});
      }, PTY_RESIZE_DEBOUNCE_MS);
    };

    const applyFit = () => {
      const fit = fitRef.current;
      const term = termRef.current;
      if (!fit || !term) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try { fit.fit(); } catch { return; }
      pushSizeToPty(term.cols, term.rows);
    };

    // 切回可见的第一帧布局还没稳定，等一帧再量
    const raf = requestAnimationFrame(applyFit);
    const observer = new ResizeObserver(applyFit);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      // 卸载时把挂起的那次尺寸补发出去：正好在防抖窗口内切走标签的话，
      // PTY 会停在拖动前的旧尺寸上，切回来就是错的折行。
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
        const term = termRef.current;
        if (term) tauri.ptyResize(session.id, term.cols, term.rows).catch(() => {});
      }
    };
  }, [hidden, session?.id]);

  // 切回可见时把焦点交还给终端
  useEffect(() => {
    if (!hidden) termRef.current?.focus();
  }, [hidden]);

  return (
    <div
      className={`${hidden ? 'invisible absolute inset-0 pointer-events-none' : 'relative'} h-full w-full overflow-hidden bg-[#1b1b1f]`}
      data-i18n-ignore
    >
      <div ref={hostRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}

/**
 * 比较 session 的字段而不是它的引用：宿主是用对象字面量传进来的，每次
 * 重渲染都是一个新对象，按引用比的话 memo 等于没加。
 *
 * 终端的内容不走 React —— xterm 自己持有 DOM，输出是 effect 里 write 进去的，
 * 所以这里挡掉的重渲染不会让屏幕落后于 PTY。
 */
export default React.memo(TerminalPane, (prev, next) => (
  prev.session?.id === next.session?.id
  && prev.session?.kind === next.session?.kind
  && prev.session?.alive === next.session?.alive
  && prev.hidden === next.hidden
  && prev.onExit === next.onExit
));
