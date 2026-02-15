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

    /// 搜索对话：同时匹配标题和消息内容
    /// 返回 (标题匹配的对话, 内容匹配的对话+消息片段)
    pub fn search_conversations(&self, query: &str) -> Result<Vec<SearchResult>> {
        let conn = self.conn.lock().unwrap();
        let like_pattern = format!("%{}%", query);

        // 1) 标题匹配
        let mut title_stmt = conn.prepare(
            "SELECT c.id, c.pet_id, c.title, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
             FROM conversations c
             LEFT JOIN pets p ON c.pet_id = p.id
             WHERE (p.is_deleted IS NULL OR p.is_deleted = 0)
               AND c.title LIKE ?1
             ORDER BY c.updated_at DESC
             LIMIT 20"
        )?;

        let title_matches: Vec<SearchResult> = title_stmt.query_map(params![like_pattern], |row| {
            Ok(SearchResult {
                conversation: Conversation {
                    id: row.get(0)?,
                    pet_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    message_count: row.get(5)?,
                },
                match_type: "title".to_string(),
                snippet: None,
                message_role: None,
            })
        })?.collect::<Result<Vec<_>>>()?;

        // 2) 消息内容匹配（排除已在标题匹配中的对话）
        let title_matched_ids: Vec<String> = title_matches.iter().map(|r| r.conversation.id.clone()).collect();
        
        // 构建排除条件
        let exclude_clause = if title_matched_ids.is_empty() {
            String::new()
        } else {
            let placeholders: Vec<String> = title_matched_ids.iter().enumerate()
                .map(|(i, _)| format!("?{}", i + 2))
                .collect();
            format!(" AND c.id NOT IN ({})", placeholders.join(","))
        };

        let content_sql = format!(
            "SELECT DISTINCT c.id, c.pet_id, c.title, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = c.id) as message_count,
                    m.content, m.role
             FROM messages m
             JOIN conversations c ON m.conversation_id = c.id
             LEFT JOIN pets p ON c.pet_id = p.id
             WHERE (p.is_deleted IS NULL OR p.is_deleted = 0)
               AND m.content LIKE ?1
               {}
             GROUP BY c.id
             ORDER BY c.updated_at DESC
             LIMIT 20",
            exclude_clause
        );

        let mut content_stmt = conn.prepare(&content_sql)?;
        
        // 构建参数列表
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        param_values.push(Box::new(like_pattern.clone()));
        for id in &title_matched_ids {
            param_values.push(Box::new(id.clone()));
        }
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

        let content_matches: Vec<SearchResult> = content_stmt.query_map(
            params_refs.as_slice(),
            |row| {
                let content: String = row.get(6)?;
                let role: String = row.get(7)?;
                // 提取关键词周围的片段（前后各 40 字符）
                let snippet = extract_snippet(&content, query, 40);
                Ok(SearchResult {
                    conversation: Conversation {
                        id: row.get(0)?,
                        pet_id: row.get(1)?,
                        title: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        message_count: row.get(5)?,
                    },
                    match_type: "content".to_string(),
                    snippet: Some(snippet),
                    message_role: Some(role),
                })
            }
        )?.collect::<Result<Vec<_>>>()?;

        let mut results = title_matches;
        results.extend(content_matches);
        Ok(results)
    }
}

/// 搜索结果
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub conversation: Conversation,
    pub match_type: String,       // "title" | "content"
    pub snippet: Option<String>,  // 消息内容片段（仅 content 匹配时）
    pub message_role: Option<String>, // 消息角色（仅 content 匹配时）
}

/// 从内容中提取关键词周围的片段
fn extract_snippet(content: &str, query: &str, context_chars: usize) -> String {
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();
    
    if let Some(pos) = lower_content.find(&lower_query) {
        let start = if pos > context_chars { pos - context_chars } else { 0 };
        let end = std::cmp::min(pos + query.len() + context_chars, content.len());
        
        // 确保不切断 UTF-8 字符
        let safe_start = content.floor_char_boundary(start);
        let safe_end = content.ceil_char_boundary(end);
        
        let mut snippet = String::new();
        if safe_start > 0 { snippet.push_str("…"); }
        snippet.push_str(&content[safe_start..safe_end]);
        if safe_end < content.len() { snippet.push_str("…"); }
        snippet
    } else {
        // 没找到匹配（不应该发生），返回前80字符
        let end = std::cmp::min(80, content.len());
        let safe_end = content.ceil_char_boundary(end);
        let mut s = content[..safe_end].to_string();
        if safe_end < content.len() { s.push_str("…"); }
        s
    }
}
