import React, { useState, useEffect } from 'react';
import SelectCharacterTitleBar from './SelectCharacterTitleBar';
import { useStateValue } from '../content/StateProvider';

const SelectCharacterPage = () => {
  const [pets, setPets] = useState([]);

  const fetchPets = async () => {
    try {
      const data = await window.electron.getPets();
      if (Array.isArray(data)) {
        setPets(data);
      } else {
        console.error("getPets 返回的数据格式不正确:", data);
      }
    } catch (error) {
      alert("读取角色失败: " + error.message);
    }
  };

  // 初次加载
  useEffect(() => {
    fetchPets();
  }, []);

  // 监听 pets 更新事件（如果你实现了）
  useEffect(() => {
    const petsUpdateHandler = () => {
      console.log("Received pets update");
      fetchPets();
    };

    if (window.electron?.onPetsUpdated) {
      window.electron.onPetsUpdated(petsUpdateHandler);
    }

    return () => {
      // 清除监听（可选）
      // window.electron.removePetsUpdated(petsUpdateHandler);
    };
  }, []);

  // 选择按钮点击事件
  const handleSelect = (pet) => {
    window.electron?.sendCharacterId(pet._id);
  };

  // 删除角色
  const handleDelete = async (petId) => {
    try {
      await window.electron.deletePet(petId);
      fetchPets(); // 删除后刷新
    } catch (error) {
      alert("删除角色失败: " + error.message);
    }
  };

  // 示例保存功能（可以保留）
  const handleSave = async () => {
    const data = {
      name: 'Jules Liu',
      location: 'Toronto',
      hobby: ['coding', 'cooking', 'fashion'],
    };

    const result = await window.electron.writeJSON(data);
    if (result.success) {
      alert(`保存成功！文件路径：\n${result.path}`);
    } else {
      alert(`保存失败：${result.error}`);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full items-center bg-[rgba(255,255,255,0.8)]">
      <SelectCharacterTitleBar />
      <div className="w-[90%] p-2 mt-2 bg-gray-50 rounded-lg shadow max-h-[400px] overflow-y-auto">
        <h2 className="text-sm font-semibold mb-2 text-center">Select a Character</h2>
        <div className="grid grid-cols-1 gap-2">
          {pets.map((pet) => (
            <div key={pet._id} className="flex items-center p-2 bg-white rounded shadow">
              <img
                src={pet.imageName}
                alt={pet.name}
                className="w-12 h-12 rounded object-cover mr-2"
              />
              <div>
                <div className="text-base font-semibold">{pet.name}</div>
                <div className="text-sm text-gray-600">Personality: {pet.personality}</div>
                {pet.appearance && (
                  <div className="text-sm text-gray-500">Appearance: {pet.appearance}</div>
                )}
                <div className="text-sm text-gray-600">
                  Model: {pet.modelName || 'N/A'} (Type: {pet.modelType || 'N/A'}) | Provider: {pet.modelProvider || 'N/A'}
                </div>
              </div>
              <button
                onClick={() => handleSelect(pet)}
                className="ml-auto bg-blue-500 text-white py-1 px-2 rounded text-xs hover:bg-blue-600"
              >
                Select
              </button>
              <button
                onClick={() => handleDelete(pet._id)}
                className="ml-2 bg-red-500 text-white py-1 px-2 rounded text-xs hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SelectCharacterPage;