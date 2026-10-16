/**
 * 开、挂视频通话。同一时间只有一通，所有操作排成一队依次执行，都可以重复调：
 *
 * - start：这个会话已经在通话（或排在前面的操作会接通它）就返回那一通，不重来；
 *   别的会话在通话，先挂掉那一通再接。
 * - stop(targetId)：只挂这个会话上的那通，不在通话就什么都不做。
 *   stop()：一通都不留，前端已经不认得的（比如页面刷新前开的）也让 Rust 挂掉。
 * - 每通电话只收一次尾：不管是这里挂的、用户在通话窗口里挂的，还是 Rust 那边自己结束的。
 * - Rust 的事件都带 callId，不是当前这通的（上一通迟到的结束、识别结果）一律丢掉。
 */
import type { CallError, CallEvents, CallInfo, CallTranscript, StartCallRequest } from './voiceCallApi.ts';

/** 一通电话在会话那边的落脚点。开始时给，这通电话的事件和收尾都交给它。 */
export interface CallBinding {
  /** 接通了：会话这边进入通话 */
  begin(call: CallInfo): void;
  /** 挂断了：会话这边恢复平时的规则。每通电话只调一次。 */
  end(call: CallInfo): void;
  /** 这通电话里识别出一句话 */
  hear(call: CallInfo, transcript: CallTranscript): void;
  /** 这通电话的采集、识别、播放出了错 */
  error?(call: CallInfo, error: CallError): void;
}

/** Rust 那边：命令和事件（见 voiceCallApi）。 */
export interface CallBackend {
  start(request: StartCallRequest): Promise<CallInfo>;
  stop(callId?: number): Promise<void>;
  listen<E extends keyof CallEvents>(name: E, handler: (payload: CallEvents[E]) => void): Promise<() => void>;
}

export interface VoiceCallController {
  start(request: StartCallRequest, binding: CallBinding): Promise<CallInfo>;
  stop(targetId?: string): Promise<void>;
  /** 当前这通（接通之后才有） */
  current(): CallInfo | null;
  /** 开始、结束时回调当前这通（没有就是 null）。返回取消订阅。 */
  onChange(callback: (call: CallInfo | null) => void): () => void;
}

type CallEvent =
  | { kind: 'ended'; callId: number }
  | { kind: 'transcript'; callId: number; transcript: CallTranscript }
  | { kind: 'error'; callId: number; error: CallError };

/** 接通的那一小会儿里到的事件最多存这么多 */
const EARLY_EVENT_LIMIT = 64;

export function createVoiceCallController(backend: CallBackend): VoiceCallController {
  let active: { info: CallInfo; binding: CallBinding } | null = null;
  /** 正在接通：还不知道新通话的 callId，这时到的事件先存着，接通后挑出这一通的补上 */
  let early: CallEvent[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let listening: Promise<void> | null = null;
  const listeners = new Set<(call: CallInfo | null) => void>();

  const notify = () => {
    for (const callback of listeners) {
      try { callback(active?.info ?? null); } catch { /* UI 回调失败不影响通话 */ }
    }
  };

  /** 本地收尾。先清掉 active 再通知会话，之后同一通的任何收尾都认不出它了。 */
  const finish = (callId: number) => {
    if (!active || active.info.callId !== callId) return;
    const { info, binding } = active;
    active = null;
    try {
      binding.end(info);
    } finally {
      notify();
    }
  };

  const apply = (event: CallEvent) => {
    if (!active || active.info.callId !== event.callId) return;
    const { info, binding } = active;
    if (event.kind === 'ended') finish(event.callId);
    else if (event.kind === 'transcript') binding.hear(info, event.transcript);
    else binding.error?.(info, event.error);
  };

  const dispatch = (event: CallEvent) => {
    if (!early) {
      apply(event);
    } else if (early.length < EARLY_EVENT_LIMIT) {
      early.push(event);
    }
  };

  /** 事件只订一次，整个页面的生命周期里都在。订阅失败的话下次开始时重试。 */
  const ensureListening = () => {
    listening ??= (async () => {
      const results = await Promise.allSettled([
        backend.listen('voice-call-ended', ({ callId }) => dispatch({ kind: 'ended', callId })),
        backend.listen('voice-call-transcript', (transcript) => dispatch({ kind: 'transcript', callId: transcript.callId, transcript })),
        backend.listen('voice-call-error', (error) => dispatch({ kind: 'error', callId: error.callId, error })),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (!failed) return;
      // 不留半套：重试时会重新订，留着的那几个会让同一个事件处理两遍
      for (const result of results) if (result.status === 'fulfilled') result.value();
      listening = null;
      throw failed.reason;
    })();
    return listening;
  };

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation);
    queue = run.catch(() => {});
    return run;
  };

  return {
    start(request, binding) {
      return serial(async () => {
        if (active && active.info.petId === request.petId && active.info.targetId === request.targetId) {
          return active.info;
        }
        await ensureListening();
        if (active) {
          // 换会话：先把这一通收尾。Rust 那边开新通话时会自己挂掉旧的，这里挂失败也不拦着
          const { callId } = active.info;
          finish(callId);
          await backend.stop(callId).catch(() => {});
        }
        early = [];
        let info: CallInfo;
        try {
          info = await backend.start(request);
        } catch (error) {
          early = null;
          throw error;
        }
        const buffered = early ?? [];
        early = null;
        active = { info, binding };
        try {
          binding.begin(info);
        } catch (error) {
          // 会话那边进不了通话，这通电话就没人管了，不能留着
          active = null;
          await backend.stop(info.callId).catch(() => {});
          throw error;
        }
        notify();
        for (const event of buffered) apply(event);
        return info;
      });
    },

    stop(targetId) {
      return serial(async () => {
        if (active) {
          if (targetId && active.info.targetId !== targetId) return;
          const { callId } = active.info;
          finish(callId);
          await backend.stop(callId);
          return;
        }
        if (!targetId) await backend.stop();
      });
    },

    current: () => active?.info ?? null,

    onChange(callback) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
}
