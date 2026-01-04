import React, { useState, useEffect } from "react";
import AddModelTitleBar from "../components/Layout/AddModelTitleBar";
import { callOpenAILib, fetchModels } from "../utils/openai";
import { FaCheck, FaSpinner, FaList, FaMagnifyingGlass } from "react-icons/fa6";
import { getPresetsForFormat, getDefaultBaseUrl, findPresetByUrl } from "../utils/llm/presets";
import { PageLayout, Surface, Card, FormGroup, Input, Select, Button, Alert, Checkbox, Badge } from "../components/UI/ui";
import * as bridge from "../utils/bridge";

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
    searchMode: "native",
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

  // Capabilities probing state
  const [isProbingCaps, setIsProbingCaps] = useState(false);
  const [capsError, setCapsError] = useState(null);
  const [capabilities, setCapabilities] = useState(null);

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
      const result = await bridge.probeOpenAICompatibleEndpoints({
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

  const handleProbeCapabilities = async () => {
    if (!testSuccess) {
      alert("Please test the connection successfully first.");
      return;
    }

    setIsProbingCaps(true);
    setCapsError(null);
    setCapabilities(null);

    try {
      const result = await bridge.probeModelCapabilities({
        apiFormat: modelConfig.apiFormat,
        apiKey: modelConfig.modelApiKey,
        modelName: modelConfig.modelName,
        baseUrl: modelConfig.modelUrl,
      });

      if (result) {
        setCapabilities(result);
      } else {
        setCapsError("Could not detect capabilities.");
      }
    } catch (error) {
      console.error("Capabilities probe failed:", error);
      setCapsError(error.message || "Failed to detect capabilities.");
    } finally {
      setIsProbingCaps(false);
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
      // 如果没有填写 configName，则使用 modelName 作为默认名称
      const displayName = modelConfig.configName.trim() || modelConfig.modelName;
      const modelData = { 
        name: displayName,
        apiFormat: modelConfig.apiFormat,
        modelName: modelConfig.modelName,
        modelApiKey: modelConfig.modelApiKey,
        modelUrl: modelConfig.modelUrl,
      };

      const newModel = await bridge.createModelConfig(modelData);
      if (!newModel || !newModel._id) {
        throw new Error("Model creation failed or no ID returned");
      }
      bridge.sendPetsUpdate(newModel);
      
      // Auto-create a default assistant if checkbox is checked
      if (createDefaultAssistant) {
        const assistantData = {
          name: `${displayName} Assistant`,
          systemInstruction: "You are a helpful assistant.",
          appearance: "",
          imageName: getDefaultImageForFormat(modelConfig.apiFormat),
          modelConfigId: newModel._id, // 关联到刚创建的 Model
          hasMood: true,
        };
        
        const newAssistant = await bridge.createAssistant(assistantData);
        if (newAssistant?._id) {
          bridge.sendCharacterId(newAssistant._id);
          bridge.sendPetsUpdate(newAssistant);
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
    <PageLayout className="bg-white/95">
      <div className="h-screen flex flex-col overflow-hidden">
        <AddModelTitleBar />
        
        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
          <Surface className="max-w-lg mx-auto p-5">
            <form onSubmit={handleSubmit} className="space-y-5">
              
              <Alert tone="blue">
                <strong>Add Model Configuration</strong><br/>
                Configure a new LLM backend that can be used by your assistants.
              </Alert>

              <FormGroup label="API Format">
                <Select
                  name="apiFormat"
                  value={modelConfig.apiFormat}
                  onChange={handleChange}
                >
                  <option value="openai_compatible">OpenAI Compatible (OpenAI / Grok / Ollama / Custom)</option>
                  <option value="gemini_official">Gemini Official (Image/Video/Audio support)</option>
                </Select>
              </FormGroup>

              <FormGroup label="API Key">
                <Input
                  name="modelApiKey"
                  type="password"
                  placeholder="sk-..."
                  value={modelConfig.modelApiKey}
                  onChange={handleChange}
                />
              </FormGroup>

              <Card title="Search" action={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleProbeCapabilities}
                  disabled={isProbingCaps || !testSuccess}
                  className="text-xs"
                  title={!testSuccess ? "Please test connection first" : "Detect native search capability"}
                >
                  {isProbingCaps ? <FaSpinner className="animate-spin w-3 h-3"/> : <FaMagnifyingGlass className="w-3 h-3"/>}
                  {isProbingCaps ? "Detecting..." : "Detect"}
                </Button>
              } className="bg-slate-50/50">
                <FormGroup label="Search Mode" hint="This switch controls native-search vs injected-search, not whether search exists.">
                  <Select
                    name="searchMode"
                    value={modelConfig.searchMode}
                    onChange={handleChange}
                  >
                    <option value="native">Native (provider web search / grounding)</option>
                    <option value="inject">Injected (DuckDuckGo)</option>
                    <option value="off">Off</option>
                  </Select>
                </FormGroup>

                {capsError && (
                  <div className="mt-2 text-xs text-rose-600 flex items-center gap-1">
                    <span>⚠️</span> {capsError}
                  </div>
                )}

                {capabilities?.nativeSearch && (
                  <div className="mt-2 text-xs text-slate-600">
                    <div className="flex items-center gap-2">
                      <Badge tone={capabilities.nativeSearch.supported === true ? 'green' : (capabilities.nativeSearch.supported === false ? 'red' : 'slate')}>
                        Native search: {capabilities.nativeSearch.supported === true ? 'Supported' : (capabilities.nativeSearch.supported === false ? 'Not supported' : 'Unknown')}
                      </Badge>
                      {capabilities.nativeSearch.reason ? (
                        <span className="text-slate-500">{capabilities.nativeSearch.reason}</span>
                      ) : null}
                    </div>
                  </div>
                )}

                {modelConfig.searchMode === 'native' && capabilities?.nativeSearch?.supported !== true && (
                  <div className="mt-2 text-xs text-amber-600 flex items-center gap-1">
                    <span>⚠️</span> Native search is not confirmed; app will fall back to injected search (DuckDuckGo).
                  </div>
                )}
              </Card>

              <FormGroup label="Base URL">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex gap-2 flex-1">
                    <Select
                      value={presetId}
                      onChange={handlePresetChange}
                      className="flex-1"
                    >
                      {currentPresets.map(preset => (
                        <option key={preset.id} value={preset.id}>{preset.label}</option>
                      ))}
                    </Select>
                    <Select
                      value={modelUrlType}
                      onChange={handleModelUrlTypeChange}
                      className="w-28"
                    >
                      <option value="default">Default</option>
                      <option value="custom">Custom</option>
                    </Select>
                  </div>
                  {modelConfig.apiFormat === "openai_compatible" && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleAutoDetect}
                      disabled={isDetecting || !modelConfig.modelApiKey}
                      className="ml-2 text-xs"
                    >
                      {isDetecting ? <FaSpinner className="animate-spin w-3 h-3"/> : <FaMagnifyingGlass className="w-3 h-3"/>}
                      {isDetecting ? "Detecting..." : "Auto-detect"}
                    </Button>
                  )}
                </div>
                
                <Input
                  name="modelUrl"
                  placeholder={getDefaultBaseUrl(modelConfig.apiFormat)}
                  value={getDisplayUrl()}
                  onChange={handleChange}
                  disabled={modelUrlType === "default"}
                  className={modelUrlType === "default" ? "bg-slate-50 text-slate-500" : ""}
                />
                
                {modelConfig.apiFormat === "openai_compatible" && (
                  <div className="mt-2">
                    <Checkbox
                      label="Include local endpoints (Ollama, LM Studio)"
                      checked={includeLocalEndpoints}
                      onChange={(e) => setIncludeLocalEndpoints(e.target.checked)}
                    />
                  </div>
                )}
                
                {detectResult && (
                  <div className={`mt-2 flex items-center gap-1.5 text-xs ${detectResult.success ? "text-emerald-600" : "text-amber-600"}`}>
                    {detectResult.success ? <FaCheck className="w-3 h-3"/> : <span>⚠️</span>}
                    {detectResult.message}
                  </div>
                )}
              </FormGroup>

              <FormGroup label="Model Name">
                <div className="flex items-center justify-between mb-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleFetchModels}
                    disabled={isFetchingModels || !modelConfig.modelApiKey}
                    className="text-xs"
                  >
                    {isFetchingModels ? <FaSpinner className="animate-spin w-3 h-3"/> : <FaList className="w-3 h-3"/>}
                    {isFetchingModels ? "Fetching..." : "Fetch Models"}
                  </Button>
                </div>
                
                <div className="relative">
                  <Input
                    name="modelName"
                    placeholder="e.g. gpt-4o (Type or select from fetched list)"
                    value={modelConfig.modelName}
                    onChange={handleChange}
                    onFocus={() => setShowModelDropdown(true)}
                    onBlur={() => setTimeout(() => setShowModelDropdown(false), 200)}
                    autoComplete="off"
                  />
                  {showModelDropdown && fetchedModels.length > 0 && (
                    <div className="absolute z-50 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-y-auto mt-1">
                      {fetchedModels
                        .filter(m => m.id.toLowerCase().includes(modelConfig.modelName.toLowerCase()))
                        .map((model) => (
                          <div 
                            key={model.id} 
                            className="px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm text-slate-700 border-b border-slate-50 last:border-none"
                            onMouseDown={() => {
                              setModelConfig({...modelConfig, modelName: model.id});
                              setShowModelDropdown(false);
                            }}
                          >
                            {model.id}
                          </div>
                        ))}
                      {fetchedModels.filter(m => m.id.toLowerCase().includes(modelConfig.modelName.toLowerCase())).length === 0 && (
                        <div className="p-3 text-slate-400 text-xs text-center">No matching models found</div>
                      )}
                    </div>
                  )}
                </div>
                
                {fetchError && (
                  <div className="mt-2 text-xs text-rose-600 flex items-center gap-1">
                    <span>⚠️</span> {fetchError}
                  </div>
                )}
                {fetchedModels.length > 0 && !fetchError && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600">
                    <FaCheck className="w-3 h-3"/> Found {fetchedModels.length} models available
                  </div>
                )}
              </FormGroup>

              <FormGroup label="Configuration Name" hint="Optional. Used to identify this configuration. Defaults to Model Name if not provided.">
                <Input
                  name="configName"
                  placeholder="e.g. My GPT-4 Config (optional)"
                  value={modelConfig.configName}
                  onChange={handleChange}
                />
              </FormGroup>

              {/* Test Section */}
              <Card title="Connection Test" action={
                <Button
                  type="button"
                  variant={testSuccess ? "subtle" : "primary"}
                  onClick={handleTestAPI}
                  disabled={testing}
                  className="text-xs"
                >
                  {testing ? "Testing..." : "Test Connection"}
                </Button>
              } className="bg-slate-50/50">
                {testResult ? (
                  <Alert tone={testSuccess ? "green" : "red"}>
                    {testResult}
                  </Alert>
                ) : (
                  <div className="text-xs text-slate-500 text-center py-2">
                    Test your connection before saving
                  </div>
                )}
              </Card>

              <div className="pt-2 space-y-3">
                <Checkbox
                  label="Create a default assistant using this model"
                  checked={createDefaultAssistant}
                  onChange={(e) => setCreateDefaultAssistant(e.target.checked)}
                />
                
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!testSuccess}
                  className="w-full py-3"
                >
                  Save Model Configuration
                </Button>
              </div>

            </form>
          </Surface>
        </div>
      </div>
    </PageLayout>
  );
};

export default AddModelPage;