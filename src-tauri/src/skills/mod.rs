//! Read-only global and per-assistant Skill packages.
//!
//! Global Skills live under `{global_root}/{skill_id}` and assistant-private
//! Skills live under `{workspace_root}/{pet_id}/skills/{skill_id}`. When both
//! libraries contain the same id, the assistant-private package wins. The chat
//! runtime can list metadata and read `SKILL.md` / referenced resources, but it
//! cannot execute package code or write Skill files. The only write operations
//! exposed here are explicit, user-triggered template creators.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Arc;
use tauri::State;

const MAX_SKILL_FILE_BYTES: u64 = 64 * 1024;
const MAX_RESOURCE_BYTES: u64 = 256 * 1024;
const MAX_SKILL_ID_CHARS: usize = 64;
const MAX_RESOURCE_PATH_CHARS: usize = 512;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub scopes: Vec<String>,
    pub path: String,
    pub source: String,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    #[serde(flatten)]
    pub descriptor: SkillDescriptor,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResource {
    pub path: String,
    pub source: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
}

#[derive(Debug)]
struct SkillMetadata {
    name: String,
    description: String,
    version: Option<String>,
    scopes: Vec<String>,
}

pub struct SkillEngine {
    workspace_root: PathBuf,
    global_root: PathBuf,
}

impl SkillEngine {
    pub fn new(workspace_root: PathBuf, global_root: PathBuf) -> Self {
        Self {
            workspace_root,
            global_root,
        }
    }

    pub fn list(&self, pet_id: &str) -> Result<Vec<SkillDescriptor>, String> {
        validate_pet_id(pet_id)?;

        // Insert global descriptors first, then assistant descriptors so a
        // private package (including an invalid one) consistently shadows the
        // inherited global package with the same id.
        let mut merged = HashMap::<String, SkillDescriptor>::new();
        for descriptor in self.list_global()? {
            merged.insert(descriptor.id.clone(), descriptor);
        }
        let assistant_dir = self.ensure_skills_dir(pet_id)?;
        for descriptor in self.list_from_dir(&assistant_dir, "assistant")? {
            merged.insert(descriptor.id.clone(), descriptor);
        }

        let mut skills: Vec<SkillDescriptor> = merged.into_values().collect();
        sort_descriptors(&mut skills);
        Ok(skills)
    }

    pub fn list_global(&self) -> Result<Vec<SkillDescriptor>, String> {
        let global_dir = self.ensure_global_dir()?;
        let mut skills = self.list_from_dir(&global_dir, "global")?;
        sort_descriptors(&mut skills);
        Ok(skills)
    }

    fn list_from_dir(
        &self,
        skills_dir: &Path,
        source: &'static str,
    ) -> Result<Vec<SkillDescriptor>, String> {
        let mut skills = Vec::new();

        for entry in fs::read_dir(skills_dir)
            .map_err(|error| format!("读取 Skills 目录失败: {error}"))?
        {
            let entry = match entry {
                Ok(value) => value,
                Err(error) => {
                    log::warn!("[Skills] Failed to read directory entry: {error}");
                    continue;
                }
            };
            let id = entry.file_name().to_string_lossy().to_string();
            if id.starts_with('.') {
                continue;
            }

            let descriptor = match entry.file_type() {
                Ok(file_type) if file_type.is_symlink() => {
                    self.invalid_descriptor(&id, source, "Skill 目录不能是符号链接")
                }
                Ok(file_type) if file_type.is_dir() => self
                    .load_descriptor_from_dir(skills_dir, &id, source)
                    .unwrap_or_else(|error| self.invalid_descriptor(&id, source, &error)),
                Ok(_) => self.invalid_descriptor(
                    &id,
                    source,
                    "Skills 目录下只允许 Skill 文件夹",
                ),
                Err(error) => self.invalid_descriptor(
                    &id,
                    source,
                    &format!("读取文件类型失败: {error}"),
                ),
            };
            skills.push(descriptor);
        }

        Ok(skills)
    }

