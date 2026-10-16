import test from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceCallController, type CallBackend, type CallBinding } from '../social/voiceCallController.ts';
import type { CallEvents, CallInfo, StartCallRequest } from '../social/voiceCallApi.ts';

const tick = () => new Promise(r => setTimeout(r, 0));

/** 假的 Rust：记下每个命令，事件由测试手动发。 */
const fakeBackend = ({ beforeConnect }: { beforeConnect?: (info: CallInfo) => void } = {}) => {
  const handlers = new Map<string, Set<(payload: never) => void>>();
  const commands: string[] = [];
  let nextId = 0;
  let failNextStart: Error | null = null;
  const backend: CallBackend = {
    async start(request: StartCallRequest) {
      commands.push(`start:${request.targetId}`);
      await tick();
      if (failNextStart) {
        const error = failNextStart;
        failNextStart = null;
        throw error;
      }
      nextId += 1;
      const info = { callId: nextId, petId: request.petId, targetId: request.targetId, targetName: request.targetName, window: `call-${nextId}` };
      beforeConnect?.(info);
      return info;
    },
    async stop(callId?: number) {
      commands.push(`stop:${callId ?? 'all'}`);
    },
    async listen(name, handler) {
      const set = handlers.get(name) ?? new Set();
      set.add(handler as (payload: never) => void);
      handlers.set(name, set);
      return () => { set.delete(handler as (payload: never) => void); };
    },
  };
  const emit = <E extends keyof CallEvents>(name: E, payload: CallEvents[E]) => {
    for (const handler of handlers.get(name) ?? []) (handler as (payload: CallEvents[E]) => void)(payload);
  };
  const listenerCount = (name: keyof CallEvents) => handlers.get(name)?.size ?? 0;
  return { backend, commands, emit, listenerCount, failStart: (error: Error) => { failNextStart = error; } };
};

const binding = () => {
  const log: string[] = [];
  const hooks: CallBinding & { log: string[] } = {
    log,
    begin: (call) => { log.push(`begin:${call.callId}`); },
    end: (call) => { log.push(`end:${call.callId}`); },
    hear: (call, transcript) => { log.push(`hear:${call.callId}:${transcript.text}`); },
    error: (call, error) => { log.push(`error:${call.callId}:${error.message}`); },
  };
  return hooks;
};

const request = (targetId: string): StartCallRequest => ({ petId: 'pet', targetId, targetName: targetId, asrApiKey: 'sk-fish' });

const transcript = (callId: number, text: string) => ({
  callId, targetId: 'g1', source: 'mic' as const, text, startedAt: 1, endedAt: 2, detectedAt: 3, asrMs: 4,
});

test('starting the same call twice connects once', async () => {
  const { backend, commands } = fakeBackend();
  const calls = createVoiceCallController(backend);
  const hooks = binding();
  const [first, second] = await Promise.all([calls.start(request('g1'), hooks), calls.start(request('g1'), hooks)]);
  assert.equal(first, second);
  assert.deepEqual(commands, ['start:g1']);
  assert.deepEqual(hooks.log, ['begin:1']);
  assert.equal(await calls.start(request('g1'), binding()), first, 'later too');
  assert.equal(calls.current()?.callId, 1);
});

test('hanging up twice ends the call once', async () => {
  const { backend, commands } = fakeBackend();
  const calls = createVoiceCallController(backend);
  const hooks = binding();
  const changes: Array<number | null> = [];
  calls.onChange(call => changes.push(call?.callId ?? null));
  await calls.start(request('g1'), hooks);
  await Promise.all([calls.stop('g1'), calls.stop('g1')]);
  assert.deepEqual(hooks.log, ['begin:1', 'end:1']);
  assert.deepEqual(commands, ['start:g1', 'stop:1']);
  assert.deepEqual(changes, [1, null]);
  assert.equal(calls.current(), null);
});

test('hanging up another session leaves this call alone', async () => {
  const { backend, commands } = fakeBackend();
  const calls = createVoiceCallController(backend);
  await calls.start(request('g1'), binding());
  await calls.stop('g2');
  assert.equal(calls.current()?.targetId, 'g1');
  assert.deepEqual(commands, ['start:g1']);
});

test('stop() with no call still clears anything Rust has left over', async () => {
  const { backend, commands } = fakeBackend();
  const calls = createVoiceCallController(backend);
  await calls.stop();
  await calls.stop();
  assert.deepEqual(commands, ['stop:all', 'stop:all']);
});

test('calling another session hangs up the first call before connecting', async () => {
  const { backend, commands } = fakeBackend();
  const calls = createVoiceCallController(backend);
  const first = binding();
  const second = binding();
  await calls.start(request('g1'), first);
  await calls.start(request('g2'), second);
  assert.deepEqual(commands, ['start:g1', 'stop:1', 'start:g2']);
  assert.deepEqual(first.log, ['begin:1', 'end:1']);
  assert.deepEqual(second.log, ['begin:2']);
});

