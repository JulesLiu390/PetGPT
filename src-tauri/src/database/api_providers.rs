use rusqlite::{params, Result, OptionalExtension};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;
use super::Database;

/// API Provider - 存储 API 服务配置
/// 作为"配置模板"，用户选择后将值复制到 Pet/Assistant
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiProvider {
    #[serde(rename(serialize = "_id", deserialize = "id"))]
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_format: String,
    pub is_validated: bool,
    pub cached_models: Option<String>,  // JSON array of model IDs
    pub hidden_models: Option<String>,  // JSON array of hidden model IDs
    pub created_at: String,
    pub updated_at: String,
}

/// 创建 API Provider 的数据
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiProviderData {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_format: Option<String>,
    pub cached_models: Option<String>,
    pub hidden_models: Option<String>,
}

/// 更新 API Provider 的数据
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApiProviderData {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub api_format: Option<String>,
    pub is_validated: Option<bool>,
    pub cached_models: Option<String>,
    pub hidden_models: Option<String>,
}

impl Database {
    /// 获取所有 API Providers
    pub fn get_all_api_providers(&self) -> Result<Vec<ApiProvider>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, base_url, api_key, api_format, is_validated, cached_models, 
                    hidden_models, created_at, updated_at 
             FROM api_providers 
             ORDER BY created_at DESC"
        )?;
        
        let providers = stmt.query_map([], |row| {
            Ok(ApiProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                api_key: row.get(3)?,
                api_format: row.get(4)?,
                is_validated: row.get::<_, i32>(5)? != 0,
                cached_models: row.get(6)?,
                hidden_models: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(providers)
    }

    /// 根据 ID 获取 API Provider
    pub fn get_api_provider_by_id(&self, id: &str) -> Result<Option<ApiProvider>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, base_url, api_key, api_format, is_validated, cached_models, 
                    hidden_models, created_at, updated_at 
             FROM api_providers 
             WHERE id = ?1"
        )?;
        
        let provider = stmt.query_row(params![id], |row| {
            Ok(ApiProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                api_key: row.get(3)?,
                api_format: row.get(4)?,
                is_validated: row.get::<_, i32>(5)? != 0,
                cached_models: row.get(6)?,
                hidden_models: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        }).optional()?;
        
        Ok(provider)
    }

    /// 创建新的 API Provider
    pub fn create_api_provider(&self, data: CreateApiProviderData) -> Result<ApiProvider> {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let api_format = data.api_format.unwrap_or_else(|| "openai_compatible".to_string());
        
        conn.execute(
            "INSERT INTO api_providers (id, name, base_url, api_key, api_format, is_validated, 
                                        cached_models, hidden_models, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9)",
            params![
                &id,
                &data.name,
                &data.base_url,
                &data.api_key,
                &api_format,
                &data.cached_models,
                &data.hidden_models,
                &now,
                &now
            ],
        )?;
        
        Ok(ApiProvider {
            id,
            name: data.name,
            base_url: data.base_url,
            api_key: data.api_key,
            api_format,
            is_validated: false,
            cached_models: data.cached_models,
            hidden_models: data.hidden_models,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// 更新 API Provider
    pub fn update_api_provider(&self, id: &str, data: UpdateApiProviderData) -> Result<Option<ApiProvider>> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        
        // 简化的更新逻辑：获取现有记录，合并更新
        let existing = {
            let mut stmt = conn.prepare(
                "SELECT id, name, base_url, api_key, api_format, is_validated, cached_models, 
                        hidden_models, created_at, updated_at 
                 FROM api_providers WHERE id = ?1"
            )?;
            stmt.query_row(params![id], |row| {
                Ok(ApiProvider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    base_url: row.get(2)?,
                    api_key: row.get(3)?,
                    api_format: row.get(4)?,
                    is_validated: row.get::<_, i32>(5)? != 0,
                    cached_models: row.get(6)?,
                    hidden_models: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            }).optional()?
        };
        
        let Some(existing) = existing else {
            return Ok(None);
        };
        
        // 更新字段
        let new_name = data.name.unwrap_or(existing.name.clone());
        let new_base_url = data.base_url.unwrap_or(existing.base_url.clone());
        let new_api_key = data.api_key.unwrap_or(existing.api_key.clone());
        let new_api_format = data.api_format.unwrap_or(existing.api_format.clone());
        
        // 如果提供了 is_validated，使用新值；
        // 如果没提供，但关键凭证(url/key)变了，重置为 false；否则保持原样
        let credentials_changed = new_base_url != existing.base_url || new_api_key != existing.api_key;
        let new_is_validated = if let Some(v) = data.is_validated {
            v
        } else if credentials_changed {
            false
        } else {
            existing.is_validated
        };
        
        let new_cached_models = data.cached_models.or(existing.cached_models.clone());
        let new_hidden_models = data.hidden_models.or(existing.hidden_models);
        
        conn.execute(
            "UPDATE api_providers 
             SET name = ?1, base_url = ?2, api_key = ?3, api_format = ?4, 
                 is_validated = ?5, cached_models = ?6, hidden_models = ?7, updated_at = ?8
             WHERE id = ?9",
            params![
                &new_name,
                &new_base_url,
                &new_api_key,
                &new_api_format,
                if new_is_validated { 1 } else { 0 },
                &new_cached_models,
                &new_hidden_models,
                &now,
                id
            ],
        )?;

        // 2. 如果凭证发生了变化，自动级联更新使用了该 Provider 的所有 Pets / Assistants
        if credentials_changed {
             // 更新所有使用旧 base_url 的 pets/assistants
             let json_pets_sql = "SELECT id, name, type, stats, created_at, updated_at, image_name, model_config_id, current_mood, api_format, model_url, model_name, model_api_key FROM pets";
             let mut stmt = conn.prepare(json_pets_sql)?;
             
             let pets_to_update: Vec<(String, String)> = stmt.query_map([], |row| {
                 let p_id: String = row.get(0)?;
                 let p_model_url: Option<String> = row.get(10)?;
                 if let Some(url) = p_model_url {
                     if url == existing.base_url {
                         return Ok(Some((p_id, url)));
                     }
                 }
                 Ok(None)
             })?
             .filter_map(|r| r.ok().flatten())
             .collect();

             for (p_id, _) in pets_to_update {
                 let _ = conn.execute(
                     "UPDATE pets SET model_url = ?1, model_api_key = ?2, updated_at = ?3 WHERE id = ?4",
                     params![&new_base_url, &new_api_key, &now, &p_id]
                 );
                 println!("Auto-updated pet {} with new credentials due to provider update", p_id);
             }
        }
        
        Ok(Some(ApiProvider {
            id: id.to_string(),
            name: new_name,
            base_url: new_base_url,
            api_key: new_api_key,
            api_format: new_api_format,
            is_validated: new_is_validated,
            cached_models: new_cached_models,
            hidden_models: new_hidden_models,
            created_at: existing.created_at,
            updated_at: now,
        }))
    }

    /// 删除 API Provider
    pub fn delete_api_provider(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows_affected = conn.execute(
            "DELETE FROM api_providers WHERE id = ?1",
            params![id],
        )?;
        Ok(rows_affected > 0)
    }

    /// 更新 API Provider 的模型缓存
    pub fn update_api_provider_models(&self, id: &str, models: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        
        let rows_affected = conn.execute(
            "UPDATE api_providers SET cached_models = ?1, updated_at = ?2 WHERE id = ?3",
            params![models, &now, id],
        )?;
        
        Ok(rows_affected > 0)
    }

    /// 标记 API Provider 已验证
    pub fn set_api_provider_validated(&self, id: &str, validated: bool) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        
        let rows_affected = conn.execute(
            "UPDATE api_providers SET is_validated = ?1, updated_at = ?2 WHERE id = ?3",
            params![if validated { 1 } else { 0 }, &now, id],
        )?;
        
        Ok(rows_affected > 0)
    }
}
