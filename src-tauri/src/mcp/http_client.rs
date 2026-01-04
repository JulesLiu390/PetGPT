// MCP Streamable HTTP Client
// Implements MCP protocol over Streamable HTTP (2025-03-26 spec)
// See: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tokio::sync::{oneshot, RwLock};
use futures::StreamExt;

use super::types::*;

const PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT_SECS: u64 = 60;

pub struct McpHttpClient {
    server_id: String,
    server_name: String,
    /// The MCP endpoint URL (e.g., https://mcp.tavily.com/mcp/)
    endpoint_url: String,
    api_key: Option<String>,
    
    // HTTP client
    client: reqwest::Client,
    
    // Session management (Mcp-Session-Id header)
    session_id: Arc<RwLock<Option<String>>>,
    
    // Request management
    request_id: AtomicU64,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>>,
    
    // State
    is_connected: Arc<Mutex<bool>>,
    server_capabilities: Arc<Mutex<ServerCapabilities>>,
    server_info: Arc<Mutex<Option<ServerInfo>>>,
    tools: Arc<Mutex<Vec<McpTool>>>,
    resources: Arc<Mutex<Vec<McpResource>>>,
}

impl McpHttpClient {
    pub fn new(
        server_id: String,
        server_name: String,
        endpoint_url: String,
        api_key: Option<String>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap();

        Self {
            server_id,
            server_name,
            endpoint_url: endpoint_url.trim_end_matches('/').to_string(),
            api_key,
            client,
            session_id: Arc::new(RwLock::new(None)),
            request_id: AtomicU64::new(0),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            is_connected: Arc::new(Mutex::new(false)),
            server_capabilities: Arc::new(Mutex::new(ServerCapabilities::default())),
            server_info: Arc::new(Mutex::new(None)),
            tools: Arc::new(Mutex::new(Vec::new())),
            resources: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Connect to the MCP server via Streamable HTTP
    /// In Streamable HTTP, we POST requests directly to the endpoint
    pub async fn connect(&self) -> Result<(), String> {
        if *self.is_connected.lock().unwrap() {
            log::info!("[MCP-HTTP][{}] Already connected", self.server_name);
            return Ok(());
        }

        log::info!("[MCP-HTTP][{}] Connecting to {} (Streamable HTTP)", self.server_name, self.endpoint_url);

        // Initialize MCP connection by sending InitializeRequest
        self.initialize().await?;

        *self.is_connected.lock().unwrap() = true;
        log::info!("[MCP-HTTP][{}] Connected successfully", self.server_name);

        Ok(())
    }

    /// Parse SSE stream response and extract JSON-RPC messages
    async fn parse_sse_response(&self, response: reqwest::Response) -> Result<serde_json::Value, String> {
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut result: Option<serde_json::Value> = None;

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    buffer.push_str(&text);
                    log::debug!("[MCP-HTTP][{}] SSE chunk: {:?}", self.server_name, text);

                    // Process complete events
                    // SSE events are separated by blank lines, handle both \r\n\r\n and \n\n
                    loop {
                        // Find event boundary - try \r\n\r\n first (Windows/HTTP style), then \n\n (Unix style)
                        let (pos, skip_len) = if let Some(p) = buffer.find("\r\n\r\n") {
                            (p, 4)
                        } else if let Some(p) = buffer.find("\n\n") {
                            (p, 2)
                        } else {
                            break; // No complete event yet
                        };

                        let event_data = buffer[..pos].to_string();
                        buffer = buffer[pos + skip_len..].to_string();

                        log::debug!("[MCP-HTTP][{}] SSE event: {:?}", self.server_name, event_data);

                        // Parse SSE event
                        if let Some(data) = Self::parse_sse_event(&event_data) {
                            log::debug!("[MCP-HTTP][{}] SSE data: {}", self.server_name, data);
                            
                            // Try to parse as JSON-RPC response
                            if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(&data) {
                                if let Some(error) = resp.error {
                                    return Err(error.message);
                                }
                                result = Some(resp.result.unwrap_or(serde_json::Value::Null));
                                // Continue processing in case there are more events
                            }
                            // Handle notifications (log them but continue)
                            else if let Ok(notif) = serde_json::from_str::<JsonRpcNotification>(&data) {
                                log::info!("[MCP-HTTP][{}] Server notification: {}", self.server_name, notif.method);
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("[MCP-HTTP][{}] SSE stream error: {}", self.server_name, e);
                    break;
                }
            }
        }

        result.ok_or_else(|| "No response received from SSE stream".to_string())
    }

    /// Parse SSE event data
    fn parse_sse_event(event_str: &str) -> Option<String> {
        let mut data_lines = Vec::new();
        for line in event_str.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                // Handle "data: value" or "data:value"
                data_lines.push(data.trim_start().to_string());
            }
        }
        if data_lines.is_empty() {
            None
        } else {
            Some(data_lines.join("\n"))
        }
    }

