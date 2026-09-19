//! 项目登记与项目内文件访问
//!
//! 为什么不复用 `WorkspaceEngine`：那个引擎在 `resolve_safe_path` 里直接拒绝
//! 绝对路径，并要求结果落在 `workspace/<pet-id>/` 之内（见 engine.rs:94）。
//! 项目在磁盘任意位置，所以需要一个根为「已登记项目列表」的独立引擎。
//!
//! 这里的路径校验用 `canonicalize` 而不是纯字符串规范化 —— 项目目录里出现
//! 指向外部的符号链接是很常见的（node_modules、pnpm store），纯字符串比较
//! 拦不住它们。

pub mod git;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 默认折叠、且不参与递归的目录。这个仓库自己就有 1.9G 的 target 和
/// 几万个文件的 node_modules，一次性遍历会直接卡死界面。
pub const NOISY_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    ".next",
    ".venv",
    "__pycache__",
    ".DS_Store",
];

/// 单个目录最多返回的条目数。超出时截断并置 truncated 标记。
pub const DIR_ENTRY_LIMIT: usize = 2000;

/// 文本预览的字节上限。工程里有 22MB 的 DMG 和大量图片，
/// 直接读进内存再塞进 DOM 会炸。
pub const PREVIEW_MAX_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastOpenedAt")]
    pub last_opened_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    /// 相对项目根的路径，用 `/` 分隔
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub size: u64,
    /// 是否属于 NOISY_DIRS，前端据此默认折叠并弱化显示
    pub noisy: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirListing {
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
}

/// 文件预览结果。二进制文件不返回内容，只报类型让前端换渲染方式。
#[derive(Debug, Clone, Serialize)]
pub struct FilePreview {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// "text" | "binary" | "image"
    pub kind: String,
    pub content: Option<String>,
    /// 内容被 PREVIEW_MAX_BYTES 截断
    pub truncated: bool,
    /// 图片/二进制预览用的绝对路径，前端走 asset:// 协议
    #[serde(rename = "absolutePath")]
    pub absolute_path: String,
    /// 读取时的修改时间。保存时带回来做冲突检测。
    #[serde(rename = "modifiedAt")]
    pub modified_at: i64,
}

/// 写入结果。返回新的修改时间，前端据此更新自己持有的基线，
/// 下一次保存才能继续做冲突检测。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub modified_at: i64,
    pub size: u64,
}

#[derive(Debug)]
pub enum ProjectError {
    NotFound(String),
    PathUnsafe(String),
    Io(String),
    /// 磁盘上的文件在前端读取之后被改过了。
    ///
    /// 这不是理论风险：agent 就在同一个项目里跑着改文件，用户打开一个文件、
    /// agent 同时改了它、用户再保存 —— 无条件写入会把 agent 的修改吞掉。
    Conflict(String),
}

/// `Conflict` 消息里这个短语是**前端契约**：`FilePreview` 靠它认出
/// 「磁盘上变了」并弹出覆盖/重载选项。改这里必须同步改
/// `src/components/Project/FilePreview.jsx` 的 CONFLICT_MARKER。
///
/// 这里没有做成错误码，是因为 `From<ProjectError> for String` 在命令边界
/// 就把枚举压成了字符串，类型信息传不到前端。
pub const CONFLICT_MARKER: &str = "was changed by another program";

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::NotFound(s) => write!(f, "Not found: {s}"),
            ProjectError::PathUnsafe(s) => write!(f, "Path escapes the project: {s}"),
            ProjectError::Io(s) => write!(f, "Filesystem error: {s}"),
            ProjectError::Conflict(s) => write!(f, "File {CONFLICT_MARKER}: {s}"),
        }
    }
}

impl From<ProjectError> for String {
    fn from(e: ProjectError) -> String {
        e.to_string()
    }
}

pub fn is_noisy(name: &str) -> bool {
    NOISY_DIRS.contains(&name)
}

const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif",
];

