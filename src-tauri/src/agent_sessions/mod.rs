//! 读取 claude / codex 自己的会话存储，作为项目历史会话的唯一事实来源。
//!
//! PetGPT 不保存任何对话内容 —— 两个 CLI 都自带会话持久化和 resume，重复存
//! 一份只会多出一个会不一致的状态。这里只做三件事：列出属于某个项目的历史
//! 会话、在新会话落盘后认领它的 id、把 id 交给 `pty` 去 resume。
//!
//! 实测得到的两个前提（都影响设计，不要凭直觉改）：
//!
//! 1. **两个 CLI 都是懒写入**：会话文件要等用户发出第一条消息才落盘。启动
//!    那一刻没有 id 可绑，所以认领只能是延迟的。
//! 2. **claude 的目录名不能靠转义规则反推**：`/` 和空格都会变成 `-`，而且
//!    macOS 的 APFS 大小写不敏感，实际存下来的名字可能与 cwd 的大小写不同
//!    （本机就有 `Documents/Projects/PetGPT` 存成 `-Documents-projects-` 的
//!    例子）。所以改为读目录里会话文件的 `cwd` 字段来匹配。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 认领窗口：spawn 之后多久之内出现的会话文件才算这次会话的。
/// 超过就放弃认领，避免把用户在别处手动开的会话错认进来。
pub const CLAIM_WINDOW_SECS: i64 = 300;

/// 在一个 JSONL 文件头部最多读多少行来找 `cwd`。
/// claude 的首条记录是 `{mode, sessionId, type}`，没有 cwd，要往后翻几行。
const HEAD_LINES: usize = 40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRecord {
    /// CLI 自己的会话 id，可直接用于 `claude --resume` / `codex resume`
    pub agent_id: String,
    pub kind: String,
    /// 最后修改时间（毫秒）。用于排序与认领判定。
    pub modified_at: i64,
    pub size: u64,
    /// 会话里第一条真实的用户消息，用作界面上的标题。
    /// 会话刚建好、用户还没开口时为 None，界面退回显示 agent 名字。
    pub first_prompt: Option<String>,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn modified_millis(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 在 JSONL 头部若干行里找 `cwd`。
///
/// 逐行解析而不是整文件读：会话文件可以有几 MB（本机就有 7MB 的），
/// 为了一个字段把它全读进来很浪费。
pub fn extract_cwd_from_jsonl_head(head: &str) -> Option<String> {
    for line in head.lines().take(HEAD_LINES) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(cwd) = find_string_field(&value, "cwd") {
            if !cwd.trim().is_empty() {
                return Some(cwd);
            }
        }
    }
    None
}

/// 会话标题的长度上限。侧边栏一行放不下太多，长了也只是省略号。
const FIRST_PROMPT_MAX_CHARS: usize = 120;

/// 从 JSONL 头部找出第一条**真实的**用户消息，用作会话标题。
///
/// 两种格式都要处理：
///   claude —— 顶层 `type: "user"`，消息在 `message.content`（字符串或数组）
///   codex  —— `payload.role == "user"`，消息在 `payload.content[].text`
///
/// 关键是**跳过注入块**：两个 CLI 都会在真正的用户输入之前塞进环境上下文。
/// 实测 codex 的头几条 user 消息是 `<environment_context>` 和 `<model_switch>`，
/// claude 也会注入 `<system-reminder>` 之类。这些都以 `<` 开头，按此过滤后
/// 在两种格式下都能正确落到用户真正打的那句话上。
pub fn extract_first_prompt(head: &str) -> Option<String> {
    for line in head.lines().take(HEAD_LINES * 4) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let mut candidates: Vec<&serde_json::Value> = Vec::new();
        if value.get("type").and_then(|t| t.as_str()) == Some("user") {
            if let Some(content) = value.get("message").and_then(|m| m.get("content")) {
                candidates.push(content);
            }
        }
        if let Some(payload) = value.get("payload") {
            if payload.get("role").and_then(|r| r.as_str()) == Some("user") {
                if let Some(content) = payload.get("content") {
                    candidates.push(content);
                }
            }
        }

        for content in candidates {
            if let Some(text) = usable_prompt_text(content) {
                return Some(text);
            }
        }
    }
    None
}

