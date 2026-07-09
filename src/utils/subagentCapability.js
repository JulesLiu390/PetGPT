export const DEFAULT_SUBAGENT_ENABLED = false;

const conversationKey = (conversationId) => String(conversationId || 'temp');
const asEnabled = (value, fallback = DEFAULT_SUBAGENT_ENABLED) => {
  if (value === undefined || value === null) return fallback;
  return value !== false && value !== 'false';
};

export function isSubagentEnabledForConversation(overrides, conversationId, defaultEnabled = DEFAULT_SUBAGENT_ENABLED) {
  const key = conversationKey(conversationId);
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, key)) {
    return Boolean(defaultEnabled);
  }
  return asEnabled(overrides[key], Boolean(defaultEnabled));
}

export function setSubagentEnabledForConversation(overrides, conversationId, enabled) {
  return {
    ...(overrides || {}),
    [conversationKey(conversationId)]: asEnabled(enabled),
  };
}

export function captureSubagentPermission(overrides, revisions, conversationId) {
  const key = conversationKey(conversationId);
  return {
    conversationId: key,
    enabled: isSubagentEnabledForConversation(overrides, key),
    revision: Number(revisions?.[key]) || 0,
  };
}

export function isSubagentPermissionCurrent(token, overrides, revisions) {
  if (!token?.enabled) return false;
  return (
    isSubagentEnabledForConversation(overrides, token.conversationId)
    && (Number(revisions?.[token.conversationId]) || 0) === token.revision
  );
}

/** Resolve a live execution guard. Missing or failing guards are denied. */
export function isSubagentRuntimeEnabled(config) {
  if (!config) return false;
  try {
    const value = typeof config.isEnabled === 'function'
      ? config.isEnabled()
      : config.enabled;
    return value !== undefined && value !== null && asEnabled(value, false);
  } catch {
    return false;
  }
}

export function matchesSubagentScope(entry, { source, conversationId } = {}) {
  if (!entry) return false;
  if (source && entry.source !== source) return false;
  if (
    conversationId !== undefined
    && conversationId !== null
    && String(entry.conversationId || '') !== String(conversationId)
  ) return false;
  return true;
}
