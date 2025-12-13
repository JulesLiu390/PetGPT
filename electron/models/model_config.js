const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

// 保存路径：Documents/PetGPT_Data/models.json
const filename = 'models.json';
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

class ModelConfig {
  constructor(
    _id,
    name,
    apiFormat,
    modelName,
    modelApiKey,
    modelUrl
  ) {
    this._id = _id || uuidv4();
    this.name = name || '';
    this.apiFormat = apiFormat || 'openai_compatible';
    this.modelName = modelName || '';
    this.modelApiKey = modelApiKey || '';
    this.modelUrl = modelUrl || 'default';
  }

  static async findAll() {
    return await readData();
  }

  static async findById(_id) {
    const models = await readData();
    return models.find(model => model._id === _id);
  }

  static async create(modelData) {
    const models = await readData();
    const newModel = new ModelConfig(
      null,
      modelData.name,
      modelData.apiFormat,
      modelData.modelName,
      modelData.modelApiKey,
      modelData.modelUrl
    );
    models.push(newModel);
    await writeData(models);
    return newModel;
  }

  static async update(_id, updatedData) {
    const models = await readData();
    const index = models.findIndex(m => m._id === _id);
    if (index === -1) return null;

    models[index] = {
      ...models[index],
      ...updatedData
    };

    await writeData(models);
    return models[index];
  }

  static async delete(_id) {
    const models = await readData();
    const index = models.findIndex(m => m._id === _id);
    if (index === -1) return null;

    const deleted = models.splice(index, 1)[0];
    await writeData(models);
    return deleted;
  }
}

module.exports = ModelConfig;
