import React, { useState } from "react";
import AddCharacterTitleBar from "./AddCharacterTitleBar";

const API_BASE_URL = "http://localhost:3001/api";

const AddCharacterPage = () => {
  // 初始化角色状态，包含基本信息和模型相关字段
  const [character, setCharacter] = useState({
    name: "",
    personality: "",
    appearance: "",
    imageName: "",
    modelProvider: "openai", // 默认选择 OpenAI
    modelName: "",          // 具体模型名称，如 "chatgpt3.5" 或 "gemini1.5"
    modelApiKey: ""
  });

  // 统一处理输入框变化
  const handleChange = (e) => {
    setCharacter({ ...character, [e.target.name]: e.target.value });
  };

  // 提交表单，调用后端 API 添加角色
  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch(`${API_BASE_URL}/pets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(character)
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to create pet");
      }
      const newPet = await response.json();

      window.electron?.sendPetsUpdate();
      // Electron.
      // 如果需要，提交后可清空表单：
      setCharacter({
        name: "",
        personality: "",
        appearance: "",
        imageName: "",
        modelProvider: "openai",
        modelName: "",
        modelApiKey: ""
      });
      alert(
        `Selected pet: ${character.name}, Personality: ${character.personality}, Appearance: ${character.appearance || 'N/A'}`
      )
    } catch (error) {
      alert("Error: " + error.message);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full items-center bg-[rgba(255,255,255,0.8)]">
      <AddCharacterTitleBar />
      <div className="w-[90%] p-2 mt-2 bg-gray-50 rounded-lg shadow">
        <h2 className="text-base font-semibold mb-2 text-center">添加角色</h2>
        <form onSubmit={handleSubmit} className="space-y-2 text-sm">
          {/* 角色名称 */}
          <input
            name="name"
            placeholder="名称"
            value={character.name}
            onChange={handleChange}
            className="w-full p-1 border rounded focus:outline-none"
          />
          {/* 人格描述 */}
          <textarea
            name="personality"
            placeholder="人格描述"
            value={character.personality}
            onChange={handleChange}
            className="w-full p-1 border rounded resize-none h-12"
          />
          {/* 外观描述 */}
          <textarea
            name="appearance"
            placeholder="外观描述"
            value={character.appearance}
            onChange={handleChange}
            className="w-full p-1 border rounded resize-none h-12"
          />
          {/* 图片 URL */}
          <input
            name="imageName"
            placeholder="图片 URL"
            value={character.imageName}
            onChange={handleChange}
            className="w-full p-1 border rounded"
          />
          {/* 模型相关字段：下拉选择模型提供商与具体模型名称 */}
          <div className="flex flex-col space-y-2">
            <div className="flex items-center space-x-4">
              {/* 模型提供商下拉 */}
              <div className="flex items-center">
                <label htmlFor="modelProvider" className="text-gray-700 mr-2">
                  模型提供商:
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
              {/* 具体模型名称 */}
              <div className="flex items-center">
                <label htmlFor="modelName" className="text-gray-700 mr-2">
                  模型名称:
                </label>
                <input
                  id="modelName"
                  name="modelName"
                  type="text"
                  value={character.modelName}
                  onChange={handleChange}
                  placeholder="例如: chatgpt3.5 或 gemini1.5"
                  className="p-1 border rounded"
                />
              </div>
            </div>
            {/* 模型 API Key */}
            <input
              name="modelApiKey"
              placeholder="模型 API Key"
              value={character.modelApiKey}
              onChange={handleChange}
              className="w-full p-1 border rounded"
            />
          </div>
          <button
            type="submit"
            className="w-full bg-blue-500 text-white py-1 rounded hover:bg-blue-600 text-sm"
          >
            保存
          </button>
        </form>
      </div>
    </div>
  );
};

export default AddCharacterPage;