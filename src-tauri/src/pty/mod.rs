//! 交互式 PTY 会话管理
//!
//! 与 `subagent` 模块的区别：subagent 起的是 `claude -p` 一次性批处理进程，
//! stdout 直接丢弃、无 stdin。这里起的是**活着的伪终端**，前端用 xterm.js
//! 渲染，按键写回 stdin，窗口变化同步 SIGWINCH。两者不能互相替代。
//!
//! 输出通过 `pty-output` 事件推给前端。读取线程按字节读，跨 chunk 的多字节
//! UTF-8 序列会被暂存到下一次，避免把一个汉字劈成两半送出去。读取与发送是
//! 分开的两个线程，中间隔一层合并缓冲 —— 原因见 `OUTPUT_FLUSH_INTERVAL`。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 一次 read 最多取多少字节。
const OUTPUT_CHUNK_MAX: usize = 8 * 1024;

/// 两次 `pty-output` 事件之间的最小间隔。
///
/// Tauri 的事件不是共享内存，而是把 payload 拼进一段 JS 源码再
/// `evaluateJavaScript` 注入 webview（见 tauri 的 `emit_js_script`），
/// 所以每个事件都要 webview 完整 parse + compile 一次一次性脚本，而 ANSI
/// 转义在 JSON 里还会膨胀成 ``。agent 的 TUI 刷屏时 PTY 每秒 read
/// 上百次，逐次 emit 等于每秒上百次跨进程注入 —— 主线程被这条路径占满，
/// 连带整个界面（不只是终端）一起卡。
///
/// 这里做的是 leading-edge 限流而不是延迟：空闲时第一段输出立刻发走，
/// 按键回显不会多等；只有在持续刷屏时才把一个窗口内的输出攒成一个事件。
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// 读取线程与发送线程之间的合并缓冲。
#[derive(Default)]
struct Pending {
    /// 上次 flush 之后攒下的输出
    buf: String,
    /// `buf` 末尾对应的 scrollback 偏移
    seq: u64,
    /// 读取线程已经结束（EOF 或出错），发送线程排空后就该退出
    closed: bool,
}

impl Pending {
    fn push(&mut self, chunk: &str, seq: u64) {
        self.buf.push_str(chunk);
        // 合并后的事件只带最后一段的偏移：前端拿它与快照的 seq 比大小做去重，
        // 中间那些偏移没有意义 —— 它们覆盖的内容都在这一个事件里。
        self.seq = seq;
    }

    /// 取走攒下的输出。空缓冲返回 None，避免发出空事件。
    fn take(&mut self) -> Option<(String, u64)> {
        if self.buf.is_empty() {
            return None;
        }
        Some((std::mem::take(&mut self.buf), self.seq))
    }
}

/// 每个会话保留多少字节的回滚缓冲。
///
/// 关掉 project 标签时 xterm 会被 dispose，但进程还在跑 —— 这段时间的输出
/// 必须留住，否则重新打开时新建的空 xterm 会接到一段做局部重绘的 TUI 输出，
/// 屏幕就花了。512KB 够放下相当长的一段 agent 输出。
const SCROLLBACK_MAX_BYTES: usize = 512 * 1024;

#[derive(Clone, Serialize)]
pub struct PtyOutputPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub data: String,
    /// 这一段输出的结束偏移，与 `PtySnapshot.seq` 同一坐标系
    pub seq: u64,
}

#[derive(Clone, Serialize)]
pub struct PtyExitPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
}

#[derive(Clone, Serialize)]
pub struct PtySessionInfo {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
}

struct PtySession {
    project_id: String,
    kind: String,
    title: String,
    cols: u16,
    rows: u16,
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 子进程 pid。杀会话时要对**整个进程组**发信号，不能只杀这一个 pid：
    /// claude 和 codex 实际上是 shell 包装脚本，真正的 node 进程挂在它下面，
    /// 只杀包装脚本会留下孤儿（实测确认过）。
    child_pid: Option<u32>,
    /// spawn 时刻（毫秒）。认领 agent 会话 id 时用来判断哪个会话文件是
    /// 这次启动产生的 —— 两个 CLI 都是懒写入，文件要等第一条消息才出现。
    spawned_at: i64,
    /// 回滚缓冲与累计写入偏移。偏移让前端能分辨「快照里已包含的输出」和
    /// 「快照之后才到达的输出」，避免重放时把同一段写两遍。
    scrollback: Arc<Mutex<Scrollback>>,
    alive: Arc<Mutex<bool>>,
}

