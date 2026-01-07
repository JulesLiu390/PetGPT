use rusqlite::{params, Result};
use serde::{Deserialize, Serialize};
use super::Database;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

impl Database {
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?")?;
        let mut rows = stmt.query(params![key])?;
        
        if let Some(row) = rows.next()? {
            let value: String = row.get(0)?;
            println!("[DEBUG Settings] get_setting: key={}, value={}", key, value);
            Ok(Some(value))
        } else {
            println!("[DEBUG Settings] get_setting: key={}, NOT FOUND", key);
            Ok(None)
        }
    }

    pub fn get_all_settings(&self) -> Result<Vec<Setting>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        
        let settings = stmt.query_map([], |row| {
            Ok(Setting {
                key: row.get(0)?,
                value: row.get(1)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        
        println!("[DEBUG Settings] get_all_settings: {} settings found", settings.len());
        for s in &settings {
            println!("[DEBUG Settings]   - {} = {}", s.key, s.value);
        }
        
        Ok(settings)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        println!("[DEBUG Settings] set_setting: key={}, value={}", key, value);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        println!("[DEBUG Settings] set_setting: SUCCESS");
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute("DELETE FROM settings WHERE key = ?", params![key])?;
        Ok(rows > 0)
    }
}
