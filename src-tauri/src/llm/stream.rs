//! LLM 流式响应处理

use futures::StreamExt;
use reqwest::Client;
use tauri::{AppHandle, Emitter};
use crate::llm::types::*;

/// 流式调用 LLM 并通过 Tauri 事件推送块
pub async fn stream_chat(
    app: AppHandle,
    request: LlmRequest,
) -> Result<LlmResponse, String> {
    let client = Client::new();
    
    match request.api_format {
        ApiFormat::OpenaiCompatible => stream_openai(app, client, request).await,
        ApiFormat::GeminiOfficial => stream_gemini(app, client, request).await,
    }
}

/// OpenAI 兼容 API 流式调用
async fn stream_openai(
    app: AppHandle,
    client: Client,
    request: LlmRequest,
) -> Result<LlmResponse, String> {
    let base = request.base_url.as_deref().unwrap_or("https://api.openai.com/v1");
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
    let endpoint = format!("{}/chat/completions", base);

    // 构建消息
    let messages: Vec<serde_json::Value> = request.messages.iter().map(|msg| {
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
                            "image_url": { "url": &image_url.url }
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
        
        serde_json::json!({
            "role": role,
            "content": content
        })
    }).collect();

    let body = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "temperature": request.temperature.unwrap_or(0.7),
        "max_tokens": request.max_tokens.unwrap_or(4096)
    });

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status, error_text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();
    let conversation_id = request.conversation_id.clone();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        let chunk_str = String::from_utf8_lossy(&chunk);
        buffer.push_str(&chunk_str);

        // 处理 SSE 格式
        let lines: Vec<&str> = buffer.split('\n').collect();
        let remaining = lines.last().cloned().unwrap_or("");
        
        for line in &lines[..lines.len().saturating_sub(1)] {
            if line.starts_with("data: ") {
                let json_str = line[6..].trim();
                if json_str == "[DONE]" {
                    continue;
                }
                
                if let Ok(chunk_data) = serde_json::from_str::<OpenAIStreamChunk>(json_str) {
                    if let Some(choice) = chunk_data.choices.first() {
                        if let Some(delta_content) = &choice.delta.content {
                            full_text.push_str(delta_content);
                            
                            // 推送流式块到前端
                            let stream_chunk = StreamChunk {
                                conversation_id: conversation_id.clone(),
                                delta: delta_content.clone(),
                                full_text: full_text.clone(),
                                done: false,
                            };
                            
                            let event_name = format!("llm-chunk:{}", conversation_id);
                            if let Err(e) = app.emit(&event_name, &stream_chunk) {
                                eprintln!("[LLM Stream] Failed to emit chunk: {:?}", e);
                            }
                        }
                    }
                }
            }
        }
        
        buffer = remaining.to_string();
    }

    // 发送完成事件
    let done_chunk = StreamChunk {
        conversation_id: conversation_id.clone(),
        delta: String::new(),
        full_text: full_text.clone(),
        done: true,
    };
    
    let event_name = format!("llm-chunk:{}", conversation_id);
    let _ = app.emit(&event_name, &done_chunk);

    Ok(LlmResponse {
        content: full_text,
        mood: "normal".to_string(),
        error: None,
        tool_calls: None,
    })
}

/// 将 ContentPart 转换为 Gemini API 的 part 格式
fn content_part_to_gemini_part(part: &ContentPart) -> serde_json::Value {
    match part {
        ContentPart::Text { text } => {
            serde_json::json!({ "text": text })
        }
        ContentPart::ImageUrl { image_url } => {
            // 处理图片：支持 base64 data URL 和普通 URL
            let url = &image_url.url;
            if url.starts_with("data:") {
                // Base64 data URL: data:image/png;base64,xxxxx
                if let Some(comma_pos) = url.find(',') {
                    let mime_part = &url[5..comma_pos]; // 跳过 "data:"
                    let mime_type = mime_part.split(';').next().unwrap_or("image/png");
                    let base64_data = &url[comma_pos + 1..];
                    serde_json::json!({
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": base64_data
                        }
                    })
                } else {
                    // 格式不正确，降级为文本
                    serde_json::json!({ "text": "[Invalid image data]" })
                }
            } else if url.starts_with("http") {
                // HTTP URL - Gemini 支持 fileData 格式
                serde_json::json!({
                    "file_data": {
                        "file_uri": url,
                        "mime_type": image_url.mime_type.as_deref().unwrap_or("image/png")
                    }
                })
            } else {
                // 本地文件路径 - 无法直接使用，降级为文本
                serde_json::json!({ "text": format!("[Image: {}]", url) })
            }
        }
        ContentPart::FileUrl { file_url } => {
            // 处理文件（PDF、视频、音频等）
            let url = &file_url.url;
            let mime_type = file_url.mime_type.as_deref().unwrap_or("application/octet-stream");
            
            if url.starts_with("data:") {
                // Base64 data URL
                if let Some(comma_pos) = url.find(',') {
                    let mime_part = &url[5..comma_pos];
                    let detected_mime = mime_part.split(';').next().unwrap_or(mime_type);
                    let base64_data = &url[comma_pos + 1..];
                    serde_json::json!({
                        "inline_data": {
                            "mime_type": detected_mime,
                            "data": base64_data
                        }
                    })
                } else {
                    let file_name = file_url.name.as_deref().unwrap_or("file");
                    serde_json::json!({ "text": format!("[Attachment: {}]", file_name) })
                }
            } else if url.starts_with("http") {
                // HTTP URL
                serde_json::json!({
                    "file_data": {
                        "file_uri": url,
                        "mime_type": mime_type
                    }
                })
            } else {
                // 本地文件路径 - 无法直接使用
                let file_name = file_url.name.as_deref().unwrap_or(url);
                serde_json::json!({ "text": format!("[Attachment: {}]", file_name) })
            }
        }
    }
}

