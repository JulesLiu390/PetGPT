import React from 'react';
import { MIN_QUICK_REPLIES, normalizeQuickReplies } from './quickReplyModel.js';

/** Grok-style reply chips. Selection is delegated; this component never sends. */
export default function QuickReplySuggestions({ suggestions, onSelect }) {
  const replies = normalizeQuickReplies(suggestions);
  if (replies.length < MIN_QUICK_REPLIES) return null;

  return (
    <div
      className="mt-1.5 flex max-w-full flex-wrap items-center gap-1.5 pb-0.5"
      role="group"
      aria-label="Suggested replies"
    >
      {replies.map(reply => (
        <button
          key={reply}
          type="button"
          onClick={() => onSelect?.(reply)}
          title={reply}
          className="inline-flex h-7 max-w-full items-center rounded-full border border-slate-200/80 bg-slate-50/75 px-2.5 text-left text-[11px] font-medium leading-none text-slate-600 shadow-sm backdrop-blur-sm transition-colors hover:border-slate-300 hover:bg-white hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          aria-label={`Send suggested reply: ${reply}`}
        >
          <span className="max-w-[13rem] truncate">{reply}</span>
        </button>
      ))}
    </div>
  );
}
