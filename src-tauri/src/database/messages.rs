use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use uuid::Uuid;
use super::Database;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    #[serde(rename = "_id")]
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub tool_call_history: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageData {
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub tool_call_history: Option<String>,
}

impl Database {
    pub fn get_messages_by_conversation(&self, conversation_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, tool_call_history, created_at 
             FROM messages 
             WHERE conversation_id = ? 
             ORDER BY created_at ASC"
        )?;
        
        let messages = stmt.query_map(params![conversation_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tool_call_history: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        Ok(messages)
    }

    pub fn create_message(&self, data: CreateMessageData) -> Result<Message> {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, tool_call_history, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                data.conversation_id,
                data.role,
                data.content,
                data.tool_call_history,
                now
            ],
        )?;
        
        // Update conversation's updated_at
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            params![now, data.conversation_id],
        )?;
        
        Ok(Message {
            id,
            conversation_id: data.conversation_id,
            role: data.role,
            content: data.content,
            tool_call_history: data.tool_call_history,
            created_at: now,
        })
    }

    pub fn delete_message(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute("DELETE FROM messages WHERE id = ?", params![id])?;
        Ok(rows > 0)
    }

    pub fn clear_conversation_messages(&self, conversation_id: &str) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?",
            params![conversation_id],
        )?;
        Ok(rows)
    }
}
