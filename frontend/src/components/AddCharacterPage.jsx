import React, { useState } from "react";
import AddCharacterTitleBar from "./AddCharacterTitleBar";
import { callOpenAI, callGemini } from "../utlis/openai"; // ✅ Import OpenAI utility
import defaultNormal from '../assets/default-normal.png';


const AddCharacterPage = () => {
  const [character, setCharacter] = useState({
    name: "",
    personality: "",
    appearance: "",
    imageName: "default", // 默认值为 "default"
    modelProvider: "openai",
    modelName: "",
    modelApiKey: "",
    modelUrl: "default",
    isAgent: false
  });

  // 控制 Personality Description 是否使用默认值
  const [useDefaultPersonality, setUseDefaultPersonality] = useState(false);
  const [modelUrlType, setModelUrlType] = useState("default");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // 存储选中的图片文件及处理后图片的路径
  const [selectedImageFile, setSelectedImageFile] = useState(null);
  const [processedImagePaths, setProcessedImagePaths] = useState([]);

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

  // 用户选择图片时保存文件对象
  const handleImageFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setSelectedImageFile(file);
    }
  };

  // 读取图片文件为 base64，并调用 processImage 接口
  const handleProcessImage = async () => {
    if (!selectedImageFile) {
      alert("请选择一张图片文件！");
      return;
    }
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64Image = event.target.result; // 包含 "data:image/png;base64,..." 前缀
      try {
        // 调用后端接口，返回 { uuid, paths }
        const result = await window.electron.processImage(base64Image);
        console.log("Processed image result:", result);
        setProcessedImagePaths(result.paths);
        // 更新 imageName 为返回的 uuid
        setCharacter((prev) => ({ ...prev, imageName: result.uuid }));
      } catch (error) {
        console.error("Error processing image:", error);
      }
    };
    reader.readAsDataURL(selectedImageFile);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      // 如果未选择图片，则 imageName 保持 "default"
      if (!selectedImageFile) {
        setCharacter((prev) => ({ ...prev, imageName: "default" }));
        setProcessedImagePaths([]);
      }
      // 提交 character 对象
      const newPet = await window.electron?.createPet(character);
      if (!newPet || !newPet._id) {
        throw new Error("Creation failed or no ID returned");
      }
      window.electron?.sendCharacterId(newPet._id);
      window.electron?.sendPetsUpdate(newPet);
      // 重置表单
      setCharacter({
        name: "",
        personality: "",
        appearance: "",
        imageName: "default",
        modelProvider: "openai",
        modelName: "",
        modelApiKey: "",
        modelUrl: "default",
        isAgent: false
      });
      setModelUrlType("default");
      setTestResult(null);
      setUseDefaultPersonality(false);
      setSelectedImageFile(null);
      setProcessedImagePaths([]);
    } catch (error) {
      console.error("Error creating pet:", error.message);
      window.electron?.sendCharacterId(null);
    }
  };

  const handleTestAPI = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      let messages = [];
      const personalityDesc =
        useDefaultPersonality || character.personality.trim() === ""
          ? "default"
          : character.personality;
      messages.push({
        role: "system",
        content: `Your personality: ${personalityDesc}`
      });
      messages.push({ role: "user", content: "Who are you?" });
      let result = null;

      if(character.modelProvider=='openai') {
        result = await callOpenAI(
          messages,
          character.modelApiKey,
          character.modelName,
          character.modelUrl
        );
      } else {
        result = await callGemini(
          messages,
          character.modelApiKey,
          character.modelName,
        );
      }
      
      if (!result || typeof result !== "object" || typeof result.content === "undefined") {
        setTestResult(`Failed: ${JSON.stringify(result)}`);
      } else {
        let display = `Test Success! AI responseContent: ${result.content}`;
        if (character.isAgent && result.mood) {
          display += `\nAgent: ${result.mood}`;
        }
        setTestResult(display);
      }
    } catch (error) {
      console.error("OpenAI request error:", error);
      const message = (error && error.message) || "Unknown error";
      setTestResult(`❌ Test failed: ${message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[rgba(255,255,255,0.8)]">
      {/* 固定标题栏 */}
      <div className="sticky top-0 z-10">
        <AddCharacterTitleBar />
      </div>
      <div className="text-center">
        <span>Add Character</span>
      </div>
      <div className="w-[90%] p-2 mx-auto bg-gray-50 rounded-lg shadow">
        <form onSubmit={handleSubmit} className="space-y-2 text-sm">
          <input
            name="name"
            placeholder="Name"
            value={character.name}
            onChange={handleChange}
            className="w-full p-1 border rounded focus:outline-none"
          />

          {/* Personality Description */}
          <div className="flex flex-col space-y-1">
            <label className="text-gray-700">Personality Description:</label>
            <textarea
              name="personality"
              placeholder="Enter personality description or function for agent"
              value={useDefaultPersonality ? "default" : character.personality}
              onChange={handleChange}
              disabled={useDefaultPersonality}
              className={`w-full p-1 border rounded resize-none h-12 ${
                useDefaultPersonality ? "bg-gray-200 cursor-not-allowed" : ""
              }`}
            />
            <label className="text-gray-700">
              <input
                type="checkbox"
                checked={useDefaultPersonality}
                onChange={(e) => {
                  setUseDefaultPersonality(e.target.checked);
                  setCharacter((prev) => ({
                    ...prev,
                    personality: e.target.checked ? "default" : ""
                  }));
                }}
                className="mr-1"
              />
              Use Default Personality
            </label>
          </div>

          {/* 图片文件选择与处理 */}
          <div>
            {/* 隐藏的文件输入 */}
            <input
              id="fileInput"
              type="file"
              accept="image/*"
              onChange={handleImageFileChange}
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={() => document.getElementById("fileInput").click()}
              className="mt-2 bg-blue-500 text-white py-1 px-3 rounded"
            >
              Choose Character Image
            </button>
            <button
              type="button"
              onClick={handleProcessImage}
              className="mt-2 ml-2 bg-indigo-500 text-white py-1 px-3 rounded"
            >
              Process Image
            </button>
          </div>

          {/* 显示处理结果 */}
          <div className="mt-2">
            <p className="text-sm">Character Image:</p>
            {processedImagePaths.length > 0 ? (
              <img src={processedImagePaths[0]} alt="Processed Character" className="w-40" />
            ) : (
              <img src={defaultNormal} alt="Default Character" className="w-40 h-40 border" />
            )}
          </div>

          {/* 显示当前 imageName */}
          <div className="mt-2 text-xs">
            <strong>Image Name:</strong>{" "}
            {character.imageName === "default" ? "default" : character.imageName}
          </div>

          {/* Is Agent 选项 */}
          <div className="flex items-center space-x-4">
            <label className="text-gray-700">
              <input
                type="checkbox"
                name="isAgent"
                checked={character.isAgent}
                onChange={(e) =>
                  setCharacter({ ...character, isAgent: e.target.checked })
                }
                className="mr-1"
              />
              Is Agent(agent has no mood in chat. If you want to use gpt-3.5 or some model that doesn't support json, please tick this.)
            </label>
          </div>

          {/* Model 相关字段 */}
          <div className="flex flex-col space-y-2">
            <div className="flex items-center space-x-4">
              <div className="flex items-center">
                <label htmlFor="modelProvider" className="text-gray-700 mr-2">
                  Model Provider:
                </label>
                <select
                  id="modelProvider"
                  name="modelProvider"
                  value={character.modelProvider}
                  onChange={handleChange}
                  className="p-1 border rounded"
                >
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                </select>
              </div>
              <div className="flex items-center">
                <label htmlFor="modelName" className="text-gray-700 mr-2">
                  Model Name:
                </label>
                <input
                  id="modelName"
                  name="modelName"
                  type="text"
                  value={character.modelName}
                  onChange={handleChange}
                  placeholder="e.g. gpt-3.5-turbo"
                  className="p-1 border rounded"
                />
              </div>
            </div>

            <input
              name="modelApiKey"
              placeholder="Model API Key"
              value={character.modelApiKey}
              onChange={handleChange}
              className="w-full p-1 border rounded"
            />

            {/* Model URL 选择 */}
            <div className="flex items-center space-x-4">
              <label className="text-gray-700">Model URL:</label>
              <select
                value={modelUrlType}
                onChange={handleModelUrlTypeChange}
                className="p-1 border rounded"
              >
                <option value="default">Default</option>
                <option value="custom">Custom</option>
              </select>
              {modelUrlType === "custom" && (
                <input
                  name="modelUrl"
                  placeholder="https://your-model-api.com"
                  value={character.modelUrl}
                  onChange={handleChange}
                  className="flex-1 p-1 border rounded"
                />
              )}
            </div>

            {/* 测试 API 按钮 */}
            <button
              type="button"
              onClick={handleTestAPI}
              disabled={testing}
              className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600 text-sm"
            >
              {testing ? "Testing..." : "Test API Key & Model"}
            </button>

            {/* 显示测试结果 */}
            {testResult && (
              <div className="mt-1 text-xs text-gray-800 bg-white border border-gray-200 rounded p-2">
                {testResult}
              </div>
            )}
          </div>

          <button
            type="submit"
            className="w-full bg-blue-500 text-white py-1 rounded hover:bg-blue-600 text-sm"
          >
            Save
          </button>
        </form>
      </div>
    </div>
  );
};

export default AddCharacterPage;