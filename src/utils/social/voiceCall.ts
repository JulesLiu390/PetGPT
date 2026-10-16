/**
 * 视频通话：整个通话是会话里的一个 turn，工作流照常跑，只换两头。
 *
 * - 进：Rust 每断出一句话就转成文字，这里把它做成一条消息直接写进会话。麦克风是使用者本人
 *   （按主人身份、算作 @ 了宠物），电脑声音是通话里的其他人。群里的文字消息照常送进来。
 * - 出：模型直接写的文字就是要说的话，边生成边切句合成；send_message / voice_send 也改成
 *   在通话里念。发图、表情包这类通话里没法呈现，直接拒绝。
 *
 * 这里是通话里用到的提示文字和格式转换，都是纯函数。开关通话见 voiceCallController，
 * 会话里的那一通见 callSession。
 */
import { stripSplitTagsForSpeech } from './outgoingText.js';
import { buildDramaText, cleanDramaScript, spokenText, type TtsConfig, type TtsProvider } from './voiceScript.ts';
import type { CallSource, CallTranscript } from './voiceCallApi.ts';

/** 通话里不能出现的发送工具（说话以外的那些）。 */
const VISUAL_SEND_TOOL_RE = /(send_image|sticker_send|image_send|webshot_send|generate_image_send)/i;

export type CallSendAction = 'speak' | 'block';

/** 通话期间这次工具调用该怎么处理：'speak' 念出来，'block' 拒绝，null 照常执行。 */
export function callSendAction(name: string): CallSendAction | null {
  if (/send_message/i.test(name) || name === 'voice_send') return 'speak';
  if (VISUAL_SEND_TOOL_RE.test(name)) return 'block';
  return null;
}

type ToolArgs = Record<string, unknown> | null | undefined;

/**
 * 要合成的文本和实际念出来的字。voice_send 在 Fish 下带语气提示；send_message 只是把
 * 分段标记换成停顿。
 */