fn usable_prompt_text(content: &serde_json::Value) -> Option<String> {
    let mut texts: Vec<&str> = Vec::new();
    match content {
        serde_json::Value::String(s) => texts.push(s),
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    texts.push(text);
                }
            }
        }
        _ => {}
    }
    for text in texts {
        let trimmed = text.trim();
        // 注入的上下文块一律以 < 开头，不是用户打的话
        if trimmed.is_empty() || trimmed.starts_with('<') {
            continue;
        }
        let mut out: String = trimmed.chars().take(FIRST_PROMPT_MAX_CHARS).collect();
        if trimmed.chars().count() > FIRST_PROMPT_MAX_CHARS {
            out.push('…');
        }
        // 标题只占一行，换行和制表符压成空格
        return Some(out.replace('\n', " ").replace('\r', " ").replace('\t', " "));
    }
    None
}

/// 深度查找某个字符串字段。codex 把 `cwd` 埋在 `payload` 里，claude 放在顶层，
/// 两种形状用同一个函数处理。
fn find_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(s)) = map.get(key) {
                return Some(s.clone());
            }
            for nested in map.values() {
                if let Some(found) = find_string_field(nested, key) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            items.iter().find_map(|item| find_string_field(item, key))
        }
        _ => None,
    }
}

/// 两个路径是否指同一个目录。
///
/// macOS 默认文件系统大小写不敏感，而 CLI 存下来的路径大小写可能与用户配置
/// 的项目路径不同，所以退回不分大小写的比较。尾部斜杠也要归一。
pub fn same_project_path(left: &str, right: &str) -> bool {
    let norm = |value: &str| {
        value
            .trim_end_matches('/')
            .to_lowercase()
    };
    !left.trim().is_empty() && norm(left) == norm(right)
}

/// `read_head` 最多读多少字节。只在单行异常大（一条消息塞了整个文件）时
/// 才会触顶，正常文件在读满 HEAD_LINES 行时就停了。
const HEAD_MAX_BYTES: u64 = 256 * 1024;

/// 读 JSONL 文件的头部若干行。
///
/// 按行懒读而不是无条件取 256KB：绝大多数会话文件的前 40 行只有几 KB，
/// 而这个函数会被扫描器对每个文件调用一次。本机 744 个 codex 会话，
/// 旧实现一次全量扫描要读掉 175MB（且每个文件都额外分配 256KB 再拷一次
/// String）；按行读之后同样的扫描只碰每个文件头部的一两个缓冲区。
fn read_head(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader, Read};
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file).take(HEAD_MAX_BYTES);
    let mut out = String::new();
    let mut raw = Vec::new();
    for _ in 0..HEAD_LINES {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => out.push_str(&String::from_utf8_lossy(&raw)),
            Err(_) => break,
        }
    }
    Some(out)
}

fn claude_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

fn codex_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex").join("sessions"))
}

/// 会话文件名里的 id。
///
/// claude：`<uuid>.jsonl`
/// codex： `rollout-<时间戳>-<uuid>.jsonl`，时间戳本身含短横线，所以取末尾
///         5 段（uuid 的固定结构）而不是简单 split。
pub fn session_id_from_file_name(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".jsonl")?;
    let stem = stem.strip_prefix("rollout-").unwrap_or(stem);
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() >= 5 {
        let tail = &parts[parts.len() - 5..];
        // uuid 的分段长度是 8-4-4-4-12
        let widths = [8usize, 4, 4, 4, 12];
        let looks_like_uuid = tail
            .iter()
            .zip(widths.iter())
            .all(|(seg, want)| seg.len() == *want && seg.chars().all(|c| c.is_ascii_hexdigit()));
        if looks_like_uuid {
            return Some(tail.join("-"));
        }
    }
    None
}

/// 列出某个项目在 claude 存储里的历史会话。
pub fn list_claude_sessions(project_path: &str) -> Vec<AgentSessionRecord> {
    list_claude_sessions_modified_since(project_path, 0)
}

