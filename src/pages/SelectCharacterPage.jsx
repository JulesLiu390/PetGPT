import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import SelectCharacterTitleBar from '../components/Layout/SelectCharacterTitleBar';
import { FaPlus, FaPen } from 'react-icons/fa6';
import { FaRobot, FaCogs } from 'react-icons/fa';
import { PageLayout, Surface, Card, Tabs, Button, EmptyState, Badge } from '../components/UI/ui';
import * as bridge from '../utils/bridge';

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
          const base64Image = await bridge.readPetImage(`${imageName}-normal.png`);
          setImgSrc(base64Image);
        }
      } catch (error) {
        console.error("Error loading image:", error);
      }
    };
    loadImage();
  }, [imageName]);

  return (
    <div className="w-16 h-16 rounded-xl overflow-hidden bg-slate-100 shrink-0">
      <img src={imgSrc} alt="Character" className="w-full h-full object-cover" />
    </div>
  );
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
      const modelData = await bridge.getModelConfigs();
      const assistantData = await bridge.getAssistants();
      
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

    const cleanup = bridge.onPetsUpdated(petsUpdateHandler);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const handleSelect = async (assistant) => {
    console.log('[SelectCharacterPage] handleSelect called with:', assistant);
    // 发送 assistant ID (兼容旧的 character-id)
    await bridge.sendCharacterId(assistant._id);
    console.log('[SelectCharacterPage] sendCharacterId done');
    // 隐藏选择窗口，显示 chat 窗口
    await bridge.hideSelectCharacterWindow();
    console.log('[SelectCharacterPage] hideSelectCharacterWindow done');
    await bridge.showChatWindow();
    console.log('[SelectCharacterPage] showChatWindow done');
  };

  const handleDeleteModel = async (modelId) => {
    if (!confirm("Are you sure you want to delete this model configuration?")) return;
    try {
      await bridge.deleteModelConfig(modelId);
      fetchData();
    } catch (error) {
      alert("删除 Model 失败: " + error.message);
    }
  };

  const handleDeleteAssistant = async (assistantId) => {
    if (!confirm("Are you sure you want to delete this assistant?")) return;
    try {
      await bridge.deleteAssistant(assistantId);
      fetchData();
    } catch (error) {
      alert("删除 Assistant 失败: " + error.message);
    }
  };

  return (
    <PageLayout className="bg-white/95">
      <div className="flex flex-col h-screen w-full overflow-hidden">
        <div className="shrink-0">
          <SelectCharacterTitleBar />
        </div>
        
        {/* 固定的 Tabs + Button 区域 */}
        <div className="shrink-0 px-4 pt-4 pb-2 flex items-center justify-between gap-3">
          <Tabs
            tabs={[
              { id: 'assistants', label: `Assistants (${assistants.length})` },
              { id: 'models', label: `Models (${models.length})` },
            ]}
            active={activeTab}
            onChange={setActiveTab}
          />

          {activeTab === 'assistants' ? (
            <Button variant="primary" onClick={() => navigate('/addAssistant')}>
              <FaPlus className="w-4 h-4" />
              New Assistant
            </Button>
          ) : (
            <Button variant="primary" onClick={() => navigate('/addCharacter')}>
              <FaPlus className="w-4 h-4" />
              New Model
            </Button>
          )}
        </div>

        {/* 内容区域 - 滚动在 Surface 内部 */}
        <div className="flex-1 min-h-0 px-4 pb-4">
          <Surface className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4">
              {activeTab === 'assistants' && (
                <Card
                  title="Select an Assistant"
                  description="Choose an assistant to start chatting."
                  className="bg-transparent border-transparent shadow-none"
                >
                  <div className="grid grid-cols-1 gap-3">
                    {assistants.length === 0 ? (
                      <EmptyState
                        title="No assistants yet"
                        description="Create one to get started."
                        icon={<FaRobot className="w-9 h-9" />}
                        action={
                          <Button variant="primary" onClick={() => navigate('/addAssistant')}>
                            <FaPlus className="w-4 h-4" />
                            New Assistant
                          </Button>
                        }
                      />
                    ) : (
                      assistants.map((assistant) => {
                        const linkedModel = models.find((m) => m._id === assistant.modelConfigId);
                        return (
                          <div
                            key={assistant._id}
                            className="bg-white border border-slate-200 shadow-sm rounded-xl p-4 flex items-start gap-4"
                          >
                            <CustomImage imageName={assistant.imageName} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-slate-900 truncate">
                                    {assistant.name}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-2">
                                    <Badge tone="blue">
                                      <FaRobot className="w-3 h-3" />
                                      Assistant
                                    </Badge>
                                    {linkedModel ? (
                                      <Badge tone="purple">
                                        <FaCogs className="w-3 h-3" />
                                        {linkedModel.name}
                                      </Badge>
                                    ) : (
                                      <Badge tone="red">Model not set</Badge>
                                    )}
                                  </div>
                                </div>
                                <div className="shrink-0 flex items-center gap-2">
                                  <Button variant="primary" onClick={() => handleSelect(assistant)}>
                                    Select
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    onClick={() => navigate(`/editAssistant?id=${assistant._id}`)}
                                    title="Edit Assistant"
                                  >
                                    <FaPen className="w-4 h-4" />
                                  </Button>
                                  <Button
                                    variant="danger"
                                    onClick={() => handleDeleteAssistant(assistant._id)}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </div>

                              <div className="mt-3 space-y-2">
                                <TruncatedText
                                  label="System Instruction"
                                  text={assistant.systemInstruction}
                                />
                                <TruncatedText label="Appearance" text={assistant.appearance} />
                                <div className="text-sm text-gray-600">
                                  <span className="font-medium">Model:</span>{' '}
                                  {linkedModel ? `${linkedModel.name} (${linkedModel.modelName})` : 'Not configured'}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </Card>
              )}

              {activeTab === 'models' && (
                <Card
                  title="Model Configurations"
                  description="Manage your model endpoints and credentials."
                  className="bg-transparent border-transparent shadow-none"
                >
                  <div className="grid grid-cols-1 gap-3">
                    {models.length === 0 ? (
                      <EmptyState
                        title="No model configurations yet"
                        description="Add a model configuration to start creating assistants."
                        icon={<FaCogs className="w-9 h-9" />}
                        action={
                          <Button variant="primary" onClick={() => navigate('/addCharacter')}>
                            <FaPlus className="w-4 h-4" />
                            New Model
                          </Button>
                        }
                      />
                    ) : (
                      models.map((model) => (
                        <div
                          key={model._id}
                          className="bg-white border border-slate-200 shadow-sm rounded-xl p-4 flex items-start gap-4"
                        >
                          <div className="w-12 h-12 rounded-xl bg-purple-50 border border-purple-100 flex items-center justify-center shrink-0">
                            <FaCogs className="w-5 h-5 text-purple-700" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-slate-900 truncate">
                                  {model.name}
                                </div>
                                <div className="mt-2 space-y-1 text-xs text-slate-600">
                                  <div>
                                    <span className="font-semibold text-slate-700">Model:</span>{' '}
                                    {model.modelName || 'N/A'}
                                  </div>
                                  <div>
                                    <span className="font-semibold text-slate-700">API Format:</span>{' '}
                                    {model.apiFormat || model.modelProvider || 'N/A'}
                                  </div>
                                  <div className="truncate">
                                    <span className="font-semibold text-slate-700">URL:</span>{' '}
                                    {model.modelUrl === 'default' ? 'Default' : (model.modelUrl || 'N/A')}
                                  </div>
                                </div>
                              </div>

                              <div className="shrink-0 flex items-center gap-2">
                                <Button
                                  variant="secondary"
                                  onClick={() => navigate(`/editModel?id=${model._id}`)}
                                  title="Edit Model"
                                >
                                  <FaPen className="w-4 h-4" />
                                </Button>
                                <Button variant="danger" onClick={() => handleDeleteModel(model._id)}>
                                  Delete
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </Card>
              )}
            </div>
          </Surface>
        </div>
      </div>
    </PageLayout>
  );
};

export default SelectCharacterPage;