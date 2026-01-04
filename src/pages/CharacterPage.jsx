import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { FaRocketchat } from "react-icons/fa";
import { FaPlug } from "react-icons/fa6";
import { CgAdd, CgHello } from "react-icons/cg";
import { GoMultiSelect } from "react-icons/go";
import { IoIosSettings } from "react-icons/io";
import * as bridge from '../utils/bridge';





export const Character = () => {
  // window.electron?.testOpen("open -a Calculator");
  // 用于接收来自主进程的心情更新
  const [characterMood, setCharacterMood] = useState("normal");
  // 当前展示的图片路径
  const [imgSrc, setImgSrc] = useState(null);
  // 控制是否显示顶部按钮
  const [isShowOptions, setIsShowOptions] = useState(false);
  const [imageName, setImageName] = useState("default");

  // 启动时加载默认角色的图片
  useEffect(() => {
    const loadDefaultCharacter = async () => {
      try {
        const settings = await bridge.getSettings();
        
        // 注册快捷键
        if (settings?.programHotkey || settings?.dialogHotkey) {
          bridge.updateShortcuts(settings.programHotkey || '', settings.dialogHotkey || '');
        }
        
        let foundPet = null;
        
        // 先尝试加载设置中的默认助手
        if (settings && settings.defaultRoleId) {
          try {
            // 优先尝试 getAssistant，失败则回退到 getPet
            try {
              foundPet = await bridge.getAssistant(settings.defaultRoleId);
            } catch (e) {
              // 忽略，尝试旧 API
            }
            if (!foundPet) {
              foundPet = await bridge.getPet(settings.defaultRoleId);
            }
          } catch (petError) {
            console.error("Error loading default pet details:", petError);
          }
        }
        
        // 如果没有找到默认助手，使用第一个可用的助手
        if (!foundPet) {
          try {
            const assistants = await bridge.getAssistants();
            if (assistants && assistants.length > 0) {
              foundPet = assistants[0];
              console.log("[CharacterPage] Fallback to first assistant:", foundPet.name);
            } else {
              const pets = await bridge.getPets();
              if (pets && pets.length > 0) {
                foundPet = pets[0];
                console.log("[CharacterPage] Fallback to first pet:", foundPet.name);
              }
            }
          } catch (e) {
            console.error("Error loading fallback assistant:", e);
          }
        }
        
        // 设置角色图片
        if (foundPet && foundPet.imageName) {
          setImageName(foundPet.imageName);
          console.log("[CharacterPage] Using character image:", foundPet.imageName);
        }
      } catch (error) {
        console.error("Error loading default character image from settings:", error);
        // 如果加载失败，默认值 "default" 会被使用
      }
    };
    
    loadDefaultCharacter();
    
  }, []); // 只在组件加载时执行一次

  // 注册监听主进程发来的 'character-mood-updated' 消息
  useEffect(() => {
    const moodUpdateHandler = (event, updatedMood) => {
      console.log("Received updated mood:", updatedMood);
      setCharacterMood(updatedMood);
    };
    const cleanup = bridge.onMoodUpdated(moodUpdateHandler);

    // 如果需要在组件卸载时移除监听，可在此处调用 removeListener
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 监听角色 ID
  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("📩 Received character ID:", id);
      const fetchCharacterImageName = async () => {
        // 优先尝试 getAssistant，失败则回退到 getPet
        let pet = null;
        try {
          pet = await bridge.getAssistant(id);
        } catch (e) {
          // 忽略，尝试旧 API
        }
        if (!pet) {
          pet = await bridge.getPet(id);
        }
        if (pet && pet.imageName) {
          setImageName(pet.imageName);
        }
      }
      fetchCharacterImageName();
    };
    const cleanup = bridge.onCharacterId(handleCharacterId);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  useEffect(() => {
    const fetchConv = async (conversationId) => {
      try {
        const conv = await bridge.getConversationById(conversationId);
        // 优先尝试 getAssistant，失败则回退到 getPet
        let pet = null;
        try {
          pet = await bridge.getAssistant(conv.petId);
        } catch (e) {
          // 忽略，尝试旧 API
        }
        if (!pet) {
          pet = await bridge.getPet(conv.petId);
        }
        if (pet && pet.imageName) {
          setImageName(pet.imageName);
        }
      } catch (error) {
        console.error("Error fetching conversation:", error);
        throw error;
      }
    };

    const handleConversationId = async(id) => {
      await fetchConv(id);
    };

    const cleanup = bridge.onConversationId(handleConversationId);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 根据 characterMood 动态加载对应图片
  useEffect(() => {
    const loadImage = async () => {
      try {
        // 动态导入，类似 ../assets/sample-happy.png
        if(imageName == 'default') {
          const base64Image = await import(`../assets/default-${characterMood}.png`);
          setImgSrc(base64Image.default);
        } else if(imageName == "Opai") {
          const module = await import(`../assets/Opai-${characterMood}.png`);
          setImgSrc(module.default);
        } else if(imageName == "Claudia") {
          const module = await import(`../assets/Claudia-${characterMood}.png`);
          setImgSrc(module.default);
        } else if(imageName == "Grocka") {
          const module = await import(`../assets/Grocka-${characterMood}.png`);
          setImgSrc(module.default);
        } else if(imageName == "Gemina") {
          const module = await import(`../assets/Gemina-${characterMood}.png`);
          setImgSrc(module.default);
        } else {
          const base64Image = await bridge.readPetImage(`${imageName}-${characterMood}.png`);
          setImgSrc(base64Image);
        }
        
      } catch (err) {
        console.error(`Failed to load image for mood: ${characterMood}`, err);
        // 如果失败，回退到 normal
        try {
          if(imageName == 'default') {
            const base64Image = await import(`../assets/default-normal.png`);
            setImgSrc(base64Image.default);
          } else if(imageName == "Opai") {
            const module = await import(`../assets/Opai-normal.png`);
            setImgSrc(module.default);
          } else if(imageName == "Claudia") {
            const module = await import(`../assets/Claudia-normal.png`);
            setImgSrc(module.default);
          } else if(imageName == "Grocka") {
            const module = await import(`../assets/Grocka-normal.png`);
            setImgSrc(module.default);
          } else if(imageName == "Gemina") {
            const module = await import(`../assets/Gemina-normal.png`);
            setImgSrc(module.default);
          } else {
            const base64Image = await bridge.readPetImage(`${imageName}-normal.png`);
            setImgSrc(base64Image);
          }
        } catch (fallbackErr) {
          console.error('Failed to load fallback image:', fallbackErr);
        }
      }
    };
    loadImage();
  }, [characterMood, imageName]);

  // 各种点击事件
  const handleClick = () => {
    bridge.changeChatWindow();
  };
  const handleClickAddModel = () => {
    bridge.changeAddModelWindow();
  };
  const handleClickSelectCharacter = () => {
    bridge.changeSelectCharacterWindow();
  };
  const handleClickSettings = () => {
    bridge.changeSettingsWindow();
  };
  const handleClickMcp = () => {
    bridge.changeMcpWindow();
  };

  useEffect(() => {
    let windowSize = "medium";
    const getWindowSize = async() => {
      const settings = await bridge.getSettings();
      windowSize = settings.windowSize;
      bridge.updateWindowSizePreset(windowSize);
    }
    getWindowSize()
    // alert(settings.windowSize)
    
      .then(result => {
        console.log("Window size preset updated:", result);
      })
      .catch(error => {
        console.error("Failed to update window size preset:", error);
      });
  }, []);

  return (
    <div
      className="select-none h-full w-full flex flex-col justify-center items-center rounded-xl overflow-hidden"
      onMouseEnter={() => setIsShowOptions(true)}
      onMouseLeave={() => setIsShowOptions(false)}
    >
      {/* 顶部按钮区 */}
      <div className="h-[50px] w-full">
        {isShowOptions && (
          <motion.div
            className="flex justify-evenly items-center gap-2 py-2 bg-black/30 rounded-lg p-2"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
          >
            <FaRocketchat
              title="Chat Window"
              onClick={handleClick}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <CgAdd
              title="Add new Model"
              onClick={handleClickAddModel}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <GoMultiSelect
              title="Chatbot Library"
              onClick={handleClickSelectCharacter}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <FaPlug
              title="MCP Servers"
              onClick={handleClickMcp}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <IoIosSettings
              title="Settings"
              onClick={handleClickSettings}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
          </motion.div>
        )}
      </div>

      {/* 角色图片 */}
      <img
        src={imgSrc || ""}
        draggable="false"
        alt=" "
        className="w-full pointer-events-none
            will-change-transform
    transform
    translate-z-0
    bg-transparent
    transition-none
    select-none
        "
      />

      {/* 底部可拖拽区域 - 增加点击热区 */}
      <div className="w-full h-[60px] flex justify-center items-center cursor-move draggable group" data-tauri-drag-region>
        <div 
          className="w-[140px] h-[14px] rounded-full bg-gray-400 opacity-70 shadow-sm group-hover:opacity-100 transition-opacity pointer-events-none" 
        />
      </div>
    </div>
  );
};

export default Character;