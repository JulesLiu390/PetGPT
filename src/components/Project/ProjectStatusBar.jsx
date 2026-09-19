import React from 'react';
import { MdFolder, MdArrowUpward, MdArrowDownward } from 'react-icons/md';
import { VscSourceControl } from 'react-icons/vsc';
import { useI18n } from '../../i18n/context.js';
import { summarizeGitCounts } from '../../utils/gitDecorations.js';

/**
 * 侧边栏底部在 project 标签下显示的内容：项目 + 分支 + 改动数。
 *
 * 顶掉的是聊天模式那个「选择助手」下拉。那个位置的语义是「当前标签属于
 * 谁」—— 聊天标签只写对话标题，所以底部补助手；项目标签只写项目名，所以
 * 底部补它在磁盘的哪里、在哪个分支上、有多少没提交。
 *
 * 这里刻意不做成下拉：切换项目的入口是上面的 ProjectsSection，长得像
 * picker 但点了没有菜单，比不显示更糟。
 */
function ProjectStatusBar({ project, gitStatus }) {
  const { t } = useI18n();
  if (!project) return null;

  const git = gitStatus?.isRepo ? gitStatus : null;
  const changes = git ? (git.files?.length ?? 0) : 0;
  const breakdown = summarizeGitCounts(git, t);

  // 悬停时把完整信息给出来：路径在窄侧边栏里一定会被截断，
  // 而改动明细（几个暂存、几个未跟踪）挤不进一行。
  const tooltip = [
    project.path,
    git?.branch ? `${t('Branch')}: ${git.branch}${git.detached ? ` (${t('detached')})` : ''}` : '',
    breakdown,
    git?.truncated ? t('Too many changes to list them all') : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="p-3 border-t border-gray-200" title={tooltip}>
      <div className="flex items-center gap-2 px-1">
        <MdFolder className="w-4 h-4 shrink-0 text-amber-500" />
        <span data-i18n-ignore className="flex-1 truncate text-sm font-medium text-gray-700">
          {project.name}
        </span>
      </div>

      {git ? (
        <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-gray-500">
          <VscSourceControl className="w-3 h-3 shrink-0" />
          <span
            data-i18n-ignore
            className={`truncate ${git.detached ? 'italic text-amber-700' : ''}`}
          >
            {git.branch || t('no branch')}
          </span>

          {git.ahead > 0 && (
            <span className="flex shrink-0 items-center text-emerald-600" data-i18n-ignore>
              <MdArrowUpward className="w-3 h-3" />{git.ahead}
            </span>
          )}
          {git.behind > 0 && (
            <span className="flex shrink-0 items-center text-sky-600" data-i18n-ignore>
              <MdArrowDownward className="w-3 h-3" />{git.behind}
            </span>
          )}

          {changes > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-1.5 py-px font-medium text-amber-700">
              <span data-i18n-ignore>{changes}</span> {t('changes')}
            </span>
          )}
        </div>
      ) : (
        // 不是 git 仓库（或机器上没有 git）：退回显示路径，
        // 这仍然是标签栏没说、而用户需要知道的那条信息。
        <div data-i18n-ignore className="mt-1 truncate px-1 text-[11px] text-gray-400">
          {project.path}
        </div>
      )}
    </div>
  );
}

export default React.memo(ProjectStatusBar);
