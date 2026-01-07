use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;
use super::Database;

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    // Transport type: "stdio" or "http"
    #[serde(default)]
    pub transport: TransportType,
    // For stdio transport
    #[serde(default)]
    pub command: String,
    pub args: Option<Vec<String>>,
    pub env: Option<std::collections::HashMap<String, String>>,
    // For http transport
    pub url: Option<String>,
    pub api_key: Option<String>,
    // Common fields
    pub icon: Option<String>,
    pub auto_start: bool,
    pub show_in_toolbar: bool,
    pub toolbar_order: i32,
    // Max tool call iterations for this server (None = unlimited)
    pub max_iterations: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
    // Runtime state (not persisted)
    #[serde(default)]
    pub is_running: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMcpServerData {
    pub name: String,
    #[serde(default)]
    pub transport: Option<TransportType>,
    // For stdio
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<std::collections::HashMap<String, String>>,
    // For http
    pub url: Option<String>,
    pub api_key: Option<String>,
    // Common
    pub icon: Option<String>,
    pub auto_start: Option<bool>,
    pub show_in_toolbar: Option<bool>,
    // Max iterations (None = unlimited)
    pub max_iterations: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpServerData {
    pub name: Option<String>,
    pub transport: Option<TransportType>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub url: Option<String>,
    pub api_key: Option<String>,
    pub icon: Option<String>,
    pub auto_start: Option<bool>,
    pub show_in_toolbar: Option<bool>,
    pub toolbar_order: Option<i32>,
    // Max iterations (None = unlimited, Some(0) to clear/reset to unlimited)
    #[serde(default, deserialize_with = "deserialize_optional_max_iterations")]
    pub max_iterations: Option<Option<i32>>,
}

// Custom deserializer to handle max_iterations: null vs absent vs 0
fn deserialize_optional_max_iterations<'de, D>(deserializer: D) -> std::result::Result<Option<Option<i32>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let opt: Option<Option<i32>> = Option::deserialize(deserializer)?;
    Ok(opt)
}

fn parse_transport(s: &str) -> TransportType {
    match s.to_lowercase().as_str() {
        "http" => TransportType::Http,
        _ => TransportType::Stdio,
    }
}

fn transport_to_string(t: &TransportType) -> &'static str {
    match t {
        TransportType::Http => "http",
        TransportType::Stdio => "stdio",
    }
}