    pub fn read(&self, pet_id: &str, skill_id: &str) -> Result<SkillDocument, String> {
        validate_pet_id(pet_id)?;
        validate_skill_id(skill_id)?;
        let assistant_dir = self.ensure_skills_dir(pet_id)?;
        if skill_entry_exists(&assistant_dir, skill_id)? {
            return self.read_from_dir(&assistant_dir, skill_id, "assistant");
        }
        let global_dir = self.ensure_global_dir()?;
        self.read_from_dir(&global_dir, skill_id, "global")
    }

    fn read_from_dir(
        &self,
        skills_dir: &Path,
        skill_id: &str,
        source: &'static str,
    ) -> Result<SkillDocument, String> {
        let descriptor = self.load_descriptor_from_dir(skills_dir, skill_id, source)?;
        let skill_dir = self.resolve_skill_dir_from_root(skills_dir, skill_id)?;
        let skill_file = skill_dir.join("SKILL.md");
        let content = read_utf8_file_limited(&skill_file, MAX_SKILL_FILE_BYTES, "SKILL.md")?;
        Ok(SkillDocument { descriptor, content })
    }

    pub fn read_resource(
        &self,
        pet_id: &str,
        skill_id: &str,
        relative_path: &str,
    ) -> Result<SkillResource, String> {
        validate_pet_id(pet_id)?;
        validate_skill_id(skill_id)?;
        let assistant_dir = self.ensure_skills_dir(pet_id)?;
        if skill_entry_exists(&assistant_dir, skill_id)? {
            return self.read_resource_from_dir(
                &assistant_dir,
                skill_id,
                relative_path,
                "assistant",
            );
        }
        let global_dir = self.ensure_global_dir()?;
        self.read_resource_from_dir(&global_dir, skill_id, relative_path, "global")
    }

    fn read_resource_from_dir(
        &self,
        skills_dir: &Path,
        skill_id: &str,
        relative_path: &str,
        source: &'static str,
    ) -> Result<SkillResource, String> {
        // Require a valid package before exposing any of its resources.
        self.load_descriptor_from_dir(skills_dir, skill_id, source)?;
        let relative = validate_resource_path(relative_path)?;
        let skill_dir = self.resolve_skill_dir_from_root(skills_dir, skill_id)?;
        let target = skill_dir.join(&relative);
        reject_symlinks_along_path(&skill_dir, &relative)?;

        let metadata = fs::symlink_metadata(&target)
            .map_err(|error| format!("Skill resource 不存在或无法访问: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Skill resource 必须是普通文件，不能是目录或符号链接".to_string());
        }
        reject_hard_link(&metadata, "Skill resource")?;
        if metadata.len() > MAX_RESOURCE_BYTES {
            return Err(format!(
                "Skill resource 过大（{} bytes），上限为 {} bytes",
                metadata.len(),
                MAX_RESOURCE_BYTES
            ));
        }

        let bytes = fs::read(&target).map_err(|error| format!("读取 Skill resource 失败: {error}"))?;
        let mime_type = mime_type_for(&target).to_string();
        let content = String::from_utf8(bytes.clone()).ok();
        let base64 = if content.is_none() {
            Some(BASE64.encode(bytes))
        } else {
            None
        };

        Ok(SkillResource {
            path: relative_path.to_string(),
            source: source.to_string(),
            mime_type,
            content,
            base64,
        })
    }

    pub fn create_template(
        &self,
        pet_id: &str,
        skill_id: &str,
        name: &str,
        description: &str,
    ) -> Result<SkillDocument, String> {
        validate_pet_id(pet_id)?;
        let skills_dir = self.ensure_skills_dir(pet_id)?;
        self.create_template_in_dir(&skills_dir, skill_id, name, description, "assistant")
    }

    pub fn create_global_template(
        &self,
        skill_id: &str,
        name: &str,
        description: &str,
    ) -> Result<SkillDocument, String> {
        let global_dir = self.ensure_global_dir()?;
        self.create_template_in_dir(&global_dir, skill_id, name, description, "global")
    }

