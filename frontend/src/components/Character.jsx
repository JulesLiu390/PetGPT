import React, { useEffect, useRef, useState } from 'react';
import { CharacterImage } from '../assets';
import { useStateValue } from '../content/StateProvider';


export const Character = () => {
    const [{characterMood}, dispatch] = useStateValue();


  const isDragging = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);

  const handleMouseDown = (e) => {
    isDragging.current = false;
    startX.current = e.screenX;
    startY.current = e.screenY;

    // 绑定全局事件，确保鼠标移动和释放时能持续跟踪
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e) => {
    const deltaX = e.screenX - startX.current;
    const deltaY = e.screenY - startY.current;
    // 判断是否为拖拽（可以根据实际需要设置阈值）
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      isDragging.current = true;
    }
    // 调用 Electron 端暴露的拖拽 API
    window.electron?.dragWindow(deltaX, deltaY);
    // 更新起始坐标以支持连续拖拽
    startX.current = e.screenX;
    startY.current = e.screenY;
  };

  const handleMouseUp = () => {
    // 移除全局事件监听
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
    // 如果没有拖拽行为，则视为点击，调用打开聊天窗口逻辑
    if (!isDragging.current) {
      window.electron?.showChatWindow();
    }
  };

  const [imgSrc, setImgSrc] = useState('../assets/sample-normal.png');
  // 1) 监听主进程广播的状态更新
  // useEffect(() => {
  //   // 如果 preload.js 暴露了 onCharacterMoodUpdated，就可以这样使用
  //   window.electron?.onCharacterMoodUpdated((event, mood) => {
  //     console.log("收到主进程更新 characterMood:", mood);
  //     // 如果需要，也可以同步更新本地 context
  //     dispatch({ type: 'SET_CHARACTER_MOOD', characterMood: mood });
  //   });

  //   return () => {
  //     window.electron?.removeCharacterMoodUpdatedListener();
  //   };
  // }, [dispatch]);

  // 2) 当 characterMood 变化时动态加载对应图片
  useEffect(() => {
    console.log("Character useEffect triggered with characterMood:", characterMood);
    import(`../assets/sample-${characterMood}.png`)
      .then(module => {
        setImgSrc(module.default);
      })
      .catch(err => {
        console.error('Failed to load image:', err);
      });
  }, [characterMood]);


//   img

  return (
    <img 
      src={imgSrc} 
      draggable="false"
      alt="character"
      className="cursor-pointer"
      onMouseDown={handleMouseDown}
    />
  );
};

export default Character;