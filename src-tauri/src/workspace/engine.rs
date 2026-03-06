// WorkspaceEngine: core file operations for the pet workspace
// Each pet gets its own workspace directory: {root_dir}/{pet_id}/
// Contains SOUL.md, USER.md, MEMORY.md and potentially other files

use std::fs;
use std::path::{Path, PathBuf};

// ============ Error Types ============

#[derive(Debug)]
pub enum WorkspaceError {
    /// Path tries to escape the workspace directory
    PathUnsafe(String),
    /// Target file does not exist
    FileNotFound(String),
    /// Failed to read file
    ReadError(String),
    /// Failed to write file
    WriteError(String),
    /// edit: oldText not found in file (path, current_content)
    EditNotFound(String, String),
    /// edit: oldText matches multiple locations (path, count, current_content)
    EditMultipleMatches(String, usize, String),
    /// edit: replacement produces no change
    EditNoChange(String),
    /// General IO error
    IoError(String),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkspaceError::PathUnsafe(path) => {
                write!(f, "不允许访问工作区外的文件: {}", path)
            }
            WorkspaceError::FileNotFound(path) => {
                write!(f, "文件不存在: {}", path)
            }
            WorkspaceError::ReadError(msg) => {
                write!(f, "读取文件失败: {}", msg)
            }
            WorkspaceError::WriteError(msg) => {
                write!(f, "写入文件失败: {}", msg)
            }
            WorkspaceError::EditNotFound(path, current_content) => {
                write!(
                    f,
                    "无法在 {} 中找到指定文本。请确保 oldText 与文件内容完全一致（包括标点、空格、换行）。建议先用 read 工具获取文件内容，直接从中复制要替换的部分。\n\n当前文件完整内容如下：\n{}",
                    path, current_content
                )
            }
            WorkspaceError::EditMultipleMatches(path, n, current_content) => {
                write!(
                    f,
                    "在 {} 中找到 {} 处匹配，oldText 不唯一。请增加上下文文本使其只匹配一处。\n\n当前文件完整内容如下：\n{}",
                    path, n, current_content
                )
            }
            WorkspaceError::EditNoChange(path) => {
                write!(f, "替换后 {} 内容没有变化。", path)
            }
            WorkspaceError::IoError(msg) => {
                write!(f, "IO 错误: {}", msg)
            }
        }
    }
}

// ============ WorkspaceEngine ============

pub struct WorkspaceEngine {
    /// Root workspace directory (e.g. ~/.app/workspace/)
    /// Each pet gets a subdirectory: {root_dir}/{pet_id}/
    root_dir: PathBuf,
}

impl WorkspaceEngine {
    pub fn new(root_dir: PathBuf) -> Self {
        // Ensure root directory exists
        let _ = fs::create_dir_all(&root_dir);
        Self { root_dir }
    }

    /// Get the workspace directory for a specific pet
    fn pet_workspace(&self, pet_id: &str) -> PathBuf {
        self.root_dir.join(pet_id)
    }

    // ============ Path Safety ============

    /// Resolve a relative path to a safe absolute path within the pet's workspace.
    /// Returns error if the resolved path escapes the workspace boundary.
    fn resolve_safe_path(
        &self,
        pet_id: &str,
        relative_path: &str,
    ) -> Result<PathBuf, WorkspaceError> {
        let workspace = self.pet_workspace(pet_id);

        // Reject absolute paths immediately
        if Path::new(relative_path).is_absolute() {
            return Err(WorkspaceError::PathUnsafe(relative_path.to_string()));
        }

        let joined = workspace.join(relative_path);

        // Normalize the path to resolve .. and . components
        let normalized = normalize_path(&joined);

        // Normalize the workspace root too for consistent comparison
        let normalized_workspace = normalize_path(&workspace);

        // Safety check: resolved path must start with the workspace directory
        if !normalized.starts_with(&normalized_workspace) {
            return Err(WorkspaceError::PathUnsafe(relative_path.to_string()));
        }

        Ok(normalized)
    }

    // ============ Core Operations ============

    /// Read a file from the pet's workspace
    pub fn read(&self, pet_id: &str, path: &str) -> Result<String, WorkspaceError> {
        let full_path = self.resolve_safe_path(pet_id, path)?;

        if !full_path.exists() {
            return Err(WorkspaceError::FileNotFound(path.to_string()));
        }

        fs::read_to_string(&full_path).map_err(|e| WorkspaceError::ReadError(e.to_string()))
    }

