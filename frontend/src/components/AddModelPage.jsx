import React, { useState, useEffect } from "react";
import AddCharacterTitleBar from "./AddCharacterTitleBar";
import { callOpenAILib } from "../utils/openai";
import defaultNormal from "../assets/default-normal.png";
import OpaiNormal from "../assets/Opai-normal.png";
import GeminaNormal from "../assets/Gemina-normal.png";
import GrockaNormal from "../assets/Grocka-normal.png";
import ClaudiaNormal from "../assets/Claudia-normal.png";




// ======= 默认图片选项 =======
const defaultImageOptions = [
  { label: "Default", value: "default", src: defaultNormal },
  { label: "Opai", value: "Opai", src: OpaiNormal },
  { label: "Gemina", value: "Gemina", src: GeminaNormal },
  { label: "Grocka", value: "Grocka", src: GrockaNormal },
  { label: "Claudia", value: "Claudia", src: ClaudiaNormal },
  // 如有更多预设图片，可在此添加
];

// ======= 预设角色数据 =======
const presetCharacterOptions = [
  {
    label: "Create Your Own Character",
    value: "own character",
    data: {
      name: "",
      personality: "",
      imageName: "default",
      modelProvider: "openai",
      modelName: "",
      modelApiKey: "",
      modelUrl: "default",
      isAgent: false,
    },
    useDefaultPersonality: false,
  },
  {
    label: "Opai (Openai pure assistant)",
    value: "Opai",
    data: {
      name: "Opai",
      personality: "You are a useful assistant",
      imageName: "Opai",
      modelProvider: "openai",
      modelName: "gpt-4o",
      modelApiKey: "",
      modelUrl: "default",
      isAgent: true,
    },
    useDefaultPersonality: true,
  },
  {
    label: "Gemina (Openai pure assistant)",
    value: "Gemina",
    data: {
      name: "Gemina",
      personality: "You are a useful assistant",
      imageName: "Gemina",
      modelProvider: "gemini",
      modelName: "gemini-2.0-flash",
      modelApiKey: "",
      modelUrl: "default",
      isAgent: true,
    },
    useDefaultPersonality: true,
  },
  {
    label: "Grocka (Grok pure assistant)",
    value: "Grocka",
    data: {
      name: "Grocka",
      personality: "You are a useful assistant",
      imageName: "Grocka",
      modelProvider: "grok",
      modelName: "grok-2-1212",
      modelApiKey: "",
      modelUrl: "default",
      isAgent: true,
    },
    useDefaultPersonality: true,
  },
  {
    label: "Claudia (Anthropic pure assistant)",
    value: "Claudia",
    data: {
      name: "Claudia",
      personality: "You are a useful assistant",
      imageName: "Claudia",
      modelProvider: "anthropic",
      modelName: "claude-3-7-sonnet-20250219",
      modelApiKey: "",
      modelUrl: "default",
      isAgent: true,
    },
    useDefaultPersonality: true,
  },
];

