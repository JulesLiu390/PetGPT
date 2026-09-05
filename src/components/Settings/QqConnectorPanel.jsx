import React, { useCallback, useEffect, useState } from 'react';
import { FaArrowUpRightFromSquare, FaCheck, FaDownload, FaPlay, FaRotate, FaStop } from 'react-icons/fa6';
import { Alert, Badge, Button, Card, FormGroup, Input } from '../UI/ui';
import * as tauri from '../../utils/tauri';
import { useI18n } from '../../i18n/context.js';
import { startAndConnectNapcat } from './qqConnectorSetup.js';

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
  const { t } = useI18n();
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
    setProgress(null);
    try {
      const result = await action();
      await refreshStatus();
      return result;
    } catch (e) {
      setError(errorText(e));
      await refreshStatus().catch(() => {});
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

  useEffect(() => {
    if (!status?.napcatRunning) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const next = await tauri.qqConnector.status();
        setStatus(next);
        if (!next.napcatRunning) {
          setAuthenticated(false);
          setLoginState(null);
        }
      } catch {
        // Keep the last known state; normal actions surface connector errors.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [status?.napcatRunning]);

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
  const isMac = status?.platform === 'macos';
  const isLinux = status?.platform === 'linux';
  const isManaged = isMac || isLinux;
  const dependencies = status?.linuxDependencies;
  const missingDependencies = dependencies?.missing || [];
  const nativeLabel = t(isMac
    ? 'Prepare Isolated QQ + NapCat'
    : status?.platform === 'linux' ? 'Download NapCat AppImage' : 'Download Native Installer');
  const updateNativeLabel = t(isMac ? 'Rebuild Isolated QQ + Update NapCat' : 'Update Native NapCat');

  const launchNapcat = async () => {
    setAuthenticated(false);
    setLoginState(null);
    setRequire2fa(false);
    const result = await run('launch', () => {
      setProgress({ message: 'Starting NapCat and waiting for WebUI. First launch may take up to 60 seconds.' });
      return startAndConnectNapcat(tauri.qqConnector, { qq, managed: isManaged });
    });
    if (result?.launch?.webuiToken) {
      setWebuiToken(result.launch.webuiToken);
      setWebuiUrl('http://127.0.0.1:6099');
    }
    if (result?.session) {
      setAuthenticated(Boolean(result.session.authenticated));
      setRequire2fa(Boolean(result.session.require2fa));
      if (result.session.authenticated) {
        setTotpCode('');
        setNotice(t('NapCat started and WebUI connected. Scan the QR code to sign in.'));
      }
    }
    if (result?.connectionError) {
      setError(result.connectionError);
    }
  };

  return (
    <Card
      title={t('Built-in QQ Connector')}
      description={t('Install QQ-MCP and the official native NapCat runtime without Docker. Components are downloaded only when requested.')}
      action={<Badge tone={setupResult || accounts.length ? 'green' : 'blue'}>{t(setupResult || accounts.length ? 'Ready' : 'No Docker')}</Badge>}
    >
      <div className="space-y-3">
        {error && <Alert tone="red">{t(error)}</Alert>}
        {notice && <Alert tone="green">{t(notice)}</Alert>}
        {accounts.length > 0 && (
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
            <div className="text-xs font-semibold text-emerald-800 mb-2">{t('Connected QQ accounts')}</div>
            <div className="flex flex-wrap gap-2">
              {accounts.map((account) => (
                <Badge key={account.uin} tone="green">
                  <span data-i18n-ignore>{account.nickname || 'QQ'} · {account.uin} → {account.serverName}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}
        {progress && busy && (
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 space-y-2">
            <div className="flex justify-between gap-3 text-xs text-blue-800">
              <span>{t(progress.message)}</span>
              {downloading && <span>{formatBytes(progress.downloaded)} / {formatBytes(progress.total)}</span>}
            </div>
            {downloading && (
              <div className="h-1.5 rounded-full bg-blue-100 overflow-hidden">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${percentage}%` }} />
              </div>
            )}
          </div>
        )}

        <Step number="1" title={t('Install managed runtimes')} done={status?.mcpInstalled && status?.napcatPackageReady && missingDependencies.length === 0}>
          {isLinux && missingDependencies.length > 0 && (
            <div className="space-y-2 mb-3">
              <Alert tone="yellow">
                {t('Linux system dependencies are missing:')} <span data-i18n-ignore>{missingDependencies.join(', ')}</span>
                <div>{t('Install them below. Your system may ask for an administrator password.')}</div>
              </Alert>
              <Button type="button" disabled={Boolean(busy) || !dependencies?.canInstall}
                onClick={() => run('dependencies', () => tauri.qqConnector.installLinuxDependencies())}>
                <FaDownload className="w-3.5 h-3.5" /> {t('Install Linux Dependencies')}
              </Button>
              {!dependencies?.canInstall && <div className="text-xs text-slate-600">
                {t('Automatic installation is unavailable. Install Xvfb, xvfb-run, xauth and libgbm with your package manager.')}
              </div>}
              {dependencies?.manualCommand && <details className="text-xs text-slate-500">
                <summary className="cursor-pointer">{t('Manual installation command')}</summary>
                <code data-i18n-ignore className="block mt-2 break-all select-text">{dependencies.manualCommand}</code>
              </details>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={status?.mcpInstalled ? 'secondary' : 'primary'}
              disabled={Boolean(busy)}
              onClick={() => run('mcp', () => tauri.qqConnector.installMcp())}
            >
              <FaDownload className="w-3.5 h-3.5" />
              {t(status?.mcpInstalled ? 'Update QQ-MCP' : 'Install QQ-MCP')}
            </Button>
            <Button
              type="button"
              variant={status?.napcatPackageReady ? 'secondary' : 'primary'}
              disabled={Boolean(busy)}
              onClick={() => run('napcat', () => tauri.qqConnector.installNapcat())}
            >
              <FaDownload className="w-3.5 h-3.5" />
              {status?.napcatPackageReady ? updateNativeLabel : nativeLabel}
            </Button>
          </div>
          <div className="text-[11px] text-slate-500">
            {t('Platform:')} {status?.platform || '…'} / {status?.arch || '…'}
            {status?.napcatProvider ? ` · ${status.napcatProvider}` : ''}
          </div>
          {isMac && status?.isolatedRuntime && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 p-3 space-y-1 text-[11px] text-emerald-900">
              <div className="font-semibold">{t('Isolated runtime ready')}</div>
              <div>{t('Source QQ:')} <span data-i18n-ignore>{status.sourceQqVersion || 'QQ'} · /Applications/QQ.app</span></div>
              <div className="break-all">{t('Private copy:')} <span data-i18n-ignore>{status.isolatedQqApp}</span></div>
              <div className="break-all">{t('Dedicated data:')} <span data-i18n-ignore>{status.isolatedProfileDir}</span></div>
              <div>{t('App identity:')} <span data-i18n-ignore>{status.isolatedBundleId}</span></div>
            </div>
          )}
        </Step>

        <Step number="2" title={t(isManaged ? 'Start isolated QQ + NapCat' : 'Install and start native NapCat')} done={status?.napcatRunning || authenticated}>
          <FormGroup label={t('QQ number')} hint={t(isManaged ? 'Optional quick-login account for the isolated QQ instance.' : 'Used when the Windows native launcher supports quick login.')}>
            <Input value={qq} onChange={(e) => setQq(e.target.value.replace(/\D/g, ''))} placeholder={t('QQ number')} />
          </FormGroup>
          <div className="flex flex-wrap gap-2">
            {!isLinux && <Button type="button" variant="secondary" disabled={!status?.napcatPackageReady || Boolean(busy)} onClick={async () => {
              const message = await run('installer', () => tauri.qqConnector.openInstaller());
              if (message) setNotice(message);
            }}>
              <FaArrowUpRightFromSquare className="w-3.5 h-3.5" /> {t(isMac ? 'Show Isolated QQ in Finder' : 'Open Official Installer')}
            </Button>}
            <Button type="button" variant="secondary" disabled={!status?.napcatPackageReady || Boolean(busy) || status?.napcatRunning || missingDependencies.length > 0} onClick={launchNapcat}>
              <FaPlay className="w-3.5 h-3.5" /> {t(isMac ? 'Start Isolated NapCat' : 'Start NapCat')}
            </Button>
            {status?.napcatRunning && (
              <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => run('stop', async () => {
                await tauri.qqConnector.stopNapcat();
                setAuthenticated(false);
                setLoginState(null);
                setRequire2fa(false);
              })}>
                <FaStop className="w-3.5 h-3.5" /> {t('Stop')}
              </Button>
            )}
          </div>
          {isLinux && <Alert tone="blue">{t('QQ and NapCat use a private data directory. No separate QQ installation or FUSE setup is needed.')}</Alert>}
          {isLinux && <Alert tone="yellow">{t('NapCat runs with the Electron sandbox disabled. A separate data directory is not a security sandbox; consider using a dedicated QQ account.')}</Alert>}
          {isLinux && status?.isolatedProfileDir && <div className="text-[11px] text-slate-500 break-all">
            {t('Dedicated data:')} <span data-i18n-ignore>{status.isolatedProfileDir}</span>
          </div>}
          {status?.logPath && <div className="text-[11px] text-slate-500 break-all">
            {t('Startup log:')} <span data-i18n-ignore>{status.logPath}</span>
          </div>}
          {isMac && (
            <Alert tone="blue">{t('PetGPT patches only its private QQ copy. /Applications/QQ.app remains untouched; the isolated copy uses a separate app identity, profile, and hot-update directory and can run alongside original QQ.')}</Alert>
          )}
          {isMac && (
            <Alert tone="yellow">{t('NapCat requires the isolated copy to run with Electron and macOS app sandboxes disabled. Use a dedicated QQ account if account or security isolation is important.')}</Alert>
          )}
        </Step>

        <Step number="3" title={t('Connect WebUI and scan QR code')} done={Boolean(loginState?.isLogin)}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormGroup label={t('NapCat WebUI URL')}>
              <Input value={webuiUrl} onChange={(e) => setWebuiUrl(e.target.value)} />
            </FormGroup>
            <FormGroup label={t('WebUI token')} hint={t(authenticated
              ? 'WebUI is connected. The token is retained only in this window for reconnecting.'
              : isManaged ? 'Generated and filled automatically when managed NapCat starts; it is used only to obtain a one-hour local credential.'
                : 'Shown by NapCat at startup; it is used only to obtain a one-hour local credential.')}>
              <Input type="password" value={webuiToken} onChange={(e) => setWebuiToken(e.target.value)} placeholder={t(isManaged ? 'Generated automatically when NapCat starts' : 'WebUI token')} />
            </FormGroup>
          </div>
          {require2fa && (
            <FormGroup label={t('2FA code')}>
              <Input value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </FormGroup>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={Boolean(busy) || (!authenticated && !webuiToken && !(isManaged && status?.napcatRunning))} onClick={connectWebui}>
              {t(authenticated ? 'Reconnect WebUI' : 'Connect WebUI')}
            </Button>
            {authenticated && (
              <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={checkLogin}>
                <FaRotate className="w-3.5 h-3.5" /> {t('Check login')}
              </Button>
            )}
            {authenticated && !loginState?.isLogin && (
              <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={async () => {
                const next = await run('qr', () => tauri.qqConnector.refreshQr());
                if (next) setLoginState(next);
              }}>
                {t('Refresh QR')}
              </Button>
            )}
          </div>
          {loginState?.qrcode && !loginState.isLogin && (
            <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-3">
              <img src={loginState.qrcode} alt={t('QQ login QR code')} className="w-36 h-36 rounded-lg border border-slate-100" />
              <div className="text-xs text-slate-600 leading-relaxed">{t('Open QQ on your phone and scan this code. PetGPT checks the local login state automatically.')}</div>
            </div>
          )}
          {loginState?.isLogin && (
            <Alert tone="green">{t(`QQ logged in: ${loginState.account?.nickname || qq || 'connected account'}`)}</Alert>
          )}
        </Step>

        <Step number="4" title={t('Configure OneBot and register MCP')} done={Boolean(setupResult || accounts.length)}>
          <Alert tone="blue">{t('PetGPT will create localhost-only HTTP/WS adapters with a random token, then validate the required Social Agent tool contract.')}</Alert>
          <Button type="button" disabled={Boolean(busy) || !status?.mcpInstalled || !loginState?.isLogin} onClick={completeSetup}>
            <FaCheck className="w-3.5 h-3.5" /> {t('Configure and Add MCP')}
          </Button>
        </Step>
      </div>
    </Card>
  );
}
