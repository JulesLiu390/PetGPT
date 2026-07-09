import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_QUICK_REPLY_VISUAL_UNITS,
  createQuickReplyRequestGate,
  getQuickReplySelectionAction,
  getQuickReplyPresentation,
  getQuickReplyVisualUnits,
  isCompletedAssistantMessage,
  normalizeQuickReplies,
  parseQuickReplyResponse,
} from '../quickReplyModel.js';

const suggestions = ['Tell me more', 'Give an example'];

test('normalizes, deduplicates, and caps suggestions at two', () => {
  assert.deepEqual(normalizeQuickReplies([
    '  Tell   me more ',
    'tell me more',
    '',
    'Give an example',
    42,
    'Compare the options',
  ]), suggestions);
});

test('parses model formatting and full-width separators into compact replies', () => {
  assert.deepEqual(parseQuickReplyResponse(`\`\`\`text
1. “对比三大平台。”｜2) X2 值得买吗？
\`\`\``), ['对比三大平台', 'X2 值得买吗？']);
});

test('rejects visually long replies and normalizes punctuation for deduplication', () => {
  const longReply = '对比 Snapdragon X2、Intel Core Ultra 和 Apple M 系列在轻薄本中的性能与续航差异';
  assert.ok(getQuickReplyVisualUnits(longReply) > MAX_QUICK_REPLY_VISUAL_UNITS);
  assert.deepEqual(normalizeQuickReplies([
    longReply,
    'Tell me more.',
    'tell me more',
    'Compare all three platforms',
  ]), ['Tell me more', 'Compare all three platforms']);
});

test('targets only the latest completed assistant message', () => {
  const messages = [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'Historical answer' },
    { role: 'user', content: 'Latest question' },
    { role: 'assistant', content: 'Latest answer' },
  ];

  assert.deepEqual(getQuickReplyPresentation({ messages, suggestions }), {
    messageIndex: 3,
    replies: suggestions,
  });
});

test('hides replies while streaming or thinking', () => {
  const messages = [{ role: 'assistant', content: 'Answer' }];
  assert.equal(getQuickReplyPresentation({ messages, suggestions, isThinking: true }), null);
  assert.equal(getQuickReplyPresentation({ messages, suggestions, streamingContent: 'partial' }), null);
});

test('hides replies when the preference is disabled', () => {
  assert.equal(getQuickReplyPresentation({
    enabled: false,
    messages: [{ role: 'assistant', content: 'Answer' }],
    suggestions,
  }), null);
});

test('hides replies when the latest conversational message is a user message', () => {
  const messages = [
    { role: 'assistant', content: 'Old answer' },
    { role: 'user', content: 'New question' },
  ];
  assert.equal(getQuickReplyPresentation({ messages, suggestions }), null);
});

test('requires two suggestions and an explicitly completed assistant message', () => {
  assert.equal(getQuickReplyPresentation({
    messages: [{ role: 'assistant', content: 'Answer' }],
    suggestions: ['Only one'],
  }), null);
  assert.equal(isCompletedAssistantMessage({ role: 'assistant', status: 'streaming' }), false);
  assert.equal(isCompletedAssistantMessage({ role: 'assistant', completed: false }), false);
  assert.equal(isCompletedAssistantMessage({ role: 'assistant', status: 'completed' }), true);
});

test('request gate isolates conversations and invalidates late settings results', () => {
  const gate = createQuickReplyRequestGate();
  const a1 = gate.begin('a');
  const b1 = gate.begin('b');
  assert.equal(gate.isCurrent(a1), true);
  assert.equal(gate.isCurrent(b1), true);

  const a2 = gate.begin('a');
  assert.equal(gate.isCurrent(a1), false);
  assert.equal(gate.isCurrent(a2), true);
  assert.equal(gate.isCurrent(b1), true);

  gate.settingsChanged();
  assert.equal(gate.isCurrent(a2), false);
  assert.equal(gate.isCurrent(b1), false);
});

test('selection sends only for the active empty composer', () => {
  const base = {
    enabled: true,
    request: { conversationId: 'chat-a', text: 'Tell me more' },
    currentConversationId: 'chat-a',
    isGenerating: false,
  };
  assert.equal(getQuickReplySelectionAction(base), 'send');
  assert.equal(getQuickReplySelectionAction({ ...base, draft: 'Existing draft' }), 'draft');
  assert.equal(getQuickReplySelectionAction({ ...base, attachmentCount: 1 }), 'draft');
  assert.equal(getQuickReplySelectionAction({ ...base, currentConversationId: 'chat-b' }), 'ignore');
  assert.equal(getQuickReplySelectionAction({ ...base, enabled: false }), 'ignore');
});
