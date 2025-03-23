import React, { useState, useEffect } from 'react';
import SelectCharacterTitleBar from './SelectCharacterTitleBar';
import { getPets } from '../utlis/api';

const SelectCharacterPage = () => {
  const [pets, setPets] = useState([]);

  const fetchPets = async () => {
    try {
      const data = await getPets();
      if (Array.isArray(data)) {
        setPets(data);
      } else {
        console.error("getPets 返回的数据格式不正确:", data);
      }
    } catch (error) {
      alert("Error: " + error.message);
    }
  };

  useEffect(() => {
    fetchPets();
  }, []);

  // 监听 pets 更新事件
  useEffect(() => {
    const petsUpdateHandler = (updatedData) => {
      console.log("Received pets update:", updatedData);
      fetchPets();
    };

    if (window.electron?.onPetsUpdated) {
      window.electron.onPetsUpdated(petsUpdateHandler);
    }

    return () => {
      // 如果暴露了移除监听接口，则调用：
      // window.electron.removePetsUpdated(petsUpdateHandler);
    };
  }, []);

  // 选择按钮点击事件，alert 显示所有信息
  const handleSelect = (pet) => {
    window.electron?.sendCharacterId(pet._id);
    alert("Sucsess!")
    // alert(
    //   `Selected pet: ${pet.name}\n` +
    //   `Personality: ${pet.personality}\n` +
    //   `Appearance: ${pet.appearance || 'N/A'}\n` +
    //   `Model Name: ${pet.modelName || 'N/A'}\n` +
    //   `Model Type: ${pet.modelType || 'N/A'}\n` +
    //   `Model Provider: ${pet.modelProvider || 'N/A'}`
    // );
  };

  return (
    <div className="flex flex-col h-screen w-full items-center bg-[rgba(255,255,255,0.8)]">
      <SelectCharacterTitleBar />
      <div className="w-[90%] p-2 mt-2 bg-gray-50 rounded-lg shadow max-h-[400px] overflow-y-auto">
        <h2 className="text-sm font-semibold mb-2 text-center">Select a Character</h2>
        <div className="grid grid-cols-1 gap-2">
          {pets.map((pet) => (
            <div key={pet._id} className="flex items-center p-2 bg-white rounded shadow">
              {/* 角色图片 */}
              <img
                src={pet.imageName}
                alt={pet.name}
                className="w-12 h-12 rounded object-cover mr-2"
              />
              {/* 角色信息 */}
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
              {/* 选择按钮 */}
              <button
                onClick={() => handleSelect(pet)}
                className="ml-auto bg-blue-500 text-white py-1 px-2 rounded text-xs hover:bg-blue-600"
              >
                Select
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SelectCharacterPage;