test('hanging up while connecting hangs up right after it connects, leaving nothing running', async () => {
  const { backend, commands } = fakeBackend();
  const calls = createVoiceCallController(backend);
  const hooks = binding();
  const starting = calls.start(request('g1'), hooks);
  const stopping = calls.stop();
  await Promise.all([starting, stopping]);
  assert.deepEqual(commands, ['start:g1', 'stop:1']);
  assert.deepEqual(hooks.log, ['begin:1', 'end:1']);
  assert.equal(calls.current(), null);
});

test('hanging up in the call window ends the call once, however many times the event arrives', async () => {
  const { backend, emit } = fakeBackend();
  const calls = createVoiceCallController(backend);
  const hooks = binding();
  const info = await calls.start(request('g1'), hooks);
  emit('voice-call-ended', info);
  emit('voice-call-ended', info);
  await calls.stop('g1');
  assert.deepEqual(hooks.log, ['begin:1', 'end:1']);
  assert.equal(calls.current(), null);
});

test('a late event from an earlier call does not touch the current one', async () => {
  const { backend, emit } = fakeBackend();
  const calls = createVoiceCallController(backend);
  const old = await calls.start(request('g1'), binding());
  await calls.stop('g1');
  const hooks = binding();
  await calls.start(request('g1'), hooks);
  emit('voice-call-ended', old);
  emit('voice-call-transcript', transcript(old.callId, '上一通的话'));
  emit('voice-call-transcript', transcript(2, '这一通的话'));
  assert.equal(calls.current()?.callId, 2);
  assert.deepEqual(hooks.log, ['begin:2', 'hear:2:这一通的话']);
});

test('what arrives while connecting reaches the call once it is connected', async () => {
  let emitEarly: (info: CallInfo) => void = () => {};
  const fake = fakeBackend({ beforeConnect: (info) => emitEarly(info) });
  emitEarly = (info) => {
    fake.emit('voice-call-error', { callId: info.callId, targetId: info.targetId, source: 'mic', message: '没有麦克风权限' });
    fake.emit('voice-call-error', { callId: 99, targetId: info.targetId, source: 'mic', message: '别的通话' });
  };
  const calls = createVoiceCallController(fake.backend);
  const hooks = binding();
  await calls.start(request('g1'), hooks);
  assert.deepEqual(hooks.log, ['begin:1', 'error:1:没有麦克风权限']);
});

test('events are subscribed once for every call', async () => {
  const { backend, listenerCount } = fakeBackend();
  const calls = createVoiceCallController(backend);
  await calls.start(request('g1'), binding());
  await calls.start(request('g2'), binding());
  await calls.stop();
  await calls.start(request('g1'), binding());
  assert.equal(listenerCount('voice-call-ended'), 1);
  assert.equal(listenerCount('voice-call-transcript'), 1);
  assert.equal(listenerCount('voice-call-error'), 1);
});

test('a failed start leaves nothing behind, and the next one works', async () => {
  const { backend, failStart } = fakeBackend();
  const calls = createVoiceCallController(backend);
  failStart(new Error('打不开窗口'));
  const hooks = binding();
  await assert.rejects(calls.start(request('g1'), hooks), /打不开窗口/);
  assert.equal(calls.current(), null);
  assert.deepEqual(hooks.log, []);
  await calls.start(request('g1'), hooks);
  assert.deepEqual(hooks.log, ['begin:1']);
});

test('a call the session cannot take is hung up at once', async () => {
  const { backend, commands } = fakeBackend();
  const calls = createVoiceCallController(backend);
  const hooks = binding();
  hooks.begin = () => { throw new Error('会话不在了'); };
  await assert.rejects(calls.start(request('g1'), hooks), /会话不在了/);
  assert.equal(calls.current(), null);
  assert.deepEqual(commands, ['start:g1', 'stop:1']);
});

test('a failed subscription is retried without leaving half of it behind', async () => {
  const fake = fakeBackend();
  let failures = 1;
  const listen = fake.backend.listen;
  const backend: CallBackend = {
    ...fake.backend,
    listen: (name, handler) => {
      if (name === 'voice-call-error' && failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('还没有 Tauri'));
      }
      return listen(name, handler);
    },
  };
  const calls = createVoiceCallController(backend);
  await assert.rejects(calls.start(request('g1'), binding()), /还没有 Tauri/);
  assert.equal(fake.listenerCount('voice-call-ended'), 0, 'the ones that worked were undone');
  await calls.start(request('g1'), binding());
  assert.equal(fake.listenerCount('voice-call-ended'), 1);
  assert.equal(fake.listenerCount('voice-call-error'), 1);
});
