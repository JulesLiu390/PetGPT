//! LLM 代理调用 — 为前端 social agent 的 tool loop 提供带超时和并发控制的 HTTP 代理
//!
//! 前端 JS 侧的 `callLLMWithTools` 原本直接使用 `fetch()` 调用 LLM API，
//! 没有超时和并发限制。此模块将 HTTP 调用搬到 Rust 侧：
//! - reqwest 的 `.timeout()` 保证单次请求不会无限等待
//! - tokio Semaphore 限制同时发出的 LLM 请求数量，防止 Observer/Intent/Compress 三方竞争

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures::StreamExt;
use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, Semaphore};

/// LLM 代理的全局状态
pub struct LlmProxy {
    http_client: Client,
    /// 并发信号量：限制同时发出的 LLM HTTP 请求数
    semaphore: Semaphore,
    /// 图像生成专用 client（更长超时）
    image_gen_client: Client,
    /// 图像生成专用 semaphore（独立并发额度，不挤占 LLM）
    image_gen_semaphore: Semaphore,
    /// Active tool-capable chat streams, keyed by the frontend request id.
    active_streams: Mutex<HashMap<String, Arc<ProxyStreamCancellation>>>,
}

struct ProxyStreamCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl ProxyStreamCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    async fn cancelled(&self) {
        if self.cancelled.load(Ordering::SeqCst) {
            return;
        }

        // Register the waiter before checking the flag again so cancellation
        // cannot fall into the gap between the first check and `.await`.
        let notified = self.notify.notified();
        if self.cancelled.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}

const STREAM_CANCELLED_ERROR: &str = "LLM stream cancelled by user";

#[derive(Debug, Clone, Serialize)]
pub struct ProxyStreamChunk {
    pub request_id: String,
    pub chunk: String,
    pub done: bool,
}

/// 单次请求的超时秒数
const REQUEST_TIMEOUT_SECS: u64 = 180;
/// 最大并发 LLM 请求数（Observer + Intent + Compress 共享）
const MAX_CONCURRENT_REQUESTS: usize = 2;

/// 图像生成单次请求超时（gpt-image-2 等慢 provider 可能 5+ 分钟）
const IMAGE_GEN_TIMEOUT_SECS: u64 = 600;
/// 图像生成最大并发数（可同时画多张主题不同的图）
const MAX_CONCURRENT_IMAGE_GEN: usize = 4;

impl LlmProxy {
    pub fn new() -> Self {
        Self {
            http_client: Client::builder()
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .expect("Failed to build reqwest client"),
            semaphore: Semaphore::new(MAX_CONCURRENT_REQUESTS),
            image_gen_client: Client::builder()
                .timeout(Duration::from_secs(IMAGE_GEN_TIMEOUT_SECS))
                .build()
                .expect("Failed to build image-gen reqwest client"),
            image_gen_semaphore: Semaphore::new(MAX_CONCURRENT_IMAGE_GEN),
            active_streams: Mutex::new(HashMap::new()),
        }
    }

    fn register_stream(&self, request_id: &str) -> Arc<ProxyStreamCancellation> {
        self.active_streams
            .lock()
            .unwrap()
            .entry(request_id.to_string())
            .or_insert_with(|| Arc::new(ProxyStreamCancellation::new()))
            .clone()
    }

    fn unregister_stream(&self, request_id: &str) {
        self.active_streams.lock().unwrap().remove(request_id);
    }

    fn cancel_stream(&self, request_id: &str) -> bool {
        // Keeping a pre-cancelled entry closes the tiny race where the abort
        // IPC reaches Rust just before the stream IPC registers its request.
        let cancellation = self
            .active_streams
            .lock()
            .unwrap()
            .entry(request_id.to_string())
            .or_insert_with(|| Arc::new(ProxyStreamCancellation::new()))
            .clone();
        cancellation.cancel();
        true
    }
}

impl Default for LlmProxy {
    fn default() -> Self {
        Self::new()
    }
}

