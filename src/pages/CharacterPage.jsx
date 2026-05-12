import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { FaRocketchat, FaKey, FaRobot } from "react-icons/fa";
import { FaPlug, FaUserGroup } from "react-icons/fa6";
import { CgHello } from "react-icons/cg";
import { IoIosSettings } from "react-icons/io";
import * as tauri from '../utils/tauri';
import { getSafeMood, EMOTION_MOODS, SYSTEM_STATES, ALL_MOODS, getRandomIdleState } from '../utils/moodDetector';
import { startSocialLoop, stopSocialLoop, isSocialActiveForPet, loadSocialConfig, getSocialStatus, getSocialLogs, clearSocialLogs, setLurkMode, getLurkModes, setTargetPaused, getPausedTargets, getTargetNames, setCustomGroupRule } from '../utils/socialAgent';

// 拖动检测配置
const DRAG_THRESHOLD = 5; // 移动超过 5px 视为拖动
const CLICK_TIME_THRESHOLD = 200; // 200ms 内释放视为点击

// ============ 状态系统常量 ============

/**
 * 角色状态枚举
 * - active: 活跃状态（有对话时）
 * - idle: 待机状态（无对话一段时间后）
 * - thinking: 思考状态（AI 处理中）
 */
const CHARACTER_STATE = {
  ACTIVE: 'active',
  IDLE: 'idle',
  THINKING: 'thinking',
};

// 待机相关配置
const IDLE_TIMEOUT_MS = 30000;      // 30秒无操作进入待机
const IDLE_ANIMATION_INTERVAL_MS = 5000; // 待机动画切换间隔 5秒

/**
 * 获取表情对应的图片文件名后缀
 * 所有内置皮肤均支持完整 mood 集：normal, idle-1/2/3, smile, sad, shocked, thinking
 * @param {string} mood - 表情/状态名称
 * @returns {string} 图片文件名后缀
 */
const getMoodImageName = (mood) => {
  return mood || 'normal';
};





