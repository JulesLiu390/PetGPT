import React from "react";
import { MdCancel } from "react-icons/md";
import TitleBar from "../UI/TitleBar";
import tauri from "../../utils/tauri";

export const SelectCharacterTitleBar = () => {
  const handleClose = () => {
    // 直接隐藏窗口（不是 toggle）
    tauri.hideSelectCharacterWindow?.();
  };

  return (
    <TitleBar
      title="Select Assistant"
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

export default SelectCharacterTitleBar;