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
pub struct Message {
    pub role: String,
    pub content: MessageContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_history: Option<Vec<serde_json::Value>>,
}

/// Tab 消息缓存 - 在内存中管理每个会话的消息
pub struct TabMessageCache {
    cache: Mutex<HashMap<String, Vec<Message>>>,
}

impl TabMessageCache {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// 获取指定会话的所有消息
    pub fn get(&self, conversation_id: &str) -> Vec<Message> {
        let cache = self.cache.lock().unwrap();
        cache.get(conversation_id).cloned().unwrap_or_default()
    }

    /// 设置指定会话的消息（完全替换）
    pub fn set(&self, conversation_id: &str, messages: Vec<Message>) {
        let mut cache = self.cache.lock().unwrap();
        cache.insert(conversation_id.to_string(), messages);
    }

    /// 添加一条消息到指定会话
    pub fn add(&self, conversation_id: &str, message: Message) {
        let mut cache = self.cache.lock().unwrap();
        cache
            .entry(conversation_id.to_string())
            .or_insert_with(Vec::new)
            .push(message);
    }

    /// 更新指定位置的消息
    pub fn update(&self, conversation_id: &str, index: usize, message: Message) -> bool {
        let mut cache = self.cache.lock().unwrap();
        if let Some(messages) = cache.get_mut(conversation_id) {
            if index < messages.len() {
                messages[index] = message;
                return true;
            }
        }
        false
    }

    /// 删除指定位置的消息
    pub fn delete(&self, conversation_id: &str, index: usize) -> bool {
        let mut cache = self.cache.lock().unwrap();
        if let Some(messages) = cache.get_mut(conversation_id) {
            if index < messages.len() {
                messages.remove(index);
                return true;
            }
        }
        false
    }

    /// 清空指定会话的消息
    pub fn clear(&self, conversation_id: &str) {
        let mut cache = self.cache.lock().unwrap();
        cache.remove(conversation_id);
    }

    /// 获取消息数量
    pub fn len(&self, conversation_id: &str) -> usize {
        let cache = self.cache.lock().unwrap();
        cache.get(conversation_id).map(|m| m.len()).unwrap_or(0)
    }
}

// ============ Tauri Commands ============

/// 获取指定会话的消息
#[tauri::command]
pub fn get_tab_messages(
    cache: tauri::State<TabMessageCache>,
    conversation_id: String,
) -> Vec<Message> {
    cache.get(&conversation_id)
}

/// 设置指定会话的消息（完全替换）
#[tauri::command]
pub fn set_tab_messages(
    cache: tauri::State<TabMessageCache>,
    conversation_id: String,
    messages: Vec<Message>,
    app: AppHandle,
) {
    cache.set(&conversation_id, messages);
    // 通知前端消息已更新
    let _ = app.emit("tab-messages-updated", &conversation_id);
}

/// 添加一条消息
#[tauri::command]
pub fn add_tab_message(
    cache: tauri::State<TabMessageCache>,
    conversation_id: String,
    message: Message,
    app: AppHandle,
) {
    cache.add(&conversation_id, message);
    // 通知前端消息已更新
    let _ = app.emit("tab-messages-updated", &conversation_id);
}

/// 更新指定位置的消息
#[tauri::command]
pub fn update_tab_message(
    cache: tauri::State<TabMessageCache>,
    conversation_id: String,
    index: usize,
    message: Message,
    app: AppHandle,
) -> bool {
    let success = cache.update(&conversation_id, index, message);
    if success {
        let _ = app.emit("tab-messages-updated", &conversation_id);
    }
    success
}

/// 删除指定位置的消息
#[tauri::command]
pub fn delete_tab_message(
    cache: tauri::State<TabMessageCache>,
    conversation_id: String,
    index: usize,
    app: AppHandle,
) -> bool {
    let success = cache.delete(&conversation_id, index);
    if success {
        let _ = app.emit("tab-messages-updated", &conversation_id);
    }
    success
}

/// 清空指定会话的消息
#[tauri::command]
pub fn clear_tab_messages(
    cache: tauri::State<TabMessageCache>,
    conversation_id: String,
    app: AppHandle,
) {
    cache.clear(&conversation_id);
    let _ = app.emit("tab-messages-updated", &conversation_id);
}

/// 获取消息数量
#[tauri::command]
pub fn get_tab_messages_count(
    cache: tauri::State<TabMessageCache>,
    conversation_id: String,
) -> usize {
    cache.len(&conversation_id)
}
