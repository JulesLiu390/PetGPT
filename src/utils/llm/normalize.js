/**
 * 消息格式标准化工具
 * 
 * 将外部格式（OpenAI style content array）转换为内部统一格式，
 * 以及将内部格式转为各 provider 需要的格式
 */
import tauri from '../tauri';

/**
 * 从 MIME 类型判断媒体类别
 */
export const getMediaCategory = (mimeType) => {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
  if (mimeType.startsWith('text/')) return 'text';
  return 'file';
};

/**
 * 从文件路径推断 MIME 类型
 */
export const getMimeTypeFromPath = (filePath) => {
  const ext = filePath?.split('.').pop()?.toLowerCase() || '';
  const mimeMap = {
    // Video
    'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime', 
    'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska', 'm4v': 'video/x-m4v',
    // Audio
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 
    'm4a': 'audio/mp4', 'flac': 'audio/flac', 'aac': 'audio/aac',
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword', 
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint', 
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain', 'md': 'text/markdown', 'json': 'application/json', 'csv': 'text/csv',
    // Images
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 
    'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
  };
  return mimeMap[ext] || 'application/octet-stream';
};

/**
 * 将外部消息格式（带 image_url / file_url）标准化为内部格式
 * 
 * 外部格式 (现有 UI 使用的):
 *   { type: 'text', text: '...' }
 *   { type: 'image_url', image_url: { url: '...', mime_type?: '...' } }
 *   { type: 'file_url', file_url: { url: '...', mime_type: '...', name?: '...' } }
 * 
 * 内部格式:
 *   { type: 'text', text: '...' }
 *   { type: 'image', url: '...', mime_type: '...' }
 *   { type: 'video', url: '...', mime_type: '...', name: '...' }
 *   { type: 'audio', url: '...', mime_type: '...', name: '...' }
 *   { type: 'file', url: '...', mime_type: '...', name: '...' }
 */
export const normalizeMessageContent = (content) => {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: String(content) }];
  }
  
  return content.map(part => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    
    if (part.type === 'image_url') {
      const url = part.image_url?.url || '';
      const mimeType = part.image_url?.mime_type || part.mime_type || getMimeTypeFromPath(url);
      return { type: 'image', url, mime_type: mimeType };
    }
    
    if (part.type === 'file_url') {
      const url = part.file_url?.url || '';
      const mimeType = part.file_url?.mime_type || getMimeTypeFromPath(url);
      const name = part.file_url?.name || url.split('/').pop() || 'file';
      const category = getMediaCategory(mimeType);
      
      // 根据 MIME 类型决定具体类型
      if (category === 'video') {
        return { type: 'video', url, mime_type: mimeType, name };
      }
      if (category === 'audio') {
        return { type: 'audio', url, mime_type: mimeType, name };
      }
      // 其他归类为 file
      return { type: 'file', url, mime_type: mimeType, name };
    }
    
    // 如果已经是内部格式，直接返回
    if (['image', 'video', 'audio', 'file'].includes(part.type)) {
      return part;
    }
    
    // 未知类型，转为文本
    return { type: 'text', text: JSON.stringify(part) };
  });
};

/**
 * 标准化整个消息数组
 */
export const normalizeMessages = (messages) => {
  return messages.map(msg => ({
    role: msg.role,
    content: normalizeMessageContent(msg.content)
  }));
};

/**
 * 将不可直接被模型读取的“文档类附件”展开为文本内容。
 *
 * 目前支持：.docx, .txt, .md, .csv, .json（由 Electron 主进程抽取/读取）。
 *
 * @param {{role: string, content: any}[]} messages
 * @param {{ includeOriginalAttachmentTag?: boolean, maxChars?: number }} [options]
 */
export const expandDocumentPartsToText = async (messages, options = {}) => {
  const { includeOriginalAttachmentTag = true, maxChars = 60_000 } = options;
  const normalized = normalizeMessages(messages);

  const out = [];
  for (const msg of normalized) {
    const newParts = [];

    for (const part of msg.content) {
      if (part.type !== 'file') {
        newParts.push(part);
        continue;
      }

      const mime = part.mime_type || '';
      const isDocx = mime.includes('officedocument.wordprocessingml.document') || (part.name || '').toLowerCase().endsWith('.docx');
      const isPlainText = mime.startsWith('text/') || ['application/json'].includes(mime) || (part.name || '').match(/\.(txt|md|csv|json)$/i);

      // 只展开“文档类”——图片/视频/音频交给各 adapter 自己处理
      if (!isDocx && !isPlainText && mime !== 'application/pdf') {
        newParts.push(part);
        continue;
      }

      // PDF 暂不在这里抽取（避免引入 pdf 解析依赖），仍作为附件引用
      if (mime === 'application/pdf') {
        newParts.push(part);
        continue;
      }

      const fileName = part.url?.split('/').pop();
      if (!fileName || !tauri.extractDocumentText) {
        newParts.push(part);
        continue;
      }

      try {
        const text = await tauri.extractDocumentText(fileName);
        const clipped = (text || '').slice(0, maxChars);
        if (includeOriginalAttachmentTag) {
          newParts.push({ type: 'text', text: `[Attachment: ${part.name || fileName} (${mime || 'unknown'})]` });
        }
        newParts.push({ type: 'text', text: clipped });
      } catch (e) {
        newParts.push(part);
      }
    }

    out.push({ role: msg.role, content: newParts });
  }

  return out;
};

/**
 * 从内部格式的内容中提取纯文本
 */
export const extractTextFromContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
};

/**
 * 检查内容是否包含多模态（非纯文本）部分
 */
export const hasMultimodalContent = (content) => {
  if (typeof content === 'string') return false;
  if (!Array.isArray(content)) return false;
  return content.some(part => part.type !== 'text');
};
