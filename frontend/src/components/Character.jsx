import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { FaRocketchat } from "react-icons/fa";
import { CgAdd, CgHello } from "react-icons/cg";
import { GoMultiSelect } from "react-icons/go";

export const Character = () => {
  // 用于接收来自主进程的心情更新
  const [characterMood, setCharacterMood] = useState("normal");
  // 当前展示的图片路径
  const [imgSrc, setImgSrc] = useState(null);
  // 控制是否显示顶部按钮
  const [isShowOptions, setIsShowOptions] = useState(false);

  // 注册监听主进程发来的 'character-mood-updated' 消息
  useEffect(() => {
    const moodUpdateHandler = (event, updatedMood) => {
      console.log("Received updated mood:", updatedMood);
      setCharacterMood(updatedMood);
    };
    window.electron?.onMoodUpdated(moodUpdateHandler);

    // 如果需要在组件卸载时移除监听，可在此处调用 removeListener
    return () => {
      // window.electron?.removeMoodUpdated(moodUpdateHandler);
    };
  }, []);

  // 根据 characterMood 动态加载对应图片
  useEffect(() => {
    const loadImage = async () => {
      try {
        // 动态导入，类似 ../assets/sample-happy.png
        const module = await import(`../assets/sample-${characterMood}.png`);
        setImgSrc(module.default);
      } catch (err) {
        console.error(`Failed to load image for mood: ${characterMood}`, err);
        // 如果失败，回退到 normal
        try {
          const fallbackModule = await import(`../assets/sample-normal.png`);
          setImgSrc(fallbackModule.default);
        } catch (fallbackErr) {
          console.error('Failed to load fallback image:', fallbackErr);
        }
      }
    };
    loadImage();
  }, [characterMood]);

  // 各种点击事件
  const handleClick = () => {
    window.electron?.changeChatWindow();
  };
  const handleClickAddCharacter = () => {
    window.electron?.changeAddCharacterWindow();
  };
  const handleClickSelectCharacter = () => {
    window.electron?.changeSelectCharacterWindow();
  };

  return (
    <div
      className="select-none h-[300px] w-[200px] flex flex-col justify-center items-center"
      onMouseEnter={() => setIsShowOptions(true)}
      onMouseLeave={() => setIsShowOptions(false)}
    >
      {/* 顶部按钮区 */}
      <div className="h-[50px] w-full">
        {isShowOptions && (
          <motion.div
            className="flex justify-evenly items-center gap-2 py-2"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
          >
            <FaRocketchat
              title="打开聊天窗口"
              onClick={handleClick}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <CgAdd
              title="发送表情"
              onClick={handleClickAddCharacter}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <GoMultiSelect
              title="查看历史消息"
              onClick={handleClickSelectCharacter}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <CgHello
              title="设置机器人语气"
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
          </motion.div>
        )}
      </div>

      {/* 角色图片 */}
      <img
        src={imgSrc || ""}
        draggable="false"
        alt="character"
        className="w-[200px] h-[200px] pointer-events-none"
      />

      {/* 底部可拖拽区域 */}
      <div className="w-[120px] h-[8px] rounded-full bg-gray-400 opacity-70 shadow-sm draggable" />
    </div>
  );
};

export default Character;