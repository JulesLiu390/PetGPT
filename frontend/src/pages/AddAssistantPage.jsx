import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { FaCheck, FaSpinner } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";

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
        const configs = await window.electron?.getModelConfigs();
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

      const newAssistant = await window.electron?.createAssistant(submitData);
      if (!newAssistant || !newAssistant._id) {
        throw new Error("Creation failed or no ID returned");
      }
      
      window.electron?.sendCharacterId(newAssistant._id);
      window.electron?.sendPetsUpdate(newAssistant);
      
      alert("Assistant created successfully!");
      navigate('/selectCharacter');
      
    } catch (error) {
      console.error("Error creating assistant:", error);
      alert("Failed to create assistant: " + error.message);
    }
  };

  if (loading) {
    return (
      <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col items-center justify-center">
        <FaSpinner className="animate-spin text-2xl text-blue-500" />
        <p className="mt-2 text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col overflow-hidden">
      <div className="sticky top-0 z-10">
        {/* Simple TitleBar */}
        <div className="draggable w-full h-12 flex justify-between items-center px-3 border-b border-gray-100">
          <MdCancel 
            className="no-drag hover:text-gray-800 text-gray-400 cursor-pointer"
            onClick={() => navigate('/selectCharacter')}
          />
          <span className="font-bold text-gray-700 text-sm">NEW ASSISTANT</span>
          <div className="w-5"></div>
        </div>
      </div>
      
      <div className="w-[90%] flex-1 mx-auto bg-gray-50 rounded-lg shadow-sm border border-gray-100 p-4 overflow-y-auto mb-4 scrollbar-hide mt-4">
        <form onSubmit={handleSubmit} className="space-y-4 text-sm h-full flex flex-col">
            
            <div className="bg-green-50 p-3 rounded-md border border-green-100 text-green-800 text-xs">
                <strong>Create New Assistant</strong><br/>
                Configure a new AI assistant with a system instruction and link it to a model.
            </div>

            {modelConfigs.length === 0 && (
              <div className="bg-yellow-50 p-3 rounded-md border border-yellow-200 text-yellow-800 text-xs">
                <strong>No Model Configurations Found</strong><br/>
                Please add a model configuration first before creating an assistant.
                <button
                  type="button"
                  onClick={() => navigate('/addCharacter')}
                  className="mt-2 block text-blue-600 hover:underline"
                >
                  → Add Model Configuration
                </button>
              </div>
            )}

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Assistant Name <span className="text-red-500">*</span></label>
                <input
                    name="name"
                    placeholder="e.g. My Helper, Code Assistant..."
                    value={assistantConfig.name}
                    onChange={handleChange}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-green-300 outline-none"
                    required
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Model Configuration</label>
                <select
                    name="selectedModelId"
                    value={assistantConfig.selectedModelId}
                    onChange={handleChange}
                    className="w-full p-2 border rounded"
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
                </select>
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">System Instruction</label>
                <textarea
                    name="systemInstruction"
                    placeholder="Describe how the assistant should behave..."
                    value={assistantConfig.systemInstruction}
                    onChange={handleChange}
                    rows={4}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-green-300 outline-none resize-none"
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Appearance Description (Optional)</label>
                <textarea
                    name="appearance"
                    placeholder="Describe the assistant's appearance for image generation..."
                    value={assistantConfig.appearance}
                    onChange={handleChange}
                    rows={2}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-green-300 outline-none resize-none"
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Avatar Style</label>
                <select
                    name="imageName"
                    value={assistantConfig.imageName}
                    onChange={handleChange}
                    className="w-full p-2 border rounded"
                >
                    <option value="default">Default</option>
                    <option value="Opai">Opai (OpenAI style)</option>
                    <option value="Gemina">Gemina (Gemini style)</option>
                    <option value="Claudia">Claudia (Claude style)</option>
                    <option value="Grocka">Grocka (Grok style)</option>
                </select>
            </div>

            <div className="flex items-center space-x-2">
                <input
                    type="checkbox"
                    id="hasMood"
                    name="hasMood"
                    checked={assistantConfig.hasMood}
                    onChange={handleChange}
                    className="w-4 h-4 text-green-600 rounded focus:ring-green-500"
                />
                <label htmlFor="hasMood" className="text-gray-700 font-medium cursor-pointer">
                    Enable mood expressions
                </label>
                <span className="text-gray-400 text-xs">(Avatar will show emotions)</span>
            </div>

            <div className="mt-auto pt-4">
                <button
                    type="submit"
                    disabled={modelConfigs.length === 0}
                    className={`w-full py-2.5 rounded shadow transition-all transform font-bold ${
                        modelConfigs.length > 0
                        ? "bg-gradient-to-r from-green-500 to-green-700 text-white hover:from-green-600 hover:to-green-800 hover:scale-[1.02]" 
                        : "bg-gray-300 text-gray-500 cursor-not-allowed"
                    }`}
                >
                    Create Assistant
                </button>
            </div>

        </form>
      </div>
    </div>
  );
};

export default AddAssistantPage;
