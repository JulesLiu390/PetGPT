/**
 * ShareCardRenderer — 将一组 Q&A 消息渲染为可分享的图片
 * 
 * 原理：
 * 1. 创建一个离屏 DOM 容器，使用固定宽度
 * 2. 用 ReactMarkdown 渲染 AI 回复（完整保留代码高亮、表格、列表等）
 * 3. html2canvas 将 DOM 转为 Canvas → PNG Blob
 * 4. 用户选择「复制到剪贴板」或「保存为文件」
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import html2canvas from 'html2canvas';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import * as tauri from '../../utils/tauri';

// ========== 分享卡片专用的静态子组件 ==========

/** 代码块：带语法高亮，无交互按钮（截图用） */
const ShareCodeBlock = ({ inline, className, children }) => {
  const match = /language-(\w+)/.exec(className || '');
  const language = match && hljs.getLanguage(match[1]) ? match[1] : null;
  const codeString = String(children).replace(/\n$/, '');
  const isBlockButTooShort = !inline && !codeString.includes('\n') && codeString.length < 30;

  if (inline || isBlockButTooShort) {
    return (
      <code style={{
        backgroundColor: '#1f2937',
        color: '#f3f4f6',
        borderRadius: '4px',
        padding: '1px 4px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: '0.85em',
      }}>
        {children}
      </code>
    );
  }

  const highlighted = language
    ? hljs.highlight(codeString, { language }).value
    : hljs.highlightAuto(codeString).value;

  return (
    <div style={{ position: 'relative', margin: '8px 0' }}>
      {language && (
        <div style={{
          position: 'absolute', right: '8px', top: '6px',
          fontSize: '10px', color: '#9ca3af', fontFamily: 'sans-serif',
        }}>
          {language}
        </div>
      )}
      <pre style={{
        borderRadius: '8px',
        padding: '16px',
        backgroundColor: '#000',
        color: '#f3f4f6',
        overflowX: 'auto',
        maxWidth: '100%',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: '13px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: '1.5',
      }}>
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
};

/** 链接：静态展示，不可点击 */
const ShareLinkRenderer = ({ href, children, ...props }) => (
  <span style={{ color: '#3b82f6', textDecoration: 'underline' }} {...props}>
    {children}
  </span>
);

// ========== 分享卡片主体 ==========

/**
 * ShareCard — 纯展示组件，直接渲染到离屏 DOM
 * 使用内联 style 确保 html2canvas 完全捕获样式
 */
const ShareCard = ({ question, answer, petName }) => {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // 提取文本内容
  const getTextContent = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }
    return '';
  };

  // 提取图片列表
  const getImages = (content) => {
    if (!Array.isArray(content)) return [];
    return content.filter(p => p.type === 'image_url').map(p => p.image_url?.url).filter(Boolean);
  };

  const questionText = getTextContent(question.content);
  const answerText = getTextContent(answer.content);
  const questionImages = getImages(question.content);

  return (
    <div style={{
      width: '600px',
      backgroundColor: '#ffffff',
      borderRadius: '16px',
      overflow: 'hidden',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 24px',
        backgroundColor: '#f9fafb',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <span style={{ fontSize: '20px' }}>🐾</span>
        <span style={{
          fontSize: '16px',
          fontWeight: '600',
          color: '#111827',
        }}>PetGPT</span>
        {petName && (
          <span data-i18n-ignore style={{
            fontSize: '12px',
            color: '#6b7280',
            marginLeft: '4px',
          }}>· {petName}</span>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '20px 24px' }}>
        {/* User Question */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: '16px',
        }}>
          <div data-i18n-ignore style={{
            backgroundColor: '#f3f4f6',
            borderRadius: '16px',
            padding: '10px 16px',
            maxWidth: '85%',
            fontSize: '14px',
            color: '#1f2937',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {questionText}
          </div>
        </div>

        {/* Question images (if any) */}
        {questionImages.length > 0 && (
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            marginBottom: '16px',
            flexWrap: 'wrap',
          }}>
            {questionImages.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                style={{
                  width: '80px',
                  height: '80px',
                  objectFit: 'cover',
                  borderRadius: '8px',
                }}
              />
            ))}
          </div>
        )}

        {/* AI Answer */}
        <div data-i18n-ignore style={{
          fontSize: '14px',
          color: '#1f2937',
          lineHeight: '1.6',
          wordBreak: 'break-word',
        }}
          className="share-card-markdown"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ShareLinkRenderer,
              code: ShareCodeBlock,
              // 表格样式
              table: ({ children }) => (
                <table style={{
                  borderCollapse: 'collapse',
                  width: '100%',
                  margin: '8px 0',
                  fontSize: '13px',
                }}>
                  {children}
                </table>
              ),
              th: ({ children }) => (
                <th style={{
                  border: '1px solid #d1d5db',
                  padding: '6px 12px',
                  backgroundColor: '#f3f4f6',
                  fontWeight: '600',
                  textAlign: 'left',
                }}>
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td style={{
                  border: '1px solid #d1d5db',
                  padding: '6px 12px',
                }}>
                  {children}
                </td>
              ),
              // 段落
              p: ({ children }) => (
                <p style={{ margin: '4px 0' }}>{children}</p>
              ),
              // 标题
              h1: ({ children }) => <h1 style={{ fontSize: '1.4em', fontWeight: '700', margin: '12px 0 4px' }}>{children}</h1>,
              h2: ({ children }) => <h2 style={{ fontSize: '1.25em', fontWeight: '600', margin: '10px 0 4px' }}>{children}</h2>,
              h3: ({ children }) => <h3 style={{ fontSize: '1.1em', fontWeight: '600', margin: '8px 0 4px' }}>{children}</h3>,
              // 列表
              ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: '20px', listStyleType: 'disc' }}>{children}</ul>,
              ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: '20px', listStyleType: 'decimal' }}>{children}</ol>,
              li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
              // 引用块
              blockquote: ({ children }) => (
                <blockquote style={{
                  borderLeft: '3px solid #d1d5db',
                  paddingLeft: '12px',
                  margin: '8px 0',
                  color: '#6b7280',
                }}>
                  {children}
                </blockquote>
              ),
              // 水平线
              hr: () => <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '12px 0' }} />,
              // 粗体/斜体
              strong: ({ children }) => <strong style={{ fontWeight: '600' }}>{children}</strong>,
              em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
            }}
          >
            {answerText}
          </ReactMarkdown>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 24px',
        backgroundColor: '#f9fafb',
        borderTop: '1px solid #e5e7eb',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: '11px', color: '#9ca3af' }}>
          Generated by PetGPT
        </span>
        <span data-i18n-ignore style={{ fontSize: '11px', color: '#9ca3af' }}>
          {dateStr}
        </span>
      </div>
    </div>
  );
};

