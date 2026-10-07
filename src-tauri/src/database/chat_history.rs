// chat_history.rs — QQ 群聊历史消息存储与查询
//
// 提供两类查询：
//   1. chat_search: FTS5 全文搜索 + 多维度过滤
//   2. chat_context: 给定 message_id，返回前后 N 条同群消息

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use super::Database;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub message_id: String,
    pub target_id: String,
    pub target_type: String,
    pub sender_id: String,
    pub content: String,
    pub timestamp: i64,        // 毫秒
    pub reply_to_id: Option<String>,
    pub is_bot: bool,
    pub raw_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertChatMessageData {
    pub message_id: String,
    pub target_id: String,
    pub target_type: String,
    pub sender_id: String,
    pub content: String,
    pub timestamp: i64,
    pub reply_to_id: Option<String>,
    pub is_bot: bool,
    pub raw_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchParams {
    pub keywords: String,         // 必填
    pub sender: Option<String>,
    pub target: Option<String>,
    pub start_ts: Option<i64>,    // 毫秒，由 JS 端解析时间字符串后传入
    pub end_ts: Option<i64>,
    pub sort: Option<String>,     // "relevance" | "newest" | "oldest"
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchResult {
    pub messages: Vec<ChatMessage>,
    pub total: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextResult {
    pub before: Vec<ChatMessage>,
    pub anchor: Option<ChatMessage>,
    pub after: Vec<ChatMessage>,
}

impl Database {
    /// 初始化 chat_history 表 + FTS5 虚拟表（在 Database::new 中调用）
    pub fn init_chat_history(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // 主表。message_id 只在一个会话里唯一：QQ 的是全局大整数，Telegram 的是
        // 每个 chat 各自从 1 数起的小整数，私聊的 #61 和别的私聊的 #61 是两条消息。
        // 所以主键必须带上 target_id。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_history (
                message_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                target_type TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                content TEXT,
                timestamp INTEGER NOT NULL,
                reply_to_id TEXT,
                is_bot INTEGER NOT NULL DEFAULT 0,
                raw_json TEXT,
                PRIMARY KEY (target_id, message_id)
            )",
            [],
        )?;
        migrate_composite_key(&conn)?;

        // 索引
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_target_time ON chat_history(target_id, timestamp DESC)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_sender_time ON chat_history(sender_id, timestamp DESC)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_reply_to ON chat_history(reply_to_id)",
            [],
        );

        // FTS5 虚拟表（contentless 模式 — 通过 rowid 关联到主表）
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chat_history_fts USING fts5(
                content,
                content='chat_history',
                content_rowid='rowid',
                tokenize='unicode61'
            )",
            [],
        )?;

        // 触发器：保持 FTS5 同步
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS chat_history_ai AFTER INSERT ON chat_history BEGIN
                INSERT INTO chat_history_fts(rowid, content) VALUES (new.rowid, new.content);
            END",
            [],
        )?;
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS chat_history_ad AFTER DELETE ON chat_history BEGIN
                INSERT INTO chat_history_fts(chat_history_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            END",
            [],
        )?;
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS chat_history_au AFTER UPDATE ON chat_history BEGIN
                INSERT INTO chat_history_fts(chat_history_fts, rowid, content) VALUES('delete', old.rowid, old.content);
                INSERT INTO chat_history_fts(rowid, content) VALUES (new.rowid, new.content);
            END",
            [],
        )?;

        Ok(())
    }

    /// 插入一条消息（去重：同一会话里 message_id 冲突时忽略）
    pub fn insert_chat_message(&self, msg: &InsertChatMessageData) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "INSERT OR IGNORE INTO chat_history
                (message_id, target_id, target_type, sender_id, content, timestamp, reply_to_id, is_bot, raw_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                msg.message_id,
                msg.target_id,
                msg.target_type,
                msg.sender_id,
                msg.content,
                msg.timestamp,
                msg.reply_to_id,
                if msg.is_bot { 1 } else { 0 },
                msg.raw_json,
            ],
        )?;
        Ok(rows > 0)
    }

    /// 批量插入（一个事务），返回成功插入数（已存在的不计）
    pub fn insert_chat_messages_batch(&self, msgs: &[InsertChatMessageData]) -> Result<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut inserted = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO chat_history
                    (message_id, target_id, target_type, sender_id, content, timestamp, reply_to_id, is_bot, raw_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for m in msgs {
                let rows = stmt.execute(params![
                    m.message_id,
                    m.target_id,
                    m.target_type,
                    m.sender_id,
                    m.content,
                    m.timestamp,
                    m.reply_to_id,
                    if m.is_bot { 1 } else { 0 },
                    m.raw_json,
                ])?;
                if rows > 0 { inserted += 1; }
            }
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// chat_search 主查询
    pub fn chat_search(&self, p: &ChatSearchParams) -> Result<ChatSearchResult> {
        let conn = self.conn.lock().unwrap();

        // keywords 必填
        let keywords = p.keywords.trim();
        if keywords.is_empty() {
            return Ok(ChatSearchResult { messages: vec![], total: 0 });
        }

        let mut where_clauses: Vec<String> = Vec::new();
        let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // FTS5 JOIN
        where_clauses.push("chat_history.rowid = chat_history_fts.rowid".to_string());
        where_clauses.push("chat_history_fts MATCH ?".to_string());
        sql_params.push(Box::new(keywords.to_string()));

        // sender
        if let Some(sender) = &p.sender {
            if !sender.trim().is_empty() {
                where_clauses.push("sender_id = ?".to_string());
                sql_params.push(Box::new(sender.clone()));
            }
        }

        // target
        if let Some(target) = &p.target {
            if !target.trim().is_empty() && target != "all" {
                where_clauses.push("target_id = ?".to_string());
                sql_params.push(Box::new(target.clone()));
            }
        }

        // time range
        if let Some(start) = p.start_ts {
            where_clauses.push("timestamp >= ?".to_string());
            sql_params.push(Box::new(start));
        }
        if let Some(end) = p.end_ts {
            where_clauses.push("timestamp <= ?".to_string());
            sql_params.push(Box::new(end));
        }

        let where_sql = format!("WHERE {}", where_clauses.join(" AND "));

        // 排序
        let sort_sql = match p.sort.as_deref() {
            Some("oldest") => "ORDER BY chat_history.timestamp ASC".to_string(),
            Some("newest") => "ORDER BY chat_history.timestamp DESC".to_string(),
            _ => "ORDER BY chat_history_fts.rank ASC".to_string(), // 默认 relevance
        };

        let limit = p.limit.unwrap_or(20).max(1).min(200);

        let sql = format!(
            "SELECT chat_history.message_id, chat_history.target_id, chat_history.target_type,
                    chat_history.sender_id, chat_history.content, chat_history.timestamp,
                    chat_history.reply_to_id, chat_history.is_bot, chat_history.raw_json
             FROM chat_history, chat_history_fts
             {}
             {}
             LIMIT {}",
            where_sql, sort_sql, limit
        );

        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = sql_params.iter().map(|p| p.as_ref()).collect();
        let messages: Vec<ChatMessage> = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok(ChatMessage {
                    message_id: row.get(0)?,
                    target_id: row.get(1)?,
                    target_type: row.get(2)?,
                    sender_id: row.get(3)?,
                    content: row.get(4)?,
                    timestamp: row.get(5)?,
                    reply_to_id: row.get(6)?,
                    is_bot: row.get::<_, i64>(7)? != 0,
                    raw_json: row.get(8)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let total = messages.len();
        Ok(ChatSearchResult { messages, total })
    }

    /// chat_context: 给定 message_id，取前后 N 条同群消息
    ///
    /// `target_id` 给了就只在那个会话里找锚点——Telegram 的 message_id 跨会话会重号。
    /// 不给（或那个会话里没有）就退回全表找最新的一条，兼容只知道 ID 的调用。
    pub fn chat_context(
        &self,
        message_id: &str,
        target_id: Option<&str>,
        before: i64,
        after: i64,
    ) -> Result<ChatContextResult> {
        let conn = self.conn.lock().unwrap();

        // 1. 找锚点
        let find_anchor = |target: Option<&str>| -> Option<(String, i64)> {
            conn.query_row(
                "SELECT target_id, timestamp FROM chat_history
                 WHERE message_id = ?1 AND (?2 IS NULL OR target_id = ?2)
                 ORDER BY timestamp DESC LIMIT 1",
                params![message_id, target],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .ok()
        };
        let target = target_id.map(str::trim).filter(|t| !t.is_empty());
        let anchor = find_anchor(target).or_else(|| target.and_then(|_| find_anchor(None)));

        let (target_id, anchor_ts) = match anchor {
            Some(v) => v,
            None => return Ok(ChatContextResult { before: vec![], anchor: None, after: vec![] }),
        };

        // 2. 锚点完整数据
        let anchor_msg: Option<ChatMessage> = conn
            .query_row(
                "SELECT message_id, target_id, target_type, sender_id, content, timestamp, reply_to_id, is_bot, raw_json
                 FROM chat_history WHERE target_id = ? AND message_id = ?",
                params![target_id, message_id],
                |row| Ok(ChatMessage {
                    message_id: row.get(0)?,
                    target_id: row.get(1)?,
                    target_type: row.get(2)?,
                    sender_id: row.get(3)?,
                    content: row.get(4)?,
                    timestamp: row.get(5)?,
                    reply_to_id: row.get(6)?,
                    is_bot: row.get::<_, i64>(7)? != 0,
                    raw_json: row.get(8)?,
                }),
            )
            .ok();

        // 3. 取 before（同群，timestamp < anchor_ts，倒序取 N 条，再正序）
        let mut before_msgs: Vec<ChatMessage> = Vec::new();
        if before > 0 {
            let mut stmt = conn.prepare(
                "SELECT message_id, target_id, target_type, sender_id, content, timestamp, reply_to_id, is_bot, raw_json
                 FROM chat_history
                 WHERE target_id = ? AND timestamp < ?
                 ORDER BY timestamp DESC LIMIT ?",
            )?;
            let rows = stmt.query_map(params![target_id, anchor_ts, before], |row| {
                Ok(ChatMessage {
                    message_id: row.get(0)?,
                    target_id: row.get(1)?,
                    target_type: row.get(2)?,
                    sender_id: row.get(3)?,
                    content: row.get(4)?,
                    timestamp: row.get(5)?,
                    reply_to_id: row.get(6)?,
                    is_bot: row.get::<_, i64>(7)? != 0,
                    raw_json: row.get(8)?,
                })
            })?;
            for r in rows {
                if let Ok(m) = r { before_msgs.push(m); }
            }
        }
        before_msgs.reverse(); // 改为正序（旧→新）

        // 4. 取 after
        let mut after_msgs: Vec<ChatMessage> = Vec::new();
        if after > 0 {
            let mut stmt = conn.prepare(
                "SELECT message_id, target_id, target_type, sender_id, content, timestamp, reply_to_id, is_bot, raw_json
                 FROM chat_history
                 WHERE target_id = ? AND timestamp > ?
                 ORDER BY timestamp ASC LIMIT ?",
            )?;
            let rows = stmt.query_map(params![target_id, anchor_ts, after], |row| {
                Ok(ChatMessage {
                    message_id: row.get(0)?,
                    target_id: row.get(1)?,
                    target_type: row.get(2)?,
                    sender_id: row.get(3)?,
                    content: row.get(4)?,
                    timestamp: row.get(5)?,
                    reply_to_id: row.get(6)?,
                    is_bot: row.get::<_, i64>(7)? != 0,
                    raw_json: row.get(8)?,
                })
            })?;
            for r in rows {
                if let Ok(m) = r { after_msgs.push(m); }
            }
        }

        Ok(ChatContextResult { before: before_msgs, anchor: anchor_msg, after: after_msgs })
    }
}

/// 旧库的主键只有 message_id，换成 (target_id, message_id)。
///
/// SQLite 改不了主键，只能重建表。rowid 原样搬过去：FTS5 是 external content
/// 表，靠 rowid 对回主表，rowid 不变索引就不用重建。触发器挂在旧表上，随旧表
/// 一起删掉，init_chat_history 后面会按 IF NOT EXISTS 重新建。
///
/// 旧主键下被 INSERT OR IGNORE 吞掉的那些消息已经找不回来了，这里只保证以后不再丢。
fn migrate_composite_key(conn: &rusqlite::Connection) -> Result<()> {
    let pk_cols: Vec<String> = {
        let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('chat_history') WHERE pk > 0 ORDER BY pk")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if pk_cols != ["message_id"] {
        return Ok(());
    }

    let result = conn.execute_batch(
        "BEGIN;
         CREATE TABLE chat_history_migrating (
             message_id TEXT NOT NULL,
             target_id TEXT NOT NULL,
             target_type TEXT NOT NULL,
             sender_id TEXT NOT NULL,
             content TEXT,
             timestamp INTEGER NOT NULL,
             reply_to_id TEXT,
             is_bot INTEGER NOT NULL DEFAULT 0,
             raw_json TEXT,
             PRIMARY KEY (target_id, message_id)
         );
         INSERT OR IGNORE INTO chat_history_migrating
             (rowid, message_id, target_id, target_type, sender_id, content, timestamp, reply_to_id, is_bot, raw_json)
             SELECT rowid, message_id, target_id, target_type, sender_id, content, timestamp, reply_to_id, is_bot, raw_json
             FROM chat_history;
         DROP TABLE chat_history;
         ALTER TABLE chat_history_migrating RENAME TO chat_history;
         CREATE INDEX IF NOT EXISTS idx_chat_target_time ON chat_history(target_id, timestamp DESC);
         CREATE INDEX IF NOT EXISTS idx_chat_sender_time ON chat_history(sender_id, timestamp DESC);
         CREATE INDEX IF NOT EXISTS idx_chat_reply_to ON chat_history(reply_to_id);
         COMMIT;",
    );
    if result.is_err() {
        // 中途失败别把连接留在半个事务里，旧表原样保留
        let _ = conn.execute_batch("ROLLBACK;");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn msg(id: &str, target: &str, ts: i64, content: &str) -> InsertChatMessageData {
        InsertChatMessageData {
            message_id: id.into(),
            target_id: target.into(),
            target_type: "friend".into(),
            sender_id: "u".into(),
            content: content.into(),
            timestamp: ts,
            reply_to_id: None,
            is_bot: false,
            raw_json: None,
        }
    }

    fn db_with(conn: rusqlite::Connection) -> Database {
        let db = Database { conn: Mutex::new(conn) };
        db.init_chat_history().unwrap();
        db
    }

    #[test]
    fn the_same_message_id_in_two_chats_is_two_rows() {
        let db = db_with(rusqlite::Connection::open_in_memory().unwrap());
        let n = db
            .insert_chat_messages_batch(&[msg("61", "@alice", 1, "hi"), msg("61", "-100123:7", 2, "yo")])
            .unwrap();
        assert_eq!(n, 2);
        // 同一会话里重复的还是要去重
        assert!(!db.insert_chat_message(&msg("61", "@alice", 1, "hi")).unwrap());
    }

    #[test]
    fn chat_context_finds_the_anchor_in_the_given_chat() {
        let db = db_with(rusqlite::Connection::open_in_memory().unwrap());
        db.insert_chat_messages_batch(&[
            msg("60", "@alice", 1, "before"),
            msg("61", "@alice", 2, "anchor-alice"),
            msg("61", "@bob", 9, "anchor-bob"),
        ])
        .unwrap();

        let r = db.chat_context("61", Some("@alice"), 5, 5).unwrap();
        assert_eq!(r.anchor.unwrap().content, "anchor-alice");
        assert_eq!(r.before.len(), 1);

        // 不给 target 就取最新的那条；给了个没有这条消息的 target 也退回全表
        assert_eq!(db.chat_context("61", None, 0, 0).unwrap().anchor.unwrap().content, "anchor-bob");
        assert_eq!(db.chat_context("61", Some("@carol"), 0, 0).unwrap().anchor.unwrap().content, "anchor-bob");
    }

    #[test]
    fn an_old_single_key_table_is_migrated_and_search_still_works() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // 旧版建表 + 旧版触发器，原样照抄
        conn.execute_batch(
            "CREATE TABLE chat_history (
                message_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, target_type TEXT NOT NULL,
                sender_id TEXT NOT NULL, content TEXT, timestamp INTEGER NOT NULL,
                reply_to_id TEXT, is_bot INTEGER NOT NULL DEFAULT 0, raw_json TEXT);
             CREATE VIRTUAL TABLE chat_history_fts USING fts5(content, content='chat_history', content_rowid='rowid', tokenize='unicode61');
             CREATE TRIGGER chat_history_ai AFTER INSERT ON chat_history BEGIN
                 INSERT INTO chat_history_fts(rowid, content) VALUES (new.rowid, new.content);
             END;
             INSERT INTO chat_history (message_id, target_id, target_type, sender_id, content, timestamp)
                 VALUES ('5', 'g1', 'group', 'u', 'hello pelican', 1), ('6', 'g1', 'group', 'u', 'other', 2);",
        )
        .unwrap();

        let db = db_with(conn);
        {
            let conn = db.conn.lock().unwrap();
            let pk: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info('chat_history') WHERE pk > 0 ORDER BY pk").unwrap()
                .query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
            assert_eq!(pk, ["target_id", "message_id"]);
        }

        // 旧数据在、旧数据能搜到（rowid 没变，FTS 对得上）
        let search = |kw: &str| db.chat_search(&ChatSearchParams {
            keywords: kw.into(), sender: None, target: None, start_ts: None, end_ts: None, sort: None, limit: None,
        }).unwrap();
        assert_eq!(search("pelican").messages[0].message_id, "5");

        // 新数据：重号也能进，触发器重建了，能搜到
        assert!(db.insert_chat_message(&msg("5", "@alice", 3, "pelican again")).unwrap());
        assert_eq!(search("pelican").total, 2);

        // 再跑一次 init 不会再迁移、也不报错
        db.init_chat_history().unwrap();
    }
}
