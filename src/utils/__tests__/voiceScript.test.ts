import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ttsProvider, resolveTts, cleanDramaScript, spokenText, buildDramaText,
  isVoiceGuideResult, hasVisibleVoiceGuide, VOICE_GUIDE_MARKER, FISH_DEFAULT_MODEL,
} from '../social/voiceScript.ts';
import { createSession, appendHistory, sealWindow } from '../social/sessionState.js';
import { trimToolOutputs } from '../social/contextTrim.js';

// contextTrim.js 的参数类型是从默认值推出来的，推不出 budgetChars
const trim = trimToolOutputs as (items: object[], options: { budgetChars: number }) =>
  { items: Array<{ content: string; _trimmed?: boolean }> };

test('老配置没有 provider：填过 ElevenLabs 的还是它，空配置默认 Fish', () => {
  assert.equal(ttsProvider({ enabled: true, apiKey: 'sk_x', voiceId: 'v' }), 'elevenlabs');
  assert.equal(ttsProvider({}), 'fish');
  assert.equal(ttsProvider(null), 'fish');
  assert.equal(ttsProvider({ provider: 'fish', apiKey: 'sk_x' }), 'fish');
});

test('只有选中的服务商配齐了才生效', () => {
  const both = {
    enabled: true, apiKey: 'sk_eleven', voiceId: 'v11', modelId: 'eleven_flash_v2_5',
    fish: { apiKey: ' sk-fish ', referenceId: ' ref ' },
  };
  assert.deepEqual(resolveTts({ ...both, provider: 'fish' }),
    { provider: 'fish', apiKey: 'sk-fish', voiceId: 'ref', model: FISH_DEFAULT_MODEL });
  assert.deepEqual(resolveTts({ ...both, provider: 'elevenlabs' }),
    { provider: 'elevenlabs', apiKey: 'sk_eleven', voiceId: 'v11', model: 'eleven_flash_v2_5' });
  assert.equal(resolveTts({ ...both, provider: 'fish', enabled: false }), null);
  assert.equal(resolveTts({ enabled: true, provider: 'fish', apiKey: 'sk_eleven', voiceId: 'v11', fish: { apiKey: 'k' } }), null,
    '选了 Fish 却没填声音，不会退回 ElevenLabs');
  assert.equal(resolveTts({ enabled: true, provider: 'fish', fish: { apiKey: 'k', referenceId: 'r', model: 's2.1-pro' } })?.model, 's2.1-pro');
});

test('认识的成对标签保留，不认识的、没配对的、控制符删掉', () => {
  assert.equal(cleanDramaScript('哼，<Emphasis>不理你了</ emphasis>！'), '哼，<emphasis>不理你了</emphasis>！');
  assert.equal(cleanDramaScript('<b>粗体</b>和<soft>轻声</soft>'), '粗体和<soft>轻声</soft>');
  assert.equal(cleanDramaScript('<whisper>只开不关，后面整句都会变调'), '只开不关，后面整句都会变调');
  assert.equal(cleanDramaScript('<|speaker:0|>你好<|phoneme_start|>'), '你好');
  assert.equal(cleanDramaScript('[sigh] 唉 [pause] 好吧'), '[sigh] 唉 [pause] 好吧');
});

test('分段标记先换成停顿，不会被当成尖括号标签吃掉', () => {
  assert.equal(cleanDramaScript('真的假的</分段>离谱了'), '真的假的，离谱了');
});

test('整理过的再整理一遍不变', () => {
  const samples = [
    '哼，<Emphasis>不理你了</ emphasis>！', '<b>粗体</b>和<soft>轻声</soft>', '<whisper>只开不关',
    '<|speaker:0|>你好', '真的假的</分段>离谱了', '[sigh]  唉   [pause] 好吧',
  ];
  for (const sample of samples) {
    const once = cleanDramaScript(sample);
    assert.equal(cleanDramaScript(once), once, sample);
    assert.equal(spokenText(spokenText(sample)), spokenText(sample), sample);
  }
  const text = buildDramaText({ direction: '开心', script: '你好呀 [laugh]' });
  assert.equal(buildDramaText({ script: text }), text, '拼好的文本再当 script 用不会再变');
});

test('念出来的字不含任何标签，用来算字数和写发送记录', () => {
  assert.equal(spokenText('哼，<emphasis>不理你了</emphasis>！[sigh] 好吧 [laugh]'), '哼，不理你了！ 好吧');
  assert.equal(spokenText('[pause] <soft></soft>'), '');
  assert.equal(spokenText(undefined), '');
});

test('direction 放进方括号放在最前面，里面的括号先去掉', () => {
  assert.equal(buildDramaText({ direction: ' 开心，语速轻快 ', script: '你好呀 [laugh]' }), '[开心，语速轻快] 你好呀 [laugh]');
  assert.equal(buildDramaText({ direction: '[小声]【困】', script: '晚安' }), '[小声困] 晚安');
  assert.equal(buildDramaText({ script: '<soft>晚安</soft>' }), '<soft>晚安</soft>');
});

test('写法说明只在它所在的窗口还没被压缩时算看得见', () => {
  const session = createSession();
  assert.equal(hasVisibleVoiceGuide(session), false);
  appendHistory(session, { role: 'tool', kind: 'tool_result', toolName: 'voice_send', content: `${VOICE_GUIDE_MARKER} …` });
  assert.equal(hasVisibleVoiceGuide(session), false, '没打标记的结果不算');
  appendHistory(session, { role: 'tool', kind: 'tool_result', toolName: 'voice_send', content: `${VOICE_GUIDE_MARKER} …`, voiceGuide: true, keepFull: true });
  assert.equal(hasVisibleVoiceGuide(session), true);
  sealWindow(session, '摘要');
  assert.equal(hasVisibleVoiceGuide(session), false, '压缩之后要重新给一遍');
  assert.equal(hasVisibleVoiceGuide(null), false);
  assert.ok(isVoiceGuideResult(`{"content":[{"text":"${VOICE_GUIDE_MARKER}"}]}`));
  assert.ok(!isVoiceGuideResult('✓ 已发送语音'));
});

test('写法说明不会被工具输出裁剪换成占位符', () => {
  const big = (extra = {}) => ({ kind: 'tool_result', role: 'tool', toolName: 'x', content: 'x'.repeat(5000), ...extra });
  const items = [big({ keepFull: true, toolName: 'voice_send' }), big(), big(), big()];
  const { items: out } = trim(items, { budgetChars: 0 });
  assert.equal(out[0]?.content.length, 5000);
  assert.ok(out[1]?._trimmed, '普通的旧输出照常裁');
});
