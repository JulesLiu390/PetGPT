import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FaCheck, FaSpinner } from "react-icons/fa6";
import { MdCancel } from "react-icons/md";
import { PageLayout, Surface, Card, FormGroup, Input, Select, Textarea, Button, Alert, Checkbox, Badge } from "../components/UI/ui";
import TitleBar from "../components/UI/TitleBar";
import * as bridge from "../utils/bridge";

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
        const models = await bridge.getModelConfigs();
        if (Array.isArray(models)) {
          setModelConfigs(models);
        }

        // 加载当前 assistant (使用新的 API)
        const assistant = await bridge.getAssistant(petId);
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

      const updatedAssistant = await bridge.updateAssistant(petId, updateData);
      
      // 通知所有组件更新列表
      bridge.sendPetsUpdate(updatedAssistant);
      
      // 重新发送 characterId 以刷新当前选中角色的内存数据
      bridge.sendCharacterId(petId);
      
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
      <PageLayout className="bg-white/95">
        <div className="h-screen flex flex-col items-center justify-center">
          <FaSpinner className="animate-spin text-2xl text-blue-500" />
          <p className="mt-2 text-slate-600 text-sm">Loading...</p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout className="bg-white/95">
      <div className="h-screen flex flex-col overflow-hidden">
        <TitleBar
          title="Edit Assistant"
          left={
            <button
              type="button"
              className="no-drag inline-flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              onClick={() => navigate('/selectCharacter')}
              title="Close"
            >
              <MdCancel className="w-5 h-5" />
            </button>
          }
          height="h-12"
        />
        
        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
          <Surface className="max-w-lg mx-auto p-5">
            <form onSubmit={handleSubmit} className="space-y-5">
              
              <Alert tone="blue">
                <strong>Edit Assistant</strong><br/>
                Update your assistant's settings and system instruction.
              </Alert>

              <FormGroup label="Assistant Name" required>
                <Input
                  name="name"
                  placeholder="e.g. My Helper, Code Assistant..."
                  value={assistantConfig.name}
                  onChange={handleChange}
                  required
                />
              </FormGroup>

              <FormGroup label="System Instruction">
                <Textarea
                  name="systemInstruction"
                  placeholder="Describe how the assistant should behave..."
                  value={assistantConfig.systemInstruction}
                  onChange={handleChange}
                  rows={4}
                />
              </FormGroup>

              <FormGroup label="Appearance Description" hint="Optional - for image generation">
                <Textarea
                  name="appearance"
                  placeholder="Describe the assistant's appearance..."
                  value={assistantConfig.appearance}
                  onChange={handleChange}
                  rows={2}
                />
              </FormGroup>

              <FormGroup label="Avatar Style">
                <Select
                  name="imageName"
                  value={assistantConfig.imageName}
                  onChange={handleChange}
                >
                  <option value="default">Default</option>
                  <option value="Opai">Opai (OpenAI style)</option>
                  <option value="Gemina">Gemina (Gemini style)</option>
                  <option value="Claudia">Claudia (Claude style)</option>
                  <option value="Grocka">Grocka (Grok style)</option>
                </Select>
              </FormGroup>

              <Checkbox
                name="hasMood"
                label="Enable mood expressions (Avatar will show emotions)"
                checked={assistantConfig.hasMood}
                onChange={handleChange}
              />

              {/* Model Configuration Section */}
              <Card title="Model Configuration" description="Select the LLM backend for this assistant" className="bg-slate-50/50">
                <Select
                  name="modelConfigId"
                  value={assistantConfig.modelConfigId}
                  onChange={handleChange}
                  required
                >
                  <option value="">-- Select a Model --</option>
                  {modelConfigs.map(model => (
                    <option key={model._id} value={model._id}>
                      {model.name} ({model.modelName})
                    </option>
                  ))}
                </Select>
                {modelConfigs.length === 0 ? (
                  <div className="mt-2 text-xs text-amber-600">
                    No model configs available. Create one first!
                  </div>
                ) : assistantConfig.modelConfigId && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                    <Badge tone="blue">
                      {modelConfigs.find(m => m._id === assistantConfig.modelConfigId)?.apiFormat || 'Unknown'}
                    </Badge>
                    <span>will power this assistant</span>
                  </div>
                )}
              </Card>

              <div className="pt-2">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={saving}
                  className="w-full py-3"
                >
                  {saving ? (
                    <span className="flex items-center gap-2">
                      <FaSpinner className="animate-spin w-4 h-4" />
                      Saving...
                    </span>
                  ) : "Save Changes"}
                </Button>
              </div>

            </form>
          </Surface>
        </div>
      </div>
    </PageLayout>
  );
};

export default EditAssistantPage;
