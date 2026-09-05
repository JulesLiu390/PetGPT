//! Linux AppImage runtime support. Helpers also compile on macOS so their
//! filesystem, command, and recovery contracts can be tested without a QQ login.

use super::{webui_token_from_config, QqConnectorManager};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::{fs, process::Command};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependencies {
    pub missing: Vec<String>,
    pub can_install: bool,
    pub manual_command: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum PackageManager {
    Apt,
    Dnf,
    Pacman,
}

impl PackageManager {
    fn detect() -> Option<Self> {
        if executable_file(Path::new("/usr/bin/apt-get")) {
            Some(Self::Apt)
        } else if executable_file(Path::new("/usr/bin/dnf")) {
            Some(Self::Dnf)
        } else if executable_file(Path::new("/usr/bin/pacman")) {
            Some(Self::Pacman)
        } else {
            None
        }
    }

    // Fixed commands only: no frontend parameters or downloaded scripts enter
    // the privileged shell. Never upgrade the user's distribution here.
    fn script(self) -> &'static str {
        match self {
            Self::Apt => "set -e\nexport DEBIAN_FRONTEND=noninteractive\n/usr/bin/apt-get update\n/usr/bin/apt-get install -y --no-install-recommends xvfb xauth libgbm1",
            Self::Dnf => "set -e\n/usr/bin/dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth mesa-libgbm",
            Self::Pacman => "set -e\n/usr/bin/pacman -S --needed --noconfirm xorg-server-xvfb xorg-xauth mesa",
        }
    }

    fn manual_command(self) -> &'static str {
        match self {
            Self::Apt => "sudo apt-get update && sudo apt-get install -y xvfb xauth libgbm1",
            Self::Dnf => "sudo dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth mesa-libgbm",
            Self::Pacman => "sudo pacman -S --needed xorg-server-xvfb xorg-xauth mesa",
        }
    }
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| executable_file(&dir.join(name))))
        .unwrap_or(false)
}

fn missing_dependencies(mut exists: impl FnMut(&str) -> bool) -> Vec<String> {
    ["xvfb-run", "Xvfb", "xauth"]
        .into_iter()
        .filter(|name| !exists(name))
        .map(str::to_string)
        .collect()
}

pub fn dependencies() -> Dependencies {
    let manager = PackageManager::detect();
    Dependencies {
        missing: missing_dependencies(command_exists),
        can_install: manager.is_some() && executable_file(Path::new("/usr/bin/pkexec")),
        manual_command: manager.map(|m| m.manual_command().to_string()),
    }
}

pub async fn install_dependencies() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("System dependency installation is only available on Linux.".to_string());
    }
    let manager = PackageManager::detect().ok_or_else(|| {
        "Install Xvfb, xvfb-run, xauth and libgbm using your distribution's package manager."
            .to_string()
    })?;
    if !executable_file(Path::new("/usr/bin/pkexec")) {
        return Err(format!(
            "Administrator authentication is unavailable. Run: {}",
            manager.manual_command()
        ));
    }
    // pkexec presents the desktop's own authentication dialog. Do not time out
    // and kill a package manager in the middle of a system package transaction.
    let output = Command::new("/usr/bin/pkexec")
        .args(["/bin/sh", "-c", manager.script()])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Could not start the dependency installer: {e}"))?;
    if !output.status.success() {
        let details: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .rev()
            .take(2400)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!(
            "Dependency installation was cancelled or failed ({}). {}",
            output.status,
            details.trim()
        ));
    }
    ensure_dependencies()
}

pub fn ensure_dependencies() -> Result<(), String> {
    let report = dependencies();
    if report.missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Missing Linux dependencies: {}. Use Install Linux Dependencies in the QQ setup.{}",
        report.missing.join(", "),
        report
            .manual_command
            .map(|cmd| format!(" Or run: {cmd}"))
            .unwrap_or_default(),
    ))
}

#[derive(Debug)]
pub struct Profile {
    pub root: PathBuf,
    pub home: PathBuf,
    pub user_data: PathBuf,
    pub workdir: PathBuf,
    pub log: PathBuf,
}

impl Profile {
    pub fn new(root: PathBuf) -> Self {
        Self {
            home: root.join("home"),
            user_data: root.join("user-data"),
            workdir: root.join("napcat-workdir"),
            log: root.join("logs/qq-bridge.log"),
            root,
        }
    }

