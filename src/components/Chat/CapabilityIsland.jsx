import React, { useEffect } from 'react';

const TAG_TONES = {
  slate: 'border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200',
  violet: 'border-violet-200 bg-violet-50 text-violet-600 hover:bg-violet-100',
  blue: 'border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-100',
  amber: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
};

export function CapabilityTag({ tag, onClick, actionLabel = 'Open capabilities drawer' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tag.title}
      aria-label={`${tag.title}. ${actionLabel}.`}
      className={`max-w-28 shrink-0 truncate rounded-full border px-2 py-1 text-[10px] font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${TAG_TONES[tag.tone] || TAG_TONES.slate}`}
    >
      {tag.label}
    </button>
  );
}

export function CapabilityAction({
  icon,
  label,
  description,
  active = false,
  badge,
  disabled = false,
  onClick,
  ariaPressed,
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={ariaPressed}
      className={`group flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:cursor-not-allowed disabled:opacity-45 ${active
        ? 'border-violet-200 bg-violet-50 text-violet-700'
        : 'border-white/60 bg-white/65 text-slate-600 hover:border-slate-200 hover:bg-white'
      }`}
      title={description}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-violet-100 text-violet-600' : 'bg-slate-100 text-slate-500 group-hover:bg-slate-200'}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span className="block truncate text-[10px] text-slate-400">{description}</span>
      </span>
      {badge != null && (
        <span className="shrink-0 rounded-full bg-slate-200/80 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
          {badge}
        </span>
      )}
    </button>
  );
}

export function CapabilityToggleAction({
  icon,
  label,
  description,
  checked,
  runningCount = 0,
  onChange,
  onView,
}) {
  const toggle = () => onChange?.(!checked);
  const hasFinishingTasks = !checked && runningCount > 0;

  return (
    <div
      className={`rounded-xl border px-3 py-2 transition-colors ${checked
        ? 'border-violet-200 bg-violet-50/90'
        : 'border-white/60 bg-white/65'
      }`}
      role="group"
      aria-label={`${label} controls`}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          className="group flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${checked
            ? 'bg-violet-100 text-violet-600'
            : 'bg-slate-100 text-slate-500 group-hover:bg-slate-200'
          }`}>
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-xs font-semibold ${checked ? 'text-violet-700' : 'text-slate-600'}`}>
              {label}
            </span>
            <span className="block truncate text-[10px] text-slate-400">{description}</span>
          </span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={`${checked ? 'Disable' : 'Enable'} ${label}`}
          onClick={toggle}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 ${checked ? 'bg-violet-500' : 'bg-slate-300'}`}
        >
          <span
            className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="mt-1.5 flex items-center justify-between border-t border-slate-200/60 pt-1.5">
        <span className={`text-[9px] font-medium ${hasFinishingTasks ? 'text-amber-600' : 'text-slate-400'}`}>
          {checked
            ? 'Enabled for this chat'
            : hasFinishingTasks ? `Off · ${runningCount} finishing` : 'Disabled for this chat'}
        </span>
        <button
          type="button"
          onClick={onView}
          className="rounded-md px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 transition-colors hover:bg-white hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          {runningCount > 0 ? `View ${runningCount} running ›` : 'View tasks ›'}
        </button>
      </div>
    </div>
  );
}

export default function CapabilityDrawer({ id, isOpen, onClose, children }) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <section
      id={id}
      aria-label="Chat capabilities"
      className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-[min(360px,55vh)] overflow-y-auto rounded-2xl border border-white/80 bg-white/90 p-2 shadow-xl backdrop-blur-md"
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Capabilities</div>
          <div className="text-[10px] text-slate-400">Tools and context for this chat</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-[10px] font-medium text-slate-400 transition-colors hover:bg-white/70 hover:text-slate-600"
          aria-label="Close capabilities drawer"
        >
          Done
        </button>
      </div>
      {children}
    </section>
  );
}