export const Character = () => {
  // window.electron?.testOpen("open -a Calculator");
  
  // ============ 状态分层管理 ============
  // 第一层：角色状态（active/idle/thinking）
  const [characterState, setCharacterState] = useState(CHARACTER_STATE.ACTIVE);
  // 第二层：情绪表情（normal/smile/sad/shocked）- 仅在 active 状态下有效
  const [emotionMood, setEmotionMood] = useState("normal");
  // 第三层：当前待机动画帧（idle-1/idle-2/idle-3）- 仅在 idle 状态下有效
  const [idleFrame, setIdleFrame] = useState("idle-1");
  
  // 计算最终显示的表情/状态（用于图片加载）
  const getDisplayMood = useCallback(() => {
    switch (characterState) {
      case CHARACTER_STATE.THINKING:
        return 'thinking';
      case CHARACTER_STATE.IDLE:
        return idleFrame;
      case CHARACTER_STATE.ACTIVE:
      default:
        return emotionMood;
    }
  }, [characterState, emotionMood, idleFrame]);
  
  // 兼容旧代码：characterMood 现在是计算属性
  const characterMood = getDisplayMood();
  
  // 当前展示的图片路径
  const [imgSrc, setImgSrc] = useState(null);
  // 控制是否显示顶部按钮（传统 onMouseEnter/Leave，作为备用）
  const [isShowOptions, setIsShowOptions] = useState(false);
  // 鼠标是否在窗口上（通过 Rust 轮询检测，即使窗口失去焦点也能工作）
  const [isMouseOver, setIsMouseOver] = useState(false);
  // 控制 Settings/Manage 窗口是否打开
  const [isManageVisible, setIsManageVisible] = useState(false);
  // 控制 Chat 窗口是否打开
  const [isChatVisible, setIsChatVisible] = useState(false);
  const [imageName, setImageName] = useState("Glitch");
  const [currentPetId, setCurrentPetId] = useState(null);
  
  // 社交代理激活状态
  const [socialActive, setSocialActive] = useState(false);
  
  // 当 currentPetId 变化时，同步社交循环状态
  useEffect(() => {
    if (currentPetId) {
      setSocialActive(isSocialActiveForPet(currentPetId));
    } else {
      setSocialActive(false);
    }
  }, [currentPetId]);
  
  // 表情恢复定时器（情绪 -> normal）
  const moodResetTimerRef = useRef(null);
  const [moodResetDelay, setMoodResetDelay] = useState(30); // 默认 30 秒
  
  // 待机相关定时器
  const idleTimeoutRef = useRef(null);      // 进入待机的定时器
  const idleAnimationRef = useRef(null);    // 待机动画切换定时器
  
  // ============ 状态切换函数 ============
  
  /**
   * 重置待机计时器（有活动时调用）
   * 使用 ref 来避免闭包陈旧值问题
   */
  const resetIdleTimer = useCallback(() => {
    // 清除待机定时器
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = null;
    }
    // 清除待机动画定时器
    if (idleAnimationRef.current) {
      clearInterval(idleAnimationRef.current);
      idleAnimationRef.current = null;
    }
    
    // 使用函数式更新来获取最新状态
    setCharacterState(prevState => {
      // 如果当前是待机状态，切换回活跃状态
      if (prevState === CHARACTER_STATE.IDLE) {
        console.log('[Character] Exiting idle state -> active');
        return CHARACTER_STATE.ACTIVE;
      }
      return prevState;
    });
    
    // 设置新的待机定时器
    idleTimeoutRef.current = setTimeout(() => {
      // 只有在非思考状态时才进入待机
      setCharacterState(prevState => {
        if (prevState !== CHARACTER_STATE.THINKING) {
          console.log('[Character] Entering idle state after timeout');
          return CHARACTER_STATE.IDLE;
        }
        return prevState;
      });
    }, IDLE_TIMEOUT_MS);
  }, []); // 不再依赖 characterState
  
  /**
   * 进入思考状态
   */
  const enterThinkingState = useCallback(() => {
    console.log('[Character] Entering thinking state');
    // 清除所有定时器
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = null;
    }
    if (idleAnimationRef.current) {
      clearInterval(idleAnimationRef.current);
      idleAnimationRef.current = null;
    }
    if (moodResetTimerRef.current) {
      clearTimeout(moodResetTimerRef.current);
      moodResetTimerRef.current = null;
    }
    setCharacterState(CHARACTER_STATE.THINKING);
  }, []);
  
  /**
   * 退出思考状态，设置情绪
   */
  const exitThinkingWithMood = useCallback((mood) => {
    console.log('[Character] Exiting thinking state with mood:', mood);
    setCharacterState(CHARACTER_STATE.ACTIVE);
    setEmotionMood(mood || 'normal');
    
    // 重置待机计时器
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
    }
    idleTimeoutRef.current = setTimeout(() => {
      setCharacterState(CHARACTER_STATE.IDLE);
    }, IDLE_TIMEOUT_MS);
    
    // 如果不是 normal，设置情绪恢复定时器
    if (mood && mood !== 'normal' && moodResetDelay > 0) {
      if (moodResetTimerRef.current) {
        clearTimeout(moodResetTimerRef.current);
      }
      moodResetTimerRef.current = setTimeout(() => {
        console.log(`[Character] Mood reset to normal after ${moodResetDelay}s`);
        setEmotionMood('normal');
      }, moodResetDelay * 1000);
    }
  }, [moodResetDelay]);
  
  // ============ 待机动画循环 ============
  useEffect(() => {
    if (characterState === CHARACTER_STATE.IDLE) {
      // 进入待机状态，开始动画循环
      console.log('[Character] Starting idle animation loop');
      setIdleFrame(getRandomIdleState());
      
      idleAnimationRef.current = setInterval(() => {
        setIdleFrame(getRandomIdleState());
      }, IDLE_ANIMATION_INTERVAL_MS);
    } else {
      // 离开待机状态，停止动画
      if (idleAnimationRef.current) {
        clearInterval(idleAnimationRef.current);
        idleAnimationRef.current = null;
      }
    }
    
    return () => {
      if (idleAnimationRef.current) {
        clearInterval(idleAnimationRef.current);
      }
    };
  }, [characterState]);
  
  // ============ 初始化 idle 计时器 ============
  useEffect(() => {
    // 组件加载后启动 idle 计时器
    console.log('[Character] Initializing idle timer');
    idleTimeoutRef.current = setTimeout(() => {
      setCharacterState(prevState => {
        if (prevState !== CHARACTER_STATE.THINKING) {
          console.log('[Character] Entering idle state after initial timeout');
          return CHARACTER_STATE.IDLE;
        }
        return prevState;
      });
    }, IDLE_TIMEOUT_MS);
    
    // 清理
    return () => {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
      }
    };
  }, []); // 只在组件挂载时运行一次

  const loadCharacter = useCallback(async (targetId = null) => {
    try {
      const settings = await tauri.getSettings();
      
      // 加载表情恢复延迟设置
      if (settings?.moodResetDelay !== undefined) {
        setMoodResetDelay(settings.moodResetDelay);
      }
      
      // 注册快捷键
      if (settings?.programHotkey || settings?.dialogHotkey || settings?.screenshotHotkey) {
        tauri.updateShortcuts(settings.programHotkey || '', settings.dialogHotkey || '', settings.screenshotHotkey || '');
      }
      
      let foundPet = null;
      let petIdToLoad = targetId || settings?.defaultRoleId;

      // 如果有指定 ID 或默认设置中的 ID，尝试加载
      if (petIdToLoad) {
        try {
          // 优先尝试 getAssistant，失败则回退到 getPet
          try {
            foundPet = await tauri.getAssistant(petIdToLoad);
          } catch (e) {
            // 忽略，尝试旧 API
          }
          if (!foundPet) {
            foundPet = await tauri.getPet(petIdToLoad);
          }
        } catch (petError) {
          console.error("Error loading pet details:", petError);
        }
      }
      
      // 如果没有找到助手，使用第一个可用的作为回退
      if (!foundPet) {
        try {
          const assistants = await tauri.getAssistants();
          if (assistants && assistants.length > 0) {
            foundPet = assistants[0];
            console.log("[CharacterPage] Fallback to first assistant:", foundPet.name);
          } else {
            const pets = await tauri.getPets();
            if (pets && pets.length > 0) {
              foundPet = pets[0];
              console.log("[CharacterPage] Fallback to first pet:", foundPet.name);
            }
          }
        } catch (e) {
          console.error("Error loading fallback assistant:", e);
        }
      }
      
      // 设置角色图片和 ID
      if (foundPet) {
        setCurrentPetId(foundPet.id || foundPet._id);
        if (foundPet.imageName) {
          setImageName(foundPet.imageName);
          console.log("[CharacterPage] Using character image:", foundPet.imageName);
        }
      }
    } catch (error) {
      console.error("Error loading character:", error);
    }
  }, []);

  // 启动时加载 + 初始化待机计时器
  useEffect(() => {
    loadCharacter();
    
    // 启动初始待机计时器
    idleTimeoutRef.current = setTimeout(() => {
      console.log('[Character] Initial idle timeout - entering idle state');
      setCharacterState(CHARACTER_STATE.IDLE);
    }, IDLE_TIMEOUT_MS);
    
    // 清理函数
    return () => {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
      }
      if (idleAnimationRef.current) {
        clearInterval(idleAnimationRef.current);
      }
      if (moodResetTimerRef.current) {
        clearTimeout(moodResetTimerRef.current);
      }
    };
  }, [loadCharacter]);

  // 监听宠物/助手更新事件
  useEffect(() => {
    const handlePetsUpdate = async (event) => {
      // event structure: { action: 'update'|'create'|'switch', type: 'assistant'|'pet', id, data }
      console.log("[CharacterPage] ★★★ Received pets update:", event);
      console.log("[CharacterPage] ★★★ Current petId:", currentPetId);

      // 如果是切换 assistant，立即加载新的角色
      if (event.action === 'switch' && event.id) {
        console.log("[CharacterPage] ★★★ Switching character to:", event.id, event.data?.name);
        loadCharacter(event.id);
      }
      // 如果更新的是当前角色，或者当前没有加载角色，则刷新
      else if (event.action === 'update' && (event.id === currentPetId || !currentPetId)) {
        console.log("Current character updated, reloading...");
        loadCharacter(event.id);
      } else if (event.action === 'delete' && event.id === currentPetId) {
        // 如果当前角色被删除，重新加载默认（传 null 触发 fallback）
        loadCharacter(null);
      }
    };

    // 直接使用 listen API 来正确设置监听器
    let unlisten = null;
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('pets-updated', (event) => {
        console.log("[CharacterPage] ★★★ Raw event received from Rust:", event);
        handlePetsUpdate(event.payload);
      });
      console.log("[CharacterPage] ★★★ pets-updated listener is READY");
    };
    setupListener();

    return () => {
      if (unlisten) {
        console.log("[CharacterPage] Cleaning up pets-updated listener");
        unlisten();
      }
    };
  }, [currentPetId, loadCharacter]);

  // 监听 settings/manage 窗口可见性
  useEffect(() => {
    const handleManageVisibility = (payload) => {
        console.log("Manage window visibility changed:", payload);
        if (payload && typeof payload.visible === 'boolean') {
            setIsManageVisible(payload.visible);
        }
    };

    let cleanup;
    if (tauri.onManageWindowVisibilityChanged) {
        cleanup = tauri.onManageWindowVisibilityChanged(handleManageVisibility);
    }
    
    return () => {
        if (cleanup) cleanup();
    }
  }, []);

  // 监听 chat 窗口可见性
  useEffect(() => {
    const handleChatVisibility = (payload) => {
        console.log("Chat window visibility changed:", payload);
        if (payload && typeof payload.visible === 'boolean') {
            setIsChatVisible(payload.visible);
        }
    };

    let cleanup;
    if (tauri.onChatWindowVisibilityChanged) {
        cleanup = tauri.onChatWindowVisibilityChanged(handleChatVisibility);
    }
    
    return () => {
        if (cleanup) cleanup();
    }
  }, []);

  // 监听鼠标是否在 character 窗口上（通过 Rust 轮询，支持失焦状态）
  useEffect(() => {
    let cleanup;
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      cleanup = await listen('mouse-over-character', (event) => {
        setIsMouseOver(event.payload);
        if (event.payload) {
          // 鼠标进入 → 启动 2 秒定时器
          hoverIdleTimerRef.current = setTimeout(() => {
            idleClickReadyRef.current = true;
            setIdleClickReady(true);
          }, HOVER_IDLE_DELAY);
        } else {
          // 鼠标离开 → 清除定时器并重置
          if (hoverIdleTimerRef.current) {
            clearTimeout(hoverIdleTimerRef.current);
            hoverIdleTimerRef.current = null;
          }
          idleClickReadyRef.current = false;
          setIdleClickReady(false);
        }
      });
    };
    setupListener();

    return () => {
      if (cleanup) cleanup();
      if (hoverIdleTimerRef.current) clearTimeout(hoverIdleTimerRef.current);
    };
  }, []);

  // 监听设置更新
  useEffect(() => {
    const handleSettingsUpdate = (payload) => {
      console.log("Settings updated:", payload);
      // 如果更新了默认角色 ID，重新加载
      // 注意：Tauri 中 key 可能是 'defaultRoleId'，Electron 中可能是 'defaultAssistant'，根据实际 key 调整
      if (payload.key === 'defaultRoleId' || payload.key === 'defaultAssistant') {
         loadCharacter();
      }
      // 更新表情恢复延迟
      if (payload.key === 'moodResetDelay') {
        setMoodResetDelay(payload.value);
      }
    };
    
    const cleanup = tauri.onSettingsUpdated(handleSettingsUpdate);
    return () => {
        if(cleanup) cleanup();
    }
  }, [loadCharacter]);

  // 注册监听主进程发来的 'character-mood-updated' 消息
  // 适配新的状态系统
  useEffect(() => {
    const moodUpdateHandler = (event, updatedMood) => {
      console.log("[Character] Received mood update:", updatedMood);
      
      // 处理 thinking 状态
      if (updatedMood === 'thinking') {
        enterThinkingState();
        return;
      }
      
      // 其他情绪：退出 thinking 并设置情绪
      if (characterState === CHARACTER_STATE.THINKING) {
        exitThinkingWithMood(updatedMood);
      } else {
        // 当前不在 thinking 状态，直接更新情绪并重置待机计时
        setEmotionMood(updatedMood || 'normal');
        resetIdleTimer();
        
        // 如果不是 normal，设置情绪恢复定时器
        if (updatedMood && updatedMood !== 'normal' && moodResetDelay > 0) {
          if (moodResetTimerRef.current) {
            clearTimeout(moodResetTimerRef.current);
          }
          moodResetTimerRef.current = setTimeout(() => {
            console.log(`[Character] Mood reset to normal after ${moodResetDelay}s`);
            setEmotionMood('normal');
          }, moodResetDelay * 1000);
        }
      }
    };
    const cleanup = tauri.onMoodUpdated(moodUpdateHandler);

    // 组件卸载时清理
    return () => {
      if (cleanup) cleanup();
      if (moodResetTimerRef.current) {
        clearTimeout(moodResetTimerRef.current);
      }
      if (pokeResetTimerRef.current) {
        clearTimeout(pokeResetTimerRef.current);
      }
    };
  }, [moodResetDelay, characterState, enterThinkingState, exitThinkingWithMood, resetIdleTimer]);

  // 监听角色 ID
  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("📩 Received character ID:", id);
      const fetchCharacterImageName = async () => {
        // 优先尝试 getAssistant，失败则回退到 getPet
        let pet = null;
        try {
          pet = await tauri.getAssistant(id);
        } catch (e) {
          // 忽略，尝试旧 API
        }
        if (!pet) {
          pet = await tauri.getPet(id);
        }
        if (pet && pet.imageName) {
          setImageName(pet.imageName);
        }
      }
      fetchCharacterImageName();
    };
    const cleanup = tauri.onCharacterId(handleCharacterId);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // onConversationId 已移除：以前用来根据 conversationId 查 petId 再查 imageName，
  // 但 onCharacterId 已经直接用 petId 做同样的事情，无需多一次 getConversationById IPC。

  // 根据 characterMood 动态加载对应图片
  useEffect(() => {
    const loadImage = async () => {
      const imageNameSuffix = getMoodImageName(characterMood);
      console.log(`[CharacterPage] Loading image for mood: ${characterMood} -> ${imageNameSuffix}`);

      try {
        // 内置皮肤：Glitch (default)、Maodie、LittlePony
        if(imageName === 'default' || imageName === 'Glitch') {
          const module = await import(`../assets/Glitch-${imageNameSuffix}.png`);
          setImgSrc(module.default);
        } else if(imageName === "Maodie") {
          const module = await import(`../assets/Maodie-${imageNameSuffix}.png`);
          setImgSrc(module.default);
        } else if(imageName === "LittlePony") {
          const module = await import(`../assets/LittlePony-${imageNameSuffix}.png`);
          setImgSrc(module.default);
        } else if (imageName.startsWith("custom:")) {
          const skinId = imageName.split(":")[1];
          const base64Image = await tauri.readSkinImage(skinId, imageNameSuffix);
          setImgSrc(base64Image);
        } else {
          const base64Image = await tauri.readPetImage(`${imageName}-${imageNameSuffix}.png`);
          setImgSrc(base64Image);
        }

      } catch (err) {
        console.error(`Failed to load image for mood: ${characterMood} (${imageNameSuffix})`, err);
        // 如果失败，回退到 normal
        try {
          if(imageName === 'default' || imageName === 'Glitch') {
            const module = await import(`../assets/Glitch-normal.png`);
            setImgSrc(module.default);
          } else if(imageName === "Maodie") {
            const module = await import(`../assets/Maodie-normal.png`);
            setImgSrc(module.default);
          } else if(imageName === "LittlePony") {
            const module = await import(`../assets/LittlePony-normal.png`);
            setImgSrc(module.default);
          } else if (imageName.startsWith("custom:")) {
            const skinId = imageName.split(":")[1];
            const base64Image = await tauri.readSkinImage(skinId, "normal");
            setImgSrc(base64Image);
          } else {
            const base64Image = await tauri.readPetImage(`${imageName}-normal.png`);
            setImgSrc(base64Image);
          }
        } catch (fallbackErr) {
          console.error('Failed to load fallback image:', fallbackErr);
          try {
            const module = await import(`../assets/Glitch-normal.png`);
            setImgSrc(module.default);
          } catch (_) {}
        }
      }
    };
    loadImage();
  }, [characterMood, imageName]);

  // 各种点击事件 - 都会重置待机计时器
  const handleClick = () => {
    resetIdleTimer();
    tauri.toggleChatWindow();
  };
  const handleClickApi = () => {
    resetIdleTimer();
    tauri.changeManageWindow('api');
  };
  const handleClickSelectCharacter = () => {
    resetIdleTimer();
    tauri.changeManageWindow('assistants');
  };
  const handleClickSettings = () => {
    resetIdleTimer();
    tauri.changeSettingsWindow();
  };
  const handleClickMcp = () => {
    resetIdleTimer();
    tauri.changeManageWindow('mcp');
  };

  const handleToggleSocial = async () => {
    resetIdleTimer();
    tauri.openSocialWindow(); // toggle show/hide
  };

  // 监听来自其他窗口的社交控制事件（ManagementPage SocialPanel）
  useEffect(() => {
    let unlistenStart, unlistenStop, unlistenQuery, unlistenQueryLogs, unlistenClearLogs, unlistenConfigUpdated, unlistenSetLurkMode, unlistenSetCustomRule, unlistenSetTargetPaused, unlistenQueryTargetNames;
    let cancelled = false;
    const setup = async () => {
      const { listen: listenEvent, emit: emitEvent } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      
      unlistenStart = await listenEvent('social-start', async (event) => {
        const config = event.payload;
        if (!config?.petId) return;
        const started = await startSocialLoop(config, (active) => {
          setSocialActive(active);
          emitEvent('social-status-changed', { active, petId: config.petId, lurkModes: getLurkModes(), pausedTargets: getPausedTargets() });
        });
        setSocialActive(started);
        emitEvent('social-status-changed', { active: started, petId: config.petId, lurkModes: getLurkModes(), pausedTargets: getPausedTargets() });
      });

      unlistenStop = await listenEvent('social-stop', () => {
        const status = getSocialStatus();
        stopSocialLoop();
        setSocialActive(false);
        emitEvent('social-status-changed', { active: false, petId: status.petId, lurkModes: {} });
      });

      unlistenQuery = await listenEvent('social-query-status', () => {
        const status = getSocialStatus();
        emitEvent('social-status-changed', { active: status.active, petId: status.petId, lurkModes: status.lurkModes, pausedTargets: status.pausedTargets });
      });

      unlistenQueryLogs = await listenEvent('social-query-logs', () => {
        emitEvent('social-logs-response', getSocialLogs());
      });

      unlistenClearLogs = await listenEvent('social-clear-logs', () => {
        clearSocialLogs();
        emitEvent('social-logs-response', []);
      });

      // 潜水模式切换（per-target）
      unlistenSetLurkMode = await listenEvent('social-set-lurk-mode', (event) => {
        const { target, mode } = event.payload || {};
        setLurkMode(target, mode);
        emitEvent('social-lurk-mode-changed', { target, lurkModes: getLurkModes() });
      });

      // 用户自定义群规则热更新（per-target）
      unlistenSetCustomRule = await listenEvent('social-set-custom-rule', (event) => {
        const { target, rules } = event.payload || {};
        setCustomGroupRule(target, rules);
      });

      // 暂停/恢复单群处理（per-target）
      unlistenSetTargetPaused = await listenEvent('social-set-target-paused', (event) => {
        const { target, paused } = event.payload || {};
        setTargetPaused(target, paused);
        emitEvent('social-target-paused-changed', { target, pausedTargets: getPausedTargets() });
      });

      // target 名称查询
      unlistenQueryTargetNames = await listenEvent('social-query-target-names', () => {
        emitEvent('social-target-names-response', getTargetNames());
      });

      // 配置更新时热重启循环
      unlistenConfigUpdated = await listenEvent('social-config-updated', async (event) => {
        const newConfig = event.payload;
        if (!newConfig?.petId) return;
        const status = getSocialStatus();
        if (!status.active || status.petId !== newConfig.petId) return;
        // 用新配置重启循环
        const started = await startSocialLoop(newConfig, (active) => {
          setSocialActive(active);
          emitEvent('social-status-changed', { active, petId: newConfig.petId, lurkModes: getLurkModes(), pausedTargets: getPausedTargets() });
        });
        setSocialActive(started);
        emitEvent('social-status-changed', { active: started, petId: newConfig.petId, lurkModes: getLurkModes(), pausedTargets: getPausedTargets() });
      });
    };
    setup();

    return () => {
      cancelled = true;
      unlistenStart?.();
      unlistenStop?.();
      unlistenQuery?.();
      unlistenQueryLogs?.();
      unlistenClearLogs?.();
      unlistenConfigUpdated?.();
      unlistenSetLurkMode?.();
      unlistenSetCustomRule?.();
      unlistenSetTargetPaused?.();
      unlistenQueryTargetNames?.();
    };
  }, []);

  // ========== 混合拖动方案 + 双击打扰系统 ==========
  const dragState = useRef({
    isMouseDown: false,
    startX: 0,
    startY: 0,
    startTime: 0,
    isDragging: false,
  });
  
  // 打扰相关状态（保留，待接入其他触发方式）
  const pokeCountRef = useRef(0);              // 打扰计数
  const pokeResetTimerRef = useRef(null);      // 打扰计数重置定时器
  const POKE_ANGRY_THRESHOLD = 5;              // 触发愤怒的打扰次数
  const POKE_RESET_DELAY = 10000;              // 打扰计数重置延迟（10秒）
  const POKE_REACTION_DURATION = 1500;         // 被戳反应持续时间（1.5秒）

  // 悬浮 2 秒后切换光标，点击切换 idle
  const HOVER_IDLE_DELAY = 2000;
  const [idleClickReady, setIdleClickReady] = useState(false);
  const idleClickReadyRef = useRef(false);
  const hoverIdleTimerRef = useRef(null);
  
  /**
   * 处理被戳（双击）
   */
  const handlePoke = useCallback(() => {
    console.log('[Character] Poked! Count:', pokeCountRef.current + 1);
    
    // 重置待机计时器
    resetIdleTimer();
    
    // 增加打扰计数
    pokeCountRef.current += 1;
    
    // 重置打扰计数的定时器
    if (pokeResetTimerRef.current) {
      clearTimeout(pokeResetTimerRef.current);
    }
    pokeResetTimerRef.current = setTimeout(() => {
      console.log('[Character] Poke count reset');
      pokeCountRef.current = 0;
    }, POKE_RESET_DELAY);
    
    // 检查是否达到愤怒阈值
    if (pokeCountRef.current >= POKE_ANGRY_THRESHOLD) {
      console.log('[Character] Too many pokes! Getting angry...');
      // 显示愤怒（用 sad 表情，因为 angry 图片映射到 sad）
      setCharacterState(CHARACTER_STATE.ACTIVE);
      setEmotionMood('sad');  // 使用 sad 作为"不耐烦"的表情
      
      // 一段时间后恢复并进入待机
      setTimeout(() => {
        setEmotionMood('normal');
        pokeCountRef.current = 0;  // 重置计数
      }, POKE_REACTION_DURATION * 2);
    } else {
      // 普通戳反应 - 显示 shocked 表情（惊讶）
      setCharacterState(CHARACTER_STATE.ACTIVE);
      setEmotionMood('shocked');
      
      // 短暂显示后恢复
      setTimeout(() => {
        setEmotionMood('normal');
      }, POKE_REACTION_DURATION);
    }
  }, [resetIdleTimer]);

  /**
   * 切换 idle 状态（悬浮 2 秒后点击触发）
   */
  const toggleIdle = useCallback(() => {
    setCharacterState(prev => {
      if (prev === CHARACTER_STATE.IDLE) {
        console.log('[Character] Toggle -> exit idle');
        if (idleAnimationRef.current) {
          clearInterval(idleAnimationRef.current);
          idleAnimationRef.current = null;
        }
        setEmotionMood('normal');
        if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = setTimeout(() => {
          setCharacterState(p => p !== CHARACTER_STATE.THINKING ? CHARACTER_STATE.IDLE : p);
        }, IDLE_TIMEOUT_MS);
        return CHARACTER_STATE.ACTIVE;
      } else if (prev === CHARACTER_STATE.ACTIVE) {
        console.log('[Character] Toggle -> enter idle');
        if (idleTimeoutRef.current) {
          clearTimeout(idleTimeoutRef.current);
          idleTimeoutRef.current = null;
        }
        return CHARACTER_STATE.IDLE;
      }
      return prev;
    });
    // 重置悬浮状态，重新开始 2 秒计时
    idleClickReadyRef.current = false;
    setIdleClickReady(false);
    if (hoverIdleTimerRef.current) {
      clearTimeout(hoverIdleTimerRef.current);
    }
    hoverIdleTimerRef.current = setTimeout(() => {
      idleClickReadyRef.current = true;
      setIdleClickReady(true);
    }, HOVER_IDLE_DELAY);
  }, []);

  const handleCharacterMouseDown = useCallback((e) => {
    // 忽略右键和中键
    if (e.button !== 0) return;
    
    dragState.current = {
      isMouseDown: true,
      startX: e.clientX,
      startY: e.clientY,
      startTime: Date.now(),
      isDragging: false,
    };
    
    // 添加全局事件监听
    document.addEventListener('mousemove', handleCharacterMouseMove);
    document.addEventListener('mouseup', handleCharacterMouseUp);
  }, []);

  const handleCharacterMouseMove = useCallback((e) => {
    if (!dragState.current.isMouseDown) return;
    
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // 如果移动超过阈值且还没开始拖动，则开始拖动
    if (distance > DRAG_THRESHOLD && !dragState.current.isDragging) {
      dragState.current.isDragging = true;
      // 调用 Tauri 的窗口拖动 API
      tauri.startDragging();
      
      // 清理事件监听（拖动由系统接管）
      document.removeEventListener('mousemove', handleCharacterMouseMove);
      document.removeEventListener('mouseup', handleCharacterMouseUp);
      dragState.current.isMouseDown = false;
    }
  }, []);

  const handleCharacterMouseUp = useCallback((e) => {
    if (!dragState.current.isMouseDown) return;
    
    const elapsed = Date.now() - dragState.current.startTime;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // 清理事件监听
    document.removeEventListener('mousemove', handleCharacterMouseMove);
    document.removeEventListener('mouseup', handleCharacterMouseUp);
    
    // 如果是快速点击且移动距离小，视为点击
    if (elapsed < CLICK_TIME_THRESHOLD && distance < DRAG_THRESHOLD) {
      if (idleClickReadyRef.current) {
        // 光标已切换为 grab → 切换 idle 状态
        console.log('[Character] Idle toggle click!');
        toggleIdle();
      } else {
        // 普通单击 → 打开聊天窗口
        handleClick();
      }
    }
    
    dragState.current.isMouseDown = false;
    dragState.current.isDragging = false;
  }, [toggleIdle]);

  // 清理函数
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleCharacterMouseMove);
      document.removeEventListener('mouseup', handleCharacterMouseUp);
    };
  }, []);
  // ========== 拖动方案结束 ==========

  useEffect(() => {
    let windowSize = "medium";
    const getWindowSize = async() => {
      const settings = await tauri.getSettings();
      windowSize = settings.windowSize;
      tauri.updateWindowSizePreset(windowSize);
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

  // 计算是否有其他窗口打开（chat 或 manage/settings）
  const hasOtherWindowOpen = isChatVisible || isManageVisible;
  // 工具栏显示逻辑：如果有其他窗口打开则一直显示，否则使用鼠标悬停逻辑
  const showToolbar = hasOtherWindowOpen || isMouseOver;

  return (
    <div
      className="select-none h-full w-full flex flex-col justify-center items-center rounded-xl overflow-hidden"
    >
      {/* 顶部按钮区 */}
      <div className="h-[50px] w-full">
        {showToolbar && (
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
            <FaKey
              title="API Management"
              onClick={handleClickApi}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <FaRobot
              title="Assistants"
              onClick={handleClickSelectCharacter}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <FaPlug
              title="MCP Servers"
              onClick={handleClickMcp}
              className="text-gray-100 hover:text-gray-400 hover:scale-110 transition-all duration-300 ease-in-out cursor-pointer"
            />
            <FaUserGroup
              title="Social"
              onClick={handleToggleSocial}
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

      {/* 角色图片 - 可拖动区域 */}
      <div
        className={`flex-1 w-full flex items-center justify-center ${idleClickReady ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
        onMouseDown={handleCharacterMouseDown}
      >
        {imgSrc && (
        <img
          src={imgSrc}
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
        )}
      </div>
    </div>
  );
};

export default Character;