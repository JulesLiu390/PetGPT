import React, { useState } from "react";
import AddCharacterTitleBar from "./AddCharacterTitleBar";

const AddCharacterPage = () => {
  const [character, setCharacter] = useState({
    name: "",
    personality: "",
    appearance: "",
    stats: "",
    imageName: "",
  });

  const handleChange = (e) => {
    setCharacter({ ...character, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    console.log("提交角色信息：", character);
  };

  return (
    <div className="flex flex-col h-screen w-full items-center bg-white">
      <AddCharacterTitleBar />
      <div className="w-[90%] p-2 mt-2 bg-gray-50 rounded-lg shadow">
        <h2 className="text-base font-semibold mb-2 text-center">添加角色</h2>
        <form onSubmit={handleSubmit} className="space-y-2 text-sm">
          <input
            name="name"
            placeholder="名称"
            value={character.name}
            onChange={handleChange}
            className="w-full p-1 border rounded focus:outline-none"
          />

          <textarea
            name="personality"
            placeholder="人格"
            value={character.personality}
            onChange={handleChange}
            className="w-full p-1 border rounded resize-none h-12"
          />

          <textarea
            name="appearance"
            placeholder="外观"
            value={character.appearance}
            onChange={handleChange}
            className="w-full p-1 border rounded resize-none h-12"
          />

          <textarea
            name="stats"
            placeholder="属性"
            value={character.stats}
            onChange={handleChange}
            className="w-full p-1 border rounded resize-none h-12"
          />

          <input
            name="imageName"
            placeholder="图片名"
            value={character.imageName}
            onChange={handleChange}
            className="w-full p-1 border rounded"
          />

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