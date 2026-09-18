import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUARANTINE_FIX_COMMAND,
  UPDATE_CHECK_INTERVAL_MS,
  isUpdateCheckEnabled,
  pendingUpdateVersion,
  shouldCheckForUpdate,
  shouldShowUpdateBanner,
  updateDownloadUrl,
  updateSettingsPatchFor,
} from '../updateCheck.js';

const NOW = 1_800_000_000_000;

test('the check is opt-out, and a stringified false still disables it', () => {
  assert.equal(isUpdateCheckEnabled({}), true);
  assert.equal(isUpdateCheckEnabled({ updateCheckEnabled: true }), true);
  assert.equal(isUpdateCheckEnabled({ updateCheckEnabled: false }), false);
  assert.equal(isUpdateCheckEnabled({ updateCheckEnabled: 'false' }), false);
});

test('a never-checked install checks immediately, then once per interval', () => {
  assert.equal(shouldCheckForUpdate({ settings: {}, now: NOW }), true);
  assert.equal(shouldCheckForUpdate({ settings: { lastUpdateCheckAt: 0 }, now: NOW }), true);
  assert.equal(
    shouldCheckForUpdate({ settings: { lastUpdateCheckAt: NOW - 1000 }, now: NOW }),
    false,
  );
  assert.equal(
    shouldCheckForUpdate({
      settings: { lastUpdateCheckAt: NOW - UPDATE_CHECK_INTERVAL_MS },
      now: NOW,
    }),
    true,
  );
});

test('a disabled check is never due, however stale the timestamp', () => {
  assert.equal(
    shouldCheckForUpdate({
      settings: { updateCheckEnabled: false, lastUpdateCheckAt: 1 },
      now: NOW,
    }),
    false,
  );
});

test('a clock that moved backwards must not lock the throttle forever', () => {
  // 一次时钟回拨（或从别的机器同步来的 settings）会让 now < last。
  assert.equal(
    shouldCheckForUpdate({ settings: { lastUpdateCheckAt: NOW + 86_400_000 }, now: NOW }),
    true,
  );
});

test('a garbage timestamp is treated as never checked', () => {
  assert.equal(shouldCheckForUpdate({ settings: { lastUpdateCheckAt: 'soon' }, now: NOW }), true);
  assert.equal(shouldCheckForUpdate({ settings: { lastUpdateCheckAt: NaN }, now: NOW }), true);
});

test('the settings patch records the check and signals other windows', () => {
  assert.deepEqual(
    updateSettingsPatchFor({ hasUpdate: true, latestVersion: '0.5.0' }, NOW),
    { lastUpdateCheckAt: NOW, lastKnownVersion: '0.5.0', updateAvailableVersion: '0.5.0' },
  );
  // 已是最新：仍然记下检查时间，但清掉信号，否则角标会一直亮着
  assert.deepEqual(
    updateSettingsPatchFor({ hasUpdate: false, latestVersion: '0.4.8' }, NOW),
    { lastUpdateCheckAt: NOW, lastKnownVersion: '0.4.8', updateAvailableVersion: '' },
  );
});

test('the sidebar badge respects a skipped version', () => {
  assert.equal(pendingUpdateVersion({ updateAvailableVersion: '0.5.0' }), '0.5.0');
  assert.equal(
    pendingUpdateVersion({ updateAvailableVersion: '0.5.0', skippedVersion: '0.5.0' }),
    '',
  );
  // 跳过 0.5.0 之后，0.5.1 依然要提示
  assert.equal(
    pendingUpdateVersion({ updateAvailableVersion: '0.5.1', skippedVersion: '0.5.0' }),
    '0.5.1',
  );
  assert.equal(pendingUpdateVersion({}), '');
});

test('the banner shows only for an unskipped, undismissed update', () => {
  const info = { hasUpdate: true, latestVersion: '0.5.0' };
  assert.equal(shouldShowUpdateBanner({ info }), true);
  assert.equal(shouldShowUpdateBanner({ info: { hasUpdate: false, latestVersion: '0.5.0' } }), false);
  assert.equal(shouldShowUpdateBanner({ info, settings: { skippedVersion: '0.5.0' } }), false);
  assert.equal(shouldShowUpdateBanner({ info, dismissedVersion: '0.5.0' }), false);
  // 跳过/关闭的是旧版本，新版本要重新出现
  assert.equal(shouldShowUpdateBanner({ info, settings: { skippedVersion: '0.4.9' } }), true);
  assert.equal(shouldShowUpdateBanner({ info, dismissedVersion: '0.4.9' }), true);
  assert.equal(shouldShowUpdateBanner({}), false);
});

test('a hasUpdate result without a version is not shown', () => {
  assert.equal(shouldShowUpdateBanner({ info: { hasUpdate: true, latestVersion: '  ' } }), false);
});

test('the download link falls back to the release page when no DMG matches', () => {
  assert.equal(
    updateDownloadUrl({ assetUrl: 'https://example.test/a.dmg', releaseUrl: 'https://example.test/r' }),
    'https://example.test/a.dmg',
  );
  assert.equal(
    updateDownloadUrl({ assetUrl: '', releaseUrl: 'https://example.test/r' }),
    'https://example.test/r',
  );
  assert.equal(updateDownloadUrl({}), '');
});

test('the quarantine hint names the installed app path', () => {
  assert.match(QUARANTINE_FIX_COMMAND, /^sudo xattr -cr \/Applications\/PetGPT\.app$/);
});
