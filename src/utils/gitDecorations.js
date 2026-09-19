/**
 * 把后端给的 git 文件清单，变成文件树每一行能直接用的装饰。
 *
 * 两件事在这里做，而不是在渲染里做：
 *
 * 1. **未跟踪目录要往下继承。** `git status -unormal` 对一个全新目录只报
 *    一条 `?? src-tauri/src/pty/`，不列里面的文件。但用户展开它之后，里面
 *    每个文件也该是绿的 —— 这需要前缀匹配，不是查表能解决的。
 * 2. **改动要往上冒泡。** VSCode 里父目录会跟着变色，否则树折叠着的时候
 *    根本看不出哪里有改动。祖先集合预先算好，渲染时只做一次 Set 查询。
 *
 * 拆成纯函数是因为这两条规则都有边界情况（前缀匹配不能把 `src/app` 当成
 * `src/a` 的子项，根目录不能算进祖先集合），用界面去验证说不清楚。
 */

/**
 * 轮询 git 状态的间隔。
 *
 * 没有走文件监听：项目里跑着 agent 和构建，`target/`、`node_modules/` 的写入
 * 频率远高于真正的源码改动，盯着 FS 事件反而要自己做一遍 gitignore 过滤。
 * 热缓存下一次 `git status` 是几十毫秒，4 秒既能让 agent 刚改完的文件很快
 * 显出来，又不至于让一个开着不动的项目标签一直敲磁盘。
 */
export const GIT_POLL_INTERVAL_MS = 4000;

/** git 状态字母 → 语义色调。渲染层据此挑 class，不直接认字母。 */
const TONE_BY_LETTER = Object.freeze({
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  '?': 'untracked',
  U: 'conflict',
});

/** 目录自身没有状态、但子孙里有改动时用的色调。 */
export const DIRTY_DIR_TONE = 'dirty';

export const toneForLetter = (letter) => TONE_BY_LETTER[letter] || 'modified';

/**
 * 一条路径的所有祖先目录，不含它自己、不含根。
 * `a/b/c.txt` → `['a', 'a/b']`
 */
const ancestorsOf = (path) => {
  const parts = String(path).split('/').filter(Boolean);
  const out = [];
  for (let i = 1; i < parts.length; i += 1) {
    out.push(parts.slice(0, i).join('/'));
  }
  return out;
};

/**
 * @param files 后端的 GitFileStatus[]，形如 { path, status, staged }
 * @returns 供 decorateEntry 使用的索引
 */
export const buildGitDecorations = (files) => {
  const byPath = new Map();
  const untrackedDirs = [];
  const dirtyDirs = new Set();

  for (const file of Array.isArray(files) ? files : []) {
    const raw = String(file?.path || '');
    if (!raw) continue;

    // git 用尾部斜杠表示「整个目录未跟踪」。树里的目录条目不带斜杠，
    // 这里统一成不带，把「是目录」的信息转记到 untrackedDirs 里。
    const isDir = raw.endsWith('/');
    const path = isDir ? raw.slice(0, -1) : raw;
    if (!path) continue;

    byPath.set(path, { status: file.status || 'M', staged: Boolean(file.staged) });
    if (isDir) untrackedDirs.push(path);

    for (const ancestor of ancestorsOf(path)) dirtyDirs.add(ancestor);
    // 未跟踪目录自己也要算脏：它折叠起来时，用户看到的是这一行
    if (isDir) dirtyDirs.add(path);
  }

  return { byPath, untrackedDirs, dirtyDirs };
};

/** 空索引。没有 git 信息时用它，省得每个调用点都判空。 */
export const EMPTY_DECORATIONS = Object.freeze(buildGitDecorations([]));

