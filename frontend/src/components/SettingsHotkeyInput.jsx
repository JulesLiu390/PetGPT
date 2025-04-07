import React, { useState, useEffect, useRef } from "react";

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
  
  // 修饰键列表
  const modifierKeys = ["Ctrl", "Alt", "Shift", "Meta"];
  
  // 处理按键事件
  const handleKeyDown = (e) => {
    // 阻止默认行为和事件传播
    e.preventDefault();
    e.stopPropagation();
    
    // 处理按下的按键
    let keyPressed = "";
    
    // 输出调试信息 - 帮助了解按键事件
    console.log("Key pressed:", e.key, "Code:", e.code);
    
    // 修饰键处理
    if (e.key === "Control" || e.key === "Ctrl" || e.code.startsWith("Control")) keyPressed = "Ctrl";
    else if (e.key === "Alt" || e.code.startsWith("Alt")) keyPressed = "Alt";
    else if (e.key === "Shift" || e.code.startsWith("Shift")) keyPressed = "Shift";
    else if (e.key === "Meta" || e.code.startsWith("Meta") || e.key === "Command" || e.key === "Win") keyPressed = "Meta";
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
      const keyArray = value.split(" + ").map(k => k.trim()).filter(k => k);
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
    <div className="w-full">
      <div className="mb-2">
        {/* 已选按键显示 */}
        <div className="flex flex-wrap gap-1 mb-2">
          {keys.map((key, index) => (
            <div key={index} className="flex items-center bg-blue-100 rounded px-2 py-1">
              <span className="mr-1">{key}</span>
              <button
                type="button"
                onClick={() => removeKey(key)}
                className="text-red-500 hover:text-red-700"
              >
                ✕
              </button>
            </div>
          ))}
          
          {/* 添加按键按钮 */}
          {keys.length < 3 && (
            <button
              type="button"
              onClick={startRecording}
              className={`px-2 py-1 border rounded ${isRecording ? 'bg-yellow-100' : 'bg-gray-100'}`}
            >
              {isRecording ? "Please press key..." : "+ add key"}
            </button>
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
      
      {/* 当前组合显示 */}
      <div className="text-center p-2 bg-gray-100 rounded">
        {keys.length > 0 ? (
          <span>Present Shortcut: {keys.join("+")}</span>
        ) : (
          <span className="text-gray-500">Please Press key</span>
        )}
      </div>
    </div>
  );
};

export default SettingsHotkeyInput;