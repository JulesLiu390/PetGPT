// MCP Protocol Types - JSON-RPC 2.0

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================
// Transport Types
// ============================================

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransportType {
    Stdio,
    Http,
}

impl Default for TransportType {
    fn default() -> Self {
        TransportType::Stdio
    }
}

// ============================================
// JSON-RPC 2.0 Types
// ============================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// ============================================
// MCP Initialize Types
// ============================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    pub capabilities: ClientCapabilities,
    pub client_info: ClientInfo,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roots: Option<RootsCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling: Option<SamplingCapability>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RootsCapability {
    #[serde(default)]
    pub list_changed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SamplingCapability {}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    #[serde(default)]
    pub protocol_version: String,
    #[serde(default)]
    pub capabilities: ServerCapabilities,
    #[serde(default)]
    pub server_info: Option<ServerInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ServerCapabilities {
    #[serde(default)]
    pub tools: Option<ToolsCapability>,
    #[serde(default)]
    pub resources: Option<ResourcesCapability>,
    #[serde(default)]
    pub prompts: Option<PromptsCapability>,
    #[serde(default)]
    pub logging: Option<LoggingCapability>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolsCapability {
    #[serde(default)]
    pub list_changed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesCapability {
    #[serde(default)]
    pub subscribe: bool,
    #[serde(default)]
    pub list_changed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PromptsCapability {
    #[serde(default)]
    pub list_changed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LoggingCapability {}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerInfo {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
}

// ============================================
// MCP Tool Types
// ============================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ToolsListResult {
    #[serde(default)]
    pub tools: Vec<McpTool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCallParams {
    pub name: String,
    #[serde(default)]
    pub arguments: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCallResult {
    #[serde(default)]
    pub content: Vec<ToolContent>,
    #[serde(default, rename = "isError")]
    pub is_error: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum ToolContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image { data: String, #[serde(rename = "mimeType")] mime_type: String },
    #[serde(rename = "resource")]
    Resource { resource: ResourceContent },
}

// ============================================
// MCP Resource Types
// ============================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpResource {
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "mimeType")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ResourcesListResult {
    #[serde(default)]
    pub resources: Vec<McpResource>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResourceContent {
    pub uri: String,
    #[serde(default, rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub blob: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResourceReadResult {
    pub contents: Vec<ResourceContent>,
}

// ============================================
// Server Status Types (for frontend)
// ============================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub server_id: String,
    pub name: String,
    pub is_running: bool,
    #[serde(default)]
    pub tools: Vec<McpTool>,
    #[serde(default)]
    pub resources: Vec<McpResource>,
    #[serde(default)]
    pub server_info: Option<ServerInfo>,
    #[serde(default)]
    pub error: Option<String>,
}

// ============================================
// Frontend API Types
// ============================================

// ============================================
// MCP Sampling Types (Server → Client)
// ============================================

/// Sampling configuration — LLM credentials for handling sampling/createMessage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SamplingLlmConfig {
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// "openai_compatible" or "gemini_official"
    #[serde(default = "default_api_format_str")]
    pub api_format: String,
}

fn default_api_format_str() -> String {
    "openai_compatible".to_string()
}

/// MCP sampling/createMessage request params
/// Ref: https://spec.modelcontextprotocol.io/specification/client/sampling/
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplingCreateMessageParams {
    pub messages: Vec<SamplingMessage>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model_preferences: Option<serde_json::Value>,
    #[serde(default)]
    pub include_context: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SamplingMessage {
    pub role: String,  // "user" or "assistant"
    pub content: SamplingContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SamplingContent {
    Text { text: String },
    Image { data: String, #[serde(rename = "mimeType")] mime_type: String },
}

/// MCP sampling/createMessage response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SamplingCreateMessageResult {
    pub role: String,
    pub content: SamplingContent,
    pub model: String,
    #[serde(rename = "stopReason", default)]
    pub stop_reason: Option<String>,
}

/// Incoming JSON-RPC request from server (for server → client methods like sampling)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcIncomingRequest {
    pub jsonrpc: String,
    pub id: serde_json::Value,  // can be number or string
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

// ============================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_name: String,
    pub tool: McpTool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct CallToolRequest {
    pub server_id: String,
    pub tool_name: String,
    pub arguments: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CallToolResponse {
    pub success: bool,
    pub content: Vec<ToolContent>,
    #[serde(default)]
    pub error: Option<String>,
}

// ============================================
// Logging Helpers
// ============================================

/// Format a ToolCallResult into a concise one-line summary for logging.
///
/// Example output:
///   `ok, 3 items (2 text, 1 image), preview: "{"results": [{"target":..."`
///   `ERROR, 1 item (1 text), preview: "Group 123 is not monitored"`
pub fn format_tool_result(result: &ToolCallResult) -> String {
    let status = if result.is_error { "ERROR" } else { "ok" };
    let total = result.content.len();

    let mut text_count = 0u32;
    let mut image_count = 0u32;
    let mut resource_count = 0u32;
    let mut first_text: Option<&str> = None;

    for item in &result.content {
        match item {
            ToolContent::Text { text } => {
                text_count += 1;
                if first_text.is_none() {
                    first_text = Some(text.as_str());
                }
            }
            ToolContent::Image { .. } => image_count += 1,
            ToolContent::Resource { .. } => resource_count += 1,
        }
    }

    // Build type breakdown
    let mut parts = Vec::new();
    if text_count > 0 { parts.push(format!("{} text", text_count)); }
    if image_count > 0 { parts.push(format!("{} image", image_count)); }
    if resource_count > 0 { parts.push(format!("{} resource", resource_count)); }
    let breakdown = parts.join(", ");

    // Truncated preview of first text content
    let preview = match first_text {
        Some(t) => {
            let clean: String = t.chars().filter(|c| !c.is_control()).collect();
            let truncated = if clean.chars().count() > 50 {
                let end = clean.char_indices().nth(50).map(|(i, _)| i).unwrap_or(clean.len());
                format!("{}…", &clean[..end])
            } else { clean };
            format!(", preview: \"{}\"", truncated)
        }
        None => String::new(),
    };

    format!("{}, {} item{} ({}){}", status, total, if total != 1 { "s" } else { "" }, breakdown, preview)
}
