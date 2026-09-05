import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_LAUNCH_NAPCAT,
  ACTION_OPEN_SETUP,
  ACTION_QUICK_LOGIN,
  ACTION_START_MCP,
  PREFLIGHT_BLOCKED,
  PREFLIGHT_OK,
  PREFLIGHT_PENDING,
  buildSocialPreflight,
  describeAccount,
  describeOnlineAccount,
  describeRuntime,
  findManagedAccount,
} from '../socialPreflightModel.js';

const onlineProbe = {
  sessionReady: true,
  isLogin: true,
  isOffline: false,
  uin: '12345678',
  nickname: '小助手',
};

const accounts = [
  { uin: '12345678', nickname: '小助手', serverName: 'qq-12345678' },
  { uin: '87654321', nickname: '', serverName: 'qq-87654321' },
];

const readyStatus = {
  platform: 'macos',
  mcpInstalled: true,
  napcatPackageReady: true,
  napcatRunning: true,
  isolatedRuntime: true,
  napcatVersion: 'v4.8.0',
};

const statusOf = (report, id) => report.checks.find(entry => entry.id === id);

test('matches a managed account by its bound MCP server name', () => {
  assert.equal(findManagedAccount(accounts, 'qq-12345678')?.uin, '12345678');
  assert.equal(findManagedAccount(accounts, 'telegram'), null);
  assert.equal(findManagedAccount(accounts, ''), null);
  assert.equal(findManagedAccount(null, 'qq-12345678'), null);
});

test('formats account and runtime detail lines without empty separators', () => {
  assert.equal(describeAccount(accounts[0]), '小助手 · 12345678');
  assert.equal(describeAccount(accounts[1]), '87654321');
  assert.equal(describeAccount(null), '');
  assert.equal(describeRuntime(readyStatus), 'isolated · macos · v4.8.0');
  assert.equal(describeRuntime({ platform: 'linux' }), 'linux');
  assert.equal(describeRuntime(null), '');
});

test('a fully ready managed chain allows Start', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: readyStatus,
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
    loginProbe: onlineProbe,
  });

  assert.equal(report.managed, true);
  assert.equal(report.canStart, true);
  assert.equal(report.pending, false);
  assert.deepEqual(report.checks.map(entry => entry.id), ['account', 'runtime', 'napcat', 'login', 'mcp']);
  assert.ok(report.checks.every(entry => entry.status === PREFLIGHT_OK));
  assert.equal(report.summary, '');
});

test('a stopped NapCat blocks Start and offers an inline launch', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: { ...readyStatus, napcatRunning: false },
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
  });

  assert.equal(report.canStart, false);
  assert.equal(statusOf(report, 'napcat').status, PREFLIGHT_BLOCKED);
  assert.equal(statusOf(report, 'napcat').action, ACTION_LAUNCH_NAPCAT);
  assert.match(report.summary, /NapCat is not running/);
});

test('NapCat reports pending rather than a second failure when the runtime is missing', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: { ...readyStatus, napcatPackageReady: false, napcatRunning: false },
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
  });

  assert.equal(statusOf(report, 'runtime').status, PREFLIGHT_BLOCKED);
  assert.equal(statusOf(report, 'runtime').action, ACTION_OPEN_SETUP);
  assert.equal(statusOf(report, 'napcat').status, PREFLIGHT_PENDING);
  assert.equal(report.blocking.length, 1);
  assert.match(report.summary, /Managed runtime is not installed/);
});

test('reports the first failure in dependency order, not the last', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: { ...readyStatus, napcatRunning: false },
    accounts,
    mcpServerExists: true,
    mcpRunning: false,
  });

  assert.deepEqual(report.blocking.map(entry => entry.id), ['napcat', 'mcp']);
  assert.match(report.summary, /NapCat is not running/);
});

test('missing Linux dependencies route to setup instead of offering a failing launch', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: { ...readyStatus, platform: 'linux', napcatRunning: false,
      linuxDependencies: { missing: ['Xvfb', 'xauth'], canInstall: true } },
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
  });
  assert.equal(report.canStart, false);
  assert.equal(statusOf(report, 'runtime').action, ACTION_OPEN_SETUP);
  assert.equal(statusOf(report, 'napcat').status, PREFLIGHT_PENDING);
  assert.match(report.summary, /Linux system dependencies are missing/);
});

