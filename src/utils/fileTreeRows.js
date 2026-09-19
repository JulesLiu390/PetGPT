/**
 * 把按层懒加载的目录树拍平成一维的可见行。
 *
 * 虚拟滚动的前提：只有一维等高的行列表，才能由 scrollTop 直接算出该渲染哪
 * 一段。原来的树是递归嵌套 DOM，展开一个大目录（后端上限 2000 条）就是几千
 * 个节点，每个还带两个 react-icons 的 SVG，滚动和展开都会明显卡一下。
 *
 * 拆成纯函数是为了能直接测：树的展开状态、过滤、懒加载占位三者交织，
 * 用渲染结果去验证既慢又说不清。
 */

/** 每行的像素高度。必须与 FileTree 里行元素的实际高度一致。 */
export const ROW_HEIGHT = 22;

/**
 * @param listings  { [path]: { entries, truncated } } 已拉取的目录内容
 * @param expanded  { [path]: boolean } 展开状态
 * @param loading   { [path]: boolean } 正在拉取的目录
 * @param filter    过滤词（已 trim/小写）；目录始终保留，否则无从展开到子项
 * @param deletedByDir  Map<目录, [{name, path}]> 已被 git 记录为删除的文件。
 *   它们不在磁盘上，`list_dir` 不会返回，只能由这里补成幽灵行 —— 否则
 *   「删了什么」在树上完全不可见。
 * @returns 行数组，每行形如 { kind, key, depth, ... }
 */
export const flattenTree = ({
  listings = {},
  expanded = {},
  loading = {},
  filter = '',
  deletedByDir = null,
} = {}) => {
  const needle = String(filter || '').trim().toLowerCase();
  const rows = [];

  const walk = (path, depth) => {
    const listing = listings[path];
    if (!listing) {
      // 目录展开了但内容还在路上
      if (loading[path]) rows.push({ kind: 'loading', key: `loading:${path}`, depth });
      return;
    }

    const entries = needle
      ? listing.entries.filter((e) => e.name.toLowerCase().includes(needle) || e.isDir)
      : listing.entries;

    for (const entry of entries) {
      rows.push({ kind: 'entry', key: entry.path, depth, entry });
      if (entry.isDir && expanded[entry.path]) walk(entry.path, depth + 1);
    }

    // 幽灵行排在真实条目之后：它们没有磁盘顺序可言，混进排序里只会
    // 让人以为文件还在。
    const deleted = deletedByDir?.get(path);
    if (deleted) {
      for (const item of deleted) {
        if (needle && !item.name.toLowerCase().includes(needle)) continue;
        rows.push({ kind: 'deleted', key: `deleted:${item.path}`, depth, entry: item });
      }
    }

    if (listing.truncated) {
      rows.push({ kind: 'truncated', key: `truncated:${path}`, depth });
    }
  };

  walk('', 0);
  return rows;
};

/**
 * 视口上下各多渲染多少行。
 *
 * 给得比较宽：一行只有三个 DOM 节点（容器 + 图标 + 文件名），40 行的余量
 * 也就两百来个节点，代价可以忽略；而快速拖动滚动条时，余量不够就会先露出
 * 一片空白再补上内容。这是刻意用一点内存换滚动手感。
 */
const DEFAULT_OVERSCAN = 40;

/** 还没量到视口高度时先铺多少行，避免首帧空白。 */
const INITIAL_ROWS = 80;

/**
 * 由滚动位置算出要渲染的行区间。
 */
export const visibleRange = ({ scrollTop = 0, viewportHeight = 0, rowCount = 0, overscan = DEFAULT_OVERSCAN }) => {
  if (rowCount <= 0 || viewportHeight <= 0) {
    return { start: 0, end: Math.min(rowCount, INITIAL_ROWS) };
  }
  const first = Math.floor(scrollTop / ROW_HEIGHT) - overscan;
  const last = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + overscan;
  return {
    start: Math.max(0, first),
    end: Math.min(rowCount, Math.max(0, last)),
  };
};

export default { ROW_HEIGHT, flattenTree, visibleRange };
