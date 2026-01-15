mod database;
mod mcp;
mod message_cache;
mod tab_state;
mod llm;

use database::{Database, pets, conversations, messages, settings, mcp_servers, api_providers, skins};
use mcp::{McpManager, ServerStatus, McpToolInfo, CallToolResponse, ToolContent};
use message_cache::TabMessageCache;
use tab_state::TabState;
use llm::{LlmClient, LlmRequest, LlmResponse, StreamChunk, LlmStreamCancellation};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::collections::HashMap;
use tauri::{State, Manager, AppHandle, LogicalPosition, LogicalSize, Emitter};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;
use serde_json::Value as JsonValue;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

// Type alias for LLM client state
type LlmState = Arc<LlmClient>;

// Type alias for LLM stream cancellation state
type LlmCancelState = Arc<LlmStreamCancellation>;

// Type alias for MCP manager state
type McpState = Arc<tokio::sync::RwLock<McpManager>>;

#[allow(unused_imports)]
use tauri::WebviewWindow;

// Type alias for database state
type DbState = Arc<Database>;

// ============ Event Broadcasting ============

// 用于存储待处理的 character-id（当 chat 窗口还没准备好时）
use std::sync::Mutex;
lazy_static::lazy_static! {
    static ref PENDING_CHARACTER_ID: Mutex<Option<String>> = Mutex::new(None);
}

/// 广播事件到所有窗口
#[tauri::command]
fn emit_to_all(app: AppHandle, event: String, payload: JsonValue) -> Result<(), String> {
    // println!("[Rust] emit_to_all called: event={}, payload={:?}", event, payload);
    
    // 如果是 character-id 事件，存储到 pending
    if event == "character-id" {
        if let Some(id) = payload.as_str() {
            let mut pending = PENDING_CHARACTER_ID.lock().unwrap();
            *pending = Some(id.to_string());
            // println!("[Rust] Stored pending character-id: {}", id);
        }
    }
    
    // 尝试发送到每个已知窗口
    let windows = ["chat", "character", "manage"];
    for label in windows {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(e) = window.emit(&event, payload.clone()) {
                println!("[Rust] Failed to emit to {}: {:?}", label, e);
            }
        }
    }
    
    // 也用 app.emit 广播一次
    app.emit(&event, payload.clone()).map_err(|e| e.to_string())
}

/// 获取并清除待处理的 character-id
#[tauri::command]
fn get_pending_character_id() -> Option<String> {
    let mut pending = PENDING_CHARACTER_ID.lock().unwrap();
    pending.take()
}

