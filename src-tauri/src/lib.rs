mod database;
mod mcp;
mod message_cache;
mod tab_state;
mod llm;
mod workspace;
mod platform;
mod window_layout;
#[cfg(target_os = "linux")]
mod linux_shortcuts;

use database::{Database, pets, conversations, messages, settings, mcp_servers, api_providers, skins};
use mcp::{McpManager, ServerStatus, McpToolInfo, CallToolResponse, ToolContent, SamplingLlmConfig};
use message_cache::TabMessageCache;
use tab_state::TabState;
use llm::{LlmClient, LlmRequest, LlmResponse, StreamChunk, LlmStreamCancellation};
use workspace::WorkspaceEngine;
use platform::{Platform, PlatformProvider, WindowEffect};
use window_layout::{WindowState, screen_info_from_tauri_monitor};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::collections::HashMap;
use tauri::{State, Manager, AppHandle, LogicalPosition, LogicalSize, Emitter};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;
use tauri_plugin_clipboard_manager::ClipboardExt;
use serde_json::Value as JsonValue;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

// Type alias for LLM client state
type LlmState = Arc<LlmClient>;

// Type alias for LLM stream cancellation state
type LlmCancelState = Arc<LlmStreamCancellation>;

// Type alias for MCP manager state
type McpState = Arc<tokio::sync::RwLock<McpManager>>;

// Type alias for workspace state
type WorkspaceFileState = Arc<WorkspaceEngine>;

// Type alias for window layout state
type WinState = Arc<WindowState>;

#[allow(unused_imports)]
use tauri::WebviewWindow;

// Type alias for database state
type DbState = Arc<Database>;

// ============ Event Broadcasting ============

/// 广播事件到所有窗口
#[tauri::command]
fn emit_to_all(app: AppHandle, event: String, payload: JsonValue, win_state: State<WinState>) -> Result<(), String> {
    // 如果是 character-id 事件，存储到 pending
    if event == "character-id" {
        if let Some(id) = payload.as_str() {
            let mut pending = win_state.pending_character_id.lock().unwrap();
            *pending = Some(id.to_string());
        }
    }

    // 使用 app.emit 广播到所有窗口（只广播一次，避免重复）
    app.emit(&event, payload).map_err(|e| e.to_string())
}

/// 获取并清除待处理的 character-id
#[tauri::command]
fn get_pending_character_id(win_state: State<WinState>) -> Option<String> {
    let mut pending = win_state.pending_character_id.lock().unwrap();
    pending.take()
}

/// 设置 chat 窗口的 vibrancy 效果（跨平台）
#[tauri::command]
fn set_vibrancy_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(chat_window) = app.get_webview_window("chat") {
        if enabled {
            Platform::apply_window_effect(
                &chat_window,
                &WindowEffect::Vibrancy { radius: 16.0 },
            )?;
        } else {
            Platform::clear_window_effect(&chat_window)?;
        }
    }
    Ok(())
}

// ============ LLM Commands ============

/// 非流式调用 LLM
#[tauri::command]
async fn llm_call(
    llm_client: State<'_, LlmState>,
    request: LlmRequest,
) -> Result<LlmResponse, String> {
    llm_client.call(&request).await
}

/// 流式调用 LLM - 通过 Tauri 事件推送块
#[tauri::command]
async fn llm_stream(
    app: AppHandle,
    cancellation: State<'_, LlmCancelState>,
    request: LlmRequest,
) -> Result<LlmResponse, String> {
    llm::stream_chat(app, request, cancellation.inner().clone()).await
}

/// 取消指定会话的 LLM 流
#[tauri::command]
fn llm_cancel_stream(
    cancellation: State<'_, LlmCancelState>,
    conversation_id: String,
) -> Result<(), String> {
    cancellation.cancel(&conversation_id);
    Ok(())
}

/// 取消所有 LLM 流
#[tauri::command]
fn llm_cancel_all_streams(
    cancellation: State<'_, LlmCancelState>,
) -> Result<(), String> {
    cancellation.cancel_all();
    Ok(())
}

/// 重置指定会话的取消状态
#[tauri::command]
fn llm_reset_cancellation(
    cancellation: State<'_, LlmCancelState>,
    conversation_id: String,
) -> Result<(), String> {
    cancellation.reset(&conversation_id);
    Ok(())
}

// ============ Pet Commands ============

