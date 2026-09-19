import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css as cssLang } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { MdSave, MdRefresh, MdLock, MdLockOpen } from 'react-icons/md';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/context.js';
import * as tauri from '../../utils/tauri';

/**
 * 认出「磁盘上的文件变了」的标记短语。
 *
 * 与 Rust 侧 `projects::CONFLICT_MARKER` 是同一个字符串，两边必须一起改。
 * 匹配的是错误原文而不是翻译后的文本 —— 后端只出英文，中文由
 * translator 的 zh-CN 规则在渲染时生成，这里拿到的始终是英文原文。
 */
const CONFLICT_MARKER = 'was changed by another program';

const formatSize = (bytes) => {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * 按扩展名选语言，而不是靠内容猜。
 *
 * 之前用的是 highlight.js 的 `highlightAuto`，它对短文件经常猜错，而且
 * 每次都要跑一遍全部语言的探测。扩展名是确定信息，没有理由不用。
 */
const languageFor = (name = '') => {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'rs':
      return rust();
    case 'json':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    case 'css':
      return cssLang();
    case 'html':
    case 'htm':
      return html();
    case 'py':
      return python();
    default:
      // 拿不到语言就只做纯文本 —— 有行号、有选择、能编辑，只是不上色
      return [];
  }
};

/**
 * 文件查看与编辑。三种渲染路径：
 *   text   —— CodeMirror 编辑器（语法高亮、行号、括号匹配、搜索、可编辑）
 *   image  —— 走 asset:// 交给浏览器，不把字节读进内存
 *   binary —— 不渲染内容
 *
 * 之前这里用 highlight.js，但**从未引入过它的主题样式**，所以生成的是一堆
 * 没有颜色的 span —— 看起来完全不像代码编辑器。换成 CodeMirror 之后主题
 * 是自带的，同时顺带拿到了编辑能力。
 *
 * 保存默认是「乐观锁」：带上读取时的修改时间，磁盘上变了就拒绝写入。
 * 这个项目里 agent 正在同时改文件，无条件覆盖会吞掉它的修改。
 */
