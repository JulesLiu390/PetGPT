// MCP Server Manager
// Manages lifecycle of all MCP servers (both stdio and HTTP transports)

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::RwLock;

use super::client::McpClient;
use super::http_client::McpHttpClient;
use super::types::*;

/// Unified client wrapper for both transport types
pub enum McpClientWrapper {
    Stdio(Arc<McpClient>),
    Http(Arc<McpHttpClient>),
}

impl McpClientWrapper {
    pub fn is_connected(&self) -> bool {
        match self {
            McpClientWrapper::Stdio(c) => c.is_connected(),
            McpClientWrapper::Http(c) => c.is_connected(),
        }
    }

    pub fn get_status(&self) -> ServerStatus {
        match self {
            McpClientWrapper::Stdio(c) => c.get_status(),
            McpClientWrapper::Http(c) => c.get_status(),
        }
    }

    pub fn disconnect(&self) {
        match self {
            McpClientWrapper::Stdio(c) => c.disconnect(),
            McpClientWrapper::Http(c) => c.disconnect(),
        }
    }

    pub async fn call_tool(&self, name: &str, arguments: Option<serde_json::Value>) -> Result<ToolCallResult, String> {
        match self {
            McpClientWrapper::Stdio(c) => c.call_tool(name, arguments).await,
            McpClientWrapper::Http(c) => c.call_tool(name, arguments).await,
        }
    }

    pub async fn read_resource(&self, uri: &str) -> Result<ResourceReadResult, String> {
        match self {
            McpClientWrapper::Stdio(c) => c.read_resource(uri).await,
            McpClientWrapper::Http(c) => c.read_resource(uri).await,
        }
    }
}

pub struct McpManager {
    clients: Arc<RwLock<HashMap<String, McpClientWrapper>>>,
    /// Global cancellation flag for all tool calls
    cancelled: Arc<AtomicBool>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    
    /// Cancel all pending tool calls
    pub fn cancel_all_tool_calls(&self) {
        log::info!("[MCPManager] Cancelling all tool calls");
        self.cancelled.store(true, Ordering::SeqCst);
    }
    
    /// Reset the cancellation flag (call before starting new operations)
    pub fn reset_cancellation(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }
    
    /// Check if operations are cancelled
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Start a stdio server with the given configuration
    pub async fn start_server(
        &self,
        server_id: &str,
        server_name: &str,
        command: &str,
        args: Vec<String>,
        env: HashMap<String, String>,
    ) -> Result<ServerStatus, String> {
        // Check if already running
        {
            let clients = self.clients.read().await;
            if let Some(client) = clients.get(server_id) {
                if client.is_connected() {
                    log::info!("[MCPManager] Server {} already running", server_id);
                    return Ok(client.get_status());
                }
            }
        }

        log::info!("[MCPManager] Starting stdio server: {} ({})", server_name, server_id);

        // Create and connect client
        let client = Arc::new(McpClient::new(
            server_id.to_string(),
            server_name.to_string(),
            command.to_string(),
            args,
            env,
        ));

        client.connect().await?;

        // Store client
        {
            let mut clients = self.clients.write().await;
            clients.insert(server_id.to_string(), McpClientWrapper::Stdio(client.clone()));
        }

        Ok(client.get_status())
    }

    /// Start an HTTP server with the given configuration
    pub async fn start_http_server(
        &self,
        server_id: &str,
        server_name: &str,
        url: &str,
        api_key: Option<String>,
    ) -> Result<ServerStatus, String> {
        // Check if already running
        {
            let clients = self.clients.read().await;
            if let Some(client) = clients.get(server_id) {
                if client.is_connected() {
                    log::info!("[MCPManager] Server {} already running", server_id);
                    return Ok(client.get_status());
                }
            }
        }

        log::info!("[MCPManager] Starting HTTP server: {} ({}) at {}", server_name, server_id, url);

        // Create and connect client
        let client = Arc::new(McpHttpClient::new(
            server_id.to_string(),
            server_name.to_string(),
            url.to_string(),
            api_key,
        ));

        client.connect().await?;

        // Store client
        {
            let mut clients = self.clients.write().await;
            clients.insert(server_id.to_string(), McpClientWrapper::Http(client.clone()));
        }

        Ok(client.get_status())
    }