#[tauri::command]
fn get_pets(db: State<DbState>) -> Result<Vec<pets::Pet>, String> {
    db.get_all_pets().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_pet(db: State<DbState>, id: String) -> Result<Option<pets::Pet>, String> {
    db.get_pet_by_id(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_pet(db: State<DbState>, data: pets::CreatePetData) -> Result<pets::Pet, String> {
    db.create_pet(data).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_pet(db: State<DbState>, id: String, data: pets::UpdatePetData) -> Result<Option<pets::Pet>, String> {
    db.update_pet(&id, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_pet(db: State<DbState>, id: String) -> Result<bool, String> {
    db.delete_pet(&id).map_err(|e| e.to_string())
}

// ============ Conversation Commands ============

#[tauri::command]
#[allow(non_snake_case)]
fn get_conversations_by_pet(db: State<DbState>, petId: String) -> Result<Vec<conversations::Conversation>, String> {
    db.get_conversations_by_pet(&petId).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_conversation(db: State<DbState>, id: String) -> Result<Option<conversations::Conversation>, String> {
    db.get_conversation_by_id(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_conversation(db: State<DbState>, data: conversations::CreateConversationData) -> Result<conversations::Conversation, String> {
    db.create_conversation(data).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_conversation_title(db: State<DbState>, id: String, title: String) -> Result<bool, String> {
    db.update_conversation_title(&id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_conversation(db: State<DbState>, id: String) -> Result<bool, String> {
    db.delete_conversation(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_orphan_conversations(db: State<DbState>) -> Result<Vec<conversations::Conversation>, String> {
    db.get_orphan_conversations().map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
fn transfer_conversation(db: State<DbState>, conversationId: String, newPetId: String) -> Result<bool, String> {
    db.transfer_conversation(&conversationId, &newPetId).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
fn transfer_all_conversations(db: State<DbState>, oldPetId: String, newPetId: String) -> Result<usize, String> {
    db.transfer_all_conversations(&oldPetId, &newPetId).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_conversations(db: State<DbState>, query: String) -> Result<Vec<conversations::SearchResult>, String> {
    db.search_conversations(&query).map_err(|e| e.to_string())
}

// ============ Message Commands ============

#[tauri::command]
#[allow(non_snake_case)]
fn get_messages(db: State<DbState>, conversationId: String) -> Result<Vec<messages::Message>, String> {
    db.get_messages_by_conversation(&conversationId).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_message(db: State<DbState>, data: messages::CreateMessageData) -> Result<messages::Message, String> {
    println!("[Rust create_message] ★ convId={}, role={}, content_len={}", data.conversation_id, data.role, data.content.len());
    let result = db.create_message(data);
    match &result {
        Ok(msg) => println!("[Rust create_message] ✅ saved msgId={} to convId={}", msg.id, msg.conversation_id),
        Err(e) => println!("[Rust create_message] ❌ ERROR: {:?}", e),
    }
    result.map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
fn clear_conversation_messages(db: State<DbState>, conversationId: String) -> Result<usize, String> {
    println!("[Rust clear_conversation_messages] ★ convId={}", conversationId);
    let result = db.clear_conversation_messages(&conversationId);
    match &result {
        Ok(count) => println!("[Rust clear_conversation_messages] ✅ deleted {} messages from convId={}", count, conversationId),
        Err(e) => println!("[Rust clear_conversation_messages] ❌ ERROR: {:?}", e),
    }
    result.map_err(|e| e.to_string())
}

// ============ Settings Commands ============

#[tauri::command]
fn get_setting(db: State<DbState>, key: String) -> Result<Option<String>, String> {
    db.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_setting(app: AppHandle, db: State<DbState>, key: String, value: String) -> Result<(), String> {
    db.set_setting(&key, &value).map_err(|e| e.to_string())?;
    
    // 广播设置更新事件到所有窗口
    let payload = serde_json::json!({
        "key": key,
        "value": value
    });
    let _ = app.emit("settings-updated", payload);
    
    Ok(())
}

#[tauri::command]
fn get_all_settings(db: State<DbState>) -> Result<Vec<settings::Setting>, String> {
    db.get_all_settings().map_err(|e| e.to_string())
}

// ============ API Provider Commands ============

#[tauri::command]
fn get_api_providers(db: State<DbState>) -> Result<Vec<api_providers::ApiProvider>, String> {
    db.get_all_api_providers().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_api_provider(db: State<DbState>, id: String) -> Result<Option<api_providers::ApiProvider>, String> {
    db.get_api_provider_by_id(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_api_provider(app: AppHandle, db: State<DbState>, id: String, data: api_providers::UpdateApiProviderData) -> Result<Option<api_providers::ApiProvider>, String> {
    let result = db.update_api_provider(&id, data).map_err(|e| e.to_string())?;
    
    // Broadcast update event
    let payload = serde_json::json!({
        "action": "update",
        "provider": result
    });
    let _ = app.emit("api-providers-updated", payload);
    
    Ok(result)
}

#[tauri::command]
fn create_api_provider(app: AppHandle, db: State<DbState>, data: api_providers::CreateApiProviderData) -> Result<api_providers::ApiProvider, String> {
    let result = db.create_api_provider(data).map_err(|e| e.to_string())?;
    
    // Broadcast update event
    let payload = serde_json::json!({
        "action": "create",
        "provider": result
    });
    let _ = app.emit("api-providers-updated", payload);
    
    Ok(result)
}

#[tauri::command]
fn delete_api_provider(app: AppHandle, db: State<DbState>, id: String) -> Result<bool, String> {
    let result = db.delete_api_provider(&id).map_err(|e| e.to_string())?;
    
    // Broadcast update event
    let payload = serde_json::json!({
        "action": "delete",
        "id": id
    });
    let _ = app.emit("api-providers-updated", payload);
    
    Ok(result)
}

#[tauri::command]
fn get_skins(db: State<DbState>) -> Result<Vec<skins::Skin>, String> {
    db.get_all_skins().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_skins_with_hidden(db: State<DbState>) -> Result<Vec<skins::Skin>, String> {
    db.get_all_skins_with_hidden().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_skin(db: State<DbState>, id: String) -> Result<Option<skins::Skin>, String> {
    db.get_skin_by_id(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_skin_by_name(db: State<DbState>, name: String) -> Result<Option<skins::Skin>, String> {
    db.get_skin_by_name(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_skin(db: State<DbState>, data: skins::CreateSkinData) -> Result<skins::Skin, String> {
    db.create_skin(data).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_skin(db: State<DbState>, id: String, data: skins::UpdateSkinData) -> Result<Option<skins::Skin>, String> {
    db.update_skin(&id, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_skin(db: State<DbState>, id: String) -> Result<bool, String> {
    db.delete_skin(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_skin(db: State<DbState>, id: String) -> Result<bool, String> {
    db.hide_skin(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_skin(db: State<DbState>, id: String) -> Result<bool, String> {
    db.restore_skin(&id).map_err(|e| e.to_string())
}

/// 导入皮肤：从 JSON 文件导入，自动读取同目录下的图片
/// JSON 格式：{ "name": "MySkin", "author": "Me", "moods": ["happy", "sad"] }
/// 图片命名：0.png, 1.png, 2.png... 或 0.jpg, 0.gif 等
#[tauri::command]
#[allow(non_snake_case)]
fn import_skin(
    app: AppHandle,
    db: State<DbState>,
    jsonPath: String,  // JSON 文件的绝对路径
) -> Result<skins::Skin, String> {
    use std::path::Path;
    use indexmap::IndexMap;
    
    // 1. 读取并解析 JSON 配置
    // moods 格式: { "表情名": "图片文件名" }，例如 { "normal": "idle.png", "happy": "smile.gif" }
    // 使用 IndexMap 保持插入顺序
    #[derive(serde::Deserialize)]
    struct SkinConfig {
        name: String,
        author: Option<String>,
        description: Option<String>,
        moods: IndexMap<String, String>,  // 表情名 -> 图片文件名（保持顺序）
    }
    
    let json_content = fs::read_to_string(&jsonPath)
        .map_err(|e| format!("Failed to read JSON file: {}", e))?;
    
    let config: SkinConfig = serde_json::from_str(&json_content)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;
    
    // 验证必须有 normal 表情
    if !config.moods.contains_key("normal") {
        return Err("Skin must have a 'normal' mood defined".to_string());
    }
    
    // 确保 normal 在索引 0 位置，其他保持原顺序
    let mut mood_names: Vec<String> = Vec::new();
    mood_names.push("normal".to_string());
    for key in config.moods.keys() {
        if key != "normal" {
            mood_names.push(key.clone());
        }
    }
    
    // 2. 创建数据库记录
    let skin = db.create_skin(skins::CreateSkinData {
        name: config.name.clone(),
        author: config.author,
        description: config.description,
        is_builtin: false,
        moods: Some(mood_names.clone()),
    }).map_err(|e| e.to_string())?;
    
    // 3. 创建皮肤图片目录
    let skins_dir = get_skins_dir(&app)?;
    let skin_dir = skins_dir.join(&skin.id);
    fs::create_dir_all(&skin_dir)
        .map_err(|e| format!("Failed to create skin dir: {}", e))?;
    
    // 4. 获取 JSON 文件所在目录
    let json_dir = Path::new(&jsonPath)
        .parent()
        .ok_or_else(|| "Invalid JSON path".to_string())?;
    
    // 5. 按照 mood 顺序读取并复制图片文件（保留原始格式）
    // normal 现在是索引 0
    for (i, mood_name) in mood_names.iter().enumerate() {
        let image_filename = config.moods.get(mood_name)
            .ok_or_else(|| format!("Missing image for mood: {}", mood_name))?;
        
        let source_path = json_dir.join(image_filename);
        
        if !source_path.exists() {
            // 清理已创建的资源
            let _ = fs::remove_dir_all(&skin_dir);
            let _ = db.delete_skin(&skin.id);
            return Err(format!(
                "Image file not found for mood '{}': {}",
                mood_name,
                source_path.display()
            ));
        }
        
        // 获取原始文件扩展名
        let ext = source_path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        
        // 直接复制文件，保留原始格式（支持 GIF 动画）
        let dest_path = skin_dir.join(format!("{}.{}", i, ext));
        fs::copy(&source_path, &dest_path)
            .map_err(|e| format!("Failed to copy image '{}': {}", image_filename, e))?;
    }
    
    println!("[Rust] Skin imported from JSON: {} with {} moods -> {:?}", skin.name, mood_names.len(), skin_dir);
    
    Ok(skin)
}

/// 导出皮肤到指定目录
/// 生成 JSON 配置文件 + 图片文件（按表情名命名）
#[tauri::command]
#[allow(non_snake_case)]
fn export_skin(
    app: AppHandle,
    db: State<DbState>,
    skinId: String,
    exportDir: String,  // 导出目标目录
) -> Result<String, String> {
    use std::path::Path;
    use std::collections::HashMap;
    
    // 1. 获取皮肤信息
    let skin = db.get_skin_by_id(&skinId)
        .map_err(|e| format!("Failed to get skin: {}", e))?
        .ok_or_else(|| format!("Skin not found: {}", skinId))?;
    
    let moods = skin.moods.clone().unwrap_or_else(|| {
        vec!["normal".to_string(), "smile".to_string(), "angry".to_string(), "thinking".to_string()]
    });
    
    // 2. 创建导出目录（以皮肤名命名子目录）
    let export_path = Path::new(&exportDir).join(&skin.name);
    fs::create_dir_all(&export_path)
        .map_err(|e| format!("Failed to create export directory: {}", e))?;
    
    // 3. 构建 moods 映射并复制图片
    let mut moods_map: HashMap<String, String> = HashMap::new();
    
    if skin.is_builtin {
        // 内置皮肤：图片在应用资源目录 assets/
        // 开发模式：src-tauri/assets/
        // 生产模式：Resources/assets/
        let resource_path = app.path().resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        let assets_dir = resource_path.join("assets");
        
        // 开发模式下可能在 src-tauri/assets
        let dev_assets_dir = std::env::current_dir()
            .unwrap_or_default()
            .join("assets");
        
        for mood_name in moods.iter() {
            // 内置皮肤的图片命名格式：{SkinName}-{mood}.png
            let source_filename = format!("{}-{}.png", skin.name, mood_name);
            
            // 尝试生产路径
            let mut source_path = assets_dir.join(&source_filename);
            
            // 如果不存在，尝试开发路径
            if !source_path.exists() {
                source_path = dev_assets_dir.join(&source_filename);
            }
            
            let image_filename = format!("{}.png", mood_name);
            let dest_path = export_path.join(&image_filename);
            
            if source_path.exists() {
                fs::copy(&source_path, &dest_path)
                    .map_err(|e| format!("Failed to copy image {}: {}", mood_name, e))?;
                moods_map.insert(mood_name.clone(), image_filename);
            } else {
                println!("[Rust] Warning: Builtin image not found. Tried: {:?} and {:?}", 
                    assets_dir.join(&source_filename), 
                    dev_assets_dir.join(&source_filename));
            }
        }
    } else {
        // 自定义皮肤：图片在 skins_dir/{skinId}/
        let skins_dir = get_skins_dir(&app)?;
        let skin_dir = skins_dir.join(&skinId);
        let extensions = ["png", "gif", "jpg", "jpeg", "webp"];
        
        for (i, mood_name) in moods.iter().enumerate() {
            // 尝试各种扩展名找到图片文件
            let mut found = false;
            for ext in &extensions {
                let source_path = skin_dir.join(format!("{}.{}", i, ext));
                if source_path.exists() {
                    let image_filename = format!("{}.{}", mood_name, ext);
                    let dest_path = export_path.join(&image_filename);
                    
                    fs::copy(&source_path, &dest_path)
                        .map_err(|e| format!("Failed to copy image {}: {}", mood_name, e))?;
                    moods_map.insert(mood_name.clone(), image_filename);
                    found = true;
                    break;
                }
            }
            if !found {
                println!("[Rust] Warning: Custom image not found for mood '{}' at index {}", mood_name, i);
            }
        }
    }
    
    if moods_map.is_empty() {
        // 清理空目录
        let _ = fs::remove_dir_all(&export_path);
        return Err("No images found for this skin. Export aborted.".to_string());
    }
    
    // 4. 生成 JSON 配置文件
    #[derive(serde::Serialize)]
    struct ExportConfig {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        author: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        moods: HashMap<String, String>,
    }
    
    let config = ExportConfig {
        name: skin.name.clone(),
        author: skin.author.clone(),
        description: skin.description.clone(),
        moods: moods_map,
    };
    
    let json_path = export_path.join("skin.json");
    let json_content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    
    fs::write(&json_path, json_content)
        .map_err(|e| format!("Failed to write JSON file: {}", e))?;
    
    println!("[Rust] Skin exported: {} -> {:?}", skin.name, export_path);
    
    Ok(json_path.to_string_lossy().to_string())
}

/// 获取皮肤图片的本地文件路径（用于 convertFileSrc）
#[tauri::command]
#[allow(non_snake_case)]
fn get_skin_image_path(app: AppHandle, db: State<DbState>, skinId: String, mood: String) -> Result<String, String> {
    let skins_dir = get_skins_dir(&app)?;
    
    // 获取 skin 的 moods 数组，找到 mood 对应的索引
    let skin = db.get_skin_by_id(&skinId)
        .map_err(|e| format!("Failed to get skin: {}", e))?
        .ok_or_else(|| format!("Skin not found: {}", skinId))?;
    
    let index = if let Some(moods) = &skin.moods {
        moods.iter().position(|m| m == &mood)
            .ok_or_else(|| format!("Mood '{}' not found in skin moods", mood))?
    } else {
        // 向后兼容：如果没有 moods，使用默认映射
        let default_moods = ["normal", "smile", "angry", "thinking"];
        default_moods.iter().position(|m| *m == mood)
            .ok_or_else(|| format!("Mood '{}' not found in default moods", mood))?
    };
    
    // 支持多种图片格式
    let skin_dir = skins_dir.join(&skinId);
    let extensions = ["png", "gif", "jpg", "jpeg", "webp"];
    
    for ext in &extensions {
        let path = skin_dir.join(format!("{}.{}", index, ext));
        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
    }
    
    Err(format!("Skin image not found: {}/{}.{{png,gif,jpg,...}}", skinId, index))
}

/// 读取皮肤的指定表情图片（返回 base64，备用方案）
#[tauri::command]
#[allow(non_snake_case)]
fn read_skin_image(app: AppHandle, db: State<DbState>, skinId: String, mood: String) -> Result<String, String> {
    let skins_dir = get_skins_dir(&app)?;
    
    // 获取 skin 的 moods 数组，找到 mood 对应的索引
    let skin = db.get_skin_by_id(&skinId)
        .map_err(|e| format!("Failed to get skin: {}", e))?
        .ok_or_else(|| format!("Skin not found: {}", skinId))?;
    
    let index = if let Some(moods) = &skin.moods {
        moods.iter().position(|m| m == &mood)
            .ok_or_else(|| format!("Mood '{}' not found in skin moods", mood))?
    } else {
        // 向后兼容：如果没有 moods，使用默认映射
        let default_moods = ["normal", "smile", "angry", "thinking"];
        default_moods.iter().position(|m| *m == mood)
            .ok_or_else(|| format!("Mood '{}' not found in default moods", mood))?
    };
    
    // 支持多种图片格式
    let skin_dir = skins_dir.join(&skinId);
    let extensions = ["png", "gif", "jpg", "jpeg", "webp"];
    
    let mut image_path = None;
    let mut found_ext = "png";
    
    for ext in &extensions {
        let path = skin_dir.join(format!("{}.{}", index, ext));
        if path.exists() {
            image_path = Some(path);
            found_ext = ext;
            break;
        }
    }
    
    let image_path = image_path.ok_or_else(|| {
        format!("Skin image not found: {}/{}.{{png,gif,jpg,...}}", skinId, index)
    })?;
    
    let data = fs::read(&image_path)
        .map_err(|e| format!("Failed to read skin image: {}", e))?;
    
    // 根据扩展名设置正确的 MIME type
    let mime_type = match found_ext {
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    
    let base64_data = BASE64.encode(&data);
    Ok(format!("data:{};base64,{}", mime_type, base64_data))
}

/// 删除皮肤（包括数据库记录和图片文件）
#[tauri::command]
#[allow(non_snake_case)]
fn delete_skin_with_files(app: AppHandle, db: State<DbState>, id: String) -> Result<bool, String> {
    // 1. 删除数据库记录
    let deleted = db.delete_skin(&id).map_err(|e| e.to_string())?;
    
    if deleted {
        // 2. 删除图片目录
        let skins_dir = get_skins_dir(&app)?;
        let skin_dir = skins_dir.join(&id);
        if skin_dir.exists() {
            fs::remove_dir_all(&skin_dir)
                .map_err(|e| format!("Failed to remove skin dir: {}", e))?;
        }
    }
    
    Ok(deleted)
}

/// 获取皮肤图片存储目录
fn get_skins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let skins_dir = app_data_dir.join("skins");
    
    // 确保目录存在
    if !skins_dir.exists() {
        fs::create_dir_all(&skins_dir)
            .map_err(|e| format!("Failed to create skins dir: {}", e))?;
    }
    
    Ok(skins_dir)
}

/// 内置皮肤定义 - 这些皮肤的图片在前端 src/assets 中，不需要复制到文件系统
struct BuiltinSkin {
    name: &'static str,
    author: &'static str,
}

/// 初始化内置皮肤数据库记录（图片由前端处理，这里只创建数据库记录）
fn initialize_builtin_skins(db: &Database) {
    let builtin_skins = vec![
        BuiltinSkin { name: "Jules", author: "PetGPT Team" },
        BuiltinSkin { name: "Maodie", author: "PetGPT Team" },
        BuiltinSkin { name: "LittlePony", author: "JulesLiu390" },
    ];
    
    // 获取数据库中所有皮肤（包括隐藏的）
    let existing_skins = db.get_all_skins_with_hidden().unwrap_or_default();
    
    for builtin in &builtin_skins {
        // 检查是否已存在同名的内置皮肤
        let exists = existing_skins.iter().any(|s| s.name == builtin.name && s.is_builtin);
        
        if !exists {
            // 创建内置皮肤记录（不需要图片文件，前端会从 assets 加载）
            // 默认表情列表：normal, smile, angry, thinking
            let default_moods = vec!["normal".to_string(), "smile".to_string(), "angry".to_string(), "thinking".to_string()];
            match db.create_skin(skins::CreateSkinData {
                name: builtin.name.to_string(),
                author: Some(builtin.author.to_string()),
                description: Some(format!("Built-in {} skin", builtin.name)),
                is_builtin: true,
                moods: Some(default_moods),
            }) {
                Ok(skin) => {
                    println!("[Skins] Created builtin skin: {} (id: {})", builtin.name, skin.id);
                }
                Err(e) => {
                    eprintln!("[Skins] Failed to create builtin skin {}: {}", builtin.name, e);
                }
            }
        }
    }
}

// ============ MCP Server Commands ============

#[tauri::command]
fn get_mcp_servers(db: State<DbState>) -> Result<Vec<mcp_servers::McpServer>, String> {
    db.get_all_mcp_servers().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_mcp_server(db: State<DbState>, id: String) -> Result<Option<mcp_servers::McpServer>, String> {
    db.get_mcp_server_by_id(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_mcp_server_by_name(db: State<DbState>, name: String) -> Result<Option<mcp_servers::McpServer>, String> {
    db.get_mcp_server_by_name(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_mcp_server(db: State<DbState>, data: mcp_servers::CreateMcpServerData) -> Result<mcp_servers::McpServer, String> {
    db.create_mcp_server(data).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_mcp_server(db: State<DbState>, id: String, data: mcp_servers::UpdateMcpServerData) -> Result<Option<mcp_servers::McpServer>, String> {
    db.update_mcp_server(&id, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_mcp_server(db: State<DbState>, id: String) -> Result<bool, String> {
    db.delete_mcp_server(&id).map_err(|e| e.to_string())
}

// ============ MCP Runtime Commands ============

#[tauri::command]
async fn mcp_start_server(
    db: State<'_, DbState>,
    mcp: State<'_, McpState>,
    server_id: String,
) -> Result<ServerStatus, String> {
    // Get server config from database
    let server = db.get_mcp_server_by_id(&server_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    let manager = mcp.read().await;
    
    // Start based on transport type
    match server.transport {
        mcp_servers::TransportType::Http => {
            let url = server.url.ok_or_else(|| "HTTP server requires a URL".to_string())?;
            manager.start_http_server(
                &server.id,
                &server.name,
                &url,
                server.api_key,
            ).await
        }
        mcp_servers::TransportType::Stdio => {
            manager.start_server(
                &server.id,
                &server.name,
                &server.command,
                server.args.unwrap_or_default(),
                server.env.unwrap_or_default(),
            ).await
        }
    }
}

#[tauri::command]
async fn mcp_stop_server(
    mcp: State<'_, McpState>,
    server_id: String,
) -> Result<(), String> {
    let manager = mcp.read().await;
    manager.stop_server(&server_id).await
}

#[tauri::command]
async fn mcp_restart_server(
    db: State<'_, DbState>,
    mcp: State<'_, McpState>,
    server_id: String,
) -> Result<ServerStatus, String> {
    // Stop first
    {
        let manager = mcp.read().await;
        let _ = manager.stop_server(&server_id).await;
    }
    
    // Wait a bit
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    
    // Get server config and start again
    let server = db.get_mcp_server_by_id(&server_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    let manager = mcp.read().await;
    
    match server.transport {
        mcp_servers::TransportType::Http => {
            let url = server.url.ok_or_else(|| "HTTP server requires a URL".to_string())?;
            manager.start_http_server(
                &server.id,
                &server.name,
                &url,
                server.api_key,
            ).await
        }
        mcp_servers::TransportType::Stdio => {
            manager.start_server(
                &server.id,
                &server.name,
                &server.command,
                server.args.unwrap_or_default(),
                server.env.unwrap_or_default(),
            ).await
        }
    }
}

#[tauri::command]
async fn mcp_get_server_status(
    mcp: State<'_, McpState>,
    server_id: String,
) -> Result<Option<ServerStatus>, String> {
    let manager = mcp.read().await;
    Ok(manager.get_server_status(&server_id).await)
}

#[tauri::command]
async fn mcp_get_all_statuses(
    mcp: State<'_, McpState>,
) -> Result<Vec<ServerStatus>, String> {
    let manager = mcp.read().await;
    Ok(manager.get_all_statuses().await)
}

#[tauri::command]
async fn mcp_get_all_tools(
    mcp: State<'_, McpState>,
) -> Result<Vec<McpToolInfo>, String> {
    let manager = mcp.read().await;
    Ok(manager.get_all_tools().await)
}

#[tauri::command]
async fn mcp_call_tool(
    mcp: State<'_, McpState>,
    server_id: String,
    tool_name: String,
    arguments: Option<serde_json::Value>,
) -> Result<CallToolResponse, String> {
    let manager = mcp.read().await;
    manager.call_tool(&server_id, &tool_name, arguments).await
}

#[tauri::command]
async fn mcp_is_server_running(
    mcp: State<'_, McpState>,
    server_id: String,
) -> Result<bool, String> {
    let manager = mcp.read().await;
    Ok(manager.is_server_running(&server_id).await)
}

#[tauri::command]
async fn mcp_cancel_all_tool_calls(
    mcp: State<'_, McpState>,
) -> Result<(), String> {
    let manager = mcp.read().await;
    manager.cancel_all_tool_calls().await;
    Ok(())
}

#[tauri::command]
async fn mcp_reset_cancellation(
    mcp: State<'_, McpState>,
) -> Result<(), String> {
    let manager = mcp.read().await;
    manager.reset_cancellation().await;
    Ok(())
}

#[tauri::command]
async fn mcp_set_sampling_config(
    mcp: State<'_, McpState>,
    server_id: String,
    config: Option<SamplingLlmConfig>,
) -> Result<(), String> {
    let manager = mcp.read().await;
    manager.set_sampling_config(&server_id, config).await
}

#[tauri::command]
async fn mcp_test_server(
    transport: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    api_key: Option<String>,
) -> Result<ServerStatus, String> {
    // Create a temporary manager for testing
    let manager = McpManager::new();
    let test_id = format!("test-{}", uuid::Uuid::new_v4());
    
    let result = match transport.as_deref() {
        Some("http") => {
            let url = url.ok_or_else(|| "HTTP transport requires a URL".to_string())?;
            manager.start_http_server(
                &test_id,
                "Test Server",
                &url,
                api_key,
            ).await
        }
        _ => {
            let command = command.ok_or_else(|| "Stdio transport requires a command".to_string())?;
            manager.start_server(
                &test_id,
                "Test Server",
                &command,
                args.unwrap_or_default(),
                env.unwrap_or_default(),
            ).await
        }
    };
    
    // Always stop the test server
    let _ = manager.stop_server(&test_id).await;
    
    result
}

// ============ File Management Commands ============

use std::fs;
use std::path::PathBuf;

/// 获取上传文件的存储目录
fn get_uploads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let uploads_dir = app_data_dir.join("uploads");
    
    // 确保目录存在
    if !uploads_dir.exists() {
        fs::create_dir_all(&uploads_dir)
            .map_err(|e| format!("Failed to create uploads dir: {}", e))?;
    }
    
    Ok(uploads_dir)
}

#[derive(serde::Serialize)]
struct SaveFileResult {
    path: String,
    name: String,
}

#[tauri::command]
#[allow(non_snake_case)]
fn save_file(app: AppHandle, fileName: String, fileData: String, mimeType: String) -> Result<SaveFileResult, String> {
    let uploads_dir = get_uploads_dir(&app)?;
    
    // 生成唯一文件名（时间戳 + 原文件名）
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))?
        .as_millis();
    let unique_name = format!("{}_{}", timestamp, fileName);
    let file_path = uploads_dir.join(&unique_name);
    
    // 解码 base64 数据
    // fileData 格式可能是 "data:image/png;base64,XXXX" 或纯 base64
    let base64_data = if fileData.contains(",") {
        fileData.split(",").nth(1).unwrap_or(&fileData)
    } else {
        &fileData
    };
    
    let decoded = BASE64.decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
    
    // 写入文件
    fs::write(&file_path, decoded)
        .map_err(|e| format!("Failed to write file: {}", e))?;
    
    println!("[Rust] File saved: {:?}, mime: {}", file_path, mimeType);
    
    Ok(SaveFileResult {
        path: file_path.to_string_lossy().to_string(),
        name: unique_name,
    })
}

/// Copy a base64-encoded PNG image to the system clipboard
#[tauri::command]
#[allow(non_snake_case)]
fn copy_image_to_clipboard(app: AppHandle, base64Data: String) -> Result<(), String> {
    // Strip data URL prefix if present
    let raw = if base64Data.contains(",") {
        base64Data.split(",").nth(1).unwrap_or(&base64Data)
    } else {
        &base64Data
    };

    let decoded = BASE64.decode(raw)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // Use Tauri's Image type to create image from PNG bytes
    let img = Image::from_bytes(&decoded)
        .map_err(|e| format!("Failed to create image: {}", e))?;

    // Write to clipboard using the clipboard manager plugin
    app.clipboard().write_image(&img)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    println!("[Rust] Image copied to clipboard");
    Ok(())
}

/// Save a base64-encoded image to a user-chosen path
#[tauri::command]
#[allow(non_snake_case)]
fn save_image_to_path(filePath: String, base64Data: String) -> Result<(), String> {
    // Strip data URL prefix if present
    let raw = if base64Data.contains(",") {
        base64Data.split(",").nth(1).unwrap_or(&base64Data)
    } else {
        &base64Data
    };

    let decoded = BASE64.decode(raw)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    std::fs::write(&filePath, decoded)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    println!("[Rust] Image saved to: {}", filePath);
    Ok(())
}

// ============ Screenshot Commands ============

/// 截取全屏并打开选区窗口
/// 使用平台抽象层 (Platform) 截屏 + BMP 直写预览
#[tauri::command]
fn take_screenshot(app: AppHandle, db: State<DbState>, win_state: State<WinState>) -> Result<(), String> {
    println!("[Screenshot] Taking full screen capture...");
    let t0 = std::time::Instant::now();

    // 0. 读取设置：是否隐藏现有窗口
    let should_hide = db.get_setting("screenshot_hide_windows")
        .ok()
        .flatten()
        .map(|v| v.trim_matches('"') != "false")
        .unwrap_or(true);

    // 1. 根据设置决定是否隐藏所有 PetGPT 窗口
    let windows_to_hide = ["chat", "character", "manage"];
    let mut was_visible: Vec<(&str, bool)> = Vec::new();
    if should_hide {
        for label in &windows_to_hide {
            if let Some(win) = app.get_webview_window(label) {
                let visible = win.is_visible().unwrap_or(false);
                was_visible.push((label, visible));
                if visible {
                    let _ = win.hide();
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    let t1 = std::time::Instant::now();

    // 2. 平台截屏（返回原始 BGRA 数据，无格式转换）
    let screenshot_data = Platform::capture_screen()?;
    let width = screenshot_data.width;
    let height = screenshot_data.height;

    let t2 = std::time::Instant::now();
    println!("[Screenshot] Platform capture: {}ms, {}x{}, {} bytes BGRA",
        t2.duration_since(t1).as_millis(), width, height, screenshot_data.bgra.len());

    // 3. BMP 直写预览文件
    let preview_path = get_uploads_dir(&app)?.join("_screenshot_preview.bmp");
    Platform::write_preview(&screenshot_data, &preview_path)?;
    let preview_path_str = preview_path.to_string_lossy().to_string();

    let t3 = std::time::Instant::now();
    println!("[Screenshot] BMP write: {}ms", t3.duration_since(t2).as_millis());

    // 4. 缓存 BGRA 原始数据（capture_region 裁剪时再局部转 RGBA）
    {
        let mut cache = win_state.screenshot_cache.lock().unwrap();
        *cache = Some((screenshot_data.bgra, width, height));
    }

    // 5. 获取 scale factor 和逻辑尺寸
    let scale_factor = app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or_else(|| Platform::default_scale_factor());
    let logical_width = (width as f64 / scale_factor) as u32;
    let logical_height = (height as f64 / scale_factor) as u32;

    // 6. 显示 screenshot-prompt 窗口，发送文件路径
    if let Some(ss_win) = app.get_webview_window("screenshot-prompt") {
        let _ = ss_win.set_size(tauri::LogicalSize::new(logical_width, logical_height));
        let _ = ss_win.set_position(tauri::LogicalPosition::new(0, 0));
        let _ = ss_win.show();
        let _ = ss_win.set_focus();

        let _ = app.emit("screenshot-ready", serde_json::json!({
            "previewPath": preview_path_str,
            "width": width,
            "height": height,
            "logicalWidth": logical_width,
            "logicalHeight": logical_height,
            "scaleFactor": scale_factor,
        }));
    }

    // 7. 记住哪些窗口需要恢复
    {
        let mut pending = win_state.pending_restore_windows.lock().unwrap();
        *pending = was_visible.iter()
            .filter(|(_, v)| *v)
            .map(|(l, _)| l.to_string())
            .collect();
    }

    println!("[Screenshot] Total take_screenshot: {}ms", t0.elapsed().as_millis());
    Ok(())
}

/// 裁剪指定区域并返回结果（优化：直接使用缓存的 RGBA 数据，无需解码）
#[tauri::command]
fn capture_region(app: AppHandle, x: u32, y: u32, width: u32, height: u32, win_state: State<WinState>) -> Result<serde_json::Value, String> {
    println!("[Screenshot] Cropping region: ({}, {}) {}x{}", x, y, width, height);
    let t0 = std::time::Instant::now();

    // 1. 从缓存取出 BGRA 原始数据
    let (bgra_data, full_w, full_h) = {
        let cache = win_state.screenshot_cache.lock().unwrap();
        cache.clone().ok_or("No screenshot in cache")?
    };

    // 2. 裁剪区域（确保不越界）
    let crop_x = x.min(full_w.saturating_sub(1));
    let crop_y = y.min(full_h.saturating_sub(1));
    let crop_w = width.min(full_w - crop_x);
    let crop_h = height.min(full_h - crop_y);

    // 3. 从 BGRA 缓存中提取裁剪区域并转为 RGBA（仅转换裁剪区域，非全图）
    let stride = full_w as usize * 4;
    let mut rgba_cropped = Vec::with_capacity((crop_w * crop_h * 4) as usize);
    for row in 0..crop_h as usize {
        let src_y = crop_y as usize + row;
        let src_offset = src_y * stride + crop_x as usize * 4;
        for col in 0..crop_w as usize {
            let i = src_offset + col * 4;
            rgba_cropped.push(bgra_data[i + 2]); // R
            rgba_cropped.push(bgra_data[i + 1]); // G
            rgba_cropped.push(bgra_data[i]);     // B
            rgba_cropped.push(255);               // A
        }
    }

    // 4. 编码裁剪结果为 PNG
    let mut cropped_bytes = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut cropped_bytes);
        encoder.write_image(
            &rgba_cropped,
            crop_w,
            crop_h,
            image::ExtendedColorType::Rgba8,
        ).map_err(|e| format!("Failed to encode cropped PNG: {}", e))?;
    }

    // 5. 保存到 uploads 目录
    let uploads_dir = get_uploads_dir(&app)?;
    let file_name = format!("screenshot_{}.png", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let file_path = uploads_dir.join(&file_name);
    fs::write(&file_path, &cropped_bytes)
        .map_err(|e| format!("Failed to save screenshot: {}", e))?;

    // 6. 生成 base64 data URL
    let base64_data = format!("data:image/png;base64,{}", BASE64.encode(&cropped_bytes));

    // 7. 复制到剪贴板
    if let Ok(img) = Image::from_bytes(&cropped_bytes) {
        let _ = app.clipboard().write_image(&img);
        println!("[Screenshot] Copied to clipboard");
    }

    // 8. 隐藏 screenshot-prompt 窗口
    if let Some(ss_win) = app.get_webview_window("screenshot-prompt") {
        let _ = ss_win.hide();
    }

    // 9. 恢复之前隐藏的窗口
    {
        let labels = win_state.pending_restore_windows.lock().unwrap().clone();
        for label in labels {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.show();
            }
        }
        let mut pending = win_state.pending_restore_windows.lock().unwrap();
        pending.clear();
    }

    // 10. 清除截图缓存
    {
        let mut cache = win_state.screenshot_cache.lock().unwrap();
        *cache = None;
    }

    println!("[Screenshot] Region captured: {}x{}, saved to {} ({}ms)", 
        crop_w, crop_h, file_name, t0.elapsed().as_millis());

    Ok(serde_json::json!({
        "imageBase64": base64_data,
        "path": file_path.to_string_lossy(),
        "name": file_name,
    }))
}

/// 取消截图（隐藏窗口，恢复之前状态）
#[tauri::command]
fn cancel_screenshot(app: AppHandle, win_state: State<WinState>) -> Result<(), String> {
    // 隐藏 screenshot-prompt 窗口
    if let Some(ss_win) = app.get_webview_window("screenshot-prompt") {
        let _ = ss_win.hide();
    }

    // 恢复之前隐藏的窗口
    {
        let labels = win_state.pending_restore_windows.lock().unwrap().clone();
        for label in labels {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.show();
            }
        }
        let mut pending = win_state.pending_restore_windows.lock().unwrap();
        pending.clear();
    }

    // 清除截图缓存
    {
        let mut cache = win_state.screenshot_cache.lock().unwrap();
        *cache = None;
    }

    println!("[Screenshot] Cancelled");
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
fn read_upload(app: AppHandle, fileName: String) -> Result<String, String> {
    let uploads_dir = get_uploads_dir(&app)?;
    let file_path = uploads_dir.join(&fileName);
    
    if !file_path.exists() {
        return Err(format!("File not found: {}", fileName));
    }
    
    // 读取文件
    let data = fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    // 推测 mime 类型
    let mime_type = match file_path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    };
    
    // 编码为 base64 data URL
    let base64_data = BASE64.encode(&data);
    let data_url = format!("data:{};base64,{}", mime_type, base64_data);
    
    Ok(data_url)
}

#[tauri::command]
#[allow(non_snake_case)]
fn read_pet_image(app: AppHandle, fileName: String) -> Result<String, String> {
    // Pet 图片存储在 assets 目录或 uploads 目录
    let uploads_dir = get_uploads_dir(&app)?;
    let file_path = uploads_dir.join(&fileName);
    
    if file_path.exists() {
        return read_upload(app, fileName);
    }
    
    // 如果不在 uploads 目录，尝试其他可能的位置
    Err(format!("Pet image not found: {}", fileName))
}

#[tauri::command]
fn get_uploads_path(app: AppHandle) -> Result<String, String> {
    let uploads_dir = get_uploads_dir(&app)?;
    Ok(uploads_dir.to_string_lossy().to_string())
}

// ============ URL Download (bypass CORS) ============

#[derive(serde::Serialize)]
struct DownloadedImage {
    data: String,      // raw base64 (no data: prefix)
    mime_type: String,
}

/// Download a URL and return base64 data + mime_type.
/// Used by the frontend to fetch images from external servers (e.g. QQ)
/// that block browser cross-origin requests.
#[tauri::command]
async fn download_url_as_base64(url: String) -> Result<DownloadedImage, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", url, e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {}", resp.status(), url));
    }

    // Get content-type from response, fall back to image/jpeg
    let mime_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();

    let bytes = resp.bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let data = BASE64.encode(&bytes);

    Ok(DownloadedImage { data, mime_type })
}

// ============ Window Management Commands ============

#[tauri::command]
fn show_chat_window(app: AppHandle) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
        // Skip chat-follow sync for 500ms after showing, to prevent
        // spurious Moved events from snapping chat to character.
        let ws = app.state::<WinState>();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        ws.skip_chat_sync_until.store(now + 500, std::sync::atomic::Ordering::SeqCst);

        chat.show().map_err(|e| e.to_string())?;
        chat.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit("chat-window-vis-change", serde_json::json!({ "visible": true }));
    }
    Ok(())
}

#[tauri::command]
fn hide_chat_window(app: AppHandle) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
        // Prevent Moved events from snapping chat before hide completes
        let ws = app.state::<WinState>();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        ws.skip_chat_sync_until.store(now + 500, std::sync::atomic::Ordering::SeqCst);

        chat.hide().map_err(|e| e.to_string())?;
        let _ = app.emit("chat-window-vis-change", serde_json::json!({ "visible": false }));
    }
    Ok(())
}

#[tauri::command]
fn toggle_chat_window(app: AppHandle) -> Result<bool, String> {
    if let Some(chat) = app.get_webview_window("chat") {
        let is_visible = chat.is_visible().unwrap_or(false);
        if is_visible {
            // Prevent Moved events from snapping chat before hide completes
            let ws = app.state::<WinState>();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            ws.skip_chat_sync_until.store(now + 500, std::sync::atomic::Ordering::SeqCst);

            chat.hide().map_err(|e| e.to_string())?;
            let _ = app.emit("chat-window-vis-change", serde_json::json!({ "visible": false }));
            Ok(false)
        } else {
            // Skip chat-follow sync for 500ms after showing
            let ws = app.state::<WinState>();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            ws.skip_chat_sync_until.store(now + 500, std::sync::atomic::Ordering::SeqCst);

            chat.show().map_err(|e| e.to_string())?;
            chat.set_focus().map_err(|e| e.to_string())?;
            let _ = app.emit("chat-window-vis-change", serde_json::json!({ "visible": true }));
            Ok(true)
        }
    } else {
        Err("Chat window not found".to_string())
    }
}

#[tauri::command]
fn minimize_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.minimize().map_err(|e| e.to_string())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn maximize_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())
        } else {
            window.maximize().map_err(|e| e.to_string())
        }
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.hide().map_err(|e| e.to_string())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn set_window_always_on_top(app: AppHandle, label: String, always_on_top: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.set_always_on_top(always_on_top).map_err(|e| e.to_string())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn get_window_position(app: AppHandle, label: String) -> Result<(i32, i32), String> {
    if let Some(window) = app.get_webview_window(&label) {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let sf = window.scale_factor().unwrap_or(1.0);
        // Return logical coordinates for cross-platform consistency
        Ok(((pos.x as f64 / sf) as i32, (pos.y as f64 / sf) as i32))
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn set_window_position(app: AppHandle, label: String, x: f64, y: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn get_window_size(app: AppHandle, label: String) -> Result<(u32, u32), String> {
    if let Some(window) = app.get_webview_window(&label) {
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let sf = window.scale_factor().unwrap_or(1.0);
        // Return logical dimensions for cross-platform consistency
        Ok(((size.width as f64 / sf) as u32, (size.height as f64 / sf) as u32))
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn set_window_size(app: AppHandle, label: String, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn is_window_maximized(app: AppHandle, label: String) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.is_maximized().map_err(|e| e.to_string())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn is_window_visible(app: AppHandle, label: String) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.is_visible().map_err(|e| e.to_string())
    } else {
        Err(format!("Window {} not found", label))
    }
}

#[tauri::command]
fn get_platform_info() -> HashMap<String, String> {
    let mut info = HashMap::new();

    #[cfg(target_os = "macos")]
    {
        info.insert("platform".to_string(), "macos".to_string());
        info.insert("has_vibrancy".to_string(), "true".to_string());
        info.insert("has_cursor_tracking".to_string(), "true".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        info.insert("platform".to_string(), "linux".to_string());
        info.insert("has_vibrancy".to_string(), "false".to_string());
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
        let has_cursor = if session.contains("wayland") { "false" } else { "true" };
        info.insert("has_cursor_tracking".to_string(), has_cursor.to_string());
        info.insert("session_type".to_string(), session);
    }
    #[cfg(target_os = "windows")]
    {
        info.insert("platform".to_string(), "windows".to_string());
        info.insert("has_vibrancy".to_string(), "true".to_string());
        info.insert("has_cursor_tracking".to_string(), "true".to_string());
    }

    info
}

#[tauri::command]
fn get_screen_size(app: AppHandle) -> Result<(u32, u32), String> {
    if let Some(window) = app.get_webview_window("character") {
        if let Some(monitor) = window.current_monitor().ok().flatten() {
            let screen = screen_info_from_tauri_monitor(&monitor);
            // Return logical work-area dimensions
            return Ok((screen.work_area.width as u32, screen.work_area.height as u32));
        }
    }
    Err("Could not get screen size".to_string())
}

// Position character window at bottom-right of screen work area
fn position_character_window(app: &AppHandle) {
    if let Some(character) = app.get_webview_window("character") {
        if let Some(monitor) = character.current_monitor().ok().flatten() {
            let screen = screen_info_from_tauri_monitor(&monitor);
            let scale_factor = monitor.scale_factor();
            let char_size = character.outer_size().unwrap_or(tauri::PhysicalSize { width: 160, height: 240 });
            let char_w = char_size.width as f64 / scale_factor;
            let char_h = char_size.height as f64 / scale_factor;
            
            let (x, y) = window_layout::position_character_bottom_right(&screen, char_w, char_h);
            
            let _ = character.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            println!("Character window positioned at ({}, {}), work_area: {:?}", x, y, screen.work_area);
        }
    }
}

// 通用窗口切换函数
fn toggle_window(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| e.to_string())?;
            if label == "manage" {
                let _ = app.emit("manage-window-vis-change", serde_json::json!({ "visible": false }));
            }
        } else {
            // Position manage window at top-right before showing
            if label == "manage" {
                if let Some(monitor) = window.current_monitor().ok().flatten() {
                    let screen = screen_info_from_tauri_monitor(&monitor);
                    let sf = monitor.scale_factor();
                    let size = window.outer_size().unwrap_or(tauri::PhysicalSize { width: 640, height: 680 });
                    let w = size.width as f64 / sf;
                    let h = size.height as f64 / sf;
                    let (x, y) = window_layout::position_manage_center(&screen, w, h);
                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                }
            }
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            if label == "manage" {
                 let _ = app.emit("manage-window-vis-change", serde_json::json!({ "visible": true }));
            }
        }
    }
    Ok(())
}

// 打开设置/选择角色/MCP等页面（在chat窗口中导航）
fn navigate_chat_to(app: &AppHandle, route: &str) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
        // 显示chat窗口
        let _ = chat.show();
        let _ = chat.set_focus();
        
        // 导航到指定路由 (使用 hash routing)
        chat.eval(&format!("window.location.hash = '{}';", route))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_page_in_chat(app: AppHandle, route: String) -> Result<(), String> {
    navigate_chat_to(&app, &route)
}

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    // 兼容旧调用：打开 manage 窗口的 ui tab
    open_manage_window_with_tab(app, "ui".to_string()).map(|_| ())
}

#[tauri::command]
fn open_manage_window(app: AppHandle) -> Result<(), String> {
    toggle_window(&app, "manage")
}

#[tauri::command]
fn open_manage_window_with_tab(app: AppHandle, tab: String) -> Result<String, String> {
    println!("[open_manage_window_with_tab] Called with tab: {}", tab);
    if let Some(window) = app.get_webview_window("manage") {
        let is_visible = window.is_visible().unwrap_or(false);
        println!("[open_manage_window_with_tab] Window found, is_visible: {}", is_visible);
        
        if is_visible {
            // 窗口已可见，发送事件让前端决定是隐藏还是切换
            println!("[open_manage_window_with_tab] Emitting check_current_tab event with tab: {}", tab);
            match window.emit("check_current_tab", &tab) {
                Ok(_) => println!("[open_manage_window_with_tab] Event emitted successfully"),
                Err(e) => println!("[open_manage_window_with_tab] Failed to emit event: {}", e),
            }
            let _ = app.emit("manage-window-vis-change", serde_json::json!({ "visible": true }));
            Ok("visible".to_string())
        } else {
            // 窗口不可见，显示并导航到指定 tab
            println!("[open_manage_window_with_tab] Window not visible, showing and navigating to tab: {}", tab);
            let _ = window.eval(&format!("window.location.hash = '/manage?tab={}'", tab));
            // Position at top-right before showing
            if let Some(monitor) = window.current_monitor().ok().flatten() {
                let screen = screen_info_from_tauri_monitor(&monitor);
                let sf = monitor.scale_factor();
                let size = window.outer_size().unwrap_or(tauri::PhysicalSize { width: 640, height: 680 });
                let w = size.width as f64 / sf;
                let h = size.height as f64 / sf;
                let (x, y) = window_layout::position_manage_center(&screen, w, h);
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            }
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            let _ = app.emit("manage-window-vis-change", serde_json::json!({ "visible": true }));
            Ok("shown".to_string())
        }
    } else {
        println!("[open_manage_window_with_tab] Window not found!");
        Err("manage window not found".to_string())
    }
}

// 隐藏窗口 (用于关闭按钮)
#[tauri::command]
fn hide_manage_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("manage") {
        window.hide().map_err(|e| e.to_string())?;
        let _ = app.emit("manage-window-vis-change", serde_json::json!({ "visible": false }));
    }
    Ok(())
}

#[tauri::command]
fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    // 兼容旧调用：隐藏 manage 窗口
    hide_manage_window(app)
}





// 最大化/还原聊天窗口
#[tauri::command]
fn maximize_chat_window(app: AppHandle, win_state: State<WinState>) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
        let is_fullscreen = chat.is_fullscreen().unwrap_or(false);
        let is_maximized = chat.is_maximized().unwrap_or(false);
        
        if is_fullscreen || is_maximized {
            // 还原
            if is_fullscreen {
                chat.set_fullscreen(false).map_err(|e| e.to_string())?;
            } else {
                chat.unmaximize().map_err(|e| e.to_string())?;
            }
            chat.set_always_on_top(true).map_err(|e| e.to_string())?;
            
            // 恢复到保存的位置和大小（逻辑坐标）
            let saved_pos = win_state.saved_chat_position.lock().unwrap().take();
            let saved_size = win_state.saved_chat_size.lock().unwrap().take();
            
            if let Some((x, y)) = saved_pos {
                let _ = chat.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            }
            if let Some((w, h)) = saved_size {
                let _ = chat.set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }));
            }
            
            // 显示角色窗口
            if let Some(character) = app.get_webview_window("character") {
                let _ = character.show();
            }
        } else {
            // 保存当前位置和大小（转换为逻辑坐标）
            let sf = chat.scale_factor().unwrap_or(1.0);
            if let Ok(pos) = chat.outer_position() {
                *win_state.saved_chat_position.lock().unwrap() = Some((pos.x as f64 / sf, pos.y as f64 / sf));
            }
            if let Ok(size) = chat.outer_size() {
                *win_state.saved_chat_size.lock().unwrap() = Some((size.width as f64 / sf, size.height as f64 / sf));
            }
            
            // 最大化（不是全屏）
            chat.maximize().map_err(|e| e.to_string())?;
            chat.set_always_on_top(false).map_err(|e| e.to_string())?;
            
            // 隐藏角色窗口
            if let Some(character) = app.get_webview_window("character") {
                let _ = character.hide();
            }
        }
    }
    Ok(())
}

/// 偏好设置结构体
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    chat_follows_character: Option<bool>,
}

/// 更新偏好设置的全局状态
#[tauri::command]
fn update_preferences(preferences: Preferences, win_state: State<WinState>) -> Result<(), String> {
    if let Some(value) = preferences.chat_follows_character {
        win_state.chat_follows_character.store(value, Ordering::SeqCst);
        println!("[Rust] CHAT_FOLLOWS_CHARACTER updated to: {}", value);
    }
    Ok(())
}

#[tauri::command]
fn toggle_sidebar(app: AppHandle, expanded: bool, win_state: State<WinState>) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
        // 如果是最大化状态，不处理窗口大小
        if chat.is_maximized().unwrap_or(false) {
            return Ok(());
        }
        
        let sidebar_expanded = win_state.sidebar_expanded.load(Ordering::SeqCst);
        
        // 如果状态没有变化，不做任何操作
        if expanded == sidebar_expanded {
            return Ok(());
        }
        
        // 获取缩放因子
        let scale_factor = chat.scale_factor().unwrap_or(1.0);
        
        if let (Ok(pos), Ok(size)) = (chat.outer_position(), chat.outer_size()) {
            // 转换为逻辑坐标
            let logical_x = pos.x as f64 / scale_factor;
            let logical_y = pos.y as f64 / scale_factor;
            let logical_width = size.width as f64 / scale_factor;
            let logical_height = size.height as f64 / scale_factor;
            
            if expanded && !sidebar_expanded {
                // 保存展开前的原始宽度
                win_state.original_width.store(logical_width as u32, Ordering::SeqCst);
                
                let (new_x, new_width) = window_layout::sidebar_expand(logical_x, logical_width);
                
                let _ = chat.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: new_x, y: logical_y }));
                let _ = chat.set_size(tauri::Size::Logical(tauri::LogicalSize { width: new_width, height: logical_height }));
                
                win_state.sidebar_expanded.store(true, Ordering::SeqCst);
                let _ = chat.set_always_on_top(false);
            } else if !expanded && sidebar_expanded {
                let original_width = win_state.original_width.load(Ordering::SeqCst) as f64;
                
                let (new_x, new_width) = window_layout::sidebar_collapse(logical_x, original_width, logical_width);
                
                let _ = chat.set_size(tauri::Size::Logical(tauri::LogicalSize { width: new_width, height: logical_height }));
                let _ = chat.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: new_x, y: logical_y }));
                
                win_state.sidebar_expanded.store(false, Ordering::SeqCst);
                let _ = chat.set_always_on_top(true);
            }
        }
    }
    Ok(())
}

// ============ Window Size Preset ============

#[tauri::command]
fn update_window_size_preset(app: AppHandle, preset: String, win_state: State<WinState>) -> Result<(), String> {
    let scale = window_layout::get_scale_factor_for_preset(&preset);
    let baselines = window_layout::get_baseline_sizes();
    
    // Get screen work area using platform abstraction
    let screen = if let Some(window) = app.get_webview_window("character") {
        if let Some(monitor) = window.current_monitor().ok().flatten() {
            screen_info_from_tauri_monitor(&monitor)
        } else {
            // Fallback: create a default ScreenInfo
            Platform::screen_info_from_monitor((1920, 1080), (0, 0), 1.0)
        }
    } else {
        Platform::screen_info_from_monitor((1920, 1080), (0, 0), 1.0)
    };
    
    // Update character window - positioned at bottom-right of work area
    if let (Some(window), Some(baseline)) = (app.get_webview_window("character"), baselines.get("character")) {
        let width = (baseline.width * scale).round();
        let height = (baseline.height * scale).round();
        let (x, y) = window_layout::position_character_bottom_right(&screen, width, height);
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    }
    
    // Update chat window - positioned to the left of character
    if let (Some(chat), Some(character), Some(chat_baseline)) = 
        (app.get_webview_window("chat"), app.get_webview_window("character"), baselines.get("chat")) {
        let chat_width = (chat_baseline.width * scale).round();
        let chat_height = (chat_baseline.height * scale).round();
        
        // Skip if sidebar is expanded
        if !win_state.sidebar_expanded.load(Ordering::SeqCst) {
            if let Ok(char_pos) = character.outer_position() {
                let sf = character.scale_factor().unwrap_or(1.0);
                let char_logical_x = char_pos.x as f64 / sf;
                let char_logical_y = char_pos.y as f64 / sf;
                
                if let Ok(char_size) = character.outer_size() {
                    let char_logical_height = char_size.height as f64 / sf;
                    
                    let (x, y) = window_layout::position_chat_relative_to_character(
                        char_logical_x, char_logical_y, char_logical_height,
                        chat_width, chat_height,
                    );
                    let _ = chat.set_size(tauri::Size::Logical(tauri::LogicalSize { width: chat_width, height: chat_height }));
                    let _ = chat.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                }
            }
        }
    }
    
    // Update manage window
    if let (Some(window), Some(baseline)) = (app.get_webview_window("manage"), baselines.get("manage")) {
        let width = (baseline.width * scale).round();
        let height = (baseline.height * scale).round();
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
    }
    
    Ok(())
}

// ============ Global Shortcuts ============

use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[tauri::command]
fn update_shortcuts(app: AppHandle, shortcut1: String, shortcut2: String, shortcut3: String) -> Result<serde_json::Value, String> {
    // Unregister all existing shortcuts
    let _ = app.global_shortcut().unregister_all();
    
    let normalized1 = window_layout::normalize_shortcut(&shortcut1);
    let normalized2 = window_layout::normalize_shortcut(&shortcut2);
    let normalized3 = window_layout::normalize_shortcut(&shortcut3);
    
    log::info!("[Shortcuts] Registering: s1={} -> {}, s2={} -> {}, s3={} -> {}", shortcut1, normalized1, shortcut2, normalized2, shortcut3, normalized3);
    
    // On Linux/GNOME Wayland, use GNOME custom keybindings for truly global shortcuts.
    // X11 key grabs via XWayland don't work when a native Wayland surface has focus.
    #[cfg(target_os = "linux")]
    {
        if linux_shortcuts::is_gnome() {
            match linux_shortcuts::register_shortcuts(&normalized1, &normalized2, &normalized3) {
                Ok(_) => log::info!("[Shortcuts] Registered via GNOME custom keybindings"),
                Err(e) => log::error!("[Shortcuts] GNOME keybinding registration failed: {}", e),
            }
            // Return early on Linux/GNOME — don't register via Tauri global_shortcut
            // (which uses XGrabKey and doesn't work when unfocused on Wayland)
            return Ok(serde_json::json!({
                "success": true,
                "shortcuts": {
                    "shortcut1": shortcut1,
                    "shortcut2": shortcut2,
                    "shortcut3": shortcut3
                }
            }));
        }
    }

    // Register shortcut1: toggle character window visibility
    if !normalized1.is_empty() {
        if let Ok(shortcut) = normalized1.parse::<Shortcut>() {
            let app_handle = app.clone();
            let _ = app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state != ShortcutState::Pressed { return; }
                if let Some(window) = app_handle.get_webview_window("character") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
        } else {
            log::warn!("[Shortcuts] Failed to parse shortcut1: {}", normalized1);
        }
    }
    
    // Register shortcut2: toggle chat window visibility
    if !normalized2.is_empty() {
        if let Ok(shortcut) = normalized2.parse::<Shortcut>() {
            let app_handle = app.clone();
            let _ = app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                log::info!("[Shortcuts] Shortcut2 triggered (chat toggle)");
                if let Some(window) = app_handle.get_webview_window("chat") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
        } else {
            log::warn!("[Shortcuts] Failed to parse shortcut2: {}", normalized2);
        }
    }
    
    // Register shortcut3: take screenshot
    if !normalized3.is_empty() {
        if let Ok(shortcut) = normalized3.parse::<Shortcut>() {
            let app_handle = app.clone();
            let _ = app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                log::info!("[Shortcuts] Shortcut3 triggered (screenshot)");
                let db = app_handle.state::<DbState>();
                let ws = app_handle.state::<WinState>();
                if let Err(e) = take_screenshot(app_handle.clone(), db, ws) {
                    log::error!("[Shortcuts] Screenshot failed: {}", e);
                }
            });
        } else {
            log::warn!("[Shortcuts] Failed to parse shortcut3: {}", normalized3);
        }
    }
    
    log::info!("[Shortcuts] Registered: s1={}, s2={}, s3={}", normalized1, normalized2, normalized3);

    Ok(serde_json::json!({
        "success": true,
        "shortcuts": {
            "shortcut1": shortcut1,
            "shortcut2": shortcut2,
            "shortcut3": shortcut3
        }
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Initialize database
            let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
            let db_path = app_data_dir.join("petgpt.db");
            
            let db = Database::new(db_path).expect("Failed to initialize database");
            
            // Initialize built-in skins if they don't exist
            initialize_builtin_skins(&db);
            
            app.manage(Arc::new(db));

            // Initialize MCP manager
            let mcp_manager = Arc::new(tokio::sync::RwLock::new(McpManager::new()));
            app.manage(mcp_manager);

            // Initialize LLM client
            let llm_client: LlmState = Arc::new(LlmClient::new());
            app.manage(llm_client);

            // Initialize LLM stream cancellation manager
            let llm_cancellation: LlmCancelState = Arc::new(LlmStreamCancellation::new());
            app.manage(llm_cancellation);

            // Initialize tab message cache for in-memory message management (legacy)
            app.manage(TabMessageCache::new());
            
            // Initialize new tab state manager (Rust-owned state)
            app.manage(TabState::new());

            // Initialize workspace engine for file-based personality/memory
            let workspace_dir = app_data_dir.join("workspace");
            let workspace_engine: WorkspaceFileState = Arc::new(WorkspaceEngine::new(workspace_dir));
            app.manage(workspace_engine);

            // Initialize window state (replaces scattered static variables)
            let win_state: WinState = Arc::new(WindowState::new());
            app.manage(win_state.clone());

            // Apply window effect (vibrancy on macOS, Mica on Windows, no-op on Linux)
            if let Some(chat_window) = app.get_webview_window("chat") {
                let _ = Platform::apply_window_effect(
                    &chat_window,
                    &WindowEffect::Vibrancy { radius: 16.0 },
                );
            }

            // Emit platform info to frontend so it can adapt UI (opacity, hover, bg)
            {
                let platform_info = get_platform_info();
                let app_handle = app.handle().clone();
                // Emit after a short delay to ensure frontend listeners are ready
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = app_handle.emit("platform-info", platform_info);
                });
            }

            // Setup mouse hover detection (polls cursor position)
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut last_mouse_over_chat = false;
                    let mut last_mouse_over_character = false;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        
                        // Check chat window
                        if let Some(chat) = app_handle.get_webview_window("chat") {
                            if !chat.is_visible().unwrap_or(false) {
                                if last_mouse_over_chat {
                                    last_mouse_over_chat = false;
                                    let _ = chat.emit("mouse-over-chat", false);
                                }
                            } else if let Ok(cursor_pos) = chat.cursor_position() {
                                if let (Ok(window_pos), Ok(window_size)) = (chat.outer_position(), chat.outer_size()) {
                                    let is_mouse_over = window_layout::is_cursor_in_window(
                                        cursor_pos.x, cursor_pos.y,
                                        window_pos.x as f64, window_pos.y as f64,
                                        window_size.width as f64, window_size.height as f64,
                                    );
                                    if is_mouse_over != last_mouse_over_chat {
                                        last_mouse_over_chat = is_mouse_over;
                                        let _ = chat.emit("mouse-over-chat", is_mouse_over);
                                    }
                                }
                            }
                        }
                        
                        // Check character window
                        if let Some(character) = app_handle.get_webview_window("character") {
                            if let Ok(cursor_pos) = character.cursor_position() {
                                if let (Ok(window_pos), Ok(window_size)) = (character.outer_position(), character.outer_size()) {
                                    let is_mouse_over = window_layout::is_cursor_in_window(
                                        cursor_pos.x, cursor_pos.y,
                                        window_pos.x as f64, window_pos.y as f64,
                                        window_size.width as f64, window_size.height as f64,
                                    );
                                    if is_mouse_over != last_mouse_over_character {
                                        last_mouse_over_character = is_mouse_over;
                                        let _ = character.emit("mouse-over-character", is_mouse_over);
                                    }
                                }
                            }
                        }
                    }
                });
            }

            // Position character window at bottom-right
            position_character_window(app.handle());
            
            // Listen for character window move events to sync chat window position and bounce back if out of bounds
            let app_handle = app.handle().clone();
            if let Some(character) = app.get_webview_window("character") {
                character.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(_) = event {
                        if let Some(character) = app_handle.get_webview_window("character") {
                            // Skip all repositioning when the character window is hidden.
                            // On XWayland, hidden windows can still fire Moved events
                            // with stale/garbage positions, causing the window to "fly around."
                            if !character.is_visible().unwrap_or(true) {
                                return;
                            }

                            // Skip ALL repositioning during the grace period after hide/show toggle.
                            // This prevents clamp_to_work_area from overriding the restored position.
                            {
                                let ws = app_handle.state::<WinState>();
                                let now_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64;
                                let skip_until = ws.skip_chat_sync_until.load(Ordering::SeqCst);
                                if now_ms < skip_until {
                                    return;
                                }
                            }

                            // Get monitor info via platform abstraction
                            if let Some(monitor) = character.current_monitor().ok().flatten() {
                                let screen = screen_info_from_tauri_monitor(&monitor);
                                let sf = monitor.scale_factor();
                                
                                if let (Ok(char_pos), Ok(char_size)) = (character.outer_position(), character.outer_size()) {
                                    // Convert to logical coordinates
                                    let logical_x = char_pos.x as f64 / sf;
                                    let logical_y = char_pos.y as f64 / sf;
                                    let logical_w = char_size.width as f64 / sf;
                                    let logical_h = char_size.height as f64 / sf;
                                    
                                    // Clamp to work area using centralized function
                                    let (new_x, new_y, needs_reposition) = window_layout::clamp_to_work_area(
                                        &screen, logical_x, logical_y, logical_w, logical_h,
                                    );
                                    
                                    if needs_reposition {
                                        let _ = character.set_position(tauri::Position::Logical(
                                            tauri::LogicalPosition { x: new_x, y: new_y }
                                        ));
                                    }
                                    
                                    // Filter spurious Moved events: XWayland fires Moved on
                                    // focus change even when the window didn't actually move.
                                    // Only sync chat if character moved > 3 logical px.
                                    let ws = app_handle.state::<WinState>();
                                    let cur_x = (logical_x * 10.0) as i32;
                                    let cur_y = (logical_y * 10.0) as i32;
                                    let prev_x = ws.last_char_x.swap(cur_x, Ordering::SeqCst);
                                    let prev_y = ws.last_char_y.swap(cur_y, Ordering::SeqCst);
                                    let dx = (cur_x.saturating_sub(prev_x)).saturating_abs();
                                    let dy = (cur_y.saturating_sub(prev_y)).saturating_abs();
                                    // 30 = 3.0 logical px * 10 (fixed-point scale)
                                    let is_real_move = prev_x == i32::MIN || dx > 30 || dy > 30;

                                    if !is_real_move {
                                        return;
                                    }

                                    // Sync chat window position (only during active drag, not on spurious events)
                                    
                                    if !ws.sidebar_expanded.load(Ordering::SeqCst) && ws.chat_follows_character.load(Ordering::SeqCst) {
                                        if let Some(chat) = app_handle.get_webview_window("chat") {
                                            if !chat.is_visible().unwrap_or(false) {
                                                return;
                                            }
                                            
                                            if let Ok(chat_size) = chat.outer_size() {
                                                let chat_sf = chat.scale_factor().unwrap_or(sf);
                                                let chat_w = chat_size.width as f64 / chat_sf;
                                                let chat_h = chat_size.height as f64 / chat_sf;
                                                
                                                let final_x = if needs_reposition { new_x } else { logical_x };
                                                let final_y = if needs_reposition { new_y } else { logical_y };
                                                
                                                let (chat_x, chat_y) = window_layout::position_chat_relative_to_character(
                                                    final_x, final_y, logical_h,
                                                    chat_w, chat_h,
                                                );
                                                
                                                let _ = chat.set_position(tauri::Position::Logical(
                                                    tauri::LogicalPosition { x: chat_x, y: chat_y }
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }

            // Start Linux global-shortcut socket listener (GNOME custom keybindings IPC)
            #[cfg(target_os = "linux")]
            {
                if linux_shortcuts::is_gnome() {
                    if let Err(e) = linux_shortcuts::start_listener(app.handle().clone()) {
                        log::error!("[Setup] Failed to start Linux shortcut listener: {}", e);
                    }
                }
            }

            // Setup tray menu
            let chat_item = MenuItem::with_id(app, "chat", "Chat Window", true, None::<&str>)?;
            let api_item = MenuItem::with_id(app, "api", "API Management", true, None::<&str>)?;
            let assistants_item = MenuItem::with_id(app, "assistants", "Assistants", true, None::<&str>)?;
            let mcp_item = MenuItem::with_id(app, "mcp", "MCP Servers", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &chat_item,
                &api_item,
                &assistants_item,
                &mcp_item,
                &settings_item,
                &separator,
                &quit_item
            ])?;

            // Load dedicated tray icon (44x44, optimized for menu bar)
            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                .map_err(|e| format!("Failed to load tray icon: {}", e))?;

            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "chat" => {
                            // Open chat window
                            if let Some(chat) = app.get_webview_window("chat") {
                                let _ = chat.show();
                                let _ = chat.set_focus();
                            }
                        }
                        "api" | "assistants" | "mcp" | "settings" => {
                            let tab = event.id.as_ref();
                            if let Some(manage) = app.get_webview_window("manage") {
                                let _ = manage.eval(&format!("window.location.hash = '#/manage?tab={}'", tab));
                                // Center on screen before showing
                                if let Some(monitor) = manage.current_monitor().ok().flatten() {
                                    let screen = screen_info_from_tauri_monitor(&monitor);
                                    let sf = monitor.scale_factor();
                                    let size = manage.outer_size().unwrap_or(tauri::PhysicalSize { width: 640, height: 680 });
                                    let w = size.width as f64 / sf;
                                    let h = size.height as f64 / sf;
                                    let (x, y) = window_layout::position_manage_center(&screen, w, h);
                                    let _ = manage.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                                }
                                let _ = manage.show();
                                let _ = manage.set_focus();
                            }
                        }
                        "quit" => {
                            #[cfg(target_os = "linux")]
                            linux_shortcuts::cleanup();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Keep tray icon alive for the entire app lifetime (Windows drops it otherwise)
            app.manage(tray);

            // Register global shortcuts from DB at startup (don't depend on frontend)
            {
                let db = app.state::<DbState>();
                let s1 = db.get_setting("programHotkey")
                    .ok().flatten().unwrap_or_default()
                    .trim_matches('"').to_string();
                let s2 = db.get_setting("dialogHotkey")
                    .ok().flatten().unwrap_or_default()
                    .trim_matches('"').to_string();
                let s3 = db.get_setting("screenshotHotkey")
                    .ok().flatten().unwrap_or_default()
                    .trim_matches('"').to_string();

                let s1 = if s1.is_empty() { "Shift+Space".to_string() } else { s1 };
                let s2 = if s2.is_empty() { "Alt+Space".to_string() } else { s2 };

                if let Err(e) = update_shortcuts(app.handle().clone(), s1, s2, s3) {
                    log::error!("[Setup] Failed to register initial shortcuts: {:?}", e);
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Pet commands
            get_pets,
            get_pet,
            create_pet,
            update_pet,
            delete_pet,
            // Conversation commands
            get_conversations_by_pet,
            get_conversation,
            create_conversation,
            update_conversation_title,
            delete_conversation,
            get_orphan_conversations,
            transfer_conversation,
            transfer_all_conversations,
            search_conversations,
            // Message commands
            get_messages,
            create_message,
            clear_conversation_messages,
            // Settings commands
            get_setting,
            set_setting,
            get_all_settings,
            // API Provider commands
            get_api_providers,
            get_api_provider,
            update_api_provider,
            create_api_provider,
            delete_api_provider,
            // Skin commands
            get_skins,
            get_skins_with_hidden,
            get_skin,
            get_skin_by_name,
            create_skin,
            update_skin,
            delete_skin,
            hide_skin,
            restore_skin,
            import_skin,
            export_skin,
            get_skin_image_path,
            read_skin_image,
            delete_skin_with_files,
            // MCP Server commands (database)
            get_mcp_servers,
            get_mcp_server,
            get_mcp_server_by_name,
            create_mcp_server,
            update_mcp_server,
            delete_mcp_server,
            // MCP Runtime commands
            mcp_start_server,
            mcp_stop_server,
            mcp_restart_server,
            mcp_get_server_status,
            mcp_get_all_statuses,
            mcp_get_all_tools,
            mcp_call_tool,
            mcp_is_server_running,
            mcp_test_server,
            mcp_cancel_all_tool_calls,
            mcp_reset_cancellation,
            mcp_set_sampling_config,
            // File handling commands
            save_file,
            save_image_to_path,
            copy_image_to_clipboard,
            read_upload,
            get_uploads_path,
            download_url_as_base64,
            // Screenshot commands
            take_screenshot,
            capture_region,
            cancel_screenshot,
            // Window management commands
            show_chat_window,
            hide_chat_window,
            toggle_chat_window,
            minimize_window,
            maximize_window,
            close_window,
            set_window_always_on_top,
            get_window_position,
            set_window_position,
            get_window_size,
            set_window_size,
            is_window_maximized,
            is_window_visible,
            get_screen_size,
            get_platform_info,
            // Page navigation commands
            open_page_in_chat,
            open_settings_window,
            open_manage_window,
            open_manage_window_with_tab,
            // Hide window commands
            hide_manage_window,
            hide_settings_window,
            // Chat window controls
            maximize_chat_window,
            toggle_sidebar,
            update_preferences,
            // Window size and shortcuts
            update_window_size_preset,
            update_shortcuts,
            // Event broadcasting
            emit_to_all,
            get_pending_character_id,
            set_vibrancy_enabled,
            // Tab message cache commands (legacy)
            message_cache::get_tab_messages,
            message_cache::set_tab_messages,
            message_cache::add_tab_message,
            message_cache::update_tab_message,
            message_cache::delete_tab_message,
            message_cache::clear_tab_messages,
            message_cache::get_tab_messages_count,
            // New Tab State commands (Rust-owned)
            tab_state::get_tab_state,
            tab_state::init_tab_messages,
            tab_state::set_tab_state_messages,
            tab_state::push_tab_message,
            tab_state::update_tab_state_message,
            tab_state::delete_tab_state_message,
            tab_state::set_tab_thinking,
            tab_state::clear_tab_state,
            // LLM commands
            llm_call,
            llm_stream,
            llm_cancel_stream,
            llm_cancel_all_streams,
            llm_reset_cancellation,
            // Workspace commands
            workspace::workspace_read,
            workspace::workspace_write,
            workspace::workspace_edit,
            workspace::workspace_ensure_default_files,
            workspace::workspace_file_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
