import React, { useState, useEffect } from "react";
import SettingsTitleBar from "../components/Layout/SettingsTitleBar";
import SettingsHotkeyInput from "../components/Settings/SettingsHotkeyInput";
import { PageLayout, Surface, Card, FormGroup, Label, Select, Button } from "../components/UI/ui";
import { FaSpinner } from "react-icons/fa";
import * as bridge from "../utils/bridge";
import { useSettings } from "../utils/useSettings";

// 设置页面组件
const SettingsPage = () => {
  // 使用 useSettings hook 获取实时同步的设置
  const { settings: syncedSettings, loading: settingsLoading, updateSettings: saveSettings } = useSettings();
  const [localSettings, setLocalSettings] = useState(null);
  const [assistants, setAssistants] = useState([]);
  const [modelConfigs, setModelConfigs] = useState([]);
  const [saving, setSaving] = useState(false);

  // 当同步设置加载完成时，初始化本地设置
  useEffect(() => {
    if (!settingsLoading && syncedSettings && Object.keys(syncedSettings).length > 0) {
      setLocalSettings(syncedSettings);
    }
  }, [syncedSettings, settingsLoading]);

  // 获取 Assistants 列表
  const fetchAssistants = async () => {
    try {
      const data = await bridge.getAssistants();
      if (Array.isArray(data)) {
        setAssistants(data);
      }
    } catch (error) {
      console.error("Failed to load assistants:", error);
    }
  };

  // 获取 ModelConfigs 列表
  const fetchModelConfigs = async () => {
    try {
      const data = await bridge.getModelConfigs();
      if (Array.isArray(data)) {
        setModelConfigs(data);
      }
    } catch (error) {
      console.error("Failed to load model configs:", error);
    }
  };

  useEffect(() => {
    fetchAssistants();
    fetchModelConfigs();
  }, []);
  
  // 使用本地设置作为显示，便于编辑
  const settings = localSettings;

  // 加载中显示
  if (!settings) {
    return (
      <PageLayout className="bg-white/95">
        <div className="h-screen flex flex-col items-center justify-center">
          <FaSpinner className="animate-spin text-2xl text-blue-500" />
          <p className="mt-2 text-slate-600 text-sm">Loading...</p>
        </div>
      </PageLayout>
    );
  }

  const handleChange = (e) => {
    const { name, value } = e.target;
    setLocalSettings((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      // 使用 useSettings hook 的 saveSettings 方法保存设置
      // 这会自动触发事件，同步到所有窗口
      await saveSettings(localSettings);
      alert("Settings saved successfully!");
    } catch (error) {
      alert("Failed to save settings: " + error.message);
    } finally {
      setSaving(false);
    }

    bridge.updateWindowSizePreset(localSettings.windowSize);
    bridge.updateShortcuts(localSettings.programHotkey, localSettings.dialogHotkey);
  };

  // 获取 Assistant 的显示文本（包含关联的 Model 信息）
  const getAssistantDisplayText = (assistant) => {
    const linkedModel = modelConfigs.find(m => m._id === assistant.modelConfigId);
    if (linkedModel) {
      return `${assistant.name} (${linkedModel.modelName})`;
    }
    return assistant.name;
  };

  // 获取 ModelConfig 的显示文本
  const getModelConfigDisplayText = (model) => {
    return `${model.name} (${model.modelName})`;
  };

  return (
    <PageLayout className="bg-white/95">
      <div className="h-screen flex flex-col overflow-hidden">
        {/* 标题栏 */}
        <div className="sticky top-0 z-10">
          <SettingsTitleBar />
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
          <Surface className="max-w-lg mx-auto p-5">
            <form onSubmit={handleSubmit} className="space-y-5">
              
              {/* Default Assistants Section */}
              <Card title="Default Assistants" description="Configure which assistants to use by default">
                <div className="space-y-4">
                  <FormGroup label="Default Chatbot" hint="The assistant used for new conversations">
                    <Select
                      name="defaultRoleId"
                      value={settings.defaultRoleId || ""}
                      onChange={handleChange}
                    >
                      <option value="">Select Default Assistant</option>
                      {assistants.map((assistant) => (
                        <option key={assistant._id} value={assistant._id}>
                          {getAssistantDisplayText(assistant)}
                        </option>
                      ))}
                    </Select>
                  </FormGroup>
                  
                  <FormGroup label="Function Model" hint="Lightweight model for quick tasks (mini recommended)">
                    <Select
                      name="defaultModelId"
                      value={settings.defaultModelId || ""}
                      onChange={handleChange}
                    >
                      <option value="">Select Function Model</option>
                      {modelConfigs.map((model) => (
                        <option key={model._id} value={model._id}>
                          {getModelConfigDisplayText(model)}
                        </option>
                      ))}
                    </Select>
                  </FormGroup>
                </div>
              </Card>
              
              {/* Window Settings */}
              <Card title="Window Settings" description="Customize the application window">
                <FormGroup label="Window Size">
                  <Select
                    name="windowSize"
                    value={settings.windowSize || "medium"}
                    onChange={handleChange}
                  >
                    <option value="large">Large</option>
                    <option value="medium">Medium</option>
                    <option value="small">Small</option>
                  </Select>
                </FormGroup>
              </Card>
              
              {/* Hotkey Settings */}
              <Card title="Keyboard Shortcuts" description="Configure global hotkeys for quick access">
                <div className="space-y-4">
                  <FormGroup label="Program Hotkey" hint="Show/hide the application">
                    <SettingsHotkeyInput
                      name="programHotkey"
                      value={settings.programHotkey || ""}
                      onChange={handleChange}
                    />
                  </FormGroup>
                  
                  <FormGroup label="Dialog Hotkey" hint="Open quick dialog anywhere">
                    <SettingsHotkeyInput
                      name="dialogHotkey"
                      value={settings.dialogHotkey || ""}
                      onChange={handleChange}
                    />
                  </FormGroup>
                </div>
              </Card>
              
              {/* 保存按钮 */}
              <div className="pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={saving}
                  className="w-full py-3"
                >
                  {saving ? (
                    <span className="flex items-center gap-2">
                      <FaSpinner className="animate-spin w-4 h-4" />
                      Saving...
                    </span>
                  ) : "Save Settings"}
                </Button>
              </div>
              
            </form>
          </Surface>
        </div>
      </div>
    </PageLayout>
  );
};

export default SettingsPage;