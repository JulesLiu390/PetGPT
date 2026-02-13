/**
 * ScreenshotOverlay — 全屏截图选区页面
 * 
 * 流程：
 * 1. Rust 端：screencapture 生成 PNG 预览文件 + CGDisplay FFI 获取 RGBA 缓存（并行）
 * 2. 本组件全屏显示截图背景 + 半透明遮罩
 * 3. 用户拖拽框选区域（可调整大小/位置）
 * 4. 确认后调用 captureRegion → 裁剪 → 图片自动发送到 chat 输入 + 复制到剪贴板
 * 5. Esc 取消
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

const ScreenshotOverlay = () => {
  const [screenshotData, setScreenshotData] = useState(null);
  const [scaleFactor, setScaleFactor] = useState(2);
  
  // 选区状态（逻辑坐标）
  const [selection, setSelection] = useState(null);  // { x, y, w, h }
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState(null);  // { x, y }
  
  // 拖拽/调整大小
  const [dragMode, setDragMode] = useState(null);
  const [dragStart, setDragStart] = useState(null);
  const [selectionAtDragStart, setSelectionAtDragStart] = useState(null);

  // 自定义快捷 Prompt 按钮
  const [quickPrompts, setQuickPrompts] = useState([]);
  
  const overlayRef = useRef(null);

  // 加载 screenshot_prompts 设置
  const loadPrompts = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke('get_setting', { key: 'screenshot_prompts' });
      if (raw) {
        const parsed = JSON.parse(raw);
        const arr = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
        if (Array.isArray(arr)) setQuickPrompts(arr);
      } else {
        setQuickPrompts([]);
      }
    } catch (e) {
      console.log('[ScreenshotOverlay] No screenshot_prompts configured');
    }
  };

  useEffect(() => { loadPrompts(); }, []);

  // 监听设置更新，实时刷新
  useEffect(() => {
    let unlisten = null;
    const setup = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('settings-updated', () => {
        loadPrompts();
      });
    };
    setup();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // 监听 Rust 发来的截图数据
  useEffect(() => {
    let unlisten = null;
    
    const setup = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('screenshot-ready', async (event) => {
        const data = event.payload;
        console.log('[ScreenshotOverlay] Received screenshot:', data.logicalWidth, 'x', data.logicalHeight);
        // 通过 Tauri asset protocol 加载本地 PNG 文件（零 base64 开销）
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const imageUrl = convertFileSrc(data.previewPath);
        setScreenshotData({ ...data, imageUrl });
        setScaleFactor(data.scaleFactor || 2);
        setSelection(null);
        setIsDrawing(false);
      });
    };
    setup();
    
    return () => { if (unlisten) unlisten(); };
  }, []);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        await cancelScreenshot();
      } else if (e.key === 'Enter' && selection && selection.w > 5 && selection.h > 5) {
        e.preventDefault();
        await confirmScreenshot();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selection]);

  const cancelScreenshot = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cancel_screenshot');
    setScreenshotData(null);
    setSelection(null);
  };

  const confirmScreenshot = async (promptItem = null) => {
    if (!selection || selection.w < 5 || selection.h < 5) return;
    
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { emit } = await import('@tauri-apps/api/event');
      
      // 将逻辑坐标转为物理像素坐标
      const physX = Math.round(selection.x * scaleFactor);
      const physY = Math.round(selection.y * scaleFactor);
      const physW = Math.round(selection.w * scaleFactor);
      const physH = Math.round(selection.h * scaleFactor);
      
      const result = await invoke('capture_region', {
        x: physX, y: physY, width: physW, height: physH
      });
      
      // 发送结果到 chat 窗口
      await emit('screenshot-with-prompt', {
        prompt: promptItem?.prompt || null,
        promptName: promptItem?.name || null,
        newTab: !!promptItem,
        screenshot: {
          data: result.imageBase64,
          path: result.path,
          name: result.name,
        }
      });
      
      setScreenshotData(null);
      setSelection(null);
    } catch (err) {
      console.error('[ScreenshotOverlay] Capture failed:', err);
    }
  };

  // ========== 鼠标事件处理 ==========
  
  const getMousePos = (e) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return; // 只处理左键
    const pos = getMousePos(e);

    // 检查是否点在调整手柄上
    if (selection) {
      const handle = getHandleAtPoint(pos, selection);
      if (handle) {
        setDragMode(handle);
        setDragStart(pos);
        setSelectionAtDragStart({ ...selection });
        e.preventDefault();
        return;
      }
      
      // 检查是否点在选区内（移动）
      if (isInsideSelection(pos, selection)) {
        setDragMode('move');
        setDragStart(pos);
        setSelectionAtDragStart({ ...selection });
        e.preventDefault();
        return;
      }
    }

    // 否则开始新的绘制
    setIsDrawing(true);
    setDrawStart(pos);
    setSelection(null);
    setDragMode(null);
  };

  const handleMouseMove = (e) => {
    const pos = getMousePos(e);

    if (isDrawing && drawStart) {
      // 绘制新选区
      const x = Math.min(drawStart.x, pos.x);
      const y = Math.min(drawStart.y, pos.y);
      const w = Math.abs(pos.x - drawStart.x);
      const h = Math.abs(pos.y - drawStart.y);
      setSelection({ x, y, w, h });
      return;
    }

    if (dragMode && dragStart && selectionAtDragStart) {
      const dx = pos.x - dragStart.x;
      const dy = pos.y - dragStart.y;
      const s = selectionAtDragStart;
      const maxW = screenshotData?.logicalWidth || window.innerWidth;
      const maxH = screenshotData?.logicalHeight || window.innerHeight;

      if (dragMode === 'move') {
        let newX = Math.max(0, Math.min(s.x + dx, maxW - s.w));
        let newY = Math.max(0, Math.min(s.y + dy, maxH - s.h));
        setSelection({ x: newX, y: newY, w: s.w, h: s.h });
      } else {
        // 调整大小
        let { x, y, w, h } = s;
        
        if (dragMode.includes('n')) { y = s.y + dy; h = s.h - dy; }
        if (dragMode.includes('s')) { h = s.h + dy; }
        if (dragMode.includes('w')) { x = s.x + dx; w = s.w - dx; }
        if (dragMode.includes('e')) { w = s.w + dx; }
        
        // 防止负尺寸
        if (w < 10) { w = 10; if (dragMode.includes('w')) x = s.x + s.w - 10; }
        if (h < 10) { h = 10; if (dragMode.includes('n')) y = s.y + s.h - 10; }
        
        // 边界约束
        x = Math.max(0, x);
        y = Math.max(0, y);
        if (x + w > maxW) w = maxW - x;
        if (y + h > maxH) h = maxH - y;
        
        setSelection({ x, y, w, h });
      }
      return;
    }

    // 更新光标样式
    if (selection) {
      const handle = getHandleAtPoint(pos, selection);
      if (handle) {
        setCursorForHandle(handle);
      } else if (isInsideSelection(pos, selection)) {
        if (overlayRef.current) overlayRef.current.style.cursor = 'move';
      } else {
        if (overlayRef.current) overlayRef.current.style.cursor = 'crosshair';
      }
    }
  };

  const handleMouseUp = (e) => {
    if (isDrawing) {
      setIsDrawing(false);
      setDrawStart(null);
    }
    if (dragMode) {
      setDragMode(null);
      setDragStart(null);
      setSelectionAtDragStart(null);
    }
  };

  const handleDoubleClick = (e) => {
    const pos = getMousePos(e);
    if (selection && isInsideSelection(pos, selection) && selection.w > 5 && selection.h > 5) {
      confirmScreenshot();
    }
  };

  // ========== 辅助函数 ==========

  const HANDLE_SIZE = 8;

  const getHandleAtPoint = (pos, sel) => {
    if (!sel) return null;
    const hs = HANDLE_SIZE;
    const handles = {
      'nw': { x: sel.x, y: sel.y },
      'n':  { x: sel.x + sel.w / 2, y: sel.y },
      'ne': { x: sel.x + sel.w, y: sel.y },
      'e':  { x: sel.x + sel.w, y: sel.y + sel.h / 2 },
      'se': { x: sel.x + sel.w, y: sel.y + sel.h },
      's':  { x: sel.x + sel.w / 2, y: sel.y + sel.h },
      'sw': { x: sel.x, y: sel.y + sel.h },
      'w':  { x: sel.x, y: sel.y + sel.h / 2 },
    };
    
    for (const [name, hpos] of Object.entries(handles)) {
      if (Math.abs(pos.x - hpos.x) <= hs && Math.abs(pos.y - hpos.y) <= hs) {
        return name;
      }
    }
    return null;
  };

  const isInsideSelection = (pos, sel) => {
    return pos.x >= sel.x && pos.x <= sel.x + sel.w &&
           pos.y >= sel.y && pos.y <= sel.y + sel.h;
  };

  const setCursorForHandle = (handle) => {
    if (!overlayRef.current) return;
    const cursors = {
      'nw': 'nwse-resize', 'se': 'nwse-resize',
      'ne': 'nesw-resize', 'sw': 'nesw-resize',
      'n': 'ns-resize', 's': 'ns-resize',
      'e': 'ew-resize', 'w': 'ew-resize',
    };
    overlayRef.current.style.cursor = cursors[handle] || 'default';
  };

  // ========== 渲染 ==========

  if (!screenshotData) {
    return <div style={{ width: '100%', height: '100%', background: 'transparent' }} />;
  }

  const sel = selection;
  const dimW = screenshotData.logicalWidth;
  const dimH = screenshotData.logicalHeight;

  return (
    <div
      ref={overlayRef}
      style={{
        width: '100vw',
        height: '100vh',
        position: 'relative',
        cursor: 'crosshair',
        overflow: 'hidden',
        userSelect: 'none',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      {/* 截图背景 */}
      <img
        src={screenshotData.imageUrl}
        alt=""
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          pointerEvents: 'none',
        }}
        draggable={false}
      />

      {/* 暗色遮罩（选区外部） */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none',
      }}>
        {sel ? (
          <>
            {/* Top */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: sel.y, background: 'rgba(0,0,0,0.5)' }} />
            {/* Bottom */}
            <div style={{ position: 'absolute', top: sel.y + sel.h, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)' }} />
            {/* Left */}
            <div style={{ position: 'absolute', top: sel.y, left: 0, width: sel.x, height: sel.h, background: 'rgba(0,0,0,0.5)' }} />
            {/* Right */}
            <div style={{ position: 'absolute', top: sel.y, left: sel.x + sel.w, right: 0, height: sel.h, background: 'rgba(0,0,0,0.5)' }} />
          </>
        ) : (
          <div style={{ width: '100%', height: '100%', background: 'rgba(0,0,0,0.3)' }} />
        )}
      </div>

      {/* 选区边框 + 手柄 */}
      {sel && sel.w > 0 && sel.h > 0 && (
        <>
          {/* 选区边框 */}
          <div style={{
            position: 'absolute',
            left: sel.x,
            top: sel.y,
            width: sel.w,
            height: sel.h,
            border: '2px solid #3b82f6',
            pointerEvents: 'none',
            boxSizing: 'border-box',
          }} />

          {/* 尺寸信息 */}
          <div style={{
            position: 'absolute',
            left: sel.x,
            top: sel.y - 24,
            background: 'rgba(0,0,0,0.75)',
            color: '#fff',
            fontSize: '11px',
            padding: '2px 8px',
            borderRadius: '4px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}>
            {Math.round(sel.w * scaleFactor)} × {Math.round(sel.h * scaleFactor)}
          </div>

          {/* 8 个调整手柄 */}
          {[
            { name: 'nw', x: sel.x, y: sel.y },
            { name: 'n',  x: sel.x + sel.w / 2, y: sel.y },
            { name: 'ne', x: sel.x + sel.w, y: sel.y },
            { name: 'e',  x: sel.x + sel.w, y: sel.y + sel.h / 2 },
            { name: 'se', x: sel.x + sel.w, y: sel.y + sel.h },
            { name: 's',  x: sel.x + sel.w / 2, y: sel.y + sel.h },
            { name: 'sw', x: sel.x, y: sel.y + sel.h },
            { name: 'w',  x: sel.x, y: sel.y + sel.h / 2 },
          ].map(h => (
            <div
              key={h.name}
              style={{
                position: 'absolute',
                left: h.x - 4,
                top: h.y - 4,
                width: 8,
                height: 8,
                background: '#fff',
                border: '1px solid #3b82f6',
                borderRadius: '1px',
                pointerEvents: 'none',
              }}
            />
          ))}

          {/* 工具栏 */}
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: Math.max(8, sel.x + sel.w / 2 - Math.max(60, (quickPrompts.length + 2) * 40)),
              top: sel.y + sel.h + 8,
              display: 'flex',
              gap: '4px',
              padding: '4px',
              background: 'rgba(0,0,0,0.75)',
              borderRadius: '8px',
              pointerEvents: 'auto',
              backdropFilter: 'blur(8px)',
            }}
          >
            {/* 自定义快捷按钮 */}
            {quickPrompts.map((item, idx) => (
              <button
                key={idx}
                onClick={(e) => { e.stopPropagation(); confirmScreenshot(item); }}
                title={item.name + (item.prompt ? ': ' + item.prompt.slice(0, 60) : '')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '4px 10px',
                  fontSize: '12px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.25)'}
                onMouseLeave={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
              >
                <span style={{ fontSize: '14px' }}>{item.icon || '📋'}</span>
                <span>{item.name}</span>
              </button>
            ))}

            {/* 分隔线（有快捷按钮时才显示） */}
            {quickPrompts.length > 0 && (
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.2)', margin: '2px 2px' }} />
            )}

            {/* 取消 */}
            <button
              onClick={(e) => { e.stopPropagation(); cancelScreenshot(); }}
              title="Cancel (Esc)"
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                background: 'rgba(255,255,255,0.1)',
                color: '#fff',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.25)'}
              onMouseLeave={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
            >
              ✕
            </button>

            {/* 确认（发送到当前 Tab，不带 Prompt） */}
            <button
              onClick={(e) => { e.stopPropagation(); confirmScreenshot(); }}
              title="Send to current tab (Enter)"
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => e.target.style.background = '#2563eb'}
              onMouseLeave={(e) => e.target.style.background = '#3b82f6'}
            >
              ✓
            </button>
          </div>
        </>
      )}

      {/* 提示文字（无选区时） */}
      {!sel && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#fff',
          fontSize: '16px',
          textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
          textAlign: 'center',
        }}>
          Drag to select area · Esc to cancel
        </div>
      )}
    </div>
  );
};

export default ScreenshotOverlay;
