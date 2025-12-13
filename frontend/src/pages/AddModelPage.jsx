import React, { useState, useEffect } from "react";
import AddModelTitleBar from "../components/Layout/AddModelTitleBar";
import { callOpenAILib, fetchModels } from "../utils/openai";
import { FaCheck, FaSpinner, FaList, FaMagnifyingGlass } from "react-icons/fa6";
import { getPresetsForFormat, getDefaultBaseUrl, findPresetByUrl } from "../utils/llm/presets";

/**
 * 根据 apiFormat 获取默认图片名
 */
const getDefaultImageForFormat = (apiFormat) => {
  const mapping = {
    'openai_compatible': 'Opai',
    'gemini_official': 'Gemina',
  };
  return mapping[apiFormat] || 'default';
};

const AddModelPage = () => {
  const [modelConfig, setModelConfig] = useState({
    configName: "",
    apiFormat: "openai_compatible",
    modelName: "",
    modelApiKey: "",
    modelUrl: "default",
  });

  const [modelUrlType, setModelUrlType] = useState("default");
  const [presetId, setPresetId] = useState("openai"); // 当前选中的 preset
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testSuccess, setTestSuccess] = useState(false);
  
  // New state for model fetching
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState([]);
  const [fetchError, setFetchError] = useState(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  
  // Auto-detect state
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState(null);
  const [includeLocalEndpoints, setIncludeLocalEndpoints] = useState(false);
  
  // Auto-create assistant checkbox
  const [createDefaultAssistant, setCreateDefaultAssistant] = useState(true);

  // 获取当前 apiFormat 的 presets
  const currentPresets = getPresetsForFormat(modelConfig.apiFormat);
  
  // 获取当前显示的 Base URL
  const getDisplayUrl = () => {
    if (modelUrlType === "default") {
      return getDefaultBaseUrl(modelConfig.apiFormat);
    }
    return modelConfig.modelUrl || "";
  };

  // 当 apiFormat 改变时，重置 preset 和 URL
  useEffect(() => {
    const newPresets = getPresetsForFormat(modelConfig.apiFormat);
    const defaultPreset = newPresets[0];
    setPresetId(defaultPreset?.id || "custom");
    
    if (modelUrlType === "default") {
      // default 模式下保持 "default"
    } else {
      // custom 模式下更新为新 apiFormat 的默认 URL
      setModelConfig(prev => ({
        ...prev,
        modelUrl: defaultPreset?.baseUrl || ""
      }));
    }
  }, [modelConfig.apiFormat]);

  const handleChange = (e) => {
    setModelConfig({ ...modelConfig, [e.target.name]: e.target.value });
    setTestSuccess(false);
    setTestResult(null);
  };

  const handleModelUrlTypeChange = (e) => {
    const type = e.target.value;
    setModelUrlType(type);
    
    if (type === "default") {
      setModelConfig({ ...modelConfig, modelUrl: "default" });
    } else {
      // 切到 custom 时，预填当前 preset 的 URL
      const preset = currentPresets.find(p => p.id === presetId);
      const prefilledUrl = preset?.baseUrl || getDefaultBaseUrl(modelConfig.apiFormat);
      setModelConfig({ ...modelConfig, modelUrl: prefilledUrl });
    }
    
    setTestSuccess(false);
    setTestResult(null);
  };

  const handlePresetChange = (e) => {
    const newPresetId = e.target.value;
    setPresetId(newPresetId);
    
    const preset = currentPresets.find(p => p.id === newPresetId);
    if (preset && preset.baseUrl) {
      // 自动切到 custom 模式并填入 URL
      setModelUrlType("custom");
      setModelConfig({ ...modelConfig, modelUrl: preset.baseUrl });
    } else if (newPresetId === "custom") {
      // 选 custom 但保留当前 URL
      setModelUrlType("custom");
    }
    
    setTestSuccess(false);
    setTestResult(null);
  };

  const handleAutoDetect = async () => {
    if (!modelConfig.modelApiKey) {
      alert("Please enter an API Key first.");
      return;
    }
    
    setIsDetecting(true);
    setDetectResult(null);
    
    try {
      const result = await window.electron?.probeOpenAICompatibleEndpoints({
        apiKey: modelConfig.modelApiKey,
        includeLocal: includeLocalEndpoints
      });
      
      if (result?.bestMatch) {
        // 找到了匹配的端点
        setDetectResult({ success: true, message: `Detected: ${result.bestMatch.label}`, url: result.bestMatch.baseUrl });
        
        // 自动填入
        setModelUrlType("custom");
        setModelConfig(prev => ({ ...prev, modelUrl: result.bestMatch.baseUrl }));
        setPresetId(findPresetByUrl(modelConfig.apiFormat, result.bestMatch.baseUrl));
      } else {
        setDetectResult({ success: false, message: "Could not auto-detect endpoint. Please select manually." });
      }
    } catch (error) {
      console.error("Auto-detect failed:", error);
      setDetectResult({ success: false, message: `Detection failed: ${error.message}` });
    } finally {
      setIsDetecting(false);
    }
  };

  const handleFetchModels = async () => {
    if (!modelConfig.modelApiKey) {
        alert("Please enter an API Key first.");
        return;
    }
    
    setIsFetchingModels(true);
    setFetchError(null);
    setFetchedModels([]);

    try {
        const models = await fetchModels(
            modelConfig.apiFormat,
            modelConfig.modelApiKey,
            modelConfig.modelUrl
        );
        
        if (models && Array.isArray(models)) {
            setFetchedModels(models);
            // If only one model, select it? No, let user choose.
            // But we can show a success indicator
        } else {
            throw new Error("Invalid response format");
        }
    } catch (error) {
        console.error("Failed to fetch models:", error);
        setFetchError(error.message || "Failed to fetch models");
    } finally {
        setIsFetchingModels(false);
    }
  };

  const handleTestAPI = async () => {
    setTesting(true);
    setTestResult(null);
    setTestSuccess(false);
    try {
      let messages = [];
      messages.push({ role: "user", content: "Hello" });
      let result = await callOpenAILib(
        messages,
        modelConfig.apiFormat,
        modelConfig.modelApiKey,
        modelConfig.modelName,
        modelConfig.modelUrl
      );
      if (!result || typeof result !== "object" || typeof result.content === "undefined") {
        // Try to parse error message if possible
        let errorMsg = JSON.stringify(result);
        if (result && result.content) errorMsg = result.content;
        
        setTestResult(`Failed: ${errorMsg}`);
        setTestSuccess(false);
      } else {
        setTestResult(`Test Success! Response: ${result.content}`);
        setTestSuccess(true);
      }
    } catch (error) {
      console.error("API request error:", error);
      const message = (error && error.message) || "Unknown error";
      setTestResult(`❌ Test failed: ${message}`);
      setTestSuccess(false);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!testSuccess) {
        alert("Please test the connection successfully before saving.");
        return;
    }

    try {
      // 创建 Model Config (使用新的分离 API)
      const modelData = { 
        name: modelConfig.configName,
        apiFormat: modelConfig.apiFormat,
        modelName: modelConfig.modelName,
        modelApiKey: modelConfig.modelApiKey,
        modelUrl: modelConfig.modelUrl,
      };

      const newModel = await window.electron?.createModelConfig(modelData);
      if (!newModel || !newModel._id) {
        throw new Error("Model creation failed or no ID returned");
      }
      window.electron?.sendPetsUpdate(newModel);
      
      // Auto-create a default assistant if checkbox is checked
      if (createDefaultAssistant) {
        const assistantData = {
          name: `${modelConfig.configName} Assistant`,
          systemInstruction: "You are a helpful assistant.",
          appearance: "",
          imageName: getDefaultImageForFormat(modelConfig.apiFormat),
          modelConfigId: newModel._id, // 关联到刚创建的 Model
          hasMood: true,
        };
        
        const newAssistant = await window.electron?.createAssistant(assistantData);
        if (newAssistant?._id) {
          window.electron?.sendCharacterId(newAssistant._id);
          window.electron?.sendPetsUpdate(newAssistant);
        }
      }
      
      // Reset form
      setModelConfig({
        configName: "",
        apiFormat: "openai_compatible",
        modelName: "",
        modelApiKey: "",
        modelUrl: "default",
      });
      setModelUrlType("default");
      setPresetId("openai");
      setTestResult(null);
      setTestSuccess(false);
      setDetectResult(null);
      setCreateDefaultAssistant(true);
      alert("Model configuration saved successfully!" + (createDefaultAssistant ? " A default assistant was also created." : ""));
      
    } catch (error) {
      console.error("Error creating model config:", error.message);
      alert("Failed to save model configuration.");
    }
  };

  return (
    <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col overflow-hidden">
      <div className="sticky top-0 z-10">
        <AddModelTitleBar />
      </div>
      
      <div className="w-[90%] flex-1 mx-auto bg-gray-50 rounded-lg shadow-sm border border-gray-100 p-4 overflow-y-auto mb-4 scrollbar-hide mt-4">
        <form onSubmit={handleSubmit} className="space-y-4 text-sm h-full flex flex-col">
            
            <div className="bg-blue-50 p-3 rounded-md border border-blue-100 text-blue-800 text-xs">
                <strong>Add Model Configuration</strong><br/>
                Configure a new LLM backend that can be used by your assistants.
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Configuration Name <span className="text-red-500">*</span></label>
                <input
                    name="configName"
                    placeholder="e.g. My GPT-4o, Local Ollama..."
                    value={modelConfig.configName}
                    onChange={handleChange}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-300 outline-none"
                    required
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">API Format</label>
                <select
                    name="apiFormat"
                    value={modelConfig.apiFormat}
                    onChange={handleChange}
                    className="w-full p-2 border rounded"
                >
                    <option value="openai_compatible">OpenAI Compatible (OpenAI / Grok / Ollama / Custom)</option>
                    <option value="gemini_official">Gemini Official (Image/Video/Audio support)</option>
                </select>
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">API Key</label>
                <input
                    name="modelApiKey"
                    type="password"
                    placeholder="sk-..."
                    value={modelConfig.modelApiKey}
                    onChange={handleChange}
                    className="w-full p-2 border rounded"
                />
            </div>

            <div className="flex flex-col space-y-1">
                <div className="flex justify-between items-center">
                    <label className="text-gray-700 font-medium">Base URL</label>
                    {modelConfig.apiFormat === "openai_compatible" && (
                        <button
                            type="button"
                            onClick={handleAutoDetect}
                            disabled={isDetecting || !modelConfig.modelApiKey}
                            className={`text-xs flex items-center gap-1 px-2 py-1 rounded ${
                                !modelConfig.modelApiKey ? "text-gray-400 cursor-not-allowed" : "text-purple-600 hover:bg-purple-50"
                            }`}
                            title="Auto-detect will test your API key against known endpoints"
                        >
                            {isDetecting ? <FaSpinner className="animate-spin"/> : <FaMagnifyingGlass/>}
                            {isDetecting ? "Detecting..." : "Auto-detect"}
                        </button>
                    )}
                </div>
                
                {/* Preset 下拉 */}
                <div className="flex gap-2">
                    <select
                        value={presetId}
                        onChange={handlePresetChange}
                        className="p-2 border rounded flex-1"
                    >
                        {currentPresets.map(preset => (
                            <option key={preset.id} value={preset.id}>
                                {preset.label}
                            </option>
                        ))}
                    </select>
                    <select
                        value={modelUrlType}
                        onChange={handleModelUrlTypeChange}
                        className="p-2 border rounded w-24"
                    >
                        <option value="default">Default</option>
                        <option value="custom">Custom</option>
                    </select>
                </div>
                
                {/* URL 输入框 */}
                <input
                    name="modelUrl"
                    placeholder={getDefaultBaseUrl(modelConfig.apiFormat)}
                    value={getDisplayUrl()}
                    onChange={handleChange}
                    disabled={modelUrlType === "default"}
                    className={`w-full p-2 border rounded ${
                        modelUrlType === "default" ? "bg-gray-100 text-gray-500" : ""
                    }`}
                />
                
                {/* Auto-detect 选项与结果 */}
                {modelConfig.apiFormat === "openai_compatible" && (
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                        <label className="flex items-center gap-1 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={includeLocalEndpoints}
                                onChange={(e) => setIncludeLocalEndpoints(e.target.checked)}
                                className="w-3 h-3"
                            />
                            Include local endpoints (Ollama, LM Studio)
                        </label>
                    </div>
                )}
                
                {detectResult && (
                    <div className={`text-xs mt-1 flex items-center gap-1 ${
                        detectResult.success ? "text-green-600" : "text-orange-500"
                    }`}>
                        {detectResult.success ? <FaCheck className="w-3 h-3"/> : <span>⚠️</span>}
                        {detectResult.message}
                    </div>
                )}
            </div>

            <div className="flex flex-col space-y-1">
                <div className="flex justify-between items-center">
                    <label className="text-gray-700 font-medium">Model Name</label>
                    <button 
                        type="button" 
                        onClick={handleFetchModels} 
                        disabled={isFetchingModels || !modelConfig.modelApiKey}
                        className={`text-xs flex items-center gap-1 px-2 py-1 rounded ${
                            !modelConfig.modelApiKey ? "text-gray-400 cursor-not-allowed" : "text-blue-600 hover:bg-blue-50"
                        }`}
                    >
                        {isFetchingModels ? <FaSpinner className="animate-spin"/> : <FaList/>}
                        {isFetchingModels ? "Fetching..." : "Fetch Models"}
                    </button>
                </div>
                
                {/* Custom Combobox Implementation */}
                <div className="relative">
                    <input
                        name="modelName"
                        placeholder="e.g. gpt-4o (Type or select from fetched list)"
                        value={modelConfig.modelName}
                        onChange={handleChange}
                        onFocus={() => setShowModelDropdown(true)}
                        onBlur={() => setTimeout(() => setShowModelDropdown(false), 200)}
                        className="w-full p-2 border rounded"
                        autoComplete="off"
                    />
                    {showModelDropdown && fetchedModels.length > 0 && (
                        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto mt-1">
                            {fetchedModels
                                .filter(m => m.id.toLowerCase().includes(modelConfig.modelName.toLowerCase()))
                                .map((model) => (
                                <div 
                                    key={model.id} 
                                    className="p-2 hover:bg-blue-50 cursor-pointer text-sm text-gray-700 border-b border-gray-50 last:border-none"
                                    onMouseDown={() => {
                                        setModelConfig({...modelConfig, modelName: model.id});
                                        setShowModelDropdown(false);
                                    }}
                                >
                                    {model.id}
                                </div>
                            ))}
                            {fetchedModels.filter(m => m.id.toLowerCase().includes(modelConfig.modelName.toLowerCase())).length === 0 && (
                                <div className="p-2 text-gray-400 text-xs text-center">No matching models found</div>
                            )}
                        </div>
                    )}
                </div>
                
                {fetchError && (
                    <div className="text-xs text-red-500 mt-1 flex items-center gap-1">
                        <span>⚠️</span> {fetchError}
                    </div>
                )}
                {fetchedModels.length > 0 && !fetchError && (
                    <div className="text-xs text-green-600 mt-1 flex items-center gap-1">
                        <FaCheck className="w-3 h-3"/> Found {fetchedModels.length} models available
                    </div>
                )}
            </div>

            {/* Test Section */}
            <div className="pt-2 border-t border-gray-200">
                <div className="flex justify-between items-center mb-2">
                    <span className="font-bold text-gray-600">Connection Test</span>
                    <button
                        type="button"
                        onClick={handleTestAPI}
                        disabled={testing}
                        className={`px-3 py-1.5 rounded text-xs font-medium ${
                            testing ? "bg-gray-300" : "bg-green-600 text-white hover:bg-green-700"
                        }`}
                    >
                        {testing ? "Testing..." : "Test Connection"}
                    </button>
                </div>
                {testResult && (
                    <div className={`p-3 rounded text-xs whitespace-pre-wrap max-h-24 overflow-y-auto ${
                        testResult.includes("Success") ? "bg-green-50 text-green-800 border border-green-100" : "bg-red-50 text-red-800 border border-red-100"
                    }`}>
                        {testResult}
                    </div>
                )}
            </div>

            <div className="mt-auto pt-4 space-y-3">
                {/* Auto-create assistant checkbox */}
                <label className="flex items-center gap-2 text-gray-700 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={createDefaultAssistant}
                        onChange={(e) => setCreateDefaultAssistant(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-xs">Create a default assistant using this model</span>
                </label>
                
                <button
                    type="submit"
                    disabled={!testSuccess}
                    className={`w-full py-2.5 rounded shadow transition-all transform font-bold ${
                        testSuccess 
                        ? "bg-gradient-to-r from-blue-500 to-blue-700 text-white hover:from-blue-600 hover:to-blue-800 hover:scale-[1.02]" 
                        : "bg-gray-300 text-gray-500 cursor-not-allowed"
                    }`}
                >
                    Save Model Configuration
                </button>
            </div>

        </form>
      </div>
    </div>
  );
};

export default AddModelPage;