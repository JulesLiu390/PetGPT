import React, { useState, useEffect } from "react";
import SettingsTitleBar from "./SettingsTitleBar";
import SettingsHotkeyInput from "./SettingsHotkeyInput";

// 设置页面组件
const SettingsPage = () => {
  const [settings, setSettings] = useState(null);
  const [pets, setPets] = useState([]);

  // 获取宠物列表
  const fetchPets = async () => {
    try {
      const data = await window.electron.getPets();
      if (Array.isArray(data)) {
        setPets(data);
      } else {
        console.error("Invalid data format returned from getPets:", data);
      }
    } catch (error) {
      alert("Failed to load characters: " + error.message);
    }
  };

  // 获取设置
  const fetchSettings = async () => {
    try {
      const data = await window.electron.getSettings();
      setSettings(data);
    } catch (error) {
      console.error("Failed to get settings:", error);
    }
  };

  useEffect(() => {
    fetchPets();
    fetchSettings();
  }, []);

  // 加载中显示
  if (!settings) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        Loading...
      </div>
    );
  }

  const handleChange = (e) => {
    const { name, value } = e.target;
    setSettings((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const newSettings = await window.electron.updateSettings(settings);
      setSettings(newSettings);
      alert("Settings saved successfully!");
    } catch (error) {
      alert("Failed to save settings: " + error.message);
    }

    window.electron.updateWindowSizePreset(settings.windowSize)
    window.electron.updateShortcuts(settings.programHotkey, settings.dialogHotkey)
  };

  // 宠物显示文本
  const getDisplayText = (pet) => {
    return pet.modelName ? `${pet.name} (${pet.modelName})` : pet.name;
  };

  return (
    <div className="min-h-screen bg-[rgba(255,255,255,0.8)]">
      {/* 标题栏 */}
      <div className="sticky top-0 z-10">
        <SettingsTitleBar />
      </div>
      <div className="w-[90%] p-4 mx-auto bg-gray-50 rounded-lg shadow">
        <form onSubmit={handleSubmit} className="space-y-4 text-sm">
          {/* 默认模型选择 */}
          <div>
            <label className="block text-gray-700 mb-1">
              Default Chatbot
            </label>
            <select
              name="defaultRoleId"
              value={settings.defaultRoleId || ""}
              onChange={handleChange}
              className="w-full p-2 border rounded"
            >
              <option value="">Select Default Model</option>
              {pets.map((pet) => (
                <option key={pet._id} value={pet._id}>
                  {getDisplayText(pet)}
                </option>
              ))}
            </select>
          </div>
          {/* 功能模型选择 */}
          <div>
            <label className="block text-gray-700 mb-1">
              Function Model (Recommended: mini)
            </label>
            <select
              name="defaultModelId"
              value={settings.defaultModelId || ""}
              onChange={handleChange}
              className="w-full p-2 border rounded"
            >
              <option value="">Select Function Model</option>
              {pets.map((pet) => (
                <option key={pet._id} value={pet._id}>
                  {getDisplayText(pet)}
                </option>
              ))}
            </select>
          </div>
          {/* 窗口大小 */}
          <div>
            <label className="block text-gray-700 mb-1">Window Size</label>
            <select
              name="windowSize"
              value={settings.windowSize || "medium"}
              onChange={handleChange}
              className="w-full p-2 border rounded"
            >
              <option value="large">Large</option>
              <option value="medium">Medium</option>
              <option value="small">Small</option>
            </select>
          </div>
          {/* 程序热键设置 */}
          <div>
            <label className="block text-gray-700 mb-1">
              Program Hotkey
            </label>
            <SettingsHotkeyInput
              name="programHotkey"
              value={settings.programHotkey || ""}
              onChange={handleChange}
            />
          </div>
          {/* 对话热键设置 */}
          <div>
            <label className="block text-gray-700 mb-1">
              Dialog Hotkey
            </label>
            <SettingsHotkeyInput
              name="dialogHotkey"
              value={settings.dialogHotkey || ""}
              onChange={handleChange}
            />
          </div>
          {/* 保存按钮 */}
          <button
            type="submit"
            className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600"
          >
            Save Settings
          </button>
        </form>
      </div>
    </div>
  );
};

export default SettingsPage;