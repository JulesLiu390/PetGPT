import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FaCheck, FaSpinner, FaPlus } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";
import { PageLayout, Surface, Card, FormGroup, Input, Select, Textarea, Button, Alert, Checkbox, Badge } from "../components/UI/ui";
import TitleBar from "../components/UI/TitleBar";
import * as bridge from "../utils/bridge";

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

const EditAssistantPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const petId = searchParams.get('id');
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiProviders, setApiProviders] = useState([]); // 可用的 API Providers
  const [selectedProviderId, setSelectedProviderId] = useState(""); // 选中的 Provider
  const [availableModels, setAvailableModels] = useState([]); // 选中 Provider 的可用模型
  
  const [assistantConfig, setAssistantConfig] = useState({
    name: "",
    systemInstruction: "",
    appearance: "",
    imageName: "default",
    hasMood: true,
    // 直接存储模型配置（从 API Provider 复制）
    modelName: "",
    modelUrl: "",
    modelApiKey: "",
    apiFormat: "",
  });

  // 加载现有 Assistant 数据
  useEffect(() => {
    const loadData = async () => {
      if (!petId) {
        alert("No assistant ID provided");
        navigate('/manage?tab=assistants');
        return;
      }
      
      try {
        // 加载所有 API Providers
        const providers = await bridge.apiProviders.getAll();
        if (Array.isArray(providers)) {
          setApiProviders(providers);
        }

        // 加载当前 assistant
        const assistant = await bridge.getAssistant(petId);
        if (assistant) {
          // hasMood 向后兼容
          const computedHasMood = typeof assistant.hasMood === 'boolean' ? assistant.hasMood : true;
          setAssistantConfig({
            name: assistant.name || "",
            systemInstruction: assistant.systemInstruction || "",
            appearance: assistant.appearance || "",
            imageName: assistant.imageName || "default",
            hasMood: computedHasMood,
            // 直接从 assistant 加载模型配置
            modelName: assistant.modelName || "",
            modelUrl: assistant.modelUrl || "",
            modelApiKey: assistant.modelApiKey || "",
            apiFormat: assistant.apiFormat || "",
          });
          
          // 尝试匹配 API Provider（根据 modelUrl 和 modelApiKey）
          if (providers && assistant.modelUrl && assistant.modelApiKey) {
            const matchedProvider = providers.find(p => 
              p.baseUrl === assistant.modelUrl && 
              p.apiKey === assistant.modelApiKey
            );
            if (matchedProvider) {
              setSelectedProviderId(matchedProvider.id);
              // 解析 available_models
              const models = matchedProvider.cachedModels 
                ? (typeof matchedProvider.cachedModels === 'string' 
                    ? JSON.parse(matchedProvider.cachedModels) 
                    : matchedProvider.cachedModels)
                : [];
              setAvailableModels(models);
            }
          }
        } else {
          alert("Assistant not found");
          navigate('/manage?tab=assistants');
        }
      } catch (error) {
        console.error("Failed to load assistant:", error);
        alert("Failed to load assistant: " + error.message);
        navigate('/manage?tab=assistants');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [petId, navigate]);

  // 当选择的 Provider 改变时，更新可用模型列表
  const handleProviderChange = (providerId) => {
    setSelectedProviderId(providerId);
    
    if (!providerId) {
      setAvailableModels([]);
      setAssistantConfig(prev => ({
        ...prev,
        modelName: "",
        modelUrl: "",
        modelApiKey: "",
        apiFormat: "",
      }));
      return;
    }
    
    const provider = apiProviders.find(p => p.id === providerId);
    if (provider) {
      // 解析 available_models JSON
      const models = provider.cachedModels 
        ? (typeof provider.cachedModels === 'string' 
            ? JSON.parse(provider.cachedModels) 
            : provider.cachedModels)
        : [];
      setAvailableModels(models);
      
      // 更新 assistant 配置（复制 Provider 的基础设置）
      setAssistantConfig(prev => ({
        ...prev,
        modelUrl: provider.baseUrl || "",
        modelApiKey: provider.apiKey || "",
        apiFormat: provider.apiFormat || "",
        modelName: "", // 清空模型名，让用户选择
        imageName: getDefaultImageForApi(provider.apiFormat),
      }));
    }
  };

  // 当选择模型时
  const handleModelChange = (modelName) => {
    setAssistantConfig(prev => ({
      ...prev,
      modelName: modelName,
    }));
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    
    if (type === 'checkbox') {
      setAssistantConfig(prev => ({ ...prev, [name]: checked }));
      return;
    }
    
    setAssistantConfig(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!assistantConfig.name.trim()) {
      alert("Please enter an assistant name.");
      return;
    }

    if (!assistantConfig.modelName || !assistantConfig.modelUrl || !assistantConfig.apiFormat) {
      alert("Please select an API Provider and Model.");
      return;
    }

    setSaving(true);
    try {
      const updateData = {
        name: assistantConfig.name,
        systemInstruction: assistantConfig.systemInstruction,
        appearance: assistantConfig.appearance,
        imageName: assistantConfig.imageName,
        hasMood: assistantConfig.hasMood,
        // 直接存储模型配置到 pets 表
        modelName: assistantConfig.modelName,
        modelUrl: assistantConfig.modelUrl,
        modelApiKey: assistantConfig.modelApiKey,
        apiFormat: assistantConfig.apiFormat,
      };

      const updatedAssistant = await bridge.updateAssistant(petId, updateData);
      
      // 通知所有组件更新列表
      bridge.sendPetsUpdate(updatedAssistant);
      
      // 重新发送 characterId 以刷新当前选中角色的内存数据
      bridge.sendCharacterId(petId);
      
      alert("Assistant updated successfully!");
      navigate('/manage?tab=assistants');
      
    } catch (error) {
      console.error("Error updating assistant:", error);
      alert("Failed to update assistant: " + error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageLayout className="bg-white/95">
        <div className="h-screen flex flex-col items-center justify-center">
          <FaSpinner className="animate-spin text-2xl text-blue-500" />
          <p className="mt-2 text-slate-600 text-sm">Loading...</p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout className="bg-white/95">
      <div className="h-screen flex flex-col overflow-hidden">
        <div className="shrink-0">
          <TitleBar
            title="Edit Assistant"
            left={
              <button
                type="button"
                className="no-drag inline-flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                onClick={() => navigate('/manage?tab=assistants')}
                title="Close"
              >
                <MdCancel className="w-5 h-5" />
              </button>
            }
            height="h-12"
          />
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
          <Surface className="max-w-lg mx-auto p-5">
            <form onSubmit={handleSubmit} className="space-y-5">
              
              <Alert tone="blue">
                <strong>Edit Assistant</strong><br/>
                Update your assistant's settings and system instruction.
              </Alert>

              <FormGroup label="Assistant Name" required>
                <Input
                  name="name"
                  placeholder="e.g. My Helper, Code Assistant..."
                  value={assistantConfig.name}
                  onChange={handleChange}
                  required
                />
              </FormGroup>

              <FormGroup label="System Instruction">
                <Textarea
                  name="systemInstruction"
                  placeholder="Describe how the assistant should behave..."
                  value={assistantConfig.systemInstruction}
                  onChange={handleChange}
                  rows={4}
                />
              </FormGroup>

              <FormGroup label="Appearance Description" hint="Optional - for image generation">
                <Textarea
                  name="appearance"
                  placeholder="Describe the assistant's appearance..."
                  value={assistantConfig.appearance}
                  onChange={handleChange}
                  rows={2}
                />
              </FormGroup>

              <FormGroup label="Avatar Style">
                <Select
                  name="imageName"
                  value={assistantConfig.imageName}
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
                label="Enable mood expressions (Avatar will show emotions)"
                checked={assistantConfig.hasMood}
                onChange={handleChange}
              />

              {/* API Provider & Model Selection */}
              <Card title="API Configuration" description="Select the API provider and model for this assistant" className="bg-slate-50/50">
                <div className="space-y-4">
                  {/* API Provider 选择 */}
                  <FormGroup label="API Provider" required>
                    <div className="flex gap-2">
                      <Select
                        value={selectedProviderId}
                        onChange={(e) => handleProviderChange(e.target.value)}
                        className="flex-1"
                      >
                        <option value="">-- Select API Provider --</option>
                        {apiProviders.map(provider => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name} ({provider.apiFormat})
                          </option>
                        ))}
                      </Select>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => navigate('/manage?tab=api')}
                        className="shrink-0"
                        title="Manage API Providers"
                      >
                        <FaPlus className="w-4 h-4" />
                      </Button>
                    </div>
                  </FormGroup>

                  {/* Model 选择 */}
                  <FormGroup label="Model" required>
                    <Select
                      value={assistantConfig.modelName}
                      onChange={(e) => handleModelChange(e.target.value)}
                      disabled={!selectedProviderId}
                    >
                      <option value="">-- Select Model --</option>
                      {availableModels.map(model => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </Select>
                    {availableModels.length === 0 && selectedProviderId && (
                      <div className="mt-2 text-xs text-amber-600">
                        No models available. Add models in API Provider settings.
                      </div>
                    )}
                  </FormGroup>

                  {/* 当前配置显示 */}
                  {assistantConfig.modelName && (
                    <div className="flex items-center gap-2 text-xs text-slate-500 pt-1">
                      <Badge tone="blue">{assistantConfig.apiFormat}</Badge>
                      <span>{assistantConfig.modelName}</span>
                    </div>
                  )}
                </div>
              </Card>

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
                  ) : "Save Changes"}
                </Button>
              </div>

            </form>
          </Surface>
        </div>
      </div>
    </PageLayout>
  );
};

export default EditAssistantPage;