pub fn classify_extension(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        "image"
    } else {
        "text"
    }
}

/// 判断字节内容是否是可显示文本。检测 NUL 字节 —— 这是区分文本和二进制
/// 最可靠的单一信号，比扩展名白名单靠得住。
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// 把相对路径解析成绝对路径，并确认它没有逃出项目根。
///
/// 两道校验：先按字符串规范化挡掉明显的 `..`，再 canonicalize 之后重新比对，
/// 挡掉通过符号链接绕出去的情况。目标不存在时退回对父目录做 canonicalize，
/// 这样「在项目内新建文件」的路径也能通过校验。
pub fn resolve_in_project(root: &str, relative: &str) -> Result<PathBuf, ProjectError> {
    let root_path = Path::new(root);
    let canonical_root = root_path
        .canonicalize()
        .map_err(|e| ProjectError::Io(format!("{root}: {e}")))?;

    if Path::new(relative).is_absolute() {
        return Err(ProjectError::PathUnsafe(relative.to_string()));
    }
    // Windows 盘符前缀和 UNC 也算绝对，上面的 is_absolute 已覆盖；
    // 这里额外挡掉被当作相对路径传入的 `..` 开头
    if relative
        .split(['/', '\\'])
        .any(|segment| segment == "..")
    {
        return Err(ProjectError::PathUnsafe(relative.to_string()));
    }

    let joined = canonical_root.join(relative);

    let canonical = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // 目标还不存在：校验其父目录
            let parent = joined
                .parent()
                .ok_or_else(|| ProjectError::PathUnsafe(relative.to_string()))?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|_| ProjectError::NotFound(relative.to_string()))?;
            if !canonical_parent.starts_with(&canonical_root) {
                return Err(ProjectError::PathUnsafe(relative.to_string()));
            }
            return Ok(joined);
        }
    };

    if !canonical.starts_with(&canonical_root) {
        return Err(ProjectError::PathUnsafe(relative.to_string()));
    }
    Ok(canonical)
}

fn to_forward_slash(relative: &Path) -> String {
    relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 列一层目录。刻意不递归 —— 文件树按层懒加载。
pub fn list_dir(root: &str, relative: &str) -> Result<DirListing, ProjectError> {
    let dir = resolve_in_project(root, relative)?;
    let read = std::fs::read_dir(&dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut truncated = false;
    let prefix = relative.trim_matches('/');

    for item in read {
        if entries.len() >= DIR_ENTRY_LIMIT {
            truncated = true;
            break;
        }
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" {
            continue;
        }
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let child_rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        entries.push(DirEntryInfo {
            name: name.clone(),
            path: child_rel,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            noisy: is_dir && is_noisy(&name),
        });
    }

    // 目录在前、噪音目录沉底、同类按名称不分大小写排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.noisy.cmp(&b.noisy))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing { entries, truncated })
}

pub fn preview_file(root: &str, relative: &str) -> Result<FilePreview, ProjectError> {
    let file = resolve_in_project(root, relative)?;
    let meta = std::fs::metadata(&file).map_err(|e| ProjectError::Io(e.to_string()))?;
    if meta.is_dir() {
        return Err(ProjectError::PathUnsafe(format!("{relative} is a directory")));
    }

    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| relative.to_string());
    let size = meta.len();
    let absolute_path = file.to_string_lossy().to_string();
    let rel_display = to_forward_slash(Path::new(relative));

    if classify_extension(&name) == "image" {
        return Ok(FilePreview {
            path: rel_display,
            name,
            size,
            kind: "image".to_string(),
            content: None,
            truncated: false,
            absolute_path,
            modified_at: modified_millis(&file),
        });
    }

    let read_len = size.min(PREVIEW_MAX_BYTES) as usize;
    let mut bytes = vec![0u8; read_len];
    {
        use std::io::Read;
        let mut handle = std::fs::File::open(&file).map_err(|e| ProjectError::Io(e.to_string()))?;
        let actually_read = handle
            .read(&mut bytes)
            .map_err(|e| ProjectError::Io(e.to_string()))?;
        bytes.truncate(actually_read);
    }

    if looks_binary(&bytes) {
        return Ok(FilePreview {
            path: rel_display,
            name,
            size,
            kind: "binary".to_string(),
            content: None,
            truncated: false,
            absolute_path,
            modified_at: modified_millis(&file),
        });
    }

    Ok(FilePreview {
        path: rel_display,
        name,
        size,
        kind: "text".to_string(),
        content: Some(String::from_utf8_lossy(&bytes).to_string()),
        truncated: size > PREVIEW_MAX_BYTES,
        absolute_path,
        modified_at: modified_millis(&file),
    })
}

