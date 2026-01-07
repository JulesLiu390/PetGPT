/**
 * 媒体文件处理工具
 * 
 * 负责文件读取、base64 编码、以及文档文本提取
 */
import tauri from '../tauri';

/**
 * 通过 Electron IPC 读取本地文件为 base64 data URI
 * 
 * @param {string} filePath - 本地文件路径或文件名
 * @returns {Promise<string|null>} base64 data URI 或 null
 */
export const readFileAsBase64 = async (filePath) => {
  if (!filePath) return null;
  
  // 如果已经是 data URI，直接返回
  if (filePath.startsWith('data:')) {
    return filePath;
  }
  
  // 如果是 http URL，无法本地读取
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }
  
  // 通过 Electron 读取
  try {
    const fileName = filePath.split('/').pop();
    const data = await tauri.readUpload(fileName);
    return data || null;
  } catch (err) {
    console.error('Failed to read file:', filePath, err);
    return null;
  }
};

/**
 * 解析 base64 data URI
 * 
 * @param {string} dataUri - data:mime;base64,xxxx 格式
 * @returns {{ mimeType: string, data: string } | null}
 */
export const parseDataUri = (dataUri) => {
  if (!dataUri?.startsWith('data:')) return null;
  
  const match = dataUri.match(/^data:(.*?);base64,(.*)$/);
  if (!match) return null;
  
  return {
    mimeType: match[1],
    data: match[2]
  };
};

/**
 * 判断 MIME 类型是否被 Gemini 原生支持
 * 
 * Gemini 支持: images, audio, video, PDF
 * 不支持: Office 文档 (docx, xlsx, pptx 等)
 */
export const isGeminiSupportedMime = (mimeType) => {
  if (!mimeType) return false;
  
  if (mimeType.startsWith('image/')) return true;
  if (mimeType.startsWith('audio/')) return true;
  if (mimeType.startsWith('video/')) return true;
  if (mimeType === 'application/pdf') return true;
  if (mimeType === 'text/plain') return true;
  if (mimeType === 'text/csv') return true;
  
  return false;
};

/**
 * 判断 MIME 类型是否被 OpenAI Vision 支持
 * 
 * OpenAI Vision 主要支持: 图片
 * 不支持: 视频、音频、文档
 */
export const isOpenAISupportedMime = (mimeType) => {
  if (!mimeType) return false;
  
  // OpenAI vision 只支持图片
  if (mimeType.startsWith('image/')) return true;
  
  return false;
};

/**
 * 获取文件的"降级"文本表示（用于不支持该类型的 provider）
 */
export const getFileFallbackText = (part) => {
  const name = part.name || part.url?.split('/').pop() || 'Unknown file';
  const mimeType = part.mime_type || 'unknown';
  
  return `[Attachment: ${name} (${mimeType})]`;
};

/**
 * 获取文件大小（字节）
 * base64 编码后的大小约为原始大小的 4/3
 */
export const getBase64Size = (base64String) => {
  if (!base64String) return 0;
  // 移除 data URI 前缀
  const base64 = base64String.includes(',') ? base64String.split(',')[1] : base64String;
  // base64 字符数 * 3/4 = 原始字节数
  return Math.ceil(base64.length * 3 / 4);
};

/**
 * 检查文件是否超过大小限制
 * 
 * @param {string} base64Data - base64 数据
 * @param {number} maxBytes - 最大字节数（默认 20MB）
 */
export const isFileTooLarge = (base64Data, maxBytes = 20 * 1024 * 1024) => {
  return getBase64Size(base64Data) > maxBytes;
};
