import React, { useState, useEffect, useRef } from "react";

// 检测平台
const isMacOS = typeof navigator !== 'undefined' && (
  navigator.platform.toUpperCase().indexOf('MAC') >= 0 || 
  navigator.userAgent.toUpperCase().indexOf('MAC') >= 0
);

export const SettingsHotkeyInput = ({ name, value, onChange }) => {
  // 当前已选择的按键
  const [keys, setKeys] = useState([]);
  // 当前正在输入的新按键
  const [currentKey, setCurrentKey] = useState("");
  // 输入框引用
  const inputRef = useRef(null);
  // 是否处于录入状态
  const [isRecording, setIsRecording] = useState(false);
  
  // 特殊按键映射
  const specialKeys = {
    " ": "Space",
    "Escape": "Esc",
    "ArrowUp": "↑",
    "ArrowDown": "↓",
    "ArrowLeft": "←",
    "ArrowRight": "→",
    "Enter": "Enter",
    "Backspace": "Backspace",
    "Delete": "Delete",
    "Tab": "Tab",
    "Home": "Home",
    "End": "End",
    "PageUp": "PageUp",
    "PageDown": "PageDown"
  };
  
  // 修饰键列表 - macOS 显示 Cmd，其他平台显示 Ctrl
  const cmdOrCtrlDisplay = isMacOS ? "Cmd" : "Ctrl";
  const modifierKeys = [cmdOrCtrlDisplay, "Alt", "Shift"];
  
  // 处理按键事件
  const handleKeyDown = (e) => {
    // 阻止默认行为和事件传播
    e.preventDefault();
    e.stopPropagation();
    
    // 处理按下的按键
    let keyPressed = "";
    
    // 输出调试信息 - 帮助了解按键事件
    console.log("Key pressed:", e.key, "Code:", e.code);
    
    // 修饰键处理 - macOS 的 Meta 键显示为 Cmd，Windows 的 Control 显示为 Ctrl
    if (e.key === "Control" || e.key === "Ctrl" || e.code.startsWith("Control")) keyPressed = "Ctrl";
    else if (e.key === "Alt" || e.code.startsWith("Alt")) keyPressed = "Alt";
    else if (e.key === "Shift" || e.code.startsWith("Shift")) keyPressed = "Shift";
    else if (e.key === "Meta" || e.code.startsWith("Meta") || e.key === "Command" || e.key === "Win") keyPressed = isMacOS ? "Cmd" : "Ctrl";
    // 特殊按键处理
    else if (specialKeys[e.key]) keyPressed = specialKeys[e.key];
    // 功能键处理 (F1-F12)
    else if (/^F\d+$/.test(e.key) || /^F\d+$/.test(e.code)) {
      // 如果e.key包含F数字，直接使用e.key
      if (/^F\d+$/.test(e.key)) {
        keyPressed = e.key;
      } 
      // 否则从e.code提取F数字（例如 KeyF1 -> F1）
      else if (/^F\d+$/.test(e.code)) {
        keyPressed = e.code.match(/F\d+/)[0];
      }
    }
    // 数字键处理
    else if (/^[0-9]$/.test(e.key)) {
      keyPressed = e.key;
    }
    // 其他普通字符键处理
    else if (e.key.length === 1) {
      keyPressed = e.key.toUpperCase();
    }
    // 处理其他特殊情况
    else {
      // 如果没有匹配到其他规则，尝试从e.code提取按键信息
      if (e.code.startsWith("Key")) {
        // 处理 "KeyA" -> "A" 这样的转换
        keyPressed = e.code.substring(3).toUpperCase();
      } else if (e.code.startsWith("Digit")) {
        // 处理 "Digit1" -> "1" 这样的转换
        keyPressed = e.code.substring(5);
      } else if (e.code.startsWith("Numpad")) {
        // 处理数字键盘 "Numpad1" -> "1(Numpad)" 这样的转换
        keyPressed = e.code.substring(6) + "(Numpad)";
      } else {
        keyPressed = e.key;
      }
    }
    
    // 如果是有效按键，立即添加到输入框
    if (keyPressed) {
      setCurrentKey(keyPressed);
      // 短暂延时后结束录入状态，让用户可以看到按键效果
      setTimeout(() => {
        setIsRecording(false);
      }, 100);
    }
    
    return false;
  };
  
  // 添加当前按键到组合中
  const addCurrentKey = () => {
    if (currentKey && keys.length < 3) {
      // 创建新的按键数组，确保修饰键在前面
      let newKeys = [...keys];
      
      if (modifierKeys.includes(currentKey)) {
        // 如果是修饰键且不存在，添加到前面
        if (!newKeys.includes(currentKey)) {
          newKeys.unshift(currentKey);
        }
      } else {
        // 如果是普通键，添加到末尾(如果不存在)
        if (!newKeys.includes(currentKey)) {
          newKeys.push(currentKey);
        }
      }
      
      // 最多3个按键
      if (newKeys.length > 3) {
        newKeys = newKeys.slice(0, 3);
      }
      
      setKeys(newKeys);
      updateParent(newKeys);
      setCurrentKey("");
    }
  };
  
  // 从组合中移除指定按键
  const removeKey = (keyToRemove) => {
    const newKeys = keys.filter(k => k !== keyToRemove);
    setKeys(newKeys);
    updateParent(newKeys);
  };
  
  // 更新父组件的值
  const updateParent = (newKeys) => {
    if (newKeys.length === 0) {
      onChange({ target: { name, value: "" } });
    } else {
      onChange({ target: { name, value: newKeys.join(" + ") } });
    }
  };
  
  // 开始录入新按键
  const startRecording = () => {
    setIsRecording(true);
    setCurrentKey("");
    
    // 确保输入框获得焦点
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }, 10);
  };
  
  // 初始化时从value解析按键
  useEffect(() => {
    if (value && typeof value === 'string') {
      // 确保正确地从 "Ctrl + Alt + A" 这样的格式解析出按键数组
      let keyArray = value.split(" + ").map(k => k.trim()).filter(k => k);
      // 将 Meta 转换为平台对应的显示名称
      keyArray = keyArray.map(k => {
        if (k === 'Meta' || k === 'meta') return isMacOS ? 'Cmd' : 'Ctrl';
        if (k === 'Cmd' || k === 'cmd') return isMacOS ? 'Cmd' : 'Ctrl';
        return k;
      });
      setKeys(keyArray);
    } else {
      setKeys([]);
    }
  }, [value]);
  
  // 当按下按键并设置了currentKey，自动添加到组合中
  useEffect(() => {
    if (currentKey) {
      // 即时添加按键
      addCurrentKey();
    }
  }, [currentKey]);
  
  // 自动聚焦输入框当处于录入状态时
  useEffect(() => {
    if (isRecording && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isRecording]);
  
  return (
    <div className="w-full space-y-2">
      {/* 已选按键显示区域 */}
      <div className="flex items-center gap-2 flex-wrap">
        {keys.map((key, index) => (
          <div 
            key={index} 
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-gradient-to-b from-slate-50 to-slate-100 
                       text-slate-700 text-sm font-medium rounded-md border border-slate-200 shadow-sm"
          >
            <span>{key}</span>
            <button
              type="button"
              onClick={() => removeKey(key)}
              className="text-slate-400 hover:text-red-500 transition-colors ml-0.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
        
        {/* 添加按键按钮 */}
        {keys.length < 3 && (
          <button
            type="button"
            onClick={startRecording}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-sm font-medium rounded-md border transition-all ${
              isRecording 
                ? 'bg-amber-50 border-amber-300 text-amber-700' 
                : 'bg-white border-dashed border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-600'
            }`}
          >
            {isRecording ? (
              <>
                <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>
                Press a key...
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add key
              </>
            )}
          </button>
        )}
      </div>
      
      {/* 当前快捷键预览 */}
      <div className="text-xs text-slate-500">
        {keys.length > 0 ? (
          <span>Current: <span className="font-medium text-slate-700">{keys.join(' + ')}</span></span>
        ) : (
          <span>Click "Add key" to set shortcut</span>
        )}
      </div>
      
      {/* 隐藏的输入框，用于捕获按键 */}
      <input
        ref={inputRef}
        type="text"
        className="opacity-0 absolute h-0 w-0"
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => e.preventDefault()}
        onKeyPress={(e) => e.preventDefault()}
        disabled={!isRecording}
        autoFocus={isRecording}
      />
    </div>
  );
};

export default SettingsHotkeyInput;