impl Database {
    pub fn get_all_mcp_servers(&self) -> Result<Vec<McpServer>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, transport, command, args, env, url, api_key, icon, auto_start, 
                    show_in_toolbar, toolbar_order, max_iterations, created_at, updated_at 
             FROM mcp_servers ORDER BY toolbar_order"
        )?;
        
        let servers = stmt.query_map([], |row| {
            let transport_str: String = row.get::<_, Option<String>>(2)?.unwrap_or_else(|| "stdio".to_string());
            let args_json: Option<String> = row.get(4)?;
            let env_json: Option<String> = row.get(5)?;
            
            Ok(McpServer {
                id: row.get(0)?,
                name: row.get(1)?,
                transport: parse_transport(&transport_str),
                command: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                args: args_json.and_then(|s| serde_json::from_str(&s).ok()),
                env: env_json.and_then(|s| serde_json::from_str(&s).ok()),
                url: row.get(6)?,
                api_key: row.get(7)?,
                icon: row.get(8)?,
                auto_start: row.get::<_, i32>(9)? != 0,
                show_in_toolbar: row.get::<_, i32>(10)? != 0,
                toolbar_order: row.get(11)?,
                max_iterations: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                is_running: false,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(servers)
    }

    pub fn get_mcp_server_by_id(&self, id: &str) -> Result<Option<McpServer>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, transport, command, args, env, url, api_key, icon, auto_start, 
                    show_in_toolbar, toolbar_order, max_iterations, created_at, updated_at 
             FROM mcp_servers WHERE id = ?"
        )?;
        
        let mut rows = stmt.query(params![id])?;
        
        if let Some(row) = rows.next()? {
            let transport_str: String = row.get::<_, Option<String>>(2)?.unwrap_or_else(|| "stdio".to_string());
            let args_json: Option<String> = row.get(4)?;
            let env_json: Option<String> = row.get(5)?;
            
            Ok(Some(McpServer {
                id: row.get(0)?,
                name: row.get(1)?,
                transport: parse_transport(&transport_str),
                command: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                args: args_json.and_then(|s| serde_json::from_str(&s).ok()),
                env: env_json.and_then(|s| serde_json::from_str(&s).ok()),
                url: row.get(6)?,
                api_key: row.get(7)?,
                icon: row.get(8)?,
                auto_start: row.get::<_, i32>(9)? != 0,
                show_in_toolbar: row.get::<_, i32>(10)? != 0,
                toolbar_order: row.get(11)?,
                max_iterations: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                is_running: false,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn get_mcp_server_by_name(&self, name: &str) -> Result<Option<McpServer>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, transport, command, args, env, url, api_key, icon, auto_start, 
                    show_in_toolbar, toolbar_order, max_iterations, created_at, updated_at 
             FROM mcp_servers WHERE name = ?"
        )?;
        
        let mut rows = stmt.query(params![name])?;
        
        if let Some(row) = rows.next()? {
            let transport_str: String = row.get::<_, Option<String>>(2)?.unwrap_or_else(|| "stdio".to_string());
            let args_json: Option<String> = row.get(4)?;
            let env_json: Option<String> = row.get(5)?;
            
            Ok(Some(McpServer {
                id: row.get(0)?,
                name: row.get(1)?,
                transport: parse_transport(&transport_str),
                command: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                args: args_json.and_then(|s| serde_json::from_str(&s).ok()),
                env: env_json.and_then(|s| serde_json::from_str(&s).ok()),
                url: row.get(6)?,
                api_key: row.get(7)?,
                icon: row.get(8)?,
                auto_start: row.get::<_, i32>(9)? != 0,
                show_in_toolbar: row.get::<_, i32>(10)? != 0,
                toolbar_order: row.get(11)?,
                max_iterations: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                is_running: false,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn create_mcp_server(&self, data: CreateMcpServerData) -> Result<McpServer> {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let auto_start = data.auto_start.unwrap_or(false);
        let show_in_toolbar = data.show_in_toolbar.unwrap_or(true);
        let transport = data.transport.unwrap_or(TransportType::Stdio);
        let args_json = data.args.as_ref().map(|a| serde_json::to_string(a).unwrap());
        let env_json = data.env.as_ref().map(|e| serde_json::to_string(e).unwrap());
        // For HTTP transport, command can be empty; use empty string to satisfy NOT NULL constraint
        let command = data.command.clone().unwrap_or_default();
        
        conn.execute(
            "INSERT INTO mcp_servers (id, name, transport, command, args, env, url, api_key, icon, auto_start, 
                                      show_in_toolbar, toolbar_order, max_iterations, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?14)",
            params![
                id,
                data.name,
                transport_to_string(&transport),
                command,
                args_json,
                env_json,
                data.url,
                data.api_key,
                data.icon,
                auto_start as i32,
                show_in_toolbar as i32,
                data.max_iterations,
                now,
                now
            ],
        )?;
        
        Ok(McpServer {
            id,
            name: data.name,
            transport,
            command: data.command.unwrap_or_default(),
            args: data.args,
            env: data.env,
            url: data.url,
            api_key: data.api_key,
            icon: data.icon,
            auto_start,
            show_in_toolbar,
            toolbar_order: 0,
            max_iterations: data.max_iterations,
            created_at: now.clone(),
            updated_at: now,
            is_running: false,
        })
    }

    pub fn update_mcp_server(&self, id: &str, data: UpdateMcpServerData) -> Result<Option<McpServer>> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        
        // Build dynamic UPDATE query
        let mut updates = vec!["updated_at = ?1".to_string()];
        let mut param_count = 2;
        
        if data.name.is_some() {
            updates.push(format!("name = ?{}", param_count));
            param_count += 1;
        }
        if data.transport.is_some() {
            updates.push(format!("transport = ?{}", param_count));
            param_count += 1;
        }
        if data.command.is_some() {
            updates.push(format!("command = ?{}", param_count));
            param_count += 1;
        }
        if data.args.is_some() {
            updates.push(format!("args = ?{}", param_count));
            param_count += 1;
        }
        if data.env.is_some() {
            updates.push(format!("env = ?{}", param_count));
            param_count += 1;
        }
        if data.url.is_some() {
            updates.push(format!("url = ?{}", param_count));
            param_count += 1;
        }
        if data.api_key.is_some() {
            updates.push(format!("api_key = ?{}", param_count));
            param_count += 1;
        }
        if data.icon.is_some() {
            updates.push(format!("icon = ?{}", param_count));
            param_count += 1;
        }
        if data.auto_start.is_some() {
            updates.push(format!("auto_start = ?{}", param_count));
            param_count += 1;
        }
        if data.show_in_toolbar.is_some() {
            updates.push(format!("show_in_toolbar = ?{}", param_count));
            param_count += 1;
        }
        if data.toolbar_order.is_some() {
            updates.push(format!("toolbar_order = ?{}", param_count));
            param_count += 1;
        }
        if data.max_iterations.is_some() {
            updates.push(format!("max_iterations = ?{}", param_count));
            param_count += 1;
        }
        
        let sql = format!(
            "UPDATE mcp_servers SET {} WHERE id = ?{}",
            updates.join(", "),
            param_count
        );
        
        // Build params dynamically
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now)];
        if let Some(name) = &data.name { params_vec.push(Box::new(name.clone())); }
        if let Some(transport) = &data.transport { params_vec.push(Box::new(transport_to_string(transport).to_string())); }
        if let Some(command) = &data.command { params_vec.push(Box::new(command.clone())); }
        if let Some(args) = &data.args { params_vec.push(Box::new(serde_json::to_string(args).unwrap())); }
        if let Some(env) = &data.env { params_vec.push(Box::new(serde_json::to_string(env).unwrap())); }
        if let Some(url) = &data.url { params_vec.push(Box::new(url.clone())); }
        if let Some(api_key) = &data.api_key { params_vec.push(Box::new(api_key.clone())); }
        if let Some(icon) = &data.icon { params_vec.push(Box::new(icon.clone())); }
        if let Some(auto_start) = data.auto_start { params_vec.push(Box::new(auto_start as i32)); }
        if let Some(show_in_toolbar) = data.show_in_toolbar { params_vec.push(Box::new(show_in_toolbar as i32)); }
        if let Some(toolbar_order) = data.toolbar_order { params_vec.push(Box::new(toolbar_order)); }
        if let Some(max_iterations) = &data.max_iterations { params_vec.push(Box::new(*max_iterations)); }
        params_vec.push(Box::new(id.to_string()));
        
        let params: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())?;
        
        drop(conn);
        self.get_mcp_server_by_id(id)
    }

    pub fn delete_mcp_server(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute("DELETE FROM mcp_servers WHERE id = ?", params![id])?;
        Ok(rows > 0)
    }
}