    /// Send initialize request
    async fn initialize(&self) -> Result<(), String> {
        let params = InitializeParams {
            protocol_version: PROTOCOL_VERSION.to_string(),
            capabilities: ClientCapabilities {
                roots: Some(RootsCapability { list_changed: true }),
                sampling: Some(SamplingCapability {}),
            },
            client_info: ClientInfo {
                name: "PetGPT".to_string(),
                version: "1.0.0".to_string(),
            },
        };

        let result: InitializeResult = self
            .send_request("initialize", Some(serde_json::to_value(params).unwrap()))
            .await
            .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;

        *self.server_capabilities.lock().unwrap() = result.capabilities;
        *self.server_info.lock().unwrap() = result.server_info;

        // Send initialized notification
        self.send_notification("notifications/initialized", None).await?;

        // Fetch tools and resources
        self.refresh_tools().await?;
        self.refresh_resources().await?;

        Ok(())
    }

    /// Refresh tools list
    pub async fn refresh_tools(&self) -> Result<(), String> {
        let caps = self.server_capabilities.lock().unwrap().clone();
        if caps.tools.is_none() {
            *self.tools.lock().unwrap() = Vec::new();
            return Ok(());
        }

        let result: ToolsListResult = self
            .send_request("tools/list", None)
            .await
            .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;

        log::info!("[MCP-HTTP][{}] Tools: {:?}", self.server_name, result.tools.iter().map(|t| &t.name).collect::<Vec<_>>());
        *self.tools.lock().unwrap() = result.tools;

        Ok(())
    }

    /// Refresh resources list
    pub async fn refresh_resources(&self) -> Result<(), String> {
        let caps = self.server_capabilities.lock().unwrap().clone();
        if caps.resources.is_none() {
            *self.resources.lock().unwrap() = Vec::new();
            return Ok(());
        }

        let result: ResourcesListResult = self
            .send_request("resources/list", None)
            .await
            .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;

        log::info!("[MCP-HTTP][{}] Resources: {:?}", self.server_name, result.resources.iter().map(|r| &r.uri).collect::<Vec<_>>());
        *self.resources.lock().unwrap() = result.resources;

        Ok(())
    }

    /// Call a tool
    pub async fn call_tool(&self, name: &str, arguments: Option<serde_json::Value>) -> Result<ToolCallResult, String> {
        if !*self.is_connected.lock().unwrap() {
            return Err("Not connected".to_string());
        }

        log::info!("[MCP-HTTP][{}] Calling tool: {} with args: {:?}", self.server_name, name, arguments);

        let params = ToolCallParams {
            name: name.to_string(),
            arguments,
        };

        let result: ToolCallResult = self
            .send_request("tools/call", Some(serde_json::to_value(params).unwrap()))
            .await
            .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;

        log::info!("[MCP-HTTP][{}] Tool result: {:?}", self.server_name, result);
        Ok(result)
    }

    /// Read a resource
    pub async fn read_resource(&self, uri: &str) -> Result<ResourceReadResult, String> {
        if !*self.is_connected.lock().unwrap() {
            return Err("Not connected".to_string());
        }

        log::info!("[MCP-HTTP][{}] Reading resource: {}", self.server_name, uri);

        let params = serde_json::json!({ "uri": uri });

        let result: ResourceReadResult = self
            .send_request("resources/read", Some(params))
            .await
            .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;

        Ok(result)
    }

    /// Send JSON-RPC request via HTTP POST (Streamable HTTP)
    /// The server may respond with application/json or text/event-stream
    async fn send_request(&self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        let id = self.request_id.fetch_add(1, Ordering::SeqCst);

        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };

