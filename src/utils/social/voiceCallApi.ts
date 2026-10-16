/**
 * 视频通话的 Rust 命令和事件（src-tauri/src/voice_call.rs）。
 *
 * 每通电话有自己的 callId，所有事件都带着它。命令都可以重复调：开始时这个会话已经在通话
 * 就返回那一通；挂断、播放指名 callId，那通已经结束就什么都不做（播放会报错）。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface CallInfo {
  callId: number;
  petId: string;
  targetId: string;
  targetName: string;
  /** 这通电话的窗口 label */
  window: string;
}

/** mic 是使用者本人，system 是电脑正在播放的声音（比如群语音里的其他人）。 */
export type CallSource = 'mic' | 'system';

/** 断出的一句话。时间都是毫秒时间戳，asrMs 是识别用的时长。 */
export interface CallTranscript {
  callId: number;
  targetId: string;
  source: CallSource;
  text: string;
  startedAt: number;
  endedAt: number;
  /** 断句判定这句说完的时刻（比 endedAt 晚一段静音） */
  detectedAt: number;
  asrMs: number;
}

/** 一句话开始播放：envelope 是每 frameMs 一个 0…1 的响度，给口型用。 */
export interface CallSpeech {
  callId: number;
  targetId: string;
  id: number;
  text: string;
  envelope: number[];
  frameMs: number;
}

export interface CallSpeechEnd {
  callId: number;
  targetId: string;
  id: number;
}

/** source：mic / system / playback 来自 Rust，llm 是前端自己发给通话窗口的。 */
export interface CallError {
  callId: number;
  targetId: string;
  source: string;
  message: string;
}

export interface CallEvents {
  'voice-call-started': CallInfo;
  'voice-call-ended': CallInfo;
  'voice-call-transcript': CallTranscript;
  'voice-call-speech': CallSpeech;
  'voice-call-speech-end': CallSpeechEnd;
  'voice-call-error': CallError;
}

export type CallEventName = keyof CallEvents;

export interface StartCallRequest {
  petId: string;
  targetId: string;
  targetName: string;
  /** Fish Audio key，识别用 */
  asrApiKey: string;
  /** 同时采集电脑声音（只有 macOS 支持） */
  captureSystem?: boolean;
}

export const voiceCallStart = ({ captureSystem = true, ...request }: StartCallRequest): Promise<CallInfo> =>
  invoke<CallInfo>('voice_call_start', { ...request, captureSystem });

/** 挂断 callId 那一通；不给就挂断所有通话（包括前端已经不认得的）。 */
export const voiceCallStop = (callId?: number): Promise<void> =>
  invoke<void>('voice_call_stop', { callId: callId ?? null });

export const voiceCallStatus = (): Promise<CallInfo | null> => invoke<CallInfo | null>('voice_call_status');

/** 把合成好的语音（base64）排进 callId 那通电话里播放。 */
export const voiceCallSpeak = (callId: number, audio: string, text: string): Promise<void> =>
  invoke<void>('voice_call_speak', { callId, audio, text });

export const listenCallEvent = <E extends CallEventName>(
  name: E,
  handler: (payload: CallEvents[E]) => void,
): Promise<UnlistenFn> => listen<CallEvents[E]>(name, event => handler(event.payload));
