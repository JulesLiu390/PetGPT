import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import SelectCharacterTitleBar from '../components/Layout/SelectCharacterTitleBar';
import { FaPlus, FaPen } from 'react-icons/fa6';
import { FaRobot } from 'react-icons/fa';
import { PageLayout, Button, Badge } from '../components/UI/ui';
import * as tauri from '../utils/tauri';

const CustomImage = ({ imageName }) => {
  const [imgSrc, setImgSrc] = useState("");

  useEffect(() => {
    const loadImage = async () => {
      try {
        // 内置皮肤：Jules (default)、Maodie、LittlePony
        if (imageName === "default" || imageName === "Jules") {
          const module = await import(`../assets/Jules-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "Maodie") {
          const module = await import(`../assets/Maodie-normal.png`);
          setImgSrc(module.default);
        } else if(imageName === "LittlePony") {
          const module = await import(`../assets/LittlePony-normal.png`);
          setImgSrc(module.default);
        } else {
          // 其他皮肤从文件系统加载
          const base64Image = await tauri.readPetImage(`${imageName}-normal.png`);
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
  const [assistants, setAssistants] = useState([]);
  const navigate = useNavigate();

  const fetchData = async () => {
    // 规范化 id 字段（Tauri 返回 id，前端期望 _id）
    const normalizeId = (item) => ({ ...item, _id: item._id || item.id });
    
    try {
      const assistantData = await tauri.getAssistants();
      console.log('[SelectCharacterPage] assistantData:', assistantData);
      if (Array.isArray(assistantData)) {
        setAssistants(assistantData.map(normalizeId));
      }
    } catch (error) {
      console.error("Failed to load assistants:", error);
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

    const cleanup = tauri.onPetsUpdated(petsUpdateHandler);
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  const handleSelect = async (assistant) => {
    console.log('[SelectCharacterPage] handleSelect called with:', assistant);
    // 先隐藏选择窗口，显示 chat 窗口
    await tauri.hideSelectCharacterWindow();
    console.log('[SelectCharacterPage] hideSelectCharacterWindow done');
    await tauri.showChatWindow();
    console.log('[SelectCharacterPage] showChatWindow done');
    // 等待 chat 窗口加载完成（给 React 组件时间挂载和设置事件监听器）
    await new Promise(resolve => setTimeout(resolve, 200));
    // 然后发送 assistant ID (兼容旧的 character-id)
    await tauri.sendCharacterId(assistant._id);
    console.log('[SelectCharacterPage] sendCharacterId done');
  };

  const handleDeleteAssistant = async (assistantId) => {
    const confirmed = await tauri.confirm("Are you sure you want to delete this assistant?", { title: "Delete Assistant" });
    if (!confirmed) return;
    
    try {
      await tauri.deleteAssistant(assistantId);
      fetchData();
    } catch (error) {
      console.error("Delete failed:", error);
      const msg = error.message || (typeof error === 'string' ? error : JSON.stringify(error));
      alert("Failed to delete assistant: " + msg);
    }
  };

  return (
    <PageLayout className="bg-white/95">
      <div className="flex flex-col h-screen w-full">
        {/* Fixed header area */}
        <div className="shrink-0">
          <SelectCharacterTitleBar />
          {/* Title + New button */}
          <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-slate-100">
            <div className="text-base font-semibold text-slate-800">
              Assistants ({assistants.length})
            </div>
            <Button variant="primary" onClick={() => navigate('/addAssistant')}>
              <FaPlus className="w-4 h-4" />
              New
            </Button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {assistants.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <FaRobot className="w-12 h-12 text-slate-300 mb-4" />
              <div className="text-slate-600 font-medium">No assistants yet</div>
              <div className="text-slate-400 text-sm mb-4">Create one to get started</div>
              <Button variant="primary" onClick={() => navigate('/addAssistant')}>
                <FaPlus className="w-4 h-4" />
                New Assistant
              </Button>
            </div>
          ) : (
            assistants.map((assistant) => (
              <div
                key={assistant._id}
                className="bg-white border border-slate-200 shadow-sm rounded-xl p-3 flex items-start gap-3"
              >
                <CustomImage imageName={assistant.imageName} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 truncate">
                        {assistant.name}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {assistant.modelName ? (
                          <Badge tone="purple">{assistant.modelName}</Badge>
                        ) : (
                          <Badge tone="red">No model</Badge>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                      <Button variant="primary" onClick={() => handleSelect(assistant)}>
                        Select
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => navigate(`/editAssistant?id=${assistant._id}`)}
                        title="Edit"
                      >
                        <FaPen className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => handleDeleteAssistant(assistant._id)}
                        title="Delete"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {(assistant.systemInstruction || assistant.appearance) && (
                    <div className="mt-2 space-y-1">
                      <TruncatedText label="Instruction" text={assistant.systemInstruction} />
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </PageLayout>
  );
};

export default SelectCharacterPage;