export const ACTIVE_TAB_STATE_STATUS = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
});

export const COMPACT_CHAT_VIEW = Object.freeze({
  NO_TAB: 'no-tab',
  LOADING: 'loading',
  EMPTY: 'empty',
  POPULATED: 'populated',
});

export const EMPTY_CHAT_PRESENTATION = Object.freeze({
  COMPACT: 'compact',
  TAB: 'tab',
});

export const EMPTY_CHAT_PRESENTATION_EVENT = Object.freeze({
  WINDOW_HIDDEN: 'window-hidden',
  USER_NAVIGATION: 'user-navigation',
  CONTENT_ACTIVE: 'content-active',
});

export const COMPACT_CHAT_MIN_HEIGHT = 104;
export const COMPACT_CHAT_MAX_HEIGHT = 720;
export const COMPACT_CHAT_OVERLAY_ALLOWANCE = 392;

export function normalizeConversationId(conversationId) {
  if (conversationId === null || conversationId === undefined) return null;
  const normalized = String(conversationId).trim();
  return normalized || null;
}

export function normalizeTabStateSnapshot(snapshot) {
  return {
    messages: Array.isArray(snapshot?.messages) ? snapshot.messages : [],
    isThinking: Boolean(snapshot?.isThinking ?? snapshot?.is_thinking),
  };
}

export function createLoadingActiveTabState(conversationId, error = null) {
  return {
    conversationId: normalizeConversationId(conversationId),
    status: ACTIVE_TAB_STATE_STATUS.LOADING,
    messages: [],
    isThinking: false,
    source: null,
    error,
  };
}

export function createReadyActiveTabState(
  conversationId,
  snapshot,
  { source = 'snapshot', error = null } = {},
) {
  const normalized = normalizeTabStateSnapshot(snapshot);
  return {
    conversationId: normalizeConversationId(conversationId),
    status: ACTIVE_TAB_STATE_STATUS.READY,
    ...normalized,
    source,
    error,
  };
}

function hasStreamingContent(streamingContent) {
  if (Array.isArray(streamingContent)) return streamingContent.length > 0;
  return Boolean(streamingContent);
}

function hasLiveToolCalls(liveToolCalls) {
  if (Array.isArray(liveToolCalls)) return liveToolCalls.length > 0;
  return Boolean(liveToolCalls);
}

export function getCompactChatView({
  activeTabId,
  tabState,
  streamingContent = null,
  liveToolCalls = [],
} = {}) {
  const conversationId = normalizeConversationId(activeTabId);
  if (!conversationId) return COMPACT_CHAT_VIEW.NO_TAB;

  if (
    tabState?.status !== ACTIVE_TAB_STATE_STATUS.READY
    || normalizeConversationId(tabState?.conversationId) !== conversationId
  ) {
    return COMPACT_CHAT_VIEW.LOADING;
  }

  const { messages, isThinking } = normalizeTabStateSnapshot(tabState);
  const isEmpty = messages.length === 0
    && !isThinking
    && !hasStreamingContent(streamingContent)
    && !hasLiveToolCalls(liveToolCalls);

  return isEmpty ? COMPACT_CHAT_VIEW.EMPTY : COMPACT_CHAT_VIEW.POPULATED;
}

export function nextEmptyChatPresentation(current, event) {
  if (event === EMPTY_CHAT_PRESENTATION_EVENT.WINDOW_HIDDEN) {
    return EMPTY_CHAT_PRESENTATION.COMPACT;
  }
  if (
    event === EMPTY_CHAT_PRESENTATION_EVENT.USER_NAVIGATION
    || event === EMPTY_CHAT_PRESENTATION_EVENT.CONTENT_ACTIVE
  ) {
    return EMPTY_CHAT_PRESENTATION.TAB;
  }
  return current === EMPTY_CHAT_PRESENTATION.TAB
    ? EMPTY_CHAT_PRESENTATION.TAB
    : EMPTY_CHAT_PRESENTATION.COMPACT;
}

