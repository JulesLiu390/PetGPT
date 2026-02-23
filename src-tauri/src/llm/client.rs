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
            response_format: {
                // OpenAI strict mode: 自动注入 strict + additionalProperties
                let mut rf = request.response_format.clone();
                if let Some(ref mut val) = rf {
                    if let Some(js) = val.get_mut("json_schema") {
                        js["strict"] = serde_json::json!(true);
                        if let Some(schema) = js.get_mut("schema") {
                            Self::inject_additional_properties_false(schema);
                        }
                    }
                }
                rf
            },
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

        // 提取 system instruction（与 stream.rs 保持一致）
        let system_instruction: Option<serde_json::Value> = request.messages.iter()
            .find(|m| m.role == Role::System)
            .map(|m| {
                serde_json::json!({
                    "parts": [{ "text": m.content.as_text() }]
                })
            });

        let mut generation_config = serde_json::json!({
            "temperature": request.temperature.unwrap_or(0.7),
            "maxOutputTokens": request.max_tokens.unwrap_or(8192)
        });

        // 结构化输出: 将 OpenAI response_format 映射为 Gemini generationConfig 字段
        if let Some(ref rf) = request.response_format {
            // 从 OpenAI 格式 { type: "json_schema", json_schema: { schema: ... } } 提取 schema
            if let Some(schema) = rf.get("json_schema").and_then(|js| js.get("schema")) {
                generation_config["responseMimeType"] = serde_json::json!("application/json");
                // Gemini responseSchema 使用 OpenAPI Schema（大写 type: OBJECT/STRING/BOOLEAN 等）
                let mut converted = schema.clone();
                Self::convert_json_schema_to_openapi(&mut converted);
                generation_config["responseSchema"] = converted;
            } else if rf.get("type").and_then(|t| t.as_str()) == Some("json_object") {
                generation_config["responseMimeType"] = serde_json::json!("application/json");
            }
        }

        let mut gemini_request = serde_json::json!({
            "contents": contents,
            "generationConfig": generation_config
        });

        if let Some(sys) = system_instruction {
            gemini_request["systemInstruction"] = sys;
        }

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

    /// 将标准 JSON Schema（小写 type）转换为 Gemini OpenAPI Schema（大写 type）
    /// 同时剥离 Gemini 不支持的字段（additionalProperties, description 等）
    fn convert_json_schema_to_openapi(value: &mut serde_json::Value) {
        if let Some(obj) = value.as_object_mut() {
            // type: "object" → "OBJECT", "string" → "STRING" 等
            if let Some(t) = obj.get_mut("type") {
                if let Some(s) = t.as_str() {
                    *t = serde_json::json!(s.to_uppercase());
                }
            }
            // 剥离 Gemini 不支持的字段
            obj.remove("additionalProperties");
            obj.remove("description");
            obj.remove("$schema");
            obj.remove("title");
            // 递归处理所有子节点
            let keys: Vec<String> = obj.keys().cloned().collect();
            for key in keys {
                if let Some(v) = obj.get_mut(&key) {
                    Self::convert_json_schema_to_openapi(v);
                }
            }
        } else if let Some(arr) = value.as_array_mut() {
            for v in arr.iter_mut() {
                Self::convert_json_schema_to_openapi(v);
            }
        }
    }

    /// 递归为所有 type=object 的 schema 节点注入 additionalProperties: false（OpenAI strict mode 要求）
    fn inject_additional_properties_false(value: &mut serde_json::Value) {
        if let Some(obj) = value.as_object_mut() {
            if obj.get("type").and_then(|t| t.as_str()) == Some("object") {
                obj.entry("additionalProperties").or_insert(serde_json::json!(false));
            }
            // 递归处理嵌套 schema（properties 的值、items 等）
            if let Some(props) = obj.get_mut("properties") {
                if let Some(props_obj) = props.as_object_mut() {
                    for v in props_obj.values_mut() {
                        Self::inject_additional_properties_false(v);
                    }
                }
            }
            if let Some(items) = obj.get_mut("items") {
                Self::inject_additional_properties_false(items);
            }
        }
    }
}

impl Default for LlmClient {
    fn default() -> Self {
        Self::new()
    }
}
