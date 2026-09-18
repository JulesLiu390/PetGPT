import React from 'react';
import { FaRotate } from 'react-icons/fa6';
import { Button } from '../UI/ui';
import { useI18n } from '../../i18n/context.js';

export default function InlineQqLogin({ state, account, onRefresh }) {
  const { t } = useI18n();
  if (state.phase === 'idle' || state.phase === 'complete') return null;
  const loading = state.phase === 'loading';
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2" aria-label={t('QQ sign-in')}>
      <div className="flex flex-wrap items-start gap-3">
        {state.qrcode && (
          <img src={state.qrcode} alt={t('QQ login QR code')}
            className="h-40 w-40 shrink-0 bg-white object-contain" />
        )}
        <div className="min-w-0 flex-1 space-y-2 text-xs text-slate-600">
          <div className="font-medium text-slate-800">{t('Scan to sign in to QQ')}</div>
          {account?.uin && <div>{t('QQ account')}: <span data-i18n-ignore>{account.uin}</span></div>}
          {loading ? (
            <div role="status" className="flex items-center gap-1.5">
              <FaRotate className="w-3 h-3 animate-spin" />{t('Getting a fresh QR code…')}
            </div>
          ) : state.error ? (
            <div role="alert" className="text-rose-600">{t(state.error)}</div>
          ) : (
            <div>{t('Open QQ on your phone and scan this code. Login status updates automatically. If the code expires, refresh it below.')}</div>
          )}
          <Button type="button" variant="secondary" className="!px-2.5 !py-1 !text-xs"
            disabled={loading} onClick={onRefresh}>
            <FaRotate className="w-3 h-3" />{t('Refresh QR')}
          </Button>
        </div>
      </div>
    </div>
  );
}