    /// Stop a running server
    pub async fn stop_server(&self, server_id: &str) -> Result<(), String> {
        let client = {
            let mut clients = self.clients.write().await;
            clients.remove(server_id)
        };

        if let Some(client) = client {
            log::info!("[MCPManager] Stopping server: {}", server_id);
            client.disconnect();
        } else {
            log::info!("[MCPManager] Server {} not running", server_id);
        }

        Ok(())
    }

    /// Restart a server
    pub async fn restart_server(
        &self,
        server_id: &str,
        server_name: &str,
        command: &str,
        args: Vec<String>,
        env: HashMap<String, String>,
    ) -> Result<ServerStatus, String> {
        self.stop_server(server_id).await?;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        self.start_server(server_id, server_name, command, args, env).await
    }

    /// Stop all servers
    pub async fn stop_all(&self) {
        log::info!("[MCPManager] Stopping all servers");
        let mut clients = self.clients.write().await;
        for (id, client) in clients.drain() {
            log::info!("[MCPManager] Stopping server: {}", id);
            client.disconnect();
        }
    }

    /// Get status of a specific server
    pub async fn get_server_status(&self, server_id: &str) -> Option<ServerStatus> {
        let clients = self.clients.read().await;
        clients.get(server_id).map(|c| c.get_status())
    }

    /// Get status of all servers
    pub async fn get_all_statuses(&self) -> Vec<ServerStatus> {
        let clients = self.clients.read().await;
        clients.values().map(|c| c.get_status()).collect()
    }

    /// Get all tools from all connected servers
    pub async fn get_all_tools(&self) -> Vec<McpToolInfo> {
        let clients = self.clients.read().await;
        let mut tools = Vec::new();
        
        for client in clients.values() {
            if client.is_connected() {
                let status = client.get_status();
                for tool in status.tools {
                    tools.push(McpToolInfo {
                        server_id: status.server_id.clone(),
                        server_name: status.name.clone(),
                        tool,
                    });
                }
            }
        }
        
        tools
    }

    /// Call a tool on a specific server
    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<CallToolResponse, String> {
        // Check if cancelled before starting
        if self.is_cancelled() {
            return Err("Tool call cancelled".to_string());
        }
        
        let clients = self.clients.read().await;
        let client = clients.get(server_id)
            .ok_or_else(|| format!("Server {} not found or not running", server_id))?;

        match client.call_tool(tool_name, arguments).await {
            Ok(result) => {
                // Check again after execution
                if self.is_cancelled() {
                    return Err("Tool call cancelled".to_string());
                }
                Ok(CallToolResponse {
                    success: !result.is_error,
                    content: result.content,
                    error: None,
                })
            },
            Err(e) => Ok(CallToolResponse {
                success: false,
                content: vec![],
                error: Some(e),
            }),
        }
    }

    /// Read a resource from a specific server
    pub async fn read_resource(&self, server_id: &str, uri: &str) -> Result<ResourceReadResult, String> {
        let clients = self.clients.read().await;
        let client = clients.get(server_id)
            .ok_or_else(|| format!("Server {} not found or not running", server_id))?;
        client.read_resource(uri).await
    }

    /// Check if a server is running
    pub async fn is_server_running(&self, server_id: &str) -> bool {
        let clients = self.clients.read().await;
        clients.get(server_id).map(|c| c.is_connected()).unwrap_or(false)
    }

    /// Get list of running server IDs
    pub async fn get_running_server_ids(&self) -> Vec<String> {
        let clients = self.clients.read().await;
        clients
            .iter()
            .filter(|(_, c)| c.is_connected())
            .map(|(id, _)| id.clone())
            .collect()
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}
