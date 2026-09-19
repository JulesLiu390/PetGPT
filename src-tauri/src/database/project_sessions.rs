//! 项目会话的绑定表。
//!
//! 只存「PetGPT 的 PTY 会话 ↔ CLI 的 agent 会话 id」这层对应关系，不存任何
//! 对话内容 —— 内容由 claude/codex 自己的存储负责（见 agent_sessions 模块）。
//! 这张表存在的唯一理由是：同一项目可以并存多个会话窗口，需要区分谁是谁。
//!
//! `shell` 类型不入表：一个 bash 会话没有可恢复的语义。

use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};

use super::Database;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSession {
    /// PetGPT 侧的 PTY session id
    pub id: String,
    pub project_id: String,
    pub kind: String,
    /// CLI 的 session uuid。认领成功后才有值 —— 两个 CLI 都是懒写入，
    /// 启动那一刻还不存在。
    pub agent_id: Option<String>,
    pub title: Option<String>,
    pub created_at: i64,
    pub last_active_at: Option<i64>,
    /// 'running' | 'exited'
    pub status: String,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Database {
    /// 登记一个会话窗口。
    ///
    /// **一行代表一个对话，不是一个进程。** `id` 只是「当前哪个 PTY 进程在
    /// 服务这个对话」，它会随恢复而改变；`agent_id` 才是身份。
    ///
    /// 所以恢复（`agent_id` 已知）时走的是**转移**而不是插入：把已有那行的
    /// `id` 换成新进程，标题和创建时间都留着。直接 INSERT 会撞上 agent_id
    /// 的 UNIQUE 索引，插入失败后新进程就成了一条无主记录，界面上多出一行。
    pub fn upsert_project_session(
        &self,
        id: &str,
        project_id: &str,
        kind: &str,
        title: Option<&str>,
        agent_id: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_millis();

        if let Some(agent) = agent_id {
            // 这个对话已经有一行了 → 把它转移到新进程上
            let moved = conn.execute(
                "UPDATE project_sessions
                 SET id = ?1, status = 'running', last_active_at = ?2, kind = ?3
                 WHERE agent_id = ?4 AND project_id = ?5",
                params![id, now, kind, agent, project_id],
            )?;
            if moved > 0 {
                return Ok(());
            }
        }

        conn.execute(
            "INSERT INTO project_sessions
                (id, project_id, kind, agent_id, title, created_at, last_active_at, status)
             VALUES (?1, ?2, ?3, ?6, ?4, ?5, ?5, 'running')
             ON CONFLICT(id) DO UPDATE SET
                status = 'running',
                last_active_at = excluded.last_active_at,
                agent_id = COALESCE(excluded.agent_id, project_sessions.agent_id)",
            params![id, project_id, kind, title, now, agent_id],
        )?;
        Ok(())
    }

    /// 删掉没能认领到 agent id 且已经退出的记录。
    ///
    /// 这些记录界面上看不见（无从 resume），但每次 spawn 都会插一条，
    /// 不清理表会一直涨。
    pub fn prune_orphan_project_sessions(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "DELETE FROM project_sessions
             WHERE agent_id IS NULL AND status = 'exited'",
            [],
        )?;
        Ok(rows)
    }

    /// 回填认领到的 agent id。
    ///
    /// 同一个 agent_id 不允许绑定到两个 PTY 会话上 —— 那意味着认领错配，
    /// 两个窗口会去 resume 同一个对话。UNIQUE 索引在数据库层面挡住它。
    pub fn bind_project_session_agent(&self, id: &str, agent_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        // 这个对话已经有一行了（比如它是被恢复出来的）：把那一行转移到当前
        // 进程上，并删掉本进程那条还没有身份的临时记录，避免两行并存。
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM project_sessions WHERE agent_id = ?1",
                params![agent_id],
                |row| row.get(0),
            )
            .ok();
        if let Some(existing_id) = existing {
            if existing_id == id {
                return Ok(true);
            }
            conn.execute("DELETE FROM project_sessions WHERE id = ?1", params![id])?;
            conn.execute(
                "UPDATE project_sessions
                 SET id = ?1, status = 'running', last_active_at = ?2
                 WHERE agent_id = ?3",
                params![id, now_millis(), agent_id],
            )?;
            return Ok(true);
        }

        let rows = conn.execute(
            "UPDATE project_sessions SET agent_id = ?2, last_active_at = ?3
             WHERE id = ?1 AND agent_id IS NULL",
            params![id, agent_id, now_millis()],
        );
        match rows {
            Ok(n) => Ok(n > 0),
            Err(rusqlite::Error::SqliteFailure(_, _)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn mark_project_session_exited(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_sessions SET status = 'exited', last_active_at = ?2 WHERE id = ?1",
            params![id, now_millis()],
        )?;
        Ok(())
    }

    /// 启动时把所有 running 标记清成 exited —— 进程随上次退出已经全没了。
    pub fn reset_project_session_statuses(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_sessions SET status = 'exited' WHERE status = 'running'",
            [],
        )?;
        Ok(())
    }

    pub fn rename_project_session(&self, id: &str, title: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE project_sessions SET title = ?2 WHERE id = ?1",
            params![id, title],
        )?;
        Ok(rows > 0)
    }

    pub fn get_project_sessions(&self, project_id: &str) -> Result<Vec<ProjectSession>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, agent_id, title, created_at, last_active_at, status
             FROM project_sessions WHERE project_id = ?1
             ORDER BY COALESCE(last_active_at, created_at) DESC",
        )?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok(ProjectSession {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    kind: row.get(2)?,
                    agent_id: row.get(3)?,
                    title: row.get(4)?,
                    created_at: row.get(5)?,
                    last_active_at: row.get(6)?,
                    status: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 已经被绑定过的 agent id，用于认领时排除。
    pub fn bound_agent_ids(&self, project_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT agent_id FROM project_sessions
             WHERE project_id = ?1 AND agent_id IS NOT NULL",
        )?;
        let rows = stmt
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn delete_project_session(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute("DELETE FROM project_sessions WHERE id = ?1", params![id])?;
        Ok(rows > 0)
    }
}
