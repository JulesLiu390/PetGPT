//! 视频通话：宠物在一个窗口里「开口说话」。
//!
//! 听：麦克风（使用者本人）和电脑正在播放的声音（比如群语音里的其他人）各走一路，
//! 每路自己做 VAD 断句，每一句交给 Fish Audio ASR 转成文字，作为一条消息发给前端，
//! 前端把它当成群里的新消息喂进原本的社交工作流。
//!
//! 说：通话期间工作流的 send_message 不发到群里，而是合成语音交到这里播放。
//! 播放放在本进程里，这样采集电脑声音时能排除掉宠物自己的声音；播放前把音量包络
//! 发给通话窗口，分层皮肤按它张嘴。
//!
//! 没有回声消除：宠物说话时（以及说完后一小段）麦克风的断句直接丢掉；麦克风里的
//! 一句话如果大半时间电脑也在出声，多半是外放的声音被麦克风收进去了，也丢掉。
//!
//! 开始、挂断、播放都可以重复调：每通电话有自己的 call_id 和窗口，所有事件都带着
//! call_id，指名某一通的命令在那通已经结束后什么都不做。
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// VAD 和 ASR 用的采样率。
const RATE: u32 = 16_000;
/// 一帧 20 ms，webrtc-vad 支持的帧长之一。
const FRAME: usize = (RATE as usize) / 50;
const FRAME_MS: u64 = 20;
/// 宠物说完后这段时间里麦克风还会收到房间里的余音。
const SPEAKING_TAIL_MS: u64 = 400;
/// 麦克风的一句话有这么大比例和电脑声音重叠，就当成外放回声。
const ECHO_OVERLAP: f64 = 0.6;
/// 低于这个能量的帧不算说话，挡住空调、键盘这类 VAD 偶尔放过的噪声。
const ENERGY_GATE: f32 = 0.004;

/// 每通电话一扇窗口。不复用同一个 label：挂断时关窗是异步的，紧接着开的新通话
/// 会拿到那扇正在关的窗口。
fn call_window_label(call_id: u64) -> String {
    format!("call-{call_id}")
}

// ───────────────────────────── 断句 ─────────────────────────────

/// 断句参数，单位都是帧（20 ms）。
#[derive(Clone, Copy, Debug)]
pub struct SegmentRules {
    /// 连续这么多帧有声音才算开口，滤掉咳嗽、敲桌子。
    pub start_frames: usize,
    /// 静音这么久算一句说完。
    pub end_silence_frames: usize,
    /// 开口前保留的帧，免得吞掉第一个字。
    pub pre_roll_frames: usize,
    /// 有声帧少于这么多的整句丢掉。
    pub min_voiced_frames: usize,
    /// 一句最长这么多帧，超过就先切一刀，免得一直不停的背景声拖住识别。
    pub max_frames: usize,
}