#[derive(Default)]
struct Scrollback {
    data: String,
    /// 自会话开始以来写出的总字节数（不因裁剪而回退）
    written: u64,
}

impl Scrollback {
    fn push(&mut self, chunk: &str) -> u64 {
        self.data.push_str(chunk);
        self.written += chunk.len() as u64;
        if self.data.len() > SCROLLBACK_MAX_BYTES {
            // 从头裁掉超出的部分，但必须落在 UTF-8 字符边界上，
            // 否则 String 会 panic
            let overflow = self.data.len() - SCROLLBACK_MAX_BYTES;
            let mut cut = overflow;
            while cut < self.data.len() && !self.data.is_char_boundary(cut) {
                cut += 1;
            }
            self.data.drain(..cut);
        }
        self.written
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySnapshot {
    pub data: String,
    /// 快照包含的输出截止偏移。前端只重放 seq 大于它的实时事件。
    pub seq: u64,
}

/// 终止一个会话及其全部后代。
///
/// PTY 的 slave 会让子进程成为会话首进程，pgid == pid，所以对 -pid 发信号
/// 就覆盖了它拉起的所有子孙。先 SIGHUP（等同于用户关掉终端窗口，TUI 会
/// 走正常退出路径把终端状态恢复），再 SIGKILL 兜底。
fn terminate_session(session: &mut PtySession) {
    #[cfg(unix)]
    if let Some(pid) = session.child_pid {
        let pgid = pid as i32;
        unsafe {
            libc::killpg(pgid, libc::SIGHUP);
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
    // Windows 没有进程组信号这套东西，退回 killer；
    // unix 上也调一次，兜住 killpg 因为进程已退出而失败的情况。
    let _ = session.killer.kill();
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 会话类型 → 要执行的命令。
///
/// `claude` 和 `codex` 这里都以**交互模式**启动（不带 `-p`），因为整个
/// 目的就是得到一个能继续对话的活会话。
fn command_for_kind(
    kind: &str,
    shell: Option<&str>,
    resume_id: Option<&str>,
) -> Result<CommandBuilder, String> {
    let resume = resume_id.map(str::trim).filter(|id| !id.is_empty());
    let mut cmd = match kind {
        "claude" => {
            let mut c = CommandBuilder::new("claude");
            // claude 的恢复是一个选项：`claude --resume <session-id>`
            if let Some(id) = resume {
                c.arg("--resume");
                c.arg(id);
            }
            c
        }
        "codex" => {
            let mut c = CommandBuilder::new("codex");
            // codex 的恢复是一个子命令：`codex resume <SESSION_ID>`
            if let Some(id) = resume {
                c.arg("resume");
                c.arg(id);
            }
            c
        }
        "shell" => {
            // 纯终端没有可恢复的会话语义，显式拒绝而不是静默忽略
            if resume.is_some() {
                return Err("Terminal sessions cannot be resumed".to_string());
            }
            let program = shell
                .map(|s| s.to_string())
                .or_else(|| std::env::var("SHELL").ok())
                .unwrap_or_else(|| "/bin/bash".to_string());
            let mut c = CommandBuilder::new(program);
            // 登录 shell，这样用户的 PATH 和别名跟他在 Terminal.app 里一致
            c.arg("-l");
            c
        }
        other => return Err(format!("Unknown session kind: {other}")),
    };

    // TERM 必须设置，否则 claude/codex 的 TUI 会退化成哑终端模式
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // PATH 必须显式给：打包后的 .app 由 launchd 拉起，进程 PATH 只有
    // /usr/bin:/bin:/usr/sbin:/sbin，claude 和 codex 都不在里面。
    // 从终端跑 tauri dev 时看不出问题，因为那时继承的是终端的 PATH。
    cmd.env("PATH", crate::shell_env::augmented_path());
    Ok(cmd)
}

pub fn default_title_for_kind(kind: &str) -> &'static str {
    match kind {
        "claude" => "Claude",
        "codex" => "Codex",
        "shell" => "Terminal",
        _ => "Session",
    }
}

#[tauri::command]
pub fn pty_spawn(
    manager: tauri::State<'_, Arc<PtyManager>>,
    app: AppHandle,
    session_id: String,
    project_id: String,
    cwd: String,
    kind: String,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    resume_id: Option<String>,
) -> Result<PtySessionInfo, String> {
    {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&session_id) {
            return Err(format!("Session '{session_id}' already exists"));
        }
    }

    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Working directory does not exist: {cwd}"));
    }

    let cols = cols.unwrap_or(80).max(20);
    let rows = rows.unwrap_or(24).max(4);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = command_for_kind(&kind, shell.as_deref(), resume_id.as_deref())?;
    cmd.cwd(cwd_path);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to start {kind}: {e}"))?;
    // slave 必须尽早释放，否则进程退出后读端收不到 EOF
    drop(pair.slave);

    let killer = child.clone_killer();
    let child_pid = child.process_id();
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let alive = Arc::new(Mutex::new(true));
    let scrollback = Arc::new(Mutex::new(Scrollback::default()));
    let title = default_title_for_kind(&kind).to_string();

    let info = PtySessionInfo {
        id: session_id.clone(),
        project_id: project_id.clone(),
        kind: kind.clone(),
        title: title.clone(),
        cols,
        rows,
        alive: true,
    };

    {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            session_id.clone(),
            PtySession {
                project_id,
                kind,
                title,
                cols,
                rows,
                writer,
                master: pair.master,
                killer,
                child_pid,
                spawned_at: chrono::Utc::now().timestamp_millis(),
                scrollback: scrollback.clone(),
                alive: alive.clone(),
            },
        );
    }

    // 读取线程：解码 PTY 输出，写进 scrollback 和合并缓冲。
    // 它自己不 emit —— emit 要跨进程注入 JS，不能卡在读取路径上。
    let scrollback_read = scrollback;
    let pending: Arc<(Mutex<Pending>, Condvar)> =
        Arc::new((Mutex::new(Pending::default()), Condvar::new()));
    let pending_read = pending.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; OUTPUT_CHUNK_MAX];
        // 跨 read 边界被截断的多字节 UTF-8 序列暂存在这里
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut bytes = std::mem::take(&mut carry);
                    bytes.extend_from_slice(&buf[..n]);
                    let text = match std::str::from_utf8(&bytes) {
                        Ok(s) => s.to_string(),
                        Err(e) => {
                            let valid_up_to = e.valid_up_to();
                            // 尾部不完整的序列留到下一轮再拼
                            carry = bytes[valid_up_to..].to_vec();
                            // 残留过长说明不是截断而是真的非 UTF-8 数据，丢弃避免无限增长
                            if carry.len() > 8 {
                                carry.clear();
                            }
                            String::from_utf8_lossy(&bytes[..valid_up_to]).to_string()
                        }
                    };
                    if !text.is_empty() {
                        // 先写缓冲再入队：事件带回的 seq 必然已经包含在
                        // 缓冲里，前端据此去重不会漏也不会重
                        let seq = scrollback_read
                            .lock()
                            .map(|mut sb| sb.push(&text))
                            .unwrap_or(0);
                        let (lock, cvar) = &*pending_read;
                        if let Ok(mut p) = lock.lock() {
                            p.push(&text, seq);
                        }
                        cvar.notify_one();
                    }
                }
                Err(_) => break,
            }
        }
        // 通知发送线程排空后退出，否则它会永远挂在 wait 上
        let (lock, cvar) = &*pending_read;
        if let Ok(mut p) = lock.lock() {
            p.closed = true;
        }
        cvar.notify_one();
    });

    // 发送线程：把合并缓冲里的输出按 OUTPUT_FLUSH_INTERVAL 限流后发给前端
    let app_emit = app.clone();
    let id_emit = session_id.clone();
    let pending_emit = pending;
    std::thread::spawn(move || {
        let (lock, cvar) = &*pending_emit;
        loop {
            let Some((chunk, seq)) = ({
                let Ok(mut p) = lock.lock() else { break };
                // 空闲时阻塞在这里，不轮询；有数据立刻醒
                while p.buf.is_empty() && !p.closed {
                    p = match cvar.wait(p) {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                }
                p.take()
            }) else {
                // take 为空只可能是 closed 且已排空
                break;
            };
            let _ = app_emit.emit(
                "pty-output",
                PtyOutputPayload {
                    session_id: id_emit.clone(),
                    data: chunk,
                    seq,
                },
            );
            // 发完歇一个窗口。这期间到达的输出攒在 pending 里，下一轮一次发走；
            // 空闲时上面的 wait 会立刻返回，所以这不会给按键回显加延迟。
            std::thread::sleep(OUTPUT_FLUSH_INTERVAL);
        }
    });

    // 等待线程：进程退出时标记死亡并通知前端
    let app_wait = app.clone();
    let id_wait = session_id.clone();
    let alive_wait = alive;
    std::thread::spawn(move || {
        let mut child = child;
        let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
        if let Ok(mut flag) = alive_wait.lock() {
            *flag = false;
        }
        let _ = app_wait.emit(
            "pty-exit",
            PtyExitPayload {
                session_id: id_wait,
                exit_code,
            },
        );
    });

    Ok(info)
}