/**
 * 已删除的文件，按所在目录分组。
 *
 * 文件树读的是磁盘，删掉的文件根本不在 `list_dir` 的结果里 —— 光有装饰
 * 是标不出来的，那一行压根不存在。所以删除要单独作为「幽灵行」补进树里。
 * （VSCode 的资源管理器也不显示它们，只在源代码管理面板里列；这里没有那个
 * 面板，删除就没有任何地方看得到了。）
 *
 * 整个目录被删光的情况不处理：那个目录自己也不在磁盘上，没有能挂靠的父节点。
 * 状态栏的计数仍然把它们算在内。
 *
 * @returns Map<父目录路径, Array<{ name, path }>>，根目录的 key 是空串
 */
export const buildDeletedIndex = (files) => {
  const byDir = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    if (file?.status !== 'D') continue;
    const path = String(file.path || '');
    if (!path) continue;
    const cut = path.lastIndexOf('/');
    const dir = cut === -1 ? '' : path.slice(0, cut);
    const name = cut === -1 ? path : path.slice(cut + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push({ name, path });
  }
  // 目录内按名字排序，跟后端给的条目顺序一致，读起来不至于跳
  for (const list of byDir.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return byDir;
};

/**
 * 某条路径落在哪个未跟踪目录里。
 *
 * 必须比到分隔符：`src/app` 不是 `src/a` 的子项，纯 startsWith 会误判。
 */
const insideUntrackedDir = (path, untrackedDirs) =>
  untrackedDirs.some((dir) => path.startsWith(`${dir}/`));

/**
 * 算一行的装饰。
 *
 * @returns `{ letter, tone }`，letter 为 null 表示只着色不打标记（目录）。
 *          没有任何改动时返回 null。
 */
export const decorateEntry = (path, isDir, decorations) => {
  const deco = decorations || EMPTY_DECORATIONS;
  const key = String(path || '');
  if (!key) return null;

  const exact = deco.byPath.get(key);
  if (exact) {
    const tone = toneForLetter(exact.status);
    // 未跟踪的**目录**不打字母：它下面每个文件都会各自显示 `?`，
    // 父目录再来一个只是噪音。有具体状态的文件才打。
    return { letter: isDir ? null : exact.status, tone };
  }

  if (insideUntrackedDir(key, deco.untrackedDirs)) {
    return { letter: isDir ? null : '?', tone: 'untracked' };
  }

  if (isDir && deco.dirtyDirs.has(key)) {
    return { letter: null, tone: DIRTY_DIR_TONE };
  }

  return null;
};

/**
 * 一份状态的内容签名，用来判断轮询回来的结果跟上一次是不是同一个。
 *
 * 界面每几秒问一次 git，绝大多数时候什么都没变，但 invoke 每次都给回全新的
 * 对象。不比一下就 setState 的话，整棵文件树（虚拟滚动 + 上百个节点）会跟着
 * 空转重建 —— 这正是 ChatboxBody 里那个「输出时间戳只写 ref」的注释在防的
 * 同一类问题。
 */
export const gitStatusSignature = (status) => {
  if (!status?.isRepo) return 'no-repo';
  const files = (Array.isArray(status.files) ? status.files : [])
    .map((f) => `${f.status}${f.staged ? '+' : '-'}${f.path}`)
    .join('\n');
  return [
    status.branch || '',
    status.detached ? 'detached' : '',
    status.ahead || 0,
    status.behind || 0,
    status.truncated ? 'trunc' : '',
    files,
  ].join('|');
};

/**
 * 状态栏用的一句话摘要，例如 `3 staged, 12 modified, 5 untracked`。
 * 没有改动时返回空串。
 */
export const summarizeGitCounts = (status, t = (s) => s) => {
  if (!status?.isRepo) return '';
  const parts = [];
  if (status.staged) parts.push(`${status.staged} ${t('staged')}`);
  if (status.unstaged) parts.push(`${status.unstaged} ${t('modified')}`);
  if (status.untracked) parts.push(`${status.untracked} ${t('untracked')}`);
  if (status.conflicted) parts.push(`${status.conflicted} ${t('conflicted')}`);
  return parts.join(', ');
};

export default {
  buildGitDecorations,
  decorateEntry,
  gitStatusSignature,
  summarizeGitCounts,
  toneForLetter,
  EMPTY_DECORATIONS,
  DIRTY_DIR_TONE,
};
