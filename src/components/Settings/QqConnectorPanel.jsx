import React, { useCallback, useEffect, useState } from 'react';
import { FaArrowUpRightFromSquare, FaCheck, FaDownload, FaPlay, FaRotate, FaStop } from 'react-icons/fa6';
import { Alert, Badge, Button, Card, FormGroup, Input } from '../UI/ui';
import * as tauri from '../../utils/tauri';

const formatBytes = (value) => {
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const errorText = (error) => error?.message || error?.toString?.() || String(error);

const Step = ({ number, title, done, children }) => (
  <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
    <div className="flex items-center gap-2">
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${done ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
        {done ? <FaCheck className="w-3 h-3" /> : number}
      </div>
      <div className="text-sm font-semibold text-slate-800">{title}</div>
    </div>
    {children}
  </div>
);

export default function QqConnectorPanel({ onReady }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [qq, setQq] = useState('');
  const [webuiUrl, setWebuiUrl] = useState('http://127.0.0.1:6099');
  const [webuiToken, setWebuiToken] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [require2fa, setRequire2fa] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginState, setLoginState] = useState(null);
  const [setupResult, setSetupResult] = useState(null);
  const [accounts, setAccounts] = useState([]);

  const refreshStatus = useCallback(async () => {
    const [next, linkedAccounts] = await Promise.all([
      tauri.qqConnector.status(),
      tauri.qqConnector.listAccounts(),
    ]);
    setStatus(next);
    setAccounts(linkedAccounts || []);
    if (next?.webuiUrl) setWebuiUrl(next.webuiUrl);
    return next;
  }, []);

  useEffect(() => {
    refreshStatus().catch((e) => setError(errorText(e)));
    return tauri.qqConnector.onProgress((event) => setProgress(event.payload));
  }, [refreshStatus]);

  const run = async (name, action) => {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      const result = await action();
      await refreshStatus();
      return result;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy('');
    }
  };

  const checkLogin = useCallback(async () => {
    if (!authenticated) return null;
    try {
      const next = await tauri.qqConnector.getLoginState();
      setLoginState(next);
      const accountId = next?.account?.user_id ?? next?.account?.uin;
      if (accountId) setQq(String(accountId));
      return next;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || loginState?.isLogin) return undefined;
    checkLogin();
    const timer = window.setInterval(checkLogin, 2000);
    return () => window.clearInterval(timer);
  }, [authenticated, loginState?.isLogin, checkLogin]);

  const connectWebui = async () => {
    setBusy('webui');
    setError('');
    try {
      const result = await tauri.qqConnector.webuiLogin({
        baseUrl: webuiUrl,
        token: webuiToken,
        totpCode: totpCode || null,
      });
      setRequire2fa(Boolean(result.require2fa));
      setAuthenticated(Boolean(result.authenticated));
      if (result.authenticated) {
        setWebuiToken('');
        setTotpCode('');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  };

  const completeSetup = async () => {
    const result = await run('setup', () => tauri.qqConnector.completeSetup({
      httpPort: 3000,
      wsPort: 3001,
      webuiPort: Number(new URL(webuiUrl).port || 6099),
    }));
    if (result) {
      setSetupResult(result);
      setNotice(`QQ ${result.uin} 已注册为 MCP 服务 ${result.serverName}`);
      await tauri.mcp.emitServersUpdated({ action: 'qq-connector-ready', serverName: result.serverName });
      onReady?.(result);
    }
  };

  const downloading = progress?.downloaded && progress?.total;
  const percentage = downloading ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : 0;
  const nativeLabel = status?.platform === 'linux' ? 'Download NapCat AppImage' : 'Download Native Installer';

  return (
    <Card
      title="Built-in QQ Connector"
      description="Install QQ-MCP and the official native NapCat runtime without Docker. Components are downloaded only when requested."
      action={<Badge tone={setupResult || accounts.length ? 'green' : 'blue'}>{setupResult || accounts.length ? 'Ready' : 'No Docker'}</Badge>}
    >
      <div className="space-y-3">
        {error && <Alert tone="red">{error}</Alert>}
        {notice && <Alert tone="green">{notice}</Alert>}
        {accounts.length > 0 && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
            <div className="text-xs font-semibold text-emerald-800 mb-2">Connected QQ accounts</div>
            <div className="flex flex-wrap gap-2">
              {accounts.map((account) => (
                <Badge key={account.uin} tone="green">
                  {account.nickname || 'QQ'} · {account.uin} → {account.serverName}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {progress && busy && (
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 space-y-2">
            <div className="flex justify-between gap-3 text-xs text-blue-800">
              <span>{progress.message}</span>
              {downloading && <span>{formatBytes(progress.downloaded)} / {formatBytes(progress.total)}</span>}
            </div>
            {downloading && (
              <div className="h-1.5 rounded-full bg-blue-100 overflow-hidden">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${percentage}%` }} />
              </div>
            )}
          </div>
        )}

        <Step number="1" title="Install managed runtimes" done={status?.mcpInstalled && status?.napcatPackageReady}>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={status?.mcpInstalled ? 'secondary' : 'primary'}
              disabled={Boolean(busy)}
              onClick={() => run('mcp', () => tauri.qqConnector.installMcp())}
            >
              <FaDownload className="w-3.5 h-3.5" />
              {status?.mcpInstalled ? 'Update QQ-MCP' : 'Install QQ-MCP'}
            </Button>
            <Button
              type="button"
              variant={status?.napcatPackageReady ? 'secondary' : 'primary'}
              disabled={Boolean(busy)}
              onClick={() => run('napcat', () => tauri.qqConnector.installNapcat())}
            >
              <FaDownload className="w-3.5 h-3.5" />
              {status?.napcatPackageReady ? 'Update Native NapCat' : nativeLabel}
            </Button>
          </div>
          <div className="text-[11px] text-slate-500">
            Platform: {status?.platform || '…'} / {status?.arch || '…'}
            {status?.napcatProvider ? ` · ${status.napcatProvider}` : ''}
          </div>
        </Step>

        <Step number="2" title="Install and start native NapCat" done={status?.napcatRunning || authenticated}>
          <FormGroup label="QQ number" hint="Used when the Windows native launcher supports quick login.">
            <Input value={qq} onChange={(e) => setQq(e.target.value.replace(/\D/g, ''))} placeholder="QQ number" />
          </FormGroup>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" disabled={!status?.napcatPackageReady || Boolean(busy)} onClick={async () => {
              const message = await run('installer', () => tauri.qqConnector.openInstaller());
              if (message) setNotice(message);
            }}>
              <FaArrowUpRightFromSquare className="w-3.5 h-3.5" /> Open Official Installer
            </Button>
            <Button type="button" variant="secondary" disabled={!status?.napcatPackageReady || Boolean(busy)} onClick={() => run('launch', () => tauri.qqConnector.launchNapcat(qq || null))}>
              <FaPlay className="w-3.5 h-3.5" /> Start NapCat
            </Button>
            {status?.napcatRunning && (
              <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => run('stop', () => tauri.qqConnector.stopNapcat())}>
                <FaStop className="w-3.5 h-3.5" /> Stop
              </Button>
            )}
          </div>
          {status?.platform === 'macos' && (
            <Alert tone="yellow">The official macOS installer still requires its guided QQ patch step. PetGPT does not modify QQ application files directly.</Alert>
          )}
        </Step>

        <Step number="3" title="Connect WebUI and scan QR code" done={Boolean(loginState?.isLogin)}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormGroup label="NapCat WebUI URL">
              <Input value={webuiUrl} onChange={(e) => setWebuiUrl(e.target.value)} />
            </FormGroup>
            <FormGroup label="WebUI token" hint="Shown by NapCat at startup; it is used only to obtain a one-hour local credential.">
              <Input type="password" value={webuiToken} onChange={(e) => setWebuiToken(e.target.value)} />
            </FormGroup>
          </div>
          {require2fa && (
            <FormGroup label="2FA code">
              <Input value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </FormGroup>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={Boolean(busy) || (!authenticated && !webuiToken)} onClick={connectWebui}>
              {authenticated ? 'Reconnect WebUI' : 'Connect WebUI'}
            </Button>
            {authenticated && (
              <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={checkLogin}>
                <FaRotate className="w-3.5 h-3.5" /> Check login
              </Button>
            )}
            {authenticated && !loginState?.isLogin && (
              <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={async () => {
                const next = await run('qr', () => tauri.qqConnector.refreshQr());
                if (next) setLoginState(next);
              }}>
                Refresh QR
              </Button>
            )}
          </div>
          {loginState?.qrcode && !loginState.isLogin && (
            <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-3">
              <img src={loginState.qrcode} alt="QQ login QR code" className="w-36 h-36 rounded-lg border border-slate-100" />
              <div className="text-xs text-slate-600 leading-relaxed">Open QQ on your phone and scan this code. PetGPT checks the local login state automatically.</div>
            </div>
          )}
          {loginState?.isLogin && (
            <Alert tone="green">QQ logged in: {loginState.account?.nickname || qq || 'connected account'}</Alert>
          )}
        </Step>

        <Step number="4" title="Configure OneBot and register MCP" done={Boolean(setupResult || accounts.length)}>
          <Alert tone="blue">PetGPT will create localhost-only HTTP/WS adapters with a random token, then validate the required Social Agent tool contract.</Alert>
          <Button type="button" disabled={Boolean(busy) || !status?.mcpInstalled || !loginState?.isLogin} onClick={completeSetup}>
            <FaCheck className="w-3.5 h-3.5" /> Configure and Add MCP
          </Button>
        </Step>
      </div>
    </Card>
  );
}
