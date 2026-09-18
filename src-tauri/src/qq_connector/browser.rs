//! Install the browser matching the managed QQ-MCP's Playwright, not a system
//! Python/Playwright or an unrelated npm installation.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const CHECK_SCRIPT: &str = include_str!("browser_check.py");

fn python_path(runtime: &Path, windows: bool) -> PathBuf {
    runtime
        .join("uv-tools")
        .join("qq-agent-mcp")
        .join(if windows {
            "Scripts/python.exe"
        } else {
            "bin/python"
        })
}

fn install_command(python: &Path) -> Command {
    let mut command = Command::new(python);
    command
        .args(["-m", "playwright", "install", "--only-shell", "chromium"])
        // Keep the same cache lookup as QQ-MCP at runtime. Do not garbage-collect
        // browser revisions belonging to the user's other Playwright projects.
        .env("PLAYWRIGHT_SKIP_BROWSER_GC", "1");
    command
}

pub async fn install(runtime: &Path) -> Result<(), String> {
    run_checked(
        install_command(&python_path(runtime, cfg!(windows))),
        Duration::from_secs(600),
        "安装 QQ 截图浏览器失败，请检查网络后重试安装 QQ-MCP",
    )
    .await
}

pub async fn verify(runtime: &Path) -> Result<(), String> {
    let mut command = Command::new(python_path(runtime, cfg!(windows)));
    command.args(["-B", "-c", CHECK_SCRIPT]);
    run_checked(
        command,
        Duration::from_secs(60),
        "QQ 截图浏览器验证失败；Linux 用户请按下方 Playwright 提示补齐系统依赖后重试",
    )
    .await
}

async fn run_checked(mut command: Command, timeout: Duration, context: &str) -> Result<(), String> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("{context}: 操作超时（{} 秒）", timeout.as_secs()))?
        .map_err(|error| format!("{context}: {error}"))?;
    if !output.status.success() {
        // Playwright can report download failures on stdout, not only stderr.
        return Err(format!(
            "{context} ({}):\n{}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_managed_python_on_unix_and_windows() {
        let root = Path::new("app data/qq/runtime");
        assert_eq!(
            python_path(root, false),
            root.join("uv-tools/qq-agent-mcp/bin/python")
        );
        assert_eq!(
            python_path(root, true),
            root.join("uv-tools/qq-agent-mcp/Scripts/python.exe")
        );
    }

    #[test]
    fn installs_only_matching_headless_browser_without_removing_other_caches() {
        let python = python_path(Path::new("app data/qq/runtime"), false);
        let command = install_command(&python);
        let command = command.as_std();
        assert_eq!(command.get_program(), python.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-m", "playwright", "install", "--only-shell", "chromium",]
        );
        assert!(command.get_envs().any(|(key, value)| {
            key == "PLAYWRIGHT_SKIP_BROWSER_GC" && value == Some(std::ffi::OsStr::new("1"))
        }));
        assert!(!command
            .get_envs()
            .any(|(key, _)| key == "PLAYWRIGHT_BROWSERS_PATH"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn accepts_success_and_surfaces_errors_from_both_output_streams() {
        let mut success = Command::new("/bin/sh");
        success.args(["-c", "exit 0"]);
        assert!(run_checked(success, Duration::from_secs(5), "install")
            .await
            .is_ok());

        let mut failure = Command::new("/bin/sh");
        failure.args([
            "-c",
            "printf 'download failed'; printf 'missing library' >&2; exit 7",
        ]);
        let error = run_checked(failure, Duration::from_secs(5), "verify")
            .await
            .unwrap_err();
        assert!(error.contains("verify"));
        assert!(error.contains('7'));
        assert!(error.contains("download failed"));
        assert!(error.contains("missing library"));
    }

    #[tokio::test]
    async fn missing_managed_python_is_an_installation_error() {
        let python = std::env::temp_dir().join(format!("missing-python-{}", uuid::Uuid::new_v4()));
        let error = run_checked(Command::new(python), Duration::from_secs(5), "install")
            .await
            .unwrap_err();
        assert!(error.starts_with("install:"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn limits_the_time_spent_waiting_for_a_stuck_process() {
        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        let error = run_checked(command, Duration::from_millis(20), "verify")
            .await
            .unwrap_err();
        assert!(error.contains("操作超时"));
    }
}
