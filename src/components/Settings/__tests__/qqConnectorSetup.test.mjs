import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAndConnectNapcat } from '../qqConnectorSetup.js';

test('managed startup waits for readiness then connects with the returned token', async () => {
  const calls = [];
  const launch = { webuiToken: 'private-token', logPath: '/private/log' };
  const session = { authenticated: true, require2fa: false };
  const result = await startAndConnectNapcat({
    async launchNapcat(qq) { calls.push(['launch', qq]); return launch; },
    async webuiLogin(request) { calls.push(['login', request]); return session; },
  }, { qq: '123456', managed: true });
  assert.deepEqual(calls, [
    ['launch', '123456'],
    ['login', { baseUrl: 'http://127.0.0.1:6099', token: 'private-token', totpCode: null }],
  ]);
  assert.deepEqual(result, { launch, session });
});

test('startup failure does not authenticate against a possibly unrelated WebUI', async () => {
  let attemptedLogin = false;
  await assert.rejects(startAndConnectNapcat({
    async launchNapcat() { throw new Error('port already in use'); },
    async webuiLogin() { attemptedLogin = true; },
  }, { managed: true }), /port already in use/);
  assert.equal(attemptedLogin, false);
});

test('recovered runtimes can use the saved backend token and still require 2FA', async () => {
  const session = { authenticated: false, require2fa: true };
  const result = await startAndConnectNapcat({
    async launchNapcat(qq) { assert.equal(qq, null); return {}; },
    async webuiLogin(request) {
      assert.equal(request.token, '');
      assert.equal(request.totpCode, null);
      return session;
    },
  }, { managed: true });
  assert.deepEqual(result.session, session);
});

test('authentication failure preserves the successful launch for manual reconnect', async () => {
  const launch = { webuiToken: 'private-token', logPath: '/private/log' };
  const result = await startAndConnectNapcat({
    async launchNapcat() { return launch; },
    async webuiLogin() { throw new Error('credential rejected'); },
  }, { managed: true });
  assert.equal(result.launch, launch);
  assert.equal(result.connectionError, 'credential rejected');
  assert.equal(result.session, undefined);
});

test('Windows native installer retains manual WebUI authentication', async () => {
  const launch = { webuiToken: null };
  const result = await startAndConnectNapcat({
    async launchNapcat() { return launch; },
    async webuiLogin() { assert.fail('must not auto-connect unmanaged runtime'); },
  }, { managed: false });
  assert.deepEqual(result, { launch });
});
