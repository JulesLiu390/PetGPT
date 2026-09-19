//! GUI 进程的 PATH 修复。
//!
//! 从终端 `npm run tauri:dev` 启动时，进程继承了终端的 PATH，什么都找得到；
//! 而双击 .app 启动时进程由 launchd（macOS）或桌面环境（Linux）拉起，PATH
//! 只有系统默认的 `/usr/bin:/bin:/usr/sbin:/sbin`。claude、codex、npx、uvx
//! 这些要么在用户目录下，要么在 homebrew 里，于是打包版一个都找不到：
//!
//! ```text
//! 启动 claude 失败: Unable to spawn claude because:
//!   No viable candidates found in PATH "/usr/bin:/bin:/usr/sbin:/sbin"
//! ```
//!
//! 这不是 PTY 独有的问题 —— subagent 和 MCP server 走的是同一条路。所以
//! 统一在这里解决：问登录 shell 要一份真实的 PATH，缓存下来给所有子进程用。
//!
//! Windows 不受影响：那边 GUI 进程正常继承系统 PATH。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// 等登录 shell 吐出 PATH 的上限。
///
/// 正常在 100ms 内返回，但用户的 profile 里可能有 nvm/conda 之类的慢初始化，
/// 极端情况下甚至有等待输入的交互式命令。超时就退回兜底目录，绝不能让
/// 应用第一次启动 agent 时卡死在这里。
const SHELL_QUERY_TIMEOUT: Duration = Duration::from_secs(3);

/// 登录 shell 查不到时的兜底目录，覆盖常见的包管理器安装位置。
fn fallback_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".deno/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".superset/bin",
        ] {
            dirs.push(home.join(rel));
        }
    }
    for abs in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin",
    ] {
        dirs.push(PathBuf::from(abs));
    }
    dirs
}

/// 把若干段 PATH 合成一条：保持先后顺序、去掉重复项和空项。
///
/// 顺序有意义 —— 前面的目录优先命中，所以登录 shell 给的那份要排在兜底前面，
/// 用户用 nvm 之类切换过的版本才不会被系统里的旧版盖掉。
pub fn merge_paths(segments: &[String]) -> String {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for segment in segments {
        for part in segment.split(':') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            if seen.insert(part.to_string()) {
                out.push(part.to_string());
            }
        }
    }
    out.join(":")
}

/// 问登录 shell 要 PATH。
///
/// 用 `-l`（登录）而不是 `-i`（交互）：登录 shell 会读 `.zprofile`/`.zshenv`
/// 或 `.bash_profile`，这正是 PATH 该被设置的地方；而 `-i` 会把插件、补全、
/// 提示符全加载一遍，既慢又可能往 stdout 里混进别的输出。
#[cfg(unix)]
fn query_login_shell_path() -> Option<String> {
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // printf 而不是 echo：不给结果添尾随换行，也避开各家 shell 的 echo 差异
    let mut child = Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg("printf %s \"$PATH\"")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // 轮询等待，超时就把它杀掉 —— 标准库没有带超时的 wait
    let deadline = Instant::now() + SHELL_QUERY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(unix))]
fn query_login_shell_path() -> Option<String> {
    None
}

fn compute_augmented_path() -> String {
    let mut segments = Vec::new();

    // 登录 shell 的那份排最前：它反映用户真正的工具链选择
    if let Some(from_shell) = query_login_shell_path() {
        segments.push(from_shell);
    }
    // 当前进程的 PATH（dev 模式下就是终端的，已经够用）
    if let Ok(current) = std::env::var("PATH") {
        segments.push(current);
    }
    // 兜底目录：登录 shell 查询失败时，至少常见位置能命中
    segments.push(
        fallback_dirs()
            .iter()
            .filter(|p| p.is_dir())
            .filter_map(|p| p.to_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join(":"),
    );

    merge_paths(&segments)
}

/// 给子进程用的 PATH。首次调用会起一个登录 shell，之后走缓存。
pub fn augmented_path() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(compute_augmented_path)
}

/// 在应用启动时预热，把起登录 shell 的开销挪出用户第一次点「新建会话」的路径。
pub fn prewarm() {
    std::thread::spawn(|| {
        let _ = augmented_path();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_keeps_first_occurrence_order() {
        let merged = merge_paths(&["/a:/b".to_string(), "/c".to_string()]);
        assert_eq!(merged, "/a:/b:/c");
    }

    #[test]
    fn merging_drops_duplicates_but_keeps_the_earliest_position() {
        // 登录 shell 的 /opt/homebrew/bin 要排在系统 /usr/bin 前面，
        // 否则 homebrew 装的版本会被系统自带的旧版盖掉
        let merged = merge_paths(&[
            "/opt/homebrew/bin:/usr/bin".to_string(),
            "/usr/bin:/bin".to_string(),
        ]);
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin:/bin");
    }

    #[test]
    fn merging_ignores_empty_and_whitespace_segments() {
        let merged = merge_paths(&[
            "".to_string(),
            "/a::/b".to_string(),
            "  ".to_string(),
            " /c ".to_string(),
        ]);
        assert_eq!(merged, "/a:/b:/c");
    }

    #[test]
    fn the_augmented_path_is_never_empty_and_covers_the_system_basics() {
        let path = augmented_path();
        assert!(!path.is_empty());
        // 无论登录 shell 查询成功与否，系统目录都该在
        assert!(path.contains("/usr/bin"), "实际: {path}");
    }

    #[test]
    fn the_augmented_path_is_cached_so_repeat_calls_are_free() {
        let first = augmented_path();
        let second = augmented_path();
        // 同一个 &'static str，说明 OnceLock 生效了
        assert!(std::ptr::eq(first, second));
    }

    /// 这条是这个模块存在的理由：打包后进程只有系统 PATH，必须能找到用户
    /// 工具链里的东西。本机没装 claude 就跳过，不在别人机器上误报。
    #[test]
    fn the_augmented_path_can_locate_the_agent_cli_on_this_machine() {
        let Some(home) = dirs::home_dir() else { return };
        let candidates = [
            home.join(".superset/bin/claude"),
            home.join(".local/bin/claude"),
        ];
        let Some(installed) = candidates.iter().find(|p| p.exists()) else {
            return;
        };
        let parent = installed.parent().unwrap().to_str().unwrap();
        let path = augmented_path();
        assert!(
            path.split(':').any(|dir| dir == parent),
            "PATH 里应包含 {parent}，实际: {path}",
        );
    }
}