    /// Write content to a file in the pet's workspace (create or overwrite).
    /// Automatically creates parent directories.
    pub fn write(
        &self,
        pet_id: &str,
        path: &str,
        content: &str,
    ) -> Result<String, WorkspaceError> {
        let full_path = self.resolve_safe_path(pet_id, path)?;

        // Create parent directories if needed
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).map_err(|e| WorkspaceError::WriteError(e.to_string()))?;
        }

        let bytes = content.as_bytes().len();
        fs::write(&full_path, content).map_err(|e| WorkspaceError::WriteError(e.to_string()))?;

        Ok(format!("成功写入 {} 字节到 {}", bytes, path))
    }

    /// Edit a file by exact text find-and-replace.
    /// - oldText must match exactly once (uniqueness check)
    /// - Falls back to fuzzy matching (whitespace tolerance) if exact match fails
    /// - Rejects if replacement produces no change
    pub fn edit(
        &self,
        pet_id: &str,
        path: &str,
        old_text: &str,
        new_text: &str,
    ) -> Result<String, WorkspaceError> {
        let full_path = self.resolve_safe_path(pet_id, path)?;

        if !full_path.exists() {
            return Err(WorkspaceError::FileNotFound(path.to_string()));
        }

        let content =
            fs::read_to_string(&full_path).map_err(|e| WorkspaceError::ReadError(e.to_string()))?;

        // Count exact matches
        let match_count = content.matches(old_text).count();

        if match_count == 0 {
            // Try fuzzy matching (normalize whitespace)
            match self.fuzzy_edit(&content, old_text, new_text) {
                Some(new_content) => {
                    if new_content == content {
                        return Err(WorkspaceError::EditNoChange(path.to_string()));
                    }
                    fs::write(&full_path, &new_content)
                        .map_err(|e| WorkspaceError::WriteError(e.to_string()))?;
                    return Ok(format!("成功替换了 {} 中的文本（模糊匹配）\n\n当前文件完整内容如下：\n{}", path, new_content));
                }
                None => return Err(WorkspaceError::EditNotFound(path.to_string(), content)),
            }
        }

        if match_count > 1 {
            return Err(WorkspaceError::EditMultipleMatches(
                path.to_string(),
                match_count,
                content,
            ));
        }

        // Single exact match — replace
        let new_content = content.replacen(old_text, new_text, 1);

        if new_content == content {
            return Err(WorkspaceError::EditNoChange(path.to_string()));
        }

        fs::write(&full_path, &new_content)
            .map_err(|e| WorkspaceError::WriteError(e.to_string()))?;

        Ok(format!("成功替换了 {} 中的文本\n\n当前文件完整内容如下：\n{}", path, new_content))
    }

    // ============ Fuzzy Matching ============

    /// Attempt an edit using whitespace-tolerant matching.
    /// Normalizes whitespace in both content and old_text for comparison,
    /// then maps the match back to the original content for replacement.
    fn fuzzy_edit(&self, content: &str, old_text: &str, new_text: &str) -> Option<String> {
        let normalized_content = normalize_whitespace(content);
        let normalized_old = normalize_whitespace(old_text);

        // Check if normalized match exists
        let match_count = normalized_content.matches(&normalized_old).count();
        if match_count != 1 {
            return None;
        }

        // Find position in normalized content
        let norm_start = normalized_content.find(&normalized_old)?;
        let norm_end = norm_start + normalized_old.len();

        // Map normalized positions back to original content positions
        // We need to walk both strings simultaneously
        let (orig_start, orig_end) = map_normalized_range_to_original(content, norm_start, norm_end);

        let mut result = String::with_capacity(content.len());
        result.push_str(&content[..orig_start]);
        result.push_str(new_text);
        result.push_str(&content[orig_end..]);

        Some(result)
    }

    // ============ Default Templates ============

    /// Ensure default workspace files exist for a pet.
    /// Creates SOUL.md and USER.md with templates. MEMORY.md is NOT auto-created (FR-3.1).
    pub fn ensure_default_files(
        &self,
        pet_id: &str,
        pet_name: &str,
    ) -> Result<(), WorkspaceError> {
        let workspace = self.pet_workspace(pet_id);
        fs::create_dir_all(&workspace).map_err(|e| WorkspaceError::IoError(e.to_string()))?;

        // Create SOUL.md if it doesn't exist
        let soul_path = workspace.join("SOUL.md");
        if !soul_path.exists() {
            let soul_template = default_soul_template(pet_name);
            fs::write(&soul_path, soul_template)
                .map_err(|e| WorkspaceError::WriteError(e.to_string()))?;
        }

        // Create USER.md if it doesn't exist
        let user_path = workspace.join("USER.md");
        if !user_path.exists() {
            let user_template = default_user_template();
            fs::write(&user_path, user_template)
                .map_err(|e| WorkspaceError::WriteError(e.to_string()))?;
        }

        // MEMORY.md is NOT auto-created — AI creates it when needed (FR-3.1)

        Ok(())
    }

    // ============ File Queries ============

    /// Check if a file exists in the pet's workspace
    pub fn file_exists(&self, pet_id: &str, path: &str) -> bool {
        match self.resolve_safe_path(pet_id, path) {
            Ok(full_path) => full_path.exists(),
            Err(_) => false,
        }
    }

    /// Get the full safe path for a file in the pet's workspace (public wrapper)
    pub fn get_full_path(&self, pet_id: &str, path: &str) -> Result<PathBuf, WorkspaceError> {
        self.resolve_safe_path(pet_id, path)
    }

    /// Delete a pet's entire workspace directory
    pub fn delete_workspace(&self, pet_id: &str) -> Result<(), WorkspaceError> {
        let workspace = self.pet_workspace(pet_id);
        if workspace.exists() {
            fs::remove_dir_all(&workspace)
                .map_err(|e| WorkspaceError::IoError(e.to_string()))?;
        }
        Ok(())
    }
}

