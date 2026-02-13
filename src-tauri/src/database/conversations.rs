use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;
use super::Database;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    #[serde(rename = "_id")]
    pub id: String,
    pub pet_id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub message_count: i32,
}

#[derive(Debug, Deserialize)]
pub struct CreateConversationData {
    #[serde(alias = "petId")]
    pub pet_id: String,
    pub title: Option<String>,
}

impl Database {
    pub fn get_conversations_by_pet(&self, pet_id: &str) -> Result<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.pet_id, c.title, c.created_at, c.updated_at, 
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
             FROM conversations c
             WHERE c.pet_id = ? 
             ORDER BY c.updated_at DESC"
        )?;
        
        let conversations = stmt.query_map(params![pet_id], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                pet_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(conversations)
    }

    pub fn get_conversation_by_id(&self, id: &str) -> Result<Option<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.pet_id, c.title, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
             FROM conversations c WHERE c.id = ?"
        )?;
        
        let mut rows = stmt.query(params![id])?;
        
        if let Some(row) = rows.next()? {
            let conv = Conversation {
                id: row.get(0)?,
                pet_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
            };
            println!("[Rust get_conversation_by_id] id={}, messageCount={}", conv.id, conv.message_count);
            Ok(Some(conv))
        } else {
            println!("[Rust get_conversation_by_id] id={} NOT FOUND", id);
            Ok(None)
        }
    }

    pub fn create_conversation(&self, data: CreateConversationData) -> Result<Conversation> {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        
        conn.execute(
            "INSERT INTO conversations (id, pet_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, data.pet_id, data.title, now, now],
        )?;
        
        Ok(Conversation {
            id,
            pet_id: data.pet_id,
            title: data.title,
            created_at: now.clone(),
            updated_at: now,
            message_count: 0,
        })
    }

    pub fn update_conversation_title(&self, id: &str, title: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let rows = conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            params![title, now, id],
        )?;
        Ok(rows > 0)
    }

    pub fn delete_conversation(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        // Delete messages first
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", params![id])?;
        // Delete conversation
        let rows = conn.execute("DELETE FROM conversations WHERE id = ?", params![id])?;
        Ok(rows > 0)
    }

    pub fn delete_conversations_by_pet(&self, pet_id: &str) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        // Get all conversation IDs for this pet
        let mut stmt = conn.prepare("SELECT id FROM conversations WHERE pet_id = ?")?;
        let conv_ids: Vec<String> = stmt
            .query_map(params![pet_id], |row| row.get(0))?
            .collect::<Result<Vec<_>>>()?;
        
        // Delete messages for each conversation
        for conv_id in &conv_ids {
            conn.execute("DELETE FROM messages WHERE conversation_id = ?", params![conv_id])?;
        }
        
        // Delete all conversations
        let rows = conn.execute("DELETE FROM conversations WHERE pet_id = ?", params![pet_id])?;
        Ok(rows)
    }

    /// 获取孤儿对话（关联的 pet 已被删除）
    pub fn get_orphan_conversations(&self) -> Result<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.pet_id, c.title, c.created_at, c.updated_at, 
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
             FROM conversations c
             LEFT JOIN pets p ON c.pet_id = p.id
             WHERE p.id IS NULL OR p.is_deleted = 1
             ORDER BY c.updated_at DESC"
        )?;
        
        let conversations = stmt.query_map([], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                pet_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get(5)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(conversations)
    }

    /// 将对话转移给新的 pet（接管功能）
    pub fn transfer_conversation(&self, conversation_id: &str, new_pet_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let rows = conn.execute(
            "UPDATE conversations SET pet_id = ?, updated_at = ? WHERE id = ?",
            params![new_pet_id, now, conversation_id],
        )?;
        Ok(rows > 0)
    }

    /// 批量转移某个 pet 的所有对话到新 pet
    pub fn transfer_all_conversations(&self, old_pet_id: &str, new_pet_id: &str) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let rows = conn.execute(
            "UPDATE conversations SET pet_id = ?, updated_at = ? WHERE pet_id = ?",
            params![new_pet_id, now, old_pet_id],
        )?;
        Ok(rows)
    }
}
