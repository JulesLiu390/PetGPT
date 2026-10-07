//! GUI 进程的 PATH 和 LANG 修复。
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
//! `LANG` 是同一个坑的另一面，见 [`utf8_lang`]：launchd 里同样没有它，但修法
//! 不一样——不能问登录 shell，得像 Terminal.app 那样自己合成。
//!
//! Windows 不受影响：那边 GUI 进程正常继承系统 PATH，也不靠 LANG 决定编码。

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
        let _ = utf8_lang();
    });
}

// ── LANG ─────────────────────────────────────────────────────────────
//
// launchd 拉起的 .app 里没有 LANG，子进程全跑在 C locale 下。屏幕显示没事
// （xterm.js 自己按 UTF-8 解码，不看 locale），但凡是在 C locale 下做
// 字节 ↔ 字符转换的程序都会坏。最直观的是 pbcopy：它把 UTF-8 字节当 MacRoman
// 读，内置终端里复制的汉字全变成这样（实测）：
//
// ```text
// 复制汉字测试  →  Â§çÂà∂Ê±âÂ≠óÊµãËØï
// ```
//
// Claude Code 的复制走的就是 pbcopy；往 zsh 里粘贴汉字也会显示成一串转义。
//
// **不能照搬 PATH 的做法去问登录 shell**：Terminal.app 和 iTerm 会替用户设
// LANG（「启动时设置区域环境变量」），所以绝大多数人的 rc 文件里根本没有这
// 一行，问回来也是空的。只能像 Terminal.app 一样从系统区域设置合成。

/// 一个 locale 值是不是 UTF-8 的。`en_US.UTF-8`、`zh_CN.utf8`、`C.UTF-8`，
/// 以及 macOS 上单独给 LC_CTYPE 用的 `UTF-8`，都算。
#[cfg_attr(not(unix), allow(dead_code))]
fn is_utf8_locale(value: &str) -> bool {
    let v = value.to_ascii_lowercase();
    v.contains("utf-8") || v.contains("utf8")
}

/// 父进程的设置够不够用；不够才需要补 LANG。
///
/// LC_ALL 和 LC_CTYPE 只要有人显式设了，就尊重它，不管值是什么：它们的优先级
/// 高于 LANG，补了 LANG 也盖不过去，而且那是用户自己的选择。只有 LANG 缺失
/// 或者不是 UTF-8（比如 `C`）时才补。
#[cfg_attr(not(unix), allow(dead_code))]
fn needs_lang(lang: Option<&str>, lc_all: Option<&str>, lc_ctype: Option<&str>) -> bool {
    let set = |v: Option<&str>| v.is_some_and(|s| !s.trim().is_empty());
    if set(lc_all) || set(lc_ctype) {
        return false;
    }
    !lang.is_some_and(is_utf8_locale)
}