/// 文件的修改时间（毫秒）。0 表示取不到。
fn modified_millis(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 写回一个项目内的文件。
///
/// `expected_modified_at` 是前端读取时看到的修改时间。若磁盘上的值已经不同，
/// 说明文件被别人改过（大概率是同项目里的 agent），拒绝写入并返回 Conflict，
/// 由界面提示用户重新加载 —— 而不是静默覆盖别人的修改。
/// 传 None 表示强制覆盖，供用户在看到冲突提示后显式选择。
pub fn write_file(
    root: &str,
    relative: &str,
    content: &str,
    expected_modified_at: Option<i64>,
) -> Result<WriteResult, ProjectError> {
    let file = resolve_in_project(root, relative)?;

    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.is_dir() {
            return Err(ProjectError::PathUnsafe(format!("{relative} is a directory")));
        }
        if let Some(expected) = expected_modified_at {
            let actual = modified_millis(&file);
            // 文件系统的时间精度有限，容忍 1ms 以内的差异
            if actual != 0 && (actual - expected).abs() > 1 {
                return Err(ProjectError::Conflict(relative.to_string()));
            }
        }
    }

    // 先写临时文件再改名：写入中途崩溃不会留下半个文件
    let temp = file.with_extension(format!(
        "{}.petgpt-tmp",
        file.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&temp, content).map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::rename(&temp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        ProjectError::Io(e.to_string())
    })?;

    Ok(WriteResult {
        modified_at: modified_millis(&file),
        size: content.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("petgpt-projects-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_relative_path_inside_the_project_resolves() {
        let root = temp_root("inside");
        fs::create_dir_all(root.join("src/utils")).unwrap();
        fs::write(root.join("src/utils/a.js"), "x").unwrap();
        let resolved =
            resolve_in_project(root.to_str().unwrap(), "src/utils/a.js").expect("should resolve");
        assert!(resolved.ends_with("src/utils/a.js"));
    }

    #[test]
    fn traversal_and_absolute_paths_are_refused() {
        let root = temp_root("traversal");
        fs::create_dir_all(root.join("src")).unwrap();
        for bad in ["../etc/passwd", "src/../../etc/passwd", "..", "src/.."] {
            assert!(
                resolve_in_project(root.to_str().unwrap(), bad).is_err(),
                "应拒绝 {bad}"
            );
        }
        assert!(resolve_in_project(root.to_str().unwrap(), "/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_outside_the_project_is_refused() {
        // 纯字符串规范化拦不住这种情况，必须靠 canonicalize
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        fs::write(outside.join("secret.txt"), "sensitive").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        assert!(resolve_in_project(root.to_str().unwrap(), "escape/secret.txt").is_err());
        assert!(preview_file(root.to_str().unwrap(), "escape/secret.txt").is_err());
    }

    #[test]
    fn a_path_that_does_not_exist_yet_validates_against_its_parent() {
        let root = temp_root("missing");
        fs::create_dir_all(root.join("src")).unwrap();
        assert!(resolve_in_project(root.to_str().unwrap(), "src/new-file.js").is_ok());
        assert!(resolve_in_project(root.to_str().unwrap(), "nowhere/new-file.js").is_err());
    }

    #[test]
    fn listing_puts_directories_first_and_sinks_the_noisy_ones() {
        let root = temp_root("listing");
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("readme.md"), "hi").unwrap();
        fs::write(root.join("Cargo.toml"), "hi").unwrap();

        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "node_modules", "target", "Cargo.toml", "readme.md"]);

        let noisy: Vec<&str> = listing
            .entries
            .iter()
            .filter(|e| e.noisy)
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(noisy, vec!["node_modules", "target"]);
        assert!(!listing.truncated);
    }

    #[test]
    fn ds_store_never_shows_up_in_a_listing() {
        let root = temp_root("dsstore");
        fs::write(root.join(".DS_Store"), "junk").unwrap();
        fs::write(root.join("keep.txt"), "hi").unwrap();
        let listing = list_dir(root.to_str().unwrap(), "").unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["keep.txt"]);
    }

    #[test]
    fn text_preview_returns_content_and_flags_oversized_files() {
        let root = temp_root("preview-text");
        fs::write(root.join("small.txt"), "hello world").unwrap();
        let small = preview_file(root.to_str().unwrap(), "small.txt").unwrap();
        assert_eq!(small.kind, "text");
        assert_eq!(small.content.as_deref(), Some("hello world"));
        assert!(!small.truncated);

        let big = "a".repeat((PREVIEW_MAX_BYTES + 1024) as usize);
        fs::write(root.join("big.txt"), &big).unwrap();
        let large = preview_file(root.to_str().unwrap(), "big.txt").unwrap();
        assert_eq!(large.kind, "text");
        assert!(large.truncated, "超过上限必须标记截断");
        assert_eq!(
            large.content.as_ref().unwrap().len(),
            PREVIEW_MAX_BYTES as usize,
            "读入内容必须停在上限，不能整文件进内存"
        );
    }

    #[test]
    fn binary_content_is_detected_and_not_returned_as_text() {
        let root = temp_root("preview-binary");
        fs::write(root.join("blob.bin"), [0x00, 0x01, 0x02, 0xff]).unwrap();
        let preview = preview_file(root.to_str().unwrap(), "blob.bin").unwrap();
        assert_eq!(preview.kind, "binary");
        assert!(preview.content.is_none());

        assert!(looks_binary(&[b'a', 0x00, b'b']));
        assert!(!looks_binary(b"plain text"));
    }

    #[test]
    fn images_are_classified_for_the_asset_protocol_instead_of_being_read() {
        let root = temp_root("preview-image");
        fs::write(root.join("pic.PNG"), [0x89, b'P', b'N', b'G']).unwrap();
        let preview = preview_file(root.to_str().unwrap(), "pic.PNG").unwrap();
        assert_eq!(preview.kind, "image", "扩展名判断要不分大小写");
        assert!(preview.content.is_none());
        assert!(preview.absolute_path.ends_with("pic.PNG"));

        assert_eq!(classify_extension("a.jpeg"), "image");
        assert_eq!(classify_extension("a.rs"), "text");
        assert_eq!(classify_extension("noext"), "text");
    }

    #[test]
    fn a_write_lands_inside_the_project_and_reports_the_new_mtime() {
        let root = temp_root("write-ok");
        fs::write(root.join("a.txt"), "old").unwrap();
        let before = preview_file(root.to_str().unwrap(), "a.txt").unwrap();
        let result = write_file(
            root.to_str().unwrap(),
            "a.txt",
            "new content",
            Some(before.modified_at),
        )
        .expect("should write");
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "new content");
        assert_eq!(result.size, "new content".len() as u64);
        assert!(result.modified_at > 0);
    }

    #[test]
    fn a_write_refuses_to_clobber_a_file_that_changed_on_disk() {
        // 这不是理论风险：agent 就在同一个项目里改文件
        let root = temp_root("write-conflict");
        fs::write(root.join("a.txt"), "original").unwrap();
        let stale_mtime = 1_000i64; // 明显不是当前值
        let err = write_file(root.to_str().unwrap(), "a.txt", "mine", Some(stale_mtime));
        assert!(matches!(err, Err(ProjectError::Conflict(_))), "应拒绝覆盖");
        // 原内容必须完好
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "original");
    }

    #[test]
    fn the_conflict_message_keeps_the_phrase_the_frontend_matches_on() {
        // 前端没有错误码可用（From<ProjectError> for String 在命令边界就把
        // 枚举压平了），只能认这个短语。写死在这里：改措辞会让这条测试红，
        // 提醒去同步 FilePreview.jsx 的 CONFLICT_MARKER。
        assert_eq!(CONFLICT_MARKER, "was changed by another program");
        let rendered = ProjectError::Conflict("src/a.js".to_string()).to_string();
        assert!(
            rendered.contains(CONFLICT_MARKER),
            "冲突消息必须带上前端认的短语，实际是 {rendered:?}",
        );
        // translator.js 的 zh-CN 规则按整句匹配，句式也不能随便改
        assert_eq!(rendered, "File was changed by another program: src/a.js");
    }

    #[test]
    fn the_other_error_messages_are_english_so_the_translator_can_localize_them() {
        // 后端是源语言（messages.js: "Keep English first"）。出中文的话
        // 英文界面会直接漏中文，而 translator 没有中文→中文的规则可加。
        for rendered in [
            ProjectError::NotFound("a".into()).to_string(),
            ProjectError::PathUnsafe("a".into()).to_string(),
            ProjectError::Io("a".into()).to_string(),
            ProjectError::Conflict("a".into()).to_string(),
        ] {
            assert!(
                rendered.is_ascii(),
                "错误消息应为英文，实际是 {rendered:?}",
            );
        }
    }

    #[test]
    fn passing_no_expected_mtime_forces_the_write() {
        // 用户在看到冲突提示后显式选择覆盖
        let root = temp_root("write-force");
        fs::write(root.join("a.txt"), "original").unwrap();
        write_file(root.to_str().unwrap(), "a.txt", "forced", None).expect("should write");
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "forced");
    }

    #[test]
    fn a_write_cannot_escape_the_project() {
        let root = temp_root("write-escape");
        fs::create_dir_all(root.join("src")).unwrap();
        for bad in ["../outside.txt", "src/../../outside.txt", "/tmp/outside.txt"] {
            assert!(
                write_file(root.to_str().unwrap(), bad, "x", None).is_err(),
                "应拒绝 {bad}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_write_cannot_follow_a_symlink_out_of_the_project() {
        let root = temp_root("write-symlink");
        let outside = temp_root("write-symlink-outside");
        fs::write(outside.join("secret.txt"), "sensitive").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        assert!(write_file(root.to_str().unwrap(), "escape/secret.txt", "x", None).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "sensitive",
            "外部文件必须完好",
        );
    }

    #[test]
    fn writing_over_a_directory_is_refused() {
        let root = temp_root("write-dir");
        fs::create_dir_all(root.join("src")).unwrap();
        assert!(write_file(root.to_str().unwrap(), "src", "x", None).is_err());
    }

    #[test]
    fn a_new_file_inside_the_project_can_be_created() {
        let root = temp_root("write-new");
        fs::create_dir_all(root.join("src")).unwrap();
        write_file(root.to_str().unwrap(), "src/fresh.txt", "hello", None).expect("should create");
        assert_eq!(fs::read_to_string(root.join("src/fresh.txt")).unwrap(), "hello");
        // 不留临时文件
        let leftovers: Vec<_> = fs::read_dir(root.join("src"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("petgpt-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件应已改名: {leftovers:?}");
    }

    #[test]
    fn previewing_a_directory_is_an_error_not_a_garbage_read() {
        let root = temp_root("preview-dir");
        fs::create_dir_all(root.join("src")).unwrap();
        assert!(preview_file(root.to_str().unwrap(), "src").is_err());
    }
}