    pub fn delete_global(&self, skill_id: &str) -> Result<(), String> {
        validate_skill_id(skill_id)?;
        let global_dir = self.ensure_global_dir()?;
        let skill_dir = global_dir.join(skill_id);
        let metadata = fs::symlink_metadata(&skill_dir)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    format!("Global Skill \"{skill_id}\" 不存在")
                } else {
                    format!("检查 Global Skill 失败: {error}")
                }
            })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Global Skill 路径必须是普通目录，不能是符号链接".to_string());
        }

        // remove_dir_all does not follow directory symlinks. The package root
        // itself is explicitly rejected above, so deletion stays inside the
        // dedicated global Skill library.
        fs::remove_dir_all(&skill_dir)
            .map_err(|error| format!("删除 Global Skill 失败: {error}"))
    }

    fn create_template_in_dir(
        &self,
        skills_dir: &Path,
        skill_id: &str,
        name: &str,
        description: &str,
        source: &'static str,
    ) -> Result<SkillDocument, String> {
        validate_skill_id(skill_id)?;
        validate_display_field("Skill name", name, 160)?;
        validate_display_field("Skill description", description, 2_000)?;

        let skill_dir = skills_dir.join(skill_id);
        match fs::symlink_metadata(&skill_dir) {
            Ok(_) => return Err(format!("Skill \"{skill_id}\" 已存在")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("检查 Skill 目录失败: {error}")),
        }

        fs::create_dir(&skill_dir).map_err(|error| format!("创建 Skill 目录失败: {error}"))?;
        fs::create_dir(skill_dir.join("references"))
            .map_err(|error| format!("创建 references 目录失败: {error}"))?;

        let quoted_name = serde_json::to_string(name.trim())
            .map_err(|error| format!("编码 Skill name 失败: {error}"))?;
        let quoted_description = serde_json::to_string(description.trim())
            .map_err(|error| format!("编码 Skill description 失败: {error}"))?;
        let content = format!(
            "---\nname: {quoted_name}\ndescription: {quoted_description}\nversion: 0.1.0\nscopes: [chat]\n---\n\n# Instructions\n\nDescribe the workflow this Skill should follow. Keep the core instructions concise and place detailed material in `references/`.\n"
        );

        let skill_file = skill_dir.join("SKILL.md");
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&skill_file)
            .map_err(|error| format!("创建 SKILL.md 失败: {error}"))?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("写入 SKILL.md 失败: {error}"))?;

        self.read_from_dir(skills_dir, skill_id, source)
    }

    pub fn ensure_skills_dir(&self, pet_id: &str) -> Result<PathBuf, String> {
        validate_pet_id(pet_id)?;
        ensure_safe_directory(&self.workspace_root, "workspace root")?;

        let pet_dir = self.workspace_root.join(pet_id);
        ensure_safe_directory(&pet_dir, "pet workspace")?;

        let skills_dir = pet_dir.join("skills");
        ensure_safe_directory(&skills_dir, "Skills directory")?;
        Ok(skills_dir)
    }

    pub fn ensure_global_dir(&self) -> Result<PathBuf, String> {
        ensure_safe_directory(&self.global_root, "global Skills directory")?;
        Ok(self.global_root.clone())
    }

    #[cfg(test)]
    fn resolve_skill_dir(&self, pet_id: &str, skill_id: &str) -> Result<PathBuf, String> {
        validate_skill_id(skill_id)?;
        let skills_dir = self.ensure_skills_dir(pet_id)?;
        self.resolve_skill_dir_from_root(&skills_dir, skill_id)
    }

    fn resolve_skill_dir_from_root(
        &self,
        skills_dir: &Path,
        skill_id: &str,
    ) -> Result<PathBuf, String> {
        validate_skill_id(skill_id)?;
        let skill_dir = skills_dir.join(skill_id);
        let metadata = fs::symlink_metadata(&skill_dir)
            .map_err(|_| format!("Skill \"{skill_id}\" 不存在"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Skill 路径必须是普通目录，不能是符号链接".to_string());
        }
        Ok(skill_dir)
    }

    fn load_descriptor_from_dir(
        &self,
        skills_dir: &Path,
        skill_id: &str,
        source: &'static str,
    ) -> Result<SkillDescriptor, String> {
        let skill_dir = self.resolve_skill_dir_from_root(skills_dir, skill_id)?;
        let skill_file = skill_dir.join("SKILL.md");
        let metadata = fs::symlink_metadata(&skill_file)
            .map_err(|_| "缺少 SKILL.md".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("SKILL.md 必须是普通文件，不能是目录或符号链接".to_string());
        }
        let content = read_utf8_file_limited(&skill_file, MAX_SKILL_FILE_BYTES, "SKILL.md")?;
        let parsed = parse_frontmatter(&content)?;

        Ok(SkillDescriptor {
            id: skill_id.to_string(),
            name: parsed.name,
            description: parsed.description,
            version: parsed.version,
            scopes: parsed.scopes,
            path: descriptor_path(source, skill_id),
            source: source.to_string(),
            valid: true,
            validation_error: None,
        })
    }

    fn invalid_descriptor(
        &self,
        skill_id: &str,
        source: &'static str,
        error: &str,
    ) -> SkillDescriptor {
        SkillDescriptor {
            id: skill_id.to_string(),
            name: skill_id.to_string(),
            description: String::new(),
            version: None,
            scopes: Vec::new(),
            path: descriptor_path(source, skill_id),
            source: source.to_string(),
            valid: false,
            validation_error: Some(error.to_string()),
        }
    }
}

