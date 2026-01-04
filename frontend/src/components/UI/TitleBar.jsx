import React from "react";
import { useNavigate } from "react-router-dom";
import { Button, cx } from "./ui";

/**
 * Shared window title bar.
 *
 * Layout: [close button] [left-aligned title] [right actions]
 * Drag rules:
 * - Outer container is draggable (data-tauri-drag-region)
 * - Only close button is no-drag, everything else can be used for dragging
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
        "draggable select-none cursor-default w-full flex items-center gap-2 px-3",
        height,
        "bg-white/95 backdrop-blur-md border-b border-slate-200 z-10",
        className
      )}
      data-tauri-drag-region
    >
      {/* Left: Close button (no-drag) */}
      <div className="no-drag flex items-center gap-2 shrink-0">
        {left ? left : null}
        {backTo !== undefined ? (
          <Button variant="ghost" onClick={handleBack} className="h-9 px-2 no-drag">
            Back
          </Button>
        ) : null}
      </div>

      {/* Title: Left-aligned, draggable */}
      <div className="flex-1 min-w-0 text-left" data-tauri-drag-region>
        {children ? (
          <div className="w-full">{children}</div>
        ) : title ? (
          <div className="select-none text-sm font-semibold text-slate-900 truncate" data-tauri-drag-region>{title}</div>
        ) : null}
      </div>

      {/* Right: Actions (no-drag for interactive elements only) */}
      <div className="flex items-center justify-end gap-2 shrink-0">
        {right ? <div className="no-drag">{right}</div> : null}
      </div>
    </div>
  );
};

export default TitleBar;
