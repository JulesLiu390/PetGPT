//! 项目的 git 状态：分支、领先/落后、改动文件清单。
//!
//! 走 `git` CLI 而不是 libgit2：解析 `--porcelain=v1 -z` 的输出是稳定契约，
//! 而 libgit2 会给编译时间和二进制体积加上一大笔，只为了一个状态栏。
//! 代价是用户机器上得有 git —— 没有就当作「不是仓库」静默降级，界面退回
//! 只显示项目名。
//!
//! 两个环境变量不是可选项：
//!
//! - `GIT_OPTIONAL_LOCKS=0` —— 界面在轮询这个命令。默认的 `git status` 会顺手
//!   刷新 index 并为此拿 `index.lock`，跟用户自己在终端里跑的 git 抢锁，
//!   表现为对方随机报 "Unable to create index.lock: File exists"。
//! - `GIT_TERMINAL_PROMPT=0` —— 这里没有终端可以应答，任何凭据提示都只会
//!   挂到超时。

use std::collections::HashSet;

use serde::Serialize;

/// 单次 `git status` 的时间上限。超时按「拿不到状态」处理。
///
/// 冷缓存的大仓库可以跑上好几秒，但界面是轮询的：与其让请求堆积，
/// 不如放弃这一轮，下一轮 git 自己的 untracked cache 通常已经热了。
pub const GIT_TIMEOUT_SECS: u64 = 10;

/// 最多回传多少条文件状态。
///
/// 只影响文件树上的装饰，计数在截断之前就算完了，状态栏上的数字仍然准确。
/// 上万条改动时逐行装饰本来也没有阅读价值，不值得把它们全序列化过河。
pub const MAX_STATUS_FILES: usize = 5000;

/// 一个文件的规约状态。单字符，与 porcelain 的 XY 不是一一对应 ——
/// 界面上一行只放得下一个标记，这里先把优先级判完。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    /// 相对项目根，`/` 分隔。未跟踪的目录以 `/` 结尾（git 自己的表示法）。
    pub path: String,
    /// `M` 修改 / `A` 新增 / `D` 删除 / `R` 重命名 / `?` 未跟踪 / `U` 冲突
    pub status: String,
    /// 暂存区里有这条改动
    pub staged: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// false 表示不是 git 仓库、git 不可用或超时。其余字段此时无意义。
    pub is_repo: bool,
    /// 分支名；detached HEAD 时是短 sha，由调用方补上
    pub branch: Option<String>,
    pub detached: bool,
    pub ahead: u32,
    pub behind: u32,
    /// 暂存区内有改动的文件数
    pub staged: u32,
    /// 工作区内有未暂存改动的文件数
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    /// 文件清单，可能因 [`MAX_STATUS_FILES`] 被截断
    pub files: Vec<GitFileStatus>,
    /// files 被截断过。计数字段不受影响。
    pub truncated: bool,
}

impl GitStatus {
    /// 「改了多少东西」：去重后的文件数。
    ///
    /// 一个文件同时有暂存和未暂存改动（`MM`）时三个计数字段会各记一次，
    /// 直接相加会把它算成两处改动。状态栏要的是「几个文件不干净」。
    pub fn total_changes(&self) -> u32 {
        self.files.len() as u32
    }
}

/// 冲突状态的 XY 组合。见 git-status(1) 的 "Unmerged" 一节。
fn is_conflict(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    )
}

/// 解析 `## ` 开头的分支头行。
///
/// 三种形态：
/// - `## main`                                      无上游
/// - `## main...origin/main [ahead 1, behind 2]`    有上游
/// - `## HEAD (no branch)`                          detached
/// - `## No commits yet on main`                    空仓库
fn parse_branch_header(line: &str, status: &mut GitStatus) {
    let body = line.trim_start_matches("## ");

    if body.starts_with("HEAD (no branch)") {
        status.detached = true;
        return;
    }

    // 空仓库：还没有 commit，但分支名已经定了
    if let Some(rest) = body.strip_prefix("No commits yet on ") {
        status.branch = Some(rest.trim().to_string());
        return;
    }

    // 领先/落后信息在方括号里，先摘掉再取分支名
    let (refs, tracking) = match body.split_once(" [") {
        Some((refs, tail)) => (refs, tail.trim_end_matches(']')),
        None => (body, ""),
    };

    // `...` 之前是本地分支。分支名本身允许含 `.`，但 `...` 是 git 固定的
    // 本地/上游分隔符，不会出现在名字里。
    let local = refs.split("...").next().unwrap_or(refs).trim();
    if !local.is_empty() {
        status.branch = Some(local.to_string());
    }

    for part in tracking.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            status.ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            status.behind = n.trim().parse().unwrap_or(0);
        }
    }
}

