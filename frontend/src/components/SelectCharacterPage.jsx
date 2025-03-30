import React, { useState, useEffect } from 'react';
import SelectCharacterTitleBar from './SelectCharacterTitleBar';

// CustomImage 组件，根据传入的 imageName 决定如何加载图片
const CustomImage = ({ imageName }) => {
  const [imgSrc, setImgSrc] = useState("");

  useEffect(() => {
    const loadImage = async () => {
      try {
        if (imageName === "default") {
          // 如果 imageName 为 "default"，动态导入默认图片（放在 src/assets 中）
          const module = await import(`../assets/default-normal.png`);
          setImgSrc(module.default);
        } else {
          // 如果为自定义图片，则调用 electron 接口读取对应 Base64 数据
          const base64Image = await window.electron.readPetImage(`${imageName}-normal.png`);
          setImgSrc(base64Image);
        }
      } catch (error) {
        console.error("Error loading image:", error);
      }
    };
    loadImage();
  }, [imageName]);

  return <img src={imgSrc} alt="Character" className="w-12 h-12 rounded object-cover mr-2" />;
};

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

  // 初次加载角色
  useEffect(() => {
    fetchPets();
  }, []);

  // 监听 pets 更新事件（如果实现了）
  useEffect(() => {
    const petsUpdateHandler = () => {
      console.log("Received pets update");
      fetchPets();
    };

    if (window.electron?.onPetsUpdated) {
      window.electron.onPetsUpdated(petsUpdateHandler);
    }
    return () => {
      // 可选：清除监听
      // window.electron.removePetsUpdated(petsUpdateHandler);
    };
  }, []);

  // 选择角色
  const handleSelect = (pet) => {
    window.electron?.sendCharacterId(pet._id);
  };

  // 删除角色
  const handleDelete = async (petId) => {
    try {
      await window.electron.deletePet(petId);
      fetchPets(); // 删除后刷新角色列表
    } catch (error) {
      alert("删除角色失败: " + error.message);
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
              {/* 使用 CustomImage 根据 pet.imageName 加载图片 */}
              <CustomImage imageName={pet.imageName} />
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