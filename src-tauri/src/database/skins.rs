use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;
use super::Database;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skin {
    pub id: String,
    pub name: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub is_builtin: bool,
    pub is_hidden: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkinData {
    pub name: String,
    pub author: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub is_builtin: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSkinData {
    pub name: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
}

impl Database {
    /// Get all visible skins (not hidden)
    pub fn get_all_skins(&self) -> Result<Vec<Skin>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, author, description, is_builtin, is_hidden, created_at, updated_at 
             FROM skins 
             WHERE is_hidden = 0
             ORDER BY is_builtin DESC, created_at DESC"
        )?;
        
        let skins = stmt.query_map([], |row| {
            Ok(Skin {
                id: row.get(0)?,
                name: row.get(1)?,
                author: row.get(2)?,
                description: row.get(3)?,
                is_builtin: row.get::<_, i32>(4)? != 0,
                is_hidden: row.get::<_, i32>(5)? != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(skins)
    }

    /// Get all skins including hidden ones
    pub fn get_all_skins_with_hidden(&self) -> Result<Vec<Skin>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, author, description, is_builtin, is_hidden, created_at, updated_at 
             FROM skins 
             ORDER BY is_builtin DESC, created_at DESC"
        )?;
        
        let skins = stmt.query_map([], |row| {
            Ok(Skin {
                id: row.get(0)?,
                name: row.get(1)?,
                author: row.get(2)?,
                description: row.get(3)?,
                is_builtin: row.get::<_, i32>(4)? != 0,
                is_hidden: row.get::<_, i32>(5)? != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(skins)
    }

    pub fn get_skin_by_id(&self, id: &str) -> Result<Option<Skin>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, author, description, is_builtin, is_hidden, created_at, updated_at 
             FROM skins WHERE id = ?"
        )?;
        
        let mut rows = stmt.query(params![id])?;
        
        if let Some(row) = rows.next()? {
            Ok(Some(Skin {
                id: row.get(0)?,
                name: row.get(1)?,
                author: row.get(2)?,
                description: row.get(3)?,
                is_builtin: row.get::<_, i32>(4)? != 0,
                is_hidden: row.get::<_, i32>(5)? != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn create_skin(&self, data: CreateSkinData) -> Result<Skin> {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        
        conn.execute(
            "INSERT INTO skins (id, name, author, description, is_builtin, is_hidden, created_at, updated_at) 
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
            params![id, data.name, data.author, data.description, data.is_builtin as i32, now, now],
        )?;
        
        Ok(Skin {
            id,
            name: data.name,
            author: data.author,
            description: data.description,
            is_builtin: data.is_builtin,
            is_hidden: false,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn update_skin(&self, id: &str, data: UpdateSkinData) -> Result<Option<Skin>> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        
        // 构建动态更新语句
        let mut updates = vec!["updated_at = ?1".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];
        let mut param_index = 2;
        
        if let Some(ref name) = data.name {
            updates.push(format!("name = ?{}", param_index));
            params_vec.push(Box::new(name.clone()));
            param_index += 1;
        }
        if let Some(ref author) = data.author {
            updates.push(format!("author = ?{}", param_index));
            params_vec.push(Box::new(author.clone()));
            param_index += 1;
        }
        if let Some(ref description) = data.description {
            updates.push(format!("description = ?{}", param_index));
            params_vec.push(Box::new(description.clone()));
            param_index += 1;
        }
        
        params_vec.push(Box::new(id.to_string()));
        
        let sql = format!(
            "UPDATE skins SET {} WHERE id = ?{}",
            updates.join(", "),
            param_index
        );
        
        let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, params_refs.as_slice())?;
        
        drop(conn);
        self.get_skin_by_id(id)
    }

    /// Hide a builtin skin (soft delete)
    pub fn hide_skin(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "UPDATE skins SET is_hidden = 1, updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id]
        )?;
        Ok(affected > 0)
    }

    /// Restore a hidden builtin skin
    pub fn restore_skin(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "UPDATE skins SET is_hidden = 0, updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id]
        )?;
        Ok(affected > 0)
    }

    /// Delete a skin - only works for non-builtin skins
    /// For builtin skins, use hide_skin instead
    pub fn delete_skin(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        
        // Check if it's a builtin skin
        let is_builtin: i32 = conn.query_row(
            "SELECT is_builtin FROM skins WHERE id = ?",
            params![id],
            |row| row.get(0)
        ).unwrap_or(0);
        
        if is_builtin != 0 {
            // For builtin skins, just hide instead of delete
            drop(conn);
            return self.hide_skin(id);
        }
        
        let affected = conn.execute("DELETE FROM skins WHERE id = ?", params![id])?;
        Ok(affected > 0)
    }
}
