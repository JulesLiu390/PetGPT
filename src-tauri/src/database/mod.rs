pub mod pets;
pub mod conversations;
pub mod messages;
pub mod settings;
pub mod mcp_servers;
pub mod api_providers;
pub mod skins;

use rusqlite::{Connection, Result};
use std::sync::Mutex;
use std::path::PathBuf;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        
        // Pets/Assistants table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT DEFAULT 'assistant',
                model_name TEXT,
                model_url TEXT,
                model_api_key TEXT,
                model_config_id TEXT,
                api_format TEXT,
                system_instruction TEXT,
                appearance TEXT,
                has_mood INTEGER DEFAULT 1,
                icon TEXT,
                toolbar_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        
        // Migration: add type column if not exists
        let _ = conn.execute("ALTER TABLE pets ADD COLUMN type TEXT DEFAULT 'assistant'", []);
        let _ = conn.execute("ALTER TABLE pets ADD COLUMN model_config_id TEXT", []);
        let _ = conn.execute("ALTER TABLE pets ADD COLUMN api_format TEXT", []);
        let _ = conn.execute("ALTER TABLE pets ADD COLUMN appearance TEXT", []);
        let _ = conn.execute("ALTER TABLE pets ADD COLUMN user_memory TEXT", []);

        // Conversations table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                pet_id TEXT NOT NULL,
                title TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (pet_id) REFERENCES pets(id)
            )",
            [],
        )?;

        // Messages table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                tool_call_history TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )",
            [],
        )?;

        // Settings table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;

        // MCP Servers table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                transport TEXT DEFAULT 'stdio',
                command TEXT,
                args TEXT,
                env TEXT,
                url TEXT,
                api_key TEXT,
                icon TEXT,
                auto_start INTEGER DEFAULT 0,
                show_in_toolbar INTEGER DEFAULT 1,
                toolbar_order INTEGER DEFAULT 0,
                max_iterations INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Migration: add new columns if not exists
        let _ = conn.execute("ALTER TABLE mcp_servers ADD COLUMN transport TEXT DEFAULT 'stdio'", []);
        let _ = conn.execute("ALTER TABLE mcp_servers ADD COLUMN url TEXT", []);
        let _ = conn.execute("ALTER TABLE mcp_servers ADD COLUMN api_key TEXT", []);
        let _ = conn.execute("ALTER TABLE mcp_servers ADD COLUMN max_iterations INTEGER", []);

        // Migration: add is_deleted to pets
        let _ = conn.execute("ALTER TABLE pets ADD COLUMN is_deleted INTEGER DEFAULT 0", []);

        // API Providers table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS api_providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                api_key TEXT NOT NULL,
                api_format TEXT NOT NULL DEFAULT 'openai_compatible',
                is_validated INTEGER DEFAULT 0,
                cached_models TEXT,
                hidden_models TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        
        // Migration: add hidden_models column if not exists
        let _ = conn.execute("ALTER TABLE api_providers ADD COLUMN hidden_models TEXT", []);

        // Skins table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS skins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                author TEXT,
                description TEXT,
                is_builtin INTEGER DEFAULT 0,
                is_hidden INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Migration: add is_builtin and is_hidden columns if not exists
        let _ = conn.execute("ALTER TABLE skins ADD COLUMN is_builtin INTEGER DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE skins ADD COLUMN is_hidden INTEGER DEFAULT 0", []);

        Ok(())
    }
}
