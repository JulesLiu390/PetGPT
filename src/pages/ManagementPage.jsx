import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { FaPlus, FaTrash, FaPen, FaCheck, FaSpinner, FaList, FaServer, FaKey, FaChevronDown, FaChevronUp, FaRobot, FaPlug, FaPalette, FaGear, FaKeyboard } from "react-icons/fa6";
import { FiRefreshCw } from 'react-icons/fi';
import { MdClose } from "react-icons/md";
import { LuMaximize2 } from "react-icons/lu";
import TitleBar from "../components/UI/TitleBar";
import { PageLayout, Surface, Card, FormGroup, Input, Select, Textarea, Button, Alert, Label, Badge, Checkbox } from "../components/UI/ui";
import { IconSelectorTrigger } from "../components/UI/IconSelector";
import { fetchModels, callOpenAILib } from "../utils/openai";
import { getPresetsForFormat, getDefaultBaseUrl, findPresetByUrl } from "../utils/llm/presets";
import * as bridge from "../utils/bridge";
import { useSettings } from "../utils/useSettings";
import SettingsHotkeyInput from "../components/Settings/SettingsHotkeyInput";

// ==================== Shared Components ====================

const CustomImage = ({ imageName }) => {
  const [imgSrc, setImgSrc] = useState("");

  useEffect(() => {
    const loadImage = async () => {
      try {
        if (imageName === "default") {
          const module = await import(`../assets/default-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Opai") {
          const module = await import(`../assets/Opai-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Claudia") {
          const module = await import(`../assets/Claudia-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Grocka") {
          const module = await import(`../assets/Grocka-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Gemina") {
          const module = await import(`../assets/Gemina-normal.png`);
          setImgSrc(module.default);
        } else {
          const base64Image = await bridge.readPetImage(`${imageName}-normal.png`);
          setImgSrc(base64Image);
        }
      } catch (error) {
        console.error("Error loading image:", error);
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
  const mapping = {
    'openai_compatible': 'Opai',
    'gemini_official': 'Gemina',
    'openai': 'Opai',
    'gemini': 'Gemina',
    'grok': 'Grocka',
    'anthropic': 'Claudia',
  };
  return mapping[apiFormat] || 'default';
};

/**
 * Assistant 编辑/创建表单
 */
const AssistantForm = ({ assistant, onSave, onCancel }) => {
  const [apiProviders, setApiProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [availableModels, setAvailableModels] = useState([]);
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
  });

  // 加载可用的 API Providers
  useEffect(() => {
    const loadApiProviders = async () => {
      try {
        const providers = await bridge.apiProviders.getAll();
        if (Array.isArray(providers)) {
          setApiProviders(providers);
          
          // 如果是编辑模式，匹配现有的 provider
          if (assistant && assistant.modelUrl && assistant.modelApiKey) {
            const matchedProvider = providers.find(p => 
              p.baseUrl === assistant.modelUrl && 
              p.apiKey === assistant.modelApiKey
            );
            if (matchedProvider) {
              setSelectedProviderId(matchedProvider.id);
              const models = matchedProvider.cachedModels 
                ? (typeof matchedProvider.cachedModels === 'string' 
                    ? JSON.parse(matchedProvider.cachedModels) 
                    : matchedProvider.cachedModels)
                : [];
              setAvailableModels(models);
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
      const models = provider.cachedModels 
        ? (typeof provider.cachedModels === 'string' 
            ? JSON.parse(provider.cachedModels) 
            : provider.cachedModels)
        : [];
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
      await onSave(formData);
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
        <Select
          name="imageName"
          value={formData.imageName}
          onChange={handleChange}
        >
          <option value="default">Default</option>
          <option value="Opai">Opai (OpenAI style)</option>
          <option value="Gemina">Gemina (Gemini style)</option>
          <option value="Claudia">Claudia (Claude style)</option>
          <option value="Grocka">Grocka (Grok style)</option>
        </Select>
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
      const assistantData = await bridge.getAssistants();
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

    const cleanup = bridge.onPetsUpdated(petsUpdateHandler);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const handleSelect = async (assistant) => {
    await bridge.sendCharacterId(assistant._id);
    await bridge.hideManageWindow();
    await bridge.showChatWindow();
  };

  const handleDeleteAssistant = async (assistantId) => {
    const confirmed = await bridge.confirm("Are you sure you want to delete this assistant?", { title: "Delete Assistant" });
    if (!confirmed) return;
    
    try {
      await bridge.deleteAssistant(assistantId);
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
      const updatedAssistant = await bridge.updateAssistant(editingAssistant._id, formData);
      bridge.sendPetsUpdate(updatedAssistant);
      bridge.sendCharacterId(editingAssistant._id);
    } else {
      // Create new
      const newAssistant = await bridge.createAssistant(formData);
      if (!newAssistant || !newAssistant._id) {
        throw new Error("Creation failed or no ID returned");
      }
      bridge.sendCharacterId(newAssistant._id);
      bridge.sendPetsUpdate(newAssistant);
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
  if (apiKey.startsWith("sk-ant-")) return { format: "anthropic", name: "Anthropic" };
  if (apiKey.startsWith("AIza")) return { format: "gemini_official", name: "Google Gemini" };
  if (apiKey.startsWith("gsk_")) return { format: "openai_compatible", name: "Groq" };
  if (apiKey.startsWith("sk-or-")) return { format: "openai_compatible", name: "OpenRouter" };
  if (apiKey.startsWith("sk-")) return { format: "openai_compatible", name: "OpenAI / DeepSeek" };
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
  
  // 当 API Key 改变时，尝试检测服务商
  useEffect(() => {
    const detected = detectProviderFromKey(formData.apiKey);
    setDetectedProvider(detected);
    
    // 如果检测到了且是新建，自动填充
    if (detected && !provider) {
      if (detected.format === "gemini_official") {
        setFormData(prev => ({
          ...prev,
          apiFormat: "gemini_official",
          baseUrl: "https://generativelanguage.googleapis.com",
          name: prev.name || detected.name,
        }));
      } else if (detected.name === "Groq") {
        setFormData(prev => ({
          ...prev,
          baseUrl: "https://api.groq.com/openai/v1",
          name: prev.name || "Groq",
        }));
      } else if (detected.name === "OpenRouter") {
        setFormData(prev => ({
          ...prev,
          baseUrl: "https://openrouter.ai/api/v1",
          name: prev.name || "OpenRouter",
        }));
      }
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
        setFetchedModels(models);
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
        setFetchedModels(models);
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
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name || !formData.baseUrl || !formData.apiKey) {
      setTestResult("Please fill in all required fields");
      return;
    }
    
    // 保存时包含 cached_models
    const dataToSave = {
      ...formData,
      cachedModels: fetchedModels.length > 0 ? fetchedModels : (provider?.cachedModels || []),
    };
    
    onSave(dataToSave);
  };
  
  const formatOptions = [
    { value: "openai_compatible", label: "OpenAI Compatible" },
    { value: "anthropic", label: "Anthropic Claude" },
    { value: "gemini_official", label: "Google Gemini" },
  ];
  
  // 预设选项
  const presets = getPresetsForFormat(formData.apiFormat);
  
  const handlePresetChange = (e) => {
    const presetUrl = e.target.value;
    if (presetUrl) {
      const preset = findPresetByUrl(presetUrl);
      setFormData(prev => ({
        ...prev,
        baseUrl: presetUrl,
        name: prev.name || (preset ? preset.name : guessProviderName(presetUrl)),
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
        {detectedProvider && (
          <div className="mt-1 text-xs text-blue-600">
            Detected: {detectedProvider.name}
          </div>
        )}
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
                {preset.name}
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
      const data = await bridge.getApiProviders();
      const normalized = (data || []).map(p => ({ ...p, _id: p._id || p.id }));
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
        await bridge.updateApiProvider(editingProvider._id, formData);
      } else {
        await bridge.createApiProvider(formData);
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
    const confirmed = await bridge.confirm("Are you sure you want to delete this API provider?", { title: "Delete API Provider" });
    if (!confirmed) return;
    
    try {
      await bridge.deleteApiProvider(id);
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
      showInToolbar
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
      const result = await bridge.mcp.testServer(config);
      
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
      const allTools = await bridge.mcp.getAllTools();
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

const McpServersPanel = () => {
  const [servers, setServers] = useState([]);
  const [serverStatuses, setServerStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [editingServer, setEditingServer] = useState(null);
  
  const loadServers = useCallback(async () => {
    try {
      const serverList = await bridge.mcp.getServers();
      setServers(serverList || []);
      
      const statuses = {};
      for (const server of serverList || []) {
        try {
          const status = await bridge.mcp.getServerStatus(server._id);
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
    if (!bridge.mcp.onServersUpdated) return;
    
    const cleanup = bridge.mcp.onServersUpdated(() => {
      loadServers();
    });
    
    return cleanup;
  }, [loadServers]);
  
  const handleDeleteServer = async (id) => {
    const serverToDelete = servers.find(s => s._id === id);
    const serverName = serverToDelete?.name || 'Unknown';
    
    const confirmDelete = await bridge.confirm(`Are you sure you want to delete "${serverName}"?`, {
      title: 'Delete MCP Server'
    });
    if (!confirmDelete) return;
    
    try {
      await bridge.mcp.deleteServer(id);
      await bridge.mcp.emitServersUpdated({ action: 'deleted', serverName });
      await loadServers();
    } catch (err) {
      console.error('Failed to delete server:', err);
      alert('Failed to delete server: ' + (err.message || err));
    }
  };
  
  const handleSave = async (config) => {
    if (editingServer) {
      await bridge.mcp.updateServer(config._id, config);
      await bridge.mcp.emitServersUpdated({ action: 'updated', serverName: config.name });
    } else {
      await bridge.mcp.createServer(config);
      await bridge.mcp.emitServersUpdated({ action: 'created', serverName: config.name });
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

const DefaultsPanel = ({ settings, onSettingsChange, onSave, saving, assistants, modelConfigs }) => {
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
              
              <FormGroup label="Function Model" hint="Lightweight model for quick tasks (mini recommended)">
                <Select
                  name="defaultModelId"
                  value={settings.defaultModelId || ""}
                  onChange={onSettingsChange}
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

// ==================== Hotkeys Panel ====================

const HotkeysPanel = ({ settings, onSettingsChange, onSave, saving }) => {
  if (!settings) return null;
  
  return (
    <>
      {/* Title */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <div className="text-base font-semibold text-slate-800">
          Keyboard Shortcuts
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          <Card title="Global Hotkeys" description="Configure global hotkeys for quick access">
            <div className="space-y-4">
              <FormGroup label="Program Hotkey" hint="Show/hide the application">
                <SettingsHotkeyInput
                  name="programHotkey"
                  value={settings.programHotkey || ""}
                  onChange={onSettingsChange}
                />
              </FormGroup>
              
              <FormGroup label="Dialog Hotkey" hint="Open quick dialog anywhere">
                <SettingsHotkeyInput
                  name="dialogHotkey"
                  value={settings.dialogHotkey || ""}
                  onChange={onSettingsChange}
                />
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

// ==================== Sidebar Navigation ====================

const tabGroups = [
  {
    title: 'MANAGE',
    tabs: [
      { id: 'assistants', label: 'Assistants', icon: FaRobot },
      { id: 'api', label: 'API', icon: FaKey },
      { id: 'mcp', label: 'MCP', icon: FaPlug },
    ]
  },
  {
    title: 'SETTINGS',
    tabs: [
      { id: 'defaults', label: 'Defaults', icon: FaGear },
      { id: 'hotkeys', label: 'Hotkeys', icon: FaKeyboard },
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
  const [saving, setSaving] = useState(false);
  
  // 当同步设置加载完成时，初始化本地设置
  useEffect(() => {
    if (!settingsLoading && syncedSettings && Object.keys(syncedSettings).length > 0) {
      setLocalSettings(syncedSettings);
    }
  }, [syncedSettings, settingsLoading]);
  
  // 获取 Assistants 和 ModelConfigs 列表 (用于 ModelsPanel)
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [assistantData, modelData] = await Promise.all([
          bridge.getAssistants(),
          bridge.getModelConfigs()
        ]);
        if (Array.isArray(assistantData)) {
          setAssistants(assistantData);
        }
        if (Array.isArray(modelData)) {
          setModelConfigs(modelData);
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
            bridge.hideManageWindow?.();
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
    bridge.hideManageWindow?.();
  };

  const handleMaximize = () => {
    bridge.maximizeWindow?.('manage');
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
      bridge.updateWindowSizePreset(localSettings.windowSize);
      bridge.updateShortcuts(localSettings.programHotkey, localSettings.dialogHotkey);
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
      case 'mcp': return 'MCP Servers';
      case 'defaults': return 'Defaults';
      case 'hotkeys': return 'Keyboard Shortcuts';
      case 'ui': return 'UI Settings';
      default: return 'Settings';
    }
  };

  return (
    <PageLayout className="bg-white/95">
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
            {activeTab === 'mcp' && <McpServersPanel />}
            {activeTab === 'defaults' && (
              <DefaultsPanel 
                settings={localSettings}
                onSettingsChange={handleSettingsChange}
                onSave={handleSaveSettings}
                saving={saving}
                assistants={assistants}
                modelConfigs={modelConfigs}
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