impl Default for SegmentRules {
    fn default() -> Self {
        Self {
            start_frames: 3,
            // 0.46 s：再短会把一句话里的换气当成说完
            end_silence_frames: 23,
            pre_roll_frames: 10,
            min_voiced_frames: 15,
            max_frames: 15 * 50,
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Segment {
    pub samples: Vec<i16>,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, PartialEq)]
pub enum SegmentEvent {
    /// 开口了，start_ms 是这句（含前置）的起点。
    Started(u64),
    Finished(Segment),
    /// 开了口但太短，不算一句。
    Dropped,
}

/// 按逐帧的「有没有人声」切句子。纯状态机，方便测试。
pub struct Segmenter {
    rules: SegmentRules,
    pre_roll: VecDeque<Vec<i16>>,
    voiced_run: usize,
    active: Option<Active>,
}

struct Active {
    frames: Vec<Vec<i16>>,
    start_ms: u64,
    voiced: usize,
    silence: usize,
}

impl Segmenter {
    pub fn new(rules: SegmentRules) -> Self {
        Self { rules, pre_roll: VecDeque::new(), voiced_run: 0, active: None }
    }

    /// 丢掉进行中的句子（宠物在说话时麦克风用这个清空）。
    pub fn reset(&mut self) -> Option<SegmentEvent> {
        self.pre_roll.clear();
        self.voiced_run = 0;
        self.active.take().map(|_| SegmentEvent::Dropped)
    }

    /// `at_ms` 是这一帧结束的时刻。
    pub fn push(&mut self, frame: &[i16], voiced: bool, at_ms: u64) -> Option<SegmentEvent> {
        let rules = self.rules;
        if let Some(active) = self.active.as_mut() {
            active.frames.push(frame.to_vec());
            if voiced {
                active.voiced += 1;
                active.silence = 0;
            } else {
                active.silence += 1;
            }
            if active.silence >= rules.end_silence_frames || active.frames.len() >= rules.max_frames {
                return Some(self.finish(at_ms));
            }
            return None;
        }
        self.pre_roll.push_back(frame.to_vec());
        while self.pre_roll.len() > rules.pre_roll_frames + rules.start_frames {
            self.pre_roll.pop_front();
        }
        self.voiced_run = if voiced { self.voiced_run + 1 } else { 0 };
        if self.voiced_run < rules.start_frames {
            return None;
        }
        let frames: Vec<Vec<i16>> = self.pre_roll.drain(..).collect();
        let start_ms = at_ms.saturating_sub(frames.len() as u64 * FRAME_MS);
        self.voiced_run = 0;
        self.active = Some(Active { frames, start_ms, voiced: rules.start_frames, silence: 0 });
        Some(SegmentEvent::Started(start_ms))
    }

    fn finish(&mut self, at_ms: u64) -> SegmentEvent {
        let active = self.active.take().expect("finish without an active segment");
        if active.voiced < self.rules.min_voiced_frames {
            return SegmentEvent::Dropped;
        }
        // 结尾的静音留 100 ms 就够，其余不必送去识别
        let keep = active.frames.len() - active.silence.saturating_sub(5);
        let end_ms = at_ms - (active.frames.len() - keep) as u64 * FRAME_MS;
        let samples = active.frames[..keep].concat();
        SegmentEvent::Finished(Segment { samples, start_ms: active.start_ms, end_ms })
    }
}

/// 一段时间里有多大比例落在这些区间内。
pub fn overlap_ratio(start: u64, end: u64, intervals: &[(u64, u64)]) -> f64 {
    if end <= start {
        return 0.0;
    }
    let covered: u64 = intervals
        .iter()
        .map(|&(a, b)| b.min(end).saturating_sub(a.max(start)))
        .sum();
    (covered as f64 / (end - start) as f64).min(1.0)
}

/// 任意采样率的单声道 → 16 kHz：每个输出样本取它覆盖的那段输入的平均，顺带滤掉高频。
pub struct Resampler {
    step: f64,
    pending: Vec<f32>,
    position: f64,
}

impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        Self { step: f64::from(input_rate) / f64::from(RATE), pending: Vec::new(), position: 0.0 }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.pending.extend_from_slice(input);
        loop {
            let start = self.position.floor() as usize;
            let end = ((self.position + self.step).floor() as usize).max(start + 1);
            if end > self.pending.len() {
                break;
            }
            let window = &self.pending[start..end];
            out.push(window.iter().sum::<f32>() / window.len() as f32);
            self.position += self.step;
        }
        let consumed = (self.position.floor() as usize).min(self.pending.len());
        self.pending.drain(..consumed);
        self.position -= consumed as f64;
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// 每 `frame_ms` 一个 0..1 的响度，给嘴型用：按整段的峰值归一，再压一下让小声也看得出动。
pub fn speech_envelope(samples: &[f32], channels: usize, sample_rate: u32, frame_ms: u32) -> Vec<f32> {
    let channels = channels.max(1);
    let frame_len = ((sample_rate as usize * frame_ms as usize) / 1000).max(1) * channels;
    let levels: Vec<f32> = samples.chunks(frame_len).map(rms).collect();
    let peak = levels.iter().copied().fold(0.0f32, f32::max).max(0.02);
    levels.iter().map(|level| (level / peak).powf(0.7).clamp(0.0, 1.0)).collect()
}

// ───────────────────────────── 通话 ─────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallInfo {
    /// 每次接通都不一样。
    call_id: u64,
    pet_id: String,
    target_id: String,
    target_name: String,
    /// 这通电话的窗口 label。
    window: String,
}

enum Playback {
    Speak { audio: Vec<u8>, text: String },
    Stop,
}

struct Clock {
    started: Instant,
    started_epoch_ms: u64,
}

impl Clock {
    fn new() -> Self {
        let started_epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default();
        Self { started: Instant::now(), started_epoch_ms }
    }
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// 两路采集和播放线程共享的状态。
struct Shared {
    info: CallInfo,
    clock: Clock,
    stop: AtomicBool,
    /// 宠物正在说话。
    speaking: AtomicBool,
    /// 宠物上次说完的时刻（通话时钟）。
    spoke_until_ms: AtomicU64,
    /// 电脑声音里最近有人说话的时段，用来认出麦克风收进去的外放。
    system_speech: Mutex<SystemSpeech>,
    asr_key: String,
    http: reqwest::Client,
    next_speech_id: AtomicU64,
}

#[derive(Default)]
struct SystemSpeech {
    since: Option<u64>,
    done: VecDeque<(u64, u64)>,
}

impl Shared {
    fn mic_suppressed(&self) -> bool {
        self.speaking.load(Ordering::Relaxed)
            || self.clock.now_ms() < self.spoke_until_ms.load(Ordering::Relaxed) + SPEAKING_TAIL_MS
    }
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

struct ActiveCall {
    shared: Arc<Shared>,
    playback: mpsc::Sender<Playback>,
}

#[derive(Default)]
pub struct VoiceCallState {
    active: Mutex<Option<ActiveCall>>,
    next_id: AtomicU64,
}

#[derive(Clone, Copy, Serialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum Source {
    Mic,
    System,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Transcript {
    call_id: u64,
    target_id: String,
    source: Source,
    text: String,
    started_at: u64,
    ended_at: u64,
    /// 断句判定这句说完的时刻（比 ended_at 晚一段静音）
    detected_at: u64,
    /// 语音识别用了多久
    asr_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallError {
    call_id: u64,
    target_id: String,
    source: &'static str,
    message: String,
}

fn emit_error(app: &AppHandle, shared: &Shared, source: &'static str, message: String) {
    log::warn!("[voice-call] {source}: {message}");
    // 挂断以后才回来的报错（比如还在路上的识别请求）没人要看了
    if shared.stopped() {
        return;
    }
    let _ = app.emit(
        "voice-call-error",
        CallError {
            call_id: shared.info.call_id,
            target_id: shared.info.target_id.clone(),
            source,
            message,
        },
    );
}

/// 在一个会话上开始通话，并打开通话窗口。可以重复调：这个会话已经在通话，就把那一通
/// 原样返回、窗口叫到前面，不重来；别的会话在通话，先挂掉那一通。
#[tauri::command]
pub async fn voice_call_start(
    app: AppHandle,
    state: State<'_, VoiceCallState>,
    pet_id: String,
    target_id: String,
    target_name: String,
    asr_api_key: String,
    capture_system: Option<bool>,
) -> Result<CallInfo, String> {
    if asr_api_key.trim().is_empty() {
        return Err("视频通话需要 Fish Audio 的 API Key 来识别语音".to_string());
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let (playback_tx, playback_rx) = mpsc::channel();

    // 查重和换上新通话在同一把锁里：两次同时开始不会各开一通、把其中一通丢在后台一直采集
    let (shared, previous) = {
        let mut active = state.active.lock().unwrap_or_else(|p| p.into_inner());
        let existing = active
            .as_ref()
            .map(|call| &call.shared.info)
            .filter(|info| info.pet_id == pet_id && info.target_id == target_id)
            .cloned();
        if let Some(info) = existing {
            drop(active);
            show_window(&app, &info.window);
            return Ok(info);
        }
        let call_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let shared = Arc::new(Shared {
            info: CallInfo {
                call_id,
                pet_id,
                target_id,
                target_name,
                window: call_window_label(call_id),
            },
            clock: Clock::new(),
            stop: AtomicBool::new(false),
            speaking: AtomicBool::new(false),
            spoke_until_ms: AtomicU64::new(0),
            system_speech: Mutex::new(SystemSpeech::default()),
            asr_key: asr_api_key.trim().to_string(),
            http,
            next_speech_id: AtomicU64::new(0),
        });
        let previous = active.replace(ActiveCall { shared: shared.clone(), playback: playback_tx });
        (shared, previous)
    };
    // 关窗口要等主线程，放在锁外
    if let Some(previous) = previous {
        end_call(&app, previous);
    }

    {
        let (app, shared) = (app.clone(), shared.clone());
        std::thread::spawn(move || run_playback(app, shared, playback_rx));
    }
    {
        let (app, shared) = (app.clone(), shared.clone());
        std::thread::spawn(move || run_capture(app, shared, Source::Mic));
    }
    if capture_system.unwrap_or(true) {
        let (app, shared) = (app.clone(), shared.clone());
        std::thread::spawn(move || run_capture(app, shared, Source::System));
    }

    let info = shared.info.clone();
    if let Err(message) = open_call_window(&app, &info) {
        // 没有窗口就没法挂断，不能让采集线程留在后台
        stop_call(&app, &state, Some(info.call_id));
        return Err(message);
    }
    // 窗口打开的这段时间里已经被挂断了：end_call 那时还找不到这扇窗
    if shared.stopped() {
        close_window(&app, &info.window);
        return Err("视频通话刚接通就被挂断了".to_string());
    }
    let _ = app.emit("voice-call-started", info.clone());
    Ok(info)
}

/// 挂断。可以重复调；给了 call_id 就只挂那一通，它已经结束或换成了别的通话就什么都不做。
#[tauri::command]
pub fn voice_call_stop(app: AppHandle, state: State<'_, VoiceCallState>, call_id: Option<u64>) {
    stop_call(&app, &state, call_id);
}

#[tauri::command]
pub fn voice_call_status(state: State<'_, VoiceCallState>) -> Option<CallInfo> {
    state
        .active
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|call| call.shared.info.clone())
}

/// 把一段合成好的语音（base64，MP3 等）排进 call_id 那通电话里播放。那通已经挂了就报错，
/// 上一通没念完的话不会跑到下一通里。
#[tauri::command]
pub fn voice_call_speak(
    state: State<'_, VoiceCallState>,
    call_id: u64,
    audio: String,
    text: String,
) -> Result<(), String> {
    let audio = BASE64.decode(audio.trim()).map_err(|e| format!("语音数据不是有效的 base64: {e}"))?;
    let guard = state.active.lock().unwrap_or_else(|p| p.into_inner());
    let call = guard
        .as_ref()
        .filter(|call| call.shared.info.call_id == call_id)
        .ok_or_else(|| "这通视频通话已经结束了".to_string())?;
    call.playback
        .send(Playback::Speak { audio, text })
        .map_err(|_| "通话的播放线程已经结束".to_string())
}

/// 挂断进行中的通话（给了 call_id 就只挂那一通）。先从 active 里取出来再收尾，
/// 所以每通电话只会收一次尾、只发一次 voice-call-ended。
fn stop_call(app: &AppHandle, state: &VoiceCallState, call_id: Option<u64>) {
    let taken = {
        let mut active = state.active.lock().unwrap_or_else(|p| p.into_inner());
        let matches = active
            .as_ref()
            .is_some_and(|call| call_id.map_or(true, |id| id == call.shared.info.call_id));
        if matches {
            active.take()
        } else {
            None
        }
    };
    if let Some(call) = taken {
        end_call(app, call);
    }
}

fn end_call(app: &AppHandle, call: ActiveCall) {
    call.shared.stop.store(true, Ordering::SeqCst);
    let _ = call.playback.send(Playback::Stop);
    close_window(app, &call.shared.info.window);
    let _ = app.emit("voice-call-ended", call.shared.info.clone());
}

fn show_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn close_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
}

fn open_call_window(app: &AppHandle, info: &CallInfo) -> Result<(), String> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("call", &info.call_id.to_string())
        .append_pair("pet", &info.pet_id)
        .append_pair("target", &info.target_id)
        .append_pair("name", &info.target_name)
        .finish();
    let url = WebviewUrl::App(format!("/#/call?{query}").into());
    let window = WebviewWindowBuilder::new(app, &info.window, url)
        .title("视频通话")
        .inner_size(380.0, 600.0)
        .min_inner_size(300.0, 420.0)
        .resizable(true)
        .always_on_top(true)
        .build()
        .map_err(|e| format!("打开视频通话窗口失败: {e}"))?;
    let (app, call_id) = (app.clone(), info.call_id);
    window.on_window_event(move |event| {
        // 用户直接关窗口也算挂断；挂断时程序自己关窗口，到这里那通已经不在了，什么都不做
        if matches!(event, tauri::WindowEvent::Destroyed) {
            stop_call(&app, &app.state::<VoiceCallState>(), Some(call_id));
        }
    });
    Ok(())
}

// ───────────────────────────── 采集 ─────────────────────────────

/// 一路声音：采集 → 16 kHz 单声道 → 逐帧 VAD → 断句 → 识别。
fn run_capture(app: AppHandle, shared: Arc<Shared>, source: Source) {
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let label = match source {
        Source::Mic => "mic",
        Source::System => "system",
    };
    // 采集流必须留在建它的线程里（macOS 上不能跨线程），所以由这个线程持有到通话结束
    let keep_alive = match source {
        Source::Mic => start_mic(tx),
        Source::System => start_system_audio(tx),
    };
    let _stream = match keep_alive {
        Ok(stream) => stream,
        Err(message) => {
            emit_error(&app, &shared, label, message);
            return;
        }
    };

    let mut vad = webrtc_vad::Vad::new_with_rate_and_mode(
        webrtc_vad::SampleRate::Rate16kHz,
        webrtc_vad::VadMode::Aggressive,
    );
    let mut segmenter = Segmenter::new(SegmentRules::default());
    let mut pending: Vec<f32> = Vec::new();
    let mut frame_i16 = vec![0i16; FRAME];
    while !shared.stopped() {
        let chunk = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => chunk,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        pending.extend_from_slice(&chunk);
        let mut offset = 0;
        while pending.len() - offset >= FRAME {
            let frame = &pending[offset..offset + FRAME];
            offset += FRAME;
            if source == Source::Mic && shared.mic_suppressed() {
                segmenter.reset();
                continue;
            }
            for (out, sample) in frame_i16.iter_mut().zip(frame) {
                *out = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
            }
            let voiced = rms(frame) > ENERGY_GATE && vad.is_voice_segment(&frame_i16).unwrap_or(false);
            let now = shared.clock.now_ms();
            match segmenter.push(&frame_i16, voiced, now) {
                Some(SegmentEvent::Started(start)) if source == Source::System => {
                    shared.system_speech.lock().unwrap_or_else(|p| p.into_inner()).since = Some(start);
                }
                Some(SegmentEvent::Finished(segment)) => {
                    if source == Source::System {
                        note_system_speech(&shared, segment.start_ms, segment.end_ms);
                    } else if is_echo(&shared, &segment) {
                        continue;
                    }
                    recognize(app.clone(), shared.clone(), source, segment);
                }
                Some(SegmentEvent::Dropped) if source == Source::System => {
                    shared.system_speech.lock().unwrap_or_else(|p| p.into_inner()).since = None;
                }
                _ => {}
            }
        }
        pending.drain(..offset);
    }
}

fn note_system_speech(shared: &Shared, start: u64, end: u64) {
    let mut speech = shared.system_speech.lock().unwrap_or_else(|p| p.into_inner());
    speech.since = None;
    speech.done.push_back((start, end));
    while speech.done.len() > 32 {
        speech.done.pop_front();
    }
}

fn is_echo(shared: &Shared, segment: &Segment) -> bool {
    let speech = shared.system_speech.lock().unwrap_or_else(|p| p.into_inner());
    let mut intervals: Vec<(u64, u64)> = speech.done.iter().copied().collect();
    if let Some(since) = speech.since {
        intervals.push((since, segment.end_ms));
    }
    overlap_ratio(segment.start_ms, segment.end_ms, &intervals) >= ECHO_OVERLAP
}

/// 把采集到的音频变成单声道送进 tx；cpal 的格式五花八门，统一成 f32。
struct MicStream(#[allow(dead_code)] cpal::Stream);

fn start_mic(tx: mpsc::Sender<Vec<f32>>) -> Result<Box<dyn std::any::Any>, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat;
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("没有找到麦克风")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("读取麦克风配置失败: {e}"))?;
    let channels = usize::from(config.channels()).max(1);
    let rate = config.sample_rate();
    let format = config.sample_format();
    let resampler = Arc::new(Mutex::new(Resampler::new(rate)));
    let err = |e: cpal::Error| log::warn!("[voice-call] mic stream error: {e}");
    macro_rules! build {
        ($t:ty, $to_f32:expr) => {{
            let (tx, resampler) = (tx.clone(), resampler.clone());
            device.build_input_stream(
                config.clone().into(),
                move |data: &[$t], _: &_| {
                    let mono: Vec<f32> = data
                        .chunks(channels)
                        .map(|frame| frame.iter().map(|&s| $to_f32(s)).sum::<f32>() / channels as f32)
                        .collect();
                    let mut out = Vec::with_capacity(mono.len() / 2);
                    resampler.lock().unwrap_or_else(|p| p.into_inner()).process(&mono, &mut out);
                    let _ = tx.send(out);
                },
                err,
                None,
            )
        }};
    }
    let stream = match format {
        SampleFormat::F32 => build!(f32, |s: f32| s),
        SampleFormat::I16 => build!(i16, |s: i16| f32::from(s) / f32::from(i16::MAX)),
        SampleFormat::I32 => build!(i32, |s: i32| s as f32 / i32::MAX as f32),
        other => return Err(format!("不支持的麦克风采样格式 {other:?}")),
    }
    .map_err(|e| format!("打开麦克风失败（检查系统设置里的麦克风权限）: {e}"))?;
    stream.play().map_err(|e| format!("启动麦克风失败: {e}"))?;
    Ok(Box::new(MicStream(stream)))
}

#[cfg(target_os = "macos")]
fn start_system_audio(tx: mpsc::Sender<Vec<f32>>) -> Result<Box<dyn std::any::Any>, String> {
    use screencapturekit::prelude::*;

    struct Handler(mpsc::Sender<Vec<f32>>);
    impl SCStreamOutputTrait for Handler {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
            if !matches!(kind, SCStreamOutputType::Audio) {
                return;
            }
            let Some(list) = sample.audio_buffer_list() else { return };
            // 单声道 float32：只有一个缓冲区
            let Some(buffer) = list.get(0) else { return };
            let samples: Vec<f32> = buffer
                .data()
                .chunks_exact(4)
                .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            let _ = self.0.send(samples);
        }
    }

