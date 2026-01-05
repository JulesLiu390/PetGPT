// MCP Client - JSON-RPC 2.0 over stdio
// Manages communication with a single MCP server

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::{mpsc, oneshot};

use super::types::*;

const PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT_MS: u64 = 60000; // Increased to 60s for long tool calls
const TOOL_CALL_TIMEOUT_MS: u64 = 300000; // 5 minutes for tool calls

pub struct McpClient {
    server_id: String,
    server_name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    
    // Process management
    process: Arc<Mutex<Option<Child>>>,
    stdin_tx: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    
    // Request management
    request_id: AtomicU64,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>>,
    
    // State
    is_connected: Arc<Mutex<bool>>,
    server_capabilities: Arc<Mutex<ServerCapabilities>>,
    server_info: Arc<Mutex<Option<ServerInfo>>>,
    tools: Arc<Mutex<Vec<McpTool>>>,
    resources: Arc<Mutex<Vec<McpResource>>>,
    
    // Cancellation support
    cancelled: Arc<AtomicBool>,
    // Error state for propagating process failures
    last_error: Arc<Mutex<Option<String>>>,
}

impl McpClient {
    pub fn new(
        server_id: String,
        server_name: String,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    ) -> Self {
        Self {
            server_id,
            server_name,
            command,
            args,
            env,
            process: Arc::new(Mutex::new(None)),
            stdin_tx: Arc::new(Mutex::new(None)),
            request_id: AtomicU64::new(0),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            is_connected: Arc::new(Mutex::new(false)),
            server_capabilities: Arc::new(Mutex::new(ServerCapabilities::default())),
            server_info: Arc::new(Mutex::new(None)),
            tools: Arc::new(Mutex::new(Vec::new())),
            resources: Arc::new(Mutex::new(Vec::new())),
            cancelled: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(Mutex::new(None)),
        }
    }
    
    /// Cancel pending operations
    pub fn cancel(&self) {
        log::info!("[MCP][{}] Cancelling operations", self.server_name);
        self.cancelled.store(true, Ordering::SeqCst);
        
        // Cancel all pending requests
        let mut pending = self.pending_requests.lock().unwrap();
        for (id, tx) in pending.drain() {
            log::debug!("[MCP][{}] Cancelling pending request {}", self.server_name, id);
            let _ = tx.send(Err("Operation cancelled".to_string()));
        }
    }
    
    /// Reset cancellation flag
    pub fn reset_cancellation(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
        *self.last_error.lock().unwrap() = None;
    }
    
