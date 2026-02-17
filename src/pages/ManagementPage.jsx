import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { FaPlus, FaTrash, FaPen, FaCheck, FaSpinner, FaList, FaServer, FaKey, FaChevronDown, FaChevronUp, FaRobot, FaPlug, FaPalette, FaGear, FaKeyboard, FaShirt, FaSliders, FaEye, FaEyeSlash, FaFile, FaDownload, FaCamera } from "react-icons/fa6";
import { FiRefreshCw } from 'react-icons/fi';
import { MdClose } from "react-icons/md";
import { GiPenguin } from "react-icons/gi";
import { LuMaximize2 } from "react-icons/lu";
import TitleBar from "../components/UI/TitleBar";
import { PageLayout, Surface, Card, FormGroup, Input, Select, Textarea, Button, Alert, Label, Badge, Checkbox } from "../components/UI/ui";
import { IconSelectorTrigger } from "../components/UI/IconSelector";
import { fetchModels, callOpenAILib } from "../utils/openai";
import { getPresetsForFormat, getDefaultBaseUrl, findPresetByUrl, getDetectionCandidates } from "../utils/llm/presets";
import * as tauri from "../utils/tauri";
import { useSettings } from "../utils/useSettings";
import SettingsHotkeyInput from "../components/Settings/SettingsHotkeyInput";
import { useStateValue } from "../context/StateProvider";
import { actionType } from "../context/reducer";
import { loadSocialConfig, saveSocialConfig } from "../utils/socialAgent";
import { emit, listen } from '@tauri-apps/api/event';

// 预加载所有内置皮肤图片
import JulesNormal from "../assets/Jules-normal.png";
import MaodieNormal from "../assets/Maodie-normal.png";
import LittlePonyNormal from "../assets/LittlePony-normal.png";

// 内置皮肤图片映射
const BUILTIN_SKIN_IMAGES = {
  'Jules': JulesNormal,
  'default': JulesNormal,
  'Maodie': MaodieNormal,
  'LittlePony': LittlePonyNormal,
};

// ==================== Shared Components ====================

const CustomImage = ({ imageName }) => {
  const [imgSrc, setImgSrc] = useState("");

  useEffect(() => {
    const loadImage = async () => {
      try {
        const skinName = imageName === "default" ? "Jules" : imageName;
        
        // 处理 custom: 前缀的自定义皮肤
        if (skinName && skinName.startsWith("custom:")) {
          const skinId = skinName.split(":")[1];
          try {
            const base64Image = await tauri.readSkinImage(skinId, "normal");
            if (base64Image) {
              setImgSrc(base64Image);
              return;
            }
          } catch (e) {
            console.warn("Custom skin not found, falling back to default:", e);
          }
          // 回退到默认皮肤
          setImgSrc(BUILTIN_SKIN_IMAGES['Jules']);
          return;
        }
        
        // 检查是否是预加载的内置皮肤
        if (BUILTIN_SKIN_IMAGES[skinName]) {
          setImgSrc(BUILTIN_SKIN_IMAGES[skinName]);
          return;
        }
        
        // 尝试从旧的 readPetImage 加载（兼容旧数据）
        if (skinName) {
          try {
            const base64Image = await tauri.readPetImage(`${skinName}-normal.png`);
            if (base64Image) {
              setImgSrc(base64Image);
              return;
            }
          } catch (e) {
            // ignore
          }
        }
        
        // 最终回退到默认 Jules
        setImgSrc(BUILTIN_SKIN_IMAGES['Jules']);
      } catch (error) {
        console.error("Error loading image:", error);
        setImgSrc(BUILTIN_SKIN_IMAGES['Jules']);
      }
    };
    loadImage();
  }, [imageName]);

  return (
    <div className="w-16 h-16 rounded-xl overflow-hidden bg-slate-100 shrink-0">
      <img src={imgSrc} alt="Character" className="w-full h-full object-cover" />
    </div>
  );
};