    let content = SCShareableContent::get()
        .map_err(|e| format!("读取电脑声音需要「屏幕与系统录音」权限: {e:?}"))?;
    let display = content.displays().into_iter().next().ok_or("没有找到显示器")?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let config = SCStreamConfiguration::new()
        // 只要声音；画面压到最小
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(RATE as i32)
        .with_channel_count(1);
    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(Handler(tx), SCStreamOutputType::Audio);
    stream.start_capture().map_err(|e| format!("启动电脑声音采集失败: {e:?}"))?;
    struct SystemStream(SCStream);
    impl Drop for SystemStream {
        fn drop(&mut self) {
            let _ = self.0.stop_capture();
        }
    }
    Ok(Box::new(SystemStream(stream)))
}

#[cfg(not(target_os = "macos"))]
fn start_system_audio(_tx: mpsc::Sender<Vec<f32>>) -> Result<Box<dyn std::any::Any>, String> {
    Err("目前只有 macOS 能采集电脑声音".to_string())
}

// ───────────────────────────── 识别 ─────────────────────────────

fn wav_bytes(samples: &[i16]) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        for &sample in samples {
            writer.write_sample(sample).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

fn recognize(app: AppHandle, shared: Arc<Shared>, source: Source, segment: Segment) {
    let detected_ms = shared.clock.now_ms();
    tauri::async_runtime::spawn(async move {
        let label = match source {
            Source::Mic => "mic",
            Source::System => "system",
        };
        let asked = Instant::now();
        let text = match transcribe(&shared, &segment.samples).await {
            Ok(text) => text,
            Err(message) => {
                emit_error(&app, &shared, label, message);
                return;
            }
        };
        if text.is_empty() || shared.stopped() {
            return;
        }
        let epoch = shared.clock.started_epoch_ms;
        let _ = app.emit(
            "voice-call-transcript",
            Transcript {
                call_id: shared.info.call_id,
                target_id: shared.info.target_id.clone(),
                source,
                text,
                started_at: epoch + segment.start_ms,
                ended_at: epoch + segment.end_ms,
                detected_at: epoch + detected_ms,
                asr_ms: asked.elapsed().as_millis() as u64,
            },
        );
    });
}

async fn transcribe(shared: &Shared, samples: &[i16]) -> Result<String, String> {
    let audio = reqwest::multipart::Part::bytes(wav_bytes(samples)?)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("audio", audio)
        .text("ignore_timestamps", "true");
    let resp = shared
        .http
        .post("https://api.fish.audio/v1/asr")
        .bearer_auth(&shared.asr_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("语音识别请求失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    if !status.is_success() {
        let message = body.get("message").and_then(|m| m.as_str()).unwrap_or("");
        return Err(format!("语音识别 HTTP {status}: {message}"));
    }
    Ok(body.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string())
}

// ───────────────────────────── 播放 ─────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Speech {
    call_id: u64,
    id: u64,
    target_id: String,
    text: String,
    /// 每 frame_ms 一个 0..1 的响度。
    envelope: Vec<f32>,
    frame_ms: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechEnd {
    call_id: u64,
    id: u64,
    target_id: String,
}

/// 播放时看一眼控制通道。前端一句合成好就交过来，不等上一句播完，所以这时候到的多半是
/// 下一句：排进 backlog，不能丢。返回 true 表示该停了。
fn drain_while_playing(rx: &mpsc::Receiver<Playback>, backlog: &mut VecDeque<(Vec<u8>, String)>) -> bool {
    loop {
        match rx.try_recv() {
            Ok(Playback::Speak { audio, text }) => backlog.push_back((audio, text)),
            Ok(Playback::Stop) | Err(mpsc::TryRecvError::Disconnected) => return true,
            Err(mpsc::TryRecvError::Empty) => return false,
        }
    }
}

fn run_playback(app: AppHandle, shared: Arc<Shared>, rx: mpsc::Receiver<Playback>) {
    use rodio::Source as _;
    let sink = match rodio::DeviceSinkBuilder::open_default_sink() {
        Ok(sink) => sink,
        Err(e) => {
            emit_error(&app, &shared, "playback", format!("打开扬声器失败: {e}"));
            return;
        }
    };
    let player = rodio::Player::connect_new(sink.mixer());
    let mut backlog = VecDeque::new();
    while !shared.stopped() {
        let (audio, text) = match backlog.pop_front() {
            Some(next) => next,
            None => match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Playback::Speak { audio, text }) => (audio, text),
                Ok(Playback::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            },
        };
        let decoder = match rodio::Decoder::builder()
            .with_data(std::io::Cursor::new(audio))
            .build()
        {
            Ok(decoder) => decoder,
            Err(e) => {
                emit_error(&app, &shared, "playback", format!("语音解码失败: {e}"));
                continue;
            }
        };
        let (channels, rate) = (decoder.channels(), decoder.sample_rate());
        let samples: Vec<f32> = decoder.collect();
        if samples.is_empty() {
            continue;
        }
        let id = shared.next_speech_id.fetch_add(1, Ordering::SeqCst) + 1;
        let frame_ms = 20;
        let envelope = speech_envelope(&samples, usize::from(channels.get()), rate.get(), frame_ms);
        shared.speaking.store(true, Ordering::SeqCst);
        let _ = app.emit(
            "voice-call-speech",
            Speech {
                call_id: shared.info.call_id,
                id,
                target_id: shared.info.target_id.clone(),
                text,
                envelope,
                frame_ms,
            },
        );
        player.append(rodio::buffer::SamplesBuffer::new(channels, rate, samples));
        player.play();
        let mut interrupted = false;
        while !player.empty() {
            if shared.stopped() || drain_while_playing(&rx, &mut backlog) {
                player.stop();
                interrupted = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        shared.spoke_until_ms.store(shared.clock.now_ms(), Ordering::SeqCst);
        shared.speaking.store(false, Ordering::SeqCst);
        let _ = app.emit(
            "voice-call-speech-end",
            SpeechEnd { call_id: shared.info.call_id, id, target_id: shared.info.target_id.clone() },
        );
        if interrupted {
            break;
        }
    }
    player.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUIET: [i16; FRAME] = [0; FRAME];

    fn feed(seg: &mut Segmenter, pattern: &[(bool, usize)]) -> Vec<SegmentEvent> {
        let mut events = Vec::new();
        let mut at = 0;
        for &(voiced, count) in pattern {
            for _ in 0..count {
                at += FRAME_MS;
                let frame = if voiced { [1000i16; FRAME] } else { QUIET };
                events.extend(seg.push(&frame, voiced, at));
            }
        }
        events
    }

    #[test]
    fn a_sentence_ends_after_enough_silence_and_keeps_its_first_syllable() {
        let mut seg = Segmenter::new(SegmentRules::default());
        let events = feed(&mut seg, &[(false, 20), (true, 40), (false, 30)]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], SegmentEvent::Started((20 - 10) * FRAME_MS));
        let SegmentEvent::Finished(segment) = &events[1] else { panic!("{:?}", events[1]) };
        // 10 帧前置 + 40 帧说话 + 5 帧尾巴
        assert_eq!(segment.samples.len(), 55 * FRAME);
        assert_eq!(segment.start_ms, 10 * FRAME_MS);
        assert_eq!(segment.end_ms, 65 * FRAME_MS);
    }

    #[test]
    fn coughs_and_clicks_are_not_sentences() {
        let mut seg = Segmenter::new(SegmentRules::default());
        assert!(feed(&mut seg, &[(true, 2), (false, 40)]).is_empty(), "too short to start");
        let events = feed(&mut seg, &[(true, 8), (false, 40)]);
        assert_eq!(events.last(), Some(&SegmentEvent::Dropped), "started but too few voiced frames");
    }

    #[test]
    fn short_pauses_stay_inside_one_sentence_and_endless_sound_is_cut() {
        let mut seg = Segmenter::new(SegmentRules::default());
        let events = feed(&mut seg, &[(true, 30), (false, 20), (true, 30), (false, 30)]);
        assert_eq!(events.iter().filter(|e| matches!(e, SegmentEvent::Finished(_))).count(), 1);

        let rules = SegmentRules { max_frames: 100, ..SegmentRules::default() };
        let mut seg = Segmenter::new(rules);
        let finished = feed(&mut seg, &[(true, 250)])
            .into_iter()
            .filter(|e| matches!(e, SegmentEvent::Finished(_)))
            .count();
        assert_eq!(finished, 2);
    }

    #[test]
    fn reset_throws_away_the_sentence_in_progress() {
        let mut seg = Segmenter::new(SegmentRules::default());
        feed(&mut seg, &[(true, 20)]);
        assert_eq!(seg.reset(), Some(SegmentEvent::Dropped));
        assert!(feed(&mut seg, &[(false, 40)]).is_empty());
    }

    #[test]
    fn overlap_counts_only_the_shared_time() {
        assert_eq!(overlap_ratio(100, 200, &[]), 0.0);
        assert_eq!(overlap_ratio(100, 200, &[(0, 150)]), 0.5);
        assert_eq!(overlap_ratio(100, 200, &[(120, 140), (180, 400)]), 0.4);
        assert_eq!(overlap_ratio(100, 200, &[(0, 1000)]), 1.0);
    }

    #[test]
    fn resampling_keeps_the_signal_and_carries_over_between_chunks() {
        let mut resampler = Resampler::new(48_000);
        let mut out = Vec::new();
        let input: Vec<f32> = (0..4800).map(|i| if i < 2400 { 0.5 } else { -0.5 }).collect();
        for chunk in input.chunks(333) {
            resampler.process(chunk, &mut out);
        }
        assert_eq!(out.len(), 1600);
        assert!(out[..790].iter().all(|&s| (s - 0.5).abs() < 1e-6));
        assert!(out[810..].iter().all(|&s| (s + 0.5).abs() < 1e-6));

        let mut odd = Resampler::new(44_100);
        let mut out = Vec::new();
        odd.process(&vec![0.25; 44_100], &mut out);
        assert!((out.len() as i64 - 16_000).abs() <= 1, "{}", out.len());
    }

    #[test]
    fn envelope_follows_loudness_and_tops_out_at_one() {
        let rate = 1000;
        let mut samples = vec![0.0f32; 20];
        samples.extend(vec![0.4; 20]);
        samples.extend(vec![0.1; 20]);
        let envelope = speech_envelope(&samples, 1, rate, 20);
        assert_eq!(envelope.len(), 3);
        assert_eq!(envelope[0], 0.0);
        assert!((envelope[1] - 1.0).abs() < 1e-6);
        assert!(envelope[2] > 0.25 && envelope[2] < 1.0, "quieter speech still moves: {}", envelope[2]);
        assert!(speech_envelope(&vec![0.001; 100], 1, rate, 20).iter().all(|&l| l < 0.2), "near silence stays shut");
    }

    #[test]
    fn segments_become_valid_wav() {
        let bytes = wav_bytes(&[0, 1000, -1000]).unwrap();
        let reader = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(reader.spec().sample_rate, RATE);
        assert_eq!(reader.len(), 3);
    }

    #[test]
    fn sentences_that_arrive_while_one_plays_wait_their_turn() {
        let (tx, rx) = mpsc::channel();
        let mut backlog = VecDeque::new();
        assert!(!drain_while_playing(&rx, &mut backlog));
        tx.send(Playback::Speak { audio: vec![1], text: "二".into() }).unwrap();
        tx.send(Playback::Speak { audio: vec![2], text: "三".into() }).unwrap();
        assert!(!drain_while_playing(&rx, &mut backlog), "more speech is not a reason to stop");
        let queued: Vec<&str> = backlog.iter().map(|(_, text)| text.as_str()).collect();
        assert_eq!(queued, ["二", "三"]);
        tx.send(Playback::Stop).unwrap();
        assert!(drain_while_playing(&rx, &mut backlog));
        drop(tx);
        assert!(drain_while_playing(&rx, &mut backlog), "the call is gone");
    }

    #[test]
    fn every_call_gets_its_own_window() {
        assert_ne!(call_window_label(1), call_window_label(2));
        assert!(call_window_label(7).starts_with("call"));
    }
}
