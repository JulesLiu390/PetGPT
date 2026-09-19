use rusqlite::{params, Result};

use super::Database;
use crate::projects::Project;

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Database {
    pub fn get_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, path, created_at, last_opened_at FROM projects
             ORDER BY COALESCE(last_opened_at, created_at) DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    created_at: row.get(3)?,
                    last_opened_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, path, created_at, last_opened_at FROM projects WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                last_opened_at: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 同一个路径只登记一次：path 上有 UNIQUE 约束，重复添加会更新名称
    /// 而不是插出第二条记录。
    pub fn create_project(&self, id: &str, name: &str, path: &str) -> Result<Project> {
        let created = now_millis();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, path, created_at, last_opened_at)
                 VALUES (?1, ?2, ?3, ?4, NULL)
                 ON CONFLICT(path) DO UPDATE SET name = excluded.name",
                params![id, name, path, created],
            )?;
        }
        // 冲突时插入的 id 不会生效，所以回读一次确保返回的是库里真实那条
        let mut found = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, name, path, created_at, last_opened_at FROM projects WHERE path = ?1",
            )?;
            let mut rows = stmt.query(params![path])?;
            rows.next()?.map(|row| {
                Ok::<Project, rusqlite::Error>(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    created_at: row.get(3)?,
                    last_opened_at: row.get(4)?,
                })
            })
        }
        .transpose()?;
        found
            .take()
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE projects SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
        Ok(rows > 0)
    }

    /// 只解除登记，不动磁盘上的任何文件。
    pub fn delete_project(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(rows > 0)
    }

    pub fn touch_project(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET last_opened_at = ?2 WHERE id = ?1",
            params![id, now_millis()],
        )?;
        Ok(())
    }
}