#[tauri::command]
pub fn pty_write(
    manager: tauri::State<'_, Arc<PtyManager>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' does not exist"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {e}"))
}

/// 同步终端尺寸。不调用这个，TUI 会按建立时的尺寸排版而错位。
#[tauri::command]
pub fn pty_resize(
    manager: tauri::State<'_, Arc<PtyManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cols = cols.max(20);
    let rows = rows.max(4);
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session '{session_id}' does not exist"))?;
    if session.cols == cols && session.rows == rows {
        return Ok(());
    }
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {e}"))?;
    session.cols = cols;
    session.rows = rows;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(
    manager: tauri::State<'_, Arc<PtyManager>>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        terminate_session(&mut session);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_list(
    manager: tauri::State<'_, Arc<PtyManager>>,
    project_id: Option<String>,
) -> Result<Vec<PtySessionInfo>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let mut out: Vec<PtySessionInfo> = sessions
        .iter()
        .filter(|(_, s)| {
            project_id
                .as_ref()
                .map(|pid| &s.project_id == pid)
                .unwrap_or(true)
        })
        .map(|(id, s)| PtySessionInfo {
            id: id.clone(),
            project_id: s.project_id.clone(),
            kind: s.kind.clone(),
            title: s.title.clone(),
            cols: s.cols,
            rows: s.rows,
            alive: s.alive.lock().map(|f| *f).unwrap_or(false),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// 取回某个会话到目前为止的输出，用于重新附着时回放。
///
/// 关掉 project 标签再打开时，新建的 xterm 是空的；先把这份快照写进去，
/// TUI 后续的局部重绘才有正确的屏幕状态可依附。
#[tauri::command]
pub fn pty_snapshot(
    manager: tauri::State<'_, Arc<PtyManager>>,
    session_id: String,
) -> Result<Option<PtySnapshot>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let Some(session) = sessions.get(&session_id) else {
        return Ok(None);
    };
    let sb = session.scrollback.lock().map_err(|e| e.to_string())?;
    Ok(Some(PtySnapshot {
        data: sb.data.clone(),
        seq: sb.written,
    }))
}

/// 某个会话的 spawn 时刻，认领 agent id 时要用。
#[tauri::command]
pub fn pty_spawned_at(
    manager: tauri::State<'_, Arc<PtyManager>>,
    session_id: String,
) -> Result<Option<i64>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.get(&session_id).map(|s| s.spawned_at))
}

