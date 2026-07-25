import { useEffect, useRef, useState } from 'react';
import * as tauri from '../../utils/tauri';
import {
  createActiveTabStateGenerationGate,
  createActiveTabStateSession,
  createLoadingActiveTabState,
  createReadyActiveTabState,
  normalizeConversationId,
} from './compactChatModel';

/**
 * Tracks the authoritative Rust TabState for the active conversation.
 *
 * The optional API override is primarily useful for isolated consumers and
 * tests. Callers should keep those function references stable.
 */
export default function useActiveTabState(activeTabId, api = {}) {
  const subscribeTabState = api.subscribeTabState || tauri.subscribeTabState;
  const getTabState = api.getTabState || tauri.getTabState;
  const getConversationWithHistory = api.getConversationWithHistory || tauri.getConversationWithHistory;
  const initTabMessages = api.initTabMessages || tauri.initTabMessages;
  const conversationId = normalizeConversationId(activeTabId);
  const gateRef = useRef(null);
  if (gateRef.current === null) {
    gateRef.current = createActiveTabStateGenerationGate();
  }

  const [state, setState] = useState(() => (
    conversationId
      ? createLoadingActiveTabState(conversationId)
      : createReadyActiveTabState(null, null, { source: 'no-tab' })
  ));

  useEffect(() => {
    if (!conversationId) {
      const token = gateRef.current.begin(null);
      setState(createReadyActiveTabState(null, null, { source: 'no-tab' }));
      return () => gateRef.current.cancel(token);
    }

    setState(createLoadingActiveTabState(conversationId));
    const session = createActiveTabStateSession({
      conversationId,
      gate: gateRef.current,
      subscribe: subscribeTabState,
      readSnapshot: async (targetId) => {
        const cached = await getTabState(targetId);
        if (cached?.messages?.length || cached?.isThinking || cached?.is_thinking) {
          return cached;
        }

        // An empty Rust cache can mean either a genuinely new conversation or
        // an existing conversation that has not hydrated from the database yet.
        // Resolve that ambiguity before exposing the compact empty state.
        const conversation = await getConversationWithHistory(targetId);
        const history = Array.isArray(conversation?.history) ? conversation.history : [];
        if (history.length > 0) {
          await initTabMessages(targetId, history);
          return { ...cached, messages: history };
        }
        return cached;
      },
      onSnapshot(snapshot, metadata) {
        setState(createReadyActiveTabState(conversationId, snapshot, metadata));
      },
      onError(error) {
        setState((current) => {
          if (normalizeConversationId(current.conversationId) !== conversationId) return current;
          return { ...current, error };
        });
      },
    });

    return session.cancel;
  }, [
    conversationId,
    getConversationWithHistory,
    getTabState,
    initTabMessages,
    subscribeTabState,
  ]);

  // Effects run after paint. Never expose the previous tab's ready snapshot
  // during the render in which activeTabId has already changed.
  if (normalizeConversationId(state.conversationId) !== conversationId) {
    return conversationId
      ? createLoadingActiveTabState(conversationId)
      : createReadyActiveTabState(null, null, { source: 'no-tab' });
  }
  return state;
}