// ============ Utility Functions ============

/// Normalize a path by resolving `.` and `..` components without filesystem access
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                // Only pop if there's something to pop that isn't a root/prefix
                if !components.is_empty() {
                    components.pop();
                }
            }
            std::path::Component::CurDir => {
                // Skip `.` components
            }
            other => {
                components.push(other);
            }
        }
    }
    components.iter().collect()
}

/// Normalize whitespace: collapse all runs of whitespace into a single space
fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Map a range in normalized (whitespace-collapsed) text back to the original text.
/// Returns (original_start_byte, original_end_byte).
fn map_normalized_range_to_original(original: &str, norm_start: usize, norm_end: usize) -> (usize, usize) {
    let mut norm_pos = 0usize; // position in normalized string
    let mut orig_idx = 0usize; // byte position in original string
    let bytes = original.as_bytes();
    let len = bytes.len();

    let mut orig_start = 0;
    let mut orig_end = len;
    let mut in_whitespace = false;
    let mut started = false;

    // Skip leading whitespace in original (normalized trims leading ws)
    while orig_idx < len && (bytes[orig_idx] as char).is_ascii_whitespace() {
        orig_idx += 1;
    }

    while orig_idx < len {
        let ch = bytes[orig_idx] as char;

        if ch.is_ascii_whitespace() {
            if !in_whitespace {
                // First whitespace after non-whitespace: counts as one space in normalized
                if norm_pos == norm_start && !started {
                    orig_start = orig_idx;
                    started = true;
                }
                norm_pos += 1; // the single space in normalized
                if norm_pos == norm_end {
                    // Find the end of this whitespace run
                    while orig_idx < len && (bytes[orig_idx] as char).is_ascii_whitespace() {
                        orig_idx += 1;
                    }
                    orig_end = orig_idx;
                    return (orig_start, orig_end);
                }
                in_whitespace = true;
            }
            orig_idx += 1;
        } else {
            in_whitespace = false;
            if norm_pos == norm_start && !started {
                orig_start = orig_idx;
                started = true;
            }
            norm_pos += 1;
            orig_idx += 1;
            if norm_pos == norm_end {
                orig_end = orig_idx;
                return (orig_start, orig_end);
            }
        }
    }

    (orig_start, orig_end)
}

// ============ Default File Templates ============

