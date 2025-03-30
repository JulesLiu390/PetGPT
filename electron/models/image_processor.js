const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const { createCanvas, loadImage } = require('canvas'); // 使用 node-canvas
const { v4: uuidv4 } = require('uuid');               // 引入 uuid 库

/**
 * 获取文档目录下的 PetGPT_Data/Images 目录，如果不存在则创建
 */
function getOutputDir() {
  let documentsPath;
  try {
    documentsPath = app.getPath('documents');
  } catch (e) {
    documentsPath = path.join(os.homedir(), 'Documents');
  }
  
  const outputDir = path.join(documentsPath, 'PetGPT_Data', 'Images');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/**
 * sliceImageToFiles
 * 
 * 将输入的 base64 格式图片切割成四个象限，并保存到本地文件系统中（使用随机 UUID 命名）。
 * 
 * @param {string} base64Image - data URL 格式的图片，例如 "data:image/png;base64,...."
 * @returns {Promise<{ uuid: string, paths: string[] }>} 返回 Promise，解析后得到一个对象：
 *   {
 *     uuid: 生成的UUID字符串,
 *     paths: [ 各切割图片的完整路径, ... ]
 *   }
 */
function sliceImageToFiles(base64Image) {
  return new Promise((resolve, reject) => {
    // 生成一个新的 UUID 作为此次处理的基准前缀
    const newUuid = uuidv4();

    loadImage(base64Image)
      .then((img) => {
        const halfWidth = img.width / 2;
        const halfHeight = img.height / 2;

        // 定义四个象限及其对应的起始坐标和后缀
        const positions = [
          { x: 0, y: 0, key: 'normal' },
          { x: halfWidth, y: 0, key: 'smile' },
          { x: 0, y: halfHeight, key: 'thinking' },
          { x: halfWidth, y: halfHeight, key: 'angry' }
        ];

        const outputDir = getOutputDir();

        // 为每个象限创建子画布并导出
        const fileWritePromises = positions.map((pos) => {
          const subCanvas = createCanvas(halfWidth, halfHeight);
          const subCtx = subCanvas.getContext('2d');

          // 绘制当前象限的图像
          subCtx.drawImage(img, -pos.x, -pos.y, img.width, img.height);

          // 导出为 PNG buffer
          const buffer = subCanvas.toBuffer('image/png');

          // 文件名示例： "<UUID>-normal.png"
          const filename = `${newUuid}-${pos.key}.png`;
          const filePath = path.join(outputDir, filename);

          // 写入本地文件
          return new Promise((res, rej) => {
            fs.writeFile(filePath, buffer, (err) => {
              if (err) {
                rej(err);
              } else {
                res(filePath);
              }
            });
          });
        });

        Promise.all(fileWritePromises)
          .then(paths => {
            // 返回包含 UUID 和生成的文件路径数组
            resolve({ uuid: newUuid, paths });
          })
          .catch(err => reject(err));
      })
      .catch((err) => {
        reject(err);
      });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sliceImageToFiles, getOutputDir };
}