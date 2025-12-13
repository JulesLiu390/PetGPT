import React from "react";

export const cx = (...classes) => classes.filter(Boolean).join(" ");

export const PageLayout = ({ children, className }) => (
  <div className={cx("min-h-screen bg-slate-50 text-slate-900", className)}>
    {children}
  </div>
);

export const Surface = ({ children, className }) => (
  <div
    className={cx(
      "bg-white/80 backdrop-blur-md border border-slate-200 shadow-sm rounded-2xl",
      className
    )}
  >
    {children}
  </div>
);

export const Card = ({ title, description, action, children, className }) => (
  <div
    className={cx(
      "bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden",
      className
    )}
  >
    {(title || action || description) && (
      <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title && <div className="text-sm font-semibold text-slate-900">{title}</div>}
          {description && (
            <div className="mt-1 text-xs text-slate-500 leading-relaxed">{description}</div>
          )}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    )}
    <div className="p-5">{children}</div>
  </div>
);

export const Divider = ({ className }) => (
  <div className={cx("h-px bg-slate-200/70", className)} />
);

export const Label = ({ children, htmlFor, hint, required, className }) => (
  <label htmlFor={htmlFor} className={cx("block", className)}>
    <div className="text-xs font-semibold text-slate-700">
      {children}
      {required ? <span className="text-rose-500"> *</span> : null}
    </div>
    {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
  </label>
);

const controlBase =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200";

export const Input = ({ className, ...props }) => (
  <input className={cx(controlBase, className)} {...props} />
);

export const Textarea = ({ className, ...props }) => (
  <textarea className={cx(controlBase, "resize-none", className)} {...props} />
);

export const Select = ({ className, children, ...props }) => (
  <div className={cx("relative", className)}>
    <select className={cx(controlBase, "pr-9 appearance-none")} {...props}>
      {children}
    </select>
    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.24a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08z" />
      </svg>
    </div>
  </div>
);

export const Button = ({ variant = "primary", className, children, ...props }) => {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition outline-none focus:ring-2";

  const variants = {
    primary:
      "bg-blue-600 text-white shadow-sm hover:bg-blue-700 focus:ring-blue-200 disabled:bg-slate-200 disabled:text-slate-500",
    secondary:
      "bg-white text-slate-900 border border-slate-200 shadow-sm hover:bg-slate-50 focus:ring-slate-200 disabled:opacity-50",
    subtle:
      "bg-slate-100 text-slate-800 hover:bg-slate-200 focus:ring-slate-200 disabled:opacity-50",
    danger:
      "bg-rose-600 text-white shadow-sm hover:bg-rose-700 focus:ring-rose-200 disabled:opacity-50",
    ghost:
      "bg-transparent text-slate-700 hover:bg-slate-100 focus:ring-slate-200 disabled:opacity-50",
  };

  return (
    <button className={cx(base, variants[variant], className)} {...props}>
      {children}
    </button>
  );
};

export const Badge = ({ children, tone = "slate", className }) => {
  const tones = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    purple: "bg-purple-50 text-purple-700 border-purple-100",
    green: "bg-emerald-50 text-emerald-700 border-emerald-100",
    red: "bg-rose-50 text-rose-700 border-rose-100",
  };

  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
};

export const Tabs = ({ tabs, active, onChange, className }) => (
  <div
    className={cx(
      "inline-flex rounded-2xl bg-slate-100 p-1 border border-slate-200",
      className
    )}
  >
    {tabs.map((t) => (
      <button
        key={t.id}
        onClick={() => onChange(t.id)}
        className={cx(
          "px-3 py-2 text-sm font-semibold rounded-xl transition",
          active === t.id ? "bg-white shadow-sm text-slate-900" : "text-slate-600 hover:text-slate-900"
        )}
        type="button"
      >
        {t.label}
      </button>
    ))}
  </div>
);

export const EmptyState = ({ title, description, action, icon }) => (
  <div className="border border-dashed border-slate-200 rounded-2xl bg-white p-8 text-center">
    {icon ? <div className="mx-auto mb-3 text-slate-300">{icon}</div> : null}
    <div className="text-sm font-semibold text-slate-800">{title}</div>
    {description ? <div className="mt-2 text-xs text-slate-500">{description}</div> : null}
    {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
  </div>
);

export const Alert = ({ tone = "blue", children, className }) => {
  const tones = {
    blue: "bg-blue-50 border-blue-100 text-blue-800",
    green: "bg-emerald-50 border-emerald-100 text-emerald-800",
    red: "bg-rose-50 border-rose-100 text-rose-800",
    yellow: "bg-amber-50 border-amber-100 text-amber-800",
  };
  return (
    <div className={cx("rounded-xl border p-3 text-xs leading-relaxed", tones[tone], className)}>
      {children}
    </div>
  );
};

export const FormGroup = ({ label, hint, required, children, className }) => (
  <div className={cx("space-y-1.5", className)}>
    {label && <Label required={required} hint={hint}>{label}</Label>}
    {children}
  </div>
);

export const Checkbox = ({ label, className, ...props }) => (
  <label className={cx("inline-flex items-center gap-2 cursor-pointer text-sm text-slate-700", className)}>
    <input
      type="checkbox"
      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
      {...props}
    />
    {label}
  </label>
);