fn default_soul_template(pet_name: &str) -> String {
    format!(
        r#"# 🐾 我是谁

<!-- 这是你的宠物的性格定义。修改这里会改变它的行为方式。 -->

## 基本信息

- **名字：**{}
- **物种/形态：**（比如：猫、狗、龙、像素精灵……）
- **性格关键词：**（比如：活泼、傲娇、话多、安静……）
- **标志性表情/emoji：**（比如：🐱、✨、😼）

## 性格

<!-- 描述你的宠物是什么样的。越具体，它的表现越一致。 -->

（待填写——你希望它是什么样的？亲切？高冷？话唠？你来定。）

## 说话方式

<!-- 它怎么说话？用什么口吻？有没有口头禅？ -->

- 语气：
- 口头禅：
- 会用的表情/颜文字：

## 行为准则

- 真诚地帮忙，不说废话客套
- 可以有自己的观点和偏好
- 尊重主人的隐私
- 不确定的时候先问再做

## 边界

- 不代替主人在外部平台发言
- 私密信息不对外泄露
- 重大操作（如删除文件）前需确认

---

_这个文件属于你的宠物。随着你们越来越了解彼此，可以一起更新它。_
"#,
        pet_name
    )
}

fn default_user_template() -> String {
    r#"# 🧑 关于我的主人

<!-- 宠物会在对话中自动了解你，并记录在这里。你也可以直接编辑。 -->

## 基本信息

- **称呼：**
- **时区：**
- **语言偏好：**

## 了解

<!-- 主人关心什么？在做什么项目？有什么习惯？喜欢什么？讨厌什么？ -->

（还没有了解到太多，让我们先聊聊吧。）

---

_了解越多，帮助越好。但这是在了解一个人，不是在建档案。_
"#
    .to_string()
}

// ============ Tests ============

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_test_workspace() -> (PathBuf, WorkspaceEngine) {
        let tmp = std::env::temp_dir().join(format!("petgpt_test_{}", uuid::Uuid::new_v4()));
        let engine = WorkspaceEngine::new(tmp.clone());
        (tmp, engine)
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn test_read_write() {
        let (tmp, engine) = setup_test_workspace();
        let pet_id = "test-pet";

        // Write
        let result = engine.write(pet_id, "test.md", "hello world");
        assert!(result.is_ok());

        // Read
        let content = engine.read(pet_id, "test.md").unwrap();
        assert_eq!(content, "hello world");

        cleanup(&tmp);
    }

    #[test]
    fn test_edit_exact() {
        let (tmp, engine) = setup_test_workspace();
        let pet_id = "test-pet";

        engine.write(pet_id, "test.md", "hello world, hello rust").unwrap();

        // Should fail: "hello" matches twice
        let result = engine.edit(pet_id, "test.md", "hello", "hi");
        assert!(result.is_err());

        // Should succeed: unique match
        let result = engine.edit(pet_id, "test.md", "hello world", "hi world");
        assert!(result.is_ok());

        let content = engine.read(pet_id, "test.md").unwrap();
        assert_eq!(content, "hi world, hello rust");

        cleanup(&tmp);
    }

    #[test]
    fn test_path_safety() {
        let (tmp, engine) = setup_test_workspace();
        let pet_id = "test-pet";

        // Should reject path traversal
        let result = engine.read(pet_id, "../../etc/passwd");
        assert!(result.is_err());

        // Should reject absolute paths
        let result = engine.read(pet_id, "/etc/passwd");
        assert!(result.is_err());

        cleanup(&tmp);
    }

    #[test]
    fn test_ensure_default_files() {
        let (tmp, engine) = setup_test_workspace();
        let pet_id = "test-pet";

        engine.ensure_default_files(pet_id, "小花").unwrap();

        assert!(engine.file_exists(pet_id, "SOUL.md"));
        assert!(engine.file_exists(pet_id, "USER.md"));
        assert!(!engine.file_exists(pet_id, "MEMORY.md")); // Not auto-created

        let soul = engine.read(pet_id, "SOUL.md").unwrap();
        assert!(soul.contains("小花"));

        cleanup(&tmp);
    }

    #[test]
    fn test_edit_no_change() {
        let (tmp, engine) = setup_test_workspace();
        let pet_id = "test-pet";

        engine.write(pet_id, "test.md", "hello world").unwrap();

        // Replacing with same text should error
        let result = engine.edit(pet_id, "test.md", "hello", "hello");
        assert!(result.is_err());

        cleanup(&tmp);
    }

    #[test]
    fn test_file_not_found() {
        let (tmp, engine) = setup_test_workspace();
        let pet_id = "test-pet";

        let result = engine.read(pet_id, "nonexistent.md");
        assert!(result.is_err());

        let result = engine.edit(pet_id, "nonexistent.md", "a", "b");
        assert!(result.is_err());

        cleanup(&tmp);
    }
}
