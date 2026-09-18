import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaCheck, FaChevronDown, FaChevronUp, FaPlay, FaRotate, FaXmark } from 'react-icons/fa6';
import { Button } from '../UI/ui';
import * as tauri from '../../utils/tauri';
import InlineQqLogin from './InlineQqLogin.jsx';
import { createPreflightQrController, EMPTY_QR_STATE, needsInlineLoginQr } from './preflightQrModel.js';
import {
  ACTION_LAUNCH_NAPCAT,
  ACTION_OPEN_SETUP,
  ACTION_SCAN_QR,
  ACTION_START_MCP,
  PREFLIGHT_BLOCKED,
  PREFLIGHT_OK,
  buildSocialPreflight,
  findManagedAccount,
} from './socialPreflightModel';

const POLL_INTERVAL_MS = 5000;

const errorText = (error) => error?.message || error?.toString?.() || String(error);

const DOT_TONES = {
  [PREFLIGHT_OK]: 'bg-emerald-500',
  [PREFLIGHT_BLOCKED]: 'bg-rose-500',
};

const ROW_TONES = {
  [PREFLIGHT_OK]: 'text-emerald-700',
  [PREFLIGHT_BLOCKED]: 'text-rose-700',
};

const StatusDot = ({ status }) => (
  <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT_TONES[status] || 'bg-slate-300'}`} />
);

const RowIcon = ({ status }) => {
  if (status === PREFLIGHT_OK) return <FaCheck className="w-3 h-3 text-emerald-600 shrink-0" />;
  if (status === PREFLIGHT_BLOCKED) return <FaXmark className="w-3 h-3 text-rose-600 shrink-0" />;
  return <span className="w-3 h-3 rounded-full border border-slate-300 shrink-0" />;
};

/**
 * Dependency-chain preflight for the Social Agent.
 *
 * Starting the agent only ever guaranteed the MCP process was spawned, which
 * succeeds even when NapCat is down — the agent then reports "running" while
 * every poll fails silently. This bar surfaces the whole chain and exposes the
 * one recurring action (starting NapCat) next to the Start button. First-time
 * installation stays in the full connector wizard under Settings → MCP.
 */
export default function SocialPreflightBar({ mcpServerName, onReportChange, className = '' }) {
  const [connectorStatus, setConnectorStatus] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [loginProbe, setLoginProbe] = useState(null);
  const [probedServer, setProbedServer] = useState(null);
  const [mcpServerExists, setMcpServerExists] = useState(null);
  const [mcpRunning, setMcpRunning] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [qrState, setQrState] = useState(EMPTY_QR_STATE);
  const selectedServer = useRef(mcpServerName);
  selectedServer.current = mcpServerName;

  // Probes race with each other when the server selection changes mid-flight;
  // only the newest one is allowed to publish.
  const probeSeq = useRef(0);
  // 自动快速登录每次掉线只尝试一次，成功上线或重启后重新武装。
  const quickLoginTried = useRef(false);
  const probeInFlight = useRef(null);

  const probe = useCallback(() => {
    if (selectedServer.current !== mcpServerName) return Promise.resolve();
    if (probeInFlight.current?.server === mcpServerName) return probeInFlight.current.promise;
    const seq = ++probeSeq.current;
    const isCurrent = () => probeSeq.current === seq && selectedServer.current === mcpServerName;
    const publish = (setter, value) => {
      if (isCurrent()) setter(value);
    };

    const promise = (async () => {
      const [status, linkedAccounts] = await Promise.all([
        tauri.qqConnector.status().catch(() => null),
        tauri.qqConnector.listAccounts().catch(() => null),
      ]);
      if (!isCurrent()) return;
      publish(setConnectorStatus, status);
      publish(setAccounts, linkedAccounts);

      // Only touch QQ login for the selected managed account while NapCat is
      // running. A custom MCP server must not trigger a QQ sign-in flow.
      if (status?.napcatRunning && findManagedAccount(linkedAccounts, mcpServerName)) {
        let nextProbe = await tauri.qqConnector.loginProbe().catch(() => null);
        if (!isCurrent()) return;
        if (nextProbe?.sessionReady && !nextProbe.isLogin && !quickLoginTried.current) {
          quickLoginTried.current = true;
          nextProbe = await tauri.qqConnector.ensureLogin().catch(() => nextProbe);
        }
        if (!isCurrent()) return;
        if (nextProbe?.isLogin) quickLoginTried.current = false;
        publish(setLoginProbe, nextProbe);
      } else {
        quickLoginTried.current = false;
        publish(setLoginProbe, null);
      }
      publish(setProbedServer, mcpServerName);

      const name = String(mcpServerName || '').trim();
      if (!name) {
        publish(setMcpServerExists, null);
        publish(setMcpRunning, null);
        return;
      }
      try {
        const server = await tauri.mcp.getServerByName(name);
        if (!server?._id) {
          publish(setMcpServerExists, false);
          publish(setMcpRunning, null);
          return;
        }
        publish(setMcpServerExists, true);
        publish(setMcpRunning, Boolean(await tauri.mcp.isServerRunning(server._id)));
      } catch {
        publish(setMcpServerExists, null);
        publish(setMcpRunning, null);
      }
    })().finally(() => {
      if (probeInFlight.current?.seq === seq) probeInFlight.current = null;
    });
    probeInFlight.current = { server: mcpServerName, seq, promise };
    return promise;
  }, [mcpServerName]);

  // Reset to "not probed yet" on server change so the bar never shows the
  // previous server's chain against the new name.
  useEffect(() => {
    setMcpServerExists(null);
    setMcpRunning(null);
    setConnectorStatus(null);
    setAccounts(null);
    setLoginProbe(null);
    setProbedServer(null);
    quickLoginTried.current = false;
    setError('');
  }, [mcpServerName]);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const tick = async () => {
      await probe();
      if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      probeSeq.current += 1;
      probeInFlight.current = null;
    };
  }, [probe]);

  const report = useMemo(() => buildSocialPreflight({
    mcpServerName,
    connectorStatus,
    accounts,
    mcpServerExists,
    mcpRunning,
    loginProbe: probedServer === mcpServerName ? loginProbe : null,
  }), [mcpServerName, connectorStatus, accounts, mcpServerExists, mcpRunning, loginProbe, probedServer]);

  const qrNeeded = probedServer === mcpServerName
    && needsInlineLoginQr({ managed: report.managed, connectorStatus, loginProbe });
  const qrController = useMemo(() => createPreflightQrController(tauri.qqConnector, setQrState, {
    onLogin: () => { probe(); },
  }), [probe]);

  useEffect(() => {
    if (qrNeeded) {
      setExpanded(true);
      qrController.start();
    } else {
      qrController.reset();
    }
    return () => qrController.reset();
  }, [qrController, qrNeeded]);

  useEffect(() => {
    onReportChange?.(report);
  }, [report, onReportChange]);

  // A failing chain is worth showing without a click; a healthy one stays quiet.
  const autoExpandedFor = useRef(null);
  useEffect(() => {
    const key = report.blocking.map(entry => entry.id).join(',');
    if (!key || autoExpandedFor.current === key) return;
    autoExpandedFor.current = key;
    setExpanded(true);
  }, [report.blocking]);

  const run = async (name, action) => {
    setBusy(name);
    setError('');
    try {
      await action();
      await probe();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  };

  const launchNapcat = () => run(ACTION_LAUNCH_NAPCAT, () => tauri.qqConnector.launchNapcat(null));

  const startMcp = () => run(ACTION_START_MCP, async () => {
    const server = await tauri.mcp.getServerByName(String(mcpServerName || '').trim());
    if (!server?._id) throw new Error(`MCP server "${mcpServerName}" not found`);
    await tauri.mcp.startServer(server._id);
  });

  const openSetup = () => tauri.openManageWindowWithTab('mcp').catch(e => setError(errorText(e)));

  const runAction = (action) => {
    if (action === ACTION_LAUNCH_NAPCAT) return launchNapcat();
    if (action === ACTION_START_MCP) return startMcp();
    if (action === ACTION_OPEN_SETUP) return openSetup();
    return undefined;
  };

  const actionLabels = {
    [ACTION_LAUNCH_NAPCAT]: 'Start NapCat',
    [ACTION_START_MCP]: 'Start MCP',
    [ACTION_OPEN_SETUP]: 'Open Full Setup',
  };

  // One button per distinct remedy, in dependency order.
  const remedies = [];
  for (const entry of report.blocking) {
    // The QR card is automatic and has its own refresh action.
    if (entry.action === ACTION_SCAN_QR) continue;
    if (entry.action && !remedies.includes(entry.action)) remedies.push(entry.action);
  }
  if (!remedies.includes(ACTION_OPEN_SETUP)) remedies.push(ACTION_OPEN_SETUP);

  return (
    <div className={`border-b border-slate-100 bg-slate-50/60 ${className}`}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-slate-100/70 transition"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Preflight</span>
        <span className="flex items-center gap-2.5">
          {report.checks.map(entry => (
            <span key={entry.id} className={`inline-flex items-center gap-1 text-[11px] ${ROW_TONES[entry.status] || 'text-slate-400'}`}>
              <StatusDot status={entry.status} />
              {entry.label}
            </span>
          ))}

        </span>
        <span className="flex-1" />
        {!report.canStart && (
          <span className="text-[11px] font-medium text-rose-600">Not ready</span>
        )}
        {expanded
          ? <FaChevronUp className="w-3 h-3 text-slate-400" />
          : <FaChevronDown className="w-3 h-3 text-slate-400" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {report.checks.map(entry => (
            <div key={entry.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5"><RowIcon status={entry.status} /></span>
              <span className="min-w-0">
                <span className={`font-medium ${ROW_TONES[entry.status] || 'text-slate-500'}`}>{entry.label}</span>
                {entry.detail && (
                  <span className="text-slate-500" data-i18n-ignore> — {entry.detail}</span>
                )}
                {entry.status === PREFLIGHT_BLOCKED && entry.message && (
                  <div className="text-slate-600 mt-0.5">{entry.message}</div>
                )}
              </span>
            </div>
          ))}

          {qrNeeded && <InlineQqLogin state={qrState} account={report.account} onRefresh={qrController.refresh} />}

          {error && <div className="text-xs text-rose-600" data-i18n-ignore>{error}</div>}

          <div className="flex flex-wrap gap-2 pt-1">
            {remedies.map(action => (
              <Button
                key={action}
                type="button"
                variant={action === ACTION_OPEN_SETUP ? 'ghost' : 'secondary'}
                className="!px-2.5 !py-1 !text-xs"
                disabled={Boolean(busy)}
                onClick={() => runAction(action)}
              >
                {busy === action
                  ? <FaRotate className="w-3 h-3 animate-spin" />
                  : action !== ACTION_OPEN_SETUP && <FaPlay className="w-3 h-3" />}
                {actionLabels[action]}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              className="!px-2.5 !py-1 !text-xs"
              disabled={Boolean(busy)}
              onClick={() => run('refresh', probe)}
            >
              <FaRotate className={`w-3 h-3 ${busy === 'refresh' ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
