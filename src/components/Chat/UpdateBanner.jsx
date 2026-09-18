import React, { useState } from 'react';
import { MdClose, MdContentCopy, MdCheck, MdSystemUpdateAlt } from 'react-icons/md';
import { useI18n } from '../../i18n/context.js';
import * as tauri from '../../utils/tauri';
import { QUARANTINE_FIX_COMMAND, updateDownloadUrl } from '../../utils/updateCheck.js';

/**
 * 新版本提示条。只引导用户去下载，安装仍由用户手动完成 ——
 * 应用未签名未公证，所以这里必须连带把清 quarantine 的命令一起给出来。
 */
export default function UpdateBanner({ info, onDismiss, onSkipVersion }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  if (!info) return null;
  const downloadUrl = updateDownloadUrl(info);

  const handleDownload = () => {
    if (downloadUrl) tauri.openExternal(downloadUrl);
  };

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(QUARANTINE_FIX_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('[UpdateBanner] Failed to copy command:', error);
    }
  };

  return (
    <div
      role="status"
      className="flex-shrink-0 mx-2 mb-1 rounded-lg border border-blue-200 bg-blue-50/90 px-3 py-2 text-xs text-slate-700"
    >
      <div className="flex items-start gap-2">
        <MdSystemUpdateAlt className="mt-0.5 w-4 h-4 shrink-0 text-blue-600" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="font-medium text-slate-800">
            {t('A new version is available')}
            {': '}
            <span data-i18n-ignore className="tabular-nums">{info.latestVersion}</span>
            {info.prerelease && (
              <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                {t('Pre-release')}
              </span>
            )}
            <span className="ml-1.5 font-normal text-slate-500">
              {t('you have')} <span data-i18n-ignore className="tabular-nums">{info.currentVersion}</span>
            </span>
          </div>

          <div className="text-slate-600">
            {t('Download the installer, drag the app into Applications, then run this once so macOS will open it:')}
          </div>

          <div className="flex items-center gap-1.5">
            <code
              data-i18n-ignore
              className="min-w-0 flex-1 truncate rounded bg-white/80 px-2 py-1 font-mono text-[11px] text-slate-700 border border-slate-200"
            >
              {QUARANTINE_FIX_COMMAND}
            </code>
            <button
              type="button"
              onClick={handleCopyCommand}
              title={t('Copy command')}
              className="shrink-0 rounded p-1 text-slate-500 hover:bg-white hover:text-slate-700 transition-colors"
            >
              {copied
                ? <MdCheck className="w-3.5 h-3.5 text-green-600" />
                : <MdContentCopy className="w-3.5 h-3.5" />}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={handleDownload}
              disabled={!downloadUrl}
              className="rounded-md bg-blue-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50 transition-colors"
            >
              {info.assetUrl ? t('Download DMG') : t('Open release page')}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-white transition-colors"
            >
              {t('Later')}
            </button>
            <button
              type="button"
              onClick={onSkipVersion}
              className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-white transition-colors"
            >
              {t('Skip this version')}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          title={t('Later')}
          className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-white hover:text-slate-600 transition-colors"
        >
          <MdClose className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
