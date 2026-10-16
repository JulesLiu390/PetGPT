/**
 * 会话这边的一通视频通话：收进来的话、正在进行的那次回答、要念的句子。
 *
 * 整个通话是会话里的一个 turn（见 socialAgent 的 runSessionTurn）。识别出的话不走缓冲区
 * 和时间游标，排在这里等那一轮来取；宠物的话边生成边切句，按顺序合成、交给这通电话播放。
 *
 * 操作都可以重复：同一句话收两次只算一次，结束同一次回答两次、挂断两次都只生效一次；
 * 挂断之后收到的话、要念的句子都直接丢掉。
 */
import { createSentenceSplitter, createSpeechQueue, type SentenceSplitter } from './speechStream.ts';
import { formatCallTiming, voiceCallMessage, type CallOwner, type CallTiming, type VoiceCallMessage } from './voiceCall.ts';
import type { CallInfo, CallTranscript } from './voiceCallApi.ts';

/** 通话里的一次回答，也就是一次模型请求。 */
export interface CallRequest {
  readonly controller: AbortController;
  /** 已经有话交去合成了：之后失败不重试，主人再开口也不打断 */
  spoke: boolean;
  /** 被主人新说的一句顶掉了 */
  stale: boolean;
  readonly startedAt: number;
  firstTextAt: number | null;
  firstSentenceAt: number | null;
  firstAudioAt: number | null;
  /** 这次回答针对的那句话的计时 */
  readonly timing: CallTiming | null;
}

/** 收进来、还没写进会话的一句话。 */
export interface CallInput {
  msg: VoiceCallMessage;
  transcript: CallTranscript;
  receivedAt: number;
}

export interface CallSessionOptions {
  owner?: CallOwner;
  /** 合成一句，返回 base64 音频；返回 null 表示这句不用念 */
  synthesize: (sentence: string) => Promise<string | null>;
  /** 交给这通电话播放 */
  deliver: (audio: string, sentence: string) => Promise<void>;
  onSpeechError?: (error: unknown, sentence: string) => void;
  /** 一次回答的第一句开始播放：从主人说完到出声各段的耗时 */
  onTiming?: (timing: string) => void;
  now?: () => number;
}

export interface CallSession {
  readonly info: CallInfo;
  readonly startedAt: number;
  readonly closed: boolean;
  /** 手上正在进行的那次回答 */
  readonly request: CallRequest | null;
  /**
   * 收一句识别结果，返回做好的消息；这句收过了、是别的通话的、没有字、已经挂断都返回 null。
   * 主人又开口了而宠物还没出声：手上那次回答过时了，作废它，带上新的这句重来。
   */
  hear(transcript: CallTranscript): VoiceCallMessage | null;
  /** 还没取走的输入有几句 */
  pendingInputs(): number;
  /** 取走所有还没写进会话的输入 */
  takeInputs(): CallInput[];
  /** 开始一次回答。手上那次还没结束就作废它；已经挂断的话这次也直接作废。 */
  beginRequest(timing: CallTiming | null): CallRequest;
  /** 这次回答结束了（成功失败都算）。不是手上那次就什么都不做。 */
  finishRequest(request: CallRequest): void;
  /** 念一句切好的话，返回它是否真的交给了播放端。 */
  speak(sentence: string, request?: CallRequest | null): Promise<boolean>;
  /** 给一段话用的切句器：切出来的每句直接念。 */
  splitter(request?: CallRequest | null): SentenceSplitter;
  /** 挂断：没播的不播了，进行中的回答作废，没取走的输入扔掉。 */
  close(): void;
}

/** 记住收过的句子，够覆盖识别结果迟到的那几秒就行 */
const SEEN_LIMIT = 256;

export function createCallSession(info: CallInfo, {
  owner = {}, synthesize, deliver, onSpeechError = () => {}, onTiming = () => {}, now = Date.now,
}: CallSessionOptions): CallSession {
  const startedAt = now();
  const inbox: CallInput[] = [];
  const seen = new Set<string>();
  let current: CallRequest | null = null;
  let closed = false;
  const speech = createSpeechQueue<string>({ synthesize, deliver, onError: onSpeechError });

  const speak = (sentence: string, request: CallRequest | null = null): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    if (request) {
      request.spoke = true;
      request.firstSentenceAt ??= now();
    }
    const delivered = speech.push(sentence);
    void delivered.then((ok) => {
      if (!ok || !request || request.firstAudioAt) return;
      request.firstAudioAt = now();
      onTiming(formatCallTiming({
        ...request.timing,
        requestAt: request.startedAt,
        firstTextAt: request.firstTextAt,
        firstSentenceAt: request.firstSentenceAt,
        firstAudioAt: request.firstAudioAt,
      }));
    });
    return delivered;
  };

  return {
    info,
    startedAt,
    get closed() { return closed; },
    get request() { return current; },

    hear(transcript) {
      if (closed || transcript.callId !== info.callId) return null;
      const msg = voiceCallMessage(transcript, owner);
      if (!msg.content || seen.has(msg.message_id)) return null;
      seen.add(msg.message_id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
      inbox.push({ msg, transcript, receivedAt: now() });
      // 电脑声音不打断：群语音里有人一直在说，打断会让宠物一句也说不出来
      if (transcript.source === 'mic' && current && !current.spoke) {
        current.stale = true;
        current.controller.abort();
      }
      return msg;
    },

    pendingInputs: () => inbox.length,

    takeInputs: () => inbox.splice(0),

    beginRequest(timing) {
      current?.controller.abort();
      const request: CallRequest = {
        controller: new AbortController(),
        spoke: false,
        stale: false,
        startedAt: now(),
        firstTextAt: null,
        firstSentenceAt: null,
        firstAudioAt: null,
        timing,
      };
      if (closed) request.controller.abort();
      current = request;
      return request;
    },

    finishRequest(request) {
      if (current === request) current = null;
    },

    speak,

    splitter(request = null) {
      return createSentenceSplitter((sentence) => { void speak(sentence, request); });
    },

    close() {
      if (closed) return;
      closed = true;
      speech.cancel();
      current?.controller.abort();
      current = null;
      inbox.length = 0;
    },
  };
}

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

/** 等 ms 毫秒，signal 一取消就提前醒。 */
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

/**
 * 跑一次通话请求：还没开口就失败时隔一会儿重试一次。平时那套 5/25/125 秒的退避，通话里
 * 等不起；已经开口了再重试会把说过的话再说一遍，被取消了也不重试。
 */
export async function retryCallRequest<T>(
  run: () => Promise<T>,
  request: CallRequest,
  { delayMs = 1500, onRetry = () => {} }: { delayMs?: number; onRetry?: (error: unknown) => void } = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (request.spoke || request.controller.signal.aborted || isAbortError(error)) throw error;
    onRetry(error);
    await pause(delayMs, request.controller.signal);
    if (request.controller.signal.aborted) throw error;
    return run();
  }
}
