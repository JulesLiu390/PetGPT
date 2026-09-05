/**
 * Preflight model for the Social Agent.
 *
 * The agent's real dependency chain is three levels deep:
 *
 *   NapCat (isolated QQ process, serves OneBot HTTP/WS)
 *     ↑ 127.0.0.1:{http_port} + NAPCAT_ACCESS_TOKEN
 *   QQ MCP server (stdio process)
 *     ↑ batch_get_recent_context / send_message
 *   startSocialLoop
 *
 * `startSocialLoop` only ever ensured the MCP process was spawned, which
 * succeeds even when NapCat is down — the agent then reports "running" while
 * every poll fails. This model derives the whole chain up front so the UI can
 * say what is missing before anything is started.
 *
 * Only servers registered by the built-in QQ connector get NapCat checks. Any
 * other MCP server (Telegram, a custom one) is checked for its process alone.
 */

export const PREFLIGHT_OK = 'ok';
export const PREFLIGHT_BLOCKED = 'blocked';
export const PREFLIGHT_PENDING = 'pending';

export const ACTION_LAUNCH_NAPCAT = 'launch-napcat';
export const ACTION_START_MCP = 'start-mcp';
export const ACTION_QUICK_LOGIN = 'quick-login';
export const ACTION_OPEN_SETUP = 'open-setup';

/** 在线账号描述，e.g. `Nickname · 12345678`。不参与翻译。 */
export function describeOnlineAccount(probe) {
  if (!probe) return '';
  const nickname = String(probe.nickname || '').trim();
  const uin = String(probe.uin || '').trim();
  return [nickname, uin].filter(Boolean).join(' · ');
}

/** The MCP server the connector bound this QQ account to, or null. */
export function findManagedAccount(accounts, mcpServerName) {
  const name = String(mcpServerName || '').trim();
  if (!name || !Array.isArray(accounts)) return null;
  return accounts.find(account => String(account?.serverName || '') === name) || null;
}

/** Human-readable account line, e.g. `Nickname · 12345678`. Never translated. */
export function describeAccount(account) {
  if (!account) return '';
  const nickname = String(account.nickname || '').trim();
  const uin = String(account.uin || '').trim();
  return [nickname, uin].filter(Boolean).join(' · ');
}

/** Runtime provenance line, e.g. `isolated · macos · v4.8.0`. Never translated. */
export function describeRuntime(connectorStatus) {
  if (!connectorStatus) return '';
  const parts = [];
  if (connectorStatus.isolatedRuntime) parts.push('isolated');
  if (connectorStatus.platform) parts.push(String(connectorStatus.platform));
  if (connectorStatus.napcatVersion) parts.push(String(connectorStatus.napcatVersion));
  return parts.join(' · ');
}

const check = (id, label, status, { detail = '', message = '', action = null } = {}) =>
  ({ id, label, status, detail, message, action });

/**
 * Derive the preflight report.
 *
 * `null` for `connectorStatus` / `mcpServerExists` / `mcpRunning` means "not
 * probed yet" and yields a pending check. Pending never blocks Start: a
 * transient probe should not fight the user, only a known-bad state should.
 */