export function shouldUseCompactChat({ view, presentation }) {
  return view === COMPACT_CHAT_VIEW.EMPTY
    && presentation === EMPTY_CHAT_PRESENTATION.COMPACT;
}

export function getCompactChatWindowHeight(contentHeight, overlayOpen = false) {
  const measured = Number(contentHeight);
  const safeHeight = Number.isFinite(measured) && measured > 0
    ? measured
    : COMPACT_CHAT_MIN_HEIGHT;
  const requested = safeHeight + (overlayOpen ? COMPACT_CHAT_OVERLAY_ALLOWANCE : 0);
  return Math.min(
    COMPACT_CHAT_MAX_HEIGHT,
    Math.max(COMPACT_CHAT_MIN_HEIGHT, Math.ceil(requested)),
  );
}

/**
 * Invalidates asynchronous work whenever the active conversation changes or
 * the current subscription is cancelled. Cancelling an old token never
 * invalidates a newer one.
 */
export function createActiveTabStateGenerationGate() {
  let generation = 0;
  let currentToken = null;

  return {
    begin(conversationId) {
      currentToken = Object.freeze({
        conversationId: normalizeConversationId(conversationId),
        generation: ++generation,
      });
      return currentToken;
    },
    cancel(token) {
      if (token !== currentToken) return;
      generation += 1;
      currentToken = null;
    },
    isCurrent(token) {
      return token !== null && token === currentToken;
    },
  };
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Starts one active-tab subscription session. The subscription is established
 * before the initial snapshot is read, so a mutation cannot fall into the gap
 * between those operations. If an event arrives while the read is in flight,
 * the event wins and the older read result is ignored.
 */
export function createActiveTabStateSession({
  conversationId,
  gate,
  subscribe,
  readSnapshot,
  onSnapshot,
  onError = () => {},
}) {
  const normalizedId = normalizeConversationId(conversationId);
  if (!normalizedId) throw new Error('Active TabState session requires a conversation ID.');
  if (!gate || typeof gate.begin !== 'function' || typeof gate.isCurrent !== 'function') {
    throw new Error('Active TabState session requires a generation gate.');
  }
  if (typeof subscribe !== 'function' || typeof readSnapshot !== 'function') {
    throw new Error('Active TabState session requires subscribe and readSnapshot functions.');
  }
  if (typeof onSnapshot !== 'function') {
    throw new Error('Active TabState session requires an onSnapshot callback.');
  }

  const token = gate.begin(normalizedId);
  let cancelled = false;
  let unlisten = null;
  let eventCount = 0;

  const isCurrent = () => !cancelled && gate.isCurrent(token);
  const publishSnapshot = (snapshot, metadata) => {
    if (!isCurrent()) return false;
    onSnapshot(normalizeTabStateSnapshot(snapshot), {
      conversationId: normalizedId,
      token,
      ...metadata,
    });
    return true;
  };

  const ready = (async () => {
    let subscriptionError = null;
    try {
      const dispose = await subscribe(normalizedId, (snapshot) => {
        eventCount += 1;
        publishSnapshot(snapshot, { source: 'event', error: null });
      });

      if (!isCurrent()) {
        if (typeof dispose === 'function') dispose();
        return;
      }
      unlisten = typeof dispose === 'function' ? dispose : null;
    } catch (error) {
      if (!isCurrent()) return;
      subscriptionError = toError(error);
      onError(subscriptionError, {
        conversationId: normalizedId,
        token,
        stage: 'subscribe',
      });
    }

    if (!isCurrent()) return;

    try {
      const snapshot = await readSnapshot(normalizedId);
      if (!isCurrent() || eventCount > 0) return;
      publishSnapshot(snapshot, {
        source: 'snapshot',
        error: subscriptionError,
      });
    } catch (error) {
      if (!isCurrent()) return;
      onError(toError(error), {
        conversationId: normalizedId,
        token,
        stage: 'read',
      });
    }
  })();

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    gate.cancel(token);
    const dispose = unlisten;
    unlisten = null;
    if (typeof dispose === 'function') dispose();
  };

  return {
    conversationId: normalizedId,
    token,
    ready,
    cancel,
    isCurrent,
  };
}
