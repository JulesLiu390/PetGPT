import React, { useState } from "react";
import AddModelTitleBar from "../components/Layout/AddModelTitleBar";
import { callOpenAILib, fetchModels } from "../utils/openai";
import { FaCheck, FaSpinner, FaList } from "react-icons/fa6";

const AddModelPage = () => {
  const [modelConfig, setModelConfig] = useState({
    configName: "",
    modelProvider: "openai",
    modelName: "",
    modelApiKey: "",
    modelUrl: "default",
  });

  const [modelUrlType, setModelUrlType] = useState("default");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testSuccess, setTestSuccess] = useState(false);
  
  // New state for model fetching
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState([]);
  const [fetchError, setFetchError] = useState(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  const handleChange = (e) => {
    setModelConfig({ ...modelConfig, [e.target.name]: e.target.value });
    setTestSuccess(false);
    setTestResult(null);
  };

  const handleModelUrlTypeChange = (e) => {
    const type = e.target.value;
    setModelUrlType(type);
    setModelConfig({ ...modelConfig, modelUrl: type === "default" ? "default" : "" });
    setTestSuccess(false);
    setTestResult(null);
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
            modelConfig.modelProvider,
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
        modelConfig.modelProvider,
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
      // Adapting to existing backend: Create a "Pet" that acts as a Model Config
      const submitData = { 
        name: modelConfig.configName, // Use config name as pet name
        personality: "default",
        imageName: "default",
        modelProvider: modelConfig.modelProvider,
        modelName: modelConfig.modelName,
        modelApiKey: modelConfig.modelApiKey,
        modelUrl: modelConfig.modelUrl,
        isAgent: false, // Default to false for models
      };

      const newPet = await window.electron?.createPet(submitData);
      if (!newPet || !newPet._id) {
        throw new Error("Creation failed or no ID returned");
      }
      window.electron?.sendCharacterId(newPet._id);
      window.electron?.sendPetsUpdate(newPet);
      
      // Reset form
      setModelConfig({
        configName: "",
        modelProvider: "openai",
        modelName: "",
        modelApiKey: "",
        modelUrl: "default",
      });
      setModelUrlType("default");
      setTestResult(null);
      setTestSuccess(false);
      alert("Model configuration saved successfully!");
      
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
                Configure a new LLM backend that can be used by your characters.
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
                <label className="text-gray-700 font-medium">Provider</label>
                <select
                    name="modelProvider"
                    value={modelConfig.modelProvider}
                    onChange={handleChange}
                    className="w-full p-2 border rounded"
                >
                    <option value="openai">OpenAI</option>
                    <option value="openai-compatible">OpenAI Compatible (Universal)</option>
                    <option value="gemini">Gemini</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="grok">Grok</option>
                    <option value="ollama">Ollama</option>
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
                <label className="text-gray-700 font-medium">Base URL</label>
                <div className="flex gap-2">
                    <select
                        value={modelUrlType}
                        onChange={handleModelUrlTypeChange}
                        className="p-2 border rounded w-24"
                    >
                        <option value="default">Default</option>
                        <option value="custom">Custom</option>
                    </select>
                    <input
                        name="modelUrl"
                        placeholder="https://api.openai.com/v1"
                        value={modelConfig.modelUrl}
                        onChange={handleChange}
                        disabled={modelUrlType === "default"}
                        className={`flex-1 p-2 border rounded ${
                            modelUrlType === "default" ? "bg-gray-100 text-gray-400" : ""
                        }`}
                    />
                </div>
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

            <div className="mt-auto pt-4">
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