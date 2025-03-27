import React, { useState } from "react";
import AddCharacterTitleBar from "./AddCharacterTitleBar";

const AddCharacterPage = () => {
  const [character, setCharacter] = useState({
    name: "",
    personality: "",
    appearance: "",
    imageName: "",
    modelProvider: "openai",
    modelName: "",
    modelApiKey: ""
  });

  const handleChange = (e) => {
    setCharacter({ ...character, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      // 调用 Electron 提供的 createPet 方法
      const newPet = await window.electron?.createPet(character);

      if (!newPet || !newPet._id) {
        throw new Error("创建失败或未返回 ID");
      }

      // 通知主进程：新角色 ID
      window.electron?.sendCharacterId(newPet._id);
      window.electron?.sendPetsUpdate(newPet);

      // 清空表单
      setCharacter({
        name: "",
        personality: "",
        appearance: "",
        imageName: "",
        modelProvider: "openai",
        modelName: "",
        modelApiKey: ""
      });
    } catch (error) {
      console.error("Error creating pet:", error.message);
      window.electron?.sendCharacterId(null);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full items-center bg-[rgba(255,255,255,0.8)]">
      <AddCharacterTitleBar />
      <div className="w-[90%] p-2 mt-2 bg-gray-50 rounded-lg shadow">
        <h2 className="text-base font-semibold mb-2 text-center">Add Character</h2>
        <form onSubmit={handleSubmit} className="space-y-2 text-sm">
          <input
            name="name"
            placeholder="Name"
            value={character.name}
            onChange={handleChange}
            className="w-full p-1 border rounded focus:outline-none"
          />
          <textarea
            name="personality"
            placeholder="Personality Description"
            value={character.personality}
            onChange={handleChange}
            className="w-full p-1 border rounded resize-none h-12"
          />
          <textarea
            name="appearance"
            placeholder="Appearance Description"
            value={character.appearance}
            onChange={handleChange}
            className="w-full p-1 border rounded resize-none h-12"
          />
          <input
            name="imageName"
            placeholder="Image URL"
            value={character.imageName}
            onChange={handleChange}
            className="w-full p-1 border rounded"
          />
          {/* Model-related fields */}
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