/// 同上，但只返回 `modified_since`（毫秒，0 表示不限）之后落盘的会话。
/// 与 codex 侧同理，认领时把下界下推到扫描层可以省掉大部分 `read_head`。
pub fn list_claude_sessions_modified_since(
    project_path: &str,
    modified_since: i64,
) -> Vec<AgentSessionRecord> {
    let Some(root) = claude_root() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|items| {
                items
                    .flatten()
                    .map(|i| i.path())
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
                    .collect()
            })
            .unwrap_or_default();
        if files.is_empty() {
            continue;
        }

        // 用目录里任意一个会话文件的 cwd 来判断这个目录属不属于该项目，
        // 而不是去反推目录名的转义规则
        let belongs = files.iter().any(|file| {
            read_head(file)
                .as_deref()
                .and_then(extract_cwd_from_jsonl_head)
                .map(|cwd| same_project_path(&cwd, project_path))
                .unwrap_or(false)
        });
        if !belongs {
            continue;
        }

        for file in files {
            let Some(name) = file.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(agent_id) = session_id_from_file_name(name) else {
                continue;
            };
            let modified_at = modified_millis(&file);
            if modified_at <= modified_since {
                continue;
            }
            let first_prompt = read_head(&file)
                .as_deref()
                .and_then(extract_first_prompt);
            out.push(AgentSessionRecord {
                agent_id,
                kind: "claude".to_string(),
                modified_at,
                size: std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0),
                first_prompt,
            });
        }
        break;
    }

    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

/// 列出某个项目在 codex 存储里的历史会话。
///
/// codex 不按项目分目录，而是 `sessions/年/月/日/`，所以按日期倒序遍历、
/// 读每个文件的头部按 cwd 过滤。`limit` 限制最多收集多少条，避免在有上千
/// 个会话的机器上做全量扫描（本机已有 744 个）。
pub fn list_codex_sessions(project_path: &str, limit: usize) -> Vec<AgentSessionRecord> {
    list_codex_sessions_modified_since(project_path, limit, 0)
}

/// 同上，但只看 `modified_since`（毫秒，0 表示不限）之后落盘的文件。
///
/// 认领场景专用。认领只可能认走 spawn 之后出现的会话（`pick_claim_candidate`
/// 同样会过滤 `modified_at > spawned_at`），所以把这个下界下推到扫描层是
/// 语义等价的，但能把「读 744 个文件的头部」压到「读刚变动的那一两个」。
pub fn list_codex_sessions_modified_since(
    project_path: &str,
    limit: usize,
    modified_since: i64,
) -> Vec<AgentSessionRecord> {
    let Some(root) = codex_root() else {
        return Vec::new();
    };

    // mtime 在收集时就一并取回。放在 sort 的比较函数里取意味着每次比较都要
    // 做一次 stat —— 744 个文件排一次序就是 7480 次系统调用而不是 744 次。
    let mut files: Vec<(PathBuf, i64)> = Vec::new();
    collect_jsonl_desc(&root, &mut files, 4);
    files.retain(|(_, modified)| *modified > modified_since);
    files.sort_by(|a, b| b.1.cmp(&a.1));

    let mut out = Vec::new();
    for (file, modified_at) in files {
        if out.len() >= limit {
            break;
        }
        let Some(head) = read_head(&file) else {
            continue;
        };
        let Some(cwd) = extract_cwd_from_jsonl_head(&head) else {
            continue;
        };
        if !same_project_path(&cwd, project_path) {
            continue;
        }
        let agent_id = find_string_field(
            &head
                .lines()
                .next()
                .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                .unwrap_or(serde_json::Value::Null),
            "id",
        )
        .filter(|id| id.len() >= 32)
        .or_else(|| {
            file.file_name()
                .and_then(|n| n.to_str())
                .and_then(session_id_from_file_name)
        });
        let Some(agent_id) = agent_id else { continue };

        out.push(AgentSessionRecord {
            agent_id,
            kind: "codex".to_string(),
            modified_at,
            size: std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0),
            first_prompt: extract_first_prompt(&head),
        });
    }
    out
}