/// 将 MessageContent 转换为 Gemini API 的 parts 数组
fn message_content_to_gemini_parts(content: &MessageContent) -> Vec<serde_json::Value> {
    match content {
        MessageContent::Text(text) => {
            vec![serde_json::json!({ "text": text })]
        }
        MessageContent::Parts(parts) => {
            parts.iter().map(content_part_to_gemini_part).collect()
        }
    }
}

/// Gemini 官方 API 流式调用
async fn stream_gemini(
    app: AppHandle,
    client: Client,
    request: LlmRequest,
) -> Result<LlmResponse, String> {
    let mut base_url = request.base_url.clone()
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".to_string());
    
    // 确保 base_url 包含 /v1beta 路径
    if !base_url.contains("/v1beta") {
        base_url = base_url.trim_end_matches('/').to_string();
        base_url.push_str("/v1beta");
    }
    
    let endpoint = format!(
        "{}/models/{}:streamGenerateContent?key={}&alt=sse",
        base_url,
        request.model,
        request.api_key
    );

    // 构建 Gemini 请求格式 - 支持多模态内容
    let contents: Vec<serde_json::Value> = request.messages.iter()
        .filter(|m| m.role != Role::System)
        .map(|msg| {
            let role = match msg.role {
                Role::User => "user",
                Role::Assistant => "model",
                _ => "user",
            };
            // 使用辅助函数转换多模态内容
            let parts = message_content_to_gemini_parts(&msg.content);
            serde_json::json!({
                "role": role,
                "parts": parts
            })
        })
        .collect();

    // 提取 system instruction
    let system_instruction: Option<serde_json::Value> = request.messages.iter()
        .find(|m| m.role == Role::System)
        .map(|m| {
            let parts = message_content_to_gemini_parts(&m.content);
            serde_json::json!({
                "parts": parts
            })
        });

    let mut gemini_request = serde_json::json!({
        "contents": contents,
        "generationConfig": {
            "temperature": request.temperature.unwrap_or(0.7),
            "maxOutputTokens": request.max_tokens.unwrap_or(8192)
        }
    });

    if let Some(sys) = system_instruction {
        gemini_request["systemInstruction"] = sys;
    }

    let response = client
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

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();
    let conversation_id = request.conversation_id.clone();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        let chunk_str = String::from_utf8_lossy(&chunk);
        buffer.push_str(&chunk_str);

        // Gemini SSE 格式处理
        let lines: Vec<&str> = buffer.split('\n').collect();
        let remaining = lines.last().cloned().unwrap_or("");
        
        for line in &lines[..lines.len().saturating_sub(1)] {
            if line.starts_with("data: ") {
                let json_str = line[6..].trim();
                
                if let Ok(chunk_data) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(text) = chunk_data["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                        full_text.push_str(text);
                        
                        let stream_chunk = StreamChunk {
                            conversation_id: conversation_id.clone(),
                            delta: text.to_string(),
                            full_text: full_text.clone(),
                            done: false,
                        };
                        
                        let event_name = format!("llm-chunk:{}", conversation_id);
                        if let Err(e) = app.emit(&event_name, &stream_chunk) {
                            eprintln!("[LLM Stream] Failed to emit chunk: {:?}", e);
                        }
                    }
                }
            }
        }
        
        buffer = remaining.to_string();
    }

    // 发送完成事件
    let done_chunk = StreamChunk {
        conversation_id: conversation_id.clone(),
        delta: String::new(),
        full_text: full_text.clone(),
        done: true,
    };
    
    let event_name = format!("llm-chunk:{}", conversation_id);
    let _ = app.emit(&event_name, &done_chunk);

    Ok(LlmResponse {
        content: full_text,
        mood: "normal".to_string(),
        error: None,
        tool_calls: None,
    })
}
