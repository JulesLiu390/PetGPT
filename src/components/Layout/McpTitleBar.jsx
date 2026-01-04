import React from "react";
import { MdCancel } from "react-icons/md";
import TitleBar from "../UI/TitleBar";
import bridge from "../../utils/bridge";

export const McpTitleBar = () => {
  const handleClose = () => {
    // 直接隐藏窗口（不是 toggle）
    bridge.hideMcpWindow?.();
  };

  return (
    <TitleBar
      title="MCP Settings"
      left={
        <button
          type="button"
          className="no-drag inline-flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          onClick={handleClose}
          title="Close"
        >
          <MdCancel className="w-5 h-5" />
        </button>
      }
      height="h-12"
    />
  );
};

export default McpTitleBar;
