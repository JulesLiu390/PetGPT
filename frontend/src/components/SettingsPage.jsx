import React, { useState } from "react";
import AddCharacterTitleBar from "./AddCharacterTitleBar";
import { callOpenAILib } from "../utlis/openai";
import SettingsTitleBar from "./SettingsTitleBar";

const AddCharacterPage = () => {
  const [character, setCharacter] = useState({
    modelProvider: "openai",
    modelName: "",
    modelApiKey: "",
    modelUrl: "default"
  });
  const [modelUrlType, setModelUrlType] = useState("default");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const handleChange = (e) => {
    setCharacter({ ...character, [e.target.name]: e.target.value });
  };

  const handleModelUrlTypeChange = (e) => {
    const type = e.target.value;
    setModelUrlType(type);
    setCharacter({
      ...character,
      modelUrl: type === "default" ? "default" : ""
    });
  };

  const handleTestAPI = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const messages = [
        { role: "system", content: "System prompt for test" },
        { role: "user", content: "Hello, who are you?" }
      ];

      const result = await callOpenAILib(
        messages,
        character.modelProvider,
        character.modelApiKey,
        character.modelName,
        character.modelUrl
      );

      if (!result || typeof result !== "object" || typeof result.content === "undefined") {
        setTestResult(`Failed: ${JSON.stringify(result)}`);
      } else {
        setTestResult(`Test Success! Response: ${result.content}`);
      }
    } catch (error) {
      setTestResult(`❌ Test failed: ${error.message}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // 这里示例仅使用 alert，实际可替换为保存逻辑
    alert(`Saving Model: [${character.modelProvider}] ${character.modelName}`);
  };

  return (
    <div className="min-h-screen bg-[rgba(255,255,255,0.8)]">
      {/* 固定标题栏 */}
      <div className="sticky top-0 z-10">
        <SettingsTitleBar />
      </div>
      <div className="w-[90%] p-4 mx-auto bg-gray-50 rounded-lg shadow">
        <form onSubmit={handleSubmit} className="space-y-4 text-sm">
          {/* API Provider */}
          <div>
            <label className="block text-gray-700 mb-1">API Provider</label>
            <select
              name="modelProvider"
              value={character.modelProvider}
              onChange={handleChange}
              className="w-full p-2 border rounded"
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          {/* Model Name */}
          <div>
            <label className="block text-gray-700 mb-1">Model Name</label>
            <input
              name="modelName"
              type="text"
              value={character.modelName}
              onChange={handleChange}
              placeholder="e.g. gpt-3.5-turbo"
              className="w-full p-2 border rounded"
            />
          </div>
          {/* Model API Key */}
          <div>
            <label className="block text-gray-700 mb-1">Model API Key</label>
            <input
              name="modelApiKey"
              type="text"
              value={character.modelApiKey}
              onChange={handleChange}
              placeholder="Enter your API Key"
              className="w-full p-2 border rounded"
            />
          </div>
          {/* Model URL 选择 */}
          <div className="flex items-center space-x-2">
            <label className="text-gray-700">Model URL:</label>
            <select
              value={modelUrlType}
              onChange={handleModelUrlTypeChange}
              className="p-2 border rounded"
            >
              <option value="default">Default</option>
              <option value="custom">Custom</option>
            </select>
            {modelUrlType === "custom" && (
              <input
                name="modelUrl"
                type="text"
                value={character.modelUrl}
                onChange={handleChange}
                placeholder="https://your-model-api.com"
                className="flex-1 p-2 border rounded"
              />
            )}
          </div>
          {/* 测试按钮 */}
          <div>
            <button
              type="button"
              onClick={handleTestAPI}
              disabled={testing}
              className="w-full bg-green-500 text-white py-2 rounded hover:bg-green-600"
            >
              {testing ? "Testing..." : "Test API Key & Model"}
            </button>
          </div>
          {/* 显示测试结果 */}
          {testResult && (
            <div className="mt-2 text-xs text-gray-800 bg-white border border-gray-200 rounded p-2">
              {testResult}
            </div>
          )}
          {/* 保存按钮 */}
          <button
            type="submit"
            className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600"
          >
            Save
          </button>
        </form>
      </div>
    </div>
  );
};

export default AddCharacterPage;