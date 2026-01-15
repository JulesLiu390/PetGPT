//! LLM 模块 - 负责与 AI 服务通信
//! 
//! 支持:
//! - OpenAI 兼容 API (openai_compatible)
//! - Google Gemini 官方 API (gemini_official)

pub mod client;
pub mod types;
pub mod stream;

pub use client::LlmClient;
pub use types::*;
pub use stream::{stream_chat, LlmStreamCancellation};