    pub async fn prepare(&self, qq: Option<&str>) -> Result<String, String> {
        for dir in [
            self.root.clone(),
            self.home.clone(),
            self.user_data.clone(),
            self.home.join(".config"),
            self.home.join(".cache"),
            self.home.join(".local/share"),
            self.workdir.join("config"),
            self.workdir.join("cache"),
            self.root.join("logs"),
        ] {
            fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        let path = self.workdir.join("config/webui.json");
        let mut config = match fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                .map_err(|e| format!("Cannot read the saved NapCat WebUI configuration: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e.to_string()),
        };
        let object = config
            .as_object_mut()
            .ok_or("NapCat WebUI configuration must be an object.")?;
        let token =
            webui_token_from_config(&serde_json::to_vec(object).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
        object.insert("host".into(), json!("127.0.0.1"));
        object.insert("port".into(), json!(6099));
        object.insert("token".into(), json!(token));
        if let Some(qq) = qq.filter(|qq| !qq.is_empty() && qq.bytes().all(|b| b.is_ascii_digit())) {
            object.insert("autoLoginAccount".into(), json!(qq));
        }
        // Preserve theme, 2FA, and other user settings; replace atomically.
        let temp = self
            .workdir
            .join(format!("config/.webui-{}.tmp", Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp).await.map_err(|e| e.to_string())?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, &path).await.map_err(|e| e.to_string())?;
        Ok(token)
    }

    pub fn command(&self, executable: &Path, token: &str, qq: Option<&str>) -> Command {
        let mut command = Command::new(executable);
        command
            .arg("--appimage-extract-and-run")
            .arg("--no-sandbox")
            .arg(format!("--user-data-dir={}", self.user_data.display()))
            .arg("--petgpt-qq-bridge")
            // Upstream AppRun overwrites NAPCAT_WORKDIR with pwd. Setting both
            // cwd and the environment keeps config/cache outside the extraction.
            .current_dir(&self.workdir)
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_CACHE_HOME", self.home.join(".cache"))
            .env("XDG_DATA_HOME", self.home.join(".local/share"))
            .env("NAPCAT_WORKDIR", &self.workdir)
            .env("NAPCAT_WEBUI_PREFERRED_PORT", "6099")
            .env("NAPCAT_WEBUI_SECRET_KEY", token)
            .stdin(Stdio::null());
        if let Some(qq) = qq.filter(|qq| !qq.is_empty() && qq.bytes().all(|b| b.is_ascii_digit())) {
            command.env("NAPCAT_QUICK_ACCOUNT", qq);
        }
        #[cfg(unix)]
        command.process_group(0);
        command
    }
}

pub fn matches_process(cmdline: &[u8], profile: &Path) -> bool {
    let expected = format!("--user-data-dir={}", profile.join("user-data").display());
    let args: Vec<_> = cmdline.split(|byte| *byte == 0).collect();
    args.contains(&b"--petgpt-qq-bridge".as_slice()) && args.contains(&expected.as_bytes())
}

async fn wait_for_ready<F: std::future::Future<Output = bool>>(
    child: &mut tokio::process::Child,
    timeout: std::time::Duration,
    mut ready: impl FnMut() -> F,
) -> Result<(), String> {
    tokio::time::timeout(timeout, async {
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("NapCat exited during startup ({status})."));
            }
            if ready().await {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    })
    .await
    .map_err(|_| {
        format!(
            "NapCat WebUI did not become ready within {} seconds.",
            timeout.as_secs()
        )
    })?
}

async fn signal_group(pid: u32, signal: &str) -> bool {
    // Never allow 0/1 or an overflowing PID to address the caller's group.
    if pid <= 1 || pid > i32::MAX as u32 {
        return false;
    }
    Command::new("/bin/kill")
        .args([signal, "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

/// AppImage, xvfb-run, Xvfb and QQ share our new process group. Retain the
/// original PID even when try_wait has reaped the launcher, and escalate for
/// remaining children rather than treating the launcher's exit as completion.
pub async fn terminate_group(pid: u32, mut child: Option<&mut tokio::process::Child>) {
    signal_group(pid, "-TERM").await;
    for _ in 0..20 {
        if let Some(child) = child.as_mut() {
            let _ = child.try_wait();
        }
        if !signal_group(pid, "-0").await {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    if signal_group(pid, "-0").await {
        signal_group(pid, "-KILL").await;
    }
    if let Some(child) = child {
        if tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}

async fn spawn_runtime<F: std::future::Future<Output = bool>>(
    profile: &Profile,
    executable: &Path,
    token: &str,
    qq: Option<&str>,
    timeout: std::time::Duration,
    ready: impl FnMut() -> F,
) -> Result<tokio::process::Child, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let log = options
        .open(&profile.log)
        .map_err(|e| format!("Cannot open NapCat log: {e}"))?;
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let mut child = profile
        .command(executable, token, qq)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| format!("Could not start NapCat AppImage: {e}"))?;
    let pid = child.id().ok_or("NapCat did not provide a process ID.")?;
    let pid_path = profile.root.join("qq-bridge.pid");
    let result = async {
        fs::write(&pid_path, pid.to_string())
            .await
            .map_err(|e| e.to_string())?;
        wait_for_ready(&mut child, timeout, ready).await
    }
    .await;
    if let Err(error) = result {
        terminate_group(pid, Some(&mut child)).await;
        let _ = fs::remove_file(&pid_path).await;
        let details = super::tail_text_file(&profile.log, 2400)
            .await
            .replace(token, "[redacted]");
        return Err(format!(
            "{error}\n{details}\nLog: {}",
            profile.log.display()
        ));
    }
    Ok(child)
}

impl QqConnectorManager {
    pub(super) async fn launch_linux(
        &self,
        executable: &Path,
        qq: Option<&str>,
    ) -> Result<(tokio::process::Child, super::QqNapCatLaunchResult), String> {
        ensure_dependencies()?;
        // A successful spawn is insufficient; also distinguish an occupied
        // port before writing credentials or starting another QQ instance.
        let port = tokio::net::TcpListener::bind("127.0.0.1:6099").await
            .map_err(|_| "NapCat port 6099 is already in use. Stop the other instance before starting managed NapCat.".to_string())?;
        drop(port);
        let profile = Profile::new(self.isolated_profile_dir());
        let token = profile.prepare(qq).await?;
        let mut metadata = self.read_metadata().await;
        metadata.isolated_profile_dir = Some(profile.root.to_string_lossy().into_owned());
        self.write_metadata(&metadata).await?;
        let child = spawn_runtime(
            &profile,
            executable,
            &token,
            qq,
            std::time::Duration::from_secs(60),
            || self.napcat_webui_accepts_token(&token),
        )
        .await?;
        self.invalidate_session().await;
        Ok((
            child,
            super::QqNapCatLaunchResult {
                webui_token: Some(token),
                log_path: Some(profile.log.to_string_lossy().into_owned()),
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependencies_require_the_server_and_auth_tools_not_only_the_wrapper() {
        assert_eq!(
            missing_dependencies(|name| name == "xvfb-run"),
            ["Xvfb", "xauth"]
        );
        assert!(missing_dependencies(|_| true).is_empty());
    }

    #[tokio::test]
    async fn profile_persists_credentials_and_preserves_existing_settings() {
        let root = std::env::temp_dir().join(format!("petgpt-linux-profile-{}", Uuid::new_v4()));
        let profile = Profile::new(root.clone());
        let token = profile.prepare(Some("123456")).await.unwrap();
        let config_path = profile.workdir.join("config/webui.json");
        let mut config: Value =
            serde_json::from_slice(&fs::read(&config_path).await.unwrap()).unwrap();
        assert_eq!(config["host"], "127.0.0.1");
        assert_eq!(config["autoLoginAccount"], "123456");
        config["enable2FA"] = json!(true);
        config["totpSecret"] = json!("preserved");
        fs::write(&config_path, serde_json::to_vec(&config).unwrap())
            .await
            .unwrap();
        assert_eq!(profile.prepare(None).await.unwrap(), token);
        let saved: Value = serde_json::from_slice(&fs::read(&config_path).await.unwrap()).unwrap();
        assert_eq!(saved["enable2FA"], true);
        assert_eq!(saved["totpSecret"], "preserved");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&config_path)
                    .await
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(&root).await.unwrap();
    }

    #[test]
    fn launch_isolates_paths_and_passes_quick_login_without_shell_interpolation() {
        let profile = Profile::new(PathBuf::from("/tmp/profile with spaces"));
        let command = profile.command(Path::new("/tmp/NapCat.AppImage"), "secret", Some("123456"));
        let command = command.as_std();
        assert_eq!(command.get_current_dir(), Some(profile.workdir.as_path()));
        let env: std::collections::HashMap<_, _> = command.get_envs().collect();
        assert_eq!(
            env[std::ffi::OsStr::new("NAPCAT_WORKDIR")],
            Some(profile.workdir.as_os_str())
        );
        assert_eq!(
            env[std::ffi::OsStr::new("NAPCAT_QUICK_ACCOUNT")],
            Some(std::ffi::OsStr::new("123456"))
        );
        assert_eq!(
            env[std::ffi::OsStr::new("HOME")],
            Some(profile.home.as_os_str())
        );
        let args: Vec<_> = command.get_args().collect();
        assert!(args.contains(&std::ffi::OsStr::new(
            "--user-data-dir=/tmp/profile with spaces/user-data"
        )));
    }

    #[test]
    fn process_recovery_requires_both_exact_marker_and_profile() {
        let profile = Path::new("/tmp/private-profile");
        let command = b"/tmp/NapCat.AppImage\0--petgpt-qq-bridge\0--user-data-dir=/tmp/private-profile/user-data\0";
        assert!(matches_process(command, profile));
        assert!(!matches_process(command, Path::new("/tmp/other-profile")));
        assert!(!matches_process(
            b"qq\0--user-data-dir=/tmp/private-profile/user-data\0",
            profile
        ));
    }

    #[tokio::test]
    async fn corrupt_saved_config_is_not_silently_replaced() {
        let root = std::env::temp_dir().join(format!("petgpt-linux-corrupt-{}", Uuid::new_v4()));
        let profile = Profile::new(root.clone());
        profile.prepare(None).await.unwrap();
        let path = profile.workdir.join("config/webui.json");
        fs::write(&path, b"{broken").await.unwrap();
        assert!(profile
            .prepare(None)
            .await
            .unwrap_err()
            .contains("saved NapCat WebUI configuration"));
        assert_eq!(fs::read(&path).await.unwrap(), b"{broken");
        fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn invalid_quick_login_accounts_are_not_passed_to_the_runtime() {
        let profile = Profile::new(PathBuf::from("/tmp/private-profile"));
        let command = profile.command(
            Path::new("/tmp/NapCat.AppImage"),
            "secret",
            Some("123;command"),
        );
        assert!(!command
            .as_std()
            .get_envs()
            .any(|(key, _)| key == "NAPCAT_QUICK_ACCOUNT"));
    }

    #[cfg(unix)]
    async fn fake_runtime(script: &str) -> (Profile, PathBuf, String) {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("petgpt-linux-runtime-{}", Uuid::new_v4()));
        let profile = Profile::new(root);
        let token = profile.prepare(None).await.unwrap();
        let executable = profile.root.join("fake.AppImage");
        fs::write(&executable, format!("#!/bin/sh\n{script}\n"))
            .await
            .unwrap();
        fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        (profile, executable, token)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_reports_early_exit_and_logs_without_exposing_the_token() {
        let (profile, executable, token) =
            fake_runtime("echo \"loader failed: $NAPCAT_WEBUI_SECRET_KEY\" >&2\nexit 7").await;
        let error = spawn_runtime(
            &profile,
            &executable,
            &token,
            None,
            std::time::Duration::from_secs(3),
            || async { false },
        )
        .await
        .unwrap_err();
        assert!(error.contains("NapCat exited during startup"), "{error}");
        assert!(error.contains("loader failed: [redacted]"), "{error}");
        assert!(!error.contains(&token));
        assert!(!profile.root.join("qq-bridge.pid").exists());
        fs::remove_dir_all(profile.root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_timeout_is_bounded_even_when_the_readiness_probe_hangs() {
        let (profile, executable, token) = fake_runtime("exec sleep 30").await;
        let error = spawn_runtime(
            &profile,
            &executable,
            &token,
            None,
            std::time::Duration::from_millis(100),
            || std::future::pending::<bool>(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("WebUI did not become ready"));
        assert!(!profile.root.join("qq-bridge.pid").exists());
        fs::remove_dir_all(profile.root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_start_records_pid_and_stops_the_owned_process_group() {
        let (profile, executable, token) = fake_runtime("exec sleep 30").await;
        let mut child = spawn_runtime(
            &profile,
            &executable,
            &token,
            Some("123456"),
            std::time::Duration::from_secs(3),
            || async { true },
        )
        .await
        .unwrap();
        let pid = child.id().unwrap();
        assert_eq!(
            fs::read_to_string(profile.root.join("qq-bridge.pid"))
                .await
                .unwrap(),
            pid.to_string()
        );
        assert!(child.try_wait().unwrap().is_none());
        terminate_group(pid, Some(&mut child)).await;
        assert!(child.try_wait().unwrap().is_some());
        assert!(!signal_group(pid, "-0").await);
        fs::remove_dir_all(profile.root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_kills_remaining_children_after_the_launcher_has_exited() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; sleep 30 & echo ready; exit 0"])
            .process_group(0)
            .stdout(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .unwrap();
        child.wait().await.unwrap();
        assert!(signal_group(pid, "-0").await);
        terminate_group(pid, Some(&mut child)).await;
        // Give init time to reap the orphan; zombies cannot keep WebUI alive.
        #[cfg(target_os = "macos")]
        {
            for _ in 0..20 {
                if !signal_group(pid, "-0").await {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            assert!(!signal_group(pid, "-0").await);
        }
    }
}