/// 解析 `git status --porcelain=v1 -b -z` 的完整输出。
///
/// `-z` 用 NUL 分隔记录且不对路径做引号转义 —— 这是唯一能安全处理含空格、
/// 换行、非 UTF-8 字节的文件名的模式。重命名条目占两个记录：`R  <new>` 之后
/// 紧跟一个单独的 `<old>`，所以不能简单地按记录逐条 map。
pub fn parse_porcelain(raw: &str) -> GitStatus {
    let mut status = GitStatus {
        is_repo: true,
        ..Default::default()
    };

    let mut records = raw.split('\0').filter(|r| !r.is_empty());
    let mut seen_paths: HashSet<String> = HashSet::new();

    while let Some(record) = records.next() {
        if record.starts_with("## ") {
            parse_branch_header(record, &mut status);
            continue;
        }
        // `XY <path>`：两个状态字符 + 一个空格
        if record.len() < 4 {
            continue;
        }
        let mut chars = record.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let path = record[3..].to_string();

        // 重命名/复制的旧路径跟在后面，单独占一条记录。必须消费掉，
        // 否则它会被当成下一条状态记录解析。
        if x == 'R' || x == 'C' {
            records.next();
        }

        let conflict = is_conflict(x, y);
        let untracked = x == '?' && y == '?';

        // `!!` 只在 --ignored 下出现，这里没开；出现了也不该进列表
        if x == '!' {
            continue;
        }

        if conflict {
            status.conflicted += 1;
        } else if untracked {
            status.untracked += 1;
        } else {
            if x != ' ' {
                status.staged += 1;
            }
            if y != ' ' {
                status.unstaged += 1;
            }
        }

        let letter = if conflict {
            'U'
        } else if untracked {
            '?'
        } else if x != ' ' {
            x
        } else {
            y
        };

        // 同一路径出现两次只保留第一条 —— porcelain 不该这么输出，
        // 但真出现了，界面上重复一行比丢一行更难解释。
        if !seen_paths.insert(path.clone()) {
            continue;
        }

        if status.files.len() < MAX_STATUS_FILES {
            status.files.push(GitFileStatus {
                path,
                status: letter.to_string(),
                staged: !untracked && !conflict && x != ' ',
            });
        } else {
            status.truncated = true;
        }
    }

    status
}