pub type SkillState = Arc<SkillEngine>;

#[tauri::command]
pub fn skills_list(
    engine: State<'_, SkillState>,
    pet_id: String,
) -> Result<Vec<SkillDescriptor>, String> {
    engine.list(&pet_id)
}

#[tauri::command]
pub fn skills_list_global(
    engine: State<'_, SkillState>,
) -> Result<Vec<SkillDescriptor>, String> {
    engine.list_global()
}

#[tauri::command]
pub fn skills_read(
    engine: State<'_, SkillState>,
    pet_id: String,
    skill_id: String,
) -> Result<SkillDocument, String> {
    engine.read(&pet_id, &skill_id)
}

#[tauri::command]
pub fn skills_read_resource(
    engine: State<'_, SkillState>,
    pet_id: String,
    skill_id: String,
    path: String,
) -> Result<SkillResource, String> {
    engine.read_resource(&pet_id, &skill_id, &path)
}

#[tauri::command]
pub fn skills_create_template(
    engine: State<'_, SkillState>,
    pet_id: String,
    skill_id: String,
    name: String,
    description: String,
) -> Result<SkillDocument, String> {
    engine.create_template(&pet_id, &skill_id, &name, &description)
}

#[tauri::command]
pub fn skills_create_global_template(
    engine: State<'_, SkillState>,
    skill_id: String,
    name: String,
    description: String,
) -> Result<SkillDocument, String> {
    engine.create_global_template(&skill_id, &name, &description)
}

#[tauri::command]
pub fn skills_delete_global(
    engine: State<'_, SkillState>,
    skill_id: String,
) -> Result<(), String> {
    engine.delete_global(&skill_id)
}

#[tauri::command]
pub fn skills_open_folder(
    engine: State<'_, SkillState>,
    pet_id: String,
) -> Result<(), String> {
    let folder = engine.ensure_skills_dir(&pet_id)?;
    open_directory(&folder)
}

#[tauri::command]
pub fn skills_open_global_folder(
    engine: State<'_, SkillState>,
) -> Result<(), String> {
    let folder = engine.ensure_global_dir()?;
    open_directory(&folder)
}

fn open_directory(folder: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    StdCommand::new("open")
        .arg(&folder)
        .spawn()
        .map_err(|error| format!("打开 Skills 目录失败: {error}"))?;

    #[cfg(target_os = "linux")]
    StdCommand::new("xdg-open")
        .arg(&folder)
        .spawn()
        .map_err(|error| format!("打开 Skills 目录失败: {error}"))?;

    #[cfg(target_os = "windows")]
    StdCommand::new("explorer")
        .arg(&folder)
        .spawn()
        .map_err(|error| format!("打开 Skills 目录失败: {error}"))?;

    Ok(())
}

