/**
 * 更新检查的纯决策逻辑：什么时候该查、查到的结果该不该提示。
 *
 * 刻意不含任何 IO —— 调用方负责读写 settings 和调 `tauri.checkForUpdate()`，
 * 这里只做判断，因此可以直接测试。
 */

/** GitHub 匿名 API 限流 60 次/小时/IP，一天一次足够且留足余量。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 启动后先把资源让给窗口初始化和社交 runtime，再做这件不紧急的事。 */
export const UPDATE_CHECK_STARTUP_DELAY_MS = 60 * 1000;

/**
 * 应用未签名未公证，装完新版必须清掉 quarantine 属性才打得开。
 * 不告诉用户这一步，他们会以为更新把应用搞坏了。
 */
export const QUARANTINE_FIX_COMMAND = 'sudo xattr -cr /Applications/PetGPT.app';

/** settings 里存的是字符串化的值，所以 'false' 也要当 false 处理。 */
export const isUpdateCheckEnabled = (settings = {}) => {
  const raw = settings?.updateCheckEnabled;
  return raw !== false && raw !== 'false';
};

export const shouldCheckForUpdate = ({
  settings = {},
  now = Date.now(),
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
} = {}) => {
  if (!isUpdateCheckEnabled(settings)) return false;
  const last = Number(settings?.lastUpdateCheckAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  // 时钟回拨（now < last）按「该查」处理，否则节流会把自己永久锁死。
  if (now < last) return true;
  return now - last >= intervalMs;
};

const normalizeVersion = (value) => String(value ?? '').trim();

/**
 * 从一次检查结果里提取要持久化的 settings 补丁。
 * `updateAvailableVersion` 是给其它窗口看的信号，这样 Management 不必自己
 * 再查一次 GitHub、也不必在 JS 侧重复实现 semver 比较。
 */
export const updateSettingsPatchFor = (info, now = Date.now()) => ({
  lastUpdateCheckAt: now,
  lastKnownVersion: normalizeVersion(info?.latestVersion),
  updateAvailableVersion: info?.hasUpdate ? normalizeVersion(info?.latestVersion) : '',
});

/** Management 侧栏角标用：有待处理的新版本时返回版本号，否则空串。 */
export const pendingUpdateVersion = (settings = {}) => {
  const available = normalizeVersion(settings?.updateAvailableVersion);
  if (!available) return '';
  if (normalizeVersion(settings?.skippedVersion) === available) return '';
  return available;
};

/**
 * @param dismissedVersion 本次会话里用户点过「稍后」的版本（不持久化）
 */
export const shouldShowUpdateBanner = ({ info, settings = {}, dismissedVersion = '' } = {}) => {
  if (!info?.hasUpdate) return false;
  const latest = normalizeVersion(info?.latestVersion);
  if (!latest) return false;
  if (normalizeVersion(settings?.skippedVersion) === latest) return false;
  if (normalizeVersion(dismissedVersion) === latest) return false;
  return true;
};

/** 没有匹配当前架构的 DMG 时（非 macOS、或该架构这次没发包）退回 Release 页。 */
export const updateDownloadUrl = (info) => (
  normalizeVersion(info?.assetUrl) || normalizeVersion(info?.releaseUrl)
);

export default {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_STARTUP_DELAY_MS,
  QUARANTINE_FIX_COMMAND,
  isUpdateCheckEnabled,
  shouldCheckForUpdate,
  updateSettingsPatchFor,
  pendingUpdateVersion,
  shouldShowUpdateBanner,
  updateDownloadUrl,
};
