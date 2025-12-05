import React, { useState, useEffect } from "react";
import AddCharacterTitleBar from "../components/Layout/AddCharacterTitleBar";
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
  const [step, setStep] = useState(1);
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

  // useDefaultPersonality 对应 "无系统设定" (默认)
  // 当 useDefaultPersonality 为 true 时，personality 字段不显示，提交时使用默认值
  const [useDefaultPersonality, setUseDefaultPersonality] = useState(true);
  
  const [modelUrlType, setModelUrlType] = useState("default");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testSuccess, setTestSuccess] = useState(false);
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
      // Reset test success when preset changes
      setTestSuccess(false);
      setTestResult(null);
    }
  };

  // 启动时自动选择 own character
  useEffect(() => {
    applyPreset("own character");
  }, []);

  const handleChange = (e) => {
    setCharacter({ ...character, [e.target.name]: e.target.value });
    // Reset test success if model related fields change
    if (["modelProvider", "modelName", "modelApiKey", "modelUrl"].includes(e.target.name)) {
      setTestSuccess(false);
      setTestResult(null);
    }
  };

  const handleModelUrlTypeChange = (e) => {
    const type = e.target.value;
    setModelUrlType(type);
    setCharacter({ ...character, modelUrl: type === "default" ? "default" : "" });
    setTestSuccess(false);
    setTestResult(null);
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
    
    if (!testSuccess) {
        alert("Please test the connection successfully before creating the character.");
        return;
    }

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
      setTestSuccess(false);
      setUseDefaultPersonality(true);
      setSelectedImageFile(null);
      setStep(1); // Reset to step 1
    } catch (error) {
      console.error("Error creating pet:", error.message);
      window.electron?.sendCharacterId(null);
    }
  };

  const handleTestAPI = async () => {
    setTesting(true);
    setTestResult(null);
    setTestSuccess(false);
    try {
      let messages = [];
      const personalityDesc =
        (useDefaultPersonality || character.personality.trim() === "") ? "default" : character.personality;
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
        setTestSuccess(false);
      } else {
        let display = `Test Success! AI responseContent: ${result.content}`;
        if (character.isAgent && result.mood) {
          display += `\nAgent: ${result.mood}`;
        }
        setTestResult(display);
        setTestSuccess(true);
      }
    } catch (error) {
      console.error("OpenAI request error:", error);
      const message = (error && error.message) || "Unknown error";
      setTestResult(`❌ Test failed: ${message}`);
      setTestSuccess(false);
    } finally {
      setTesting(false);
    }
  };

  // 修改 getDefaultImageSrc 函数，返回 URL 字符串
  const getDefaultImageSrc = (imageNameValue) => {
    const found = defaultImageOptions.find((opt) => opt.value === imageNameValue);
    return found ? found.src : "";
  };

  // Navigation Helpers
  const nextStep = () => setStep(s => Math.min(s + 1, 3));
  const prevStep = () => setStep(s => Math.max(s - 1, 1));

  return (
    <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col overflow-hidden">
      <div className="sticky top-0 z-10">
        <AddCharacterTitleBar />
      </div>
      
      {/* Progress Bar */}
      <div className="w-[90%] mx-auto mt-4 mb-2 flex-shrink-0">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span className={step >= 1 ? "text-blue-600 font-bold" : ""}>1. Identity</span>
            <span className={step >= 2 ? "text-blue-600 font-bold" : ""}>2. Appearance</span>
            <span className={step >= 3 ? "text-blue-600 font-bold" : ""}>3. Intelligence</span>
        </div>
        <div className="h-1 w-full bg-gray-200 rounded-full overflow-hidden">
            <div 
                className="h-full bg-blue-500 transition-all duration-300 ease-in-out"
                style={{ width: `${(step / 3) * 100}%` }}
            ></div>
        </div>
      </div>

      <div className="w-[90%] flex-1 mx-auto bg-gray-50 rounded-lg shadow-sm border border-gray-100 p-4 overflow-y-auto mb-4 scrollbar-hide">
        <form onSubmit={handleSubmit} className="space-y-2 text-sm h-full flex flex-col">
          
          {/* STEP 1: IDENTITY */}
          {step === 1 && (
            <div className="space-y-2 animate-fadeIn">
                <div className="bg-blue-50 p-2 rounded-md border border-blue-100 text-blue-800 text-xs">
                    <strong>Step 1: Identity</strong><br/>
                    Define who your character is. You can start from a preset or create from scratch.
                </div>

                {/* Preset */}
                <div className="flex flex-col space-y-1">
                    <label className="text-gray-700 font-medium">Preset Template</label>
                    <select
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-300 outline-none"
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

                {/* Name */}
                <div className="flex flex-col space-y-1">
                    <label className="text-gray-700 font-medium">Name <span className="text-red-500">*</span></label>
                    <input
                    name="name"
                    placeholder="e.g. Jarvis, Kitty..."
                    value={character.name}
                    onChange={handleChange}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-300 outline-none"
                    required
                    />
                </div>

                {/* Personality Toggle */}
                <div className="flex flex-col space-y-1 pt-1">
                    <div className="flex items-center justify-between">
                        <label className="text-gray-700 font-medium">System Setting (Personality)</label>
                        <div className="flex items-center bg-gray-200 rounded-full p-0.5 w-12 cursor-pointer" onClick={() => setUseDefaultPersonality(!useDefaultPersonality)}>
                            <div className={`w-5 h-5 rounded-full shadow-sm transform transition-transform duration-300 ${!useDefaultPersonality ? 'translate-x-6 bg-blue-500' : 'translate-x-0 bg-white'}`}></div>
                        </div>
                    </div>
                    <p className="text-xs text-gray-500">
                        {useDefaultPersonality ? "Default (No specific system setting)" : "Custom system prompt enabled"}
                    </p>
                    
                    {!useDefaultPersonality && (
                        <textarea
                        name="personality"
                        placeholder="You are a helpful assistant..."
                        value={character.personality}
                        onChange={handleChange}
                        className="w-full p-2 border rounded resize-none h-20 focus:ring-2 focus:ring-blue-300 outline-none"
                        />
                    )}
                </div>

                {/* Agent Mode */}
                <div className="pt-1 border-t border-gray-200 mt-1">
                    <label className="flex items-start space-x-2 cursor-pointer">
                        <input
                            type="checkbox"
                            name="isAgent"
                            checked={character.isAgent}
                            onChange={(e) => setCharacter({ ...character, isAgent: e.target.checked })}
                            className="mt-1"
                        />
                        <div>
                            <span className="font-medium text-gray-700">Enable Agent Mode</span>
                            <p className="text-xs text-gray-500 mt-0.5">
                                Allow this character to execute system commands (Shell/Terminal). 
                                <br/>Mood analysis is supported in all modes.
                            </p>
                        </div>
                    </label>
                </div>
            </div>
          )}

          {/* STEP 2: APPEARANCE */}
          {step === 2 && (
            <div className="space-y-2 animate-fadeIn">
                <div className="bg-indigo-50 p-2 rounded-md border border-indigo-100 text-indigo-800 text-xs">
                    <strong>Step 2: Appearance</strong><br/>
                    Choose how your character looks. You can upload a custom image and process it for animations.
                </div>

                <div className="flex flex-col space-y-1">
                    <label className="text-gray-700 font-medium">Image Source</label>
                    <select
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-indigo-300 outline-none"
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

                <div className="flex gap-2">
                    <button
                    type="button"
                    onClick={() => document.getElementById("fileInput").click()}
                    className="flex-1 bg-white border border-gray-300 text-gray-700 py-2 px-4 rounded hover:bg-gray-50 transition-colors text-xs font-medium"
                    >
                    Upload Image
                    </button>
                    <button
                    type="button"
                    onClick={handleProcessImage}
                    className="flex-1 bg-indigo-600 text-white py-2 px-4 rounded hover:bg-indigo-700 transition-colors text-xs font-medium"
                    >
                    Process Image
                    </button>
                    <input
                    id="fileInput"
                    type="file"
                    accept="image/*"
                    onChange={handleImageFileChange}
                    style={{ display: "none" }}
                    />
                </div>

                <div className="mt-2 flex justify-center bg-gray-100 rounded-lg p-2 border border-dashed border-gray-300">
                    {processedImagePaths.length > 0 ? (
                    <img
                        src={processedImagePaths[0]}
                        alt="Processed Character"
                        draggable="false"
                        className="h-32 object-contain"
                    />
                    ) : (
                    <img
                        src={getDefaultImageSrc(character.imageName)}
                        alt="default"
                        draggable="false"
                        className="h-32 object-contain opacity-50"
                    />
                    )}
                </div>
                <div className="text-center text-xs text-gray-400">
                    Current ID: {character.imageName === "default" ? "Default" : character.imageName}
                </div>
            </div>
          )}

          {/* STEP 3: INTELLIGENCE */}
          {step === 3 && (
            <div className="space-y-2 animate-fadeIn">
                <div className="bg-green-50 p-2 rounded-md border border-green-100 text-green-800 text-xs">
                    <strong>Step 3: Intelligence</strong><br/>
                    Connect your character to an AI brain. Configure the model provider and test the connection.
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col space-y-1">
                        <label className="text-gray-700 font-medium text-xs">Provider</label>
                        <select
                            name="modelProvider"
                            value={character.modelProvider}
                            onChange={handleChange}
                            className="w-full p-2 border rounded text-xs"
                        >
                            <option value="openai">OpenAI</option>
                            <option value="gemini">Gemini</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="grok">Grok</option>
                            <option value="ollama">Ollama</option>
                        </select>
                    </div>
                    <div className="flex flex-col space-y-1">
                        <label className="text-gray-700 font-medium text-xs">Model Name</label>
                        <input
                            name="modelName"
                            placeholder="e.g. gpt-4o"
                            value={character.modelName}
                            onChange={handleChange}
                            className="w-full p-2 border rounded text-xs"
                        />
                    </div>
                </div>

                <div className="flex flex-col space-y-1">
                    <label className="text-gray-700 font-medium text-xs">API Key</label>
                    <input
                        name="modelApiKey"
                        type="password"
                        placeholder="sk-..."
                        value={character.modelApiKey}
                        onChange={handleChange}
                        className="w-full p-2 border rounded text-xs"
                    />
                </div>

                <div className="flex flex-col space-y-1">
                    <label className="text-gray-700 font-medium text-xs">Base URL</label>
                    <div className="flex gap-2">
                        <select
                            value={modelUrlType}
                            onChange={handleModelUrlTypeChange}
                            className="p-2 border rounded text-xs w-24"
                        >
                            <option value="default">Default</option>
                            <option value="custom">Custom</option>
                        </select>
                        <input
                            name="modelUrl"
                            placeholder="https://api.openai.com/v1"
                            value={character.modelUrl}
                            onChange={handleChange}
                            disabled={modelUrlType === "default"}
                            className={`flex-1 p-2 border rounded text-xs ${
                                modelUrlType === "default" ? "bg-gray-100 text-gray-400" : ""
                            }`}
                        />
                    </div>
                </div>

                {/* Test Section */}
                <div className="pt-1 border-t border-gray-200">
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-bold text-gray-600">Connection Test</span>
                        <button
                            type="button"
                            onClick={handleTestAPI}
                            disabled={testing}
                            className={`text-xs px-3 py-1 rounded ${
                                testing ? "bg-gray-300" : "bg-green-600 text-white hover:bg-green-700"
                            }`}
                        >
                            {testing ? "Testing..." : "Test Connection"}
                        </button>
                    </div>
                    {testResult && (
                        <div className={`p-2 rounded text-xs whitespace-pre-wrap max-h-16 overflow-y-auto ${
                            testResult.includes("Success") ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
                        }`}>
                            {testResult}
                        </div>
                    )}
                </div>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="mt-auto pt-4 flex justify-between border-t border-gray-200 flex-shrink-0">
            {step > 1 ? (
                <button
                    type="button"
                    onClick={prevStep}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors text-sm font-medium"
                >
                    Back
                </button>
            ) : (
                <div></div> // Spacer
            )}

            {step < 3 ? (
                <button
                    type="button"
                    onClick={nextStep}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm font-medium"
                >
                    Next
                </button>
            ) : (
                <button
                    type="submit"
                    disabled={!testSuccess}
                    className={`px-6 py-2 rounded shadow transition-all transform text-sm font-bold ${
                        testSuccess 
                        ? "bg-gradient-to-r from-green-500 to-green-700 text-white hover:from-green-600 hover:to-green-800 hover:scale-105" 
                        : "bg-gray-300 text-gray-500 cursor-not-allowed"
                    }`}
                >
                    Create Character
                </button>
            )}
          </div>

        </form>
      </div>
    </div>
  );
};

export default AddCharacterPage;