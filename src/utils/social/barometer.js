/**
 * 群气压计 —— 对最近一段对话做一次整体判断。
 *
 * 和消息打标（moodTag）是两回事，别混：
 *
 *              消息打标                      气压计
 *   粒度       一条消息                       最近 30 条的窗口
 *   时效       冻结，标完永不变                 实时，每个 turn 重算
 *   进 history 是（正因冻结才能落进可缓存前缀）   否（每轮都变，进去就把前缀缓存打穿）
 *   频率       每条新消息一次                   每 turn 一次
 *
 * 为什么不能把消息标签聚合成气压计：一屋子人各说各的平静话，和两个人在平静地
 * 对线，per-message tone 的直方图一模一样，气压天差地别。群的状态是**涌现**的，
 * 不是单条情绪的和。
 *
 * 用词也刻意和消息标签错开。群级不说"阴阳"（那是单句的性质），说"互相调侃"。
 * 同一个词跨尺度复用会让模型把两层搅在一起。
 */

import { askJev, pickChoice, JEV_DEFAULT_MODEL } from './jevClient.js';

/** 看最近多少条。太短读不出结构，太长会把早就过去的气氛算进来。 */
export const BAROMETER_WINDOW = 30;

/** 气压计比单条打标值钱，也不在每条消息的关键路径上，超时可以给宽一点。 */
export const BAROMETER_TIMEOUT_MS = 2000;

/** A. 对话形态——纯结构信息，单条消息完全看不出来。 */
export const SHAPE_LABELS = {
  crowd: '多人热聊',
  duel: '两人对线',
  monologue: '单人连发',
  scattered: '各说各的',
  quiet: '冷场',
};

/** B. 场面温度——注意这不是单条情绪的平均，紧张来自模式而非单句。 */
export const CLIMATE_LABELS = {
  warm: '融洽',
  plain: '平淡',
  tense: '紧张',
  awkward: '尬住',
  rowdy: '刷屏亢奋',
};

/** D. 话题状态。 */
export const TOPIC_LABELS = {
  deep: '深聊一个',
  parallel: '多线并行',
  shifting: '刚切换',
  drifting: '无主题漂着',
};

/**
 * 问题全用英文写（文档：非英语准确率更低），举例用真实中文消息。
 */
export const BAROMETER_QUESTIONS = {
  shape: {
    type: 'choice',
    instructions:
      'Look at the shape of this conversation as a whole — who is talking to whom. '
      + 'This is a Chinese tech group chat. Judge the recent stretch, not any single message.',
    criteria: {
      crowd: 'Several people are actively trading messages with each other.',
      duel: 'Essentially two participants going back and forth while others watch.',
      monologue: 'One person is posting several messages in a row; nobody else is really engaging.',
      scattered: 'Multiple people are posting, but about unrelated things — no shared thread.',
      quiet: 'Very little is happening. Long gaps, or only a stray message or two.',
    },
  },
  climate: {
    type: 'choice',
    instructions:
      'What is the overall atmosphere of the room right now? '
      + 'This is about the pattern of the exchange, NOT the average sentiment of individual messages — '
      + 'a room can be tense even when every single message reads calm.',
    criteria: {
      warm: 'Relaxed and friendly. People are riffing with each other comfortably.',
      plain: 'Ordinary working chatter. Nothing charged either way.',
      tense: 'Disagreement with an edge to it. Short replies, pushback, people talking past each other.',
      awkward: 'Something landed badly and stalled. A question ignored, a joke that died.',
      rowdy: 'High-energy pile-on. Rapid-fire memes, copypasta, everyone piling onto the same gag.',
    },
  },
  topic: {
    type: 'choice',
    instructions: 'What is the topic situation in this stretch of conversation?',
    criteria: {
      deep: 'One subject, being explored in some depth.',
      parallel: 'Two or more distinct threads running at the same time.',
      shifting: 'The subject just changed, or is in the middle of changing.',
      drifting: 'No real subject — idle chatter that is not going anywhere.',
    },
  },
};