fn sort_descriptors(skills: &mut [SkillDescriptor]) {
    skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn descriptor_path(source: &str, skill_id: &str) -> String {
    if source == "global" {
        format!("global/{skill_id}")
    } else {
        format!("skills/{skill_id}")
    }
}

/// Check whether a package id is present without following it. An invalid
/// assistant entry still shadows a global package with the same id, preventing
/// a broken private override from silently changing behavior back to global.
fn skill_entry_exists(skills_dir: &Path, skill_id: &str) -> Result<bool, String> {
    validate_skill_id(skill_id)?;
    match fs::symlink_metadata(skills_dir.join(skill_id)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("检查 Skill 失败: {error}")),
    }
}

fn validate_pet_id(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err("petId 格式不安全".to_string())
    }
}

fn validate_skill_id(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= MAX_SKILL_ID_CHARS
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.ends_with('-')
        && !value.contains("--");
    if valid {
        Ok(())
    } else {
        Err("Skill id 必须由小写字母、数字和单个连字符组成，且不超过 64 字符".to_string())
    }
}

fn validate_display_field(label: &str, value: &str, max_chars: usize) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} 不能为空"));
    }
    if trimmed.chars().count() > max_chars {
        return Err(format!("{label} 不能超过 {max_chars} 字符"));
    }
    if trimmed.chars().any(|character| character == '\0' || character.is_control() && character != '\n' && character != '\t') {
        return Err(format!("{label} 包含不安全的控制字符"));
    }
    Ok(())
}

fn ensure_safe_directory(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!("{label} 必须是普通目录，不能是符号链接"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|create_error| format!("创建 {label} 失败: {create_error}"))?;
        }
        Err(error) => return Err(format!("检查 {label} 失败: {error}")),
    }
    Ok(())
}

fn validate_resource_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.chars().count() > MAX_RESOURCE_PATH_CHARS || value.contains('\0') {
        return Err("Skill resource path 为空、过长或包含 NUL".to_string());
    }
    if value.contains('\\') {
        return Err("Skill resource path 必须使用正斜杠".to_string());
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("Skill resource path 不能是绝对路径".to_string());
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("Skill resource path 不能包含 .、.. 或绝对路径组件".to_string());
        }
    }
    Ok(path.to_path_buf())
}

fn reject_symlinks_along_path(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("Skill resource path 不安全".to_string());
        };
        current.push(part);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("Skill resource 不存在或无法访问: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Skill resource 路径不能经过符号链接".to_string());
        }
    }
    Ok(())
}

