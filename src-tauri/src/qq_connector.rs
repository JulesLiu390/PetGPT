//! Managed native QQ connector.
//!
//! PetGPT owns the small Python/MCP runtime and downloads NapCat from official
//! native release channels. Docker is deliberately not supported here.

mod linux;

use crate::database::{mcp_servers, Database};
use crate::mcp::{McpManager, ServerStatus};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use flate2::read::GzDecoder;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{File as StdFile, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use url::Url;
use uuid::Uuid;

const QQ_MCP_SOURCE: &str = "git+https://github.com/JulesLiu390/Amadeus-QQ-MCP.git@41be98028383ab80745a164ae75f9e8840525e18";
const DEFAULT_WEBUI_URL: &str = "http://127.0.0.1:6099";
const MACOS_SOURCE_QQ_APP: &str = "/Applications/QQ.app";
const MACOS_BRIDGE_APP_NAME: &str = "PetGPT QQ Bridge.app";
const MACOS_BRIDGE_BUNDLE_ID: &str = "com.petgpt.qqbridge";
const MACOS_BRIDGE_DISPLAY_NAME: &str = "PetGPT QQ Bridge";
const MACOS_LOADER_NAME: &str = "petgpt-napcat-loader.js";
const MACOS_ISOLATION_VERSION: u32 = 2;
const MACOS_BRIDGE_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_QR_CODE_PNG_BYTES: usize = 1024 * 1024;
/// 快速登录候选列表接口：NapCat 各版本命名不同，按新→旧依次尝试
const QUICK_LOGIN_LIST_PATHS: [&str; 2] = [
    "/QQLogin/GetQuickLoginListNew",
    "/QQLogin/GetQuickLoginList",
];
/// 发起快速登录后等待其完成的轮询次数与间隔（总计约 10 秒）
const QUICK_LOGIN_POLL_ATTEMPTS: u32 = 20;
const QUICK_LOGIN_POLL_INTERVAL: Duration = Duration::from_millis(500);
const REQUIRED_QQ_TOOLS: [&str; 3] = [
    "batch_get_recent_context",
    "send_message",
    "compress_context",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqConnectorProgress {
    stage: String,
    message: String,
    downloaded: Option<u64>,
    total: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorMetadata {
    uv_version: Option<String>,
    qq_mcp_source: Option<String>,
    qq_mcp_executable: Option<String>,
    napcat_version: Option<String>,
    napcat_provider: Option<String>,
    napcat_executable: Option<String>,
    isolated_qq_app: Option<String>,
    isolated_profile_dir: Option<String>,
    isolated_bundle_id: Option<String>,
    source_qq_version: Option<String>,
    source_qq_build: Option<String>,
    isolation_version: Option<u32>,
    installed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqConnectorStatus {
    platform: String,
    arch: String,
    root_dir: String,
    mcp_installed: bool,
    mcp_executable: Option<String>,
    napcat_package_ready: bool,
    napcat_running: bool,
    napcat_provider: Option<String>,
    uv_version: Option<String>,
    napcat_version: Option<String>,
    webui_url: String,
    isolated_runtime: bool,
    isolated_qq_app: Option<String>,
    isolated_profile_dir: Option<String>,
    isolated_bundle_id: Option<String>,
    source_qq_version: Option<String>,
    isolation_version: Option<u32>,
    linux_dependencies: Option<linux::Dependencies>,
    log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqNapCatLaunchResult {
    webui_token: Option<String>,
    log_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebUiLoginRequest {
    #[serde(default = "default_webui_url")]
    base_url: String,
    token: String,
    totp_code: Option<String>,
}

fn default_webui_url() -> String {
    DEFAULT_WEBUI_URL.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebUiLoginResult {
    authenticated: bool,
    require_2fa: bool,
    message: Option<String>,
}

/// 轻量登录态探测结果。
///
/// 和 QqLoginState 的区别：不取二维码、不写任何文件、失败不返回 Err，
/// 因此可以被启动前预检安全地轮询。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqLoginProbe {
    /// WebUI 会话是否可用 —— 为 false 时 is_login 无意义（问不出来，不代表没登录）
    session_ready: bool,
    is_login: bool,
    is_offline: bool,
    uin: Option<String>,
    nickname: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqLoginState {
    webui_reachable: bool,
    authenticated: bool,
    is_login: bool,
    is_offline: bool,
    qrcode: Option<String>,
    login_error: Option<String>,
    account: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteSetupRequest {
    #[serde(default = "default_http_port")]
    http_port: u16,
    #[serde(default = "default_ws_port")]
    ws_port: u16,
    #[serde(default = "default_webui_port")]
    webui_port: u16,
}

fn default_http_port() -> u16 {
    3000
}
fn default_ws_port() -> u16 {
    3001
}
fn default_webui_port() -> u16 {
    6099
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqSetupResult {
    uin: String,
    nickname: String,
    server_id: String,
    server_name: String,
    status: ServerStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QqAccountMapping {
    uin: String,
    nickname: Option<String>,
    avatar_url: Option<String>,
    server_id: String,
    server_name: String,
    provider: String,
    http_port: u16,
    ws_port: u16,
    webui_port: u16,
    last_login_at: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NapCatEnvelope<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

#[derive(Debug, Clone)]
struct WebUiSession {
    base_url: String,
    credential: String,
}

pub struct QqConnectorManager {
    root: PathBuf,
    client: reqwest::Client,
    webui_client: reqwest::Client,
    native_child: Mutex<Option<Child>>,
    webui_session: RwLock<Option<WebUiSession>>,
    install_lock: Mutex<()>,
}

impl QqConnectorManager {
    pub fn new(root: PathBuf) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static("PetGPT-QQ-Connector/0.1"),
        );
        let client = reqwest::Client::builder()
            .default_headers(headers.clone())
            .connect_timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("failed to build QQ connector HTTP client");
        let webui_client = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build NapCat WebUI HTTP client");
        Self {
            root,
            client,
            webui_client,
            native_child: Mutex::new(None),
            webui_session: RwLock::new(None),
            install_lock: Mutex::new(()),
        }
    }

    fn metadata_path(&self) -> PathBuf {
        self.root.join("metadata.json")
    }

    fn runtime_dir(&self) -> PathBuf {
        self.root.join("runtime")
    }

    fn native_dir(&self) -> PathBuf {
        self.root.join("napcat-native")
    }

    fn isolated_dir(&self) -> PathBuf {
        self.root.join("qq-isolated")
    }

    fn isolated_app_path(&self) -> PathBuf {
        self.isolated_dir().join(MACOS_BRIDGE_APP_NAME)
    }

    fn isolated_profile_dir(&self) -> PathBuf {
        self.isolated_dir().join("profile")
    }

    async fn read_metadata(&self) -> ConnectorMetadata {
        let path = self.metadata_path();
        match fs::read_to_string(path).await {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => ConnectorMetadata::default(),
        }
    }

    async fn write_metadata(&self, metadata: &ConnectorMetadata) -> Result<(), String> {
        fs::create_dir_all(&self.root)
            .await
            .map_err(|e| e.to_string())?;
        let target = self.metadata_path();
        let temp = self.root.join(format!("metadata-{}.tmp", Uuid::new_v4()));
        let payload = serde_json::to_vec_pretty(metadata).map_err(|e| e.to_string())?;
        fs::write(&temp, payload).await.map_err(|e| e.to_string())?;
        if fs::try_exists(&target).await.map_err(|e| e.to_string())? {
            fs::remove_file(&target).await.map_err(|e| e.to_string())?;
        }
        fs::rename(temp, target).await.map_err(|e| e.to_string())
    }

    fn emit_progress(
        app: &AppHandle,
        stage: &str,
        message: impl Into<String>,
        downloaded: Option<u64>,
        total: Option<u64>,
    ) {
        let _ = app.emit(
            "qq-connector-progress",
            QqConnectorProgress {
                stage: stage.to_string(),
                message: message.into(),
                downloaded,
                total,
            },
        );
    }

    async fn latest_release(&self, repo: &str) -> Result<GitHubRelease, String> {
        let url = format!("https://api.github.com/repos/{repo}/releases/latest");
        self.client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("读取 {repo} 版本失败: {e}"))?
            .error_for_status()
            .map_err(|e| format!("读取 {repo} 版本失败: {e}"))?
            .json::<GitHubRelease>()
            .await
            .map_err(|e| format!("解析 {repo} 版本失败: {e}"))
    }

    async fn download_asset(
        &self,
        app: &AppHandle,
        stage: &str,
        asset: &GitHubAsset,
        destination: &Path,
    ) -> Result<(), String> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        let temp = destination.with_extension(format!("download-{}", Uuid::new_v4()));
        let response = self
            .client
            .get(&asset.browser_download_url)
            .send()
            .await
            .map_err(|e| format!("下载 {} 失败: {e}", asset.name))?
            .error_for_status()
            .map_err(|e| format!("下载 {} 失败: {e}", asset.name))?;
        let total = response.content_length().or(Some(asset.size));
        let mut stream = response.bytes_stream();
        let mut file = File::create(&temp).await.map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("下载 {} 中断: {e}", asset.name))?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;
            Self::emit_progress(
                app,
                stage,
                format!("正在下载 {}", asset.name),
                Some(downloaded),
                total,
            );
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);

        if let Some(expected) = asset
            .digest
            .as_deref()
            .and_then(|d| d.strip_prefix("sha256:"))
        {
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(expected) {
                let _ = fs::remove_file(&temp).await;
                return Err(format!("{} SHA-256 校验失败", asset.name));
            }
        } else {
            let _ = fs::remove_file(&temp).await;
            return Err(format!(
                "{} 的官方发行记录没有 SHA-256，拒绝安装",
                asset.name
            ));
        }

        if fs::try_exists(destination)
            .await
            .map_err(|e| e.to_string())?
        {
            fs::remove_file(destination)
                .await
                .map_err(|e| e.to_string())?;
        }
        fs::rename(&temp, destination)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn status(&self) -> QqConnectorStatus {
        let metadata = self.read_metadata().await;
        let mcp_executable = metadata
            .qq_mcp_executable
            .clone()
            .filter(|p| Path::new(p).is_file());
        let legacy_napcat_ready = metadata
            .napcat_executable
            .as_deref()
            .map(Path::new)
            .map(|p| p.exists())
            .unwrap_or(false);
        let macos_isolated_runtime = cfg!(target_os = "macos")
            && metadata.isolation_version == Some(MACOS_ISOLATION_VERSION)
            && metadata
                .isolated_qq_app
                .as_deref()
                .map(Path::new)
                .map(|p| p.is_dir())
                .unwrap_or(false)
            && metadata
                .napcat_executable
                .as_deref()
                .map(Path::new)
                .map(|p| p.is_file())
                .unwrap_or(false);
        let isolated_runtime = macos_isolated_runtime || (cfg!(target_os = "linux")
            && legacy_napcat_ready && self.isolated_profile_dir().is_dir());
        let napcat_package_ready = if cfg!(target_os = "macos") {
            macos_isolated_runtime
        } else {
            legacy_napcat_ready
        };
        let child_running = {
            let mut guard = self.native_child.lock().await;
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(None) => true,
                    _ => {
                        *guard = None;
                        false
                    }
                },
                None => false,
            }
        };
        let detached_running = if cfg!(any(target_os = "macos", target_os = "linux")) && !child_running {
            match (
                metadata.isolated_profile_dir.as_deref(),
                managed_runtime_executable(&metadata),
            ) {
                (Some(profile), Some(app)) => {
                    managed_bridge_process_is_running(Path::new(profile), Path::new(app)).await
                }
                _ => false,
            }
        } else {
            false
        };
        let napcat_running = child_running || detached_running;
        let log_path = metadata.isolated_profile_dir.as_ref()
            .map(|profile| Path::new(profile).join("logs/qq-bridge.log").to_string_lossy().into_owned());
        QqConnectorStatus {
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            root_dir: self.root.to_string_lossy().to_string(),
            mcp_installed: mcp_executable.is_some(),
            mcp_executable,
            napcat_package_ready,
            napcat_running,
            napcat_provider: metadata.napcat_provider,
            uv_version: metadata.uv_version,
            napcat_version: metadata.napcat_version,
            webui_url: DEFAULT_WEBUI_URL.to_string(),
            isolated_runtime,
            isolated_qq_app: metadata.isolated_qq_app,
            isolated_profile_dir: metadata.isolated_profile_dir,
            isolated_bundle_id: metadata.isolated_bundle_id,
            source_qq_version: metadata.source_qq_version,
            isolation_version: metadata.isolation_version,
            linux_dependencies: cfg!(target_os = "linux").then(linux::dependencies),
            log_path,
        }
    }

    pub async fn install_mcp(&self, app: &AppHandle) -> Result<QqConnectorStatus, String> {
        let _guard = self.install_lock.lock().await;
        fs::create_dir_all(self.runtime_dir())
            .await
            .map_err(|e| e.to_string())?;
        Self::emit_progress(app, "uv-release", "正在查询 uv 官方版本", None, None);
        let release = self.latest_release("astral-sh/uv").await?;
        let wanted = uv_asset_name()?;
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == wanted)
            .ok_or_else(|| format!("uv {} 没有适用于当前平台的资产 {wanted}", release.tag_name))?;
        let archive = self.runtime_dir().join(&asset.name);
        self.download_asset(app, "uv-download", asset, &archive)
            .await?;

        let uv_dir = self.runtime_dir().join("uv-bin");
        if fs::try_exists(&uv_dir).await.map_err(|e| e.to_string())? {
            fs::remove_dir_all(&uv_dir)
                .await
                .map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&uv_dir)
            .await
            .map_err(|e| e.to_string())?;
        Self::emit_progress(app, "uv-extract", "正在解压 uv", None, None);
        extract_archive(archive.clone(), uv_dir.clone()).await?;
        let _ = fs::remove_file(&archive).await;
        let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
        let uv_path = find_file_named(&uv_dir, uv_name)
            .ok_or_else(|| "uv 发行包中没有找到可执行文件".to_string())?;
        set_executable(&uv_path)?;

        let tool_dir = self.runtime_dir().join("uv-tools");
        let tool_bin = self.runtime_dir().join("bin");
        let python_dir = self.runtime_dir().join("python");
        let cache_dir = self.runtime_dir().join("cache");
        for dir in [&tool_dir, &tool_bin, &python_dir, &cache_dir] {
            fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
        }
        Self::emit_progress(
            app,
            "mcp-install",
            "正在安装独立 Python 与 QQ-MCP",
            None,
            None,
        );
        let output = Command::new(&uv_path)
            .args([
                "tool",
                "install",
                "--force",
                "--python",
                "3.11",
                "--from",
                QQ_MCP_SOURCE,
                "qq-agent-mcp",
            ])
            .env("UV_TOOL_DIR", &tool_dir)
            .env("UV_TOOL_BIN_DIR", &tool_bin)
            .env("UV_PYTHON_INSTALL_DIR", &python_dir)
            .env("UV_CACHE_DIR", &cache_dir)
            .env("UV_NO_MODIFY_PATH", "1")
            .env("UV_MANAGED_PYTHON", "1")
            .output()
            .await
            .map_err(|e| format!("启动 uv 失败: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "安装 QQ-MCP 失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let executable = tool_bin.join(if cfg!(windows) {
            "qq-agent-mcp.exe"
        } else {
            "qq-agent-mcp"
        });
        if !executable.is_file() {
            return Err(format!(
                "QQ-MCP 安装完成但入口不存在: {}",
                executable.display()
            ));
        }
        let mut metadata = self.read_metadata().await;
        metadata.uv_version = Some(release.tag_name);
        metadata.qq_mcp_source = Some(QQ_MCP_SOURCE.to_string());
        metadata.qq_mcp_executable = Some(executable.to_string_lossy().to_string());
        metadata.installed_at = Some(Utc::now().to_rfc3339());
        self.write_metadata(&metadata).await?;
        Self::emit_progress(app, "mcp-ready", "QQ-MCP 运行时已就绪", None, None);
        Ok(self.status().await)
    }

    async fn install_macos_isolated(&self, app: &AppHandle) -> Result<QqConnectorStatus, String> {
        {
            let mut guard = self.native_child.lock().await;
            if let Some(child) = guard.as_mut() {
                if child.try_wait().ok().flatten().is_none() {
                    return Err("请先停止隔离 QQ，再更新运行时".to_string());
                }
                *guard = None;
            }
        }
        let existing_metadata = self.read_metadata().await;
        if let (Some(profile), Some(isolated_app)) = (
            existing_metadata.isolated_profile_dir.as_deref(),
            existing_metadata.isolated_qq_app.as_deref(),
        ) {
            if managed_bridge_process_is_running(Path::new(profile), Path::new(isolated_app)).await
            {
                return Err("请先停止隔离 QQ，再更新运行时".to_string());
            }
        }

        let source_app = PathBuf::from(MACOS_SOURCE_QQ_APP);
        if !source_app.is_dir() {
            return Err("没有在 /Applications 中找到 QQ.app，请先安装官方 QQ".to_string());
        }
        let source_package = qq_package_path(&source_app);
        let source_package_before = fs::read(&source_package)
            .await
            .map_err(|e| format!("读取官方 QQ 入口失败: {e}"))?;
        let source_digest_before = Sha256::digest(&source_package_before);
        let pristine_package = select_pristine_qq_package(&source_package).await?;
        let package_info = qq_package_info(&pristine_package)?;

        Self::emit_progress(
            app,
            "napcat-release",
            "正在查询 NapCat 官方 Shell 版本",
            None,
            None,
        );
        let release = self.latest_release("NapNeko/NapCatQQ").await?;
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == "NapCat.Shell.zip")
            .ok_or_else(|| format!("NapCat {} 缺少 NapCat.Shell.zip", release.tag_name))?;

        fs::create_dir_all(self.native_dir())
            .await
            .map_err(|e| e.to_string())?;
        fs::create_dir_all(self.isolated_dir())
            .await
            .map_err(|e| e.to_string())?;
        let archive = self.native_dir().join("NapCat.Shell.zip");
        let staging_root = self
            .root
            .join(format!(".qq-isolated-staging-{}", Uuid::new_v4()));
        let staging_app = staging_root.join(MACOS_BRIDGE_APP_NAME);
        let final_app = self.isolated_app_path();

        let install_result: Result<PathBuf, String> = async {
            self.download_asset(app, "napcat-download", asset, &archive)
                .await?;
            fs::create_dir_all(&staging_root)
                .await
                .map_err(|e| e.to_string())?;

            Self::emit_progress(
                app,
                "qq-copy",
                "正在创建隔离 QQ 副本（原版 QQ 不会被修改）",
                None,
                None,
            );
            let copy_output = Command::new("/usr/bin/ditto")
                .args(["--clone", "--noqtn"])
                .arg(&source_app)
                .arg(&staging_app)
                .output()
                .await
                .map_err(|e| format!("创建隔离 QQ 副本失败: {e}"))?;
            if !copy_output.status.success() {
                return Err(format!(
                    "创建隔离 QQ 副本失败: {}",
                    String::from_utf8_lossy(&copy_output.stderr).trim()
                ));
            }

            let copied_package = qq_package_path(&staging_app);
            fs::write(&copied_package, &pristine_package)
                .await
                .map_err(|e| format!("恢复隔离副本的原版入口失败: {e}"))?;

            let resources_dir = staging_app.join("Contents/Resources");
            let runtime_dir = resources_dir.join("petgpt-napcat");
            fs::create_dir_all(&runtime_dir)
                .await
                .map_err(|e| e.to_string())?;
            Self::emit_progress(
                app,
                "napcat-extract",
                "正在把 NapCat 安装到隔离 QQ 副本",
                None,
                None,
            );
            extract_archive(archive.clone(), runtime_dir.clone()).await?;
            let runtime_entry = find_file_named(&runtime_dir, "napcat.mjs")
                .ok_or_else(|| "NapCat Shell 中没有找到 napcat.mjs".to_string())?;
            patch_isolated_qq_package(&staging_app, &runtime_entry, &pristine_package).await?;

            Self::emit_progress(
                app,
                "qq-isolate",
                "正在设置独立应用身份和数据目录",
                None,
                None,
            );
            configure_isolated_macos_bundle(&staging_app).await?;

            let source_package_after = fs::read(&source_package)
                .await
                .map_err(|e| format!("复核官方 QQ 入口失败: {e}"))?;
            if Sha256::digest(&source_package_after) != source_digest_before {
                return Err("安全检查失败：官方 QQ 入口在准备过程中发生了变化".to_string());
            }

            replace_managed_directory(&staging_app, &final_app).await?;
            Ok(final_app.join("Contents/MacOS/QQ"))
        }
        .await;

        let _ = fs::remove_file(&archive).await;
        if fs::try_exists(&staging_root).await.unwrap_or(false) {
            let _ = fs::remove_dir_all(&staging_root).await;
        }
        let executable = install_result?;

        let profile_dir = self.isolated_profile_dir();
        for dir in [
            profile_dir.join("home"),
            profile_dir.join("user-data"),
            profile_dir.join("napcat-workdir"),
            profile_dir.join("logs"),
        ] {
            fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
        }
        ensure_isolated_qq_version_config(
            &profile_dir.join("home"),
            &final_app,
            package_info.version.as_deref(),
            package_info.build_version.as_deref(),
        )
        .await?;

        let mut metadata = self.read_metadata().await;
        metadata.napcat_version = Some(release.tag_name);
        metadata.napcat_provider = Some("macos-isolated-copy".to_string());
        metadata.napcat_executable = Some(executable.to_string_lossy().to_string());
        metadata.isolated_qq_app = Some(final_app.to_string_lossy().to_string());
        metadata.isolated_profile_dir = Some(profile_dir.to_string_lossy().to_string());
        metadata.isolated_bundle_id = Some(MACOS_BRIDGE_BUNDLE_ID.to_string());
        metadata.source_qq_version = package_info.version;
        metadata.source_qq_build = package_info.build_version;
        metadata.isolation_version = Some(MACOS_ISOLATION_VERSION);
        metadata.installed_at = Some(Utc::now().to_rfc3339());
        self.write_metadata(&metadata).await?;
        Self::emit_progress(
            app,
            "napcat-ready",
            "隔离 QQ 与 NapCat 已就绪；原版 QQ 保持不变",
            None,
            None,
        );
        Ok(self.status().await)
    }

    pub async fn install_napcat(&self, app: &AppHandle) -> Result<QqConnectorStatus, String> {
        let _guard = self.install_lock.lock().await;
        if cfg!(target_os = "macos") {
            return self.install_macos_isolated(app).await;
        }
        if self.status().await.napcat_running {
            return Err("Stop NapCat before updating the runtime.".to_string());
        }
        let (repo, matcher, provider) = napcat_release_target()?;
        Self::emit_progress(
            app,
            "napcat-release",
            "正在查询 NapCat 官方原生版本",
            None,
            None,
        );
        let release = self.latest_release(repo).await?;
        let asset = release
            .assets
            .iter()
            .find(|asset| matcher(&asset.name))
            .ok_or_else(|| {
                format!(
                    "NapCat {} 没有适用于 {}-{} 的原生资产",
                    release.tag_name,
                    std::env::consts::OS,
                    std::env::consts::ARCH
                )
            })?;
        fs::create_dir_all(self.native_dir())
            .await
            .map_err(|e| e.to_string())?;
        let archive = self.native_dir().join(&asset.name);
        self.download_asset(app, "napcat-download", asset, &archive)
            .await?;

        let executable = if cfg!(target_os = "linux") {
            let target = self.native_dir().join("NapCat.AppImage");
            if target != archive {
                if fs::try_exists(&target).await.map_err(|e| e.to_string())? {
                    fs::remove_file(&target).await.map_err(|e| e.to_string())?;
                }
                fs::rename(&archive, &target)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            set_executable(&target)?;
            target
        } else {
            let extracted = self.native_dir().join("current");
            if fs::try_exists(&extracted)
                .await
                .map_err(|e| e.to_string())?
            {
                fs::remove_dir_all(&extracted)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            fs::create_dir_all(&extracted)
                .await
                .map_err(|e| e.to_string())?;
            Self::emit_progress(
                app,
                "napcat-extract",
                "正在解压 NapCat 原生安装器",
                None,
                None,
            );
            extract_archive(archive.clone(), extracted.clone()).await?;
            let _ = fs::remove_file(&archive).await;
            if cfg!(target_os = "windows") {
                find_file_named(&extracted, "NapCatInstaller.exe")
                    .ok_or_else(|| "NapCat 包中没有找到 NapCatInstaller.exe".to_string())?
            } else {
                find_directory_named(&extracted, "NapCatInstaller.app")
                    .ok_or_else(|| "NapCat 包中没有找到 NapCatInstaller.app".to_string())?
            }
        };

        let mut metadata = self.read_metadata().await;
        metadata.napcat_version = Some(release.tag_name);
        metadata.napcat_provider = Some(provider.to_string());
        metadata.napcat_executable = Some(executable.to_string_lossy().to_string());
        if cfg!(target_os = "linux") {
            let profile = linux::Profile::new(self.isolated_profile_dir());
            profile.prepare(None).await?;
            metadata.isolated_profile_dir = Some(profile.root.to_string_lossy().into_owned());
        }
        metadata.installed_at = Some(Utc::now().to_rfc3339());
        self.write_metadata(&metadata).await?;
        Self::emit_progress(app, "napcat-ready", "NapCat 原生组件已就绪", None, None);
        Ok(self.status().await)
    }

    pub async fn open_installer(&self) -> Result<String, String> {
        let metadata = self.read_metadata().await;
        let executable = metadata
            .napcat_executable
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .ok_or_else(|| "请先下载 NapCat 原生组件".to_string())?;
        if cfg!(target_os = "windows") {
            Command::new(&executable)
                .current_dir(executable.parent().unwrap_or(&self.native_dir()))
                .spawn()
                .map_err(|e| format!("启动 NapCat 安装器失败: {e}"))?;
            Ok("已打开 NapCat Windows 原生安装器。完成安装后返回 PetGPT 启动 NapCat。".to_string())
        } else if cfg!(target_os = "macos") {
            let isolated_app = metadata
                .isolated_qq_app
                .as_deref()
                .map(PathBuf::from)
                .filter(|path| path.is_dir())
                .ok_or_else(|| "请先准备隔离 QQ 运行时".to_string())?;
            let status = Command::new("open")
                .arg("-R")
                .arg(&isolated_app)
                .status()
                .await
                .map_err(|e| format!("在 Finder 中显示隔离 QQ 失败: {e}"))?;
            if !status.success() {
                return Err("无法在 Finder 中显示隔离 QQ".to_string());
            }
            Ok("已在 Finder 中显示 PetGPT 管理的隔离 QQ；原版 QQ 不会被修改。".to_string())
        } else {
            self.launch_napcat(None).await?;
            Ok("NapCat AppImage 已启动。".to_string())
        }
    }

    pub async fn launch_napcat(&self, qq: Option<String>) -> Result<QqNapCatLaunchResult, String> {
        let _install_guard = self.install_lock.lock().await;
        let metadata = self.read_metadata().await;
        let executable = metadata
            .napcat_executable
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .ok_or_else(|| "请先下载 NapCat 原生组件".to_string())?;
        let mut guard = self.native_child.lock().await;
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                return Ok(QqNapCatLaunchResult {
                    webui_token: self.managed_webui_token().await,
                    log_path: metadata.isolated_profile_dir.as_ref().map(|profile|
                        Path::new(profile).join("logs/qq-bridge.log").to_string_lossy().into_owned()),
                });
            }
            *guard = None;
        }
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            if let (Some(profile), Some(app)) = (
                metadata.isolated_profile_dir.as_deref(),
                managed_runtime_executable(&metadata),
            ) {
                if managed_bridge_process_is_running(Path::new(profile), Path::new(app)).await {
                    return Ok(QqNapCatLaunchResult {
                        webui_token: self.managed_webui_token().await,
                        log_path: Some(
                            Path::new(profile)
                                .join("logs/qq-bridge.log")
                                .to_string_lossy()
                                .to_string(),
                        ),
                    });
                }
            }
        }

        if cfg!(target_os = "linux") {
            let (child, result) = self.launch_linux(&executable, qq.as_deref()).await?;
            *guard = Some(child);
            return Ok(result);
        }

        if cfg!(target_os = "windows") {
            let native_dir = self.native_dir();
            let root = executable.parent().unwrap_or(&native_dir);
            let boot = find_file_named(root, "NapCatWinBootMain.exe")
                .ok_or_else(|| "请先运行 NapCatInstaller.exe 完成原生安装".to_string())?;
            let mut command = Command::new(&boot);
            if let Some(qq) = qq.filter(|value| !value.trim().is_empty()) {
                command.arg(qq);
            }
            let child = command
                .current_dir(boot.parent().unwrap_or(root))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("启动 NapCat Windows Runtime 失败: {e}"))?;
            *guard = Some(child);
            return Ok(QqNapCatLaunchResult {
                webui_token: None,
                log_path: None,
            });
        }

        if cfg!(target_os = "macos") {
            if metadata.isolation_version != Some(MACOS_ISOLATION_VERSION) {
                return Err("请先更新并准备隔离 QQ 运行时".to_string());
            }
            let isolated_app = metadata
                .isolated_qq_app
                .as_deref()
                .map(PathBuf::from)
                .filter(|path| path.is_dir())
                .ok_or_else(|| "隔离 QQ 副本不存在，请重新准备运行时".to_string())?;
            let profile_dir = metadata
                .isolated_profile_dir
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_else(|| self.isolated_profile_dir());
            let isolated_home = profile_dir.join("home");
            let user_data = profile_dir.join("user-data");
            let napcat_workdir = profile_dir.join("napcat-workdir");
            let logs_dir = profile_dir.join("logs");
            for dir in [&isolated_home, &user_data, &napcat_workdir, &logs_dir] {
                fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
            }
            let runtime_root = isolated_app.join("Contents/Resources/petgpt-napcat");
            let runtime_entry = find_file_named(&runtime_root, "napcat.mjs")
                .ok_or_else(|| "隔离 QQ 中缺少 NapCat 运行时，请重新准备".to_string())?;
            let version_config = ensure_isolated_qq_version_config(
                &isolated_home,
                &isolated_app,
                metadata.source_qq_version.as_deref(),
                metadata.source_qq_build.as_deref(),
            )
            .await?;
            patch_isolated_hot_updates(&isolated_home, &runtime_entry).await?;

            let package_path = qq_package_path(&isolated_app);
            let log_path = logs_dir.join("qq-bridge.log");
            let webui_token = Uuid::new_v4().simple().to_string();
            let stdout = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .map_err(|e| format!("打开隔离 QQ 日志失败: {e}"))?;
            let stderr = stdout
                .try_clone()
                .map_err(|e| format!("打开隔离 QQ 日志失败: {e}"))?;

            let mut command = Command::new(&executable);
            command
                .arg("--no-sandbox")
                .arg(format!("--user-data-dir={}", user_data.to_string_lossy()))
                .arg("--petgpt-qq-bridge")
                .current_dir(executable.parent().unwrap_or(Path::new(".")))
                .env("CFFIXED_USER_HOME", &isolated_home)
                .env("HOME", &isolated_home)
                .env("NAPCAT_INSTANCE_ID", "petgpt-isolated")
                .env("NAPCAT_WORKDIR", &napcat_workdir)
                .env("NAPCAT_QQ_PACKAGE_INFO_PATH", &package_path)
                .env("NAPCAT_QQ_VERSION_CONFIG_PATH", &version_config)
                .env("NAPCAT_WEBUI_PREFERRED_PORT", "6099")
                .env("NAPCAT_WEBUI_SECRET_KEY", &webui_token)
                .stdin(Stdio::null())
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::from(stderr));
            if let Some(qq) = qq.filter(|value| !value.trim().is_empty()) {
                command.env("NAPCAT_QUICK_ACCOUNT", qq);
            }
            #[cfg(unix)]
            command.process_group(0);

            let mut child = command
                .spawn()
                .map_err(|e| format!("启动隔离 QQ/NapCat 失败: {e}"))?;
            let pid_path = profile_dir.join("qq-bridge.pid");
            if let Some(pid) = child.id() {
                if let Err(error) = fs::write(&pid_path, pid.to_string()).await {
                    terminate_spawned_bridge(&mut child).await;
                    return Err(format!("记录隔离 QQ 进程失败: {error}"));
                }
            }

            let started_at = tokio::time::Instant::now();
            loop {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|e| format!("检查隔离 QQ/NapCat 状态失败: {e}"))?
                {
                    let _ = fs::remove_file(&pid_path).await;
                    let details = tail_text_file(&log_path, 2400).await;
                    return Err(format!(
                        "隔离 QQ/NapCat 启动后立即退出（{status}）{}",
                        if details.is_empty() {
                            String::new()
                        } else {
                            format!("：\n{details}")
                        }
                    ));
                }
                if self.napcat_webui_accepts_token(&webui_token).await {
                    break;
                }
                if started_at.elapsed() >= MACOS_BRIDGE_STARTUP_TIMEOUT {
                    terminate_spawned_bridge(&mut child).await;
                    let _ = fs::remove_file(&pid_path).await;
                    let details = tail_text_file(&log_path, 2400).await;
                    return Err(format!(
                        "隔离 QQ/NapCat 启动超时：20 秒内未能连接本机 WebUI{}",
                        if details.is_empty() {
                            String::new()
                        } else {
                            format!("：\n{details}")
                        }
                    ));
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            *guard = Some(child);
            return Ok(QqNapCatLaunchResult {
                webui_token: Some(webui_token),
                log_path: Some(log_path.to_string_lossy().to_string()),
            });
        }

        Err("当前平台不支持启动 NapCat".to_string())
    }

    async fn napcat_webui_accepts_token(&self, token: &str) -> bool {
        let hash = format!("{:x}", Sha256::digest(format!("{token}.napcat").as_bytes()));
        matches!(
            tokio::time::timeout(
                Duration::from_millis(800),
                self.webui_post_optional::<Value>(
                    DEFAULT_WEBUI_URL,
                    "/auth/login",
                    json!({ "hash": hash, "totpCode": null }),
                    None,
                ),
            )
            .await,
            Ok(Ok(_))
        )
    }

    async fn managed_qrcode_path(&self) -> PathBuf {
        let metadata = self.read_metadata().await;
        metadata
            .isolated_profile_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.isolated_profile_dir())
            .join("napcat-workdir/cache/qrcode.png")
    }

    async fn managed_qrcode_data_url(&self) -> Option<String> {
        let payload = fs::read(self.managed_qrcode_path().await).await.ok()?;
        png_data_url(&payload)
    }

    async fn managed_webui_token(&self) -> Option<String> {
        let metadata = self.read_metadata().await;
        let profile_dir = metadata
            .isolated_profile_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.isolated_profile_dir());
        let payload = fs::read(profile_dir.join("napcat-workdir/config/webui.json"))
            .await
            .ok()?;
        webui_token_from_config(&payload)
    }

    pub async fn stop_napcat(&self) -> Result<(), String> {
        let _install_guard = self.install_lock.lock().await;
        let metadata = self.read_metadata().await;
        let mut guard = self.native_child.lock().await;
        if cfg!(target_os = "linux") {
            if let Some(child) = guard.as_mut() {
                if let Some(pid) = child.id() {
                    linux::terminate_group(pid, Some(child)).await;
                }
            }
            *guard = None;
            if let (Some(profile), Some(executable)) = (
                metadata.isolated_profile_dir.as_deref(), metadata.napcat_executable.as_deref(),
            ) {
                let profile = Path::new(profile);
                if managed_bridge_process_is_running(profile, Path::new(executable)).await {
                    if let Some(pid) = managed_bridge_pid(profile).await {
                        linux::terminate_group(pid, None).await;
                    }
                }
                let _ = fs::remove_file(profile.join("qq-bridge.pid")).await;
            }
            self.invalidate_session().await;
            return Ok(());
        }
        if let Some(child) = guard.as_mut() {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            if let Some(pid) = child.id() {
                let group = format!("-{pid}");
                let _ = Command::new("/bin/kill")
                    .args(["-TERM", &group])
                    .status()
                    .await;
            }
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            child
                .start_kill()
                .map_err(|e| format!("停止 NapCat 失败: {e}"))?;
            if tokio::time::timeout(Duration::from_secs(4), child.wait())
                .await
                .is_err()
            {
                child
                    .kill()
                    .await
                    .map_err(|e| format!("停止 NapCat 失败: {e}"))?;
                let _ = child.wait().await;
            }
        }
        *guard = None;
        drop(guard);
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            if let (Some(profile), Some(app)) = (
                metadata.isolated_profile_dir.as_deref(),
                managed_runtime_executable(&metadata),
            ) {
                terminate_managed_bridge(Path::new(profile), Path::new(app)).await;
            }
        }
        self.invalidate_session().await;
        Ok(())
    }

    async fn webui_post_optional<T: DeserializeOwned>(
        &self,
        base_url: &str,
        path: &str,
        body: Value,
        credential: Option<&str>,
    ) -> Result<Option<T>, String> {
        validate_loopback_url(base_url)?;
        let url = format!("{}/api{}", base_url.trim_end_matches('/'), path);
        let mut request = self.webui_client.post(url).json(&body);
        if let Some(credential) = credential {
            request = request.header(AUTHORIZATION, format!("Bearer {credential}"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("连接 NapCat WebUI 失败: {e}"))?
            .error_for_status()
            .map_err(|e| format!("NapCat WebUI HTTP 错误: {e}"))?;
        let envelope = response
            .json::<NapCatEnvelope<T>>()
            .await
            .map_err(|e| format!("解析 NapCat WebUI 响应失败: {e}"))?;
        if envelope.code != 0 {
            return Err(if envelope.message.is_empty() {
                "NapCat WebUI 请求失败".to_string()
            } else {
                envelope.message
            });
        }
        Ok(envelope.data)
    }

    async fn webui_post<T: DeserializeOwned>(
        &self,
        base_url: &str,
        path: &str,
        body: Value,
        credential: Option<&str>,
    ) -> Result<T, String> {
        self.webui_post_optional(base_url, path, body, credential)
            .await?
            .ok_or_else(|| "NapCat WebUI 返回空数据".to_string())
    }

    pub async fn webui_login(
        &self,
        request: WebUiLoginRequest,
    ) -> Result<WebUiLoginResult, String> {
        validate_loopback_url(&request.base_url)?;
        let token = if request.token.trim().is_empty() {
            self.managed_webui_token()
                .await
                .ok_or_else(|| "WebUI token 不能为空".to_string())?
        } else {
            request.token.trim().to_string()
        };
        let hash = format!("{:x}", Sha256::digest(format!("{token}.napcat").as_bytes()));
        let data: Value = self
            .webui_post(
                &request.base_url,
                "/auth/login",
                json!({ "hash": hash, "totpCode": request.totp_code }),
                None,
            )
            .await?;
        let require_2fa = data
            .get("require2FA")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if require_2fa {
            return Ok(WebUiLoginResult {
                authenticated: false,
                require_2fa: true,
                message: data
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        let credential = data
            .get("Credential")
            .and_then(Value::as_str)
            .ok_or_else(|| "NapCat WebUI 没有返回登录凭证".to_string())?;
        *self.webui_session.write().await = Some(WebUiSession {
            base_url: request.base_url.trim_end_matches('/').to_string(),
            credential: credential.to_string(),
        });
        Ok(WebUiLoginResult {
            authenticated: true,
            require_2fa: false,
            message: None,
        })
    }

    /// 返回一个可用的 WebUI 会话。
    ///
    /// 内存里没有会话时（app 刚重启就是这种状态）不再直接报错要求用户手动连接，
    /// 而是拿 NapCat 落盘的 token 自己登一次。token 在 napcat-workdir/config/webui.json
    /// 里跨重启存在，所以「QQ 明明在线、PetGPT 却说不知道」不该由用户点一下来解决。
    async fn session(&self) -> Result<WebUiSession, String> {
        let existing = { self.webui_session.read().await.clone() };
        if let Some(session) = existing {
            return Ok(session);
        }
        self.restore_session().await
    }

    /// 用落盘的 WebUI token 重建会话。需要双重验证时放弃并要求走设置页手动连接。
    async fn restore_session(&self) -> Result<WebUiSession, String> {
        let result = self
            .webui_login(WebUiLoginRequest {
                base_url: DEFAULT_WEBUI_URL.to_string(),
                // 留空 → webui_login 回落到 managed_webui_token() 读磁盘
                token: String::new(),
                totp_code: None,
            })
            .await?;
        if result.require_2fa {
            return Err("NapCat WebUI 需要双重验证，请在设置中手动连接一次".to_string());
        }
        self.webui_session
            .read()
            .await
            .clone()
            .ok_or_else(|| "NapCat WebUI 会话重建失败".to_string())
    }

    /// 丢弃当前会话，下次 session() 会重新登录。
    /// WebUI credential 只有一小时有效期，过期后所有 /QQLogin/* 调用都会失败。
    async fn invalidate_session(&self) {
        self.webui_session.write().await.take();
    }

    /// 发一次带凭证的 WebUI 请求；凭证过期（一小时）时重建会话并重试一次。
    async fn webui_post_authed_optional<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Value,
    ) -> Result<Option<T>, String> {
        let session = self.session().await?;
        match self
            .webui_post_optional::<T>(
                &session.base_url,
                path,
                body.clone(),
                Some(&session.credential),
            )
            .await
        {
            Ok(value) => Ok(value),
            Err(first_error) => {
                self.invalidate_session().await;
                let Ok(session) = self.session().await else {
                    // 重建都失败了，报原始错误 —— 它更接近真实原因
                    return Err(first_error);
                };
                self.webui_post_optional::<T>(
                    &session.base_url,
                    path,
                    body,
                    Some(&session.credential),
                )
                .await
            }
        }
    }

    async fn webui_post_authed<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Value,
    ) -> Result<T, String> {
        self.webui_post_authed_optional(path, body)
            .await?
            .ok_or_else(|| "NapCat WebUI 返回空数据".to_string())
    }

    /// 列出 NapCat 本地还留有会话、可以免扫码登录的账号。
    ///
    /// 不同 NapCat 版本的接口名和返回结构都不一致，这里按新→旧依次尝试，
    /// 全部失败就返回空列表 —— 拿不到候选只意味着「走扫码」，不是错误。
    pub async fn quick_login_candidates(&self) -> Vec<String> {
        for path in QUICK_LOGIN_LIST_PATHS {
            if let Ok(Some(value)) = self.webui_post_authed_optional::<Value>(path, json!({})).await
            {
                let uins = parse_quick_login_uins(&value);
                if !uins.is_empty() {
                    return uins;
                }
            }
        }
        Vec::new()
    }

    /// 尝试免扫码登录。
    ///
    /// Ok(true)  已登录（本来就登着，或这次快速登录成功）
    /// Ok(false) 没有可用的本地会话 —— 该走扫码了，这是正常结局而非失败
    pub async fn quick_login(&self, preferred_uin: Option<&str>) -> Result<bool, String> {
        let probe = self.login_probe().await;
        if probe.is_login {
            return Ok(true);
        }
        if !probe.session_ready {
            return Err(probe
                .error
                .unwrap_or_else(|| "无法连接 NapCat WebUI".to_string()));
        }

        let candidates = self.quick_login_candidates().await;
        if candidates.is_empty() {
            return Ok(false);
        }

        let preferred = preferred_uin
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let uin = match preferred {
            Some(want) if candidates.iter().any(|item| item == want) => want.to_string(),
            // 记住的号没有本地会话时，只有唯一候选才敢用；
            // 多个候选而无法确定要哪个，宁可让用户扫码也不要登错账号。
            _ if candidates.len() == 1 => candidates[0].clone(),
            _ => return Ok(false),
        };

        self.webui_post_authed_optional::<Value>("/QQLogin/SetQuickLogin", json!({ "uin": uin }))
            .await?;

        for _ in 0..QUICK_LOGIN_POLL_ATTEMPTS {
            tokio::time::sleep(QUICK_LOGIN_POLL_INTERVAL).await;
            if self.login_probe().await.is_login {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 探测 QQ 当前是否在线。
    ///
    /// 刻意不返回 Err：NapCat 没起、WebUI 连不上都是预检要如实展示的正常状态，
    /// 而不是异常。也刻意不碰二维码 —— 取码有副作用（写文件、刷新码），
    /// 不适合放在每几秒一次的轮询里。
    pub async fn login_probe(&self) -> QqLoginProbe {
        let data: Value = match self
            .webui_post_authed("/QQLogin/CheckLoginStatus", json!({}))
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return QqLoginProbe {
                    session_ready: false,
                    error: Some(error),
                    ..Default::default()
                };
            }
        };

        let is_login = data
            .get("isLogin")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_offline = data
            .get("isOffline")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut probe = QqLoginProbe {
            session_ready: true,
            is_login,
            is_offline,
            error: data
                .get("loginError")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            ..Default::default()
        };

        if is_login {
            if let Ok(info) = self
                .webui_post_authed::<Value>("/QQLogin/GetQQLoginInfo", json!({}))
                .await
            {
                probe.uin = info
                    .get("uin")
                    .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_i64().map(|n| n.to_string())));
                probe.nickname = info
                    .get("nick")
                    .or_else(|| info.get("nickname"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
            }
        }

        probe
    }

    pub async fn login_state(&self) -> Result<QqLoginState, String> {
        let session = self.session().await?;
        let data: Value = self
            .webui_post(
                &session.base_url,
                "/QQLogin/CheckLoginStatus",
                json!({}),
                Some(&session.credential),
            )
            .await?;
        let is_login = data
            .get("isLogin")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let account = if is_login {
            self.webui_post::<Value>(
                &session.base_url,
                "/QQLogin/GetQQLoginInfo",
                json!({}),
                Some(&session.credential),
            )
            .await
            .ok()
        } else {
            None
        };
        let mut qrcode_content = data
            .get("qrcodeurl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if !is_login && qrcode_content.is_none() {
            qrcode_content = self
                .webui_post::<Value>(
                    &session.base_url,
                    "/QQLogin/GetQQLoginQrcode",
                    json!({}),
                    Some(&session.credential),
                )
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("qrcode")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
        }
        let qrcode = if is_login {
            None
        } else {
            match qrcode_content.as_deref() {
                Some(value) if value.starts_with("data:image/") => Some(value.to_string()),
                Some(value) => login_qrcode_data_url(value)
                    .or(self.managed_qrcode_data_url().await),
                None => self.managed_qrcode_data_url().await,
            }
        };
        Ok(QqLoginState {
            webui_reachable: true,
            authenticated: true,
            is_login,
            is_offline: data
                .get("isOffline")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            qrcode,
            login_error: data
                .get("loginError")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            account,
        })
    }

    pub async fn refresh_qr(&self) -> Result<QqLoginState, String> {
        let session = self.session().await?;
        let qrcode_path = self.managed_qrcode_path().await;
        let _ = fs::remove_file(&qrcode_path).await;
        self.webui_post_optional::<Value>(
            &session.base_url,
            "/QQLogin/RefreshQRcode",
            json!({}),
            Some(&session.credential),
        )
        .await?;
        for _ in 0..20 {
            if fs::try_exists(&qrcode_path).await.unwrap_or(false) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.login_state().await
    }

    async fn configure_onebot(
        &self,
        http_port: u16,
        ws_port: u16,
        token: &str,
    ) -> Result<(), String> {
        let session = self.session().await?;
        let mut config: Value = self
            .webui_post(
                &session.base_url,
                "/OB11Config/GetConfig",
                json!({}),
                Some(&session.credential),
            )
            .await?;
        let network = config
            .get_mut("network")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "NapCat OneBot 配置缺少 network".to_string())?;
        upsert_named_adapter(
            network,
            "httpServers",
            "petgpt-http",
            json!({
                "name": "petgpt-http", "enable": true, "debug": false,
                "host": "127.0.0.1", "port": http_port,
                "enableCors": false, "enableWebsocket": false,
                "messagePostFormat": "array", "token": token
            }),
        )?;
        upsert_named_adapter(
            network,
            "websocketServers",
            "petgpt-ws",
            json!({
                "name": "petgpt-ws", "enable": true, "debug": false,
                "host": "127.0.0.1", "port": ws_port,
                "messagePostFormat": "array", "reportSelfMessage": true,
                "enableForcePushEvent": true, "heartInterval": 30000,
                "token": token
            }),
        )?;
        self.webui_post_optional::<Value>(
            &session.base_url,
            "/OB11Config/SetConfig",
            json!({ "config": serde_json::to_string(&config).map_err(|e| e.to_string())? }),
            Some(&session.credential),
        )
        .await?;
        Ok(())
    }

    async fn account_info(&self) -> Result<(String, String, Value), String> {
        let session = self.session().await?;
        let account: Value = self
            .webui_post(
                &session.base_url,
                "/QQLogin/GetQQLoginInfo",
                json!({}),
                Some(&session.credential),
            )
            .await?;
        let uin = value_as_string(account.get("user_id").or_else(|| account.get("uin")))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "无法从 NapCat 获取 QQ 号".to_string())?;
        let nickname = account
            .get("nickname")
            .and_then(Value::as_str)
            .unwrap_or(&uin)
            .to_string();
        Ok((uin, nickname, account))
    }

    fn mcp_executable(&self, metadata: &ConnectorMetadata) -> Result<PathBuf, String> {
        metadata
            .qq_mcp_executable
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .ok_or_else(|| "请先安装 QQ-MCP 运行时".to_string())
    }
}

#[tauri::command]
pub async fn qq_connector_status(
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<QqConnectorStatus, String> {
    Ok(state.status().await)
}

#[tauri::command]
pub async fn qq_connector_install_mcp(
    app: AppHandle,
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<QqConnectorStatus, String> {
    state.install_mcp(&app).await
}

#[tauri::command]
pub async fn qq_connector_install_napcat(
    app: AppHandle,
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<QqConnectorStatus, String> {
    state.install_napcat(&app).await
}

#[tauri::command]
pub async fn qq_connector_install_linux_dependencies(
    app: AppHandle,
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<QqConnectorStatus, String> {
    let _guard = state.install_lock.lock().await;
    QqConnectorManager::emit_progress(&app, "linux-dependencies", "Installing Linux dependencies. Complete the system authentication dialog.", None, None);
    linux::install_dependencies().await?;
    Ok(state.status().await)
}

#[tauri::command]
pub async fn qq_connector_open_installer(
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<String, String> {
    state.open_installer().await
}

#[tauri::command]
pub async fn qq_connector_launch_napcat(
    state: State<'_, Arc<QqConnectorManager>>,
    db: State<'_, Arc<Database>>,
    qq: Option<String>,
) -> Result<QqNapCatLaunchResult, String> {
    // 调用方没显式指定就用记住的账号。快速登录要求 NapCat 启动时就知道登哪个号，
    // 而这个号一直存在 qq_accounts 里 —— 之前只有用户在设置页手输才会传进来。
    let qq = qq
        .filter(|value| !value.trim().is_empty())
        .or_else(|| remembered_qq_uin(&db));
    state.launch_napcat(qq).await
}

#[tauri::command]
pub async fn qq_connector_stop_napcat(
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<(), String> {
    state.stop_napcat().await
}

#[tauri::command]
pub async fn qq_connector_webui_login(
    state: State<'_, Arc<QqConnectorManager>>,
    request: WebUiLoginRequest,
) -> Result<WebUiLoginResult, String> {
    state.webui_login(request).await
}

#[tauri::command]
pub async fn qq_connector_get_login_state(
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<QqLoginState, String> {
    state.login_state().await
}

#[tauri::command]
pub async fn qq_connector_login_probe(
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<QqLoginProbe, String> {
    Ok(state.login_probe().await)
}

/// 尽最大努力把 QQ 弄上线：已登录就直接返回，否则用本地残留会话免扫码登录。
/// 登不上不算错误 —— 返回的探测结果会显示未登录，调用方据此引导扫码。
#[tauri::command]
pub async fn qq_connector_ensure_login(
    state: State<'_, Arc<QqConnectorManager>>,
    db: State<'_, Arc<Database>>,
) -> Result<QqLoginProbe, String> {
    let remembered = remembered_qq_uin(&db);
    let quick_login_error = match state.quick_login(remembered.as_deref()).await {
        Ok(_) => None,
        Err(error) => Some(error),
    };

    let mut probe = state.login_probe().await;
    if !probe.is_login && probe.error.is_none() {
        probe.error = quick_login_error;
    }
    Ok(probe)
}

#[tauri::command]
pub async fn qq_connector_refresh_qr(
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<QqLoginState, String> {
    state.refresh_qr().await
}

#[tauri::command]
pub async fn qq_connector_list_accounts(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<QqAccountMapping>, String> {
    let conn = db.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT q.uin, q.nickname, q.avatar_url, q.mcp_server_id, m.name,
                    q.provider, q.http_port, q.ws_port, q.webui_port, q.last_login_at
             FROM qq_accounts q
             INNER JOIN mcp_servers m ON m.id = q.mcp_server_id
             ORDER BY q.last_login_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(QqAccountMapping {
                uin: row.get(0)?,
                nickname: row.get(1)?,
                avatar_url: row.get(2)?,
                server_id: row.get(3)?,
                server_name: row.get(4)?,
                provider: row.get(5)?,
                http_port: row.get(6)?,
                ws_port: row.get(7)?,
                webui_port: row.get(8)?,
                last_login_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn qq_connector_complete_setup(
    state: State<'_, Arc<QqConnectorManager>>,
    db: State<'_, Arc<Database>>,
    mcp: State<'_, Arc<RwLock<McpManager>>>,
    request: CompleteSetupRequest,
) -> Result<QqSetupResult, String> {
    let (uin, nickname, account) = state.account_info().await?;
    let metadata = state.read_metadata().await;
    let executable = state.mcp_executable(&metadata)?;
    let token = Uuid::new_v4().simple().to_string();
    state
        .configure_onebot(request.http_port, request.ws_port, &token)
        .await?;

    let server_name = format!("qq-{uin}");
    let args = vec![
        "--qq".to_string(),
        uin.clone(),
        "--napcat-host".to_string(),
        "127.0.0.1".to_string(),
        "--napcat-port".to_string(),
        request.http_port.to_string(),
        "--ws-port".to_string(),
        request.ws_port.to_string(),
    ];
    let mut env = HashMap::new();
    env.insert("NAPCAT_ACCESS_TOKEN".to_string(), token);

    let existing = db
        .get_mcp_server_by_name(&server_name)
        .map_err(|e| e.to_string())?;
    let server = if let Some(existing) = existing {
        {
            let manager = mcp.read().await;
            let _ = manager.stop_server(&existing.id).await;
        }
        db.update_mcp_server(
            &existing.id,
            mcp_servers::UpdateMcpServerData {
                name: Some(server_name.clone()),
                transport: Some(mcp_servers::TransportType::Stdio),
                command: Some(executable.to_string_lossy().to_string()),
                args: Some(args.clone()),
                env: Some(env.clone()),
                url: None,
                api_key: None,
                icon: Some("🐧".to_string()),
                auto_start: Some(true),
                show_in_toolbar: Some(true),
                toolbar_order: None,
                max_iterations: None,
            },
        )
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "更新 QQ MCP 配置失败".to_string())?
    } else {
        db.create_mcp_server(mcp_servers::CreateMcpServerData {
            name: server_name.clone(),
            transport: Some(mcp_servers::TransportType::Stdio),
            command: Some(executable.to_string_lossy().to_string()),
            args: Some(args.clone()),
            env: Some(env.clone()),
            url: None,
            api_key: None,
            icon: Some("🐧".to_string()),
            auto_start: Some(true),
            show_in_toolbar: Some(true),
            max_iterations: None,
        })
        .map_err(|e| e.to_string())?
    };

    tokio::time::sleep(Duration::from_millis(700)).await;
    let status = {
        let manager = mcp.read().await;
        manager
            .start_server(
                &server.id,
                &server.name,
                &server.command,
                server.args.clone().unwrap_or_default(),
                server.env.clone().unwrap_or_default(),
            )
            .await?
    };
    let tools: HashSet<&str> = status.tools.iter().map(|tool| tool.name.as_str()).collect();
    let missing: Vec<&str> = REQUIRED_QQ_TOOLS
        .iter()
        .copied()
        .filter(|name| !tools.contains(name))
        .collect();
    if !missing.is_empty() {
        let manager = mcp.read().await;
        let _ = manager.stop_server(&server.id).await;
        return Err(format!(
            "QQ-MCP 工具契约不兼容，缺少: {}",
            missing.join(", ")
        ));
    }

    let avatar_url = account
        .get("avatarUrl")
        .or_else(|| account.get("avatar"))
        .or_else(|| account.get("avatar_url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let now = Utc::now().to_rfc3339();
    {
        let conn = db.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
        conn.execute(
            "INSERT INTO qq_accounts (
                uin, nickname, avatar_url, mcp_server_id, provider,
                http_port, ws_port, webui_port, last_login_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(uin) DO UPDATE SET
                nickname=excluded.nickname,
                avatar_url=excluded.avatar_url,
                mcp_server_id=excluded.mcp_server_id,
                provider=excluded.provider,
                http_port=excluded.http_port,
                ws_port=excluded.ws_port,
                webui_port=excluded.webui_port,
                last_login_at=excluded.last_login_at,
                updated_at=excluded.updated_at",
            rusqlite::params![
                uin,
                nickname,
                avatar_url,
                server.id,
                metadata
                    .napcat_provider
                    .unwrap_or_else(|| "native".to_string()),
                request.http_port,
                request.ws_port,
                request.webui_port,
                now,
                now,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(QqSetupResult {
        uin,
        nickname,
        server_id: server.id,
        server_name,
        status,
    })
}

#[derive(Debug)]
struct QqPackageInfo {
    version: Option<String>,
    build_version: Option<String>,
}

fn qq_package_path(app: &Path) -> PathBuf {
    app.join("Contents/Resources/app/package.json")
}

fn qq_package_info(payload: &[u8]) -> Result<QqPackageInfo, String> {
    let value: Value =
        serde_json::from_slice(payload).map_err(|e| format!("QQ package.json 格式无效: {e}"))?;
    Ok(QqPackageInfo {
        version: value
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        build_version: value.get("buildVersion").and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        }),
    })
}

fn png_data_url(payload: &[u8]) -> Option<String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if payload.len() < PNG_SIGNATURE.len()
        || payload.len() > MAX_QR_CODE_PNG_BYTES
        || !payload.starts_with(PNG_SIGNATURE)
    {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(payload)
    ))
}

/// NapCat commonly returns a login URL, not an image URL. Encode the payload
/// locally, without fetching it or depending on a platform-specific cache file.
fn login_qrcode_data_url(value: &str) -> Option<String> {
    if value.len() > 2048 { return None; }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() { return None; }
    let code = qrcode::QrCode::new(value.as_bytes()).ok()?;
    let scale = 6;
    let size = (code.width() + 8) as u32 * scale;
    let mut bitmap = image::GrayImage::from_pixel(size, size, image::Luma([255]));
    for y in 0..code.width() {
        for x in 0..code.width() {
            if code[(x, y)] == qrcode::Color::Dark {
                for dy in 0..scale {
                    for dx in 0..scale {
                        bitmap.put_pixel((x as u32 + 4) * scale + dx, (y as u32 + 4) * scale + dy, image::Luma([0]));
                    }
                }
            }
        }
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    bitmap.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
    png_data_url(bytes.get_ref())
}

fn webui_token_from_config(payload: &[u8]) -> Option<String> {
    if payload.len() > 64 * 1024 {
        return None;
    }
    serde_json::from_slice::<Value>(payload)
        .ok()?
        .get("token")?
        .as_str()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn is_original_qq_loader(loader: &str) -> bool {
    matches!(
        loader,
        "./application.asar/app_launcher/index.js"
            | "./application/app_launcher/index.js"
            | "./app_launcher/index.js"
    )
}

async fn select_pristine_qq_package(package_path: &Path) -> Result<Vec<u8>, String> {
    let current = fs::read(package_path)
        .await
        .map_err(|e| format!("读取 QQ package.json 失败: {e}"))?;
    let current_json: Value =
        serde_json::from_slice(&current).map_err(|e| format!("QQ package.json 格式无效: {e}"))?;
    if current_json
        .get("main")
        .and_then(Value::as_str)
        .map(is_original_qq_loader)
        .unwrap_or(false)
    {
        return Ok(current);
    }

    let backup_paths = [
        package_path.with_file_name("package.json.petgpt-original"),
        PathBuf::from(format!("{}.bak", package_path.to_string_lossy())),
    ];
    for backup_path in backup_paths {
        let Ok(backup) = fs::read(&backup_path).await else {
            continue;
        };
        let Ok(backup_json) = serde_json::from_slice::<Value>(&backup) else {
            continue;
        };
        if backup_json
            .get("main")
            .and_then(Value::as_str)
            .map(is_original_qq_loader)
            .unwrap_or(false)
        {
            return Ok(backup);
        }
    }
    Err("检测到 QQ 入口已被修改，且没有可用的原版入口备份；请先恢复或重装官方 QQ".to_string())
}

async fn patch_isolated_qq_package(
    app: &Path,
    runtime_entry: &Path,
    pristine_package: &[u8],
) -> Result<(), String> {
    let resources_dir = app.join("Contents/Resources");
    let app_dir = resources_dir.join("app");
    let package_path = app_dir.join("package.json");
    let backup_path = app_dir.join("package.json.petgpt-original");
    let runtime_expression = match runtime_entry.strip_prefix(&resources_dir) {
        Ok(relative) => {
            let literal =
                serde_json::to_string(&relative.to_string_lossy()).map_err(|e| e.to_string())?;
            format!("path.resolve(__dirname, '..', {literal})")
        }
        Err(_) => {
            serde_json::to_string(&runtime_entry.to_string_lossy()).map_err(|e| e.to_string())?
        }
    };
    let loader = format!(
        "const path = require('path');\n\
         const {{ pathToFileURL }} = require('url');\n\
         const runtimePath = {runtime_expression};\n\
         (async () => {{\n\
           await import(pathToFileURL(runtimePath).href);\n\
         }})().catch((error) => {{\n\
           console.error('[PetGPT QQ Bridge] Failed to load NapCat:', error);\n\
           process.exitCode = 1;\n\
         }});\n"
    );
    fs::write(&backup_path, pristine_package)
        .await
        .map_err(|e| format!("保存隔离副本原版入口失败: {e}"))?;
    fs::write(app_dir.join(MACOS_LOADER_NAME), loader)
        .await
        .map_err(|e| format!("写入隔离 NapCat 加载器失败: {e}"))?;

    let mut package: Value = serde_json::from_slice(pristine_package)
        .map_err(|e| format!("QQ package.json 格式无效: {e}"))?;
    let object = package
        .as_object_mut()
        .ok_or_else(|| "QQ package.json 不是对象".to_string())?;
    object.insert(
        "main".to_string(),
        Value::String(format!("./{MACOS_LOADER_NAME}")),
    );
    let payload = serde_json::to_vec_pretty(&package).map_err(|e| e.to_string())?;
    fs::write(&package_path, payload)
        .await
        .map_err(|e| format!("修补隔离 QQ 入口失败: {e}"))
}

async fn ensure_isolated_qq_version_config(
    isolated_home: &Path,
    isolated_app: &Path,
    source_version: Option<&str>,
    source_build: Option<&str>,
) -> Result<PathBuf, String> {
    let package_path = qq_package_path(isolated_app);
    let package_info = if source_version.filter(|value| !value.is_empty()).is_none()
        || source_build.filter(|value| !value.is_empty()).is_none()
    {
        fs::read(&package_path)
            .await
            .ok()
            .and_then(|payload| qq_package_info(&payload).ok())
    } else {
        None
    };
    let version = source_version
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| package_info.as_ref().and_then(|info| info.version.clone()))
        .ok_or_else(|| "隔离 QQ 版本配置缺少 QQ 版本号".to_string())?;
    let build = source_build
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            package_info
                .as_ref()
                .and_then(|info| info.build_version.clone())
        })
        .or_else(|| version.rsplit_once('-').map(|(_, build)| build.to_string()))
        .unwrap_or_else(|| version.clone());

    let versions_dir = isolated_home.join("Library/Application Support/QQ/versions");
    fs::create_dir_all(&versions_dir)
        .await
        .map_err(|e| format!("创建隔离 QQ 版本目录失败: {e}"))?;
    let config_path = versions_dir.join("config.json");
    let mut config = match fs::read(&config_path).await {
        Ok(payload) => serde_json::from_slice::<Value>(&payload)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    };

    for (key, default) in [
        ("unzipRetryCount", json!(0)),
        ("onErrorVersions", json!([])),
        ("readyInstaller", json!("")),
        ("prevVersion", json!("")),
        ("readyVersion", json!("")),
        ("retryTimes", json!(0)),
    ] {
        config.entry(key.to_string()).or_insert(default);
    }
    config.insert("buildId".to_string(), Value::String(build));
    config.insert(
        "baseBundle".to_string(),
        Value::String(isolated_app.to_string_lossy().to_string()),
    );
    config.insert("baseVersion".to_string(), Value::String(version.clone()));
    let has_current_version = config
        .get("curVersion")
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    if !has_current_version {
        config.insert("curVersion".to_string(), Value::String(version));
    }
    config.insert("notarized".to_string(), Value::Bool(false));

    let payload = serde_json::to_vec_pretty(&Value::Object(config))
        .map_err(|e| format!("生成隔离 QQ 版本配置失败: {e}"))?;
    let temp_path = versions_dir.join(format!("config-{}.tmp", Uuid::new_v4()));
    fs::write(&temp_path, payload)
        .await
        .map_err(|e| format!("写入隔离 QQ 版本配置失败: {e}"))?;
    if cfg!(target_os = "windows")
        && fs::try_exists(&config_path)
            .await
            .map_err(|e| format!("检查隔离 QQ 版本配置失败: {e}"))?
    {
        fs::remove_file(&config_path)
            .await
            .map_err(|e| format!("替换隔离 QQ 版本配置失败: {e}"))?;
    }
    if let Err(error) = fs::rename(&temp_path, &config_path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(format!("启用隔离 QQ 版本配置失败: {error}"));
    }
    Ok(config_path)
}

async fn patch_isolated_hot_updates(
    isolated_home: &Path,
    runtime_entry: &Path,
) -> Result<usize, String> {
    let versions_dir = isolated_home.join("Library/Application Support/QQ/versions");
    if !versions_dir.is_dir() {
        return Ok(0);
    }
    let mut update_apps = Vec::new();
    collect_directories_named(&versions_dir, "QQUpdate.app", &mut update_apps);
    let mut patched = 0;
    for update_app in update_apps {
        let package_path = qq_package_path(&update_app);
        if !package_path.is_file() {
            continue;
        }
        let pristine = select_pristine_qq_package(&package_path).await?;
        patch_isolated_qq_package(&update_app, runtime_entry, &pristine).await?;
        patched += 1;
    }
    Ok(patched)
}

async fn configure_isolated_macos_bundle(app: &Path) -> Result<(), String> {
    let plist = app.join("Contents/Info.plist");
    for (key, value) in [
        ("CFBundleIdentifier", MACOS_BRIDGE_BUNDLE_ID),
        ("CFBundleDisplayName", MACOS_BRIDGE_DISPLAY_NAME),
    ] {
        let output = Command::new("/usr/bin/plutil")
            .args(["-replace", key, "-string", value])
            .arg(&plist)
            .output()
            .await
            .map_err(|e| format!("设置隔离 QQ 应用身份失败: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "设置隔离 QQ 应用身份失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }

    // A Tencent-sandboxed binary cannot use a different bundle identifier without
    // Tencent's signing identity. Re-signing only the private copy ad-hoc removes
    // that sandbox coupling; CFFIXED_USER_HOME and --user-data-dir provide the
    // dedicated filesystem boundary when the bridge is launched.
    let sign_output = Command::new("/usr/bin/codesign")
        .args(["--deep", "--force", "--sign", "-"])
        .arg(app)
        .output()
        .await
        .map_err(|e| format!("签名隔离 QQ 副本失败: {e}"))?;
    if !sign_output.status.success() {
        return Err(format!(
            "签名隔离 QQ 副本失败: {}",
            String::from_utf8_lossy(&sign_output.stderr).trim()
        ));
    }
    let verify_output = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app)
        .output()
        .await
        .map_err(|e| format!("验证隔离 QQ 副本签名失败: {e}"))?;
    if !verify_output.status.success() {
        return Err(format!(
            "验证隔离 QQ 副本签名失败: {}",
            String::from_utf8_lossy(&verify_output.stderr).trim()
        ));
    }
    Ok(())
}

async fn replace_managed_directory(staging: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "隔离 QQ 目标目录无效".to_string())?;
    fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let target_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("managed-runtime");
    let backup = parent.join(format!(".{target_name}.previous-{}", Uuid::new_v4()));
    let had_target = fs::try_exists(target).await.map_err(|e| e.to_string())?;
    if had_target {
        fs::rename(target, &backup)
            .await
            .map_err(|e| format!("暂存旧隔离 QQ 失败: {e}"))?;
    }
    if let Err(error) = fs::rename(staging, target).await {
        if had_target {
            let _ = fs::rename(&backup, target).await;
        }
        return Err(format!("启用新隔离 QQ 失败: {error}"));
    }
    if had_target {
        let _ = fs::remove_dir_all(backup).await;
    }
    Ok(())
}

async fn tail_text_file(path: &Path, max_chars: usize) -> String {
    let Ok(payload) = fs::read_to_string(path).await else {
        return String::new();
    };
    let mut tail: String = payload.chars().rev().take(max_chars).collect();
    tail = tail.chars().rev().collect();
    tail.trim().to_string()
}

async fn managed_bridge_pid(profile_dir: &Path) -> Option<u32> {
    fs::read_to_string(profile_dir.join("qq-bridge.pid"))
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// 从快速登录列表响应里抽出可用的 uin。
///
/// 已知的返回形态至少有三种：`["123"]`、`[{"uin":"123"}]`、
/// `{"LocalLoginInfoList":[{"uin":123,"isQuickLogin":true}]}`。
/// 与其赌某个版本，不如全都认；认不出来就返回空列表退回扫码。
fn parse_quick_login_uins(value: &Value) -> Vec<String> {
    let items: Vec<Value> = match value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map
            .get("LocalLoginInfoList")
            .or_else(|| map.get("localLoginInfoList"))
            .or_else(|| map.get("list"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    items
        .iter()
        .filter_map(|item| match item {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            Value::Object(map) => {
                // 明确标注不可快速登录的候选直接跳过
                if map.get("isQuickLogin").and_then(Value::as_bool) == Some(false) {
                    return None;
                }
                map.get("uin").and_then(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| value.as_i64().map(|n| n.to_string()))
                })
            }
            _ => None,
        })
        .map(|uin| uin.trim().to_string())
        .filter(|uin| !uin.is_empty())
        .collect()
}

/// 最近登录过的 QQ 号 —— 快速登录优先用它，避免多账号时登错。
fn remembered_qq_uin(db: &Database) -> Option<String> {
    let conn = db.conn.lock().ok()?;
    conn.query_row(
        "SELECT uin FROM qq_accounts ORDER BY last_login_at DESC LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|uin| !uin.trim().is_empty())
}

async fn managed_bridge_process_is_running(profile_dir: &Path, isolated_app: &Path) -> bool {
    let pid_path = profile_dir.join("qq-bridge.pid");
    let Some(pid) = managed_bridge_pid(profile_dir).await else {
        return false;
    };
    if cfg!(target_os = "linux") {
        let running = fs::read(format!("/proc/{pid}/cmdline")).await
            .map(|cmdline| linux::matches_process(&cmdline, profile_dir))
            .unwrap_or(false);
        if !running { let _ = fs::remove_file(&pid_path).await; }
        return running;
    }
    let Ok(output) = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .await
    else {
        let _ = fs::remove_file(&pid_path).await;
        return false;
    };
    if !output.status.success() {
        let _ = fs::remove_file(&pid_path).await;
        return false;
    }
    let command = String::from_utf8_lossy(&output.stdout);
    let expected_app = isolated_app.to_string_lossy();
    let running = command.contains(expected_app.as_ref()) && command.contains("--petgpt-qq-bridge");
    if !running {
        let _ = fs::remove_file(&pid_path).await;
    }
    running
}

fn managed_runtime_executable(metadata: &ConnectorMetadata) -> Option<&str> {
    if cfg!(target_os = "linux") {
        metadata.napcat_executable.as_deref()
    } else {
        metadata.isolated_qq_app.as_deref()
    }
}

async fn terminate_spawned_bridge(child: &mut Child) {
    let pid = child.id();
    if let Some(pid) = pid {
        let group = format!("-{pid}");
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &group])
            .status()
            .await;
    }
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        if let Some(pid) = pid {
            let group = format!("-{pid}");
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &group])
                .status()
                .await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

async fn terminate_managed_bridge(profile_dir: &Path, isolated_app: &Path) {
    let Some(pid) = managed_bridge_pid(profile_dir).await else {
        return;
    };
    if managed_bridge_process_is_running(profile_dir, isolated_app).await {
        let group = format!("-{pid}");
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &group])
            .status()
            .await;
        for _ in 0..20 {
            if !managed_bridge_process_is_running(profile_dir, isolated_app).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if managed_bridge_process_is_running(profile_dir, isolated_app).await {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &group])
                .status()
                .await;
        }
    }
    let _ = fs::remove_file(profile_dir.join("qq-bridge.pid")).await;
}

fn uv_asset_name() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("uv-aarch64-apple-darwin.tar.gz"),
        ("macos", "x86_64") => Ok("uv-x86_64-apple-darwin.tar.gz"),
        ("windows", "x86_64") => Ok("uv-x86_64-pc-windows-msvc.zip"),
        ("windows", "aarch64") => Ok("uv-aarch64-pc-windows-msvc.zip"),
        ("linux", "x86_64") => Ok("uv-x86_64-unknown-linux-gnu.tar.gz"),
        ("linux", "aarch64") => Ok("uv-aarch64-unknown-linux-gnu.tar.gz"),
        (os, arch) => Err(format!("暂不支持 {os}-{arch} 的 QQ-MCP 运行时")),
    }
}

type AssetMatcher = Box<dyn Fn(&str) -> bool + Send + Sync>;

fn napcat_release_target() -> Result<(&'static str, AssetMatcher, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok((
            "NapNeko/NapCatQQ",
            Box::new(|name| name == "NapCat.Shell.Windows.OneKey.zip"),
            "windows-onekey",
        )),
        ("linux", arch @ ("x86_64" | "aarch64")) => {
            let suffix = if arch == "x86_64" {
                "amd64.AppImage"
            } else {
                "arm64.AppImage"
            };
            Ok((
                "NapNeko/NapCatAppImageBuild",
                Box::new(move |name| name.ends_with(suffix)),
                "linux-appimage",
            ))
        }
        ("macos", _) => Ok((
            "NapNeko/NapCat-Mac-Installer",
            Box::new(|name| name == "NapCatInstaller.zip"),
            "macos-installer",
        )),
        (os, arch) => Err(format!("NapCat 暂无可管理的 {os}-{arch} 原生 Provider")),
    }
}

async fn extract_archive(archive: PathBuf, destination: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let name = archive
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default();
        if name.ends_with(".zip") {
            extract_zip(&archive, &destination)
        } else if name.ends_with(".tar.gz") {
            let file = StdFile::open(&archive).map_err(|e| e.to_string())?;
            let decoder = GzDecoder::new(file);
            let mut tar = tar::Archive::new(decoder);
            tar.unpack(&destination).map_err(|e| e.to_string())
        } else {
            Err(format!("不支持的归档格式: {}", archive.display()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = StdFile::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("归档包含不安全路径: {}", entry.name()))?;
        let output = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = StdFile::create(&output).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&output, std::fs::Permissions::from_mode(mode))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_file_named(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|v| v.to_str()) == Some(name) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

fn find_directory_named(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.file_name().and_then(|v| v.to_str()) == Some(name) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_directory_named(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

fn collect_directories_named(root: &Path, name: &str, output: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) == Some(name) {
            output.push(path);
        } else {
            collect_directories_named(&path, name, output);
        }
    }
}

fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)
            .map_err(|e| e.to_string())?
            .permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(path, permissions).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn validate_loopback_url(raw: &str) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|e| format!("WebUI URL 无效: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("WebUI URL 只支持 HTTP/HTTPS".to_string());
    }
    let host = url.host_str().unwrap_or_default();
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return Err("为防止凭据泄露，QQ 连接器只允许访问本机 NapCat WebUI".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("WebUI URL 只能包含本机地址和端口".to_string());
    }
    Ok(())
}

fn upsert_named_adapter(
    network: &mut serde_json::Map<String, Value>,
    key: &str,
    name: &str,
    value: Value,
) -> Result<(), String> {
    if !network.contains_key(key) {
        network.insert(key.to_string(), Value::Array(Vec::new()));
    }
    let adapters = network
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("NapCat network.{key} 不是数组"))?;
    if let Some(index) = adapters
        .iter()
        .position(|item| item.get("name").and_then(Value::as_str) == Some(name))
    {
        adapters[index] = value;
    } else {
        adapters.push(value);
    }
    Ok(())
}

fn value_as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_login_uins_are_parsed_from_every_known_response_shape() {
        assert_eq!(
            parse_quick_login_uins(&json!(["12345678", "87654321"])),
            vec!["12345678".to_string(), "87654321".to_string()],
        );
        assert_eq!(
            parse_quick_login_uins(&json!([{ "uin": "12345678" }])),
            vec!["12345678".to_string()],
        );
        // 数字型 uin 与包装在对象里的列表
        assert_eq!(
            parse_quick_login_uins(&json!({
                "LocalLoginInfoList": [{ "uin": 12345678i64, "isQuickLogin": true }]
            })),
            vec!["12345678".to_string()],
        );
        assert_eq!(
            parse_quick_login_uins(&json!({ "list": [{ "uin": "12345678" }] })),
            vec!["12345678".to_string()],
        );
    }

    #[test]
    fn accounts_without_a_local_session_are_not_quick_login_candidates() {
        assert_eq!(
            parse_quick_login_uins(&json!([
                { "uin": "111", "isQuickLogin": false },
                { "uin": "222", "isQuickLogin": true },
            ])),
            vec!["222".to_string()],
        );
    }

    #[test]
    fn unrecognised_quick_login_payloads_degrade_to_an_empty_list() {
        // 认不出来就退回扫码，绝不能瞎猜一个 uin 出来登错号
        assert!(parse_quick_login_uins(&json!(null)).is_empty());
        assert!(parse_quick_login_uins(&json!("unexpected")).is_empty());
        assert!(parse_quick_login_uins(&json!({ "unknownKey": [1, 2] })).is_empty());
        assert!(parse_quick_login_uins(&json!([{ "noUin": "x" }])).is_empty());
        assert!(parse_quick_login_uins(&json!(["", "   "])).is_empty());
    }

    #[test]
    fn only_loopback_webui_urls_are_allowed() {
        assert!(validate_loopback_url("http://127.0.0.1:6099").is_ok());
        assert!(validate_loopback_url("http://localhost:6099").is_ok());
        assert!(validate_loopback_url("https://example.com:6099").is_err());
        assert!(validate_loopback_url("http://127.0.0.1:6099/redirect").is_err());
        assert!(validate_loopback_url("http://user:pass@127.0.0.1:6099").is_err());
    }

    #[test]
    fn adapter_upsert_is_idempotent() {
        let mut network = serde_json::Map::new();
        upsert_named_adapter(
            &mut network,
            "httpServers",
            "petgpt-http",
            json!({"name":"petgpt-http","port":3000}),
        )
        .unwrap();
        upsert_named_adapter(
            &mut network,
            "httpServers",
            "petgpt-http",
            json!({"name":"petgpt-http","port":3100}),
        )
        .unwrap();
        let adapters = network["httpServers"].as_array().unwrap();
        assert_eq!(adapters.len(), 1);
        assert_eq!(adapters[0]["port"], 3100);
    }

    #[test]
    fn recognizes_supported_original_qq_loaders() {
        assert!(is_original_qq_loader(
            "./application.asar/app_launcher/index.js"
        ));
        assert!(is_original_qq_loader("./application/app_launcher/index.js"));
        assert!(!is_original_qq_loader("./petgpt-napcat-loader.js"));
    }

    #[test]
    fn converts_only_bounded_png_payloads_to_data_urls() {
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let encoded = png_data_url(png).unwrap();
        assert!(encoded.starts_with("data:image/png;base64,"));
        assert_eq!(
            BASE64_STANDARD
                .decode(encoded.split_once(',').unwrap().1)
                .unwrap(),
            png
        );
        assert!(png_data_url(b"https://txz.qq.com/not-an-image").is_none());
        assert!(png_data_url(&vec![0; MAX_QR_CODE_PNG_BYTES + 1]).is_none());
    }

    #[test]
    fn renders_login_urls_as_real_png_qr_codes_without_fetching_them() {
        let encoded = login_qrcode_data_url("https://example.invalid/login?token=fixture").unwrap();
        let png = BASE64_STANDARD.decode(encoded.split_once(',').unwrap().1).unwrap();
        let bitmap = image::load_from_memory(&png).unwrap().to_luma8();
        assert_eq!(bitmap.width(), bitmap.height());
        assert!(bitmap.width() > 100);
        assert!(bitmap.pixels().any(|pixel| pixel.0 == [0]));
        // Four modules of white quiet zone, at six pixels per module.
        assert!((0..bitmap.width()).all(|x| (0..24).all(|y| bitmap.get_pixel(x, y).0 == [255])));
        assert!(login_qrcode_data_url("javascript:alert(1)").is_none());
        assert!(login_qrcode_data_url("file:///tmp/qrcode.png").is_none());
        assert!(login_qrcode_data_url(&format!("https://example.invalid/{}", "a".repeat(2048))).is_none());
    }

    #[test]
    fn reads_only_non_empty_tokens_from_managed_webui_config() {
        assert_eq!(
            webui_token_from_config(br#"{"token":" managed-secret "}"#).as_deref(),
            Some("managed-secret")
        );
        assert!(webui_token_from_config(br#"{"token":""}"#).is_none());
        assert!(webui_token_from_config(br#"{"host":"::"}"#).is_none());
        assert!(webui_token_from_config(b"not-json").is_none());
    }

    #[tokio::test]
    async fn patches_only_the_isolated_qq_package() {
        let root = std::env::temp_dir().join(format!("petgpt-qq-test-{}", Uuid::new_v4()));
        let app = root.join("PetGPT QQ Bridge.app");
        let app_dir = app.join("Contents/Resources/app");
        let runtime = app.join("Contents/Resources/petgpt-napcat/napcat.mjs");
        fs::create_dir_all(runtime.parent().unwrap()).await.unwrap();
        fs::create_dir_all(&app_dir).await.unwrap();
        fs::write(&runtime, "export {};").await.unwrap();
        let pristine = br#"{
          "main": "./application.asar/app_launcher/index.js",
          "version": "6.9.81-40366",
          "buildVersion": "40366"
        }"#;
        fs::write(app_dir.join("package.json"), pristine)
            .await
            .unwrap();

        patch_isolated_qq_package(&app, &runtime, pristine)
            .await
            .unwrap();

        let patched: Value =
            serde_json::from_slice(&fs::read(app_dir.join("package.json")).await.unwrap()).unwrap();
        assert_eq!(patched["main"], format!("./{MACOS_LOADER_NAME}"));
        assert_eq!(
            fs::read(app_dir.join("package.json.petgpt-original"))
                .await
                .unwrap(),
            pristine
        );
        let loader = fs::read_to_string(app_dir.join(MACOS_LOADER_NAME))
            .await
            .unwrap();
        assert!(loader.contains("petgpt-napcat/napcat.mjs"));
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn uses_petgpt_backup_when_an_isolated_entry_is_already_patched() {
        let root = std::env::temp_dir().join(format!("petgpt-qq-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).await.unwrap();
        let package = root.join("package.json");
        let pristine = br#"{"main":"./application.asar/app_launcher/index.js"}"#;
        fs::write(&package, br#"{"main":"./petgpt-napcat-loader.js"}"#)
            .await
            .unwrap();
        fs::write(root.join("package.json.petgpt-original"), pristine)
            .await
            .unwrap();
        assert_eq!(
            select_pristine_qq_package(&package).await.unwrap(),
            pristine
        );
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn creates_and_repairs_isolated_qq_version_config() {
        let root = std::env::temp_dir().join(format!("petgpt-qq-config-test-{}", Uuid::new_v4()));
        let home = root.join("profile/home");
        let app = root.join("PetGPT QQ Bridge.app");

        let config_path =
            ensure_isolated_qq_version_config(&home, &app, Some("6.9.81-40366"), Some("40366"))
                .await
                .unwrap();
        let created: Value =
            serde_json::from_slice(&fs::read(&config_path).await.unwrap()).unwrap();
        assert_eq!(created["baseBundle"], app.to_string_lossy().as_ref());
        assert_eq!(created["baseVersion"], "6.9.81-40366");
        assert_eq!(created["curVersion"], "6.9.81-40366");
        assert_eq!(created["buildId"], "40366");
        assert_eq!(created["notarized"], false);

        fs::write(
            &config_path,
            serde_json::to_vec(&json!({
                "baseBundle": "/Applications/QQ.app",
                "baseVersion": "6.9.81-40366",
                "curVersion": "6.9.99-99999",
                "buildId": "40366"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        ensure_isolated_qq_version_config(&home, &app, Some("6.9.81-40366"), Some("40366"))
            .await
            .unwrap();
        let repaired: Value =
            serde_json::from_slice(&fs::read(&config_path).await.unwrap()).unwrap();
        assert_eq!(repaired["baseBundle"], app.to_string_lossy().as_ref());
        assert_eq!(repaired["curVersion"], "6.9.99-99999");
        assert_eq!(repaired["notarized"], false);
        assert_eq!(repaired["onErrorVersions"], json!([]));

        fs::remove_dir_all(root).await.unwrap();
    }
}
