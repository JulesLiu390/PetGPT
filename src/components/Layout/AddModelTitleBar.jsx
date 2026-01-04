import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MdCancel } from "react-icons/md";
import TitleBar from "../UI/TitleBar";
import bridge from "../../utils/bridge";

export const AddModelTitleBar = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isStandalone = searchParams.get('standalone') === 'true';
  
  const handleClose = () => {
    if (isStandalone) {
      // 独立窗口模式：隐藏窗口
      bridge.hideAddModelWindow?.();
    } else {
      // 路由导航模式：返回 selectCharacter 页面
      navigate('/selectCharacter');
    }
  };

  return (
    <TitleBar
      title="New Model"
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
      className="bg-white/95 z-10"
    />
  );
};

export default AddModelTitleBar;