fn read_utf8_file_limited(path: &Path, max_bytes: u64, label: &str) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("读取 {label} 元数据失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} 必须是普通文件，不能是目录或符号链接"));
    }
    reject_hard_link(&metadata, label)?;
    if metadata.len() > max_bytes {
        return Err(format!("{label} 过大（{} bytes），上限为 {max_bytes} bytes", metadata.len()));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 {label} 失败: {error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{label} 必须是 UTF-8 文本"))
}

#[cfg(unix)]
fn reject_hard_link(metadata: &fs::Metadata, label: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    if metadata.nlink() > 1 {
        Err(format!("{label} 不能是硬链接"))
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn reject_hard_link(_metadata: &fs::Metadata, _label: &str) -> Result<(), String> {
    Ok(())
}

fn parse_frontmatter(content: &str) -> Result<SkillMetadata, String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("SKILL.md 必须以 YAML frontmatter（---）开头".to_string());
    }

    let mut fields = HashMap::<String, String>::new();
    let mut scopes = Vec::<String>::new();
    let mut collecting_scopes = false;
    let mut closed = false;

    for raw_line in lines {
        let line = raw_line.trim();
        if line == "---" {
            closed = true;
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if collecting_scopes && line.starts_with("- ") {
            scopes.push(unquote_scalar(line.trim_start_matches("- ").trim())?);
            continue;
        }
        collecting_scopes = false;

        let Some((key, raw_value)) = line.split_once(':') else {
            return Err(format!("无法解析 frontmatter 行: {line}"));
        };
        let key = key.trim().to_lowercase();
        let raw_value = raw_value.trim();
        if key == "scopes" {
            if raw_value.is_empty() {
                collecting_scopes = true;
            } else {
                scopes.extend(parse_scopes(raw_value)?);
            }
        } else {
            fields.insert(key, unquote_scalar(raw_value)?);
        }
    }

    if !closed {
        return Err("SKILL.md frontmatter 缺少结束分隔符 ---".to_string());
    }

    let name = fields.remove("name").unwrap_or_default();
    let description = fields.remove("description").unwrap_or_default();
    validate_display_field("frontmatter.name", &name, 160)?;
    validate_display_field("frontmatter.description", &description, 2_000)?;

    let version = fields.remove("version").filter(|value| !value.trim().is_empty());
    if version.as_ref().is_some_and(|value| value.chars().count() > 80) {
        return Err("frontmatter.version 不能超过 80 字符".to_string());
    }

    if scopes.is_empty() {
        scopes.push("chat".to_string());
    }
    scopes.sort();
    scopes.dedup();
    if scopes.iter().any(|scope| {
        scope.is_empty()
            || scope.len() > 64
            || !scope
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    }) {
        return Err("frontmatter.scopes 包含无效 scope".to_string());
    }

    Ok(SkillMetadata {
        name,
        description,
        version,
        scopes,
    })
}

fn parse_scopes(raw_value: &str) -> Result<Vec<String>, String> {
    let value = raw_value.trim();
    let inner = if value.starts_with('[') && value.ends_with(']') {
        &value[1..value.len() - 1]
    } else {
        value
    };
    inner
        .split(',')
        .map(|item| unquote_scalar(item.trim()))
        .filter(|result| result.as_ref().map(|value| !value.is_empty()).unwrap_or(true))
        .collect()
}

fn unquote_scalar(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.starts_with('"') {
        return serde_json::from_str::<String>(trimmed)
            .map_err(|error| format!("无效的双引号字符串: {error}"));
    }
    if trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2 {
        return Ok(trimmed[1..trimmed.len() - 1].replace("''", "'"));
    }
    Ok(trimmed.to_string())
}

fn mime_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(OsStr::to_str).map(str::to_ascii_lowercase).as_deref() {
        Some("md") | Some("markdown") => "text/markdown",
        Some("txt") | Some("log") => "text/plain",
        Some("json") => "application/json",
        Some("yaml") | Some("yml") => "application/yaml",
        Some("csv") => "text/csv",
        Some("html") => "text/html",
        Some("css") => "text/css",
        Some("js") | Some("mjs") => "text/javascript",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_engine() -> (SkillEngine, PathBuf) {
        let root = std::env::temp_dir().join(format!("petgpt-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let workspace_root = root.join("workspace");
        let global_root = root.join("global-skills");
        fs::create_dir(&workspace_root).unwrap();
        fs::create_dir(&global_root).unwrap();
        (SkillEngine::new(workspace_root, global_root), root)
    }

    #[test]
    fn creates_lists_and_reads_a_skill() {
        let (engine, root) = test_engine();
        let document = engine
            .create_template("pet-1", "meeting-notes", "Meeting Notes", "Summarize meetings")
            .unwrap();
        assert_eq!(document.descriptor.id, "meeting-notes");
        assert!(document.content.contains("# Instructions"));

        let skills = engine.list("pet-1").unwrap();
        assert_eq!(skills.len(), 1);
        assert!(skills[0].valid);
        assert_eq!(skills[0].scopes, vec!["chat"]);
        assert_eq!(skills[0].source, "assistant");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inherits_global_skills_and_lists_global_library() {
        let (engine, root) = test_engine();
        engine
            .create_global_template("shared-notes", "Shared Notes", "A shared workflow")
            .unwrap();
        fs::write(
            engine
                .ensure_global_dir()
                .unwrap()
                .join("shared-notes/references/guide.txt"),
            "global guide",
        )
        .unwrap();

        let global = engine.list_global().unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].id, "shared-notes");
        assert_eq!(global[0].source, "global");
        assert_eq!(global[0].path, "global/shared-notes");

        let inherited = engine.list("pet-1").unwrap();
        assert_eq!(inherited.len(), 1);
        assert_eq!(inherited[0].source, "global");
        let document = engine.read("pet-1", "shared-notes").unwrap();
        assert_eq!(document.descriptor.source, "global");
        assert!(document.content.contains("Shared Notes"));
        let resource = engine
            .read_resource("pet-1", "shared-notes", "references/guide.txt")
            .unwrap();
        assert_eq!(resource.source, "global");
        assert_eq!(resource.content.as_deref(), Some("global guide"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletes_only_the_requested_global_skill() {
        let (engine, root) = test_engine();
        engine
            .create_global_template("delete-me", "Delete Me", "Temporary")
            .unwrap();
        engine
            .create_global_template("keep-me", "Keep Me", "Persistent")
            .unwrap();

        engine.delete_global("delete-me").unwrap();
        let remaining = engine.list_global().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "keep-me");
        assert!(engine.delete_global("../unsafe").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_delete_a_symlinked_global_skill() {
        use std::os::unix::fs::symlink;

        let (engine, root) = test_engine();
        let outside = root.join("outside-library");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        let link = engine.ensure_global_dir().unwrap().join("linked-skill");
        symlink(&outside, &link).unwrap();

        assert!(engine.delete_global("linked-skill").is_err());
        assert!(outside.join("keep.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn assistant_skill_overrides_global_for_list_read_and_resource() {
        let (engine, root) = test_engine();
        engine
            .create_global_template("writer", "Global Writer", "Global behavior")
            .unwrap();
        engine
            .create_template("pet-1", "writer", "Private Writer", "Private behavior")
            .unwrap();

        let global_dir = engine.ensure_global_dir().unwrap().join("writer");
        fs::write(global_dir.join("references").join("mode.txt"), "global").unwrap();
        let private_dir = engine.resolve_skill_dir("pet-1", "writer").unwrap();
        fs::write(private_dir.join("references").join("mode.txt"), "assistant").unwrap();

        let merged = engine.list("pet-1").unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "Private Writer");
        assert_eq!(merged[0].source, "assistant");

        let document = engine.read("pet-1", "writer").unwrap();
        assert_eq!(document.descriptor.source, "assistant");
        assert!(document.content.contains("Private Writer"));

        let resource = engine
            .read_resource("pet-1", "writer", "references/mode.txt")
            .unwrap();
        assert_eq!(resource.source, "assistant");
        assert_eq!(resource.content.as_deref(), Some("assistant"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_private_override_does_not_fall_back_to_global() {
        let (engine, root) = test_engine();
        engine
            .create_global_template("shared", "Shared", "Global behavior")
            .unwrap();
        let private_dir = engine.ensure_skills_dir("pet-1").unwrap().join("shared");
        fs::create_dir(&private_dir).unwrap();
        fs::write(private_dir.join("SKILL.md"), "invalid").unwrap();

        let merged = engine.list("pet-1").unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "assistant");
        assert!(!merged[0].valid);
        assert!(engine.read("pet-1", "shared").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_private_override_does_not_fall_back_to_global() {
        use std::os::unix::fs::symlink;

        let (engine, root) = test_engine();
        engine
            .create_global_template("shared", "Shared", "Global behavior")
            .unwrap();
        let outside = root.join("outside-skill");
        fs::create_dir(&outside).unwrap();
        fs::write(
            outside.join("SKILL.md"),
            "---\nname: Outside\ndescription: Unsafe\n---\n",
        )
        .unwrap();
        let private_link = engine.ensure_skills_dir("pet-1").unwrap().join("shared");
        symlink(&outside, &private_link).unwrap();

        let merged = engine.list("pet-1").unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "assistant");
        assert!(!merged[0].valid);
        assert!(merged[0]
            .validation_error
            .as_deref()
            .unwrap()
            .contains("符号链接"));
        assert!(engine.read("pet-1", "shared").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn inherited_global_resource_still_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let (engine, root) = test_engine();
        engine
            .create_global_template("shared", "Shared", "Global behavior")
            .unwrap();
        let outside = root.join("secret.txt");
        fs::write(&outside, "secret").unwrap();
        let global_skill = engine.ensure_global_dir().unwrap().join("shared");
        symlink(
            &outside,
            global_skill.join("references").join("escape.txt"),
        )
        .unwrap();

        assert!(engine
            .read_resource("pet-1", "shared", "references/escape.txt")
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_package_is_reported_without_breaking_list() {
        let (engine, root) = test_engine();
        let skill_dir = engine.ensure_skills_dir("pet-1").unwrap().join("broken");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Missing frontmatter").unwrap();

        let skills = engine.list("pet-1").unwrap();
        assert_eq!(skills.len(), 1);
        assert!(!skills[0].valid);
        assert!(skills[0].validation_error.as_deref().unwrap().contains("frontmatter"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unsafe_identifiers_and_resource_traversal() {
        let (engine, root) = test_engine();
        assert!(engine.list("../pet").is_err());
        assert!(engine
            .create_template("pet-1", "../bad", "Bad", "Bad package")
            .is_err());
        engine
            .create_template("pet-1", "safe", "Safe", "Safe package")
            .unwrap();
        engine
            .create_template("pet-1", "123-skill", "Numeric", "Numeric prefix is portable")
            .unwrap();
        assert!(engine.read_resource("pet-1", "safe", "../SKILL.md").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_text_and_binary_resources() {
        let (engine, root) = test_engine();
        engine
            .create_template("pet-1", "assets", "Assets", "Resource package")
            .unwrap();
        let skill_dir = engine.resolve_skill_dir("pet-1", "assets").unwrap();
        fs::write(skill_dir.join("references").join("guide.md"), "hello").unwrap();
        fs::write(skill_dir.join("image.png"), [0_u8, 159, 146, 150]).unwrap();

        let text = engine
            .read_resource("pet-1", "assets", "references/guide.md")
            .unwrap();
        assert_eq!(text.content.as_deref(), Some("hello"));
        let image = engine.read_resource("pet-1", "assets", "image.png").unwrap();
        assert!(image.base64.is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_resources() {
        use std::os::unix::fs::symlink;

        let (engine, root) = test_engine();
        engine
            .create_template("pet-1", "safe", "Safe", "Safe package")
            .unwrap();
        let skill_dir = engine.resolve_skill_dir("pet-1", "safe").unwrap();
        let outside = root.join("secret.txt");
        fs::write(&outside, "secret").unwrap();
        symlink(&outside, skill_dir.join("references").join("escape.txt")).unwrap();

        let result = engine.read_resource("pet-1", "safe", "references/escape.txt");
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hard_link_resources() {
        let (engine, root) = test_engine();
        engine
            .create_template("pet-1", "safe", "Safe", "Safe package")
            .unwrap();
        let skill_dir = engine.resolve_skill_dir("pet-1", "safe").unwrap();
        let outside = root.join("secret.txt");
        fs::write(&outside, "secret").unwrap();
        fs::hard_link(&outside, skill_dir.join("references").join("hard-link.txt")).unwrap();

        let result = engine.read_resource("pet-1", "safe", "references/hard-link.txt");
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_inline_and_list_scopes() {
        let inline = parse_frontmatter(
            "---\nname: Test\ndescription: Desc\nscopes: [chat, social.intent]\n---\nBody",
        )
        .unwrap();
        assert_eq!(inline.scopes, vec!["chat", "social.intent"]);

        let list = parse_frontmatter(
            "---\nname: Test\ndescription: Desc\nscopes:\n  - chat\n  - social.intent\n---\nBody",
        )
        .unwrap();
        assert_eq!(list.scopes, vec!["chat", "social.intent"]);
    }
}