/// 设置 chat 窗口的 vibrancy 效果（macOS only）
#[tauri::command]
fn set_vibrancy_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        
        if let Some(chat_window) = app.get_webview_window("chat") {
            if enabled {
                let _ = apply_vibrancy(
                    &chat_window, 
                    NSVisualEffectMaterial::FullScreenUI, 
                    Some(NSVisualEffectState::Active), 
                    Some(16.0)
                );
            } else {
                let _ = clear_vibrancy(&chat_window);
            }
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

// ============ Message Commands ============

#[tauri::command]
#[allow(non_snake_case)]
fn get_messages(db: State<DbState>, conversationId: String) -> Result<Vec<messages::Message>, String> {
    db.get_messages_by_conversation(&conversationId).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_message(db: State<DbState>, data: messages::CreateMessageData) -> Result<messages::Message, String> {
    db.create_message(data).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
fn clear_conversation_messages(db: State<DbState>, conversationId: String) -> Result<usize, String> {
    db.clear_conversation_messages(&conversationId).map_err(|e| e.to_string())
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

// ============ Window Management Commands ============

#[tauri::command]
fn show_chat_window(app: AppHandle) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
        // 显示窗口时不改变位置，保持原来的位置
        // 只有拖动角色时才会跟随移动（由 on_window_event 处理）
        chat.show().map_err(|e| e.to_string())?;
        chat.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit("chat-window-vis-change", serde_json::json!({ "visible": true }));
    }
    Ok(())
}

#[tauri::command]
fn hide_chat_window(app: AppHandle) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
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
            chat.hide().map_err(|e| e.to_string())?;
            let _ = app.emit("chat-window-vis-change", serde_json::json!({ "visible": false }));
            Ok(false)
        } else {
            // 显示窗口时不改变位置，保持原来的位置
            // 只有拖动角色时才会跟随移动（由 on_window_event 处理）
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
        Ok((pos.x, pos.y))
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
        Ok((size.width, size.height))
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
fn get_screen_size(app: AppHandle) -> Result<(u32, u32), String> {
    if let Some(window) = app.get_webview_window("character") {
        if let Some(monitor) = window.current_monitor().ok().flatten() {
            let size = monitor.size();
            return Ok((size.width, size.height));
        }
    }
    Err("Could not get screen size".to_string())
}

// Position character window at bottom-right of screen
fn position_character_window(app: &AppHandle) {
    if let Some(character) = app.get_webview_window("character") {
        if let Some(monitor) = character.current_monitor().ok().flatten() {
            let screen_size = monitor.size();
            let scale_factor = monitor.scale_factor();
            let char_size = character.outer_size().unwrap_or(tauri::PhysicalSize { width: 160, height: 240 });
            
            // 计算右下角位置，考虑 Dock 和菜单栏
            // macOS 通常 Dock 高度约 70px，留出边距
            let x = screen_size.width as i32 - char_size.width as i32 - (20.0 * scale_factor) as i32;
            let y = screen_size.height as i32 - char_size.height as i32 - (80.0 * scale_factor) as i32;
            
            let _ = character.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
            println!("Character window positioned at ({}, {}), screen: {:?}", x, y, screen_size);
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
fn maximize_chat_window(app: AppHandle) -> Result<(), String> {
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
            
            // 恢复到保存的位置和大小
            let saved_pos = SAVED_CHAT_POSITION.lock().unwrap().take();
            let saved_size = SAVED_CHAT_SIZE.lock().unwrap().take();
            
            if let Some((x, y)) = saved_pos {
                let _ = chat.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
            }
            if let Some((w, h)) = saved_size {
                let _ = chat.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }));
            }
            
            // 显示角色窗口
            if let Some(character) = app.get_webview_window("character") {
                let _ = character.show();
            }
        } else {
            // 保存当前位置和大小
            if let Ok(pos) = chat.outer_position() {
                *SAVED_CHAT_POSITION.lock().unwrap() = Some((pos.x, pos.y));
            }
            if let Ok(size) = chat.outer_size() {
                *SAVED_CHAT_SIZE.lock().unwrap() = Some((size.width, size.height));
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

// 侧边栏展开/收起 - 窗口向左扩展
const SIDEBAR_WIDTH: f64 = 256.0; // 与前端 w-64 (256px) 一致，使用逻辑像素
static SIDEBAR_EXPANDED: AtomicBool = AtomicBool::new(false);
// 保存展开前的原始宽度，用于收起时恢复
static ORIGINAL_WIDTH: AtomicU32 = AtomicU32::new(0);
// 聊天窗口是否跟随角色移动
static CHAT_FOLLOWS_CHARACTER: AtomicBool = AtomicBool::new(true);

// 保存最大化前的窗口位置和大小
lazy_static::lazy_static! {
    static ref SAVED_CHAT_POSITION: Mutex<Option<(i32, i32)>> = Mutex::new(None);
    static ref SAVED_CHAT_SIZE: Mutex<Option<(u32, u32)>> = Mutex::new(None);
}

/// 偏好设置结构体
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    chat_follows_character: Option<bool>,
}

/// 更新偏好设置的全局状态
#[tauri::command]
fn update_preferences(preferences: Preferences) -> Result<(), String> {
    if let Some(value) = preferences.chat_follows_character {
        CHAT_FOLLOWS_CHARACTER.store(value, Ordering::SeqCst);
        println!("[Rust] CHAT_FOLLOWS_CHARACTER updated to: {}", value);
    }
    Ok(())
}

#[tauri::command]
fn toggle_sidebar(app: AppHandle, expanded: bool) -> Result<(), String> {
    if let Some(chat) = app.get_webview_window("chat") {
        // 如果是最大化状态，不处理窗口大小
        if chat.is_maximized().unwrap_or(false) {
            return Ok(());
        }
        
        let sidebar_expanded = SIDEBAR_EXPANDED.load(Ordering::SeqCst);
        
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
                // 保存展开前的原始宽度（主体区域宽度）
                ORIGINAL_WIDTH.store(logical_width as u32, Ordering::SeqCst);
                
                // 展开侧边栏：窗口向左扩展，主体区域位置保持不变
                // 新窗口左边界 = 当前左边界 - 侧边栏宽度
                // 新窗口宽度 = 当前宽度 + 侧边栏宽度
                let new_x = logical_x - SIDEBAR_WIDTH;
                let new_width = logical_width + SIDEBAR_WIDTH;
                
                // 同时设置位置和大小，减少闪烁
                let _ = chat.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: new_x, y: logical_y }));
                let _ = chat.set_size(tauri::Size::Logical(tauri::LogicalSize { width: new_width, height: logical_height }));
                
                SIDEBAR_EXPANDED.store(true, Ordering::SeqCst);
                
                // 展开后变为普通窗口（不置顶）
                let _ = chat.set_always_on_top(false);
            } else if !expanded && sidebar_expanded {
                // 收起侧边栏：恢复到展开前的原始宽度
                let original_width = ORIGINAL_WIDTH.load(Ordering::SeqCst) as f64;
                // 如果没有保存过原始宽度（不应该发生），使用当前宽度减去侧边栏宽度
                let new_width = if original_width > 0.0 { original_width } else { logical_width - SIDEBAR_WIDTH };
                
                // 收起时：主体区域右边界保持不变
                // 新窗口左边界 = 当前左边界 + 侧边栏宽度
                let new_x = logical_x + SIDEBAR_WIDTH;
                
                // 同时设置位置和大小
                let _ = chat.set_size(tauri::Size::Logical(tauri::LogicalSize { width: new_width, height: logical_height }));
                let _ = chat.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: new_x, y: logical_y }));
                
                SIDEBAR_EXPANDED.store(false, Ordering::SeqCst);
                
                // 收起后恢复置顶
                let _ = chat.set_always_on_top(true);
            }
        }
    }
    Ok(())
}