/// 起一个配置好的 git 子进程。
fn git_command(root: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(root);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // 输出要按固定格式解析，别让用户的 language pack 把它翻译了
    cmd.env("LC_ALL", "C");

    // PATH 只在 unix 上需要修：打包后的 .app / .desktop 拿到的 PATH 里没有
    // homebrew 和用户目录。Windows 的 GUI 进程正常继承系统 PATH，而
    // `augmented_path()` 是按 `:` 拼的，套到带盘符的 Windows 路径上会把
    // `C:\Program Files\Git\cmd` 劈成两段 —— 那样反而找不到 git。
    #[cfg(unix)]
    cmd.env("PATH", crate::shell_env::augmented_path());

    // Windows 上不要弹出控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// 跑一条 git 子命令，拿它的 stdout。
///
/// 非零退出一律返回 `None` 而不是错误字符串：调用方对「不是仓库」「没装
/// git」「超时」的处理完全一样 —— 界面上不显示 git 那一段。把它们区分开
/// 只会让状态栏多出一种没人能修的报错。
async fn git_output(root: &str, args: &[&str]) -> Option<String> {
    let mut cmd = git_command(root);
    cmd.args(args);
    cmd.stdin(std::process::Stdio::null());

    let run = cmd.output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(GIT_TIMEOUT_SECS), run)
        .await
        .ok()? // 超时
        .ok()?; // spawn 失败（没装 git）

    if !output.status.success() {
        return None;
    }
    // 文件名不保证是合法 UTF-8。lossy 会把坏字节换成 U+FFFD，那一行的路径
    // 点不开，但整个状态不会因为一个古怪的文件名就全军覆没。
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 读取一个目录的 git 状态。非仓库或 git 不可用时返回 `is_repo: false`。
pub async fn read_status(root: &str) -> GitStatus {
    // --untracked-files=normal：未跟踪的目录整个报成一条 `?? dir/`，不展开
    // 里面的文件。对文件树装饰来说这正好（目录标一次就够），也避免了在一个
    // 没 .gitignore 的项目里把 node_modules 的几万个文件全列出来。
    let Some(raw) = git_output(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-b",
            "-z",
            "--untracked-files=normal",
        ],
    )
    .await
    else {
        return GitStatus::default();
    };

    let mut status = parse_porcelain(&raw);

    // detached HEAD 下 porcelain 只说 "(no branch)"，短 sha 得单独问一次。
    // 只在这一种情况下多起一个进程，常规路径仍然是单次调用。
    if status.detached && status.branch.is_none() {
        if let Some(sha) = git_output(root, &["rev-parse", "--short", "HEAD"]).await {
            let sha = sha.trim();
            if !sha.is_empty() {
                status.branch = Some(sha.to_string());
            }
        }
    }

    status
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把人写的用例转成 -z 的实际形状，省得每个用例里插一堆 \0
    fn z(records: &[&str]) -> String {
        let mut out = String::new();
        for r in records {
            out.push_str(r);
            out.push('\0');
        }
        out
    }

    #[test]
    fn a_clean_repo_on_a_tracked_branch_reports_no_changes() {
        let s = parse_porcelain(&z(&["## main...origin/main"]));
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(!s.detached);
        assert_eq!(s.total_changes(), 0);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
    }

    #[test]
    fn ahead_and_behind_are_read_from_the_header() {
        let s = parse_porcelain(&z(&["## main...origin/main [ahead 2, behind 13]"]));
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 13);
        assert_eq!(s.branch.as_deref(), Some("main"));
    }

    #[test]
    fn ahead_alone_does_not_leak_into_behind() {
        let s = parse_porcelain(&z(&["## feature/x...origin/feature/x [ahead 1]"]));
        assert_eq!(s.ahead, 1);
        assert_eq!(s.behind, 0);
        assert_eq!(s.branch.as_deref(), Some("feature/x"));
    }

    #[test]
    fn a_branch_without_an_upstream_still_yields_its_name() {
        let s = parse_porcelain(&z(&["## local-only"]));
        assert_eq!(s.branch.as_deref(), Some("local-only"));
    }

    #[test]
    fn a_detached_head_is_flagged_rather_than_named_head() {
        let s = parse_porcelain(&z(&["## HEAD (no branch)"]));
        assert!(s.detached);
        // 短 sha 由调用方补，解析阶段不该编一个名字出来
        assert_eq!(s.branch, None);
    }

    #[test]
    fn a_repo_without_commits_still_reports_its_branch() {
        let s = parse_porcelain(&z(&["## No commits yet on main", "A  first.txt"]));
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.staged, 1);
    }

    #[test]
    fn staged_and_unstaged_columns_are_counted_separately() {
        let s = parse_porcelain(&z(&[
            "## main",
            "M  staged.txt",   // 只在暂存区
            " M unstaged.txt", // 只在工作区
            "MM both.txt",     // 两边都有
        ]));
        assert_eq!(s.staged, 2, "staged.txt 和 both.txt");
        assert_eq!(s.unstaged, 2, "unstaged.txt 和 both.txt");
        // 但「改了多少东西」是文件数，both.txt 不能算两次
        assert_eq!(s.total_changes(), 3);
    }

    #[test]
    fn untracked_entries_are_not_counted_as_staged_or_unstaged() {
        let s = parse_porcelain(&z(&["## main", "?? new.txt", "?? newdir/"]));
        assert_eq!(s.untracked, 2);
        assert_eq!(s.staged, 0);
        assert_eq!(s.unstaged, 0);
        assert_eq!(s.files[0].status, "?");
        assert!(!s.files[0].staged);
    }

    #[test]
    fn a_rename_consumes_its_old_path_instead_of_parsing_it_as_a_status() {
        // 这是 -z 最容易踩的地方：旧路径是一条独立记录，漏掉它就会
        // 把 `src/context/initialState.jsx` 当成一条状态行
        let s = parse_porcelain(&z(&[
            "## main",
            "R  src/context/initialState.js",
            "src/context/initialState.jsx",
            " M package.json",
        ]));
        assert_eq!(s.files.len(), 2, "旧路径不该变成第三条记录");
        assert_eq!(s.files[0].path, "src/context/initialState.js");
        assert_eq!(s.files[0].status, "R");
        assert!(s.files[0].staged);
        assert_eq!(s.files[1].path, "package.json");
    }

    #[test]
    fn a_path_containing_spaces_survives_intact() {
        // -z 不加引号，所以空格是普通字符；按空格切分就会在这里断掉
        let s = parse_porcelain(&z(&["## main", "?? memory module documents/a.md"]));
        assert_eq!(s.files[0].path, "memory module documents/a.md");
    }

    #[test]
    fn conflicts_outrank_the_ordinary_columns() {
        let s = parse_porcelain(&z(&["## main", "UU merged.txt", "AA added-both.txt"]));
        assert_eq!(s.conflicted, 2);
        assert_eq!(s.staged, 0, "冲突不该同时计入暂存");
        assert_eq!(s.unstaged, 0);
        assert!(s.files.iter().all(|f| f.status == "U"));
    }

    #[test]
    fn a_deletion_keeps_its_letter_from_whichever_column_has_it() {
        let s = parse_porcelain(&z(&["## main", "D  gone-staged.txt", " D gone-worktree.txt"]));
        assert_eq!(s.files[0].status, "D");
        assert!(s.files[0].staged);
        assert_eq!(s.files[1].status, "D");
        assert!(!s.files[1].staged, "只在工作区删除，没进暂存区");
    }

    #[test]
    fn ignored_entries_never_reach_the_file_list() {
        let s = parse_porcelain(&z(&["## main", "!! target/", " M real.txt"]));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].path, "real.txt");
    }

    #[test]
    fn the_file_list_is_capped_but_the_counts_are_not() {
        let mut records = vec!["## main".to_string()];
        for i in 0..(MAX_STATUS_FILES + 25) {
            records.push(format!(" M file{i}.txt"));
        }
        let refs: Vec<&str> = records.iter().map(|s| s.as_str()).collect();
        let s = parse_porcelain(&z(&refs));
        assert_eq!(s.files.len(), MAX_STATUS_FILES);
        assert!(s.truncated);
        assert_eq!(s.unstaged as usize, MAX_STATUS_FILES + 25, "计数不受截断影响");
    }

    #[test]
    fn empty_output_is_a_clean_repo_not_a_missing_one() {
        let s = parse_porcelain("");
        assert!(s.is_repo);
        assert_eq!(s.total_changes(), 0);
        assert_eq!(s.branch, None);
    }

    // ==================== 与真实 git 的契约 ====================
    //
    // 上面那些用例验证的是「我读懂了 git 的文档」，这一节验证的是
    // 「git 真的那么输出」—— 未跟踪目录的尾斜杠、重命名占两条记录，
    // 这两条假设错了的话上面全绿也没用。

    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// 在临时目录里建一个干净的仓库。git 不可用时返回 None，调用方跳过测试。
    fn make_repo(tag: &str) -> Option<PathBuf> {
        let dir = std::env::temp_dir().join(format!("petgpt-git-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;

        // -b main 固定初始分支名，免得跟着用户的 init.defaultBranch 走
        run(&dir, &["init", "-b", "main"])?;
        run(&dir, &["config", "user.email", "test@example.com"])?;
        run(&dir, &["config", "user.name", "Test"])?;
        Some(dir)
    }

    fn run(dir: &Path, args: &[&str]) -> Option<()> {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            // 用户的全局 hooks / GPG 签名配置会让这些命令在别人机器上失败
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()?;
        status.success().then_some(())
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    #[tokio::test]
    async fn a_real_repository_reports_its_branch_and_every_kind_of_change() {
        let Some(dir) = make_repo("full") else {
            eprintln!("跳过：机器上没有可用的 git");
            return;
        };
        let root = dir.to_str().unwrap();

        write(&dir, "kept.txt", "original\n");
        write(&dir, "renamed-from.txt", "move me\n");
        write(&dir, "deleted.txt", "remove me\n");
        run(&dir, &["add", "."]).unwrap();
        run(&dir, &["commit", "-m", "init"]).unwrap();

        // 一个改过但没暂存的
        write(&dir, "kept.txt", "changed\n");
        // 一个新增并暂存的
        write(&dir, "added.txt", "new\n");
        run(&dir, &["add", "added.txt"]).unwrap();
        // 一个删掉的
        std::fs::remove_file(dir.join("deleted.txt")).unwrap();
        // 一个重命名的（暂存后 git 才认得出是 rename）
        run(&dir, &["mv", "renamed-from.txt", "renamed-to.txt"]).unwrap();
        // 一个整个未跟踪的目录
        write(&dir, "fresh/inside.txt", "untracked\n");

        let status = read_status(root).await;

        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.detached);

        let by_path = |p: &str| {
            status
                .files
                .iter()
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("清单里没有 {p}：{:?}", status.files))
                .clone()
        };

        assert_eq!(by_path("kept.txt").status, "M");
        assert!(!by_path("kept.txt").staged);

        assert_eq!(by_path("added.txt").status, "A");
        assert!(by_path("added.txt").staged);

        assert_eq!(by_path("deleted.txt").status, "D");

        assert_eq!(by_path("renamed-to.txt").status, "R");
        assert!(
            !status.files.iter().any(|f| f.path == "renamed-from.txt"),
            "重命名的旧路径是 -z 里的第二条记录，不该被当成一条状态",
        );

        // 未跟踪的**目录**整个报一条，带尾斜杠；里面的文件不单列
        assert_eq!(by_path("fresh/").status, "?");
        assert!(
            !status.files.iter().any(|f| f.path == "fresh/inside.txt"),
            "-unormal 不该展开未跟踪目录",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_detached_head_gets_a_short_sha_for_its_branch_name() {
        let Some(dir) = make_repo("detached") else {
            eprintln!("跳过：机器上没有可用的 git");
            return;
        };
        let root = dir.to_str().unwrap();

        write(&dir, "a.txt", "one\n");
        run(&dir, &["add", "."]).unwrap();
        run(&dir, &["commit", "-m", "one"]).unwrap();
        run(&dir, &["checkout", "--detach", "HEAD"]).unwrap();

        let status = read_status(root).await;
        assert!(status.detached);
        let branch = status.branch.expect("detached 时该退回短 sha");
        assert!(
            branch.len() >= 7 && branch.chars().all(|c| c.is_ascii_hexdigit()),
            "应该是一个短 sha，实际是 {branch:?}",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_plain_directory_is_reported_as_not_a_repository() {
        let dir = std::env::temp_dir().join("petgpt-git-test-norepo");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // git 会一路往上找 .git。临时目录本身落在某个仓库里的话（有人把
        // TMPDIR 指进工作区），这里测的就不是「不是仓库」了。与其用
        // GIT_CEILING_DIRECTORIES 去污染整个测试进程的环境，不如先问一句。
        let inside_a_repo = Command::new("git")
            .current_dir(&dir)
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if inside_a_repo {
            eprintln!("跳过：临时目录本身在一个 git 仓库里");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let status = read_status(dir.to_str().unwrap()).await;
        assert!(!status.is_repo);
        assert_eq!(status.branch, None);
        assert_eq!(status.total_changes(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