const AddCharacterPage = () => {
  const [character, setCharacter] = useState({
    name: "",
    personality: "",
    imageName: "default",
    modelProvider: "openai",
    modelName: "",
    modelApiKey: "",
    modelUrl: "default",
    isAgent: false,
  });

  const [useDefaultPersonality, setUseDefaultPersonality] = useState(false);
  const [modelUrlType, setModelUrlType] = useState("default");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [selectedImageFile, setSelectedImageFile] = useState(null);
  const [processedImagePaths, setProcessedImagePaths] = useState([]);
  const [presetSelected, setPresetSelected] = useState("");

  // 将预设选项的逻辑封装到一个函数中
  const applyPreset = (presetValue) => {
    const preset = presetCharacterOptions.find(opt => opt.value === presetValue);
    if (preset && preset.data) {
      const presetData = { ...preset.data };
      if (preset.useDefaultPersonality) {
        presetData.personality = "default";
        setUseDefaultPersonality(true);
      } else {
        setUseDefaultPersonality(false);
      }
      setCharacter(presetData);
      setPresetSelected(presetValue);
      const foundOption = defaultImageOptions.find(opt => opt.value === presetData.imageName);
      if (foundOption && foundOption.src) {
        setProcessedImagePaths([foundOption.src]);
      } else {
        setProcessedImagePaths([]);
      }
    }
  };

  // 启动时自动选择 own character
  useEffect(() => {
    applyPreset("own character");
  }, []);

  const handleChange = (e) => {
    setCharacter({ ...character, [e.target.name]: e.target.value });
  };

  const handleModelUrlTypeChange = (e) => {
    const type = e.target.value;
    setModelUrlType(type);
    setCharacter({ ...character, modelUrl: type === "default" ? "default" : "" });
  };

  const handlePresetChange = (e) => {
    applyPreset(e.target.value);
  };

  const handleImageFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setSelectedImageFile(file);
    }
  };

  const handleProcessImage = async () => {
    if (!selectedImageFile) {
      alert("Please select an image file!");
      return;
    }
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64Image = event.target.result;
      try {
        const result = await window.electron.processImage(base64Image);
        console.log("Processed image result:", result);
        setProcessedImagePaths(result.paths);
        setCharacter(prev => ({ ...prev, imageName: result.uuid }));
      } catch (error) {
        console.error("Error processing image:", error);
      }
    };
    reader.readAsDataURL(selectedImageFile);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const submitData = { 
        ...character, 
        personality: useDefaultPersonality ? "default" : character.personality 
      };
      if (!selectedImageFile && submitData.imageName === "default") {
        submitData.imageName = "default";
        setProcessedImagePaths([]);
      }
      const newPet = await window.electron?.createPet(submitData);
      if (!newPet || !newPet._id) {
        throw new Error("Creation failed or no ID returned");
      }
      window.electron?.sendCharacterId(newPet._id);
      window.electron?.sendPetsUpdate(newPet);
      // 重置时也模拟选择 own character
      applyPreset("own character");
      setModelUrlType("default");
      setTestResult(null);
      setUseDefaultPersonality(false);
      setSelectedImageFile(null);
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
        character.personality.trim() === "" ? "default" : character.personality;
      messages.push({
        role: "system",
        content: `Your personality: ${personalityDesc}`,
      });
      messages.push({ role: "user", content: "Who are you?" });
      let result = await callOpenAILib(
        messages,
        character.modelProvider,
        character.modelApiKey,
        character.modelName,
        character.modelUrl
      );
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

  // 修改 getDefaultImageSrc 函数，返回 URL 字符串
  const getDefaultImageSrc = (imageNameValue) => {
    const found = defaultImageOptions.find((opt) => opt.value === imageNameValue);
    return found ? found.src : "";
  };

  return (
    <div className="min-h-screen bg-[rgba(255,255,255,0.8)]">
      <div className="sticky top-0 z-10">
        <AddCharacterTitleBar />
      </div>
      <div className="w-[90%] p-2 mt-5 mx-auto bg-gray-50 rounded-lg shadow">
        <form onSubmit={handleSubmit} className="space-y-2 text-sm">
          {/* 预设角色下拉选择 */}
          <div className="flex flex-col space-y-1">
            <label className="text-gray-700">Preset Character:</label>
            <select
              className="w-full p-1 border rounded"
              value={presetSelected}
              onChange={handlePresetChange}
            >
              {presetCharacterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* 姓名 */}
          <input
            name="name"
            placeholder="Name"
            value={character.name}
            onChange={handleChange}
            className="w-full p-1 border rounded focus:outline-none"
          />

          {/* 人格描述及 Use Default Personality 勾选框 */}
          <div className="flex flex-col space-y-1">
            <label className="text-gray-700">Personality Description:</label>
            <textarea
              name="personality"
              placeholder="Enter personality description or function for agent"
              value={useDefaultPersonality ? "You are a useful assistant" : character.personality}
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
                onChange={(e) => setUseDefaultPersonality(e.target.checked)}
                className="mr-1"
              />
              Use Default Personality
            </label>
          </div>

          {/* 默认角色图片选择 */}
          <div className="flex flex-col space-y-1">
            <label className="text-gray-700">Default Character Image:</label>
            <select
              className="w-full p-1 border rounded"
              value={character.imageName}
              onChange={(e) => {
                const newVal = e.target.value;
                setCharacter(prev => ({ ...prev, imageName: newVal }));
                setSelectedImageFile(null);
                const foundOption = defaultImageOptions.find(opt => opt.value === newVal);
                if (foundOption && foundOption.src) {
                  setProcessedImagePaths([foundOption.src]);
                } else {
                  setProcessedImagePaths([]);
                }
              }}
            >
              {defaultImageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* 图片文件上传 */}
          <div>
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
              className="mt-2 bg-gradient-to-r from-blue-500 to-blue-700 text-white py-2 px-4 rounded shadow hover:from-blue-600 hover:to-blue-800 transition-colors duration-300"
            >
              Choose Character Image
            </button>
            <button
              type="button"
              onClick={handleProcessImage}
              className="mt-2 ml-2 bg-gradient-to-r from-indigo-500 to-indigo-700 text-white py-2 px-4 rounded shadow hover:from-indigo-600 hover:to-indigo-800 transition-colors duration-300"
            >
              Process Image
            </button>
          </div>

          {/* 图片预览 */}
          <div className="mt-2">
            <p className="text-sm">Character Image Preview:</p>
            {processedImagePaths.length > 0 ? (
              <img
                src={processedImagePaths[0]}
                alt="Processed Character"
                draggable="false"
                className="w-40"
              />
            ) : (
              <img
                src={getDefaultImageSrc(character.imageName)}
                alt="default"
                draggable="false"
                className="w-40 h-40 border"
              />
            )}
          </div>

          {/* 当前 imageName 显示 */}
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
                onChange={(e) => setCharacter({ ...character, isAgent: e.target.checked })}
                className="mr-1"
              />
              Is Agent (agent has no mood in chat. If you want to use gpt-3.5 or some model that doesn't support JSON, please tick this.)
            </label>
          </div>

          {/* 模型相关字段 */}
          <div className="flex flex-col space-y-2">
            <div className="flex items-center space-x-4">
              <div className="flex items-center">
                <label htmlFor="modelProvider" className="text-gray-700 mr-2">
                  Model Provider:
                </label>
                <select
                  name="modelProvider"
                  value={character.modelProvider}
                  onChange={(e) => {
                    const newProvider = e.target.value;
                    setCharacter(prev => ({
                      ...prev,
                      modelProvider: newProvider,
                      modelUrl: newProvider === "others" ? "" : "default",
                    }));
                  }}
                  className="p-1 border rounded"
                >
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="grok">Grok</option>
                  <option value="others">Others</option>
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
            <label className="text-gray-700">
              If you want to use local ollama model, please select others.
            </label>
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
              {character.modelProvider === "others" ? (
                <input
                  name="modelUrl"
                  placeholder="https://yunwu.ai"
                  value={character.modelUrl}
                  onChange={handleChange}
                  className="flex-1 p-1 border rounded"
                />
              ) : (
                <>
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
                      placeholder="https://yunwu.ai"
                      value={character.modelUrl}
                      onChange={handleChange}
                      className="flex-1 p-1 border rounded"
                    />
                  )}
                </>
              )}
            </div>
            {/* Test API 按钮 */}
            <button
              type="button"
              onClick={handleTestAPI}
              disabled={testing}
              className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600 text-sm"
            >
              {testing ? "Testing..." : "Test API Key & Model"}
            </button>
            {/* 测试结果显示 */}
            {testResult && (
              <div className="mt-1 text-xs text-gray-800 bg-white border border-gray-200 rounded p-2">
                {testResult}
              </div>
            )}
          </div>
          <button type="submit" className="w-full bg-blue-500 text-white py-1 rounded hover:bg-blue-600 text-sm">
            Save
          </button>
        </form>
      </div>
    </div>
  );
};

export default AddCharacterPage;