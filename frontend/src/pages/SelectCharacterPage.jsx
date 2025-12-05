import React, { useState, useEffect } from 'react';
import SelectCharacterTitleBar from '../components/Layout/SelectCharacterTitleBar';

const CustomImage = ({ imageName }) => {
  const [imgSrc, setImgSrc] = useState("");

  useEffect(() => {
    const loadImage = async () => {
      try {
        if (imageName === "default") {
          const module = await import(`../assets/default-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Opai") {
          const module = await import(`../assets/Opai-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Claudia") {
          const module = await import(`../assets/Claudia-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Grocka") {
          const module = await import(`../assets/Grocka-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Gemina") {
          const module = await import(`../assets/Gemina-normal.png`);
          setImgSrc(module.default);
        } else {
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

const TruncatedText = ({ label, text }) => {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  const isLong = text.length > 80;
  const displayText = expanded || !isLong ? text : text.slice(0, 80) + '...';

  return (
    <div className="text-sm text-gray-600">
      <span className="font-medium">{label}: </span>
      {displayText}
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-1 text-blue-500 hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
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

  useEffect(() => {
    fetchPets();
  }, []);

  useEffect(() => {
    const petsUpdateHandler = () => {
      console.log("Received pets update");
      fetchPets();
    };

    if (window.electron?.onPetsUpdated) {
      window.electron.onPetsUpdated(petsUpdateHandler);
    }
    return () => {
      // window.electron.removePetsUpdated(petsUpdateHandler);
    };
  }, []);

  const handleSelect = (pet) => {
    window.electron?.sendCharacterId(pet._id);    
    alert("Character Selected")
    window.electron?.sendMoodUpdate('normal');
  };

  const handleDelete = async (petId) => {
    try {
      await window.electron.deletePet(petId);
      fetchPets();
    } catch (error) {
      alert("删除角色失败: " + error.message);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full items-center bg-[rgba(255,255,255,0.8)]">
      <SelectCharacterTitleBar />
      <div className="w-[90%] p-2 mt-2 bg-gray-50 rounded-lg shadow max-h-full overflow-y-auto">
        <h2 className="text-sm font-semibold mb-2 text-center">Select a Character</h2>
        <div className="grid grid-cols-1 gap-2">
          {pets.map((pet) => (
            <div key={pet._id} className="flex items-start p-2 bg-white rounded shadow">
              <CustomImage imageName={pet.imageName} />
              <div className="flex-1">
                <div className="text-base font-semibold">{pet.name}</div>
                <TruncatedText label="Personality" text={pet.personality} />
                <TruncatedText label="Appearance" text={pet.appearance} />
                <div className="text-sm text-gray-600">
                  <span className="font-medium">Model:</span> {pet.modelName || 'N/A'} (Type: {pet.modelType || 'N/A'}) | Provider: {pet.modelProvider || 'N/A'}
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