// ============ Window Size Preset ============

// 定义各窗口的基准尺寸（以 medium 为标准，与 Electron 一致）
struct BaselineSize {
    width: f64,
    height: f64,
}

fn get_baseline_sizes() -> HashMap<&'static str, BaselineSize> {
    let mut sizes = HashMap::new();
    sizes.insert("character", BaselineSize { width: 200.0, height: 300.0 });
    sizes.insert("chat", BaselineSize { width: 500.0, height: 400.0 });
    sizes.insert("manage", BaselineSize { width: 640.0, height: 680.0 });
    sizes
}

fn get_scale_factor_for_preset(preset: &str) -> f64 {
    match preset {
        "small" => 0.9,
        "medium" => 1.0,
        "large" => 1.15,
        _ => 1.0,
    }
}

#[tauri::command]
fn update_window_size_preset(app: AppHandle, preset: String) -> Result<(), String> {
    let scale = get_scale_factor_for_preset(&preset);
    let baselines = get_baseline_sizes();
    
    // Get screen size
    let screen_size = if let Some(window) = app.get_webview_window("character") {
        if let Some(monitor) = window.current_monitor().ok().flatten() {
            let size = monitor.size();
            let sf = monitor.scale_factor();
            (size.width as f64 / sf, size.height as f64 / sf)
        } else {
            (1920.0, 1080.0)
        }
    } else {
        (1920.0, 1080.0)
    };
    
    // Update character window - positioned at bottom-right
    if let (Some(window), Some(baseline)) = (app.get_webview_window("character"), baselines.get("character")) {
        let width = (baseline.width * scale).round();
        let height = (baseline.height * scale).round();
        let x = screen_size.0 - width - 20.0;
        let y = screen_size.1 - height - 80.0; // Account for dock
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    }
    
    // Update chat window - positioned to the left of character
    if let (Some(chat), Some(character), Some(chat_baseline)) = 
        (app.get_webview_window("chat"), app.get_webview_window("character"), baselines.get("chat")) {
        let chat_width = (chat_baseline.width * scale).round();
        let chat_height = (chat_baseline.height * scale).round();
        
        // Skip if sidebar is expanded - let the sidebar logic handle sizing
        if !SIDEBAR_EXPANDED.load(Ordering::SeqCst) {
            if let Ok(char_pos) = character.outer_position() {
                let sf = character.scale_factor().unwrap_or(1.0);
                let char_logical_x = char_pos.x as f64 / sf;
                let char_logical_y = char_pos.y as f64 / sf;
                
                if let Ok(char_size) = character.outer_size() {
                    let char_logical_height = char_size.height as f64 / sf;
                    let x = char_logical_x - chat_width - 50.0;
                    let y = char_logical_y - chat_height + char_logical_height;
                    let _ = chat.set_size(tauri::Size::Logical(tauri::LogicalSize { width: chat_width, height: chat_height }));
                    let _ = chat.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: x.max(0.0), y: y.max(0.0) }));
                }
            }
        }
    }
    
    // Update manage window (unified settings window)
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
fn update_shortcuts(app: AppHandle, shortcut1: String, shortcut2: String) -> Result<serde_json::Value, String> {
    // Unregister all existing shortcuts
    let _ = app.global_shortcut().unregister_all();
    
    // Helper to convert cross-platform shortcut notation
    // Electron uses: shift+space, shift+ctrl+space
    // Tauri expects: Shift+Space, Control+Shift+Space
    fn normalize_shortcut(shortcut: &str) -> String {
        shortcut
            .split('+')
            .map(|part| {
                let lowered = part.trim().to_lowercase();
                match lowered.as_str() {
                    "ctrl" | "control" => "Control".to_string(),
                    "cmd" | "command" | "meta" => {
                        #[cfg(target_os = "macos")]
                        { "Command".to_string() }
                        #[cfg(not(target_os = "macos"))]
                        { "Control".to_string() }
                    },
                    "alt" | "option" => "Alt".to_string(),
                    "shift" => "Shift".to_string(),
                    "space" => "Space".to_string(),
                    "escape" | "esc" => "Escape".to_string(),
                    "enter" | "return" => "Enter".to_string(),
                    "tab" => "Tab".to_string(),
                    "backspace" => "Backspace".to_string(),
                    "delete" | "del" => "Delete".to_string(),
                    other => {
                        // Capitalize first letter for regular keys
                        let mut chars = other.chars();
                        match chars.next() {
                            Some(c) => c.to_uppercase().chain(chars).collect(),
                            None => String::new(),
                        }
                    }
                }
            })
            .collect::<Vec<_>>()
            .join("+")
    }
    
    let normalized1 = normalize_shortcut(&shortcut1);
    let normalized2 = normalize_shortcut(&shortcut2);
    
    log::info!("[Shortcuts] Registering: {} -> {}, {} -> {}", shortcut1, normalized1, shortcut2, normalized2);
    
    // Register shortcut1: toggle character window visibility
    if !normalized1.is_empty() {
        if let Ok(shortcut) = normalized1.parse::<Shortcut>() {
            let app_handle = app.clone();
            let _ = app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                // 只在按下时触发，忽略释放事件（避免触发两次）
                if event.state != ShortcutState::Pressed {
                    return;
                }
                log::info!("[Shortcuts] Shortcut1 triggered (character toggle)");
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
                // 只在按下时触发，忽略释放事件（避免触发两次）
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
    
    Ok(serde_json::json!({
        "success": true,
        "shortcuts": {
            "shortcut1": shortcut1,
            "shortcut2": shortcut2
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

            // Apply vibrancy effect to chat window only (macOS only)
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                
                if let Some(chat_window) = app.get_webview_window("chat") {
                    // 使用 FullScreenUI 材质，设置为 Active 状态以保持始终透明
                    // macOS 圆角：vibrancy 处理，前端不设置 border-radius
                    let _ = apply_vibrancy(
                        &chat_window, 
                        NSVisualEffectMaterial::FullScreenUI, 
                        Some(NSVisualEffectState::Active), 
                        Some(16.0)
                    );
                }
            }

            // Setup mouse hover detection for chat window (polls cursor position)
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut last_mouse_over_chat = false;
                    let mut last_mouse_over_character = false;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        
                        // Check chat window
                        if let Some(chat) = app_handle.get_webview_window("chat") {
                            // Only check if window is visible
                            if !chat.is_visible().unwrap_or(false) {
                                if last_mouse_over_chat {
                                    last_mouse_over_chat = false;
                                    let _ = chat.emit("mouse-over-chat", false);
                                }
                            } else {
                                // Get cursor position (desktop coordinates)
                                if let Ok(cursor_pos) = chat.cursor_position() {
                                    if let (Ok(window_pos), Ok(window_size)) = (chat.outer_position(), chat.outer_size()) {
                                        // Check if cursor is within window bounds
                                        let is_mouse_over = 
                                            cursor_pos.x >= window_pos.x as f64 &&
                                            cursor_pos.x <= (window_pos.x + window_size.width as i32) as f64 &&
                                            cursor_pos.y >= window_pos.y as f64 &&
                                            cursor_pos.y <= (window_pos.y + window_size.height as i32) as f64;
                                        
                                        // Only emit event when state changes
                                        if is_mouse_over != last_mouse_over_chat {
                                            last_mouse_over_chat = is_mouse_over;
                                            let _ = chat.emit("mouse-over-chat", is_mouse_over);
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Check character window
                        if let Some(character) = app_handle.get_webview_window("character") {
                            if let Ok(cursor_pos) = character.cursor_position() {
                                if let (Ok(window_pos), Ok(window_size)) = (character.outer_position(), character.outer_size()) {
                                    // Check if cursor is within window bounds
                                    let is_mouse_over = 
                                        cursor_pos.x >= window_pos.x as f64 &&
                                        cursor_pos.x <= (window_pos.x + window_size.width as i32) as f64 &&
                                        cursor_pos.y >= window_pos.y as f64 &&
                                        cursor_pos.y <= (window_pos.y + window_size.height as i32) as f64;
                                    
                                    // Only emit event when state changes
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
                            // Get monitor info for boundary checking
                            if let Some(monitor) = character.current_monitor().ok().flatten() {
                                let screen_size = monitor.size();
                                let screen_position = monitor.position();
                                let scale_factor = monitor.scale_factor();
                                
                                if let (Ok(char_pos), Ok(char_size)) = (character.outer_position(), character.outer_size()) {
                                    let mut new_x = char_pos.x;
                                    let mut new_y = char_pos.y;
                                    let mut needs_reposition = false;
                                    
                                    // Calculate screen boundaries (with some margin for visibility)
                                    let min_visible = (50.0 * scale_factor) as i32; // At least 50 logical pixels visible
                                    let menu_bar_height = (25.0 * scale_factor) as i32; // macOS menu bar
                                    let dock_height = (70.0 * scale_factor) as i32; // Approximate dock height
                                    
                                    let screen_left = screen_position.x;
                                    let screen_top = screen_position.y + menu_bar_height;
                                    let screen_right = screen_position.x + screen_size.width as i32;
                                    let screen_bottom = screen_position.y + screen_size.height as i32 - dock_height;
                                    
                                    // Check left boundary - ensure at least min_visible pixels are on screen
                                    if char_pos.x + (char_size.width as i32) < screen_left + min_visible {
                                        new_x = screen_left;
                                        needs_reposition = true;
                                    }
                                    // Check right boundary
                                    if char_pos.x > screen_right - min_visible {
                                        new_x = screen_right - (char_size.width as i32);
                                        needs_reposition = true;
                                    }
                                    // Check top boundary
                                    if char_pos.y < screen_top {
                                        new_y = screen_top;
                                        needs_reposition = true;
                                    }
                                    // Check bottom boundary
                                    if char_pos.y + (char_size.height as i32) > screen_bottom + min_visible {
                                        new_y = screen_bottom - (char_size.height as i32);
                                        needs_reposition = true;
                                    }
                                    
                                    // Reposition if out of bounds
                                    if needs_reposition {
                                        let _ = character.set_position(tauri::Position::Physical(
                                            tauri::PhysicalPosition { x: new_x, y: new_y }
                                        ));
                                    }
                                    
                                    // Sync chat window position (skip if sidebar is expanded or chat follows is disabled)
                                    if !SIDEBAR_EXPANDED.load(Ordering::SeqCst) && CHAT_FOLLOWS_CHARACTER.load(Ordering::SeqCst) {
                                        if let Some(chat) = app_handle.get_webview_window("chat") {
                                            // Skip if chat window is not visible
                                            if !chat.is_visible().unwrap_or(false) {
                                                return;
                                            }
                                            
                                            if let Ok(chat_size) = chat.outer_size() {
                                                // Use the corrected position
                                                let final_x = if needs_reposition { new_x } else { char_pos.x };
                                                let final_y = if needs_reposition { new_y } else { char_pos.y };
                                                
                                                // Calculate new chat position (to the left of character, bottom-aligned with offset)
                                                let char_bottom = final_y + char_size.height as i32;
                                                let chat_x = final_x - chat_size.width as i32 - 20; // 20px gap
                                                let chat_y = char_bottom - chat_size.height as i32 - 150; // Adjusted up by 150px
                                                
                                                let _ = chat.set_position(tauri::Position::Physical(
                                                    tauri::PhysicalPosition { x: chat_x.max(0), y: chat_y.max(0) }
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

            let _tray = TrayIconBuilder::new()
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
                        "api" => {
                            // Open API management (manage window with api tab)
                            if let Some(manage) = app.get_webview_window("manage") {
                                let _ = manage.eval("window.location.hash = '#/manage?tab=api'");
                                let _ = manage.show();
                                let _ = manage.set_focus();
                            }
                        }
                        "assistants" => {
                            // Open assistants selection (manage window with assistants tab)
                            if let Some(manage) = app.get_webview_window("manage") {
                                let _ = manage.eval("window.location.hash = '#/manage?tab=assistants'");
                                let _ = manage.show();
                                let _ = manage.set_focus();
                            }
                        }
                        "mcp" => {
                            // Open MCP servers (manage window with mcp tab)
                            if let Some(manage) = app.get_webview_window("manage") {
                                let _ = manage.eval("window.location.hash = '#/manage?tab=mcp'");
                                let _ = manage.show();
                                let _ = manage.set_focus();
                            }
                        }
                        "settings" => {
                            // Open settings (manage window with settings tab)
                            if let Some(manage) = app.get_webview_window("manage") {
                                let _ = manage.eval("window.location.hash = '#/manage?tab=settings'");
                                let _ = manage.show();
                                let _ = manage.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

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
            // File handling commands
            save_file,
            read_upload,
            get_uploads_path,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