export function buildSocialPreflight({
  mcpServerName = '',
  connectorStatus = null,
  accounts = null,
  mcpServerExists = null,
  mcpRunning = null,
  loginProbe = null,
} = {}) {
  const serverName = String(mcpServerName || '').trim();
  const account = findManagedAccount(accounts, serverName);
  const managed = Boolean(account);
  const checks = [];

  if (!serverName) {
    checks.push(check('server', 'MCP server', PREFLIGHT_BLOCKED, {
      message: 'No MCP server selected. Pick one under Config, or set up the built-in QQ connector first.',
      action: ACTION_OPEN_SETUP,
    }));
    return finalize({ managed, account, checks });
  }

  if (managed) {
    checks.push(check('account', 'QQ account', PREFLIGHT_OK, {
      detail: describeAccount(account),
    }));

    if (!connectorStatus) {
      checks.push(check('runtime', 'Managed runtime', PREFLIGHT_PENDING));
      checks.push(check('napcat', 'NapCat', PREFLIGHT_PENDING));
      checks.push(check('login', 'QQ online', PREFLIGHT_PENDING));
    } else {
      const missingDependencies = connectorStatus.linuxDependencies?.missing || [];
      const runtimeReady = Boolean(connectorStatus.mcpInstalled && connectorStatus.napcatPackageReady && missingDependencies.length === 0);
      checks.push(check('runtime', 'Managed runtime', runtimeReady ? PREFLIGHT_OK : PREFLIGHT_BLOCKED, {
        detail: runtimeReady ? describeRuntime(connectorStatus) : '',
        message: runtimeReady ? '' : missingDependencies.length > 0
          ? 'Linux system dependencies are missing. Open the full setup to install them.'
          : 'Managed runtime is not installed. Open the full setup to download QQ-MCP and NapCat.',
        action: runtimeReady ? null : ACTION_OPEN_SETUP,
      }));

      // NapCat can only be launched once its package exists, so a missing
      // runtime reports as pending here rather than as a second failure.
      if (!runtimeReady) {
        checks.push(check('napcat', 'NapCat', PREFLIGHT_PENDING));
        checks.push(check('login', 'QQ online', PREFLIGHT_PENDING));
      } else {
        const running = Boolean(connectorStatus.napcatRunning);
        checks.push(check('napcat', 'NapCat', running ? PREFLIGHT_OK : PREFLIGHT_BLOCKED, {
          detail: running ? describeRuntime(connectorStatus) : '',
          message: running ? '' : 'NapCat is not running. The agent would poll forever without ever receiving a message.',
          action: running ? null : ACTION_LAUNCH_NAPCAT,
        }));
        checks.push(buildLoginCheck({ napcatRunning: running, loginProbe }));
      }
    }
  }

  if (mcpServerExists === false) {
    checks.push(check('mcp', 'MCP process', PREFLIGHT_BLOCKED, {
      detail: serverName,
      message: `MCP server "${serverName}" no longer exists. Select another server or register it again.`,
      action: ACTION_OPEN_SETUP,
    }));
    return finalize({ managed, account, checks });
  }

  if (mcpServerExists === null || mcpRunning === null) {
    checks.push(check('mcp', 'MCP process', PREFLIGHT_PENDING, { detail: serverName }));
    return finalize({ managed, account, checks });
  }

  checks.push(check('mcp', 'MCP process', mcpRunning ? PREFLIGHT_OK : PREFLIGHT_BLOCKED, {
    detail: serverName,
    message: mcpRunning ? '' : 'The MCP server process is not running.',
    action: mcpRunning ? null : ACTION_START_MCP,
  }));

  return finalize({ managed, account, checks });
}

/**
 * QQ 是否真的在线。
 *
 * 「绑定过某个账号」和「那个账号此刻在线」是两回事：会话过期后 NapCat 照常运行、
 * MCP 照常握手，只有这一项能发现 agent 其实收不到任何消息。
 *
 * 探测不出来时一律 pending —— 问不到不等于没登录，不该据此拦住用户。
 */
function buildLoginCheck({ napcatRunning, loginProbe }) {
  if (!napcatRunning || !loginProbe) return check('login', 'QQ online', PREFLIGHT_PENDING);
  if (!loginProbe.sessionReady) {
    return check('login', 'QQ online', PREFLIGHT_PENDING, { detail: loginProbe.error || '' });
  }
  if (!loginProbe.isLogin) {
    // 先给「用本地会话登一次」的入口；真的登不上时用户还能走旁边的完整设置扫码。
    return check('login', 'QQ online', PREFLIGHT_BLOCKED, {
      detail: loginProbe.error || '',
      message: 'QQ is not logged in. Try signing in with the saved session, or scan the QR code in the full setup.',
      action: ACTION_QUICK_LOGIN,
    });
  }
  if (loginProbe.isOffline) {
    return check('login', 'QQ online', PREFLIGHT_BLOCKED, {
      detail: describeOnlineAccount(loginProbe),
      message: 'QQ is signed in but currently offline. Check the isolated QQ window before starting the agent.',
      action: ACTION_OPEN_SETUP,
    });
  }
  return check('login', 'QQ online', PREFLIGHT_OK, { detail: describeOnlineAccount(loginProbe) });
}

function finalize({ managed, account, checks }) {
  const blocking = checks.filter(entry => entry.status === PREFLIGHT_BLOCKED);
  return {
    managed,
    account,
    checks,
    blocking,
    canStart: blocking.length === 0,
    pending: checks.some(entry => entry.status === PREFLIGHT_PENDING),
    // The first failure in dependency order is the one worth acting on:
    // NapCat being down explains an MCP that will not work either.
    summary: blocking[0]?.message || '',
  };
}
