//! Managed native QQ connector.
//!
//! PetGPT owns the small Python/MCP runtime and downloads NapCat from official
//! native release channels. Docker is deliberately not supported here.

use crate::database::{mcp_servers, Database};
use crate::mcp::{McpManager, ServerStatus};
use chrono::Utc;
use flate2::read::GzDecoder;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File as StdFile;
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
        let napcat_package_ready = metadata
            .napcat_executable
            .as_deref()
            .map(Path::new)
            .map(|p| p.exists())
            .unwrap_or(false);
        let napcat_running = {
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

    pub async fn install_napcat(&self, app: &AppHandle) -> Result<QqConnectorStatus, String> {
        let _guard = self.install_lock.lock().await;
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
            let status = Command::new("open")
                .arg(&executable)
                .status()
                .await
                .map_err(|e| format!("打开 NapCat macOS 安装器失败: {e}"))?;
            if !status.success() {
                return Err("NapCat macOS 安装器未能打开".to_string());
            }
            Ok("已打开 NapCat macOS 安装器。按官方向导修补 QQ 后返回 PetGPT。".to_string())
        } else {
            self.launch_napcat(None).await?;
            Ok("NapCat AppImage 已启动。".to_string())
        }
    }

    pub async fn launch_napcat(&self, qq: Option<String>) -> Result<(), String> {
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
                return Ok(());
            }
            *guard = None;
        }

        if cfg!(target_os = "linux") {
            let child = Command::new(&executable)
                .arg("--appimage-extract-and-run")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("启动 NapCat AppImage 失败: {e}"))?;
            *guard = Some(child);
            return Ok(());
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
            return Ok(());
        }

        // The macOS installer patches the locally installed QQ application.
        let status = Command::new("open")
            .args(["-a", "QQ"])
            .status()
            .await
            .map_err(|e| format!("启动 QQ 失败: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("无法启动 QQ；请确认已通过 NapCat Installer 完成修补".to_string())
        }
    }

    pub async fn stop_napcat(&self) -> Result<(), String> {
        let mut guard = self.native_child.lock().await;
        if let Some(child) = guard.as_mut() {
            child
                .kill()
                .await
                .map_err(|e| format!("停止 NapCat 失败: {e}"))?;
        }
        *guard = None;
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
        if request.token.trim().is_empty() {
            return Err("WebUI token 不能为空".to_string());
        }
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("{}.napcat", request.token).as_bytes())
        );
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

    async fn session(&self) -> Result<WebUiSession, String> {
        self.webui_session
            .read()
            .await
            .clone()
            .ok_or_else(|| "请先使用 NapCat WebUI token 连接".to_string())
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
        let mut qrcode = data
            .get("qrcodeurl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if !is_login && qrcode.is_none() {
            qrcode = self
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
        self.webui_post_optional::<Value>(
            &session.base_url,
            "/QQLogin/RefreshQRcode",
            json!({}),
            Some(&session.credential),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
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
pub async fn qq_connector_open_installer(
    state: State<'_, Arc<QqConnectorManager>>,
) -> Result<String, String> {
    state.open_installer().await
}

#[tauri::command]
pub async fn qq_connector_launch_napcat(
    state: State<'_, Arc<QqConnectorManager>>,
    qq: Option<String>,
) -> Result<(), String> {
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
}