/// 收集 `.jsonl` 路径，顺带带回每个文件的 mtime（毫秒）。
///
/// mtime 在这里取而不是留给调用方，是因为唯一的调用方要按它排序 ——
/// 放在比较函数里会让 stat 次数从 O(n) 变成 O(n log n)。
fn collect_jsonl_desc(dir: &Path, out: &mut Vec<(PathBuf, i64)>, depth: usize) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // DirEntry 自带的 metadata 走的是 readdir 已经拿到的信息，
        // 比对 path 再 stat 一次便宜
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or_else(|| path.is_dir());
        if is_dir {
            dirs.push(path);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let modified = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push((path, modified));
        }
    }
    // 目录名是年/月/日，倒序遍历让最近的会话先被收集
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for sub in dirs {
        collect_jsonl_desc(&sub, out, depth - 1);
    }
}

/// 从候选会话里挑出该次 spawn 应该认领的那一条。
///
/// 纯函数，认领规则本身可验证：
///   * 只认 spawn 之后落盘的（`modified_at > spawned_at`）
///   * 只认认领窗口内的，超时放弃，避免错认用户在别处开的会话
///   * 只认同类型的
///   * 排除已经被别的 pane 绑定过的 id
///   * 多个候选时取最早出现的那个 —— 串行认领保证同一时刻只有一个 pane
///     在等，最早出现的必然是它的
pub fn pick_claim_candidate(
    candidates: &[AgentSessionRecord],
    kind: &str,
    spawned_at: i64,
    now: i64,
    already_bound: &[String],
) -> Option<String> {
    if now - spawned_at > CLAIM_WINDOW_SECS * 1000 {
        return None;
    }
    candidates
        .iter()
        .filter(|record| record.kind == kind)
        .filter(|record| record.modified_at > spawned_at)
        .filter(|record| !already_bound.iter().any(|bound| bound == &record.agent_id))
        .min_by_key(|record| record.modified_at)
        .map(|record| record.agent_id.clone())
}

