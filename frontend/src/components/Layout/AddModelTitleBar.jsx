import React from "react";
import { useNavigate } from "react-router-dom";
import { MdCancel } from "react-icons/md";
import TitleBar from "../UI/TitleBar";

export const AddModelTitleBar = () => {
  const navigate = useNavigate();
  
  const handleClose = () => {
    // 检查是否有导航历史：如果 history.length > 1，说明是从其他页面导航过来的
    // 在 HashRouter 中，初始加载时 history.length 通常是 1
    if (window.history.length > 1) {
      // 有导航历史，使用路由返回到 selectCharacter 页面
      navigate('/selectCharacter');
    } else {
      // 没有导航历史，说明是独立窗口直接加载的，隐藏窗口
      window.electron?.hideAddCharacterWindow();
    }
  };

  return (
    <TitleBar
      title="Add Model"
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
      className="bg-white/80"
    />
  );
};

export default AddModelTitleBar;