/// 代理 LLM HTTP POST 请求（非流式）
///
/// 前端传入已由 JS adapter 构建好的 endpoint / headers / bodyB64，
/// Rust 侧只负责发送 + 超时 + 并发控制，返回原始 JSON 响应。
///
/// body 以 Base64 编码形式传入（JS 侧 JSON.stringify → UTF-8 → Base64），
/// 彻底避免 Tauri IPC 传输时 Unicode 转义序列被破坏的问题。
#[tauri::command]
pub async fn llm_proxy_call(
    proxy: tauri::State<'_, Arc<LlmProxy>>,
    endpoint: String,
    headers: HashMap<String, String>,
    body_b64: String,
) -> Result<serde_json::Value, String> {
    // Base64 解码 → UTF-8 → JSON
    let body_bytes = BASE64
        .decode(&body_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let body_str =
        String::from_utf8(body_bytes).map_err(|e| format!("UTF-8 decode error: {}", e))?;
    let body_value: serde_json::Value =
        serde_json::from_str(&body_str).map_err(|e| format!("Body JSON parse error: {}", e))?;

    // 获取并发许可（若已满则等待，不会无限等——受前面 timeout 保护）
    let _permit = proxy
        .semaphore
        .acquire()
        .await
        .map_err(|e| format!("Semaphore closed: {}", e))?;

    let mut req = proxy
        .http_client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    for (key, value) in &headers {
        // Content-Type 已设过，跳过重复
        if key.to_lowercase() == "content-type" {
            continue;
        }
        req = req.header(key.as_str(), value.as_str());
    }

    let response = req.json(&body_value).send().await.map_err(|e| {
        if e.is_timeout() {
            format!("LLM request timed out after {}s", REQUEST_TIMEOUT_SECS)
        } else {
            format!("HTTP error: {}", e)
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status.as_u16(), error_text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    Ok(data)
}

/// 代理 LLM HTTP GET 请求（用于 /models 等浏览器 fetch 可能被 CORS/ATS 拦截的端点）
#[tauri::command]
pub async fn llm_proxy_get(
    proxy: tauri::State<'_, Arc<LlmProxy>>,
    endpoint: String,
    headers: HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let _permit = proxy
        .semaphore
        .acquire()
        .await
        .map_err(|e| format!("Semaphore closed: {}", e))?;

    let mut req = proxy.http_client.get(&endpoint);

    for (key, value) in &headers {
        req = req.header(key.as_str(), value.as_str());
    }

    let response = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("LLM GET request timed out after {}s", REQUEST_TIMEOUT_SECS)
        } else {
            format!("HTTP error: {}", e)
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status.as_u16(), error_text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    Ok(data)
}

/// 代理 LLM HTTP POST 流式请求。
///
/// 前端仍使用各 adapter 原有的 SSE 解析逻辑；Rust 侧只负责发送 HTTP 请求，
/// 并把原始响应字节按文本块通过 Tauri event 转发回来，避免 WKWebView fetch
/// 在局域网/反代/CORS 场景下抛 "Load failed"。
#[tauri::command]
pub async fn llm_proxy_stream(
    app: AppHandle,
    proxy: tauri::State<'_, Arc<LlmProxy>>,
    request_id: String,
    endpoint: String,
    headers: HashMap<String, String>,
    body_b64: String,
) -> Result<(), String> {
    let cancellation = proxy.register_stream(&request_id);
    let result = llm_proxy_stream_inner(
        app,
        proxy.inner().as_ref(),
        &request_id,
        endpoint,
        headers,
        body_b64,
        cancellation,
    )
    .await;
    proxy.unregister_stream(&request_id);
    result
}

async fn llm_proxy_stream_inner(
    app: AppHandle,
    proxy: &LlmProxy,
    request_id: &str,
    endpoint: String,
    headers: HashMap<String, String>,
    body_b64: String,
    cancellation: Arc<ProxyStreamCancellation>,
) -> Result<(), String> {
    let body_bytes = BASE64
        .decode(&body_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let body_str =
        String::from_utf8(body_bytes).map_err(|e| format!("UTF-8 decode error: {}", e))?;
    let body_value: serde_json::Value =
        serde_json::from_str(&body_str).map_err(|e| format!("Body JSON parse error: {}", e))?;

    let _permit = tokio::select! {
        permit = proxy.semaphore.acquire() => {
            permit.map_err(|e| format!("Semaphore closed: {}", e))?
        }
        _ = cancellation.cancelled() => {
            return Err(STREAM_CANCELLED_ERROR.to_string());
        }
    };

    let mut req = proxy
        .http_client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    for (key, value) in &headers {
        if key.to_lowercase() == "content-type" {
            continue;
        }
        req = req.header(key.as_str(), value.as_str());
    }

    let response = tokio::select! {
        response = req.json(&body_value).send() => {
            response.map_err(|e| {
                if e.is_timeout() {
                    format!("LLM stream request timed out after {}s", REQUEST_TIMEOUT_SECS)
                } else {
                    format!("HTTP error: {}", e)
                }
            })?
        }
        _ = cancellation.cancelled() => {
            return Err(STREAM_CANCELLED_ERROR.to_string());
        }
    };

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status.as_u16(), error_text));
    }

    let event_name = format!("llm-proxy-chunk:{}", request_id);
    let mut stream = response.bytes_stream();

    loop {
        let chunk_result = tokio::select! {
            chunk = stream.next() => chunk,
            _ = cancellation.cancelled() => {
                return Err(STREAM_CANCELLED_ERROR.to_string());
            }
        };
        let Some(chunk_result) = chunk_result else {
            break;
        };
        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        let payload = ProxyStreamChunk {
            request_id: request_id.to_string(),
            chunk: String::from_utf8_lossy(&chunk).to_string(),
            done: false,
        };
        app.emit(&event_name, &payload)
            .map_err(|e| format!("Event emit error: {}", e))?;
    }

    let done_payload = ProxyStreamChunk {
        request_id: request_id.to_string(),
        chunk: String::new(),
        done: true,
    };
    app.emit(&event_name, &done_payload)
        .map_err(|e| format!("Event emit error: {}", e))?;

    Ok(())
}

/// Cancel a tool-capable chat stream without waiting for the provider to emit
/// another chunk. Dropping the request future closes the underlying response.
#[tauri::command]
pub fn llm_proxy_cancel_stream(proxy: tauri::State<'_, Arc<LlmProxy>>, request_id: String) -> bool {
    proxy.cancel_stream(&request_id)
}

#[cfg(test)]
mod tests {
    use super::ProxyStreamCancellation;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn stream_cancellation_wakes_an_active_waiter() {
        let cancellation = Arc::new(ProxyStreamCancellation::new());
        let waiter = cancellation.clone();
        let task = tokio::spawn(async move {
            waiter.cancelled().await;
        });

        cancellation.cancel();
        tokio::time::timeout(Duration::from_millis(100), task)
            .await
            .expect("cancel waiter should wake")
            .expect("cancel waiter task should finish");
    }

    #[tokio::test]
    async fn cancellation_before_wait_is_observed() {
        let cancellation = ProxyStreamCancellation::new();
        cancellation.cancel();
        tokio::time::timeout(Duration::from_millis(100), cancellation.cancelled())
            .await
            .expect("pre-cancelled waiter should finish immediately");
    }
}

/// 代理图像生成 HTTP POST 请求
///
/// 与 llm_proxy_call 同样的接口，但使用独立的 client（10 分钟超时）和 semaphore，
/// 不挤占 LLM 调用并发额度。专为 generate_image_send 设计——
/// 部分 image provider（如 gpt-image-2）单次生成需要 3-6 分钟，180s 不够用。
///
/// 用 base64-编码 body 同样为了避免 Tauri IPC Unicode 转义问题。
#[tauri::command]
pub async fn image_gen_proxy_call(
    proxy: tauri::State<'_, Arc<LlmProxy>>,
    endpoint: String,
    headers: HashMap<String, String>,
    body_b64: String,
) -> Result<serde_json::Value, String> {
    let body_bytes = BASE64
        .decode(&body_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let body_str =
        String::from_utf8(body_bytes).map_err(|e| format!("UTF-8 decode error: {}", e))?;
    let body_value: serde_json::Value =
        serde_json::from_str(&body_str).map_err(|e| format!("Body JSON parse error: {}", e))?;

    let _permit = proxy
        .image_gen_semaphore
        .acquire()
        .await
        .map_err(|e| format!("Image-gen semaphore closed: {}", e))?;

    let mut req = proxy
        .image_gen_client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    for (key, value) in &headers {
        if key.to_lowercase() == "content-type" {
            continue;
        }
        req = req.header(key.as_str(), value.as_str());
    }

    let response = req.json(&body_value).send().await.map_err(|e| {
        if e.is_timeout() {
            format!(
                "Image-gen request timed out after {}s",
                IMAGE_GEN_TIMEOUT_SECS
            )
        } else {
            format!("HTTP error: {}", e)
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status.as_u16(), error_text));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    Ok(data)
}