/// 列出某个项目的全部历史会话（两种 agent 合并，按时间倒序）。
/// `shell` 不入历史 —— 一个 bash 会话没有可恢复的语义。
pub fn list_project_sessions(project_path: &str, codex_limit: usize) -> Vec<AgentSessionRecord> {
    let mut out = list_claude_sessions(project_path);
    out.extend(list_codex_sessions(project_path, codex_limit));
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

/// 认领用的候选列表。与 `list_project_sessions` 的区别是它不需要大 limit，
/// 也不需要看历史：认领只关心 `spawned_at` 之后才出现的那一条，所以把这个
/// 下界交给扫描层去过滤，而不是全扫完再由 `pick_claim_candidate` 丢掉。
///
/// 这条路径会被认领轮询反复调用，是唯一一个真的需要在意扫描成本的地方。
pub fn claim_candidates(project_path: &str, spawned_at: i64) -> Vec<AgentSessionRecord> {
    let mut out = list_claude_sessions_modified_since(project_path, spawned_at);
    out.extend(list_codex_sessions_modified_since(
        project_path,
        16,
        spawned_at,
    ));
    out
}

pub fn claim_now() -> i64 {
    now_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, kind: &str, modified_at: i64) -> AgentSessionRecord {
        AgentSessionRecord {
            agent_id: id.to_string(),
            kind: kind.to_string(),
            modified_at,
            size: 1,
            first_prompt: None,
        }
    }

    #[test]
    fn cwd_is_found_even_when_the_first_record_does_not_carry_it() {
        // claude 的首条记录实测是 {mode, sessionId, type}，没有 cwd
        let head = concat!(
            r#"{"type":"mode","sessionId":"abc","mode":"default"}"#,
            "\n",
            r#"{"type":"user","cwd":"/Users/jules/Documents/Projects/PetGPT","message":{}}"#,
            "\n",
        );
        assert_eq!(
            extract_cwd_from_jsonl_head(head).as_deref(),
            Some("/Users/jules/Documents/Projects/PetGPT"),
        );
    }

    #[test]
    fn a_nested_cwd_is_found_too() {
        // codex 把 cwd 埋在 payload 里
        let head = r#"{"type":"session_meta","payload":{"id":"x","cwd":"/tmp/demo"}}"#;
        assert_eq!(extract_cwd_from_jsonl_head(head).as_deref(), Some("/tmp/demo"));
    }

    #[test]
    fn a_head_without_cwd_or_with_broken_json_yields_nothing() {
        assert!(extract_cwd_from_jsonl_head("").is_none());
        assert!(extract_cwd_from_jsonl_head("not json at all").is_none());
        assert!(extract_cwd_from_jsonl_head(r#"{"type":"mode"}"#).is_none());
        // 空 cwd 不算
        assert!(extract_cwd_from_jsonl_head(r#"{"cwd":"  "}"#).is_none());
    }

    #[test]
    fn project_paths_match_case_insensitively() {
        // 本机实测：Documents/Projects/PetGPT 被存成了 -Documents-projects-PetGPT，
        // APFS 大小写不敏感，所以必须忽略大小写
        assert!(same_project_path(
            "/Users/jules/Documents/Projects/PetGPT",
            "/Users/jules/Documents/projects/PetGPT",
        ));
        assert!(same_project_path("/tmp/demo/", "/tmp/demo"));
        assert!(!same_project_path("/tmp/demo", "/tmp/other"));
        assert!(!same_project_path("", "/tmp/demo"));
    }

    #[test]
    fn session_ids_are_recovered_from_both_file_name_shapes() {
        assert_eq!(
            session_id_from_file_name("9132b4ab-2762-433d-a1e9-1170a52e7a73.jsonl").as_deref(),
            Some("9132b4ab-2762-433d-a1e9-1170a52e7a73"),
        );
        // codex 的时间戳本身含短横线，简单 split 会切错
        assert_eq!(
            session_id_from_file_name(
                "rollout-2026-09-04T15-39-19-01a06dee-c42b-7073-a809-3054b6baf0a7.jsonl"
            )
            .as_deref(),
            Some("01a06dee-c42b-7073-a809-3054b6baf0a7"),
        );
    }

    #[test]
    fn non_session_file_names_are_rejected() {
        assert!(session_id_from_file_name("memory").is_none());
        assert!(session_id_from_file_name("notes.txt").is_none());
        assert!(session_id_from_file_name("short.jsonl").is_none());
        // 段数够但不是 16 进制
        assert!(session_id_from_file_name("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz.jsonl").is_none());
    }

    #[test]
    fn the_title_comes_from_the_first_real_user_message() {
        // claude 的形状：顶层 type=user，content 是字符串
        let claude = concat!(
            r#"{"type":"mode","sessionId":"x","mode":"default"}"#, "\n",
            r#"{"type":"user","message":{"role":"user","content":"理解这个项目"}}"#, "\n",
        );
        assert_eq!(extract_first_prompt(claude).as_deref(), Some("理解这个项目"));

        // codex 的形状：payload.role=user，content 是数组
        let codex = concat!(
            r#"{"type":"session_meta","payload":{"cwd":"/tmp"}}"#, "\n",
            r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"写个脚本"}]}}"#, "\n",
        );
        assert_eq!(extract_first_prompt(codex).as_deref(), Some("写个脚本"));
    }

    #[test]
    fn injected_context_blocks_are_skipped_so_the_title_is_what_the_user_typed() {
        // 实测：codex 真正的用户输入前面有两条注入消息，
        // claude 也会注入 system-reminder。都以 < 开头。
        let head = concat!(
            r#"{"type":"response_item","payload":{"role":"developer","content":[{"text":"<model_switch>..."}]}}"#, "\n",
            r#"{"type":"response_item","payload":{"role":"user","content":[{"text":"<environment_context>\n <cwd>/tmp</cwd>"}]}}"#, "\n",
            r#"{"type":"response_item","payload":{"role":"user","content":[{"text":"理解这个项目"}]}}"#, "\n",
        );
        assert_eq!(extract_first_prompt(head).as_deref(), Some("理解这个项目"));
    }

    #[test]
    fn a_long_prompt_is_truncated_and_flattened_to_one_line() {
        let long = "啊".repeat(FIRST_PROMPT_MAX_CHARS + 50);
        let head = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}}}}"#,
            long
        );
        let title = extract_first_prompt(&head).unwrap();
        // 按字符截断而不是字节 —— 按字节切会把中文劈断
        assert_eq!(title.chars().count(), FIRST_PROMPT_MAX_CHARS + 1, "含省略号");
        assert!(title.ends_with('…'));

        let multiline = r#"{"type":"user","message":{"role":"user","content":"第一行\n第二行"}}"#;
        let flat = extract_first_prompt(multiline).unwrap();
        assert!(!flat.contains('\n'), "标题只占一行");
        assert_eq!(flat, "第一行 第二行");
    }

    #[test]
    fn a_session_with_no_user_message_yet_has_no_title() {
        // 会话文件刚建好、用户还没说话
        assert!(extract_first_prompt(r#"{"type":"mode","sessionId":"x"}"#).is_none());
        assert!(extract_first_prompt("").is_none());
        // 只有助手消息也不算
        assert!(extract_first_prompt(r#"{"type":"assistant","message":{"content":"hi"}}"#).is_none());
    }

    #[test]
    fn a_claim_takes_the_first_session_written_after_the_spawn() {
        let spawned = 1_000;
        let candidates = vec![
            record("old", "claude", 500),   // spawn 之前就存在
            record("mine", "claude", 1_200),
            record("later", "claude", 1_500),
        ];
        assert_eq!(
            pick_claim_candidate(&candidates, "claude", spawned, 2_000, &[]).as_deref(),
            Some("mine"),
        );
    }

    #[test]
    fn a_claim_never_takes_a_session_that_predates_the_spawn() {
        let candidates = vec![record("old", "claude", 500)];
        assert!(pick_claim_candidate(&candidates, "claude", 1_000, 2_000, &[]).is_none());
    }

    #[test]
    fn a_claim_ignores_the_other_agent_kind() {
        let candidates = vec![record("codex-one", "codex", 1_200)];
        assert!(pick_claim_candidate(&candidates, "claude", 1_000, 2_000, &[]).is_none());
        assert_eq!(
            pick_claim_candidate(&candidates, "codex", 1_000, 2_000, &[]).as_deref(),
            Some("codex-one"),
        );
    }

    #[test]
    fn a_session_already_bound_to_another_pane_is_not_claimed_twice() {
        let candidates = vec![record("taken", "claude", 1_100), record("free", "claude", 1_300)];
        assert_eq!(
            pick_claim_candidate(&candidates, "claude", 1_000, 2_000, &["taken".to_string()])
                .as_deref(),
            Some("free"),
        );
    }

    #[test]
    fn the_claim_window_expires_so_a_later_manual_session_is_not_stolen() {
        let spawned = 1_000;
        let candidates = vec![record("much-later", "claude", spawned + 10_000)];
        let past_window = spawned + CLAIM_WINDOW_SECS * 1000 + 1;
        assert!(pick_claim_candidate(&candidates, "claude", spawned, past_window, &[]).is_none());
        // 窗口内仍然认领
        assert!(pick_claim_candidate(&candidates, "claude", spawned, spawned + 20_000, &[]).is_some());
    }

    #[test]
    fn an_empty_candidate_list_claims_nothing() {
        assert!(pick_claim_candidate(&[], "claude", 1_000, 1_100, &[]).is_none());
    }

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("petgpt-head-{name}"));
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn reading_a_head_stops_at_the_line_budget_instead_of_swallowing_the_file() {
        // 头部是正常的短 JSONL，后面跟着几 MB 的正文 —— 真实会话文件就长这样。
        // 旧实现无条件取 256KB，扫描上千个文件时这笔 I/O 会累成几百 MB。
        let mut body = String::new();
        for i in 0..HEAD_LINES + 200 {
            body.push_str(&format!(r#"{{"type":"user","n":{i}}}"#));
            body.push('\n');
        }
        let tail_marker = "\"NEEDLE_PAST_THE_HEAD\"";
        body.push_str(&"x".repeat(3 * 1024 * 1024));
        body.push_str(tail_marker);
        let path = temp_file("budget.jsonl", body.as_bytes());

        let head = read_head(&path).unwrap();
        assert_eq!(head.lines().count(), HEAD_LINES);
        assert!(!head.contains("NEEDLE_PAST_THE_HEAD"));
        // 40 行短 JSON 远小于旧实现固定读走的 256KB
        assert!(head.len() < 8 * 1024, "头部读了 {} 字节", head.len());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_single_oversized_line_cannot_read_past_the_byte_ceiling() {
        // 一条塞了整个文件内容的消息可以有几 MB，行预算拦不住它，靠字节上限兜底
        let mut body = String::from("{\"pad\":\"");
        body.push_str(&"y".repeat(2 * HEAD_MAX_BYTES as usize));
        body.push_str("\"}\n");
        let path = temp_file("oneline.jsonl", body.as_bytes());

        let head = read_head(&path).unwrap();
        assert!(
            head.len() as u64 <= HEAD_MAX_BYTES,
            "读了 {} 字节，超过上限 {HEAD_MAX_BYTES}",
            head.len(),
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn an_empty_file_yields_an_empty_head_rather_than_an_error() {
        let path = temp_file("empty.jsonl", b"");
        assert_eq!(read_head(&path).as_deref(), Some(""));
        std::fs::remove_file(&path).ok();
    }
}

#[cfg(test)]
mod live_store_probe {
    use super::*;

    /// 对本机真实存储跑一次，确认扫描能命中当前项目。
    /// 存储为空时自动跳过，不会在别人的机器上误报失败。
    #[test]
    fn scanning_the_real_store_finds_this_project_when_it_has_history() {
        let project = "/Users/jules/Documents/Projects/PetGPT";
        if !std::path::Path::new(project).is_dir() {
            return;
        }
        let claude = list_claude_sessions(project);
        let codex = list_codex_sessions(project, 8);
        eprintln!("  claude 命中 {} 条, codex 命中 {} 条", claude.len(), codex.len());
        for r in claude.iter().take(2) {
            eprintln!("    claude {} ({} bytes)", r.agent_id, r.size);
        }
        for r in codex.iter().take(2) {
            eprintln!("    codex  {} ({} bytes)", r.agent_id, r.size);
        }
        // 两个 id 都必须长得像 uuid，否则 resume 会失败
        for r in claude.iter().chain(codex.iter()) {
            assert_eq!(r.agent_id.len(), 36, "id 应为 uuid: {}", r.agent_id);
            assert!(r.modified_at > 0);
        }
        // 结果必须按时间倒序
        let merged = list_project_sessions(project, 8);
        for pair in merged.windows(2) {
            assert!(pair[0].modified_at >= pair[1].modified_at);
        }
    }

    /// 认领路径把 `spawned_at` 下推到扫描层。下界取未来时刻时必须什么都不返回 ——
    /// 这正是认领轮询在「会话文件还没落盘」期间反复走的那条路径，它不该去
    /// 读任何文件的头部。
    #[test]
    fn claiming_with_a_future_lower_bound_scans_nothing() {
        let project = "/Users/jules/Documents/Projects/PetGPT";
        if !std::path::Path::new(project).is_dir() {
            return;
        }
        let future = now_millis() + 60_000;
        assert!(claim_candidates(project, future).is_empty());
    }

    /// 下界为 0 时行为必须与不带下界的老接口完全一致，否则历史列表会缺条目。
    #[test]
    fn a_zero_lower_bound_is_the_same_as_no_bound() {
        let project = "/Users/jules/Documents/Projects/PetGPT";
        if !std::path::Path::new(project).is_dir() {
            return;
        }
        let bounded: Vec<String> = list_codex_sessions_modified_since(project, 8, 0)
            .into_iter()
            .map(|r| r.agent_id)
            .collect();
        let plain: Vec<String> = list_codex_sessions(project, 8)
            .into_iter()
            .map(|r| r.agent_id)
            .collect();
        assert_eq!(bounded, plain);
    }
}
