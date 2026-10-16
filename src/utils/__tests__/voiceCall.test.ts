import test from 'node:test';
import assert from 'node:assert/strict';

import { TURN_REGISTERS } from '../social/sessionState.js';
import {
  callSendAction, callSpeech, voiceCallMessage, callStartedNote, callEndedNote, callAsrKey,
  callInjectionText, formatSpokenMessage, speechForProvider, callTurnNote, formatCallTiming,
} from '../social/voiceCall.ts';

test('during a call speaking is spoken and pictures are refused', () => {
  assert.equal(callSendAction('qq__send_message'), 'speak');
  assert.equal(callSendAction('voice_send'), 'speak');
  for (const name of ['sticker_send', 'image_send', 'webshot_send', 'generate_image_send', 'qq__send_image']) {
    assert.equal(callSendAction(name), 'block', name);
  }
  for (const name of ['history_read', 'social_read', 'turn_note', 'check_new_messages', 'webshot']) {
    assert.equal(callSendAction(name), null, name);
  }
});

test('what gets synthesised and what counts as said', () => {
  assert.deepEqual(callSpeech('qq__send_message', { content: '真的假的</分段>离谱了' }, 'fish'),
    { text: '真的假的，离谱了', spoken: '真的假的，离谱了' });
  assert.deepEqual(callSpeech('voice_send', { direction: '开心', script: '你好呀 [laugh]' }, 'fish'),
    { text: '[开心] 你好呀 [laugh]', spoken: '你好呀' });
  assert.deepEqual(callSpeech('voice_send', { text: '早呀' }, 'elevenlabs'), { text: '早呀', spoken: '早呀' });
  assert.equal(callSpeech('qq__send_message', {}, 'fish').spoken, '');
  assert.equal(callSpeech('qq__send_message', null, 'fish').spoken, '');
});

test('the microphone is the owner calling the pet; computer audio is everyone else', () => {
  const startedAt = Date.parse('2026-10-15T12:00:00Z');
  const mic = voiceCallMessage({ callId: 3, source: 'mic', text: ' 在吗 ', startedAt }, { ownerQQ: '123', ownerName: '姐姐' });
  assert.equal(mic.sender_id, '123');
  assert.equal(mic.sender_name, '姐姐（通话语音）');
  assert.equal(mic.content, '在吗');
  assert.equal(mic.is_at_me, true);
  assert.equal(mic.is_self, false);
  assert.equal(mic.timestamp, '2026-10-15T12:00:00.000Z');

  const other = voiceCallMessage({ callId: 3, source: 'system', text: '大家好', startedAt });
  assert.equal(other.sender_id, 'voice-call');
  assert.equal(other.is_at_me, false);
  assert.match(other.sender_name, /电脑声音/);
  assert.equal(voiceCallMessage({ callId: 3, source: 'mic', text: 'x', startedAt }).sender_name, '主人（通话语音）');
});

test('a sentence keeps its message id however often it arrives', () => {
  const startedAt = Date.parse('2026-10-15T12:00:00Z');
  const heard = { callId: 3, source: 'system', text: '大家好', startedAt } as const;
  assert.equal(voiceCallMessage(heard).message_id, voiceCallMessage(heard).message_id);
  assert.equal(voiceCallMessage(heard).message_id, `voice-3-system-${startedAt}`);
  assert.notEqual(voiceCallMessage(heard).message_id, voiceCallMessage({ ...heard, source: 'mic' }).message_id,
    'the two sources can start at the same moment and are still two sentences');
  assert.notEqual(voiceCallMessage(heard).message_id, voiceCallMessage({ ...heard, callId: 4 }).message_id,
    'another call, another sentence');
});

test('the call notes say the text itself is spoken, and what the turn does without', () => {
  const started = callStartedNote('测试群');
  assert.match(started, /「测试群」/);
  assert.match(started, /直接写出来的文字会被原样念出来/);
  assert.match(started, /不用调 check_new_messages/);
  assert.match(started, /不用调 turn_note/);
  assert.match(started, /（通话语音）/);
  assert.match(started, /群里的文字消息你照样能看到/);
  assert.doesNotMatch(started, /\[laugh\]/, 'no sound cues unless the voice understands them');
  assert.match(callStartedNote('', { soundCues: true }), /\[laugh\]/);
  assert.match(callEndedNote(), /要调 send_message/);
  assert.equal(callAsrKey({ fish: { apiKey: ' sk-fish ' } }), 'sk-fish');
  assert.equal(callAsrKey({ apiKey: 'sk_eleven' }), '');
  assert.equal(callAsrKey(null), '');
});

test('each batch of input in a call is followed by a short reminder', () => {
  assert.match(callInjectionText({ voice: 2 }), /通话里刚说的 2 句话/);
  assert.match(callInjectionText({ voice: 1, group: 3 }), /通话里刚说的 1 句话和群里新到的 3 条消息/);
  assert.match(callInjectionText({ group: 1 }), /写出来的文字会被念出来/);
});

test('what the pet said in the call is kept apart from what it said in the group', () => {
  assert.equal(formatSpokenMessage({ text: '在的', time: '19:01:02' }), '[19:01:02 我在通话里说] 在的');
  assert.equal(formatSpokenMessage({ text: '在的' }), '[我在通话里说] 在的');
});

test('sound cues reach a voice that understands them and nobody else', () => {
  assert.equal(speechForProvider('[开心] 你好 <soft>呀</soft> <b>x</b>', 'fish'), '[开心] 你好 <soft>呀</soft> x');
  assert.equal(speechForProvider('[开心] 你好 <soft>呀</soft>', 'elevenlabs'), '你好 呀');
});

test('the call turn gets a summary instead of a turn_note', () => {
  const note = callTurnNote({ startedAt: Date.now() - 5 * 60_000, spoken: 7 });
  assert.equal(note.register, '闲扯');
  assert.ok(TURN_REGISTERS.includes(note.register), 'a register the session knows');
  assert.match(note.summary, /约 5 分钟，说了 7 段话/);
  assert.equal(note.inferred, true);
  assert.match(callTurnNote({ startedAt: Date.now() }).summary, /约 1 分钟/, 'never zero minutes');
});

test('timing reads from the end of the sentence to the first sound', () => {
  const t0 = 1_000_000;
  assert.equal(formatCallTiming({
    endedAt: t0, detectedAt: t0 + 460, asrMs: 800, receivedAt: t0 + 1300,
    requestAt: t0 + 1350, firstTextAt: t0 + 2850, firstSentenceAt: t0 + 3000, firstAudioAt: t0 + 3900,
  }), '断句 0.5s · 识别 0.8s · 排队 0.1s · 首字 1.5s · 首句合成 0.9s · 共 3.9s');
  assert.equal(formatCallTiming({ requestAt: t0, firstTextAt: t0 + 1000 }), '首字 1.0s', 'a greeting has no sentence before it');
});