/// 关闭某个项目的全部会话（关闭 project 标签时调用）。
#[tauri::command]
pub fn pty_kill_project(
    manager: tauri::State<'_, Arc<PtyManager>>,
    project_id: String,
) -> Result<usize, String> {
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let ids: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| s.project_id == project_id)
        .map(|(id, _)| id.clone())
        .collect();
    let count = ids.len();
    for id in ids {
        if let Some(mut session) = sessions.remove(&id) {
            terminate_session(&mut session);
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_kinds_map_to_titles() {
        assert_eq!(default_title_for_kind("claude"), "Claude");
        assert_eq!(default_title_for_kind("codex"), "Codex");
        assert_eq!(default_title_for_kind("shell"), "Terminal");
        assert_eq!(default_title_for_kind("nope"), "Session");
    }

    #[test]
    fn an_unknown_kind_is_rejected_before_spawning_anything() {
        assert!(command_for_kind("rm-rf", None, None).is_err());
        assert!(command_for_kind("claude", None, None).is_ok());
        assert!(command_for_kind("codex", None, None).is_ok());
        assert!(command_for_kind("shell", Some("/bin/zsh"), None).is_ok());
    }

    #[test]
    fn resuming_is_accepted_for_agents_and_refused_for_a_plain_terminal() {
        assert!(command_for_kind("claude", None, Some("abc-123")).is_ok());
        assert!(command_for_kind("codex", None, Some("abc-123")).is_ok());
        // 纯终端没有可恢复的会话，显式报错而不是静默丢掉参数
        assert!(command_for_kind("shell", None, Some("abc-123")).is_err());
    }

    #[test]
    fn a_blank_resume_id_is_treated_as_no_resume() {
        // 前端传空串不应该变成 `claude --resume ""`
        assert!(command_for_kind("claude", None, Some("   ")).is_ok());
        assert!(command_for_kind("shell", None, Some("   ")).is_ok());
    }

    #[test]
    fn the_scrollback_reports_a_monotonic_offset() {
        let mut sb = Scrollback::default();
        assert_eq!(sb.push("abc"), 3);
        assert_eq!(sb.push("de"), 5);
        assert_eq!(sb.data, "abcde");
    }

    #[test]
    fn the_scrollback_trims_from_the_front_without_splitting_a_character() {
        let mut sb = Scrollback::default();
        // 用三字节的中文字符填满，裁剪点必须落在字符边界上，否则 drain 会 panic
        let chunk = "中".repeat(1000); // 3000 字节
        let mut total = 0u64;
        while sb.data.len() <= SCROLLBACK_MAX_BYTES {
            total = sb.push(&chunk);
        }
        total = sb.push(&chunk);
        assert!(sb.data.len() <= SCROLLBACK_MAX_BYTES + chunk.len());
        // 偏移不因裁剪而回退
        assert_eq!(total, sb.written);
        assert!(sb.written > SCROLLBACK_MAX_BYTES as u64);
        // 裁剪后内容仍是合法 UTF-8 且全是完整字符
        assert!(sb.data.chars().all(|c| c == '中'));
    }

    #[test]
    fn merging_preserves_order_and_reports_the_latest_offset() {
        let mut pending = Pending::default();
        pending.push("abc", 3);
        pending.push("de", 5);
        // 一个窗口内的多段输出合成一个事件，顺序不能乱，偏移取最后一段的 ——
        // 前端拿它跟快照 seq 比大小，取中间值会让快照之后的输出被当成重复丢掉
        assert_eq!(pending.take(), Some(("abcde".to_string(), 5)));
        // 取过之后就空了，不该再发一个空事件出去
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn an_empty_buffer_never_produces_an_event() {
        let mut pending = Pending::default();
        assert_eq!(pending.take(), None);
        pending.push("", 0);
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn a_fresh_manager_reports_no_sessions() {
        let manager = PtyManager::new();
        let sessions = manager.sessions.lock().unwrap();
        assert!(sessions.is_empty());
    }
}