// ========== 截图渲染引擎 ==========

/**
 * 将 Q&A 消息对渲染为 PNG Blob
 * @param {Object} question - 用户消息对象 { role: 'user', content: ... }
 * @param {Object} answer   - AI 回复消息对象 { role: 'assistant', content: ... }
 * @param {string} petName  - 助手名称（可选）
 * @returns {Promise<Blob>} PNG blob
 */
export const renderShareImage = async (question, answer, petName) => {
  // 1. 创建离屏容器
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed; left:-9999px; top:0; z-index:-1;';
  document.body.appendChild(container);

  // 2. 注入 highlight.js 样式（确保离屏 DOM 也能使用）
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .share-card-markdown p { margin: 4px 0 !important; }
    .share-card-markdown > *:first-child { margin-top: 0 !important; }
    .share-card-markdown > *:last-child { margin-bottom: 0 !important; }
  `;
  container.appendChild(styleEl);

  // 3. 渲染 React 组件到离屏 DOM
  const cardDiv = document.createElement('div');
  container.appendChild(cardDiv);

  return new Promise((resolve, reject) => {
    const root = createRoot(cardDiv);
    root.render(
      <ShareCard question={question} answer={answer} petName={petName} />
    );

    // 4. 等待渲染完成后截图
    //    requestAnimationFrame + 小延迟确保 DOM 完全绘制
    requestAnimationFrame(() => {
      setTimeout(async () => {
        try {
          const targetEl = cardDiv.firstChild;
          if (!targetEl) throw new Error('ShareCard render failed');

          const canvas = await html2canvas(targetEl, {
            backgroundColor: '#ffffff',
            scale: 2, // 2x 高清
            useCORS: true,
            logging: false,
          });

          canvas.toBlob((blob) => {
            // 5. 清理
            root.unmount();
            document.body.removeChild(container);

            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Canvas toBlob returned null'));
            }
          }, 'image/png');
        } catch (err) {
          root.unmount();
          document.body.removeChild(container);
          reject(err);
        }
      }, 100); // 等待 100ms 让代码高亮等异步操作完成
    });
  });
};

/**
 * Blob → base64 字符串（不含 data URL 前缀）
 */
const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // reader.result = "data:image/png;base64,XXXX..."
      resolve(reader.result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * 将 Blob 复制到剪贴板（通过 Rust invoke → Tauri clipboard-manager 插件）
 */
export const copyImageToClipboard = async (blob) => {
  try {
    const base64DataUrl = await blobToBase64(blob);
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('copy_image_to_clipboard', { base64Data: base64DataUrl });
    console.log('[ShareCard] Image copied to clipboard via Tauri');
    return true;
  } catch (err) {
    console.error('[ShareCard] Failed to copy to clipboard:', err);
    return false;
  }
};

/**
 * 将 Blob 保存为文件（通过 Tauri 对话框 + Rust invoke 写文件）
 */
export const saveImageToFile = async (blob) => {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      defaultPath: `PetGPT_Share_${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });

    if (!filePath) return false; // 用户取消

    // Blob → base64 data URL
    const base64DataUrl = await blobToBase64(blob);

    // 通过 Rust 命令写文件（绕过 fs 插件权限限制）
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_image_to_path', {
      filePath: filePath,
      base64Data: base64DataUrl,
    });

    console.log('[ShareCard] Image saved to:', filePath);
    return true;
  } catch (err) {
    console.error('[ShareCard] Failed to save file:', err);
    return false;
  }
};

export default ShareCard;