test('a fully provisioned Linux runtime follows the same ready path as macOS', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: { ...readyStatus, platform: 'linux', linuxDependencies: { missing: [] } },
    accounts, mcpServerExists: true, mcpRunning: true, loginProbe: onlineProbe,
  });
  assert.equal(report.canStart, true);
  assert.equal(report.pending, false);
});

test('a non-connector MCP server is checked for its process alone', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'telegram',
    connectorStatus: null,
    accounts,
    mcpServerExists: true,
    mcpRunning: false,
  });

  assert.equal(report.managed, false);
  assert.equal(report.account, null);
  assert.deepEqual(report.checks.map(entry => entry.id), ['mcp']);
  assert.equal(statusOf(report, 'mcp').action, ACTION_START_MCP);
  assert.equal(report.canStart, false);
});

test('an unprobed chain stays pending and does not block Start', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: null,
    accounts,
    mcpServerExists: null,
    mcpRunning: null,
  });

  assert.equal(report.canStart, true);
  assert.equal(report.pending, true);
  assert.deepEqual(
    report.checks.filter(entry => entry.status === PREFLIGHT_PENDING).map(entry => entry.id),
    ['runtime', 'napcat', 'login', 'mcp'],
  );
});

test('an expired QQ session blocks Start and sends the user to scan a QR code', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: readyStatus,
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
    loginProbe: { sessionReady: true, isLogin: false, isOffline: false },
  });

  assert.equal(report.canStart, false);
  assert.equal(statusOf(report, 'login').status, PREFLIGHT_BLOCKED);
  assert.equal(statusOf(report, 'login').action, ACTION_QUICK_LOGIN);
  assert.match(report.summary, /QQ is not logged in/);
  // The binding row still reads OK: "bound once" and "online now" are different facts.
  assert.equal(statusOf(report, 'account').status, PREFLIGHT_OK);
});

test('a signed-in but offline QQ blocks Start', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: readyStatus,
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
    loginProbe: { ...onlineProbe, isOffline: true },
  });

  assert.equal(report.canStart, false);
  assert.match(report.summary, /currently offline/);
  assert.equal(statusOf(report, 'login').detail, '小助手 · 12345678');
});

test('an unreachable WebUI session reports pending, never a false offline', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: readyStatus,
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
    loginProbe: { sessionReady: false, isLogin: false, error: '连接 NapCat WebUI 失败' },
  });

  assert.equal(statusOf(report, 'login').status, PREFLIGHT_PENDING);
  assert.equal(statusOf(report, 'login').detail, '连接 NapCat WebUI 失败');
  assert.equal(report.canStart, true);
});

test('login stays pending while NapCat is down — the NapCat row is the actionable one', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: { ...readyStatus, napcatRunning: false },
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
    loginProbe: onlineProbe,
  });

  assert.equal(statusOf(report, 'login').status, PREFLIGHT_PENDING);
  assert.deepEqual(report.blocking.map(entry => entry.id), ['napcat']);
});

test('a non-connector MCP server never gets a QQ login row', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'telegram',
    connectorStatus: readyStatus,
    accounts,
    mcpServerExists: true,
    mcpRunning: true,
    loginProbe: { sessionReady: true, isLogin: false },
  });

  assert.deepEqual(report.checks.map(entry => entry.id), ['mcp']);
  assert.equal(report.canStart, true);
});

test('formats the online account line from probe fields', () => {
  assert.equal(describeOnlineAccount(onlineProbe), '小助手 · 12345678');
  assert.equal(describeOnlineAccount({ uin: '999' }), '999');
  assert.equal(describeOnlineAccount(null), '');
});

test('no selected server blocks Start and points at the setup wizard', () => {
  const report = buildSocialPreflight({ accounts, connectorStatus: readyStatus });

  assert.equal(report.canStart, false);
  assert.deepEqual(report.checks.map(entry => entry.id), ['server']);
  assert.equal(report.checks[0].action, ACTION_OPEN_SETUP);
});

test('a selected server missing from the database blocks Start', () => {
  const report = buildSocialPreflight({
    mcpServerName: 'qq-12345678',
    connectorStatus: readyStatus,
    accounts,
    mcpServerExists: false,
    mcpRunning: null,
  });

  assert.equal(report.canStart, false);
  assert.equal(statusOf(report, 'mcp').status, PREFLIGHT_BLOCKED);
  assert.match(report.summary, /no longer exists/);
});

test('defaults to a blocked report when called with no input', () => {
  const report = buildSocialPreflight();
  assert.equal(report.canStart, false);
  assert.equal(report.managed, false);
});