export function callSpeech(name: string, args: ToolArgs, provider: TtsProvider | undefined): { text: string; spoken: string } {
  if (name === 'voice_send' && provider === 'fish') {
    const script = String(args?.script ?? args?.text ?? '');
    return { text: buildDramaText({ direction: args?.direction, script }), spoken: spokenText(script) };
  }
  const raw = name === 'voice_send' ? args?.text : args?.content;
  const text = String(stripSplitTagsForSpeech(String(raw || '')) || '').trim();
  return { text, spoken: name === 'voice_send' ? text : spokenText(text) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 和 qq-mcp 的 Message.to_dict 同形，会话把它当成一条群消息。 */
export interface VoiceCallMessage {
  message_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_at_me: boolean;
  is_self: false;
  _voiceCall: CallSource;
}

export interface CallOwner {
  ownerQQ?: string;
  ownerName?: string;
}

/**
 * Rust 的一句识别结果 → 群消息。message_id 由通话、声源和开口时刻决定：同一句话送来两次
 * 得到同一条消息，会话据此去重。同一路声音的两句话不可能在同一毫秒开口。
 */
export function voiceCallMessage(
  { callId, source, text, startedAt }: Pick<CallTranscript, 'callId' | 'source' | 'text' | 'startedAt'>,
  { ownerQQ = '', ownerName = '' }: CallOwner = {},
): VoiceCallMessage {
  const fromUser = source === 'mic';
  const at = new Date(startedAt || Date.now());
  return {
    message_id: `voice-${callId}-${source}-${at.getTime()}`,
    sender_id: fromUser ? (ownerQQ || 'owner') : 'voice-call',
    sender_name: fromUser ? `${ownerName || '主人'}（通话语音）` : '通话里的其他人（电脑声音）',
    content: String(text || '').trim(),
    timestamp: at.toISOString(),
    // 对着宠物说的话就是在叫它
    is_at_me: fromUser,
    is_self: false,
    _voiceCall: source,
  };
}

const clockOf = (date = new Date()) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/**
 * 通话开始时插进会话的说明：说话怎么出去、消息从哪来。
 * soundCues：TTS 是 Fish 时，可以在话里写语气和音效。
 */
export function callStartedNote(targetName: string, { soundCues = false }: { soundCues?: boolean } = {}): string {
  const where = targetName ? `「${targetName}」` : '这个会话';
  const cues = soundCues
    ? '\n- 可以在句子开头用方括号写语气，比如 [开心，语速轻快]；也可以在说话的位置插 [laugh] [sigh] [pause] 这类音效。方括号不会被念出来，一句里一两个就够。'
    : '';
  return `【系统】${clockOf()} 主人和你开了视频通话（挂在${where}上）。通话期间这一整段都算同一轮，规则和平时不一样：
- 你直接写出来的文字会被原样念出来，不用调 send_message（调了也只是念出来，不会发到群里）。所以只写要说出口的话：口语、简短，一次一两句；不写分析过程、括号旁白、Markdown、网址、表情符号。没什么要说的就什么都不写。${cues}
- 不用调 check_new_messages：主人说的话和群里的新消息都会自动送到。也不用调 turn_note，挂断时系统会收尾。
- 名字带「（通话语音）」的是主人在麦克风里说的话；「通话里的其他人（电脑声音）」是电脑正在播放的声音，比如群语音里的其他人。识别可能有错字，按意思理解。
- 群里的文字消息你照样能看到，跟通话有关可以提一句，但不用逐条回应；这期间不往群里发任何东西，发图、表情包、网页截图都会被拒绝。
- 刚接通，可以先简短打个招呼。`;
}

export function callEndedNote(): string {
  return `【系统】${clockOf()} 视频通话结束了，恢复平时的规则：想在群里说话要调 send_message，直接写的文字群里看不到。`;
}

/** 通话里每批新输入后面跟的一句提醒。 */
export function callInjectionText({ voice = 0, group = 0 }: { voice?: number; group?: number } = {}): string {
  const parts: string[] = [];
  if (voice) parts.push(`通话里刚说的 ${voice} 句话`);
  if (group) parts.push(`群里新到的 ${group} 条消息`);
  return `（以上是${parts.join('和') || '新的内容'}。还在通话中：直接说，写出来的文字会被念出来；没什么要说的就不出声。）`;
}

/** 宠物在通话里说过的话怎么进会话记录：assistant 角色，和群里说的话分开标。 */
export function formatSpokenMessage({ text = '', time = '' }: { text?: string; time?: string } = {}): string {
  const head = [time, '我在通话里说'].filter(Boolean).join(' ');
  return `[${head}] ${text}`;
}

/** 一句话交给 TTS 之前：Fish 保留语气和音效标记（清掉不认识的），别家全去掉免得被念出来。 */
export function speechForProvider(sentence: string, provider: TtsProvider | undefined): string {
  return provider === 'fish' ? cleanDramaScript(sentence) : spokenText(sentence);
}

export interface CallTurnNote {
  register: string;
  summary: string;
  inferred: true;
}

/** 挂断时替模型补的这一轮小结。 */
export function callTurnNote({ startedAt, spoken = 0 }: { startedAt?: number; spoken?: number } = {}): CallTurnNote {
  const minutes = Math.max(1, Math.round((Date.now() - (startedAt || Date.now())) / 60000));
  return { register: '闲扯', summary: `视频通话约 ${minutes} 分钟，说了 ${spoken} 段话`, inferred: true };
}

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** 一次回答各段的时刻（毫秒时间戳），asrMs 是时长。缺的段跳过。 */
export interface CallTiming {
  endedAt?: number | null;
  detectedAt?: number | null;
  asrMs?: number | null;
  receivedAt?: number | null;
  requestAt?: number | null;
  firstTextAt?: number | null;
  firstSentenceAt?: number | null;
  firstAudioAt?: number | null;
}

/** 一次回答各段耗时，从主人那句话说完算起。 */
export function formatCallTiming({
  endedAt, detectedAt, asrMs, receivedAt, requestAt, firstTextAt, firstSentenceAt, firstAudioAt,
}: CallTiming = {}): string {
  const parts: string[] = [];
  if (endedAt && detectedAt) parts.push(`断句 ${secs(detectedAt - endedAt)}`);
  if (asrMs != null) parts.push(`识别 ${secs(asrMs)}`);
  if (receivedAt && requestAt) parts.push(`排队 ${secs(requestAt - receivedAt)}`);
  if (requestAt && firstTextAt) parts.push(`首字 ${secs(firstTextAt - requestAt)}`);
  if (firstSentenceAt && firstAudioAt) parts.push(`首句合成 ${secs(firstAudioAt - firstSentenceAt)}`);
  const start = endedAt || receivedAt || requestAt;
  if (start && firstAudioAt) parts.push(`共 ${secs(firstAudioAt - start)}`);
  return parts.join(' · ');
}

/** 识别用的 Fish Audio key：和 TTS 共用。 */
export function callAsrKey(ttsConfig: TtsConfig | null | undefined): string {
  return String(ttsConfig?.fish?.apiKey || '').trim();
}
