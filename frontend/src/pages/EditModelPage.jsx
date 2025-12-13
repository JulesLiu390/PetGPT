import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FaSpinner } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";
import { callOpenAILib } from '../utils/openai';

const EditModelPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const modelId = searchParams.get('id');
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testSuccess, setTestSuccess] = useState(false);
  
  const [modelConfig, setModelConfig] = useState({
    name: "",
    apiFormat: "openai_compatible",
    modelName: "",
    modelApiKey: "",
    modelUrl: "default",
  });
  const [modelUrlType, setModelUrlType] = useState("default");

  // 加载现有 Model 数据
  useEffect(() => {
    const loadModel = async () => {
      if (!modelId) {
        alert("No model ID provided");
        navigate('/selectCharacter');
        return;
      }
      
      try {
        const model = await window.electron?.getModelConfig(modelId);
        if (model) {
          setModelConfig({
            name: model.name || "",
            apiFormat: model.apiFormat || "openai_compatible",
            modelName: model.modelName || "",
            modelApiKey: model.modelApiKey || "",
            modelUrl: model.modelUrl || "default",
          });
          setModelUrlType(model.modelUrl === "default" ? "default" : "custom");
        } else {
          alert("Model not found");
          navigate('/selectCharacter');
        }
      } catch (error) {
        console.error("Failed to load model:", error);
        alert("Failed to load model: " + error.message);
        navigate('/selectCharacter');
      } finally {
        setLoading(false);
      }
    };
    loadModel();
  }, [modelId, navigate]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setModelConfig(prev => ({ ...prev, [name]: value }));
    // 重置测试状态
    setTestResult(null);
    setTestSuccess(false);
  };

  const handleUrlTypeChange = (e) => {
    const type = e.target.value;
    setModelUrlType(type);
    if (type === "default") {
      setModelConfig(prev => ({ ...prev, modelUrl: "default" }));
    } else {
      setModelConfig(prev => ({ ...prev, modelUrl: "" }));
    }
    setTestResult(null);
    setTestSuccess(false);
  };

  const handleTestAPI = async () => {
    setTesting(true);
    setTestResult(null);
    setTestSuccess(false);
    try {
      let messages = [{ role: "user", content: "Hello" }];
      let result = await callOpenAILib(
        messages,
        modelConfig.apiFormat,
        modelConfig.modelApiKey,
        modelConfig.modelName,
        modelConfig.modelUrl
      );
      if (!result || typeof result !== "object" || typeof result.content === "undefined") {
        setTestResult(`Failed: ${JSON.stringify(result)}`);
        setTestSuccess(false);
      } else {
        setTestResult(`✅ Test Success! Response: ${result.content.substring(0, 100)}...`);
        setTestSuccess(true);
      }
    } catch (error) {
      console.error("API request error:", error);
      setTestResult(`❌ Test failed: ${error.message || "Unknown error"}`);
      setTestSuccess(false);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!modelConfig.name.trim()) {
      alert("Please enter a model name.");
      return;
    }

    setSaving(true);
    try {
      const updateData = {
        name: modelConfig.name,
        apiFormat: modelConfig.apiFormat,
        modelName: modelConfig.modelName,
        modelApiKey: modelConfig.modelApiKey,
        modelUrl: modelConfig.modelUrl,
      };

      await window.electron?.updateModelConfig(modelId, updateData);
      window.electron?.sendPetsUpdate();
      
      alert("Model configuration updated successfully!");
      navigate('/selectCharacter');
      
    } catch (error) {
      console.error("Error updating model:", error);
      alert("Failed to update model: " + error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col items-center justify-center">
        <FaSpinner className="animate-spin text-2xl text-purple-500" />
        <p className="mt-2 text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col overflow-hidden">
      <div className="sticky top-0 z-10">
        <div className="draggable w-full h-12 flex justify-between items-center px-3 border-b border-gray-100">
          <MdCancel 
            className="no-drag hover:text-gray-800 text-gray-400 cursor-pointer"
            onClick={() => navigate('/selectCharacter')}
          />
          <span className="font-bold text-gray-700 text-sm">EDIT MODEL</span>
          <div className="w-5"></div>
        </div>
      </div>
      
      <div className="w-[90%] flex-1 mx-auto bg-gray-50 rounded-lg shadow-sm border border-gray-100 p-4 overflow-y-auto mb-4 scrollbar-hide mt-4">
        <form onSubmit={handleSubmit} className="space-y-4 text-sm h-full flex flex-col">
            
            <div className="bg-purple-50 p-3 rounded-md border border-purple-100 text-purple-800 text-xs">
                <strong>Edit Model Configuration</strong><br/>
                Update your LLM backend settings.
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Config Name <span className="text-red-500">*</span></label>
                <input
                    name="name"
                    placeholder="e.g. My GPT-4, Local Ollama..."
                    value={modelConfig.name}
                    onChange={handleChange}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-purple-300 outline-none"
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
                    <option value="openai_compatible">OpenAI Compatible</option>
                    <option value="gemini_official">Gemini Official</option>
                </select>
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Model Name</label>
                <input
                    name="modelName"
                    placeholder="e.g. gpt-4o, gemini-pro..."
                    value={modelConfig.modelName}
                    onChange={handleChange}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-purple-300 outline-none"
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">API Key</label>
                <input
                    name="modelApiKey"
                    type="password"
                    placeholder="sk-..."
                    value={modelConfig.modelApiKey}
                    onChange={handleChange}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-purple-300 outline-none"
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">API URL</label>
                <select
                    value={modelUrlType}
                    onChange={handleUrlTypeChange}
                    className="w-full p-2 border rounded mb-2"
                >
                    <option value="default">Default (based on API format)</option>
                    <option value="custom">Custom URL</option>
                </select>
                {modelUrlType === "custom" && (
                    <input
                        name="modelUrl"
                        placeholder="https://your-api-endpoint.com"
                        value={modelConfig.modelUrl === "default" ? "" : modelConfig.modelUrl}
                        onChange={handleChange}
                        className="w-full p-2 border rounded focus:ring-2 focus:ring-purple-300 outline-none"
                    />
                )}
            </div>

            {/* Test Button */}
            <div className="flex flex-col space-y-2">
                <button
                    type="button"
                    onClick={handleTestAPI}
                    disabled={testing || !modelConfig.modelApiKey || !modelConfig.modelName}
                    className={`w-full py-2 rounded shadow transition-all ${
                        testing || !modelConfig.modelApiKey || !modelConfig.modelName
                        ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                        : "bg-purple-100 text-purple-700 hover:bg-purple-200"
                    }`}
                >
                    {testing ? (
                        <span className="flex items-center justify-center gap-2">
                            <FaSpinner className="animate-spin" />
                            Testing...
                        </span>
                    ) : (
                        "Test Connection"
                    )}
                </button>
                {testResult && (
                    <div className={`p-2 rounded text-xs ${testSuccess ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                        {testResult}
                    </div>
                )}
            </div>

            <div className="mt-auto pt-4">
                <button
                    type="submit"
                    disabled={saving}
                    className={`w-full py-2.5 rounded shadow transition-all transform font-bold ${
                        !saving
                        ? "bg-gradient-to-r from-purple-500 to-purple-700 text-white hover:from-purple-600 hover:to-purple-800 hover:scale-[1.02]" 
                        : "bg-gray-300 text-gray-500 cursor-not-allowed"
                    }`}
                >
                    {saving ? (
                      <span className="flex items-center justify-center gap-2">
                        <FaSpinner className="animate-spin" />
                        Saving...
                      </span>
                    ) : (
                      "Save Changes"
                    )}
                </button>
            </div>

        </form>
      </div>
    </div>
  );
};

export default EditModelPage;