const TruncatedText = ({ label, text }) => {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  const isLong = text.length > 80;
  const displayText = expanded || !isLong ? text : text.slice(0, 80) + '...';

  return (
    <div className="text-sm text-gray-600">
      <span className="font-medium">{label}: </span>
      {displayText}
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-1 text-blue-500 hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
};

// ==================== Assistants Panel ====================

/**
 * 根据 apiFormat 获取默认图片名
 */
const getDefaultImageForApi = (apiFormat) => {
  // 新的内置皮肤只有 Jules 和 Maodie，默认使用 Jules
  return 'Jules';
};

/**
 * Assistant 编辑/创建表单
 */
const AssistantForm = ({ assistant, onSave, onCancel }) => {
  const [apiProviders, setApiProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [availableModels, setAvailableModels] = useState([]);
  const [builtinSkins, setBuiltinSkins] = useState([]);
  const [customSkins, setCustomSkins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  const [formData, setFormData] = useState({
    name: assistant?.name || "",
    systemInstruction: assistant?.systemInstruction || "You are a helpful assistant.",
    appearance: assistant?.appearance || "",
    imageName: assistant?.imageName || "default",
    hasMood: assistant?.hasMood !== false,
    modelName: assistant?.modelName || "",
    modelUrl: assistant?.modelUrl || "",
    modelApiKey: assistant?.modelApiKey || "",
    apiFormat: assistant?.apiFormat || "",
    modelConfigId: "", // Clear legacy config ID to ensure local settings take precedence
  });
  
  // 加载皮肤列表（区分内置和自定义）
  const loadSkins = async () => {
    try {
      const skins = await tauri.getSkins();
      const skinsList = Array.isArray(skins) ? skins : [];
      // 分离内置皮肤和自定义皮肤
      const builtin = skinsList.filter(s => s.isBuiltin);
      const custom = skinsList.filter(s => !s.isBuiltin);
      setBuiltinSkins(builtin);
      setCustomSkins(custom);
    } catch (err) {
      console.error('[AssistantForm] Failed to load skins:', err);
    }
  };
  
  useEffect(() => {
    loadSkins();
  }, []);
  
  // 监听皮肤更新事件
  useEffect(() => {
    const cleanup = tauri.onSkinsUpdated?.(() => {
      console.log('[AssistantForm] Skins updated, refreshing list...');
      loadSkins();
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 加载可用的 API Providers
  useEffect(() => {
    const loadApiProviders = async () => {
      try {
        const rawProviders = await tauri.apiProviders.getAll();
        if (Array.isArray(rawProviders)) {
          // Normalize providers: ensure id exists and cachedModels is parsed
          const providers = rawProviders.map(p => ({
            ...p,
            id: p.id || p._id, // Ensure ID is consistent
            cachedModels: typeof p.cachedModels === 'string' 
              ? JSON.parse(p.cachedModels) 
              : (p.cachedModels || [])
          }));
          
          setApiProviders(providers);
          
          // 如果是编辑模式，匹配现有的 provider
          if (assistant && assistant.modelUrl && assistant.modelApiKey) {
            const matchedProvider = providers.find(p => 
              p.baseUrl === assistant.modelUrl && 
              p.apiKey === assistant.modelApiKey
            );
            if (matchedProvider) {
              setSelectedProviderId(matchedProvider.id);
              setAvailableModels(matchedProvider.cachedModels);
            }
          } else if (!assistant && providers.length > 0) {
            // 新建模式，默认选第一个
            handleProviderChange(providers[0].id, providers);
          }
        }
      } catch (error) {
        console.error("Failed to load API providers:", error);
      } finally {
        setLoading(false);
      }
    };
    loadApiProviders();
    
    // Listen for provider updates
    let unlistenFn;
    const setupListener = async () => {
      if (tauri.listen) {
        unlistenFn = await tauri.listen("api-providers-updated", (event) => {
          console.log("API Providers updated, refreshing list...");
          loadApiProviders();
        });
      }
    };
    setupListener();
    
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [assistant]);

  const handleProviderChange = (providerId, providerList = apiProviders) => {
    setSelectedProviderId(providerId);
    
    if (!providerId) {
      setAvailableModels([]);
      setFormData(prev => ({
        ...prev,
        modelName: "",
        modelUrl: "",
        modelApiKey: "",
        apiFormat: "",
      }));
      return;
    }
    
    const provider = providerList.find(p => p.id === providerId);
    if (provider) {
      const models = provider.cachedModels || [];
      setAvailableModels(models);
      
      const firstModel = models.length > 0 ? models[0] : "";
      setFormData(prev => ({
        ...prev,
        modelUrl: provider.baseUrl || "",
        modelApiKey: provider.apiKey || "",
        apiFormat: provider.apiFormat || "",
        modelName: assistant ? prev.modelName : firstModel,
        imageName: assistant ? prev.imageName : getDefaultImageForApi(provider.apiFormat),
      }));
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ 
      ...prev, 
      [name]: type === 'checkbox' ? checked : value 
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      alert("Please enter an assistant name.");
      return;
    }
    
    if (!formData.modelName || !formData.modelUrl || !formData.apiFormat) {
      alert("Please select an API Provider and Model.");
      return;
    }

    setSaving(true);
    try {
      // Explicitly clear modelConfigId to ensure the Assistant's local settings (Pro) take precedence
      // over any stale linked configuration (Flash)
      await onSave({ ...formData, modelConfigId: "" });
    } catch (error) {
      console.error("Save failed:", error);
      alert("Failed to save: " + (error.message || error));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <FaSpinner className="animate-spin text-xl text-blue-500" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {apiProviders.length === 0 && (
        <Alert variant="warning">
          <strong>No API Providers Found</strong><br/>
          Please add an API provider first before creating an assistant.
        </Alert>
      )}

      <FormGroup>
        <Label required>Assistant Name</Label>
        <Input
          name="name"
          placeholder="e.g. My Helper, Code Assistant..."
          value={formData.name}
          onChange={handleChange}
          required
        />
      </FormGroup>

      {/* API Provider & Model Selection */}
      <div className="p-3 bg-slate-50 rounded-lg space-y-3">
        <div className="text-sm font-medium text-slate-700">API Configuration</div>
        
        <FormGroup>
          <Label required>API Provider</Label>
          <Select
            value={selectedProviderId}
            onChange={(e) => handleProviderChange(e.target.value)}
            disabled={apiProviders.length === 0}
          >
            {apiProviders.length === 0 ? (
              <option value="">No providers available</option>
            ) : (
              <>
                <option value="">-- Select API Provider --</option>
                {apiProviders.map(provider => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} ({provider.apiFormat})
                  </option>
                ))}
              </>
            )}
          </Select>
        </FormGroup>

        <FormGroup>
          <Label required>Model</Label>
          <Select
            value={formData.modelName}
            onChange={(e) => setFormData(prev => ({ ...prev, modelName: e.target.value }))}
            disabled={!selectedProviderId || availableModels.length === 0}
          >
            {availableModels.length === 0 ? (
              <option value="">No models available</option>
            ) : (
              <>
                <option value="">-- Select Model --</option>
                {availableModels.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </>
            )}
          </Select>
        </FormGroup>

        {formData.modelName && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Badge tone="blue">{formData.apiFormat}</Badge>
            <span>{formData.modelName}</span>
          </div>
        )}
      </div>

      <FormGroup>
        <Label>System Instruction</Label>
        <Textarea
          name="systemInstruction"
          placeholder="Describe how the assistant should behave..."
          value={formData.systemInstruction}
          onChange={handleChange}
          rows={3}
        />
      </FormGroup>

      <FormGroup>
        <Label>Avatar Style</Label>
        <div className="flex items-start gap-3">
          {/* 实时预览 */}
          <CustomImage imageName={formData.imageName} />
          <div className="flex-1">
            <Select
              name="imageName"
              value={formData.imageName}
              onChange={handleChange}
            >
              {builtinSkins.length > 0 && (
                <optgroup label="Built-in">
                  {builtinSkins.map(skin => (
                    <option key={skin.id} value={skin.name}>
                      {skin.name}{skin.name === 'Jules' ? ' (Default)' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {customSkins.length > 0 && (
                <optgroup label="Custom Skins">
                  {customSkins.map(skin => (
                    <option key={skin.id} value={`custom:${skin.id}`}>
                      {skin.name}{skin.author ? ` (by ${skin.author})` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
            {builtinSkins.length === 0 && customSkins.length === 0 && (
              <div className="text-xs text-slate-400 mt-1">
                No skins available.
              </div>
            )}
          </div>
        </div>
      </FormGroup>

      <Checkbox
        name="hasMood"
        label="Enable mood expressions"
        checked={formData.hasMood}
        onChange={handleChange}
      />

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <div className="flex-1" />
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button 
          type="submit" 
          variant="primary"
          disabled={saving || apiProviders.length === 0 || !formData.modelName}
        >
          {saving ? <FaSpinner className="w-4 h-4 animate-spin" /> : null}
          {assistant ? 'Save Changes' : 'Create'}
        </Button>
      </div>
    </form>
  );
};

const AssistantsPanel = ({ onNavigate }) => {
  const [assistants, setAssistants] = useState([]);
  const [isCreating, setIsCreating] = useState(false);
  const [editingAssistant, setEditingAssistant] = useState(null);

  const fetchData = async () => {
    const normalizeId = (item) => ({ ...item, _id: item._id || item.id });
    
    try {
      const assistantData = await tauri.getAssistants();
      if (Array.isArray(assistantData)) {
        setAssistants(assistantData.map(normalizeId));
      }
    } catch (error) {
      console.error("Failed to load assistants:", error);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const petsUpdateHandler = () => {
      fetchData();
    };

    const cleanup = tauri.onPetsUpdated(petsUpdateHandler);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  // 监听皮肤更新事件，刷新助手列表（因为助手预览图可能依赖皮肤）
  useEffect(() => {
    const skinsUpdateHandler = () => {
      console.log('[AssistantsPanel] Skins updated, refreshing...');
      fetchData();
    };

    const cleanup = tauri.onSkinsUpdated?.(skinsUpdateHandler);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const handleSelect = async (assistant) => {
    // 先隐藏 manage 窗口，显示 chat 窗口
    await tauri.hideManageWindow();
    await tauri.showChatWindow();
    // 等待 chat 窗口加载完成（给 React 组件时间挂载和设置事件监听器）
    await new Promise(resolve => setTimeout(resolve, 200));
    // 然后发送 character-id 事件
    await tauri.sendCharacterId(assistant._id);
  };

  const handleDeleteAssistant = async (assistantId) => {
    const confirmed = await tauri.confirm("Are you sure you want to delete this assistant?", { title: "Delete Assistant" });
    if (!confirmed) return;
    
    try {
      await tauri.deleteAssistant(assistantId);
      fetchData();
    } catch (error) {
      console.error("Delete failed:", error);
      const msg = error.message || (typeof error === 'string' ? error : JSON.stringify(error));
      alert("Failed to delete assistant: " + msg);
    }
  };

  const handleSave = async (formData) => {
    if (editingAssistant) {
      // Update existing
      const updatedAssistant = await tauri.updateAssistant(editingAssistant._id, formData);
      // 发送包含 id 的更新事件，确保聊天窗口能匹配到
      tauri.sendPetsUpdate({ 
        action: 'update', 
        type: 'assistant', 
        id: editingAssistant._id,
        _id: editingAssistant._id,
        data: updatedAssistant 
      });
      tauri.sendCharacterId(editingAssistant._id);
    } else {
      // Create new
      const newAssistant = await tauri.createAssistant(formData);
      if (!newAssistant || !newAssistant._id) {
        throw new Error("Creation failed or no ID returned");
      }
      tauri.sendCharacterId(newAssistant._id);
      tauri.sendPetsUpdate({ 
        action: 'create', 
        type: 'assistant', 
        id: newAssistant._id,
        _id: newAssistant._id,
        data: newAssistant 
      });
    }
    setIsCreating(false);
    setEditingAssistant(null);
    fetchData();
  };

  const handleEdit = (assistant) => {
    setEditingAssistant(assistant);
    setIsCreating(false);
  };

  const handleCancel = () => {
    setIsCreating(false);
    setEditingAssistant(null);
  };

  const showForm = isCreating || editingAssistant;

  return (
    <>
      {/* Title + New button */}
      {!showForm && (
        <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
          <div className="text-base font-semibold text-slate-800">
            Assistants ({assistants.length})
          </div>
          <Button variant="primary" onClick={() => setIsCreating(true)}>
            <FaPlus className="w-4 h-4" />
            New
          </Button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {showForm ? (
          <Card
            title={editingAssistant ? `Edit: ${editingAssistant.name}` : "New Assistant"}
            description="Configure your AI assistant"
          >
            <AssistantForm
              assistant={editingAssistant}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </Card>
        ) : assistants.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <FaRobot className="w-12 h-12 text-slate-300 mb-4" />
            <div className="text-slate-600 font-medium">No assistants yet</div>
            <div className="text-slate-400 text-sm mb-4">Create one to get started</div>
            <Button variant="primary" onClick={() => setIsCreating(true)}>
              <FaPlus className="w-4 h-4" />
              New Assistant
            </Button>
          </div>
        ) : (
          assistants.map((assistant) => (
            <div
              key={assistant._id}
              className="bg-white border border-slate-200 shadow-sm rounded-xl p-3 flex items-start gap-3"
            >
              <CustomImage imageName={assistant.imageName} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 truncate">
                      {assistant.name}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {assistant.modelName ? (
                        <Badge tone="purple">{assistant.modelName}</Badge>
                      ) : (
                        <Badge tone="red">No model</Badge>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    <Button variant="primary" onClick={() => handleSelect(assistant)}>
                      Select
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => handleEdit(assistant)}
                      title="Edit"
                    >
                      <FaPen className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => handleDeleteAssistant(assistant._id)}
                      title="Delete"
                    >
                      Delete
                    </Button>
                  </div>
                </div>

                {(assistant.systemInstruction || assistant.appearance) && (
                  <div className="mt-2 space-y-1">
                    <TruncatedText label="Instruction" text={assistant.systemInstruction} />
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
};

// ==================== API Providers Panel ====================

/**
 * 根据 URL 猜测服务商名称
 */
const guessProviderName = (baseUrl) => {
  if (!baseUrl) return "Unknown";
  const url = baseUrl.toLowerCase();
  if (url.includes("openai.com")) return "OpenAI";
  if (url.includes("deepseek.com")) return "DeepSeek";
  if (url.includes("anthropic.com")) return "Anthropic";
  if (url.includes("googleapis.com")) return "Google Gemini";
  if (url.includes("groq.com")) return "Groq";
  if (url.includes("openrouter.ai")) return "OpenRouter";
  if (url.includes("together.xyz")) return "Together AI";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "Local Service";
  try {
    const domain = new URL(baseUrl).hostname;
    return domain;
  } catch {
    return "Custom API";
  }
};

/**
 * 根据 API Key 格式检测可能的服务商
 */
const detectProviderFromKey = (apiKey) => {
  if (!apiKey) return null;
  // Anthropic 使用 OpenAI 兼容格式（通过其兼容端点）
  if (apiKey.startsWith("sk-ant-")) return { format: "openai_compatible", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" };
  if (apiKey.startsWith("AIza")) return { format: "gemini_official", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com" };
  if (apiKey.startsWith("gsk_")) return { format: "openai_compatible", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" };
  if (apiKey.startsWith("sk-or-")) return { format: "openai_compatible", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" };
  if (apiKey.startsWith("xai-")) return { format: "openai_compatible", name: "xAI", baseUrl: "https://api.x.ai/v1" };
  if (apiKey.startsWith("sk-")) return { format: "openai_compatible", name: "OpenAI / DeepSeek", baseUrl: "https://api.openai.com/v1" };
  return null;
};

/**
 * 脱敏显示 API Key
 */
const maskApiKey = (key) => {
  if (!key || key.length < 10) return "****";
  return key.substring(0, 7) + "..." + key.substring(key.length - 4);
};

/**
 * API Provider 编辑/创建表单
 */
const ApiProviderForm = ({ provider, onSave, onCancel }) => {
  const [formData, setFormData] = useState({
    name: provider?.name || "",
    baseUrl: provider?.baseUrl || "",
    apiKey: provider?.apiKey || "",
    apiFormat: provider?.apiFormat || "openai_compatible",
  });
  
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testSuccess, setTestSuccess] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState([]);
  const [detectedProvider, setDetectedProvider] = useState(null);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const [autoDetectProgress, setAutoDetectProgress] = useState("");
  
  // 当 API Key 改变时，尝试检测服务商并自动填充
  useEffect(() => {
    const detected = detectProviderFromKey(formData.apiKey);
    setDetectedProvider(detected);
    
    // 如果检测到了且是新建，自动填充所有字段
    if (detected && !provider) {
      setFormData(prev => ({
        ...prev,
        apiFormat: detected.format,
        baseUrl: detected.baseUrl || prev.baseUrl,
        name: prev.name || detected.name,
      }));
    }
  }, [formData.apiKey, provider]);
  
  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setTestResult(null);
    setTestSuccess(false);
  };
  
  // Fetch models list
  const handleFetchModels = async () => {
    if (!formData.baseUrl || !formData.apiKey) {
      setTestResult("Please provide Base URL and API Key first");
      return;
    }
    
    setIsFetchingModels(true);
    setTestResult(null);
    
    try {
      const models = await fetchModels(formData.baseUrl, formData.apiKey, formData.apiFormat);
      
      if (models && models.length > 0) {
        const modelIds = models.map(m => typeof m === 'object' ? m.id : m);
        setFetchedModels(modelIds);
        setTestResult(`Found ${models.length} models`);
        setTestSuccess(true);
      } else {
        setTestResult("No models found. The API might not support model listing.");
        setFetchedModels([]);
      }
    } catch (error) {
      console.error("Fetch models error:", error);
      setTestResult(`Failed: ${error.message || error}`);
      setFetchedModels([]);
    } finally {
      setIsFetchingModels(false);
    }
  };
  
  // Test connection
  const handleTestConnection = async () => {
    if (!formData.baseUrl || !formData.apiKey) {
      setTestResult("Please provide Base URL and API Key");
      return;
    }
    
    setTesting(true);
    setTestResult(null);
    setTestSuccess(false);
    
    try {
      // Try to fetch models as a test
      const models = await fetchModels(formData.baseUrl, formData.apiKey, formData.apiFormat);
      
      if (models && models.length > 0) {
        const modelIds = models.map(m => typeof m === 'object' ? m.id : m);
        setFetchedModels(modelIds);
        setTestResult(`✓ Connection successful! Found ${models.length} models`);
        setTestSuccess(true);
      } else {
        // Models not supported, try a simple completion
        const response = await callOpenAILib({
          apiKey: formData.apiKey,
          baseUrl: formData.baseUrl,
          apiFormat: formData.apiFormat,
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: "Hi" }],
          maxTokens: 5,
        });
        
        if (response) {
          setTestResult("✓ Connection successful!");
          setTestSuccess(true);
        }
      }
    } catch (error) {
      console.error("Test connection error:", error);
      setTestResult(`✗ Connection failed: ${error.message || error}`);
      setTestSuccess(false);
    } finally {
      setTesting(false);
    }
  };
  
  // Auto-detect endpoint by trying known provider URLs
  const handleAutoDetect = async () => {
    if (!formData.apiKey) {
      setTestResult("Please enter your API Key first");
      return;
    }
    
    setIsAutoDetecting(true);
    setTestResult(null);
    setTestSuccess(false);
    setAutoDetectProgress("");
    
    // Get candidates including local servers
    const candidates = getDetectionCandidates(true);
    
    // Also try Gemini format for Google keys
    const isGoogleKey = formData.apiKey.startsWith("AIza");
    
    if (isGoogleKey) {
      // For Google keys, directly use Gemini endpoint
      setAutoDetectProgress("Testing Google Gemini...");
      try {
        const models = await fetchModels(
          "https://generativelanguage.googleapis.com",
          formData.apiKey,
          "gemini_official"
        );
        if (models && models.length > 0) {
          setFormData(prev => ({
            ...prev,
            baseUrl: "https://generativelanguage.googleapis.com",
            apiFormat: "gemini_official",
            name: prev.name || "Google Gemini",
          }));
          const modelIds = models.map(m => typeof m === 'object' ? m.id : m);
          setFetchedModels(modelIds);
          setTestResult(`✓ Found Google Gemini with ${models.length} models`);
          setTestSuccess(true);
          setIsAutoDetecting(false);
          setAutoDetectProgress("");
          return;
        }
      } catch (e) {
        console.log("Gemini detection failed:", e.message);
      }
    }
    
    // Try OpenAI-compatible endpoints
    for (const candidate of candidates) {
      setAutoDetectProgress(`Testing ${candidate.label}...`);
      
      try {
        const models = await fetchModels(candidate.baseUrl, formData.apiKey, "openai_compatible");
        
        if (models && models.length > 0) {
          setFormData(prev => ({
            ...prev,
            baseUrl: candidate.baseUrl,
            apiFormat: "openai_compatible",
            name: prev.name || candidate.label,
          }));
          const modelIds = models.map(m => typeof m === 'object' ? m.id : m);
          setFetchedModels(modelIds);
          setTestResult(`✓ Found ${candidate.label} with ${models.length} models`);
          setTestSuccess(true);
          setIsAutoDetecting(false);
          setAutoDetectProgress("");
          return;
        }
      } catch (e) {
        // Continue to next candidate
        console.log(`${candidate.label} failed:`, e.message);
      }
    }
    
    // No endpoint found
    setTestResult("Could not auto-detect endpoint. Please select manually.");
    setTestSuccess(false);
    setIsAutoDetecting(false);
    setAutoDetectProgress("");
  };
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name || !formData.baseUrl || !formData.apiKey) {
      setTestResult("Please fill in all required fields");
      return;
    }
    
    // 保存时包含 cached_models
    // cachedModels needs to be a JSON string for the backend API
    const cachedModelsArray = fetchedModels.length > 0 ? fetchedModels : (provider?.cachedModels || []);
    
    // 如果是新建 Provider，默认将所有模型设为隐藏
    // 如果是编辑现有 Provider，保持现有的 hiddenModels
    const hiddenModelsArray = provider?.hiddenModels || cachedModelsArray;
    
    const dataToSave = {
      ...formData,
      cachedModels: JSON.stringify(cachedModelsArray),
      hiddenModels: JSON.stringify(hiddenModelsArray),
    };
    
    onSave(dataToSave);
  };
  
  const formatOptions = [
    { value: "openai_compatible", label: "OpenAI Compatible" },
    { value: "gemini_official", label: "Google Gemini" },
  ];
  
  // 预设选项
  const presets = getPresetsForFormat(formData.apiFormat);
  
  const handlePresetChange = (e) => {
    const presetUrl = e.target.value;
    if (presetUrl) {
      // Find the selected preset directly from the presets array
      const selectedPreset = presets.find(p => p.baseUrl === presetUrl);
      setFormData(prev => ({
        ...prev,
        baseUrl: presetUrl,
        name: prev.name || (selectedPreset ? selectedPreset.label : guessProviderName(presetUrl)),
      }));
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* API Key with auto-detect hint */}
      <FormGroup>
        <Label required>API Key</Label>
        <Input
          type="password"
          name="apiKey"
          value={formData.apiKey}
          onChange={handleChange}
          placeholder="sk-... or AIza..."
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleAutoDetect}
            disabled={isAutoDetecting || !formData.apiKey}
          >
            {isAutoDetecting ? <FaSpinner className="w-3 h-3 animate-spin" /> : <FaServer className="w-3 h-3" />}
            Auto-Detect Endpoint
          </Button>
          {autoDetectProgress && (
            <span className="text-xs text-slate-500">{autoDetectProgress}</span>
          )}
          {detectedProvider && !autoDetectProgress && (
            <span className="text-xs text-blue-600">Detected: {detectedProvider.name}</span>
          )}
        </div>
      </FormGroup>
      
      {/* API Format */}
      <FormGroup>
        <Label>API Format</Label>
        <Select
          name="apiFormat"
          value={formData.apiFormat}
          onChange={handleChange}
        >
          {formatOptions.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
      </FormGroup>
      
      {/* Base URL with presets */}
      <FormGroup>
        <Label required>Base URL</Label>
        {presets.length > 0 && (
          <Select
            onChange={handlePresetChange}
            value={formData.baseUrl}
            className="mb-2"
          >
            <option value="">-- Select preset or enter custom --</option>
            {presets.map(preset => (
              <option key={preset.baseUrl} value={preset.baseUrl}>
                {preset.label}
              </option>
            ))}
          </Select>
        )}
        <Input
          type="text"
          name="baseUrl"
          value={formData.baseUrl}
          onChange={handleChange}
          placeholder="https://api.openai.com/v1"
        />
      </FormGroup>
      
      {/* Provider Name */}
      <FormGroup>
        <Label required>Name</Label>
        <Input
          type="text"
          name="name"
          value={formData.name}
          onChange={handleChange}
          placeholder="My OpenAI API"
        />
        <div className="mt-1 text-xs text-slate-500">
          A friendly name to identify this API provider
        </div>
      </FormGroup>
      
      {/* Test result */}
      {testResult && (
        <Alert variant={testSuccess ? "success" : "error"}>
          {testResult}
        </Alert>
      )}
      
      {/* Fetched models preview */}
      {fetchedModels.length > 0 && (
        <div className="p-3 bg-slate-50 rounded-lg">
          <div className="text-sm font-medium text-slate-700 mb-2">
            Available Models ({fetchedModels.length})
          </div>
          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
            {fetchedModels.slice(0, 20).map(model => (
              <Badge key={model} tone="gray">{model}</Badge>
            ))}
            {fetchedModels.length > 20 && (
              <Badge tone="gray">+{fetchedModels.length - 20} more</Badge>
            )}
          </div>
        </div>
      )}
      
      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          type="button"
          variant="secondary"
          onClick={handleTestConnection}
          disabled={testing || !formData.baseUrl || !formData.apiKey}
        >
          {testing ? <FaSpinner className="w-4 h-4 animate-spin" /> : <FaCheck className="w-4 h-4" />}
          Test
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handleFetchModels}
          disabled={isFetchingModels || !formData.baseUrl || !formData.apiKey}
        >
          {isFetchingModels ? <FaSpinner className="w-4 h-4 animate-spin" /> : <FaList className="w-4 h-4" />}
          Fetch Models
        </Button>
        <div className="flex-1" />
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
};

/**
 * API Provider 列表项
 */
const ApiProviderItem = ({ provider, onEdit, onDelete }) => {
  const [expanded, setExpanded] = useState(false);
  const providerType = guessProviderName(provider.baseUrl);
  const modelCount = provider.cachedModels?.length || 0;
  
  return (
    <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-3 flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
          <FaServer className="w-5 h-5 text-blue-600" />
        </div>
        
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 truncate">{provider.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone="blue">{providerType}</Badge>
                <Badge tone="purple">{provider.apiFormat}</Badge>
                {modelCount > 0 && (
                  <Badge tone="green">{modelCount} models</Badge>
                )}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1.5">
              <Button
                variant="secondary"
                onClick={() => onEdit(provider)}
                title="Edit"
              >
                <FaPen className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="danger"
                onClick={() => onDelete(provider._id)}
                title="Delete"
              >
                <FaTrash className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? <FaChevronUp className="w-3.5 h-3.5" /> : <FaChevronDown className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
          
          {/* URL preview */}
          <div className="mt-2 text-sm text-slate-500 truncate">
            {provider.baseUrl}
          </div>
        </div>
      </div>
      
      {/* Expanded content */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <FaKey className="w-4 h-4 text-slate-400" />
            <span className="text-slate-500">API Key:</span>
            <code className="text-slate-700 bg-slate-100 px-2 py-0.5 rounded text-xs">
              {maskApiKey(provider.apiKey)}
            </code>
          </div>
          
          {modelCount > 0 && (
            <div className="pt-2">
              <div className="text-slate-500 mb-1">Cached Models:</div>
              <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                {provider.cachedModels.slice(0, 15).map(model => (
                  <Badge key={model} tone="gray">{model}</Badge>
                ))}
                {modelCount > 15 && (
                  <Badge tone="gray">+{modelCount - 15} more</Badge>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ApiProvidersPanel = () => {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [editingProvider, setEditingProvider] = useState(null);
  
  const loadProviders = useCallback(async () => {
    try {
      const data = await tauri.getApiProviders();
      const normalized = (data || []).map(p => ({ 
        ...p, 
        _id: p._id || p.id,
        // Parse cachedModels JSON string to array
        cachedModels: typeof p.cachedModels === 'string' ? JSON.parse(p.cachedModels) : (p.cachedModels || [])
      }));
      setProviders(normalized);
    } catch (error) {
      console.error("Failed to load API providers:", error);
    } finally {
      setLoading(false);
    }
  }, []);
  
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);
  
  const handleSave = async (formData) => {
    try {
      if (editingProvider) {
        await tauri.updateApiProvider(editingProvider._id, formData);
      } else {
        await tauri.createApiProvider(formData);
      }
      setIsCreating(false);
      setEditingProvider(null);
      loadProviders();
    } catch (error) {
      console.error("Save failed:", error);
      alert("Failed to save: " + (error.message || error));
    }
  };
  
  const handleEdit = (provider) => {
    setEditingProvider(provider);
    setIsCreating(false);
  };
  
  const handleDelete = async (id) => {
    const confirmed = await tauri.confirm("Are you sure you want to delete this API provider?", { title: "Delete API Provider" });
    if (!confirmed) return;
    
    try {
      await tauri.deleteApiProvider(id);
      loadProviders();
    } catch (error) {
      console.error("Delete failed:", error);
      alert("Failed to delete: " + (error.message || error));
    }
  };
  
  const handleCancel = () => {
    setIsCreating(false);
    setEditingProvider(null);
  };
  
  const showForm = isCreating || editingProvider;

  return (
    <>
      {/* Title + New button */}
      {!showForm && (
        <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
          <div className="text-base font-semibold text-slate-800">
            API Providers ({providers.length})
          </div>
          <Button variant="primary" onClick={() => setIsCreating(true)}>
            <FaPlus className="w-4 h-4" />
            New
          </Button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {showForm ? (
          <Card
            title={editingProvider ? `Edit: ${editingProvider.name}` : "Add New API Service"}
            description="Configure API Key and endpoint to use when creating assistants"
          >
            <ApiProviderForm
              provider={editingProvider}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </Card>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <FaSpinner className="w-8 h-8 animate-spin text-slate-300 mb-4" />
            <div className="text-slate-400 text-sm">Loading...</div>
          </div>
        ) : providers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <FaServer className="w-12 h-12 text-slate-300 mb-4" />
            <div className="text-slate-600 font-medium">No API providers yet</div>
            <div className="text-slate-400 text-sm mb-4">Add one to start creating assistants</div>
            <Button variant="primary" onClick={() => setIsCreating(true)}>
              <FaPlus className="w-4 h-4" />
              Add API Provider
            </Button>
          </div>
        ) : (
          providers.map(provider => (
            <ApiProviderItem
              key={provider._id}
              provider={provider}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </>
  );
};

// ==================== MCP Servers Panel ====================

/**
 * MCP Server 编辑/创建表单
 */
const McpServerForm = ({ server, onSave, onCancel }) => {
  const [name, setName] = useState(server?.name || '');
  const [transport, setTransport] = useState(server?.transport || 'stdio');
  const [command, setCommand] = useState(server?.command || '');
  const [args, setArgs] = useState(server?.args?.join(', ') || '');
  const [envVars, setEnvVars] = useState(
    server?.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
  );
  const [url, setUrl] = useState(server?.url || '');
  const [apiKey, setApiKey] = useState(server?.apiKey || '');
  const [autoStart, setAutoStart] = useState(server?.autoStart || false);
  const [icon, setIcon] = useState(server?.icon || '🔧');
  const [showInToolbar, setShowInToolbar] = useState(server?.showInToolbar !== false);
  // Max iterations: null/undefined means unlimited, number means limited
  const [maxIterations, setMaxIterations] = useState(server?.maxIterations ?? null);
  const [isUnlimited, setIsUnlimited] = useState(server?.maxIterations == null);
  
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);

  // 构建配置对象
  const buildConfig = () => {
    const config = {
      name: name.trim(),
      transport,
      autoStart,
      icon,
      showInToolbar,
      maxIterations: isUnlimited ? null : (maxIterations || 10)
    };
    
    if (server?._id) {
      config._id = server._id;
    }
    
    if (transport === 'stdio') {
      const env = {};
      if (envVars.trim()) {
        envVars.split('\n').forEach(line => {
          const [key, ...valueParts] = line.split('=');
          if (key && valueParts.length > 0) {
            env[key.trim()] = valueParts.join('=').trim();
          }
        });
      }
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/,|\s+/).filter(Boolean) : [];
      config.env = env;
    } else {
      config.url = url.trim();
      if (apiKey.trim()) {
        config.apiKey = apiKey.trim();
      }
    }
    
    return config;
  };

  const isValid = () => {
    if (!name.trim()) return false;
    if (transport === 'stdio') {
      return !!command.trim();
    } else {
      return !!url.trim();
    }
  };

  const handleTest = async () => {
    setError('');
    setTestResult(null);
    
    if (!isValid()) {
      setError(transport === 'stdio' 
        ? 'Name and command are required' 
        : 'Name and URL are required');
      return;
    }
    
    setTesting(true);
    
    try {
      const config = buildConfig();
      const result = await tauri.mcp.testServer(config);
      
      if (result) {
        const formattedResult = {
          success: result.isRunning !== undefined ? result.isRunning : result.success,
          toolCount: result.tools?.length || result.toolCount || 0,
          resourceCount: result.resources?.length || result.resourceCount || 0,
          tools: result.tools || [],
          message: result.error || result.message,
        };
        setTestResult(formattedResult);
        if (!formattedResult.success) {
          setError(formattedResult.message || 'Test failed');
        }
      } else {
        setError('No response from server');
        setTestResult({ success: false, message: 'No response from server' });
      }
    } catch (err) {
      const errorMessage = err.message || err.toString() || 'Test failed';
      setError(errorMessage);
      setTestResult({ success: false, message: errorMessage });
    } finally {
      setTesting(false);
    }
  };

  // 检查配置是否变化（用于编辑模式）
  const checkConfigChanged = () => {
    if (!server) return true;
    
    if (transport !== (server.transport || 'stdio')) return true;
    if (name !== server.name) return true;
    if (autoStart !== (server.autoStart || false)) return true;
    
    if (transport === 'stdio') {
      if (command !== (server.command || '')) return true;
      if (args !== (server.args?.join(', ') || '')) return true;
      const originalEnvStr = server.env 
        ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') 
        : '';
      if (envVars !== originalEnvStr) return true;
    } else {
      if (url !== (server.url || '')) return true;
      if (apiKey !== (server.apiKey || '')) return true;
    }
    
    return false;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!isValid()) {
      setError(transport === 'stdio' 
        ? 'Name and command are required' 
        : 'Name and URL are required');
      return;
    }
    
    // 新建模式必须测试成功
    if (!server && !testResult?.success) {
      setError('Please test the server connection first');
      return;
    }
    
    // 编辑模式：配置变了需要重新测试
    if (server && checkConfigChanged() && !testResult?.success) {
      setError('Configuration changed. Please test the connection first.');
      return;
    }
    
    setSaving(true);
    try {
      const config = buildConfig();
      await onSave(config);
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <FormGroup>
        <Label required>Server Name</Label>
        <Input
          value={name}
          onChange={(e) => { setName(e.target.value); setTestResult(null); }}
          placeholder="e.g., tavily, filesystem"
          required
        />
      </FormGroup>
      
      <FormGroup>
        <Label>Transport Type</Label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="transport"
              value="stdio"
              checked={transport === 'stdio'}
              onChange={(e) => { setTransport(e.target.value); setTestResult(null); }}
              className="w-4 h-4 text-blue-600"
            />
            <span className="text-sm">
              <span className="font-medium">Stdio</span>
              <span className="text-gray-500 ml-1">(Local)</span>
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="transport"
              value="http"
              checked={transport === 'http'}
              onChange={(e) => { setTransport(e.target.value); setTestResult(null); }}
              className="w-4 h-4 text-blue-600"
            />
            <span className="text-sm">
              <span className="font-medium">HTTP/SSE</span>
              <span className="text-gray-500 ml-1">(Remote)</span>
            </span>
          </label>
        </div>
      </FormGroup>
      
      {transport === 'stdio' ? (
        <>
          <FormGroup>
            <Label required>Command</Label>
            <Input
              value={command}
              onChange={(e) => { setCommand(e.target.value); setTestResult(null); }}
              placeholder="e.g., npx"
              required
            />
          </FormGroup>
          
          <FormGroup>
            <Label>Arguments</Label>
            <Input
              value={args}
              onChange={(e) => { setArgs(e.target.value); setTestResult(null); }}
              placeholder="e.g., -y, @modelcontextprotocol/server-filesystem"
            />
          </FormGroup>
          
          <FormGroup>
            <Label>Environment Variables</Label>
            <Textarea
              value={envVars}
              onChange={(e) => { setEnvVars(e.target.value); setTestResult(null); }}
              placeholder="KEY=value (one per line)"
              rows={2}
              className="font-mono text-sm"
            />
          </FormGroup>
        </>
      ) : (
        <>
          <FormGroup>
            <Label required>Server URL</Label>
            <Input
              value={url}
              onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
              placeholder="e.g., https://api.example.com/mcp"
              required
            />
          </FormGroup>
          
          <FormGroup>
            <Label>API Key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setTestResult(null); }}
              placeholder="Optional authentication key"
            />
          </FormGroup>
        </>
      )}
      
      <FormGroup>
        <Label>Icon</Label>
        <div className="flex items-center gap-3">
          <IconSelectorTrigger value={icon} onChange={setIcon} />
          <span className="text-sm text-gray-500">Click to select</span>
        </div>
      </FormGroup>
      
      <div className="flex flex-col gap-2">
        <Checkbox
          checked={autoStart}
          onChange={(e) => setAutoStart(e.target.checked)}
          label="Auto-start when PetGPT opens"
        />
        <Checkbox
          checked={showInToolbar}
          onChange={(e) => setShowInToolbar(e.target.checked)}
          label="Show in toolbar"
        />
      </div>
      
      {/* Max Iterations Setting */}
      <FormGroup>
        <Label>Max Tool Call Iterations</Label>
        <div className="flex items-center gap-3">
          <Checkbox
            checked={isUnlimited}
            onChange={(e) => {
              setIsUnlimited(e.target.checked);
              if (e.target.checked) {
                setMaxIterations(null);
              } else {
                setMaxIterations(10);
              }
            }}
            label="Unlimited"
          />
          {!isUnlimited && (
            <Input
              type="number"
              min={1}
              max={100}
              value={maxIterations || 10}
              onChange={(e) => setMaxIterations(parseInt(e.target.value, 10) || 10)}
              className="w-24"
            />
          )}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Limit the number of tool calls per conversation turn for this server
        </p>
      </FormGroup>
      
      {/* Test Result */}
      {(testResult || error) && (
        <div className="mt-2">
          {error && !testResult && (
            <Alert variant="error">{error}</Alert>
          )}
          {testResult && (
            <div className={`p-3 rounded-lg border text-sm ${
              testResult.success 
                ? 'bg-green-50 border-green-200 text-green-800' 
                : 'bg-red-50 border-red-200 text-red-800'
            }`}>
              <div className="font-medium">
                {testResult.success ? '✓ Connection Successful' : '✗ Connection Failed'}
              </div>
              {testResult.success && (
                <div className="mt-1">
                  Found {testResult.toolCount || 0} tool(s)
                  {testResult.tools?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {testResult.tools.slice(0, 3).map((tool, i) => (
                        <Badge key={i} tone="green">{tool.name}</Badge>
                      ))}
                      {testResult.tools.length > 3 && (
                        <Badge tone="gray">+{testResult.tools.length - 3}</Badge>
                      )}
                    </div>
                  )}
                </div>
              )}
              {!testResult.success && testResult.message && (
                <div className="mt-1 opacity-90">{testResult.message}</div>
              )}
            </div>
          )}
        </div>
      )}
      
      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          type="button"
          variant="secondary"
          onClick={handleTest}
          disabled={testing || !isValid()}
        >
          {testing ? <FiRefreshCw className="w-4 h-4 animate-spin" /> : <FaCheck className="w-4 h-4" />}
          Test
        </Button>
        <div className="flex-1" />
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button 
          type="submit" 
          variant="primary"
          disabled={saving || (!server && !testResult?.success)}
        >
          {saving ? <FaSpinner className="w-4 h-4 animate-spin" /> : null}
          {server ? 'Save' : 'Add Server'}
        </Button>
      </div>
    </form>
  );
};

const McpServerCard = ({ server, onDelete, onEdit }) => {
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState([]);
  const isRunning = server.isRunning || server.status === 'running';
  
  const loadTools = useCallback(async () => {
    if (!isRunning) {
      setTools([]);
      return;
    }
    
    try {
      const allTools = await tauri.mcp.getAllTools();
      const serverTools = (allTools || []).filter(t => t.serverId === server._id);
      setTools(serverTools);
    } catch (error) {
      console.error('Failed to load tools:', error);
      setTools([]);
    }
  }, [server._id, isRunning]);
  
  useEffect(() => {
    loadTools();
  }, [loadTools]);
  
  return (
    <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-3 flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={`mt-1.5 w-3 h-3 rounded-full shrink-0 ${isRunning ? 'bg-green-500' : 'bg-gray-300'}`} />
        
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 truncate">{server.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone={isRunning ? "green" : "gray"}>
                  {isRunning ? 'Running' : 'Stopped'}
                </Badge>
                {server.autoStart && <Badge tone="blue">Auto-start</Badge>}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1.5">
              <Button
                variant="secondary"
                onClick={() => onEdit(server)}
                title="Edit"
              >
                <FaPen className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="danger"
                onClick={() => onDelete(server._id)}
                title="Delete"
              >
                <FaTrash className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? <FaChevronUp className="w-3.5 h-3.5" /> : <FaChevronDown className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
          
          <div className="mt-2 text-sm text-slate-500 truncate">
            {server.command} {server.args?.join(' ')}
          </div>
        </div>
      </div>
      
      {/* Expanded content */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="space-y-2 text-sm">
            <div className="flex">
              <span className="w-24 text-slate-500">Command:</span>
              <code className="text-slate-700 bg-slate-100 px-2 py-0.5 rounded text-xs">
                {server.command} {server.args?.join(' ')}
              </code>
            </div>
            
            {server.env && Object.keys(server.env).length > 0 && (
              <div className="flex">
                <span className="w-24 text-slate-500">Env vars:</span>
                <span className="text-slate-700">{Object.keys(server.env).length} configured</span>
              </div>
            )}
          </div>
          
          {isRunning && tools.length > 0 && (
            <div className="mt-3">
              <h4 className="text-sm font-medium text-slate-700 mb-2">
                Available Tools ({tools.length})
              </h4>
              <div className="grid gap-2">
                {tools.map((tool, index) => (
                  <div key={index} className="bg-slate-50 rounded p-2 border border-slate-200">
                    <div className="font-medium text-slate-800 text-sm">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-slate-500 mt-1">{tool.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {isRunning && tools.length === 0 && (
            <div className="mt-3 text-sm text-slate-500">
              No tools available from this server.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ==================== Models Panel ====================

const ModelsPanel = () => {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedProviders, setExpandedProviders] = useState(new Set());
  const [{}, dispatch] = useStateValue();

  const loadProviders = useCallback(async () => {
    try {
      const data = await tauri.getApiProviders();
      const normalized = (data || []).map(p => ({ 
        ...p, 
        _id: p._id || p.id,
        // Parse cachedModels and hiddenModels JSON strings
        cachedModels: typeof p.cachedModels === 'string' ? JSON.parse(p.cachedModels) : (p.cachedModels || []),
        hiddenModels: typeof p.hiddenModels === 'string' ? JSON.parse(p.hiddenModels) : (p.hiddenModels || [])
      }));
      setProviders(normalized);
    } catch (error) {
      console.error("Failed to load providers:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const toggleModelVisibility = async (provider, modelName) => {
    try {
      const hiddenModels = provider.hiddenModels || [];
      const newHiddenModels = hiddenModels.includes(modelName)
        ? hiddenModels.filter(m => m !== modelName)
        : [...hiddenModels, modelName];

      await tauri.updateApiProvider(provider._id, {
        hiddenModels: JSON.stringify(newHiddenModels)
      });

      // 重新拉取完整的 providers 数据
      const updatedProviders = await tauri.getApiProviders();
      if (updatedProviders) {
        const normalizedProviders = updatedProviders.map(p => ({
          ...p,
          cachedModels: typeof p.cachedModels === 'string' 
            ? JSON.parse(p.cachedModels) 
            : (p.cachedModels || []),
          hiddenModels: typeof p.hiddenModels === 'string'
            ? JSON.parse(p.hiddenModels)
            : (p.hiddenModels || [])
        }));
        
        // 更新本地状态
        setProviders(normalizedProviders);
        
        // 更新全局状态
        dispatch({
          type: actionType.SET_API_PROVIDERS,
          apiProviders: normalizedProviders
        });
        
        // 发送跨窗口事件通知其他窗口更新
        await tauri.sendApiProvidersUpdate(normalizedProviders);
      }
    } catch (error) {
      console.error("Failed to toggle model visibility:", error);
      alert("Failed to update model visibility");
    }
  };

  const toggleProvider = (providerId) => {
    setExpandedProviders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(providerId)) {
        newSet.delete(providerId);
      } else {
        newSet.add(providerId);
      }
      return newSet;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <FaSpinner className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  // Flatten all models from all providers
  const allModels = providers.flatMap(provider => {
    const models = provider.cachedModels || [];
    return models.map(modelName => ({
      modelName,
      provider: provider.name,
      providerId: provider._id,
      isHidden: (provider.hiddenModels || []).includes(modelName)
    }));
  });

  if (allModels.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-gray-500">
          <FaList className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No models available</p>
          <p className="text-sm">Add API providers and fetch models first</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-800">Model Visibility</h2>
          <p className="text-sm text-gray-500 mt-1">
            Control which models appear in the dropdown selector. All models are disabled by default. Toggle on to enable them in the chat interface.
          </p>
        </div>

        {/* Table Header */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
          <div className="grid grid-cols-12 gap-4 px-4 py-3 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase tracking-wide">
            <div className="col-span-6">Model Name</div>
            <div className="col-span-3">Provider</div>
            <div className="col-span-3 text-center">Enabled</div>
          </div>

          {/* Table Body - Grouped by Provider */}
          {providers.map(provider => {
            const models = provider.cachedModels || [];
            const hiddenModels = provider.hiddenModels || [];
            const isExpanded = expandedProviders.has(provider._id);

            if (models.length === 0) return null;

            return (
              <div key={provider._id} className="border-b border-gray-100 last:border-b-0">
                {/* Provider Header */}
                <div 
                  className="flex items-center gap-2 px-4 py-3 bg-gray-50/50 cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => toggleProvider(provider._id)}
                >
                  {isExpanded ? (
                    <FaChevronDown className="w-3 h-3 text-gray-400" />
                  ) : (
                    <FaChevronUp className="w-3 h-3 text-gray-400" />
                  )}
                  <span className="font-semibold text-sm text-gray-700">
                    {provider.name}
                  </span>
                  <Badge variant="secondary" className="text-xs">
                    {models.length} models
                  </Badge>
                  <Badge variant={models.length - hiddenModels.length > 0 ? "success" : "secondary"} className="text-xs ml-auto">
                    {models.length - hiddenModels.length} enabled
                  </Badge>
                </div>

                {/* Model Rows */}
                {isExpanded && (
                  <div>
                    {models.map((modelName, index) => {
                      const isHidden = hiddenModels.includes(modelName);
                      return (
                        <div 
                          key={`${provider._id}-${modelName}`}
                          className={`grid grid-cols-12 gap-4 px-4 py-3 hover:bg-gray-50 transition-colors ${
                            index !== models.length - 1 ? 'border-b border-gray-100' : ''
                          }`}
                        >
                          <div className="col-span-6 text-sm text-gray-800 font-mono truncate">
                            {modelName}
                          </div>
                          <div className="col-span-3 text-sm text-gray-500">
                            {provider.name}
                          </div>
                          <div className="col-span-3 flex justify-center">
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={!isHidden}
                                onChange={() => toggleModelVisibility(provider, modelName)}
                                className="sr-only peer"
                              />
                              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-2 peer-focus:ring-green-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-500"></div>
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const McpServersPanel = () => {
  const [servers, setServers] = useState([]);
  const [serverStatuses, setServerStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [editingServer, setEditingServer] = useState(null);
  
  const loadServers = useCallback(async () => {
    try {
      const serverList = await tauri.mcp.getServers();
      setServers(serverList || []);
      
      const statuses = {};
      for (const server of serverList || []) {
        try {
          const status = await tauri.mcp.getServerStatus(server._id);
          statuses[server._id] = status;
        } catch {
          statuses[server._id] = 'unknown';
        }
      }
      setServerStatuses(statuses);
    } catch (err) {
      console.error('Failed to load MCP servers:', err);
    } finally {
      setLoading(false);
    }
  }, []);
  
  useEffect(() => {
    loadServers();
  }, [loadServers]);
  
  useEffect(() => {
    if (!tauri.mcp.onServersUpdated) return;
    
    const cleanup = tauri.mcp.onServersUpdated(() => {
      loadServers();
    });
    
    return cleanup;
  }, [loadServers]);
  
  const handleDeleteServer = async (id) => {
    const serverToDelete = servers.find(s => s._id === id);
    const serverName = serverToDelete?.name || 'Unknown';
    
    const confirmDelete = await tauri.confirm(`Are you sure you want to delete "${serverName}"?`, {
      title: 'Delete MCP Server'
    });
    if (!confirmDelete) return;
    
    try {
      await tauri.mcp.deleteServer(id);
      await tauri.mcp.emitServersUpdated({ action: 'deleted', serverName });
      await loadServers();
    } catch (err) {
      console.error('Failed to delete server:', err);
      alert('Failed to delete server: ' + (err.message || err));
    }
  };
  
  const handleSave = async (config) => {
    if (editingServer) {
      await tauri.mcp.updateServer(config._id, config);
      await tauri.mcp.emitServersUpdated({ action: 'updated', serverName: config.name });
    } else {
      await tauri.mcp.createServer(config);
      await tauri.mcp.emitServersUpdated({ action: 'created', serverName: config.name });
    }
    setIsCreating(false);
    setEditingServer(null);
    loadServers();
  };

  const handleEdit = (server) => {
    setEditingServer(server);
    setIsCreating(false);
  };

  const handleCancel = () => {
    setIsCreating(false);
    setEditingServer(null);
  };

  const showForm = isCreating || editingServer;

  return (
    <>
      {/* Title + New button */}
      {!showForm && (
        <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
          <div className="text-base font-semibold text-slate-800">
            MCP Servers ({servers.length})
          </div>
          <Button variant="primary" onClick={() => setIsCreating(true)}>
            <FaPlus className="w-4 h-4" />
            New
          </Button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {showForm ? (
          <Card
            title={editingServer ? `Edit: ${editingServer.name}` : "New MCP Server"}
            description="Configure an MCP server for tool integration"
          >
            <McpServerForm
              server={editingServer}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </Card>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <FiRefreshCw className="w-8 h-8 animate-spin text-slate-300 mb-4" />
            <div className="text-slate-400 text-sm">Loading...</div>
          </div>
        ) : servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <FaPlug className="w-12 h-12 text-slate-300 mb-4" />
            <div className="text-slate-600 font-medium">No MCP servers yet</div>
            <div className="text-slate-400 text-sm mb-4">Add one to enable tool integration</div>
            <Button variant="primary" onClick={() => setIsCreating(true)}>
              <FaPlus className="w-4 h-4" />
              Add Server
            </Button>
          </div>
        ) : (
          servers.map(server => (
            <McpServerCard
              key={server._id}
              server={{
                ...server,
                status: serverStatuses[server._id] || (server.isRunning ? 'running' : 'stopped')
              }}
              onDelete={handleDeleteServer}
              onEdit={handleEdit}
            />
          ))
        )}
      </div>
    </>
  );
};

// ==================== Skins Panel ====================

/**
 * Skins Form - 选择 JSON 文件导入
 * JSON 格式示例：
 * {
 *   "name": "My Skin",
 *   "author": "Me",
 *   "description": "Optional",
 *   "moods": {
 *     "happy": "smile.png",
 *     "sad": "cry.gif",
 *     "angry": "angry.jpg"
 *   }
 * }
 * 图片文件与 JSON 同目录，名称在 moods 对象中指定
 */
const SkinForm = ({ onSave, onCancel }) => {
  const [jsonPath, setJsonPath] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFileSelect = async () => {
    try {
      // 使用 Tauri 的文件对话框选择 JSON 文件
      const selected = await tauri.selectFile({
        filters: [{
          name: 'Skin Config',
          extensions: ['json']
        }],
        multiple: false,
        directory: false,
      });

      if (!selected) return;

      setJsonPath(selected);
      setError(null);

      // 读取并验证 JSON 内容
      try {
        const content = await tauri.readFile(selected);
        const parsed = JSON.parse(content);
        
        // 验证必需字段 - moods 现在是对象 { moodName: imageName }
        if (!parsed.name || !parsed.moods || typeof parsed.moods !== 'object' || Object.keys(parsed.moods).length === 0) {
          setError("Invalid JSON: must have 'name' and 'moods' object (e.g. { \"happy\": \"smile.png\" })");
          setJsonPath(null);
          return;
        }

        setConfig(parsed);
      } catch (e) {
        setError("Failed to read or parse JSON: " + e.message);
        setJsonPath(null);
      }
    } catch (err) {
      setError("Failed to open file dialog: " + err.message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!jsonPath) {
      setError("Please select a JSON file");
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      await onSave(jsonPath);
    } catch (err) {
      setError("Import failed: " + (err.message || err));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <Alert type="error">{error}</Alert>}

      {/* File Selection */}
      <div className="space-y-3">
        <Label>Skin Configuration</Label>
        <div className="flex gap-2">
          <div className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 truncate">
            {jsonPath ? jsonPath : "No file selected"}
          </div>
          <Button variant="secondary" onClick={handleFileSelect} type="button">
            <FaFile className="w-4 h-4 mr-2" />
            Select JSON
          </Button>
        </div>
        <div className="text-xs text-slate-500">
          Select a JSON file containing skin configuration. Images (0.png, 1.png, etc.) should be in the same directory.
        </div>
      </div>

      {/* Config Preview */}
      {config && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Preview</div>
          <div className="space-y-1 text-sm">
            <div><span className="font-medium text-slate-700">Name:</span> {config.name}</div>
            {config.author && <div><span className="font-medium text-slate-700">Author:</span> {config.author}</div>}
            {config.description && <div><span className="font-medium text-slate-700">Description:</span> {config.description}</div>}
            <div>
              <span className="font-medium text-slate-700">Moods ({Object.keys(config.moods).length}):</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {/* 按标准顺序排序显示 moods */}
                {(() => {
                  const MOOD_ORDER = ['normal', 'smile', 'sad', 'shocked', 'thinking', 'idle-1', 'idle-2', 'idle-3'];
                  const sortedEntries = Object.entries(config.moods).sort((a, b) => {
                    const indexA = MOOD_ORDER.indexOf(a[0]);
                    const indexB = MOOD_ORDER.indexOf(b[0]);
                    // 未知的 mood 放到末尾
                    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
                  });
                  return sortedEntries.map(([moodName, imageName], i) => (
                    <Badge key={i} tone="blue">{i}: {moodName} → {imageName}</Badge>
                  ));
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button variant="secondary" onClick={onCancel} type="button">Cancel</Button>
        <Button variant="primary" type="submit" disabled={isProcessing || !jsonPath}>
          {isProcessing ? <FaSpinner className="animate-spin mr-2" /> : <FaCheck className="mr-2" />}
          Import Skin
        </Button>
      </div>
    </form>
  );
};

/**
 * 皮肤预览图组件 - 先尝试从 assets 加载，失败后从自定义目录加载
 */
const SkinPreview = ({ skinId, skinName, isBuiltin }) => {
  const [imageUrl, setImageUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const loadImage = async () => {
      try {
        const assetName = skinName === 'default' ? 'Jules' : skinName;
        // 先尝试从 assets 加载
        try {
          const module = await import(`../assets/${assetName}-normal.png`);
          setImageUrl(module.default);
          setLoading(false);
          return;
        } catch {
          // assets 中没有，从自定义目录加载
        }
        // 从自定义目录加载
        const url = await tauri.readSkinImage(skinId, 'normal');
        setImageUrl(url);
      } catch (err) {
        console.error('Failed to load skin preview:', err);
      } finally {
        setLoading(false);
      }
    };
    loadImage();
  }, [skinId, skinName, isBuiltin]);
  
  if (loading) {
    return (
      <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
        <FaSpinner className="w-4 h-4 text-slate-400 animate-spin" />
      </div>
    );
  }
  
  if (imageUrl) {
    return (
      <img 
        src={imageUrl} 
        alt={skinName} 
        className="w-12 h-12 rounded-lg object-cover shrink-0 bg-slate-100"
      />
    );
  }
  
  return (
    <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
      <FaShirt className="w-6 h-6 text-slate-400" />
    </div>
  );
};

/**
 * 皮肤状态预览组件 - 动态显示心情状态
 * @param {string} skinId - 皮肤 ID
 * @param {string} skinName - 皮肤名称
 * @param {boolean} isBuiltin - 是否内置皮肤
 * @param {string[]} moods - 动态表情列表 e.g. ["normal", "smile", "sad", "shocked", "thinking"]
 */
const SkinMoodPreview = ({ skinId, skinName, isBuiltin, moods: propMoods }) => {
  // 固定表情系统: 情绪表情 + 系统状态
  const DEFAULT_MOODS = ['normal', 'smile', 'sad', 'shocked', 'thinking', 'idle-1', 'idle-2', 'idle-3'];
  
  // 内置皮肤总是使用完整的表情列表（因为数据库中的旧记录可能不完整）
  // 自定义皮肤使用传入的 moods，如果没有则使用默认值
  const moods = isBuiltin ? DEFAULT_MOODS : (propMoods && propMoods.length > 0 ? propMoods : DEFAULT_MOODS);
  
  // 生成显示标签：处理 idle-1 等特殊格式
  const getMoodLabel = (mood) => {
    if (mood.startsWith('idle-')) {
      const num = mood.split('-')[1];
      return `Idle ${num}`;
    }
    return mood.charAt(0).toUpperCase() + mood.slice(1);
  };
  const [images, setImages] = useState({});
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const loadImages = async () => {
      const loaded = {};
      setLoading(true);
      
      for (const mood of moods) {
        try {
          if (isBuiltin) {
            // 内置皮肤：从 assets 加载
            const assetName = skinName === 'default' ? 'Jules' : skinName;
            try {
              const module = await import(`../assets/${assetName}-${mood}.png`);
              loaded[mood] = module.default;
              continue;
            } catch {
              console.warn(`[SkinMoodPreview] Asset not found: ${assetName}-${mood}.png`);
            }
          }
          
          // 自定义皮肤或内置皮肤加载失败：从文件系统加载
          const url = await tauri.readSkinImage(skinId, mood);
          loaded[mood] = url;
        } catch (err) {
          console.error(`[SkinMoodPreview] Failed to load ${mood} image for skin ${skinId}:`, err);
        }
      }
      
      setImages(loaded);
      setLoading(false);
    };
    loadImages();
  }, [skinId, skinName, isBuiltin, moods]);
  
  return (
    <div className="grid grid-cols-4 gap-3 p-3 bg-slate-50 rounded-lg">
      {moods.map(mood => (
        <div key={mood} className="flex flex-col items-center gap-1">
          <div className="w-16 h-16 rounded-lg overflow-hidden bg-white border border-slate-200 shadow-sm">
            {images[mood] ? (
              <img src={images[mood]} alt={mood} className="w-full h-full object-cover" />
            ) : loading ? (
              <div className="w-full h-full flex items-center justify-center">
                <FaSpinner className="w-4 h-4 text-slate-300 animate-spin" />
              </div>
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <FaShirt className="w-6 h-6 text-slate-200" />
              </div>
            )}
          </div>
          <span className="text-xs text-slate-500">{getMoodLabel(mood)}</span>
        </div>
      ))}
    </div>
  );
};

/**
 * Skins Panel - 模仿 AssistantsPanel 布局
 */
const SkinsPanel = () => {
  const [skins, setSkins] = useState([]);
  const [isCreating, setIsCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedSkinId, setSelectedSkinId] = useState(null);
  
  // 从后端加载皮肤数据
  const fetchSkins = async () => {
    try {
      // 根据 showHidden 状态选择 API
      const data = showHidden 
        ? await tauri.getSkinsWithHidden()
        : await tauri.getSkins();
      const skinsList = Array.isArray(data) ? data : [];
      setSkins(skinsList);
    } catch (err) {
      console.error("Failed to load skins:", err);
    } finally {
      setLoading(false);
    }
  };

  // 初始化加载
  useEffect(() => {
    fetchSkins();
  }, [showHidden]);
  
  // 监听 skins-updated 事件，实现数据同步
  useEffect(() => {
    const cleanup = tauri.onSkinsUpdated?.(() => {
      console.log('[SkinsPanel] Received skins-updated event, refreshing...');
      fetchSkins();
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, [showHidden]);
  
  const handleSave = async (jsonPath) => {
    try {
      console.log("Importing skin from:", jsonPath);
      
      // 调用 Rust API 导入皮肤（JSON + 自动发现图片）
      await tauri.importSkin(jsonPath);
      
      // 发送更新事件，通知其他窗口刷新
      await tauri.sendSkinsUpdate?.({ action: 'create' });
      
      setIsCreating(false);
      fetchSkins();
    } catch (err) {
      console.error("Failed to import skin:", err);
      alert("Failed to import skin: " + (err.message || err));
    }
  };
  
  const handleDelete = async (skin) => {
    // 对于内置皮肤，提示是隐藏而不是删除
    const message = skin.isBuiltin 
      ? "This is a built-in skin. It will be hidden but can be restored later. Continue?"
      : "Are you sure you want to delete this skin? This cannot be undone.";
    
    const confirmed = await tauri.confirm?.(message, { title: skin.isBuiltin ? "Hide Skin" : "Delete Skin" }) ?? window.confirm(message);
    if (!confirmed) return;
    
    try {
      if (skin.isBuiltin) {
        // 内置皮肤只是隐藏
        await tauri.hideSkin(skin.id);
      } else {
        // 用户皮肤真正删除
        await tauri.deleteSkin(skin.id);
      }
      
      // 发送更新事件
      await tauri.sendSkinsUpdate?.({ action: skin.isBuiltin ? 'hide' : 'delete', skinId: skin.id });
      
      fetchSkins();
    } catch (err) {
      console.error("Failed to delete/hide skin:", err);
      alert("Failed to delete skin: " + (err.message || err));
    }
  };
  
  const handleRestore = async (skinId) => {
    try {
      await tauri.restoreSkin(skinId);
      
      // 发送更新事件
      await tauri.sendSkinsUpdate?.({ action: 'restore', skinId });
      
      fetchSkins();
    } catch (err) {
      console.error("Failed to restore skin:", err);
      alert("Failed to restore skin: " + (err.message || err));
    }
  };

  const handleExport = async (skin) => {
    try {
      // 选择导出目录
      const exportDir = await tauri.selectDirectory();
      if (!exportDir) return;
      
      // 导出皮肤
      const jsonPath = await tauri.exportSkin(skin.id, exportDir);
      alert(`Skin exported successfully!\n\nLocation: ${jsonPath}`);
    } catch (err) {
      console.error("Failed to export skin:", err);
      alert("Failed to export skin: " + (err.message || err));
    }
  };

  const handleCancel = () => {
    setIsCreating(false);
  };
  
  // 分离可见和隐藏的皮肤
  const visibleSkins = skins.filter(s => !s.isHidden);
  const hiddenSkins = skins.filter(s => s.isHidden);
  
  return (
    <>
      {/* Title + Import button */}
      {!isCreating && (
        <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
          <div className="text-base font-semibold text-slate-800">
            Skins ({visibleSkins.length})
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="rounded border-slate-300"
              />
              Show hidden
            </label>
            <Button variant="primary" onClick={() => setIsCreating(true)}>
              <FaPlus className="w-4 h-4" />
              Import
            </Button>
          </div>
        </div>
      )}
      
      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {isCreating ? (
          <Card
            title="Import New Skin"
            description="Select a JSON configuration file. Image files (0.png, 1.jpg, etc.) should be in the same directory."
          >
            <SkinForm 
              onSave={handleSave} 
              onCancel={handleCancel} 
            />
          </Card>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <FaSpinner className="w-8 h-8 text-slate-400 animate-spin mb-4" />
            <div className="text-slate-500">Loading skins...</div>
          </div>
        ) : visibleSkins.length === 0 && hiddenSkins.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <FaShirt className="w-12 h-12 text-slate-300 mb-4" />
            <div className="text-slate-600 font-medium">No custom skins yet</div>
            <div className="text-slate-400 text-sm mb-4">Import a 2x2 sprite sheet to get started</div>
            <Button variant="primary" onClick={() => setIsCreating(true)}>
              <FaPlus className="w-4 h-4" />
              Import Skin
            </Button>
          </div>
        ) : (
          <>
            {/* Visible skins list */}
            {visibleSkins.map((skin) => (
              <div key={skin.id} className="space-y-2">
                <div
                  onClick={() => setSelectedSkinId(selectedSkinId === skin.id ? null : skin.id)}
                  className={`bg-white border shadow-sm rounded-xl p-3 flex items-start gap-3 cursor-pointer transition-all ${
                    selectedSkinId === skin.id 
                      ? 'border-blue-400 ring-2 ring-blue-100' 
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <SkinPreview skinId={skin.id} skinName={skin.name} isBuiltin={skin.isBuiltin} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 truncate">
                          {skin.name}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {skin.author && (
                            <Badge tone="blue">by {skin.author}</Badge>
                          )}
                          {skin.isBuiltin ? (
                            <Badge tone="green">Built-in</Badge>
                          ) : (
                            <Badge tone="slate">Custom</Badge>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1.5">
                        <Button
                          variant="secondary"
                          onClick={(e) => { e.stopPropagation(); handleExport(skin); }}
                          title="Export"
                        >
                          <FaDownload className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="danger"
                          onClick={(e) => { e.stopPropagation(); handleDelete(skin); }}
                          title={skin.isBuiltin ? "Hide" : "Delete"}
                        >
                          {skin.isBuiltin ? (
                            <FaEyeSlash className="w-3.5 h-3.5" />
                          ) : (
                            <FaTrash className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
                {/* 展开的预览面板 */}
                {selectedSkinId === skin.id && (
                  <SkinMoodPreview skinId={skin.id} skinName={skin.name} isBuiltin={skin.isBuiltin} moods={skin.moods} />
                )}
              </div>
            ))}
            
            {/* Hidden skins section (only shown when showHidden is true) */}
            {showHidden && hiddenSkins.length > 0 && (
              <>
                <div className="pt-4 pb-2">
                  <div className="text-sm font-medium text-slate-500">
                    Hidden Skins ({hiddenSkins.length})
                  </div>
                </div>
                {hiddenSkins.map((skin) => (
                  <div
                    key={skin.id}
                    onClick={() => setSelectedSkinId(selectedSkinId === skin.id ? null : skin.id)}
                    className={`bg-slate-50 border shadow-sm rounded-xl p-3 flex items-start gap-3 opacity-60 cursor-pointer ${
                      selectedSkinId === skin.id 
                        ? 'border-blue-400' 
                        : 'border-slate-200'
                    }`}
                  >
                    <SkinPreview skinId={skin.id} skinName={skin.name} isBuiltin={skin.isBuiltin} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate">
                            {skin.name}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {skin.author && (
                              <Badge tone="blue">by {skin.author}</Badge>
                            )}
                            <Badge tone="amber">Hidden</Badge>
                            {skin.isBuiltin && (
                              <Badge tone="green">Built-in</Badge>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            onClick={(e) => { e.stopPropagation(); handleExport(skin); }}
                            title="Export"
                          >
                            <FaDownload className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={(e) => { e.stopPropagation(); handleRestore(skin.id); }}
                            title="Restore"
                          >
                            <FaEye className="w-3.5 h-3.5" />
                            Restore
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
};

// ==================== API Settings Panel ====================

const SettingsPanel = () => {
  return (
    <div className="flex-1 overflow-hidden bg-slate-50 flex items-center justify-center text-slate-400">
      Coming Soon
    </div>
  );
};

// ==================== UI Settings Panel ====================

const UIPanel = ({ settings, onSettingsChange, onSave, saving }) => {
  if (!settings) return null;
  
  return (
    <>
      {/* Title */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="text-base font-semibold text-slate-800">
          UI Settings
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          <Card title="Window Settings" description="Customize the application window">
            <FormGroup label="Window Size">
              <Select
                name="windowSize"
                value={settings.windowSize || "medium"}
                onChange={onSettingsChange}
              >
                <option value="large">Large</option>
                <option value="medium">Medium</option>
                <option value="small">Small</option>
              </Select>
            </FormGroup>
          </Card>
          
          <div className="pt-2">
            <Button
              type="button"
              variant="primary"
              disabled={saving}
              onClick={onSave}
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
        </div>
      </div>
    </>
  );
};

// ==================== Defaults Panel ====================

const DefaultsPanel = ({ settings, onSettingsChange, onSave, saving, assistants, modelConfigs, apiProviders }) => {
  if (!settings) return null;
  
  // 获取 Assistant 的显示文本
  const getAssistantDisplayText = (assistant) => {
    if (assistant.modelName) {
      return `${assistant.name} (${assistant.modelName})`;
    }
    return assistant.name;
  };

  // 获取 ModelConfig 的显示文本
  const getModelConfigDisplayText = (model) => {
    return `${model.name} (${model.modelName})`;
  };
  
  // 获取选中的 provider
  const selectedProvider = apiProviders?.find(p => p._id === settings.functionModelProviderId);
  
  // 获取该 provider 下的可见模型列表
  const availableModels = selectedProvider 
    ? (selectedProvider.cachedModels || []).filter(model => {
        const hiddenModels = selectedProvider.hiddenModels || [];
        const modelName = typeof model === 'string' ? model : model.name;
        return !hiddenModels.includes(modelName);
      })
    : [];
  
  // 处理 provider 变化
  const handleProviderChange = (e) => {
    const providerId = e.target.value;
    onSettingsChange({
      target: {
        name: 'functionModelProviderId',
        value: providerId
      }
    });
    // 清空选中的模型
    onSettingsChange({
      target: {
        name: 'functionModelName',
        value: ''
      }
    });
  };
  
  // 处理 model 变化
  const handleModelChange = (e) => {
    onSettingsChange({
      target: {
        name: 'functionModelName',
        value: e.target.value
      }
    });
  };

  return (
    <>
      {/* Title */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="text-base font-semibold text-slate-800">
          Defaults
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          <Card title="Default Assistants" description="Configure which assistants to use by default">
            <div className="space-y-4">
              <FormGroup label="Default Chatbot" hint="The assistant used for new conversations">
                <Select
                  name="defaultRoleId"
                  value={settings.defaultRoleId || ""}
                  onChange={onSettingsChange}
                >
                  <option value="">Select Default Assistant</option>
                  {assistants.map((assistant) => (
                    <option key={assistant._id} value={assistant._id}>
                      {getAssistantDisplayText(assistant)}
                    </option>
                  ))}
                </Select>
              </FormGroup>
              
              <FormGroup label="Function Model Provider" hint="Select the API provider for function model">
                <Select
                  name="functionModelProviderId"
                  value={settings.functionModelProviderId || ""}
                  onChange={handleProviderChange}
                >
                  <option value="">Select Provider</option>
                  {(apiProviders || []).map((provider) => (
                    <option key={provider._id} value={provider._id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
              </FormGroup>
              
              <FormGroup label="Function Model" hint="Lightweight model for quick tasks (mini recommended)">
                <Select
                  name="functionModelName"
                  value={settings.functionModelName || ""}
                  onChange={handleModelChange}
                  disabled={!settings.functionModelProviderId}
                >
                  <option value="">Select Model</option>
                  {availableModels.map((model) => {
                    const modelName = typeof model === 'string' ? model : model.name;
                    return (
                      <option key={modelName} value={modelName}>
                        {modelName}
                      </option>
                    );
                  })}
                </Select>
              </FormGroup>
            </div>
          </Card>
          
          <div className="pt-2">
            <Button
              type="button"
              variant="primary"
              disabled={saving}
              onClick={onSave}
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
        </div>
      </div>
    </>
  );
};

// ==================== Preferences Panel ====================

const PreferencesPanel = ({ settings, onSettingsChange, onSave, saving }) => {
  if (!settings) return null;
  
  // 处理 checkbox 变化
  const handleCheckboxChange = (e) => {
    const { name, checked } = e.target;
    onSettingsChange({
      target: {
        name,
        value: checked
      }
    });
  };

  return (
    <>
      {/* Title */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="text-base font-semibold text-slate-800">
          Preferences
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          {/* Memory Settings */}
          <Card title="Memory" description="Configure conversation memory behavior">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700">Enable Memory by Default</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  When enabled, the assistant will remember context across conversations by default.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  name="memoryEnabledByDefault"
                  checked={settings.memoryEnabledByDefault !== false}
                  onChange={handleCheckboxChange}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
              </label>
            </div>
          </Card>

          {/* Window Behavior */}
          <Card title="Window Behavior" description="Configure window movement settings">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700">Chat Window Follows Character</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  When enabled, the chat window will automatically move when you drag the character.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  name="chatFollowsCharacter"
                  checked={settings.chatFollowsCharacter !== false}
                  onChange={handleCheckboxChange}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
              </label>
            </div>
          </Card>
          
          {/* Character Mood Settings */}
          <Card title="Character Mood" description="Configure character expression behavior">
            <FormGroup>
              <Label>Mood Reset Delay (seconds)</Label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  name="moodResetDelay"
                  value={settings.moodResetDelay ?? 30}
                  onChange={onSettingsChange}
                  min={0}
                  max={300}
                  className="w-24"
                />
                <span className="text-sm text-slate-500">
                  {settings.moodResetDelay === 0 ? "Disabled" : `Reset to normal after ${settings.moodResetDelay ?? 30}s`}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Time before the character's expression returns to normal after responding. Set to 0 to disable.
              </div>
            </FormGroup>
          </Card>
          
          <div className="pt-2">
            <Button
              type="button"
              variant="primary"
              disabled={saving}
              onClick={onSave}
              className="w-full py-3"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <FaSpinner className="animate-spin w-4 h-4" />
                  Saving...
                </span>
              ) : "Save Preferences"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

// ==================== Hotkeys Panel ====================

const HotkeysPanel = ({ settings, onSettingsChange, onSave, saving }) => {
  if (!settings) return null;
  
  // 检测平台
  const isMacOS = typeof navigator !== 'undefined' && (
    navigator.platform.toUpperCase().indexOf('MAC') >= 0 || 
    navigator.userAgent.toUpperCase().indexOf('MAC') >= 0
  );
  
  // 单行快捷键设置组件
  const HotkeyRow = ({ label, name, value }) => (
    <div className="flex items-center justify-between py-3 border-b border-slate-100 last:border-b-0">
      <label className="text-sm font-medium text-slate-700 shrink-0 w-32">{label}</label>
      <div className="flex-1 max-w-xs">
        <SettingsHotkeyInput
          name={name}
          value={value || ""}
          onChange={onSettingsChange}
        />
      </div>
    </div>
  );
  
  return (
    <>
      {/* Title */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="text-base font-semibold text-slate-800">
          Keyboard Shortcuts
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="space-y-5">
          {/* Global Hotkeys Section */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
                <FaKeyboard className="w-4 h-4 text-white" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Global Hotkeys</h3>
                <p className="text-xs text-slate-500">Works anywhere on your system</p>
              </div>
            </div>
            
            <div className="bg-slate-50 rounded-xl px-4">
              <HotkeyRow label="Show/Hide App" name="programHotkey" value={settings.programHotkey} />
              <HotkeyRow label="Quick Dialog" name="dialogHotkey" value={settings.dialogHotkey} />
            </div>
          </div>
          
          {/* Chat Tab Hotkeys Section */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Chat Tab Hotkeys</h3>
                <p className="text-xs text-slate-500">Works when chat window is focused</p>
              </div>
            </div>
            
            <div className="bg-slate-50 rounded-xl px-4">
              <HotkeyRow label="New Tab" name="newTabHotkey" value={settings.newTabHotkey} />
              <HotkeyRow label="Close Tab" name="closeTabHotkey" value={settings.closeTabHotkey} />
              <div className="flex items-center justify-between py-3">
                <div className="shrink-0 w-32">
                  <label className="text-sm font-medium text-slate-700">Switch Tab</label>
                  <p className="text-xs text-slate-400">+ number (1-9)</p>
                </div>
                <div className="flex-1 max-w-xs">
                  <SettingsHotkeyInput
                    name="switchTabPrefix"
                    value={settings.switchTabPrefix || ""}
                    onChange={onSettingsChange}
                  />
                  <p className="text-xs text-slate-400 mt-1">
                    e.g. {isMacOS ? '⌘' : 'Ctrl'} + 1 → first tab
                  </p>
                </div>
              </div>
            </div>
          </div>
          
          {/* Save Button */}
          <div className="pt-2">
            <Button
              type="button"
              variant="primary"
              disabled={saving}
              onClick={onSave}
              className="w-full py-2.5"
            >
              {saving ? (
                <span className="flex items-center justify-center gap-2">
                  <FaSpinner className="animate-spin w-4 h-4" />
                  Saving...
                </span>
              ) : "Save Changes"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

// ==================== Screenshot Panel ====================

const ScreenshotPanel = ({ settings, onSettingsChange, onSave, saving }) => {
  if (!settings) return null;

  // 解析 screenshot_prompts（JSON 字符串 → 数组）
  const prompts = (() => {
    try {
      const raw = settings.screenshot_prompts;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') return JSON.parse(raw);
      return [];
    } catch { return []; }
  })();

  const [editingIdx, setEditingIdx] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: '', icon: '', prompt: '' });

  const updatePrompts = (newPrompts) => {
    onSettingsChange({
      target: { name: 'screenshot_prompts', value: JSON.stringify(newPrompts) }
    });
  };

  const handleAddPrompt = () => {
    const newItem = { name: 'New Action', icon: '🔍', prompt: '' };
    updatePrompts([...prompts, newItem]);
    setEditingIdx(prompts.length);
    setEditDraft({ ...newItem });
  };

  const handleDeletePrompt = (idx) => {
    const updated = prompts.filter((_, i) => i !== idx);
    updatePrompts(updated);
    if (editingIdx === idx) { setEditingIdx(null); }
    else if (editingIdx > idx) { setEditingIdx(editingIdx - 1); }
  };

  const handleEditPrompt = (idx) => {
    setEditingIdx(idx);
    setEditDraft({ ...prompts[idx] });
  };

  const handleSaveEdit = () => {
    if (editingIdx === null) return;
    const updated = [...prompts];
    updated[editingIdx] = { ...editDraft };
    updatePrompts(updated);
    setEditingIdx(null);
  };

  const handleCancelEdit = () => {
    setEditingIdx(null);
  };

  const handleCheckboxChange = (e) => {
    const { name, checked } = e.target;
    onSettingsChange({
      target: { name, value: checked }
    });
  };

  return (
    <>
      {/* Title */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="text-base font-semibold text-slate-800">
          Screenshot
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          {/* Screenshot Hotkey */}
          <Card title="Screenshot Hotkey" description="Global shortcut to trigger screenshot capture">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700">Capture Screenshot</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Press this shortcut anywhere to start a screenshot capture.
                </div>
              </div>
              <div className="w-48">
                <SettingsHotkeyInput
                  name="screenshotHotkey"
                  value={settings.screenshotHotkey || ''}
                  onChange={onSettingsChange}
                />
              </div>
            </div>
          </Card>

          {/* Hide Windows */}
          <Card title="Capture Behavior" description="Configure how screenshots are taken">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700">Hide Windows Before Capture</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Hide all PetGPT windows before taking a screenshot so they don't appear in the captured image.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  name="screenshot_hide_windows"
                  checked={settings.screenshot_hide_windows !== false && settings.screenshot_hide_windows !== 'false'}
                  onChange={handleCheckboxChange}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
              </label>
            </div>
          </Card>

          {/* Quick Prompts */}
          <Card title="Quick Actions" description="Custom toolbar buttons shown after selecting a screenshot area. Each button sends the screenshot with a preset prompt to a new chat tab.">
            <div className="space-y-2">
              {prompts.length === 0 && (
                <div className="text-sm text-slate-400 text-center py-3">
                  No quick actions configured. Click "Add" to create one.
                </div>
              )}

              {prompts.map((item, idx) => (
                <div key={idx}>
                  {editingIdx === idx ? (
                    // 编辑模式
                    <div className="border border-blue-200 rounded-lg p-3 bg-blue-50/50 space-y-2">
                      <div className="flex gap-2">
                        <div className="w-16">
                          <label className="text-xs text-slate-500">Icon</label>
                          <Input
                            value={editDraft.icon}
                            onChange={(e) => setEditDraft(d => ({ ...d, icon: e.target.value }))}
                            className="text-center text-lg"
                            maxLength={2}
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-slate-500">Name</label>
                          <Input
                            value={editDraft.name}
                            onChange={(e) => setEditDraft(d => ({ ...d, name: e.target.value }))}
                            placeholder="e.g. Translate"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-slate-500">Prompt</label>
                        <Textarea
                          value={editDraft.prompt}
                          onChange={(e) => setEditDraft(d => ({ ...d, prompt: e.target.value }))}
                          placeholder="e.g. Please translate the text in this screenshot to English"
                          rows={3}
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={handleCancelEdit} className="text-xs px-3 py-1">Cancel</Button>
                        <Button variant="primary" onClick={handleSaveEdit} className="text-xs px-3 py-1">Done</Button>
                      </div>
                    </div>
                  ) : (
                    // 列表模式
                    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 group">
                      <span className="text-xl w-8 text-center shrink-0">{item.icon || '📋'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-700 truncate">{item.name}</div>
                        <div className="text-xs text-slate-400 truncate">{item.prompt || '(no prompt)'}</div>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleEditPrompt(idx)}
                          className="p-1.5 rounded hover:bg-slate-200 text-slate-500"
                          title="Edit"
                        >
                          <FaPen className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDeletePrompt(idx)}
                          className="p-1.5 rounded hover:bg-red-100 text-slate-500 hover:text-red-500"
                          title="Delete"
                        >
                          <FaTrash className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              <button
                onClick={handleAddPrompt}
                className="w-full flex items-center justify-center gap-2 py-2 text-sm text-blue-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg border border-dashed border-blue-200 transition-colors"
              >
                <FaPlus className="w-3 h-3" /> Add Quick Action
              </button>
            </div>
          </Card>

          <div className="pt-2">
            <Button
              type="button"
              variant="primary"
              disabled={saving}
              onClick={onSave}
              className="w-full py-3"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <FaSpinner className="animate-spin w-4 h-4" />
                  Saving...
                </span>
              ) : "Save Screenshot Settings"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

// ==================== Social Agent Panel ====================

const SocialPanel = ({ assistants, apiProviders }) => {
  const [selectedPetId, setSelectedPetId] = useState('');
  const [config, setConfig] = useState({
    petId: '',
    mcpServerName: '',
    apiProviderId: '',
    modelName: '',
    pollingInterval: 60,
    watchedGroups: [],
    watchedFriends: [],
    socialPersonaPrompt: '',
    replyStrategyPrompt: '',
    atMustReply: true,
    botQQ: '',
  });
  const [mcpServers, setMcpServers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [socialActive, setSocialActive] = useState(false);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [groupsText, setGroupsText] = useState('');
  const [friendsText, setFriendsText] = useState('');

  // Load MCP servers list
  useEffect(() => {
    const loadServers = async () => {
      try {
        const serverList = await tauri.mcp.getServers();
        setMcpServers(serverList || []);
      } catch (e) {
        console.error('Failed to load MCP servers:', e);
      }
    };
    loadServers();
  }, []);

  // Listen for social status changes from character window
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-status-changed', (event) => {
        const { active, petId } = event.payload;
        if (petId === selectedPetId || !selectedPetId) {
          setSocialActive(active);
        }
      });
      // Query current status on mount
      emit('social-query-status');
    };
    setup();
    return () => { unlisten?.(); };
  }, [selectedPetId]);

  // Listen for log responses from character window
  useEffect(() => {
    let unlisten;
    const setup = async () => {
      unlisten = await listen('social-logs-response', (event) => {
        setLogs(event.payload || []);
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  // Refresh logs periodically when visible
  useEffect(() => {
    if (!showLogs) return;
    emit('social-query-logs');
    const interval = setInterval(() => emit('social-query-logs'), 3000);
    return () => clearInterval(interval);
  }, [showLogs]);

  // Load config when pet changes
  useEffect(() => {
    if (!selectedPetId) return;
    const load = async () => {
      const saved = await loadSocialConfig(selectedPetId);
      if (saved) {
        setConfig({ ...saved, petId: selectedPetId });
        setGroupsText((saved.watchedGroups || []).join(', '));
        setFriendsText((saved.watchedFriends || []).join(', '));
      } else {
        setConfig(prev => ({
          ...prev,
          petId: selectedPetId,
          mcpServerName: '',
          apiProviderId: '',
          modelName: '',
          pollingInterval: 60,
          watchedGroups: [],
          watchedFriends: [],
          socialPersonaPrompt: '',
          replyStrategyPrompt: '',
          atMustReply: true,
          injectBehaviorGuidelines: true,
          atInstantReply: true,
          botQQ: '',
          ownerQQ: '',
          ownerName: '',
          enabledMcpServers: [],
        }));
        setGroupsText('');
        setFriendsText('');
      }
      // Query status from character window
      emit('social-query-status');
    };
    load();
  }, [selectedPetId]);

  // Auto-select first assistant
  useEffect(() => {
    if (assistants.length > 0 && !selectedPetId) {
      setSelectedPetId(assistants[0]._id);
    }
  }, [assistants, selectedPetId]);

  const handleConfigChange = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const configToSave = {
        ...config,
        petId: selectedPetId,
        watchedGroups: groupsText.split(',').map(s => s.trim()).filter(Boolean),
        watchedFriends: friendsText.split(',').map(s => s.trim()).filter(Boolean),
      };
      await saveSocialConfig(selectedPetId, configToSave);
      setConfig(configToSave);
      // 如果循环正在运行，通知 character 窗口用新配置重启
      if (socialActive) {
        emit('social-config-updated', configToSave);
      }
    } catch (e) {
      console.error('Failed to save social config:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (socialActive) {
      // Send stop event to character window
      emit('social-stop');
    } else {
      const configToStart = {
        ...config,
        petId: selectedPetId,
        watchedGroups: groupsText.split(',').map(s => s.trim()).filter(Boolean),
        watchedFriends: friendsText.split(',').map(s => s.trim()).filter(Boolean),
      };
      // Save config first, then send start event to character window
      await saveSocialConfig(selectedPetId, configToStart);
      setConfig(configToStart);
      emit('social-start', configToStart);
    }
  };

  // Resolve available models for selected provider
  const selectedProvider = apiProviders.find(p => (p._id || p.id) === config.apiProviderId);
  const providerModels = selectedProvider?.cachedModels || [];

  return (
    <>
      {/* Title */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="text-base font-semibold text-slate-800">
          Social Agent
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            {showLogs ? 'Hide Logs' : 'Show Logs'}
          </button>
          <button
            onClick={handleToggle}
            disabled={!selectedPetId}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
              socialActive 
                ? 'bg-red-500 text-white hover:bg-red-600' 
                : 'bg-cyan-500 text-white hover:bg-cyan-600'
            } disabled:opacity-50`}
          >
            {socialActive ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          {/* Assistant Selector */}
          <Card title="Assistant" description="Select which assistant powers the social agent">
            <FormGroup label="Assistant">
              <Select
                value={selectedPetId}
                onChange={(e) => setSelectedPetId(e.target.value)}
              >
                <option value="">Select an assistant...</option>
                {assistants.map(a => (
                  <option key={a._id} value={a._id}>{a.name}</option>
                ))}
              </Select>
            </FormGroup>
          </Card>

          {/* LLM Configuration */}
          <Card title="LLM" description="API provider and model for social decisions">
            <div className="space-y-3">
              <FormGroup label="API Provider">
                <Select
                  value={config.apiProviderId}
                  onChange={(e) => {
                    handleConfigChange('apiProviderId', e.target.value);
                    handleConfigChange('modelName', '');
                  }}
                >
                  <option value="">Select provider...</option>
                  {apiProviders.map(p => (
                    <option key={p._id || p.id} value={p._id || p.id}>{p.name}</option>
                  ))}
                </Select>
              </FormGroup>
              <FormGroup label="Model">
                {providerModels.length > 0 ? (
                  <Select
                    value={config.modelName}
                    onChange={(e) => handleConfigChange('modelName', e.target.value)}
                  >
                    <option value="">Select model...</option>
                    {providerModels.map(m => {
                      const modelId = typeof m === 'string' ? m : m.id;
                      return <option key={modelId} value={modelId}>{modelId}</option>;
                    })}
                  </Select>
                ) : (
                  <Input
                    value={config.modelName}
                    onChange={(e) => handleConfigChange('modelName', e.target.value)}
                    placeholder="e.g. gpt-4o-mini"
                  />
                )}
              </FormGroup>
            </div>
          </Card>

          {/* MCP Server */}
          <Card title="MCP Server" description="The QQ MCP server to use for messaging">
            <FormGroup label="Server">
              <Select
                value={config.mcpServerName}
                onChange={(e) => handleConfigChange('mcpServerName', e.target.value)}
              >
                <option value="">Select server...</option>
                {mcpServers.map(s => (
                  <option key={s._id} value={s.name}>{s.name}</option>
                ))}
              </Select>
            </FormGroup>
            <FormGroup label="Bot QQ Number" hint="Your bot's QQ number, used to detect @mentions">
              <Input
                value={config.botQQ}
                onChange={(e) => handleConfigChange('botQQ', e.target.value)}
                placeholder="e.g. 3825478002"
              />
            </FormGroup>
            <FormGroup label="Owner QQ Number" hint="Your personal QQ number, so the bot can recognize you in group chat">
              <Input
                value={config.ownerQQ}
                onChange={(e) => handleConfigChange('ownerQQ', e.target.value)}
                placeholder="e.g. 123456789"
              />
            </FormGroup>
            <FormGroup label="Owner Name" hint="Your QQ display name or nickname">
              <Input
                value={config.ownerName}
                onChange={(e) => handleConfigChange('ownerName', e.target.value)}
                placeholder="e.g. Jules"
              />
            </FormGroup>
          </Card>

          {/* Additional MCP Servers */}
          {mcpServers.filter(s => s.name !== config.mcpServerName).length > 0 && (
            <Card title="Additional MCP Tools" description="Enable extra MCP servers whose tools the agent can use">
              <div className="space-y-2">
                {mcpServers.filter(s => s.name !== config.mcpServerName).map(s => (
                  <div key={s._id} className="flex items-center justify-between">
                    <div className="text-sm text-slate-700">{s.name}</div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(config.enabledMcpServers || []).includes(s.name)}
                        onChange={(e) => {
                          const prev = config.enabledMcpServers || [];
                          if (e.target.checked) {
                            handleConfigChange('enabledMcpServers', [...prev, s.name]);
                          } else {
                            handleConfigChange('enabledMcpServers', prev.filter(n => n !== s.name));
                          }
                        }}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                    </label>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Targets */}
          <Card title="Watch Targets" description="QQ groups and friends to monitor">
            <div className="space-y-3">
              <FormGroup label="Groups" hint="Comma-separated group numbers">
                <Input
                  value={groupsText}
                  onChange={(e) => setGroupsText(e.target.value)}
                  placeholder="e.g. 1059558644, 123456789"
                />
              </FormGroup>
              <FormGroup label="Friends" hint="Comma-separated QQ numbers">
                <Input
                  value={friendsText}
                  onChange={(e) => setFriendsText(e.target.value)}
                  placeholder="e.g. 100001, 100002"
                />
              </FormGroup>
            </div>
          </Card>

          {/* Polling */}
          <Card title="Polling" description="How often to check for new messages">
            <div className="space-y-3">
              <FormGroup label="Interval (seconds)">
                <Input
                  type="number"
                  min={3}
                  max={600}
                  value={config.pollingInterval}
                  onChange={(e) => handleConfigChange('pollingInterval', parseInt(e.target.value) || 60)}
                />
              </FormGroup>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700">Instant @Reply</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Check for @mentions every 3s and reply immediately
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.atInstantReply !== false}
                    onChange={(e) => handleConfigChange('atInstantReply', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                </label>
              </div>

            </div>
          </Card>

          {/* Prompt Configuration */}
          <Card title="Prompts" description="Customize social behavior and reply strategy">
            <div className="space-y-3">
              <FormGroup label="Social Persona" hint="Additional persona instructions for social context">
                <Textarea
                  rows={3}
                  value={config.socialPersonaPrompt}
                  onChange={(e) => handleConfigChange('socialPersonaPrompt', e.target.value)}
                  placeholder="e.g. 你是群里的活跃成员，喜欢用emoji..."
                />
              </FormGroup>
              <FormGroup label="Reply Strategy" hint="Rules for when to reply vs stay silent">
                <Textarea
                  rows={3}
                  value={config.replyStrategyPrompt}
                  onChange={(e) => handleConfigChange('replyStrategyPrompt', e.target.value)}
                  placeholder="Leave empty for default: reply only when mentioned or topic is interesting"
                />
              </FormGroup>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700">@Mention Must Reply</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Always reply when someone @mentions the bot
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.atMustReply !== false}
                    onChange={(e) => handleConfigChange('atMustReply', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                </label>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700">Behavior Guidelines</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Inject built-in social behavior rules (be genuine, quality over quantity, etc.)
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.injectBehaviorGuidelines !== false}
                    onChange={(e) => handleConfigChange('injectBehaviorGuidelines', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                </label>
              </div>
            </div>
          </Card>

          {/* Save Button */}
          <div className="flex justify-end pb-4">
            <Button 
              variant="primary" 
              onClick={handleSave} 
              disabled={saving || !selectedPetId}
            >
              {saving ? <FaSpinner className="animate-spin w-4 h-4 mr-1" /> : <FaCheck className="w-4 h-4 mr-1" />}
              Save Configuration
            </Button>
          </div>

          {/* Logs */}
          {showLogs && (
            <Card 
              title="Logs" 
              description="Recent social agent activity"
              action={
                <button 
                  onClick={() => { emit('social-clear-logs'); setLogs([]); }}
                  className="text-xs text-slate-500 hover:text-red-500"
                >
                  Clear
                </button>
              }
            >
              <div className="max-h-64 overflow-y-auto text-xs font-mono space-y-0.5">
                {logs.length === 0 ? (
                  <div className="text-slate-400 text-center py-4">No logs yet</div>
                ) : (
                  [...logs].reverse().map((log, i) => (
                    <div key={i} className={`py-0.5 ${
                      log.level === 'error' ? 'text-red-600' : 
                      log.level === 'warn' ? 'text-amber-600' : 'text-slate-600'
                    }`}>
                      <span className="text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      {' '}
                      <span className="font-semibold">[{log.level}]</span>
                      {' '}
                      {log.message}
                      {log.details && <span className="text-slate-400"> — {typeof log.details === 'string' ? log.details : JSON.stringify(log.details)}</span>}
                    </div>
                  ))
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
};

// ==================== Sidebar Navigation ====================

const tabGroups = [
  {
    title: 'MANAGE',
    tabs: [
      { id: 'assistants', label: 'Assistants', icon: FaRobot },
      { id: 'api', label: 'API', icon: FaKey },
      { id: 'models', label: 'Models', icon: FaList },
      { id: 'mcp', label: 'MCP', icon: FaPlug },
      { id: 'social', label: 'Social', icon: GiPenguin },
      { id: 'skins', label: 'Skins', icon: FaShirt },
    ]
  },
  {
    title: 'SETTINGS',
    tabs: [
      { id: 'defaults', label: 'Defaults', icon: FaGear },
      { id: 'preferences', label: 'Preferences', icon: FaSliders },
      { id: 'hotkeys', label: 'Hotkeys', icon: FaKeyboard },
      { id: 'screenshot', label: 'Screenshot', icon: FaCamera },
      { id: 'ui', label: 'UI', icon: FaPalette },
    ]
  }
];

const allTabs = tabGroups.flatMap(g => g.tabs.map(t => t.id));

const Sidebar = ({ activeTab, onTabChange, onClose, onMaximize }) => {
  return (
    <div className="w-32 bg-slate-50 border-r border-slate-200 flex flex-col shrink-0 overflow-y-auto">
      {/* Window Controls - macOS Style */}
      <div className="draggable flex items-center gap-2 px-3 py-3" data-tauri-drag-region>
        {/* 红色：关闭 */}
        <div 
          onClick={onClose} 
          className="no-drag w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 cursor-pointer flex items-center justify-center group"
          title="关闭"
        >
          <MdClose className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
        </div>
        {/* 黄色：最小化（隐藏窗口） */}
        <div 
          onClick={onClose} 
          className="no-drag w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 cursor-pointer flex items-center justify-center group"
          title="隐藏"
        >
          <span className="text-white text-[8px] font-bold opacity-0 group-hover:opacity-100">−</span>
        </div>
        {/* 绿色：最大化/还原 */}
        <div 
          onClick={onMaximize} 
          className="no-drag w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 cursor-pointer flex items-center justify-center group"
          title="全屏"
        >
          <LuMaximize2 className="text-white text-[8px] opacity-0 group-hover:opacity-100" />
        </div>
      </div>
      
      {/* Tab Groups */}
      <div className="flex flex-col py-2 gap-0">
      {tabGroups.map((group, groupIndex) => (
        <div key={group.title}>
          {/* Group title */}
          <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 tracking-wider">
            {group.title}
          </div>
          
          {/* Group tabs */}
          <div className="flex flex-col gap-0.5 px-2">
            {group.tabs.map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className={`
                    w-full h-9 rounded-lg flex items-center gap-2 px-2.5 transition-colors
                    ${isActive 
                      ? 'bg-blue-100 text-blue-600' 
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                    }
                  `}
                  title={tab.label}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="text-xs font-medium truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>
          
          {/* Separator between groups */}
          {groupIndex < tabGroups.length - 1 && (
            <div className="mx-3 my-2 border-t border-slate-200" />
          )}
        </div>
      ))}
      </div>
    </div>
  );
};

// ==================== Main Management Page ====================

const ManagementPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  
  // Settings 相关状态
  const { settings: syncedSettings, loading: settingsLoading, updateSettings: saveSettingsHook } = useSettings();
  const [localSettings, setLocalSettings] = useState(null);
  const [assistants, setAssistants] = useState([]);
  const [modelConfigs, setModelConfigs] = useState([]);
  const [apiProviders, setApiProviders] = useState([]);
  const [saving, setSaving] = useState(false);
  
  // 当同步设置加载完成时，初始化本地设置
  useEffect(() => {
    if (!settingsLoading && syncedSettings && Object.keys(syncedSettings).length > 0) {
      setLocalSettings(syncedSettings);
    }
  }, [syncedSettings, settingsLoading]);
  
  // 获取 Assistants、ModelConfigs 和 ApiProviders 列表
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [assistantData, modelData, providerData] = await Promise.all([
          tauri.getAssistants(),
          tauri.getModelConfigs(),
          tauri.getApiProviders()
        ]);
        if (Array.isArray(assistantData)) {
          setAssistants(assistantData);
        }
        if (Array.isArray(modelData)) {
          setModelConfigs(modelData);
        }
        if (Array.isArray(providerData)) {
          // 规范化 providers 数据
          const normalizedProviders = providerData.map(p => ({
            ...p,
            cachedModels: typeof p.cachedModels === 'string' 
              ? JSON.parse(p.cachedModels) 
              : (p.cachedModels || []),
            hiddenModels: typeof p.hiddenModels === 'string'
              ? JSON.parse(p.hiddenModels)
              : (p.hiddenModels || [])
          }));
          setApiProviders(normalizedProviders);
        }
      } catch (error) {
        console.error("Failed to load data:", error);
      }
    };
    fetchData();
  }, []);
  
  // 从 URL 参数获取初始 tab
  const getInitialTab = () => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab && allTabs.includes(tab)) {
      return tab;
    }
    return 'assistants';
  };
  
  const [activeTab, setActiveTab] = useState(getInitialTab);
  
  // 当 URL 变化时更新 tab
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab && allTabs.includes(tab)) {
      setActiveTab(tab);
    }
  }, [location.search]);

  // 使用 ref 来存储当前 activeTab，避免闭包问题
  const activeTabRef = React.useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // 监听来自 Rust 的 check_current_tab 事件，处理切换/隐藏逻辑
  useEffect(() => {
    let unlisten = null;
    let cancelled = false;
    
    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) return;
        
        console.log('[ManagementPage] Setting up check_current_tab listener');
        unlisten = await listen('check_current_tab', (event) => {
          const targetTab = event.payload;
          const currentTab = activeTabRef.current;
          
          console.log('[ManagementPage] check_current_tab event:', { targetTab, currentTab });
          
          if (currentTab === targetTab) {
            // 同一个 tab，隐藏窗口
            console.log('[ManagementPage] Same tab, hiding window');
            tauri.hideManageWindow?.();
          } else {
            // 不同 tab，切换到目标 tab
            console.log('[ManagementPage] Different tab, switching to:', targetTab);
            setActiveTab(targetTab);
            window.history.replaceState(null, '', `#/manage?tab=${targetTab}`);
          }
        });
        console.log('[ManagementPage] Listener setup complete');
      } catch (err) {
        console.error('[ManagementPage] Failed to setup listener:', err);
      }
    };
    
    setupListener();
    
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    // 更新 URL 但不触发导航
    const newUrl = `/manage?tab=${tab}`;
    window.history.replaceState(null, '', `#${newUrl}`);
  };
  
  const handleClose = () => {
    tauri.hideManageWindow?.();
  };

  const handleMaximize = () => {
    tauri.maximizeWindow?.('manage');
  };
  
  // Settings 相关处理函数
  const handleSettingsChange = (e) => {
    const { name, value } = e.target;
    setLocalSettings((prev) => ({ ...prev, [name]: value }));
  };
  
  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      await saveSettingsHook(localSettings);
      tauri.updateWindowSizePreset(localSettings.windowSize);
      tauri.updateShortcuts(localSettings.programHotkey, localSettings.dialogHotkey, localSettings.screenshotHotkey);
      
      // 同步偏好设置到 Rust 后端
      if (localSettings.chatFollowsCharacter !== undefined) {
        await tauri.updatePreferences({ 
          chatFollowsCharacter: localSettings.chatFollowsCharacter !== false 
        });
      }
      
      alert("Settings saved successfully!");
    } catch (error) {
      alert("Failed to save settings: " + error.message);
    } finally {
      setSaving(false);
    }
  };
  
  const getTitle = () => {
    switch (activeTab) {
      case 'assistants': return 'Assistants';
      case 'api': return 'API Providers';
      case 'models': return 'Models';
      case 'mcp': return 'MCP Servers';
      case 'social': return 'Social Agent';
      case 'defaults': return 'Defaults';
      case 'preferences': return 'Preferences';
      case 'hotkeys': return 'Keyboard Shortcuts';
      case 'screenshot': return 'Screenshot';
      case 'ui': return 'UI Settings';
      case 'skins': return 'Skins';
      default: return 'Settings';
    }
  };

  return (
    <PageLayout className="bg-white">
      <div className="flex h-screen w-full">
        {/* Sidebar */}
        <Sidebar 
          activeTab={activeTab} 
          onTabChange={handleTabChange}
          onClose={handleClose}
          onMaximize={handleMaximize}
        />
        
        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* TitleBar */}
          <div className="shrink-0">
            <TitleBar
              title={getTitle()}
              height="h-12"
            />
          </div>
          
          {/* Panel content */}
          <div className="flex-1 flex flex-col min-h-0">
            {activeTab === 'assistants' && <AssistantsPanel />}
            {activeTab === 'api' && <ApiProvidersPanel />}
            {activeTab === 'models' && <ModelsPanel />}
            {activeTab === 'mcp' && <McpServersPanel />}
            {activeTab === 'skins' && <SkinsPanel />}
            {activeTab === 'social' && <SocialPanel assistants={assistants} apiProviders={apiProviders} />}
            {activeTab === 'defaults' && (
              <DefaultsPanel 
                settings={localSettings}
                onSettingsChange={handleSettingsChange}
                onSave={handleSaveSettings}
                saving={saving}
                assistants={assistants}
                modelConfigs={modelConfigs}
                apiProviders={apiProviders}
              />
            )}
            {activeTab === 'hotkeys' && (
              <HotkeysPanel 
                settings={localSettings}
                onSettingsChange={handleSettingsChange}
                onSave={handleSaveSettings}
                saving={saving}
              />
            )}
            {activeTab === 'preferences' && (
              <PreferencesPanel 
                settings={localSettings}
                onSettingsChange={handleSettingsChange}
                onSave={handleSaveSettings}
                saving={saving}
              />
            )}
            {activeTab === 'screenshot' && (
              <ScreenshotPanel 
                settings={localSettings}
                onSettingsChange={handleSettingsChange}
                onSave={handleSaveSettings}
                saving={saving}
              />
            )}
            {activeTab === 'ui' && (
              <UIPanel 
                settings={localSettings} 
                onSettingsChange={handleSettingsChange}
                onSave={handleSaveSettings}
                saving={saving}
              />
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default ManagementPage;