/// 把 macOS 的 AppleLocale 规整成 POSIX locale 名的前半截（不带编码）。
///
/// ```text
/// en_CA            → en_CA
/// en_US@rg=cnzzzz  → en_US   （区域覆盖之类的修饰符）
/// zh-Hans_CN       → zh_CN   （脚本子标签）
/// en               → None    （只有语言没有地区，拼不出有效的 locale）
/// ```
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn posix_locale_base(apple_locale: &str) -> Option<String> {
    let core = apple_locale.split('@').next()?.trim();
    let (lang, region) = core.split_once('_')?;
    let lang = lang.split('-').next()?;
    // 结果会被拼进 /usr/share/locale 下的路径里查，只放行字母和数字
    let ok = |s: &str, f: fn(char) -> bool| !s.is_empty() && s.chars().all(f);
    if !ok(lang, |c| c.is_ascii_alphabetic()) || !ok(region, |c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(format!("{}_{}", lang.to_ascii_lowercase(), region.to_ascii_uppercase()))
}

/// 挑一个系统上确实存在的 UTF-8 locale：用户自己的区域 → en_US → C.UTF-8。
///
/// 最后那档不查存在性：Linux 上 glibc 2.35 起内置了 C.UTF-8，老发行版也基本都带。
#[cfg_attr(not(unix), allow(dead_code))]
fn pick_utf8_locale(preferred_base: Option<&str>, exists: impl Fn(&str) -> bool) -> String {
    if let Some(base) = preferred_base {
        let candidate = format!("{base}.UTF-8");
        if exists(&candidate) {
            return candidate;
        }
    }
    if exists("en_US.UTF-8") {
        return "en_US.UTF-8".to_string();
    }
    "C.UTF-8".to_string()
}

/// `defaults read -g AppleLocale`，比如 `en_CA`。不经过用户的 shell，不会卡住。
#[cfg(target_os = "macos")]
fn apple_locale() -> Option<String> {
    use std::process::{Command, Stdio};

    let output = Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLocale"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
fn locale_exists(name: &str) -> bool {
    std::path::Path::new("/usr/share/locale").join(name).is_dir()
}

#[cfg(unix)]
fn compute_utf8_lang() -> Option<String> {
    let var = |key: &str| std::env::var(key).ok();
    let (lang, lc_all, lc_ctype) = (var("LANG"), var("LC_ALL"), var("LC_CTYPE"));
    if !needs_lang(lang.as_deref(), lc_all.as_deref(), lc_ctype.as_deref()) {
        return None;
    }
    #[cfg(target_os = "macos")]
    let chosen = {
        let preferred = apple_locale().and_then(|l| posix_locale_base(&l));
        pick_utf8_locale(preferred.as_deref(), locale_exists)
    };
    // Linux 的 locale 在 locale-archive 里，按目录查不准；直接走兜底
    #[cfg(not(target_os = "macos"))]
    let chosen = pick_utf8_locale(None, |_| false);
    Some(chosen)
}

#[cfg(not(unix))]
fn compute_utf8_lang() -> Option<String> {
    None
}

/// 子进程该补上的 LANG。父进程已经够用（从终端 `tauri dev`、或者用户自己
/// `launchctl setenv` 过）时为 None，调用方什么都不用做。首次调用读一次系统
/// 区域设置，之后走缓存。
pub fn utf8_lang() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(compute_utf8_lang).as_deref()
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

    // ── LANG ──

    fn only(names: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |n| names.contains(&n)
    }

    #[test]
    fn utf8_locales_are_recognised_in_every_spelling() {
        for v in ["en_US.UTF-8", "zh_CN.utf8", "C.UTF-8", "en_CA.UTF8", "UTF-8"] {
            assert!(is_utf8_locale(v), "{v}");
        }
        for v in ["", "C", "POSIX", "en_US", "en_US.ISO8859-1"] {
            assert!(!is_utf8_locale(v), "{v}");
        }
    }

    /// 打包版的现场：launchd 什么都没给。
    #[test]
    fn a_missing_or_non_utf8_lang_needs_fixing() {
        assert!(needs_lang(None, None, None));
        assert!(needs_lang(Some(""), Some(""), Some("  ")), "空串等于没设");
        assert!(needs_lang(Some("C"), None, None));
        assert!(!needs_lang(Some("en_US.UTF-8"), None, None), "dev 模式继承了终端的，不动");
    }

    #[test]
    fn an_explicit_lc_all_or_lc_ctype_is_respected_whatever_it_says() {
        // 优先级高于 LANG，补了也盖不过去；而且那是用户自己的选择
        assert!(!needs_lang(None, Some("C"), None));
        assert!(!needs_lang(None, None, Some("UTF-8")));
        assert!(!needs_lang(Some("C"), None, Some("C")));
    }

    #[test]
    fn apple_locales_are_normalised_to_posix_names() {
        assert_eq!(posix_locale_base("en_CA").as_deref(), Some("en_CA"));
        assert_eq!(posix_locale_base("en_US@rg=cnzzzz").as_deref(), Some("en_US"));
        assert_eq!(posix_locale_base("zh-Hans_CN").as_deref(), Some("zh_CN"));
        assert_eq!(posix_locale_base("zh-Hant_TW").as_deref(), Some("zh_TW"));
        assert_eq!(posix_locale_base("es_419").as_deref(), Some("es_419"));
        assert_eq!(posix_locale_base("en"), None, "没有地区拼不出 locale");
        assert_eq!(posix_locale_base(""), None);
        // 结果会被拼进 /usr/share/locale 下的路径，不能放 ../ 之类的东西进来
        assert_eq!(posix_locale_base("../x_y"), None);
        assert_eq!(posix_locale_base("en_C/A"), None);
    }

    #[test]
    fn the_users_own_region_wins_then_en_us_then_c_utf8() {
        assert_eq!(pick_utf8_locale(Some("en_CA"), only(&["en_CA.UTF-8", "en_US.UTF-8"])), "en_CA.UTF-8");
        // 用户的区域在系统上没有对应的 locale 文件
        assert_eq!(pick_utf8_locale(Some("es_419"), only(&["en_US.UTF-8"])), "en_US.UTF-8");
        assert_eq!(pick_utf8_locale(None, only(&["en_US.UTF-8"])), "en_US.UTF-8");
        // Linux 那条路：不查存在性，直接兜底
        assert_eq!(pick_utf8_locale(None, |_| false), "C.UTF-8");
    }

    /// 合成出来的名字在 macOS 上真实存在，而不是拼了一个系统不认识的 locale。
    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_the_synthesised_locale_really_exists() {
        assert!(locale_exists("en_US.UTF-8"), "macOS 总该有 en_US.UTF-8");
        if let Some(base) = apple_locale().and_then(|l| posix_locale_base(&l)) {
            let chosen = pick_utf8_locale(Some(&base), locale_exists);
            assert!(locale_exists(&chosen), "选中的 {chosen} 在 /usr/share/locale 里不存在");
        }
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
