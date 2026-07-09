export const MIN_QUICK_REPLIES = 2;
export const MAX_QUICK_REPLIES = 2;
export const MAX_QUICK_REPLY_VISUAL_UNITS = 28;

const CJK_OR_EMOJI_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u;
const LIST_PREFIX_RE = /^(?:\d{1,2}\s*[.)、:：]\s*|[-*•]\s+)/u;
const OUTER_MARK_RE = /^[\s`"'“”‘’*_]+|[\s`"'“”‘’*_]+$/gu;
const TRAILING_DECORATION_RE = /[\s。.!！;；…]+$/u;

const INCOMPLETE_STATUSES = new Set([
  'generating',
  'in_progress',
  'pending',
  'streaming',
  'thinking',
]);

const getGraphemes = (text) => {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment);
  }
  return Array.from(text);
};

export function getQuickReplyVisualUnits(text) {
  return getGraphemes(String(text || '')).reduce((units, grapheme) => {
    if (/^\s+$/u.test(grapheme)) return units + 0.5;
    return units + (CJK_OR_EMOJI_RE.test(grapheme) ? 2 : 1);
  }, 0);
}

export function cleanQuickReply(suggestion) {
  if (typeof suggestion !== 'string') return '';
  return suggestion
    .replace(/```[\w-]*|```/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(LIST_PREFIX_RE, '')
    .replace(OUTER_MARK_RE, '')
    .replace(TRAILING_DECORATION_RE, '')
    .trim();
}

export function isCompactQuickReply(reply) {
  if (!reply || getQuickReplyVisualUnits(reply) > MAX_QUICK_REPLY_VISUAL_UNITS) return false;
  if (CJK_OR_EMOJI_RE.test(reply)) return true;
  const words = reply.match(/[\p{L}\p{N}][\p{L}\p{N}'’+./-]*/gu) || [];
  return words.length <= 6;
}

const getDedupeKey = (text) => text
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/\s+/gu, ' ')
  .replace(/[.!?。！？]+$/u, '');

export function normalizeQuickReplies(suggestions) {
  if (!Array.isArray(suggestions)) return [];

  const seen = new Set();
  const normalized = [];
  for (const suggestion of suggestions) {
    const text = cleanQuickReply(suggestion);
    if (!isCompactQuickReply(text)) continue;
    const dedupeKey = getDedupeKey(text);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(text);
    if (normalized.length === MAX_QUICK_REPLIES) break;
  }
  return normalized;
}

export function parseQuickReplyResponse(response) {
  if (typeof response !== 'string') return [];
  return normalizeQuickReplies(response.split(/\s*(?:\||｜|\r?\n)\s*/u));
}

export function isCompletedAssistantMessage(message) {
  if (String(message?.role || '').toLowerCase() !== 'assistant') return false;
  if (message?.completed === false || message?.isStreaming === true || message?.is_streaming === true) return false;
  return !INCOMPLETE_STATUSES.has(String(message?.status || '').toLowerCase());
}

export function getLastConversationalMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = String(messages[index]?.role || '').toLowerCase();
    if (role === 'assistant' || role === 'user') return index;
  }
  return -1;
}

/**
 * Returns the one message allowed to render Quick Replies, or null.
 * Historical assistant messages never receive a presentation.
 */
export function getQuickReplyPresentation({
  enabled = true,
  messages,
  suggestions,
  isThinking = false,
  streamingContent = null,
} = {}) {
  const replies = normalizeQuickReplies(suggestions);
  if (!enabled || replies.length < MIN_QUICK_REPLIES || isThinking || Boolean(streamingContent)) return null;

  const messageIndex = getLastConversationalMessageIndex(messages);
  if (messageIndex < 0 || !isCompletedAssistantMessage(messages[messageIndex])) return null;

  return { messageIndex, replies };
}

/**
 * Tracks asynchronous suggestion generations without coupling conversations.
 * A settings change invalidates every token, while a new request only replaces
 * an older request for the same conversation.
 */
export function createQuickReplyRequestGate() {
  let settingsRevision = 0;
  const conversationRevisions = new Map();

  const bumpConversation = (conversationId) => {
    const key = String(conversationId || '');
    const next = (conversationRevisions.get(key) || 0) + 1;
    conversationRevisions.set(key, next);
    return { conversationId: key, conversationRevision: next, settingsRevision };
  };

  return {
    begin: bumpConversation,
    invalidateConversation: bumpConversation,
    settingsChanged() {
      settingsRevision += 1;
      conversationRevisions.clear();
    },
    isCurrent(token) {
      if (!token || token.settingsRevision !== settingsRevision) return false;
      return conversationRevisions.get(token.conversationId) === token.conversationRevision;
    },
  };
}

export function getQuickReplySelectionAction({
  enabled,
  request,
  currentConversationId,
  isGenerating,
  draft,
  attachmentCount = 0,
} = {}) {
  if (
    !enabled
    || !request?.text
    || String(request.conversationId || '') !== String(currentConversationId || '')
    || isGenerating
  ) {
    return 'ignore';
  }
  return String(draft || '').trim() || attachmentCount > 0 ? 'draft' : 'send';
}
