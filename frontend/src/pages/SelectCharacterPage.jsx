import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import SelectCharacterTitleBar from '../components/Layout/SelectCharacterTitleBar';
import { FaPlus, FaPen } from 'react-icons/fa6';
import { FaRobot, FaCogs } from 'react-icons/fa';

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
  const [models, setModels] = useState([]);
  const [assistants, setAssistants] = useState([]);
  const [activeTab, setActiveTab] = useState('assistants'); // 'assistants' or 'models'
  const navigate = useNavigate();

  const fetchData = async () => {
    try {
      // 分别获取 Models 和 Assistants
      const modelData = await window.electron.getModelConfigs();
      const assistantData = await window.electron.getAssistants();
      
      if (Array.isArray(modelData)) {
        setModels(modelData);
      }
      if (Array.isArray(assistantData)) {
        setAssistants(assistantData);
      }
    } catch (error) {
      console.error("读取数据失败:", error);
      alert("读取数据失败: " + error.message);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const petsUpdateHandler = () => {
      console.log("Received pets update");
      fetchData();
    };

    if (window.electron?.onPetsUpdated) {
      window.electron.onPetsUpdated(petsUpdateHandler);
    }
    return () => {
      // window.electron.removePetsUpdated(petsUpdateHandler);
    };
  }, []);

  const handleSelect = async (assistant) => {
    // 获取关联的 ModelConfig
    let modelConfig = null;
    if (assistant.modelConfigId) {
      modelConfig = await window.electron.getModelConfig(assistant.modelConfigId);
    }
    
    // 发送 assistant ID (兼容旧的 character-id)
    window.electron?.sendCharacterId(assistant._id);
    alert("Assistant Selected");
    window.electron?.sendMoodUpdate('normal');
  };

  const handleDeleteModel = async (modelId) => {
    if (!confirm("Are you sure you want to delete this model configuration?")) return;
    try {
      await window.electron.deleteModelConfig(modelId);
      fetchData();
    } catch (error) {
      alert("删除 Model 失败: " + error.message);
    }
  };

  const handleDeleteAssistant = async (assistantId) => {
    if (!confirm("Are you sure you want to delete this assistant?")) return;
    try {
      await window.electron.deleteAssistant(assistantId);
      fetchData();
    } catch (error) {
      alert("删除 Assistant 失败: " + error.message);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full items-center bg-[rgba(255,255,255,0.8)]">
      <SelectCharacterTitleBar />
      
      {/* Tab Bar */}
      <div className="w-[90%] flex mt-2 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('assistants')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'assistants'
              ? 'border-b-2 border-blue-500 text-blue-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <FaRobot className="w-4 h-4" />
          Assistants ({assistants.length})
        </button>
        <button
          onClick={() => setActiveTab('models')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'models'
              ? 'border-b-2 border-purple-500 text-purple-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <FaCogs className="w-4 h-4" />
          Models ({models.length})
        </button>
      </div>
      
      <div className="w-[90%] p-2 mt-2 bg-gray-50 rounded-lg shadow max-h-full overflow-y-auto">
        {/* Assistants Tab */}
        {activeTab === 'assistants' && (
          <>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-sm font-semibold">Select an Assistant</h2>
              <button
                onClick={() => navigate('/addAssistant')}
                className="flex items-center gap-1 px-2 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600"
              >
                <FaPlus className="w-3 h-3" />
                New Assistant
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {assistants.length === 0 ? (
                <div className="text-center text-gray-500 py-4 text-sm">
                  No assistants yet. Create one to get started!
                </div>
              ) : (
                assistants.map((assistant) => {
                  // 查找关联的 Model Config
                  const linkedModel = models.find(m => m._id === assistant.modelConfigId);
                  return (
                  <div key={assistant._id} className="flex items-start p-2 bg-white rounded shadow">
                    <CustomImage imageName={assistant.imageName} />
                    <div className="flex-1">
                      <div className="text-base font-semibold">{assistant.name}</div>
                      <TruncatedText label="System Instruction" text={assistant.systemInstruction} />
                      <TruncatedText label="Appearance" text={assistant.appearance} />
                      <div className="text-sm text-gray-600">
                        <span className="font-medium">Model:</span> {linkedModel ? `${linkedModel.name} (${linkedModel.modelName})` : 'Not configured'}
                      </div>
                    </div>
                    <button
                      onClick={() => handleSelect(assistant)}
                      className="ml-auto bg-blue-500 text-white py-1 px-2 rounded text-xs hover:bg-blue-600"
                    >
                      Select
                    </button>
                    <button
                      onClick={() => navigate(`/editAssistant?id=${assistant._id}`)}
                      className="ml-2 bg-gray-500 text-white py-1 px-2 rounded text-xs hover:bg-gray-600"
                      title="Edit Assistant"
                    >
                      <FaPen className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDeleteAssistant(assistant._id)}
                      className="ml-2 bg-red-500 text-white py-1 px-2 rounded text-xs hover:bg-red-600"
                    >
                      Delete
                    </button>
                  </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* Models Tab */}
        {activeTab === 'models' && (
          <>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-sm font-semibold">Model Configurations</h2>
              <button
                onClick={() => navigate('/addCharacter')}
                className="flex items-center gap-1 px-2 py-1 bg-purple-500 text-white rounded text-xs hover:bg-purple-600"
              >
                <FaPlus className="w-3 h-3" />
                New Model
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {models.length === 0 ? (
                <div className="text-center text-gray-500 py-4 text-sm">
                  No model configurations yet. Add one to get started!
                </div>
              ) : (
                models.map((model) => (
                  <div key={model._id} className="flex items-center p-2 bg-white rounded shadow">
                    <div className="w-10 h-10 rounded bg-purple-100 flex items-center justify-center mr-2">
                      <FaCogs className="w-5 h-5 text-purple-600" />
                    </div>
                    <div className="flex-1">
                      <div className="text-base font-semibold">{model.name}</div>
                      <div className="text-sm text-gray-600">
                        <span className="font-medium">Model:</span> {model.modelName || 'N/A'}
                      </div>
                      <div className="text-sm text-gray-600">
                        <span className="font-medium">API Format:</span> {model.apiFormat || model.modelProvider || 'N/A'}
                      </div>
                      <div className="text-sm text-gray-600">
                        <span className="font-medium">URL:</span> {model.modelUrl === 'default' ? 'Default' : (model.modelUrl || 'N/A')}
                      </div>
                    </div>
                    <button
                      onClick={() => navigate(`/editModel?id=${model._id}`)}
                      className="ml-2 bg-purple-500 text-white py-1 px-2 rounded text-xs hover:bg-purple-600"
                      title="Edit Model"
                    >
                      <FaPen className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDeleteModel(model._id)}
                      className="ml-2 bg-red-500 text-white py-1 px-2 rounded text-xs hover:bg-red-600"
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default SelectCharacterPage;