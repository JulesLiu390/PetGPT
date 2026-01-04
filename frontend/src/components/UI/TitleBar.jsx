import React from "react";
import { useNavigate } from "react-router-dom";
import { Button, cx } from "./ui";

/**
 * Shared window title bar.
 *
 * Layout: [left actions] [center title] [right actions]
 * Drag rules:
 * - Outer container is draggable
 * - Interactive areas are no-drag
 */
export const TitleBar = ({
  title,
  left,
  right,
  children,
  onClose,
  backTo,
  height = "h-12",
  className,
}) => {
  const navigate = useNavigate();

  const handleBack = () => {
    if (typeof backTo === "string") {
      navigate(backTo);
    } else {
      navigate(-1);
    }
  };

  return (
    <div
      className={cx(
        "draggable w-full flex items-center gap-2 px-3",
        height,
        "bg-white/80 backdrop-blur-md border-b border-slate-200",
        className
      )}
      data-tauri-drag-region
    >
      <div className="no-drag flex items-center gap-2 min-w-0 shrink-0">
        {left ? left : null}
        {backTo !== undefined ? (
          <Button variant="ghost" onClick={handleBack} className="h-9 px-2">
            Back
          </Button>
        ) : null}
      </div>

      <div className="flex-1 min-w-0 text-center">
        {children ? (
          <div className="no-drag w-full">{children}</div>
        ) : title ? (
          <div className="select-none text-sm font-semibold text-slate-900 truncate">{title}</div>
        ) : null}
      </div>

      <div className="no-drag flex items-center justify-end gap-2 min-w-0 shrink-0">
        {right ? right : <span className="opacity-0">placeholder</span>}
      </div>
    </div>
  );
};

export default TitleBar;