function FilePreview({ projectId, path, hidden }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editable, setEditable] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const hostRef = useRef(null);
  const viewRef = useRef(null);
  // 保存基线。放 ref 里，保存回调不必因为它变化而重建。
  const baselineRef = useRef(0);
  const saveRef = useRef(() => {});

  const load = useCallback(() => {
    if (!projectId || !path) return;
    setLoading(true);
    setError('');
    setConflict(false);
    tauri.projectsPreviewFile(projectId, path)
      .then((result) => {
        setPreview(result);
        baselineRef.current = result?.modifiedAt ?? 0;
        setDirty(false);
      })
      .catch((err) => { setError(String(err?.message || err)); setPreview(null); })
      .finally(() => setLoading(false));
  }, [projectId, path]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async ({ force = false } = {}) => {
    const view = viewRef.current;
    if (!view || !projectId || !path) return;
    setSaving(true);
    try {
      const result = await tauri.projectsWriteFile({
        id: projectId,
        path,
        content: view.state.doc.toString(),
        expectedModifiedAt: force ? null : baselineRef.current,
      });
      baselineRef.current = result?.modifiedAt ?? 0;
      setDirty(false);
      setConflict(false);
      setError('');
    } catch (err) {
      const message = String(err?.message || err);
      // 后端把冲突和普通 IO 错误分开报，界面据此给不同的出路
      if (message.includes(CONFLICT_MARKER)) setConflict(true);
      else setError(message);
    } finally {
      setSaving(false);
    }
  }, [projectId, path]);

  saveRef.current = save;

  const language = useMemo(() => languageFor(preview?.name), [preview?.name]);

  // 建立/重建编辑器。文件或语言变了才重建，避免打字时反复重挂。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || preview?.kind !== 'text') return undefined;

    const view = new EditorView({
      state: EditorState.create({
        doc: preview.content ?? '',
        extensions: [
          basicSetup,
          oneDark,
          language,
          // Cmd/Ctrl+S 保存。放在 basicSetup 之前会被它的默认键位覆盖，
          // 所以放在后面。
          keymap.of([{
            key: 'Mod-s',
            preventDefault: true,
            run: () => { saveRef.current(); return true; },
          }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setDirty(true);
          }),
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
          EditorView.theme({
            '&': { height: '100%', fontSize: '12px' },
            '.cm-scroller': {
              fontFamily: 'var(--petgpt-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
              lineHeight: '1.5',
            },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [preview?.kind, preview?.content, language, editable]);

  // 必须在下面那个 `if (hidden) return null` 之前：hook 不能条件调用。
  //
  // 用 useMemo：预览上限是 512KB，把整份内容 split 成行数组只为拿个长度，
  // 每次渲染都做一遍很浪费 —— 而拖动窗口时父组件是每帧重渲染的。
  const lineCount = useMemo(() => {
    const content = preview?.content;
    if (!content) return 0;
    // 不用 split：它要为几万行各分配一个字符串再全部丢掉
    let n = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) n++;
    }
    return n;
  }, [preview?.content]);

  if (hidden) return null;

  return (
    <div className="flex h-full flex-col bg-[#282c34]">
      {/* 顶栏：路径 + 元信息 + 编辑/保存 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-black/30 bg-[#21252b] px-3 text-[11px] text-gray-400">
        <span data-i18n-ignore className="min-w-0 flex-1 truncate font-medium text-gray-200" title={path}>
          {path}
        </span>
        {preview?.kind === 'text' && (
          <span data-i18n-ignore className="shrink-0 tabular-nums">
            {lineCount > 0 ? `${lineCount} ${t('lines')} · ` : ''}{formatSize(preview.size)}
          </span>
        )}
        {preview?.truncated && (
          <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
            {t('Truncated')}
          </span>
        )}
        {dirty && !saving && (
          <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-300">
            {t('Unsaved')}
          </span>
        )}

        {preview?.kind === 'text' && (
          <>
            <button
              type="button"
              onClick={load}
              title={t('Reload from disk')}
              className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-100"
            >
              <MdRefresh className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setEditable((v) => !v)}
              title={editable ? t('Switch to read-only') : t('Enable editing')}
              className={`shrink-0 rounded p-0.5 hover:bg-white/10 ${
                editable ? 'text-emerald-400' : 'text-gray-400 hover:text-gray-100'
              }`}
            >
              {editable
                ? <MdLockOpen className="h-3.5 w-3.5" />
                : <MdLock className="h-3.5 w-3.5" />}
            </button>
            {editable && (
              <button
                type="button"
                onClick={() => save()}
                disabled={!dirty || saving}
                title={`${t('Save')} (⌘S)`}
                className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-100 disabled:opacity-40"
              >
                <MdSave className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
      </div>

      {conflict && (
        <div className="flex shrink-0 items-center gap-2 bg-amber-500/15 px-3 py-1.5 text-[11px] text-amber-200">
          <span className="flex-1">{t('This file changed on disk since you opened it.')}</span>
          <button
            type="button"
            onClick={load}
            className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
          >
            {t('Reload')}
          </button>
          <button
            type="button"
            onClick={() => save({ force: true })}
            className="rounded bg-rose-500/30 px-2 py-0.5 hover:bg-rose-500/50"
          >
            {t('Overwrite')}
          </button>
        </div>
      )}

      {error && (
        <div className="shrink-0 bg-rose-500/15 px-3 py-1.5 text-[11px] text-rose-200">
          <span data-i18n-ignore>{t(error)}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && <div className="p-3 text-[11px] text-gray-500">{t('Loading…')}</div>}

        {preview?.kind === 'image' && (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={convertFileSrc(preview.absolutePath)}
              alt={preview.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}

        {preview?.kind === 'binary' && (
          <div className="p-4 text-[11px] text-gray-500">
            {t('Binary file, no preview available.')}
          </div>
        )}

        {preview?.kind === 'text' && (
          <div ref={hostRef} className="h-full w-full" data-i18n-ignore />
        )}
      </div>
    </div>
  );
}

// memo：父组件 ProjectView 会因为终端活动、标签切换等原因重渲染，
// 而这里挂着一个 CodeMirror 实例，没必要跟着跑。
export default React.memo(FilePreview);
