import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { FaRocketchat, FaKey, FaRobot } from "react-icons/fa";
import { FaPlug, FaUserGroup } from "react-icons/fa6";
import { IoIosSettings } from "react-icons/io";
import * as tauri from '../utils/tauri';
import { getRandomIdleState } from '../utils/moodDetector';
import PseudoLive2DCharacter from '../components/Avatar/PseudoLive2DCharacter';
import { startSocialLoop, stopSocialLoop, isSocialActiveForPet, getSocialStatus, getSocialLogs, clearSocialLogs, setLurkMode, getLurkModes, setTargetPaused, getPausedTargets, getTargetNames, setCustomGroupRule } from '../utils/socialAgent';

// 拖动检测配置
const DRAG_THRESHOLD = 8; // 留出轻微手抖空间，移动超过 8px 才视为拖动

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

export const Character = () => {
  // window.electron?.testOpen("open -a Calculator");
  
  // ============ 状态分层管理 ============
  // 第一层：角色状态（active/idle/thinking）
  const [characterState, setCharacterState] = useState(CHARACTER_STATE.ACTIVE);
  // 第二层：情绪表情（normal/smile/sad/shocked）- 仅在 active 状态下有效
  const [emotionMood, setEmotionMood] = useState("normal");
  // 第三层：当前待机动画帧（idle-1/idle-2/idle-3）- 仅在 idle 状态下有效
  const [idleFrame, setIdleFrame] = useState("idle-1");
  
  // 计算最终显示的表情/状态（驱动分层皮肤）
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
  
  // 鼠标是否在窗口上（通过 Rust 轮询检测，即使窗口失去焦点也能工作）
  const [isMouseOver, setIsMouseOver] = useState(false);
  // 控制 Settings/Manage 窗口是否打开
  const [isManageVisible, setIsManageVisible] = useState(false);
  // 控制 Chat 窗口是否打开
  const [isChatVisible, setIsChatVisible] = useState(false);
  const [currentPetId, setCurrentPetId] = useState(null);
  
  // 社交代理激活状态
  const [, setSocialActive] = useState(false);
  
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
          } catch {
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
      
      // 设置当前角色 ID。人物渲染已切到新的分层皮肤。
      if (foundPet) {
        setCurrentPetId(foundPet.id || foundPet._id);
      }
    } catch (error) {
      console.error("Error loading character:", error);
    }
  }, []);

  // 启动时加载角色。idle 计时器由上方唯一的初始化 effect 管理。
  useEffect(() => {
    loadCharacter();
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
    let cleanup = null;
    let cancelled = false;
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('mouse-over-character', (event) => {
        setIsMouseOver(Boolean(event.payload));
      });
      if (cancelled) unlisten();
      else cleanup = unlisten;
    };
    setupListener().catch(error => {
      console.error('[Character] Failed to listen for mouse hover:', error);
    });

    return () => {
      cancelled = true;
      cleanup?.();
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
    };
  }, [moodResetDelay, characterState, enterThinkingState, exitThinkingWithMood, resetIdleTimer]);

  // 监听角色 ID
  useEffect(() => {
    const handleCharacterId = (id) => {
      console.log("📩 Received character ID:", id);
      loadCharacter(id);
    };
    const cleanup = tauri.onCharacterId(handleCharacterId);
    return () => {
      if (cleanup) cleanup();
    };
  }, [loadCharacter]);

  // onConversationId 已移除：onCharacterId 已经直接用 petId 刷新当前角色上下文。

  // 各种点击事件 - 都会重置待机计时器
  const handleClick = useCallback(() => {
    resetIdleTimer();
    tauri.toggleChatWindow();
  }, [resetIdleTimer]);
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

  // ========== 人物单击与窗口拖动 ==========
  const dragState = useRef({
    isMouseDown: false,
    startX: 0,
    startY: 0,
    isDragging: false,
  });
  const dragMoveHandlerRef = useRef(null);
  const dragUpHandlerRef = useRef(null);
  const dragCancelHandlerRef = useRef(null);

  const clearCharacterGestureListeners = useCallback(() => {
    if (dragMoveHandlerRef.current) {
      document.removeEventListener('mousemove', dragMoveHandlerRef.current);
    }
    if (dragUpHandlerRef.current) {
      document.removeEventListener('mouseup', dragUpHandlerRef.current);
    }
    if (dragCancelHandlerRef.current) {
      window.removeEventListener('blur', dragCancelHandlerRef.current);
    }
  }, []);

  const handleCharacterMouseMove = useCallback((e) => {
    if (!dragState.current.isMouseDown) return;

    // A mouseup outside the webview may not reach document. Cancel as soon as
    // the pointer returns without the primary button held.
    if ((e.buttons & 1) === 0) {
      clearCharacterGestureListeners();
      dragState.current.isMouseDown = false;
      dragState.current.isDragging = false;
      return;
    }
    
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // 如果移动超过阈值且还没开始拖动，则开始拖动
    if (distance > DRAG_THRESHOLD && !dragState.current.isDragging) {
      dragState.current.isDragging = true;
      dragState.current.isMouseDown = false;
      clearCharacterGestureListeners();
      void tauri.startDragging().catch(error => {
        console.error('[Character] Failed to start window drag:', error);
      });
    }
  }, [clearCharacterGestureListeners]);

  const handleCharacterMouseUp = useCallback((e) => {
    if (e.button !== 0 || !dragState.current.isMouseDown) return;

    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    clearCharacterGestureListeners();
    if (!dragState.current.isDragging && distance <= DRAG_THRESHOLD) {
      handleClick();
    }

    dragState.current.isMouseDown = false;
    dragState.current.isDragging = false;
  }, [clearCharacterGestureListeners, handleClick]);

  const cancelCharacterGesture = useCallback(() => {
    clearCharacterGestureListeners();
    dragState.current.isMouseDown = false;
    dragState.current.isDragging = false;
  }, [clearCharacterGestureListeners]);

  dragMoveHandlerRef.current = handleCharacterMouseMove;
  dragUpHandlerRef.current = handleCharacterMouseUp;
  dragCancelHandlerRef.current = cancelCharacterGesture;

  const handleCharacterMouseDown = useCallback((e) => {
    if (e.button !== 0) return;

    dragState.current = {
      isMouseDown: true,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
    };

    document.addEventListener('mousemove', dragMoveHandlerRef.current);
    document.addEventListener('mouseup', dragUpHandlerRef.current);
    window.addEventListener('blur', dragCancelHandlerRef.current);
  }, []);

  useEffect(() => {
    return cancelCharacterGesture;
  }, [cancelCharacterGesture]);
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
        className="flex-1 w-full flex items-center justify-center cursor-default"
        onMouseDown={handleCharacterMouseDown}
      >
        <PseudoLive2DCharacter mood={characterMood} />
      </div>
    </div>
  );
};

export default Character;
