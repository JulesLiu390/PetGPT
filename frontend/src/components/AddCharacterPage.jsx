import React, { useState } from "react";
import AddCharacterTitleBar from "./AddCharacterTitleBar";
import { callOpenAILib } from "../utlis/openai";
import defaultNormal from "../assets/default-normal.png";

// ======= 默认图片选项 =======
const defaultImageOptions = [
  { label: "Default", value: "default", src: defaultNormal },
  // 如有更多预设图片，可在此添加
  { label: "Anime Girl", value: "anime-girl", src: defaultNormal },
  // { label: "Warrior", value: "warrior", src: warriorImg },
];

// ======= 预设角色数据（删除了外观字段），包含完整表单数据 =======
// useDefaultPersonality 标志指示该预设角色是否应使用默认人格（即 personality 为 "default"）。
const presetCharacterOptions = [
  {
    label: "Create Your Own Character",
    value: "",
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
      personality: "You are a useful assistant", // 此处默认描述，可在下方用 useDefaultPersonality 覆盖
      imageName: "default",
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
      personality: "You are a useful assistant", // 此处默认描述，可在下方用 useDefaultPersonality 覆盖
      imageName: "default",
      modelProvider: "gemini",
      modelName: "gemini",
      modelApiKey: "",
      modelUrl: "default",
      isAgent: true,
    },
    useDefaultPersonality: true,
  },
  {
    label: "Mystical Sage",
    value: "mystical_sage",
    data: {
      name: "Opai",
      personality: "You are a useful assistant", // 此处默认描述，可在下方用 useDefaultPersonality 覆盖
      imageName: "default",
      modelProvider: "openai",
      modelName: "gpt-4o",
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

  // 控制是否使用默认人格的勾选框（仅用于 UI 控制，提交前根据该状态覆盖 personality 字段）
  const [useDefaultPersonality, setUseDefaultPersonality] = useState(false);
  const [modelUrlType, setModelUrlType] = useState("default");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  // 图片文件及处理后图片路径
  const [selectedImageFile, setSelectedImageFile] = useState(null);
  const [processedImagePaths, setProcessedImagePaths] = useState([]);
  // 记录当前选中的预设角色
  const [presetSelected, setPresetSelected] = useState("");

  const handleChange = (e) => {
    setCharacter({ ...character, [e.target.name]: e.target.value });
  };

  const handleModelUrlTypeChange = (e) => {
    const type = e.target.value;
    setModelUrlType(type);
    setCharacter({ ...character, modelUrl: type === "default" ? "default" : "" });
  };

  // 当用户选择预设角色时，根据 preset.useDefaultPersonality 来更新整个表单
  const handlePresetChange = (e) => {
    const value = e.target.value;
    setPresetSelected(value);
    if (value) {
      const preset = presetCharacterOptions.find((opt) => opt.value === value);
      if (preset && preset.data) {
        const presetData = { ...preset.data };
        if (preset.useDefaultPersonality) {
          presetData.personality = "default";
          setUseDefaultPersonality(true); // 自动勾选 Use Default Personality
        } else {
          setUseDefaultPersonality(false);
        }
        setCharacter(presetData);
        // 同步更新图片预览
        if (presetData.imageName !== "default") {
          const foundOption = defaultImageOptions.find(
            (opt) => opt.value === presetData.imageName
          );
          if (foundOption && foundOption.src) {
            setProcessedImagePaths([foundOption.src]);
          } else {
            setProcessedImagePaths([]);
          }
        } else {
          setProcessedImagePaths([]);
        }
      }
    }
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
      // 提交前，根据 useDefaultPersonality 状态覆盖 personality 字段
      const submitData = { ...character, personality: useDefaultPersonality ? "default" : character.personality };
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
      // 重置表单
      setCharacter({
        name: "",
        personality: "",
        imageName: "default",
        modelProvider: "openai",
        modelName: "",
        modelApiKey: "",
        modelUrl: "default",
        isAgent: false,
      });
      setPresetSelected("");
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

  // 根据 imageName 获取对应图片预览
  const getDefaultImageSrc = (imageNameValue) => {
    const found = defaultImageOptions.find((opt) => opt.value === imageNameValue);
    return found ? found.src : defaultNormal;
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
                onChange={(e) => setUseDefaultPersonality(e.target.checked)}
                className="mr-1"
              />
              Use Default Personality
            </label>
          </div>

          {/* 删除外观字段，默认为空 */}

          {/* 默认角色图片选择 */}
          <div className="flex flex-col space-y-1">
            <label className="text-gray-700">Default Character Image:</label>
            <select
              className="w-full p-1 border rounded"
              value={character.imageName}
              onChange={(e) => {
                const newVal = e.target.value;
                setCharacter((prev) => ({ ...prev, imageName: newVal }));
                setSelectedImageFile(null);
                if (newVal === "default") {
                  setProcessedImagePaths([]);
                } else {
                  const foundOption = defaultImageOptions.find((opt) => opt.value === newVal);
                  if (foundOption && foundOption.src) {
                    setProcessedImagePaths([foundOption.src]);
                  } else {
                    setProcessedImagePaths([]);
                  }
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
                alt="Default Character"
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
                onChange={(e) =>
                  setCharacter({ ...character, isAgent: e.target.checked })
                }
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
                    setCharacter((prev) => ({
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
                  placeholder="https://your-model-api.com"
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
                      placeholder="https://your-model-api.com"
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