        log::info!("[MCP-HTTP][{}] Sending request: {} (id={})", self.server_name, method, id);
        log::debug!("[MCP-HTTP][{}] Request body: {:?}", self.server_name, request);

        // Build request - POST to the MCP endpoint
        let mut req = self.client.post(&self.endpoint_url)
            .header("Content-Type", "application/json")
            // Accept both JSON and SSE responses as per spec
            .header("Accept", "application/json, text/event-stream")
            .json(&request);

        // Add API key if provided (as query param is already in URL, but also try Bearer token)
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }

        // Add session ID if we have one
        if let Some(session_id) = &*self.session_id.read().await {
            req = req.header("Mcp-Session-Id", session_id);
        }

        // Send request
        let response = req.send().await.map_err(|e| {
            format!("HTTP request failed: {}", e)
        })?;

        // Check for session ID in response (set by server during initialization)
        if let Some(session_id) = response.headers().get("mcp-session-id") {
            if let Ok(id) = session_id.to_str() {
                log::info!("[MCP-HTTP][{}] Got session ID: {}", self.server_name, id);
                *self.session_id.write().await = Some(id.to_string());
            }
        }

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!("HTTP {} - {}", status, body));
        }

        // Check Content-Type to determine how to parse response
        let content_type = response.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        log::debug!("[MCP-HTTP][{}] Response Content-Type: {}", self.server_name, content_type);

        if content_type.contains("text/event-stream") {
            // Parse SSE stream response
            log::debug!("[MCP-HTTP][{}] Parsing SSE response", self.server_name);
            self.parse_sse_response(response).await
        } else {
            // Parse JSON response
            let body = response.text().await.map_err(|e| e.to_string())?;
            log::debug!("[MCP-HTTP][{}] JSON response: {}", self.server_name, body);
            
            if body.is_empty() {
                return Err("Empty response body".to_string());
            }

            let resp: JsonRpcResponse = serde_json::from_str(&body)
                .map_err(|e| format!("Failed to parse JSON response: {} - body: {}", e, body))?;
            
            if let Some(error) = resp.error {
                return Err(error.message);
            }
            
            Ok(resp.result.unwrap_or(serde_json::Value::Null))
        }
    }

    /// Send notification (no response expected)
    /// Per spec: server returns 202 Accepted for notifications
    async fn send_notification(&self, method: &str, params: Option<serde_json::Value>) -> Result<(), String> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        };

        log::debug!("[MCP-HTTP][{}] Sending notification: {}", self.server_name, method);

        let mut req = self.client.post(&self.endpoint_url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&notification);

        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }

        if let Some(session_id) = &*self.session_id.read().await {
            req = req.header("Mcp-Session-Id", session_id);
        }

        let response = req.send().await.map_err(|e| format!("Failed to send notification: {}", e))?;
        
        // Per spec: server should return 202 Accepted for notifications
        // But we accept any 2xx status
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Notification failed: HTTP {} - {}", status, body));
        }

        Ok(())
    }

    /// Disconnect from the server
    pub fn disconnect(&self) {
        log::info!("[MCP-HTTP][{}] Disconnecting", self.server_name);

        *self.is_connected.lock().unwrap() = false;

        // Clear pending requests
        let mut pending = self.pending_requests.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("Connection closed".to_string()));
        }

        *self.tools.lock().unwrap() = Vec::new();
        *self.resources.lock().unwrap() = Vec::new();
    }

    /// Get connection status
    pub fn is_connected(&self) -> bool {
        *self.is_connected.lock().unwrap()
    }

    /// Get available tools
    pub fn get_tools(&self) -> Vec<McpTool> {
        self.tools.lock().unwrap().clone()
    }

    /// Get available resources
    pub fn get_resources(&self) -> Vec<McpResource> {
        self.resources.lock().unwrap().clone()
    }

    /// Get server info
    pub fn get_server_info(&self) -> Option<ServerInfo> {
        self.server_info.lock().unwrap().clone()
    }

    /// Get server status
    pub fn get_status(&self) -> ServerStatus {
        ServerStatus {
            server_id: self.server_id.clone(),
            name: self.server_name.clone(),
            is_running: self.is_connected(),
            tools: self.get_tools(),
            resources: self.get_resources(),
            server_info: self.get_server_info(),
            error: None,
        }
    }
}

impl Drop for McpHttpClient {
    fn drop(&mut self) {
        self.disconnect();
    }
}