/**
 * 组装 state。
 *
 * 除了原文，还喂进**时间跨度和人数**——30 条消息发在 2 分钟和发在 3 小时，
 * 是完全不同的两个群，而光看文本分不出来。这两个值运行时算得出来，
 * 不该浪费一个问题去问 Jev。
 *
 * 和消息打标一样，窗口里**不带任何标签**，只给原文：带标签会让 Jev 锚定。
 */
export function buildBarometerState(window, { botName = 'the bot' } = {}) {
  if (!Array.isArray(window) || window.length === 0) return null;
  const recent = window.slice(-BAROMETER_WINDOW);
  const others = recent.filter(m => !m.isSelf);
  if (others.length === 0) return null;   // 全是 bot 自己说的，没有群可测

  const stamps = recent.map(m => Number(m.at)).filter(Number.isFinite);
  const spanMin = stamps.length >= 2
    ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 60000)
    : null;
  const speakers = new Set(others.map(m => m.sender).filter(Boolean));

  return {
    note: 'Chinese tech group chat. Judge the conversation as a whole, not any single line.',
    stats: {
      messages: recent.length,
      distinct_speakers: speakers.size,
      span_minutes: spanMin,
      bot_messages: recent.length - others.length,
    },
    conversation: recent.map(m => ({
      time: m.time || '',
      sender: m.isSelf ? `${botName} (the AI bot)` : (m.sender || 'unknown'),
      text: m.text || '',
    })),
  };
}

/** 解析。任何一维不合法就整份判废——半份读数比没有更容易误导。 */
export function parseBarometer(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const shape = pickChoice(answers.shape, SHAPE_LABELS);
  const climate = pickChoice(answers.climate, CLIMATE_LABELS);
  const topic = pickChoice(answers.topic, TOPIC_LABELS);
  if (!shape || !climate || !topic) return null;
  return {
    shape,
    climate,
    topic,
    confidence: Math.min(
      Number(answers.shape?.confidence) || 0,
      Number(answers.climate?.confidence) || 0,
      Number(answers.topic?.confidence) || 0,
    ),
    at: Date.now(),
  };
}

/**
 * 渲染成注入 prompt 尾部的那一小块。
 *
 * 必须放在**请求尾部**而不是 system prompt 里：system prompt 整个 session 固定
 * 不变（那是缓存命中的前提），而气压计每轮都变。
 */
export function renderBarometer(reading, stats = null) {
  if (!reading) return '';
  const lines = [
    '# 此刻群里的气压',
    `· 对话形态：${SHAPE_LABELS[reading.shape]}`,
    `· 场面温度：${CLIMATE_LABELS[reading.climate]}`,
    `· 话题状态：${TOPIC_LABELS[reading.topic]}`,
  ];
  if (stats?.messages) {
    const span = stats.span_minutes != null ? `${stats.span_minutes} 分钟内` : '';
    lines.push(`· 窗口：最近 ${stats.messages} 条${span ? `（${span}）` : ''}，${stats.distinct_speakers} 人发言`);
  }
  lines.push('（这是对最近一段对话的整体读数，每轮重算，和单条消息的【…】标签是两个尺度。'
    + '它描述场面，不替你做决定——要不要开口还是看你自己读到的内容。）');
  return lines.join('\n');
}

/** 读一次气压。失败返回 null，调用方不注入那一段即可。 */
export async function readBarometer(window, opts = {}) {
  const state = buildBarometerState(window, opts);
  if (!state) return null;
  const answers = await askJev(state, BAROMETER_QUESTIONS, {
    model: JEV_DEFAULT_MODEL, timeoutMs: BAROMETER_TIMEOUT_MS, ...opts,
  });
  const reading = parseBarometer(answers);
  return reading ? { reading, stats: state.stats } : null;
}
