use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;
use super::Database;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pet {
    #[serde(rename(serialize = "_id", deserialize = "id"))]
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub pet_type: Option<String>,
    pub model_name: Option<String>,
    pub model_url: Option<String>,
    pub model_api_key: Option<String>,
    pub model_config_id: Option<String>,
    pub api_format: Option<String>,
    pub system_instruction: Option<String>,
    pub appearance: Option<String>,
    pub has_mood: bool,
    #[serde(rename = "imageName")]
    pub icon: Option<String>,
    pub toolbar_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePetData {
    pub name: String,
    #[serde(rename = "type")]
    pub pet_type: Option<String>,
    pub model_name: Option<String>,
    pub model_url: Option<String>,
    pub model_api_key: Option<String>,
    pub model_config_id: Option<String>,
    pub api_format: Option<String>,
    pub system_instruction: Option<String>,
    pub appearance: Option<String>,
    pub has_mood: Option<bool>,
    #[serde(rename = "imageName")]
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePetData {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub pet_type: Option<String>,
    pub model_name: Option<String>,
    pub model_url: Option<String>,
    pub model_api_key: Option<String>,
    pub model_config_id: Option<String>,
    pub api_format: Option<String>,
    pub system_instruction: Option<String>,
    pub appearance: Option<String>,
    pub has_mood: Option<bool>,
    #[serde(rename = "imageName")]
    pub icon: Option<String>,
    pub toolbar_order: Option<i32>,
}

impl Database {
    pub fn get_all_pets(&self) -> Result<Vec<Pet>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, type, model_name, model_url, model_api_key, model_config_id,
                    api_format, system_instruction, appearance, has_mood, icon, 
                    toolbar_order, created_at, updated_at 
             FROM pets 
             WHERE is_deleted = 0 
             ORDER BY toolbar_order"
        )?;
        
        let pets = stmt.query_map([], |row| {
            Ok(Pet {
                id: row.get(0)?,
                name: row.get(1)?,
                pet_type: row.get(2)?,
                model_name: row.get(3)?,
                model_url: row.get(4)?,
                model_api_key: row.get(5)?,
                model_config_id: row.get(6)?,
                api_format: row.get(7)?,
                system_instruction: row.get(8)?,
                appearance: row.get(9)?,
                has_mood: row.get::<_, i32>(10)? != 0,
                icon: row.get(11)?,
                toolbar_order: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(pets)
    }

    pub fn get_pet_by_id(&self, id: &str) -> Result<Option<Pet>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, type, model_name, model_url, model_api_key, model_config_id,
                    api_format, system_instruction, appearance, has_mood, icon, 
                    toolbar_order, created_at, updated_at 
             FROM pets WHERE id = ?"
        )?;
        
        let mut rows = stmt.query(params![id])?;
        
        if let Some(row) = rows.next()? {
            Ok(Some(Pet {
                id: row.get(0)?,
                name: row.get(1)?,
                pet_type: row.get(2)?,
                model_name: row.get(3)?,
                model_url: row.get(4)?,
                model_api_key: row.get(5)?,
                model_config_id: row.get(6)?,
                api_format: row.get(7)?,
                system_instruction: row.get(8)?,
                appearance: row.get(9)?,
                has_mood: row.get::<_, i32>(10)? != 0,
                icon: row.get(11)?,
                toolbar_order: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn create_pet(&self, data: CreatePetData) -> Result<Pet> {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let has_mood = data.has_mood.unwrap_or(true);
        let pet_type = data.pet_type.clone().unwrap_or_else(|| "assistant".to_string());
        
        conn.execute(
            "INSERT INTO pets (id, name, type, model_name, model_url, model_api_key, 
                              model_config_id, api_format, system_instruction, appearance,
                              has_mood, icon, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id,
                data.name,
                pet_type,
                data.model_name,
                data.model_url,
                data.model_api_key,
                data.model_config_id,
                data.api_format,
                data.system_instruction,
                data.appearance,
                has_mood as i32,
                data.icon,
                now,
                now
            ],
        )?;
        
        Ok(Pet {
            id,
            name: data.name,
            pet_type: Some(pet_type),
            model_name: data.model_name,
            model_url: data.model_url,
            model_api_key: data.model_api_key,
            model_config_id: data.model_config_id,
            api_format: data.api_format,
            system_instruction: data.system_instruction,
            appearance: data.appearance,
            has_mood,
            icon: data.icon,
            toolbar_order: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn update_pet(&self, id: &str, data: UpdatePetData) -> Result<Option<Pet>> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        
        // Build dynamic UPDATE query
        let mut updates = vec!["updated_at = ?"];
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];
        
        if let Some(name) = &data.name {
            updates.push("name = ?");
            values.push(Box::new(name.clone()));
        }
        if let Some(pet_type) = &data.pet_type {
            updates.push("type = ?");
            values.push(Box::new(pet_type.clone()));
        }
        if let Some(model_name) = &data.model_name {
            updates.push("model_name = ?");
            values.push(Box::new(model_name.clone()));
        }
        if let Some(model_url) = &data.model_url {
            updates.push("model_url = ?");
            values.push(Box::new(model_url.clone()));
        }
        if let Some(model_api_key) = &data.model_api_key {
            updates.push("model_api_key = ?");
            values.push(Box::new(model_api_key.clone()));
        }
        if let Some(model_config_id) = &data.model_config_id {
            updates.push("model_config_id = ?");
            values.push(Box::new(model_config_id.clone()));
        }
        if let Some(api_format) = &data.api_format {
            updates.push("api_format = ?");
            values.push(Box::new(api_format.clone()));
        }
        if let Some(system_instruction) = &data.system_instruction {
            updates.push("system_instruction = ?");
            values.push(Box::new(system_instruction.clone()));
        }
        if let Some(appearance) = &data.appearance {
            updates.push("appearance = ?");
            values.push(Box::new(appearance.clone()));
        }
        if let Some(has_mood) = data.has_mood {
            updates.push("has_mood = ?");
            values.push(Box::new(has_mood as i32));
        }
        if let Some(icon) = &data.icon {
            updates.push("icon = ?");
            values.push(Box::new(icon.clone()));
        }
        if let Some(toolbar_order) = data.toolbar_order {
            updates.push("toolbar_order = ?");
            values.push(Box::new(toolbar_order));
        }
        
        values.push(Box::new(id.to_string()));
        
        let sql = format!(
            "UPDATE pets SET {} WHERE id = ?",
            updates.join(", ")
        );
        
        let params: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())?;
        
        drop(conn);
        self.get_pet_by_id(id)
    }

    pub fn delete_pet(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        // Soft delete: mark as deleted instead of removing
        let rows = conn.execute("UPDATE pets SET is_deleted = 1 WHERE id = ?", params![id])?;
        Ok(rows > 0)
    }
}
