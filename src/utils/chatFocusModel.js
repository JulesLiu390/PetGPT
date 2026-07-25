function normalizeVisible(value) {
  return value === true || value === 'true';
}

function normalizeFocusRequestId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Normalize the payload emitted by the native `chat-window-activated` event.
 * Keeping this boundary strict prevents malformed or stale native events from
 * repeatedly stealing focus in the chat composer.
 */
export function normalizeChatWindowActivation(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    ...source,
    visible: normalizeVisible(source.visible),
    focusRequestId: normalizeFocusRequestId(source.focusRequestId),
  };
}

/**
 * Accept each visible focus request once. Request ids are monotonically
 * increasing on the native side, so older events are stale as well as repeats.
 */
export function createChatFocusRequestGate() {
  let lastAcceptedRequestId = null;

  return {
    accept(payload) {
      const activation = normalizeChatWindowActivation(payload);
      if (!activation.visible || activation.focusRequestId === null) {
        return false;
      }
      if (
        lastAcceptedRequestId !== null
        && activation.focusRequestId <= lastAcceptedRequestId
      ) {
        return false;
      }
      lastAcceptedRequestId = activation.focusRequestId;
      return true;
    },

    getLastAcceptedRequestId() {
      return lastAcceptedRequestId;
    },
  };
}

/**
 * Decide whether a scheduled composer-focus attempt is still allowed. An
 * explicit native activation may replace stale control focus, but a real
 * pointer interaction after that activation always wins.
 */
export function shouldApplyComposerFocus({
  documentFocused,
  explicitRequest,
  activeElementSafe,
  requestStartedAt,
  lastPointerDownAt,
}) {
  if (!documentFocused) return false;
  if (
    Number.isFinite(requestStartedAt)
    && Number.isFinite(lastPointerDownAt)
    && lastPointerDownAt > requestStartedAt
  ) {
    return false;
  }
  return Boolean(explicitRequest || activeElementSafe);
}
