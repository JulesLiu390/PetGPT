// MCP (Model Context Protocol) implementation for Tauri
// Supports both stdio and HTTP/SSE transports

pub mod client;
pub mod http_client;
pub mod manager;
pub mod types;

pub use client::McpClient;
pub use http_client::McpHttpClient;
pub use manager::McpManager;
pub use types::*;
