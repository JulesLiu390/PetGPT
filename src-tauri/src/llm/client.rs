//! LLM HTTP 客户端

use reqwest::Client;
use crate::llm::types::*;

/// LLM 客户端
pub struct LlmClient {
    http_client: Client,
}

impl LlmClient {
    pub fn new() -> Self {
        Self {
            http_client: Client::new(),
        }
    }

    /// 获取 API 端点
    fn get_endpoint(&self, api_format: &ApiFormat, base_url: Option<&str>) -> String {
        match api_format {
            ApiFormat::OpenaiCompatible => {
                let base = base_url.unwrap_or("https://api.openai.com/v1");
                let base = if base == "default" { "https://api.openai.com/v1" } else { base };
                let base = if !base.contains("/v1") {
                    if base.ends_with('/') {
                        format!("{}v1", base)
                    } else {
                        format!("{}/v1", base)
                    }
                } else {
                    base.to_string()
                };
                format!("{}/chat/completions", base)
            }
            ApiFormat::GeminiOfficial => {
                // Gemini 官方 API
                let base = base_url.unwrap_or("https://generativelanguage.googleapis.com/v1beta");
                format!("{}/models/{{model}}:streamGenerateContent", base)
            }
        }
    }

    /// 构建 OpenAI 兼容的消息格式
    fn build_openai_messages(&self, messages: &[ChatMessage]) -> Vec<OpenAIMessage> {
        messages.iter().map(|msg| {
            let role = match msg.role {
                Role::System => "system",
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::Tool => "tool",
            };
            
            let content = match &msg.content {
                MessageContent::Text(s) => serde_json::json!(s),
                MessageContent::Parts(parts) => {
                    let json_parts: Vec<serde_json::Value> = parts.iter().map(|p| {
                        match p {
                            ContentPart::Text { text } => serde_json::json!({
                                "type": "text",
                                "text": text
                            }),
                            ContentPart::ImageUrl { image_url } => serde_json::json!({
                                "type": "image_url",
                                "image_url": {
                                    "url": image_url.url
                                }
                            }),
                            ContentPart::FileUrl { file_url } => serde_json::json!({
                                "type": "text",
                                "text": format!("[Attachment: {}]", file_url.url)
                            }),
                        }
                    }).collect();
                    serde_json::json!(json_parts)
                }
            };
            
            OpenAIMessage {
                role: role.to_string(),
                content,
            }
        }).collect()
    }

    /// 非流式调用 LLM
    pub async fn call(&self, request: &LlmRequest) -> Result<LlmResponse, String> {
        match request.api_format {
            ApiFormat::OpenaiCompatible => self.call_openai(request).await,
            ApiFormat::GeminiOfficial => self.call_gemini(request).await,
        }
    }

    /// 调用 OpenAI 兼容 API (非流式)
    async fn call_openai(&self, request: &LlmRequest) -> Result<LlmResponse, String> {
        let endpoint = self.get_endpoint(&request.api_format, request.base_url.as_deref());
        
        let openai_request = OpenAIRequest {
            model: request.model.clone(),
            messages: self.build_openai_messages(&request.messages),
            temperature: request.temperature,
            max_tokens: request.max_tokens,
            stream: false,
        };

        let response = self.http_client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", request.api_key))
            .header("Content-Type", "application/json")
            .json(&openai_request)
            .send()
            .await
            .map_err(|e| format!("HTTP error: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("API error {}: {}", status, error_text));
        }

        let openai_response: OpenAIResponse = response
            .json()
            .await
            .map_err(|e| format!("JSON parse error: {}", e))?;

        let content = openai_response.choices
            .first()
            .and_then(|c| c.message.content.clone())
            .unwrap_or_default();

        Ok(LlmResponse {
            content,
            mood: "normal".to_string(),
            error: None,
            tool_calls: None,
        })
    }

    /// 调用 Gemini 官方 API (非流式)
    async fn call_gemini(&self, request: &LlmRequest) -> Result<LlmResponse, String> {
        // Gemini API 需要不同的请求格式
        let mut base_url = request.base_url.clone()
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".to_string());
        
        // 确保 base_url 包含 /v1beta 路径
        if !base_url.contains("/v1beta") {
            base_url = base_url.trim_end_matches('/').to_string();
            base_url.push_str("/v1beta");
        }
        
        let endpoint = format!(
            "{}/models/{}:generateContent?key={}",
            base_url,
            request.model,
            request.api_key
        );

        // 构建 Gemini 请求格式
        let contents: Vec<serde_json::Value> = request.messages.iter()
            .filter(|m| m.role != Role::System)
            .map(|msg| {
                let role = match msg.role {
                    Role::User => "user",
                    Role::Assistant => "model",
                    _ => "user",
                };
                serde_json::json!({
                    "role": role,
                    "parts": [{ "text": msg.content.as_text() }]
                })
            })
            .collect();

        let gemini_request = serde_json::json!({
            "contents": contents,
            "generationConfig": {
                "temperature": request.temperature.unwrap_or(0.7),
                "maxOutputTokens": request.max_tokens.unwrap_or(8192)
            }
        });

        let response = self.http_client
            .post(&endpoint)
            .header("Content-Type", "application/json")
            .json(&gemini_request)
            .send()
            .await
            .map_err(|e| format!("HTTP error: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("API error {}: {}", status, error_text));
        }

        let gemini_response: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("JSON parse error: {}", e))?;

        let content = if let Some(parts) = gemini_response["candidates"][0]["content"]["parts"].as_array() {
            parts.iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        } else {
            String::new()
        };

        Ok(LlmResponse {
            content,
            mood: "normal".to_string(),
            error: None,
            tool_calls: None,
        })
    }
}

impl Default for LlmClient {
    fn default() -> Self {
        Self::new()
    }
}
