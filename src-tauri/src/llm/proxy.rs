//! LLM 代理调用 — 为前端 social agent 的 tool loop 提供带超时和并发控制的 HTTP 代理
//!
//! 前端 JS 侧的 `callLLMWithTools` 原本直接使用 `fetch()` 调用 LLM API，
//! 没有超时和并发限制。此模块将 HTTP 调用搬到 Rust 侧：
//! - reqwest 的 `.timeout()` 保证单次请求不会无限等待
//! - tokio Semaphore 限制同时发出的 LLM 请求数量，防止 Observer/Intent/Compress 三方竞争

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use reqwest::Client;
use tokio::sync::Semaphore;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

/// LLM 代理的全局状态
pub struct LlmProxy {
    http_client: Client,
    /// 并发信号量：限制同时发出的 LLM HTTP 请求数
    semaphore: Semaphore,
}

/// 单次请求的超时秒数
const REQUEST_TIMEOUT_SECS: u64 = 90;
/// 最大并发 LLM 请求数（Observer + Intent + Compress 共享）
const MAX_CONCURRENT_REQUESTS: usize = 2;

impl LlmProxy {
    pub fn new() -> Self {
        Self {
            http_client: Client::builder()
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .expect("Failed to build reqwest client"),
            semaphore: Semaphore::new(MAX_CONCURRENT_REQUESTS),
        }
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
    let body_bytes = BASE64.decode(&body_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let body_str = String::from_utf8(body_bytes)
        .map_err(|e| format!("UTF-8 decode error: {}", e))?;
    let body_value: serde_json::Value = serde_json::from_str(&body_str)
        .map_err(|e| format!("Body JSON parse error: {}", e))?;

    // 获取并发许可（若已满则等待，不会无限等——受前面 timeout 保护）
    let _permit = proxy.semaphore
        .acquire()
        .await
        .map_err(|e| format!("Semaphore closed: {}", e))?;

    let mut req = proxy.http_client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    for (key, value) in &headers {
        // Content-Type 已设过，跳过重复
        if key.to_lowercase() == "content-type" {
            continue;
        }
        req = req.header(key.as_str(), value.as_str());
    }

    let response = req
        .json(&body_value)
        .send()
        .await
        .map_err(|e| {
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
