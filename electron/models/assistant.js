const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

// 保存路径：Documents/PetGPT_Data/assistants.json
const filename = 'assistants.json';
const filePath = path.join(app.getPath('documents') + '/PetGPT_Data', filename);

// 读取 JSON 数据
async function readData() {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// 写入 JSON 数据
async function writeData(data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

class Assistant {
  constructor(
    _id,
    name,
    systemInstruction,
    appearance,
    imageName,
    modelConfigId,  // 关联的 Model Config ID
    hasMood
  ) {
    this._id = _id || uuidv4();
    this.name = name || '';
    this.systemInstruction = systemInstruction || '';
    this.appearance = appearance || '';
    this.imageName = imageName || 'default';
    this.modelConfigId = modelConfigId || '';  // 引用 ModelConfig
    this.hasMood = typeof hasMood === 'boolean' ? hasMood : true;
  }

  static async findAll() {
    return await readData();
  }

  static async findById(_id) {
    const assistants = await readData();
    return assistants.find(a => a._id === _id);
  }

  static async create(assistantData) {
    const assistants = await readData();
    const newAssistant = new Assistant(
      null,
      assistantData.name,
      assistantData.systemInstruction || assistantData.personality || '',
      assistantData.appearance,
      assistantData.imageName,
      assistantData.modelConfigId,
      assistantData.hasMood
    );
    assistants.push(newAssistant);
    await writeData(assistants);
    return newAssistant;
  }

  static async update(_id, updatedData) {
    const assistants = await readData();
    const index = assistants.findIndex(a => a._id === _id);
    if (index === -1) return null;

    // 向后兼容：支持 personality
    if (updatedData.personality && !updatedData.systemInstruction) {
      updatedData.systemInstruction = updatedData.personality;
      delete updatedData.personality;
    }

    assistants[index] = {
      ...assistants[index],
      ...updatedData
    };

    await writeData(assistants);
    return assistants[index];
  }

  static async delete(_id) {
    const assistants = await readData();
    const index = assistants.findIndex(a => a._id === _id);
    if (index === -1) return null;

    const deleted = assistants.splice(index, 1)[0];
    await writeData(assistants);
    return deleted;
  }
}

module.exports = Assistant;
