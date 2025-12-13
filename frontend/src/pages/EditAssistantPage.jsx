import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FaCheck, FaSpinner } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";

const EditAssistantPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const petId = searchParams.get('id');
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modelConfigs, setModelConfigs] = useState([]); // 可用的 Model Configs
  
  const [assistantConfig, setAssistantConfig] = useState({
    name: "",
    systemInstruction: "",
    appearance: "",
    imageName: "default",
    hasMood: true,
    modelConfigId: "", // 关联的 Model Config ID
  });

  // 加载现有 Assistant 数据
  useEffect(() => {
    const loadData = async () => {
      if (!petId) {
        alert("No assistant ID provided");
        navigate('/selectCharacter');
        return;
      }
      
      try {
        // 加载所有 Model Configs (使用新的 API)
        const models = await window.electron?.getModelConfigs();
        if (Array.isArray(models)) {
          setModelConfigs(models);
        }

        // 加载当前 assistant (使用新的 API)
        const assistant = await window.electron?.getAssistant(petId);
        if (assistant) {
          // hasMood 向后兼容
          const computedHasMood = typeof assistant.hasMood === 'boolean' ? assistant.hasMood : true;
          setAssistantConfig({
            name: assistant.name || "",
            systemInstruction: assistant.systemInstruction || "",
            appearance: assistant.appearance || "",
            imageName: assistant.imageName || "default",
            hasMood: computedHasMood,
            modelConfigId: assistant.modelConfigId || "",
          });
        } else {
          alert("Assistant not found");
          navigate('/selectCharacter');
        }
      } catch (error) {
        console.error("Failed to load assistant:", error);
        alert("Failed to load assistant: " + error.message);
        navigate('/selectCharacter');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [petId, navigate]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    
    if (type === 'checkbox') {
      setAssistantConfig(prev => ({ ...prev, [name]: checked }));
      return;
    }
    
    setAssistantConfig(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!assistantConfig.name.trim()) {
      alert("Please enter an assistant name.");
      return;
    }

    if (!assistantConfig.modelConfigId) {
      alert("Please select a model configuration.");
      return;
    }

    setSaving(true);
    try {
      const updateData = {
        name: assistantConfig.name,
        systemInstruction: assistantConfig.systemInstruction,
        appearance: assistantConfig.appearance,
        imageName: assistantConfig.imageName,
        hasMood: assistantConfig.hasMood,
        modelConfigId: assistantConfig.modelConfigId,
      };

      const updatedAssistant = await window.electron?.updateAssistant(petId, updateData);
      
      // 通知所有组件更新列表
      window.electron?.sendPetsUpdate(updatedAssistant);
      
      // 重新发送 characterId 以刷新当前选中角色的内存数据
      window.electron?.sendCharacterId(petId);
      
      alert("Assistant updated successfully!");
      navigate('/selectCharacter');
      
    } catch (error) {
      console.error("Error updating assistant:", error);
      alert("Failed to update assistant: " + error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col items-center justify-center">
        <FaSpinner className="animate-spin text-2xl text-blue-500" />
        <p className="mt-2 text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[rgba(255,255,255,0.95)] flex flex-col overflow-hidden">
      <div className="sticky top-0 z-10">
        {/* Simple TitleBar */}
        <div className="draggable w-full h-12 flex justify-between items-center px-3 border-b border-gray-100">
          <MdCancel 
            className="no-drag hover:text-gray-800 text-gray-400 cursor-pointer"
            onClick={() => navigate('/selectCharacter')}
          />
          <span className="font-bold text-gray-700 text-sm">EDIT ASSISTANT</span>
          <div className="w-5"></div>
        </div>
      </div>
      
      <div className="w-[90%] flex-1 mx-auto bg-gray-50 rounded-lg shadow-sm border border-gray-100 p-4 overflow-y-auto mb-4 scrollbar-hide mt-4">
        <form onSubmit={handleSubmit} className="space-y-4 text-sm h-full flex flex-col">
            
            <div className="bg-blue-50 p-3 rounded-md border border-blue-100 text-blue-800 text-xs">
                <strong>Edit Assistant</strong><br/>
                Update your assistant's settings and system instruction.
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Assistant Name <span className="text-red-500">*</span></label>
                <input
                    name="name"
                    placeholder="e.g. My Helper, Code Assistant..."
                    value={assistantConfig.name}
                    onChange={handleChange}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-300 outline-none"
                    required
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">System Instruction</label>
                <textarea
                    name="systemInstruction"
                    placeholder="Describe how the assistant should behave..."
                    value={assistantConfig.systemInstruction}
                    onChange={handleChange}
                    rows={4}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-300 outline-none resize-none"
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Appearance Description (Optional)</label>
                <textarea
                    name="appearance"
                    placeholder="Describe the assistant's appearance for image generation..."
                    value={assistantConfig.appearance}
                    onChange={handleChange}
                    rows={2}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-300 outline-none resize-none"
                />
            </div>

            <div className="flex flex-col space-y-1">
                <label className="text-gray-700 font-medium">Avatar Style</label>
                <select
                    name="imageName"
                    value={assistantConfig.imageName}
                    onChange={handleChange}
                    className="w-full p-2 border rounded"
                >
                    <option value="default">Default</option>
                    <option value="Opai">Opai (OpenAI style)</option>
                    <option value="Gemina">Gemina (Gemini style)</option>
                    <option value="Claudia">Claudia (Claude style)</option>
                    <option value="Grocka">Grocka (Grok style)</option>
                </select>
            </div>

            <div className="flex items-center space-x-2">
                <input
                    type="checkbox"
                    id="hasMood"
                    name="hasMood"
                    checked={assistantConfig.hasMood}
                    onChange={handleChange}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <label htmlFor="hasMood" className="text-gray-700 font-medium cursor-pointer">
                    Enable mood expressions
                </label>
                <span className="text-gray-400 text-xs">(Avatar will show emotions)</span>
            </div>

            {/* Model Configuration Section */}
            <div className="border-t border-gray-200 pt-4 mt-2">
                <h3 className="text-gray-700 font-medium mb-3">Model Configuration</h3>
                
                <div className="flex flex-col space-y-1 mb-3">
                    <label className="text-gray-700 font-medium text-sm">Select Model Config <span className="text-red-500">*</span></label>
                    <select
                        name="modelConfigId"
                        value={assistantConfig.modelConfigId}
                        onChange={handleChange}
                        className="w-full p-2 border rounded"
                        required
                    >
                        <option value="">-- Select a Model --</option>
                        {modelConfigs.map(model => (
                            <option key={model._id} value={model._id}>
                                {model.name} ({model.modelName})
                            </option>
                        ))}
                    </select>
                    <span className="text-gray-400 text-xs">
                        {modelConfigs.length === 0 
                            ? "No model configs available. Create one first!" 
                            : "Select which model configuration this assistant should use"}
                    </span>
                </div>
            </div>

            <div className="mt-auto pt-4">
                <button
                    type="submit"
                    disabled={saving}
                    className={`w-full py-2.5 rounded shadow transition-all transform font-bold ${
                        !saving
                        ? "bg-gradient-to-r from-blue-500 to-blue-700 text-white hover:from-blue-600 hover:to-blue-800 hover:scale-[1.02]" 
                        : "bg-gray-300 text-gray-500 cursor-not-allowed"
                    }`}
                >
                    {saving ? (
                      <span className="flex items-center justify-center gap-2">
                        <FaSpinner className="animate-spin" />
                        Saving...
                      </span>
                    ) : (
                      "Save Changes"
                    )}
                </button>
            </div>

        </form>
      </div>
    </div>
  );
};

export default EditAssistantPage;