    /// Check if cancelled
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    
    /// Get last error
    pub fn get_last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }
    
    /// Set error and update connected state
    fn set_error(&self, error: String) {
        log::error!("[MCP][{}] Error: {}", self.server_name, error);
        *self.last_error.lock().unwrap() = Some(error);
        *self.is_connected.lock().unwrap() = false;
    }

    /// Start the MCP server process and initialize connection
    pub async fn connect(&self) -> Result<(), String> {
        if *self.is_connected.lock().unwrap() {
            log::info!("[MCP][{}] Already connected", self.server_name);
            return Ok(());
        }

        log::info!("[MCP][{}] Starting server: {} {:?}", self.server_name, self.command, self.args);

        // Spawn the process
        let mut cmd = Command::new(&self.command);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(&self.env);

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn process: {}", e))?;

        // Get stdin handle
        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

        // Create channel for stdin writes
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(100);
        *self.stdin_tx.lock().unwrap() = Some(stdin_tx);

        // Spawn stdin writer thread with proper error propagation
        let server_name_clone = self.server_name.clone();
        let is_connected_clone = self.is_connected.clone();
        let last_error_clone = self.last_error.clone();
        let pending_requests_clone = self.pending_requests.clone();
        
        thread::spawn(move || {
            let mut stdin = stdin;
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                while let Some(msg) = stdin_rx.recv().await {
                    if let Err(e) = stdin.write_all(msg.as_bytes()) {
                        let error_msg = format!("Failed to write to stdin: {}", e);
                        log::error!("[MCP][{}] {}", server_name_clone, error_msg);
                        
                        // Update connection state and error
                        *is_connected_clone.lock().unwrap() = false;
                        *last_error_clone.lock().unwrap() = Some(error_msg.clone());
                        
                        // Cancel all pending requests
                        let mut pending = pending_requests_clone.lock().unwrap();
                        for (_, tx) in pending.drain() {
                            let _ = tx.send(Err(error_msg.clone()));
                        }
                        break;
                    }
                    if let Err(e) = stdin.flush() {
                        let error_msg = format!("Failed to flush stdin: {}", e);
                        log::error!("[MCP][{}] {}", server_name_clone, error_msg);
                        
                        *is_connected_clone.lock().unwrap() = false;
                        *last_error_clone.lock().unwrap() = Some(error_msg.clone());
                        
                        let mut pending = pending_requests_clone.lock().unwrap();
                        for (_, tx) in pending.drain() {
                            let _ = tx.send(Err(error_msg.clone()));
                        }
                        break;
                    }
                }
                log::info!("[MCP][{}] Stdin writer exited", server_name_clone);
            });
        });

        // Spawn stdout reader thread with proper error handling
        let pending_requests = self.pending_requests.clone();
        let server_name_stdout = self.server_name.clone();
        let is_connected_stdout = self.is_connected.clone();
        let last_error_stdout = self.last_error.clone();
        
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        
                        // Try to parse as JSON-RPC response
                        match serde_json::from_str::<JsonRpcResponse>(trimmed) {
                            Ok(response) => {
                                let mut pending = pending_requests.lock().unwrap();
                                if let Some(tx) = pending.remove(&response.id) {
                                    if let Some(error) = response.error {
                                        let error_msg = format!("JSON-RPC error {}: {}", error.code, error.message);
                                        let _ = tx.send(Err(error_msg));
                                    } else {
                                        let _ = tx.send(Ok(response.result.unwrap_or(serde_json::Value::Null)));
                                    }
                                } else {
                                    log::warn!("[MCP][{}] Received response for unknown request id: {}", 
                                        server_name_stdout, response.id);
                                }
                            }
                            Err(_) => {
                                // Try to parse as notification
                                if let Ok(notif) = serde_json::from_str::<JsonRpcNotification>(trimmed) {
                                    match notif.method.as_str() {
                                        "notifications/tools/list_changed" => {
                                            log::info!("[MCP][{}] Tools list changed", server_name_stdout);
                                        }
                                        "notifications/resources/list_changed" => {
                                            log::info!("[MCP][{}] Resources list changed", server_name_stdout);
                                        }
                                        _ => {
                                            log::debug!("[MCP][{}] Notification: {}", server_name_stdout, notif.method);
                                        }
                                    }
                                } else {
                                    log::debug!("[MCP][{}] Non-JSON message: {}", server_name_stdout, trimmed);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let error_msg = format!("Process stdout closed: {}", e);
                        log::error!("[MCP][{}] {}", server_name_stdout, error_msg);
                        
                        // Update connection state
                        *is_connected_stdout.lock().unwrap() = false;
                        *last_error_stdout.lock().unwrap() = Some(error_msg.clone());
                        
                        // Cancel all pending requests
                        let mut pending = pending_requests.lock().unwrap();
                        for (_, tx) in pending.drain() {
                            let _ = tx.send(Err(error_msg.clone()));
                        }
                        break;
                    }
                }
            }
            
            // Process has exited - update state
            log::info!("[MCP][{}] Stdout reader exited, process likely terminated", server_name_stdout);
            *is_connected_stdout.lock().unwrap() = false;
            
            // Cancel any remaining pending requests
            let mut pending = pending_requests.lock().unwrap();
            if !pending.is_empty() {
                let error_msg = "Process terminated unexpectedly".to_string();
                for (_, tx) in pending.drain() {
                    let _ = tx.send(Err(error_msg.clone()));
                }
            }
        });

        // Spawn stderr reader thread (for logging)
        let server_name_stderr = self.server_name.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        log::debug!("[MCP][{}][stderr] {}", server_name_stderr, line);
                    }
                    Err(_) => break,
                }
            }
        });

        // Store process
        *self.process.lock().unwrap() = Some(child);

        // Initialize MCP connection
        self.initialize().await?;

        *self.is_connected.lock().unwrap() = true;
        log::info!("[MCP][{}] Connected successfully", self.server_name);

        Ok(())
    }

    /// Send initialize request and receive capabilities
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

        // Store capabilities
        *self.server_capabilities.lock().unwrap() = result.capabilities;
        *self.server_info.lock().unwrap() = result.server_info;

        // Send initialized notification
        self.send_notification("notifications/initialized", None).await?;

        // Fetch tools and resources
        self.refresh_tools().await?;
        self.refresh_resources().await?;

        Ok(())
    }

    /// Refresh the tools list from the server
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

        log::info!("[MCP][{}] Tools: {:?}", self.server_name, result.tools.iter().map(|t| &t.name).collect::<Vec<_>>());
        *self.tools.lock().unwrap() = result.tools;

        Ok(())
    }

    /// Refresh the resources list from the server
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

        log::info!("[MCP][{}] Resources: {:?}", self.server_name, result.resources.iter().map(|r| &r.uri).collect::<Vec<_>>());
        *self.resources.lock().unwrap() = result.resources;

        Ok(())
    }

    /// Call a tool on the server with cancellation support
    pub async fn call_tool(&self, name: &str, arguments: Option<serde_json::Value>) -> Result<ToolCallResult, String> {
        // Check for errors from previous operations
        if let Some(error) = self.get_last_error() {
            return Err(format!("Client in error state: {}", error));
        }
        
        if !*self.is_connected.lock().unwrap() {
            return Err("Not connected".to_string());
        }
        
        // Check cancellation before starting
        if self.is_cancelled() {
            return Err("Operation cancelled".to_string());
        }

        log::info!("[MCP][{}] Calling tool: {} with args: {:?}", self.server_name, name, arguments);

        let params = ToolCallParams {
            name: name.to_string(),
            arguments,
        };

        // Use longer timeout for tool calls
        let result: ToolCallResult = self
            .send_request_with_timeout("tools/call", Some(serde_json::to_value(params).unwrap()), TOOL_CALL_TIMEOUT_MS)
            .await
            .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;
        
        // Check cancellation after completion
        if self.is_cancelled() {
            return Err("Operation cancelled".to_string());
        }

        log::info!("[MCP][{}] Tool result: {:?}", self.server_name, result);
        Ok(result)
    }

    /// Read a resource from the server
    pub async fn read_resource(&self, uri: &str) -> Result<ResourceReadResult, String> {
        if !*self.is_connected.lock().unwrap() {
            return Err("Not connected".to_string());
        }

        log::info!("[MCP][{}] Reading resource: {}", self.server_name, uri);

        let params = serde_json::json!({ "uri": uri });

        let result: ResourceReadResult = self
            .send_request("resources/read", Some(params))
            .await
            .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;

        Ok(result)
    }

    /// Send a JSON-RPC request and wait for response with default timeout
    async fn send_request(&self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        self.send_request_with_timeout(method, params, REQUEST_TIMEOUT_MS).await
    }
    
    /// Send a JSON-RPC request and wait for response with custom timeout
    async fn send_request_with_timeout(&self, method: &str, params: Option<serde_json::Value>, timeout_ms: u64) -> Result<serde_json::Value, String> {
        // Check connection state first
        if !*self.is_connected.lock().unwrap() {
            if let Some(error) = self.get_last_error() {
                return Err(format!("Not connected: {}", error));
            }
            return Err("Not connected".to_string());
        }
        
        // Check cancellation
        if self.is_cancelled() {
            return Err("Operation cancelled".to_string());
        }
        
        let id = self.request_id.fetch_add(1, Ordering::SeqCst);
        
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };

        let message = serde_json::to_string(&request).map_err(|e| e.to_string())? + "\n";
        log::debug!("[MCP][{}] Sending request {} (id={}): {}", self.server_name, method, id, message.trim());

        // Create response channel
        let (tx, rx) = oneshot::channel();
        self.pending_requests.lock().unwrap().insert(id, tx);

        // Send request - clone the sender before await to avoid holding MutexGuard across await
        let stdin_tx_clone = {
            let guard = self.stdin_tx.lock().unwrap();
            guard.clone()
        };
        
        if let Some(sender) = stdin_tx_clone {
            if let Err(e) = sender.send(message).await {
                self.pending_requests.lock().unwrap().remove(&id);
                self.set_error(format!("Failed to send request: {}", e));
                return Err(format!("Failed to send request: {}", e));
            }
        } else {
            self.pending_requests.lock().unwrap().remove(&id);
            return Err("stdin not available - process may have terminated".to_string());
        }

        // Wait for response with timeout
        match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            rx,
        ).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                // Channel was closed - likely process died
                let error = "Response channel closed - process may have terminated".to_string();
                self.set_error(error.clone());
                Err(error)
            }
            Err(_) => {
                self.pending_requests.lock().unwrap().remove(&id);
                Err(format!("Request timeout after {}ms: {}", timeout_ms, method))
            }
        }
    }

    /// Send a notification (no response expected)
    async fn send_notification(&self, method: &str, params: Option<serde_json::Value>) -> Result<(), String> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        };

        let message = serde_json::to_string(&notification).map_err(|e| e.to_string())? + "\n";

        // Clone the sender before await to avoid holding MutexGuard across await
        let stdin_tx_clone = {
            let guard = self.stdin_tx.lock().unwrap();
            guard.clone()
        };
        
        if let Some(sender) = stdin_tx_clone {
            sender.send(message).await.map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    /// Disconnect from the server and cleanup resources
    pub fn disconnect(&self) {
        log::info!("[MCP][{}] Disconnecting", self.server_name);
        
        // Set cancelled to interrupt any ongoing operations
        self.cancelled.store(true, Ordering::SeqCst);
        *self.is_connected.lock().unwrap() = false;
        
        // Drop stdin sender to signal writer thread to exit
        *self.stdin_tx.lock().unwrap() = None;
        
        // Clear pending requests with appropriate error
        {
            let mut pending = self.pending_requests.lock().unwrap();
            for (id, tx) in pending.drain() {
                log::debug!("[MCP][{}] Cancelling pending request {} due to disconnect", self.server_name, id);
                let _ = tx.send(Err("Connection closed".to_string()));
            }
        }

        // Kill process and wait for it to exit to avoid zombies
        if let Some(mut process) = self.process.lock().unwrap().take() {
            log::info!("[MCP][{}] Killing process", self.server_name);
            
            // Try graceful shutdown first
            let _ = process.kill();
            
            // Wait for process to exit with timeout
            match process.try_wait() {
                Ok(Some(status)) => {
                    log::info!("[MCP][{}] Process exited with status: {:?}", self.server_name, status);
                }
                Ok(None) => {
                    // Process still running, wait a bit
                    log::debug!("[MCP][{}] Waiting for process to exit...", self.server_name);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    match process.try_wait() {
                        Ok(Some(status)) => {
                            log::info!("[MCP][{}] Process exited with status: {:?}", self.server_name, status);
                        }
                        _ => {
                            log::warn!("[MCP][{}] Process did not exit cleanly", self.server_name);
                        }
                    }
                }
                Err(e) => {
                    log::error!("[MCP][{}] Error checking process status: {}", self.server_name, e);
                }
            }
        }

        *self.tools.lock().unwrap() = Vec::new();
        *self.resources.lock().unwrap() = Vec::new();
    }

    /// Get current connection status
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

    /// Get server status (includes error info if any)
    pub fn get_status(&self) -> ServerStatus {
        ServerStatus {
            server_id: self.server_id.clone(),
            name: self.server_name.clone(),
            is_running: self.is_connected(),
            tools: self.get_tools(),
            resources: self.get_resources(),
            server_info: self.get_server_info(),
            error: self.get_last_error(),
        }
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        self.disconnect();
    }
}
