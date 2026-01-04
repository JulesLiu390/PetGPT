import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { FaCheck, FaSpinner } from "react-icons/fa6";
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
    // 兼容旧值
    'openai': 'Opai',
    'gemini': 'Gemina',
    'grok': 'Grocka',
    'anthropic': 'Claudia',
  };
  return mapping[apiFormat] || 'default';
};

const AddAssistantPage = () => {
  const navigate = useNavigate();
  const [modelConfigs, setModelConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [assistantConfig, setAssistantConfig] = useState({
    name: "",
    systemInstruction: "You are a helpful assistant.",
    appearance: "",
    selectedModelId: "",
    imageName: "default",
    hasMood: true, // 是否启用情绪表情
  });

  // 加载可用的 Model Configurations
  useEffect(() => {
    const loadModelConfigs = async () => {
      try {
        // 使用新的 API 获取 Model Configs
        const configs = await bridge.getModelConfigs();
        if (Array.isArray(configs)) {
          setModelConfigs(configs);
          
          // 如果有配置，默认选第一个
          if (configs.length > 0) {
            setAssistantConfig(prev => ({
              ...prev,
              selectedModelId: configs[0]._id,
              imageName: getDefaultImageForApi(configs[0].apiFormat)
            }));
          }
        }
      } catch (error) {
        console.error("Failed to load model configs:", error);
      } finally {
        setLoading(false);
      }
    };
    loadModelConfigs();
  }, []);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    
    // 处理 checkbox
    if (type === 'checkbox') {
      setAssistantConfig(prev => ({ ...prev, [name]: checked }));
      return;
    }
    
    setAssistantConfig(prev => ({ ...prev, [name]: value }));
    
    // 如果切换了 Model，更新默认图片
    if (name === 'selectedModelId') {
      const selectedModel = modelConfigs.find(m => m._id === value);
      if (selectedModel) {
        setAssistantConfig(prev => ({
          ...prev,
          [name]: value,
          imageName: getDefaultImageForApi(selectedModel.apiFormat)
        }));
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!assistantConfig.name.trim()) {
      alert("Please enter an assistant name.");
      return;
    }
    
    if (!assistantConfig.selectedModelId) {
      alert("Please select a model configuration. Create one first if you haven't.");
      return;
    }

    try {
      // 获取选中的 Model 配置
      const selectedModel = modelConfigs.find(m => m._id === assistantConfig.selectedModelId);
      if (!selectedModel) {
        alert("Selected model not found.");
        return;
      }

      // 创建 Assistant（使用新的 API，关联 Model Config）
      const submitData = {
        name: assistantConfig.name,
        systemInstruction: assistantConfig.systemInstruction,
        appearance: assistantConfig.appearance,
        imageName: assistantConfig.imageName,
        modelConfigId: assistantConfig.selectedModelId, // 关联到 Model Config
        hasMood: assistantConfig.hasMood,
      };

      const newAssistant = await bridge.createAssistant(submitData);
      if (!newAssistant || !newAssistant._id) {
        throw new Error("Creation failed or no ID returned");
      }
      
      bridge.sendCharacterId(newAssistant._id);
      bridge.sendPetsUpdate(newAssistant);
      
      alert("Assistant created successfully!");
      navigate('/selectCharacter');
      
    } catch (error) {
      console.error("Error creating assistant:", error);
      alert("Failed to create assistant: " + error.message);
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
            title="New Assistant"
            left={
              <button
                type="button"
                className="no-drag inline-flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                onClick={() => navigate('/selectCharacter')}
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
                <strong>Create New Assistant</strong><br/>
                Configure a new AI assistant with a system instruction and link it to a model.
              </Alert>

              {modelConfigs.length === 0 && (
                <Alert tone="yellow">
                  <strong>No Model Configurations Found</strong><br/>
                  Please add a model configuration first before creating an assistant.
                  <button
                    type="button"
                    onClick={() => navigate('/addCharacter')}
                    className="mt-2 block text-blue-600 hover:underline font-medium"
                  >
                    → Add Model Configuration
                  </button>
                </Alert>
              )}

              <FormGroup label="Assistant Name" required>
                <Input
                  name="name"
                  placeholder="e.g. My Helper, Code Assistant..."
                  value={assistantConfig.name}
                  onChange={handleChange}
                  required
                />
              </FormGroup>

              <Card title="Model Configuration" description="Select the LLM backend for this assistant" className="bg-slate-50/50">
                <Select
                  name="selectedModelId"
                  value={assistantConfig.selectedModelId}
                  onChange={handleChange}
                  disabled={modelConfigs.length === 0}
                >
                  {modelConfigs.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    modelConfigs.map(config => (
                      <option key={config._id} value={config._id}>
                        {config.name} ({config.modelName})
                      </option>
                    ))
                  )}
                </Select>
                {modelConfigs.length > 0 && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                    <Badge tone="blue">
                      {modelConfigs.find(m => m._id === assistantConfig.selectedModelId)?.apiFormat || 'Unknown'}
                    </Badge>
                    <span>will power this assistant</span>
                  </div>
                )}
              </Card>

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

              <div className="pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={modelConfigs.length === 0}
                  className="w-full py-3"
                >
                  Create Assistant
                </Button>
              </div>

            </form>
          </Surface>
        </div>
      </div>
    </PageLayout>
  );
};

export default AddAssistantPage;
