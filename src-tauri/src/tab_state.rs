use std::collections::HashMap;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// 消息内容可以是字符串或复杂对象（如多模态内容）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<serde_json::Value>),
}

/// 单条消息
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub content: MessageContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_history: Option<Vec<serde_json::Value>>,
}

/// Tab 状态快照 - 推送给前端的数据结构
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TabStateSnapshot {
    pub messages: Vec<Message>,
    pub is_thinking: bool,
}

/// 简化的 Tab 状态管理 - Rust 完全拥有数据所有权
/// 
/// 设计原则：
/// 1. Rust 是唯一的数据源（Single Source of Truth）
/// 2. 前端只是"订阅者"，不维护自己的消息状态
/// 3. 任何修改都会自动推送完整状态给前端
pub struct TabState {
    /// 消息数据 - Rust 独占所有权
    messages: Mutex<HashMap<String, Vec<Message>>>,
    /// 思考状态 - Rust 独占所有权
    thinking: Mutex<HashMap<String, bool>>,
}

impl TabState {
    pub fn new() -> Self {
        Self {
            messages: Mutex::new(HashMap::new()),
            thinking: Mutex::new(HashMap::new()),
        }
    }

    /// 获取指定会话的状态快照
    fn get_snapshot(&self, conversation_id: &str) -> TabStateSnapshot {
        let messages = self.messages.lock().unwrap();
        let thinking = self.thinking.lock().unwrap();

        TabStateSnapshot {
            messages: messages.get(conversation_id).cloned().unwrap_or_default(),
            is_thinking: *thinking.get(conversation_id).unwrap_or(&false),
        }
    }

    /// 推送状态更新到前端
    fn emit_state(&self, conversation_id: &str, app: &AppHandle) {
        let snapshot = self.get_snapshot(conversation_id);
        // 使用特定于会话的事件名，前端可以精确订阅
        let event_name = format!("tab-state:{}", conversation_id);
        if let Err(e) = app.emit(&event_name, &snapshot) {
            eprintln!("[TabState] Failed to emit state: {:?}", e);
        }
    }
}

// ============ Tauri Commands ============

/// 获取指定 tab 的完整状态（用于初始加载）
#[tauri::command]
pub fn get_tab_state(
    state: tauri::State<TabState>,
    conversation_id: String,
) -> TabStateSnapshot {
    state.get_snapshot(&conversation_id)
}

/// 初始化 tab 消息（切换 tab 时调用，只在缓存为空时初始化）
#[tauri::command]
pub fn init_tab_messages(
    state: tauri::State<TabState>,
    conversation_id: String,
    messages: Vec<Message>,
    app: AppHandle,
) {
    {
        let mut msg_map = state.messages.lock().unwrap();
        // 使用 entry API - 所有权转移，messages 被移动到 HashMap
        msg_map.entry(conversation_id.clone()).or_insert(messages);
    }
    state.emit_state(&conversation_id, &app);
}

/// 设置 tab 消息（完全替换）
#[tauri::command]
pub fn set_tab_state_messages(
    state: tauri::State<TabState>,
    conversation_id: String,
    messages: Vec<Message>,
    app: AppHandle,
) {
    {
        let mut msg_map = state.messages.lock().unwrap();
        msg_map.insert(conversation_id.clone(), messages);
    }
    state.emit_state(&conversation_id, &app);
}

/// 添加一条消息（Rust 会自动推送更新）
#[tauri::command]
pub fn push_tab_message(
    state: tauri::State<TabState>,
    conversation_id: String,
    message: Message,
    app: AppHandle,
) {
    {
        let mut msg_map = state.messages.lock().unwrap();
        msg_map
            .entry(conversation_id.clone())
            .or_default()
            .push(message);
    }
    state.emit_state(&conversation_id, &app);
}

/// 更新指定位置的消息
#[tauri::command]
pub fn update_tab_state_message(
    state: tauri::State<TabState>,
    conversation_id: String,
    index: usize,
    message: Message,
    app: AppHandle,
) -> bool {
    let success = {
        let mut msg_map = state.messages.lock().unwrap();
        if let Some(messages) = msg_map.get_mut(&conversation_id) {
            if index < messages.len() {
                messages[index] = message;
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if success {
        state.emit_state(&conversation_id, &app);
    }
    success
}

/// 删除指定位置的消息
#[tauri::command]
pub fn delete_tab_state_message(
    state: tauri::State<TabState>,
    conversation_id: String,
    index: usize,
    app: AppHandle,
) -> bool {
    let success = {
        let mut msg_map = state.messages.lock().unwrap();
        if let Some(messages) = msg_map.get_mut(&conversation_id) {
            if index < messages.len() {
                messages.remove(index);
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if success {
        state.emit_state(&conversation_id, &app);
    }
    success
}

/// 设置 thinking 状态（Rust 会自动推送更新）
#[tauri::command]
pub fn set_tab_thinking(
    state: tauri::State<TabState>,
    conversation_id: String,
    is_thinking: bool,
    app: AppHandle,
) {
    {
        let mut thinking_map = state.thinking.lock().unwrap();
        thinking_map.insert(conversation_id.clone(), is_thinking);
    }
    state.emit_state(&conversation_id, &app);
}

/// 清空指定会话的所有状态
#[tauri::command]
pub fn clear_tab_state(
    state: tauri::State<TabState>,
    conversation_id: String,
    app: AppHandle,
) {
    {
        let mut msg_map = state.messages.lock().unwrap();
        let mut thinking_map = state.thinking.lock().unwrap();
        msg_map.remove(&conversation_id);
        thinking_map.remove(&conversation_id);
    }
    state.emit_state(&conversation_id, &app);
}
