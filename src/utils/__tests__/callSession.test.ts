import test from 'node:test';
import assert from 'node:assert/strict';

import { createCallSession, retryCallRequest, type CallSessionOptions } from '../social/callSession.ts';
import type { CallInfo, CallTranscript } from '../social/voiceCallApi.ts';

const info: CallInfo = { callId: 7, petId: 'pet', targetId: 'g1', targetName: '测试群', window: 'call-7' };

const heard = (text: string, extra: Partial<CallTranscript> = {}): CallTranscript => ({
  callId: 7, targetId: 'g1', source: 'mic', text,
  startedAt: 1_000, endedAt: 2_000, detectedAt: 2_460, asrMs: 500,
  ...extra,
});

const tick = () => new Promise(r => setTimeout(r, 0));

const session = (options: Partial<CallSessionOptions> = {}) => {
  const played: string[] = [];
  const timings: string[] = [];
  const call = createCallSession(info, {
    owner: { ownerQQ: '123', ownerName: '姐姐' },
    synthesize: async (sentence) => `audio:${sentence}`,
    deliver: async (audio) => { played.push(audio); },
    onTiming: (timing) => timings.push(timing),
    ...options,
  });
  return { call, played, timings };
};

test('the same sentence heard twice is one input', () => {
  const { call } = session();
  const first = call.hear(heard('在吗'));
  assert.equal(first?.sender_name, '姐姐（通话语音）');
  assert.equal(call.hear(heard('在吗')), null, 'a repeat is not news');
  assert.equal(call.pendingInputs(), 1);
  assert.ok(call.hear(heard('在吗', { source: 'system' })), 'the other source at the same moment is another sentence');
  assert.ok(call.hear(heard('还在吗', { startedAt: 3_000 })));
  assert.deepEqual(call.takeInputs().map(input => input.msg.content), ['在吗', '在吗', '还在吗']);
  assert.deepEqual(call.takeInputs(), [], 'taken means gone');
  assert.equal(call.hear(heard('在吗')), null, 'still a repeat after it was taken');
});

test('sentences from another call, without words, or after hanging up are dropped', () => {
  const { call } = session();
  assert.equal(call.hear(heard('别的通话', { callId: 8 })), null);
  assert.equal(call.hear(heard('   ', { startedAt: 5_000 })), null);
  call.hear(heard('还没取走', { startedAt: 6_000 }));
  call.close();
  assert.equal(call.pendingInputs(), 0, 'hanging up throws away what was not taken');
  assert.equal(call.hear(heard('挂断之后', { startedAt: 7_000 })), null);
});

test('the owner speaking again cancels an answer that has not started talking', () => {
  const { call } = session();
  const quiet = call.beginRequest(null);
  call.hear(heard('电脑里有人说话', { source: 'system' }));
  assert.equal(quiet.controller.signal.aborted, false, 'computer audio never interrupts');
  call.hear(heard('等一下', { startedAt: 2_000 }));
  assert.equal(quiet.controller.signal.aborted, true);
  assert.equal(quiet.stale, true);

  const talking = call.beginRequest(null);
  void call.speak('我在说话呢', talking);
  call.hear(heard('插一句', { startedAt: 3_000 }));
  assert.equal(talking.controller.signal.aborted, false, 'once it is talking it finishes');
});

test('one answer at a time, and finishing one twice or finishing an old one changes nothing', () => {
  const { call } = session();
  const first = call.beginRequest(null);
  const second = call.beginRequest(null);
  assert.equal(first.controller.signal.aborted, true, 'a new answer replaces one left open');
  assert.equal(call.request, second);
  call.finishRequest(first);
  assert.equal(call.request, second, 'the old one cannot clear the new one');
  call.finishRequest(second);
  call.finishRequest(second);
  assert.equal(call.request, null);
});

test('hanging up stops the answer and the speech, and hanging up twice is hanging up once', async () => {
  const { call, played } = session();
  const request = call.beginRequest(null);
  call.close();
  call.close();
  assert.equal(call.closed, true);
  assert.equal(request.controller.signal.aborted, true);
  assert.equal(call.request, null);
  assert.equal(await call.speak('挂了还说'), false);
  const late = call.beginRequest(null);
  assert.equal(late.controller.signal.aborted, true, 'an answer started after hanging up is dead on arrival');
  await tick();
  assert.deepEqual(played, []);
});

test('a splitter speaks each sentence in order and the timing is logged once per answer', async () => {
  let clock = 10_000;
  const { call, played, timings } = session({ now: () => clock });
  const request = call.beginRequest({ endedAt: 9_000, detectedAt: 9_460, asrMs: 400, receivedAt: 9_900 });
  request.firstTextAt = 11_000;
  const splitter = call.splitter(request);
  clock = 11_500;
  splitter.push('你好呀，好久不见！今天');
  clock = 12_000;
  splitter.push('过得怎么样？');
  splitter.end();
  splitter.end();
  await tick();
  await tick();
  assert.deepEqual(played, ['audio:你好呀，好久不见！', 'audio:今天过得怎么样？']);
  assert.equal(request.spoke, true);
  assert.equal(request.firstSentenceAt, 11_500);
  assert.equal(timings.length, 1);
  assert.match(timings[0] ?? '', /^断句 0\.5s · 识别 0\.4s · 排队 0\.1s · 首字 1\.0s/);
});

test('a speech failure is reported and the rest still plays', async () => {
  const errors: string[] = [];
  const { call, played } = session({
    synthesize: async (sentence) => { if (sentence.includes('坏')) throw new Error('tts down'); return `audio:${sentence}`; },
    onSpeechError: (error, sentence) => errors.push(`${sentence}:${(error as Error).message}`),
  });
  void call.speak('第一句好的');
  assert.equal(await call.speak('这句坏了'), false);
  assert.equal(await call.speak('第三句好的'), true);
  assert.deepEqual(played, ['audio:第一句好的', 'audio:第三句好的']);
  assert.deepEqual(errors, ['这句坏了:tts down']);
});

test('a call answer is retried once, but not after it started talking or was cancelled', async () => {
  const { call } = session();
  let runs = 0;
  const flaky = async () => { runs += 1; if (runs === 1) throw new Error('503'); return 'ok'; };
  const retried: unknown[] = [];
  assert.equal(await retryCallRequest(flaky, call.beginRequest(null), { delayMs: 1, onRetry: e => retried.push(e) }), 'ok');
  assert.equal(runs, 2);
  assert.equal(retried.length, 1);

  const failing = async () => { throw new Error('503'); };
  const spoke = call.beginRequest(null);
  spoke.spoke = true;
  await assert.rejects(retryCallRequest(failing, spoke, { delayMs: 1 }), /503/, 'saying it again would repeat what was said');

  const aborted = call.beginRequest(null);
  aborted.controller.abort();
  await assert.rejects(retryCallRequest(failing, aborted, { delayMs: 1 }), /503/);

  const waiting = call.beginRequest(null);
  let second = false;
  const started = Date.now();
  const pending = retryCallRequest(async () => {
    if (second) return 'should not run';
    second = true;
    throw new Error('503');
  }, waiting, { delayMs: 10_000 });
  await tick();
  waiting.controller.abort();
  await assert.rejects(pending, /503/);
  assert.ok(Date.now() - started < 5_000, 'hanging up during the pause does not wait it out');
});
