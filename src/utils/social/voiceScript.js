/**
 * voice_send 的 TTS 服务商和 Fish Audio 脚本处理。
 *
 * 两家互斥：ttsConfig.provider 选一家，voice_send 的参数和发送路径跟着换。
 * ElevenLabs 只念纯文本；Fish Audio（默认 drama-3）能读 [导演提示]、[sigh] 这类
 * 方括号和 <soft>…</soft> 这类成对标签，写法说明在模型第一次调用时才给（见
 * hasVisibleVoiceGuide），平时不占 system prompt。
 */
import { stripSplitTagsForSpeech } from './outgoingText.js';
import { isWindowSealed } from './sessionState.js';

export const FISH_DEFAULT_MODEL = 'drama-3';
export const FISH_MODELS = ['drama-3', 's2.1-pro', 's2.1-pro-free'];

/** drama-3 认的成对标签；别的尖括号标签会被念出来或乱读，一律删掉。 */
export const DRAMA_PAIRED_TAGS = ['whisper', 'emphasis', 'soft', 'fast', 'slow', 'stress', 'forceful'];

/** 写法说明结果的开头。会话记录里靠它认出「模型已经看过说明」。 */
export const VOICE_GUIDE_MARKER = '【voice_send 写法说明】';

/**
 * 当前选中的服务商。老配置没有 provider 字段：填过 ElevenLabs 的就还是它，
 * 什么都没填的新配置默认 Fish。
 */
export function ttsProvider(ttsConfig) {
  if (ttsConfig?.provider === 'fish' || ttsConfig?.provider === 'elevenlabs') return ttsConfig.provider;
  return ttsConfig?.apiKey || ttsConfig?.voiceId ? 'elevenlabs' : 'fish';
}

/**
 * 生效的 TTS 配置：{ provider, apiKey, voiceId, model }。没启用或缺 key / 声音时返回 null，
 * 这时 voice_send 不会提供给模型。
 */
export function resolveTts(ttsConfig) {
  if (!ttsConfig?.enabled) return null;
  const provider = ttsProvider(ttsConfig);
  if (provider === 'fish') {
    const fish = ttsConfig.fish || {};
    const apiKey = (fish.apiKey || '').trim();
    const voiceId = (fish.referenceId || '').trim();
    if (!apiKey || !voiceId) return null;
    return { provider, apiKey, voiceId, model: fish.model || FISH_DEFAULT_MODEL };
  }
  const apiKey = (ttsConfig.apiKey || '').trim();
  const voiceId = (ttsConfig.voiceId || '').trim();
  if (!apiKey || !voiceId) return null;
  return { provider, apiKey, voiceId, model: ttsConfig.modelId || '' };
}

const PAIRED_TAG = /<\s*(\/?)\s*([a-zA-Z_-]+)\s*>/g;

/**
 * 整理模型写的 script：分段标记换成停顿，<|speaker:0|> 这类控制符和不认识的
 * 尖括号标签删掉，没配对的标签也删掉（只开不关会让后面整句都变调）。
 */
export function cleanDramaScript(script) {
  let text = stripSplitTagsForSpeech(String(script || '')).replace(/<\|[^|>]*\|>/g, '');
  const counts = new Map();
  for (const [, slash, rawName] of text.matchAll(PAIRED_TAG)) {
    const name = rawName.toLowerCase();
    const count = counts.get(name) || { open: 0, close: 0 };
    count[slash ? 'close' : 'open'] += 1;
    counts.set(name, count);
  }
  text = text.replace(PAIRED_TAG, (_, slash, rawName) => {
    const name = rawName.toLowerCase();
    const count = counts.get(name);
    if (!DRAMA_PAIRED_TAGS.includes(name) || count.open !== count.close) return '';
    return `<${slash}${name}>`;
  });
  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 真正会被念出来的字：去掉方括号提示和所有尖括号标签。算字数、写发送记录都用它。 */
export function spokenText(script) {
  return String(script || '')
    .replace(/<\|[^|>]*\|>/g, '')
    .replace(/<[^<>]*>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 发给 Fish 的文本：「[direction] script」。direction 里的方括号会打断提示，先去掉。 */
export function buildDramaText({ direction, script }) {
  const cue = String(direction || '').replace(/[[\]【】]/g, '').replace(/\s+/g, ' ').trim();
  const body = cleanDramaScript(script);
  return cue ? `[${cue}] ${body}` : body;
}

export function isVoiceGuideResult(text) {
  return typeof text === 'string' && text.includes(VOICE_GUIDE_MARKER);
}

/**
 * 模型眼下还看得见写法说明吗：说明所在的窗口没被压缩掉就算。说明的记录带 keepFull，
 * 不会被工具输出裁剪换成占位符，所以「在 history 里且窗口未封」就等于在上下文里。
 */
export function hasVisibleVoiceGuide(session) {
  return (session?.history || []).some(entry =>
    entry.voiceGuide && !isWindowSealed(session, entry.windowId));
}
