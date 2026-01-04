import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FaSpinner } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";
import { callOpenAILib } from '../utils/openai';
import { PageLayout, Surface, Card, FormGroup, Input, Select, Button, Alert } from "../components/UI/ui";
import TitleBar from "../components/UI/TitleBar";
import * as bridge from "../utils/bridge";

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
        const model = await bridge.getModelConfig(modelId);
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

      await bridge.updateModelConfig(modelId, updateData);
      bridge.sendPetsUpdate();
      
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
        <TitleBar
          title="Edit Model"
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
        
        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
          <Surface className="max-w-lg mx-auto p-5">
            <form onSubmit={handleSubmit} className="space-y-5">
              
              <Alert tone="blue">
                <strong>Edit Model Configuration</strong><br/>
                Update your LLM backend settings.
              </Alert>

              <FormGroup label="Configuration Name" required>
                <Input
                  name="name"
                  placeholder="e.g. My GPT-4, Local Ollama..."
                  value={modelConfig.name}
                  onChange={handleChange}
                  required
                />
              </FormGroup>

              <FormGroup label="API Format">
                <Select
                  name="apiFormat"
                  value={modelConfig.apiFormat}
                  onChange={handleChange}
                >
                  <option value="openai_compatible">OpenAI Compatible</option>
                  <option value="gemini_official">Gemini Official</option>
                </Select>
              </FormGroup>

              <FormGroup label="Model Name">
                <Input
                  name="modelName"
                  placeholder="e.g. gpt-4o, gemini-pro..."
                  value={modelConfig.modelName}
                  onChange={handleChange}
                />
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

              <FormGroup label="API URL">
                <Select
                  value={modelUrlType}
                  onChange={handleUrlTypeChange}
                  className="mb-2"
                >
                  <option value="default">Default (based on API format)</option>
                  <option value="custom">Custom URL</option>
                </Select>
                {modelUrlType === "custom" && (
                  <Input
                    name="modelUrl"
                    placeholder="https://your-api-endpoint.com"
                    value={modelConfig.modelUrl === "default" ? "" : modelConfig.modelUrl}
                    onChange={handleChange}
                  />
                )}
              </FormGroup>

              {/* Test Section */}
              <Card title="Connection Test" action={
                <Button
                  type="button"
                  variant={testSuccess ? "subtle" : "primary"}
                  onClick={handleTestAPI}
                  disabled={testing || !modelConfig.modelApiKey || !modelConfig.modelName}
                  className="text-xs"
                >
                  {testing ? (
                    <span className="flex items-center gap-2">
                      <FaSpinner className="animate-spin w-3 h-3" />
                      Testing...
                    </span>
                  ) : "Test Connection"}
                </Button>
              } className="bg-slate-50/50">
                {testResult ? (
                  <Alert tone={testSuccess ? "green" : "red"}>
                    {testResult}
                  </Alert>
                ) : (
                  <div className="text-xs text-slate-500 text-center py-2">
                    Test your connection to verify settings
                  </div>
                )}
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

export default EditModelPage;
