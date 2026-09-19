import React from 'react';
import { SESSION_STATE } from '../../utils/sessionActivity.js';

/**
 * 会话状态指示器。三态：
 *   running —— 三点呼吸动画，表示 agent 正在输出
 *   idle    —— 静态绿点，进程活着但安静
 *   exited  —— 灰色空心圈
 *
 * 动画用纯 CSS 的错相位 animate-pulse，不引入动画库。
 */
export default function SessionDot({ state, title }) {
  if (state === SESSION_STATE.RUNNING) {
    return (
      <span className="flex shrink-0 items-center gap-[2px]" title={title} role="status">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse"
            style={{ animationDelay: `${delay}ms`, animationDuration: '900ms' }}
          />
        ))}
      </span>
    );
  }
  if (state === SESSION_STATE.EXITED) {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full border border-gray-300"
        title={title}
      />
    );
  }
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title={title} />;
}
