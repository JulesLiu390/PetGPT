import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startKeepAwake, stopKeepAwake, keepAwakeStatus,
  KEEP_AWAKE_GAIN, KEEP_AWAKE_FREQ_HZ, KEEP_AWAKE_SAMPLE_RATE,
} from '../keepAwake.js';

/** 记账用的假 AudioContext。startsSuspended 模拟自动播放策略拦截。 */
function makeFakeContext({ startsSuspended = false, resumeWorks = true } = {}) {
  const calls = { osc: 0, gain: 0, start: 0, stop: 0, disconnect: 0, close: 0, resume: 0 };
  const ctx = {
    state: startsSuspended ? 'suspended' : 'running',
    destination: { __d: true },
    onstatechange: null,
    options: null,
    calls,
    createOscillator() {
      calls.osc += 1;
      return {
        frequency: { value: 0 },
        connect(dst) { this.__dst = dst; },
        disconnect() { calls.disconnect += 1; },
        start() { calls.start += 1; },
        stop() { calls.stop += 1; },
      };
    },
    createGain() {
      calls.gain += 1;
      return {
        gain: { value: 1 },
        connect(dst) { this.__dst = dst; },
        disconnect() { calls.disconnect += 1; },
      };
    },
    async resume() {
      calls.resume += 1;
      if (resumeWorks) ctx.state = 'running';
    },
    async close() { calls.close += 1; ctx.state = 'closed'; },
  };
  return ctx;
}

const factoryFor = (ctx) => (options) => { ctx.options = options; return ctx; };

test.afterEach(() => stopKeepAwake());

test('启动后 context 在跑，振荡器接到了 destination', async () => {
  const ctx = makeFakeContext();
  const status = await startKeepAwake({ audioContextFactory: factoryFor(ctx) });

  assert.equal(status.running, true);
  assert.equal(status.wanted, true);
  assert.equal(ctx.calls.osc, 1);
  assert.equal(ctx.calls.gain, 1);
  assert.equal(ctx.calls.start, 1);
});

test('增益非零——归零有被 WebKit 判成静音的风险', async () => {
  const ctx = makeFakeContext();
  let capturedGain = null;
  const origCreateGain = ctx.createGain.bind(ctx);
  ctx.createGain = () => { capturedGain = origCreateGain(); return capturedGain; };

  await startKeepAwake({ audioContextFactory: factoryFor(ctx) });

  assert.ok(KEEP_AWAKE_GAIN > 0, '增益必须大于 0');
  assert.ok(KEEP_AWAKE_GAIN < 0.001, '增益必须小到听不见');
  assert.equal(capturedGain.gain.value, KEEP_AWAKE_GAIN);
});

test('按低采样率请求 context，拿不到再由工厂自己退回', async () => {
  const ctx = makeFakeContext();
  await startKeepAwake({ audioContextFactory: factoryFor(ctx) });
  assert.equal(ctx.options.sampleRate, KEEP_AWAKE_SAMPLE_RATE);
  assert.equal(ctx.options.latencyHint, 'playback');
});

test('频率设到次低频', async () => {
  const ctx = makeFakeContext();
  let osc = null;
  const orig = ctx.createOscillator.bind(ctx);
  ctx.createOscillator = () => { osc = orig(); return osc; };
  await startKeepAwake({ audioContextFactory: factoryFor(ctx) });
  assert.equal(osc.frequency.value, KEEP_AWAKE_FREQ_HZ);
});

test('suspended 起步时会 resume', async () => {
  const ctx = makeFakeContext({ startsSuspended: true });
  const status = await startKeepAwake({ audioContextFactory: factoryFor(ctx) });
  assert.equal(ctx.calls.resume, 1);
  assert.equal(status.running, true);
});

test('resume 无效时报一条 warn，状态诚实地说没跑起来', async () => {
  const ctx = makeFakeContext({ startsSuspended: true, resumeWorks: false });
  const logs = [];
  const status = await startKeepAwake({
    audioContextFactory: factoryFor(ctx),
    onLog: (level, message) => logs.push([level, message]),
  });
  assert.equal(status.running, false);
  assert.equal(status.state, 'suspended');
  assert.ok(logs.some(([level]) => level === 'warn'));
});

test('幂等：重复 start 不会再建一个 context', async () => {
  const ctx = makeFakeContext();
  let built = 0;
  const factory = (options) => { built += 1; ctx.options = options; return ctx; };

  await startKeepAwake({ audioContextFactory: factory });
  await startKeepAwake({ audioContextFactory: factory });

  assert.equal(built, 1);
  assert.equal(ctx.calls.osc, 1);
});

test('stop 会停振荡器、关 context，状态归零', async () => {
  const ctx = makeFakeContext();
  await startKeepAwake({ audioContextFactory: factoryFor(ctx) });
  stopKeepAwake();

  assert.equal(ctx.calls.stop, 1);
  assert.equal(ctx.calls.close, 1);
  assert.deepEqual(keepAwakeStatus(), { wanted: false, present: false, state: 'closed', running: false });
});

test('stop 幂等，没启动过也不炸', () => {
  stopKeepAwake();
  stopKeepAwake();
  assert.equal(keepAwakeStatus().running, false);
});

test('没有 Web Audio 的环境降级：不抛异常，只报 warn', async () => {
  const logs = [];
  const status = await startKeepAwake({
    audioContextFactory: () => null,
    onLog: (level, message) => logs.push([level, message]),
  });
  assert.equal(status.running, false);
  assert.equal(status.present, false);
  assert.ok(logs.some(([level]) => level === 'warn'));
});

test('建图抛异常时会清理干净，不留半个 context', async () => {
  const ctx = makeFakeContext();
  ctx.createOscillator = () => { throw new Error('boom'); };
  const logs = [];
  const status = await startKeepAwake({
    audioContextFactory: factoryFor(ctx),
    onLog: (level, message) => logs.push([level, message]),
  });
  assert.equal(status.present, false);
  assert.equal(ctx.calls.close, 1);
  assert.ok(logs.some(([level, msg]) => level === 'warn' && msg.includes('boom')));
});

test('被系统打断后 statechange 会自己爬起来', async () => {
  const ctx = makeFakeContext();
  await startKeepAwake({ audioContextFactory: factoryFor(ctx) });

  ctx.state = 'interrupted';
  ctx.onstatechange();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(ctx.calls.resume, 1);
  assert.equal(ctx.state, 'running');
});

test('stop 之后 statechange 不再自救', async () => {
  const ctx = makeFakeContext();
  await startKeepAwake({ audioContextFactory: factoryFor(ctx) });
  const handler = ctx.onstatechange;
  stopKeepAwake();

  ctx.state = 'suspended';
  handler();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(ctx.calls.resume, 0);
});
