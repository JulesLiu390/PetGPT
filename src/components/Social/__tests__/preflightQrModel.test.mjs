import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreflightQrController, EMPTY_QR_STATE, needsInlineLoginQr } from '../preflightQrModel.js';

const qr = 'data:image/png;base64,fixture';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { resolve, promise };
};

test('only a managed, reachable, logged-out QQ account automatically requests a code', () => {
  const state = { managed: true, connectorStatus: { napcatRunning: true },
    loginProbe: { sessionReady: true, isLogin: false } };
  assert.equal(needsInlineLoginQr(state), true);
  assert.equal(needsInlineLoginQr({ ...state, managed: false }), false);
  assert.equal(needsInlineLoginQr({ ...state, connectorStatus: { napcatRunning: false } }), false);
  assert.equal(needsInlineLoginQr({ ...state, loginProbe: { sessionReady: false } }), false);
  assert.equal(needsInlineLoginQr({ ...state, loginProbe: { sessionReady: true, isLogin: true } }), false);
  assert.equal(needsInlineLoginQr({}), false);
});

test('expired QQ login automatically loads a fresh QR and does not refresh it on each poll', async () => {
  const states = [];
  let refreshes = 0;
  const controller = createPreflightQrController({
    async refreshQr() { refreshes += 1; return { isLogin: false, qrcode: qr }; },
  }, state => states.push(state));
  await controller.start();
  assert.deepEqual(states.map(state => state.phase), ['loading', 'ready']);
  assert.equal(states.at(-1).qrcode, qr);
  await controller.start();
  assert.equal(refreshes, 1);
  await controller.refresh();
  assert.equal(refreshes, 2);
});

test('late QR generation retries reads without repeatedly invalidating the phone scan', async () => {
  let refreshes = 0;
  let reads = 0;
  let state;
  const controller = createPreflightQrController({
    async refreshQr() { refreshes += 1; return { isLogin: false }; },
    async getLoginState() { reads += 1; return reads === 2 ? { qrcode: qr } : {}; },
  }, next => { state = next; }, { delay: async () => {} });
  await controller.start();
  assert.equal(state.phase, 'ready');
  assert.equal(refreshes, 1);
  assert.equal(reads, 2);
});

test('a completed login hides the QR and requests a new preflight report', async () => {
  const logins = [];
  let state;
  const login = { isLogin: true, account: { uin: '123456' } };
  const controller = createPreflightQrController({ async refreshQr() { return login; } },
    next => { state = next; }, { onLogin: result => logins.push(result) });
  await controller.start();
  assert.deepEqual(logins, [login]);
  assert.deepEqual(state, { phase: 'complete', qrcode: null, error: '' });
});

test('unmount, server changes, and a successful status poll invalidate late QR responses', async () => {
  const old = deferred();
  let calls = 0;
  let state;
  const controller = createPreflightQrController({
    refreshQr() { calls += 1; return calls === 1 ? old.promise : Promise.resolve({ qrcode: `${qr}-new` }); },
  }, next => { state = next; });
  const pending = controller.start();
  await Promise.resolve();
  controller.reset();
  assert.equal(state, EMPTY_QR_STATE);
  await controller.start();
  old.resolve({ qrcode: `${qr}-old` });
  await pending;
  assert.equal(state.qrcode, `${qr}-new`);
  controller.reset();
  await controller.refresh();
  assert.equal(calls, 2);
  assert.equal(state.qrcode, null);
});

test('refresh clicks share an in-flight request', async () => {
  const response = deferred();
  let calls = 0;
  const controller = createPreflightQrController({
    refreshQr() { calls += 1; return response.promise; },
  }, () => {});
  const first = controller.start();
  assert.equal(controller.refresh(), first);
  await Promise.resolve();
  response.resolve({ qrcode: qr });
  await first;
  assert.equal(calls, 1);
});

test('QR failures are visible and the refresh button can retry synchronous bridge errors', async () => {
  let state;
  let calls = 0;
  const controller = createPreflightQrController({
    refreshQr() {
      calls += 1;
      if (calls === 1) throw new Error('WebUI requires 2FA');
      return Promise.resolve({ qrcode: qr });
    },
  }, next => { state = next; });
  await controller.start();
  assert.equal(state.phase, 'error');
  assert.equal(state.error, 'WebUI requires 2FA');
  await controller.refresh();
  assert.equal(state.phase, 'ready');
});

test('missing QR has a bounded wait and never silently displays a remote URL', async () => {
  let state;
  let reads = 0;
  const controller = createPreflightQrController({
    async refreshQr() { return { qrcode: 'https://example.invalid/qr' }; },
    async getLoginState() { reads += 1; return {}; },
  }, next => { state = next; }, { attempts: 3, delay: async () => {} });
  await controller.start();
  assert.equal(state.phase, 'error');
  assert.equal(state.qrcode, null);
  assert.equal(reads, 2);
});
