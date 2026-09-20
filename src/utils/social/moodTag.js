/**
 * 消息级状态打标（"敬酒系统"）—— 用 TypeSafe Jev 给每条群友消息贴一个气压读数。
 *
 * 设计要点（每条都是有理由的，别随手改）：
 *
 * 1. **一次只标一条**。state 是这条消息之前的原文窗口，问题只问"最后这条"。
 * 2. **窗口里不带标签**。只给原文。带上前面的标签会让 Jev 锚定——连着五条
 *    【玩梗】会把第六条也拽过去，校准概率就没意义了。它照样看得见那五条的
 *    原文，所以不损失信息，只是没有标签惯性。
 * 3. **因此可以完全并行**。第 N 条的标签只依赖原文 1..N，从不依赖标签
 *    1..N-1，所以 M 条消息 = M 个并发请求，墙钟时间是一次调用的延迟。
 * 4. **问题用英文写**。文档原话：其他语言"accepted but have lower accuracy"，
 *    而英文是主训练语言。state 必须是中文原文（那是数据），但 instructions
 *    和 criteria 用英文能白捡一点准确率。输出再映射回中文渲染。
 * 5. **bot 自己的消息不标**，但**要留在窗口里**——群友那句是不是在回应 bot，
 *    全靠它。
 * 6. **失败就不标**。1 秒超时，拿不到就发占位符，绝不阻塞发言。
 *
 * API 契约见 https://docs.typesafe.ai/api.md
 */

import {
  askJev, pickChoice, bucketScore,
  makeFetchRequest as _makeFetchRequest, JEV_DEFAULT_MODEL,
} from './jevClient.js';

/** 转出去，沙盒和测试还在用。 */
export const makeFetchRequest = _makeFetchRequest;


/** 拿不到标签时的占位。prompt 里会说明它的含义。 */
export const MOOD_TAG_UNKNOWN = '—';

/** 超时。打标在消息进 history 之前做，不能拖住 turn。 */
export const MOOD_TAG_TIMEOUT_MS = 1000;

/** about_bot 超过这个概率才渲染。它是 flag 不是类目，每条都渲染"没提到你"是纯噪音。 */
export const ABOUT_BOT_THRESHOLD = 0.6;

// ── 英文 enum → 中文渲染 ──

export const ACT_LABELS = {
  question: '提问',
  inform: '给料',
  challenge: '质疑',
  banter: '玩梗',
  vent: '吐槽',
  update: '播报',
  request: '指令',
  unclear: '难辨',
};

export const TONE_LABELS = {
  neutral: '平静',
  upbeat: '兴奋',
  sarcastic: '阴阳',
  annoyed: '烦躁',
  urgent: '着急',
};

/** earnest 是 score（criteria 三档 → 0..2），落到三个桶。 */
export const EARNEST_LABELS = ['玩笑', '随意', '认真'];

/**
 * 插话空间：这条消息之后，此刻有没有 bot 开口的余地。
 *
 * 放在消息级而不是群气压计里，是因为它本质上是"某个时刻"的属性——和情绪一样
 * 可以冻结。群气压计是滑动窗口的实时读数，两回事。
 *
 * 「有人问了没人答」这个信号并进了最高档：那正是 bot 最该开口的场景。
 */
export const ROOM_LABELS = ['别插', '可接', '等接'];

/**
 * 问题定义。criteria 的措辞直接决定质量，改之前先在沙盒里对照真实日志跑一遍。
 * 例子全部摘自 902317662 群的真实消息。
 */
export const MOOD_QUESTIONS = {
  act: {
    type: 'choice',
    instructions:
      'What is the LAST message in the conversation doing? Judge the last message only; '
      + 'earlier messages are context. This is a Chinese tech group chat.',
    criteria: {
      question: 'Genuinely asking for an answer. e.g. "这玩意判断的准确率怎么样"',
      inform: 'Supplying information or explaining something. e.g. "type safe说是基于RLCD做的后训练"',
      challenge: 'Doubting, pushing back, or correcting someone. e.g. "这不会就是个 reranker 吧（"',
      banter: 'Joking, meme-ing, riffing, or repeating a running gag. e.g. "南蚌", "glitch即将长出system 1"',
      vent: 'Complaining or musing out loud, not expecting an answer. e.g. "唉人脑靠眼睛读东西是真慢"',
      update: 'Reporting a fact about themselves or the world. e.g. "我间隙先下一碗馄饨吃"',
      request: 'Asking someone to DO something. e.g. "看一下这个网页，总结一下"',
      unclear: 'Cannot tell — e.g. the message is only an image or sticker with no text.',
    },
  },
  tone: {
    type: 'choice',
    instructions:
      'What is the emotional colour of the LAST message? Judge the last message only. '
      + 'Chinese internet sarcasm is often marked by a trailing "（", by ironic emoji '
      + '(e.g. 😠 used playfully), or by exaggerated praise/numbers.',
    criteria: {
      neutral: 'Flat, matter-of-fact, no particular emotional charge.',
      upbeat: 'Excited, pleased, enthusiastic.',
      sarcastic: 'Saying one thing, meaning another. Teasing, ironic, needling. e.g. "外网已经有用jev -1500%的了"',
      annoyed: 'Irritated, frustrated, grumbling — genuinely, not playfully.',
      urgent: 'Pressed for time, anxious, needs an answer soon.',
    },
  },
  earnest: {
    type: 'score',
    instructions: 'How literally should the LAST message be taken? Judge the last message only.',
    criteria: [
      'Pure joke or meme. There is no literal claim to respond to.',
      'Casual chat. Half-joking, but there is some real content.',
      'Fully serious. A real statement or question that deserves a considered answer.',
    ],
  },
  room: {
    type: 'score',
    instructions:
      'Right after the LAST message, how much room is there for the AI bot to speak up? '
      + 'Judge the moment created by the last message, not the whole conversation.',
    criteria: [
      'No room. Two people are mid-exchange, or the bot just spoke and was ignored. Butting in would be rude.',
      'Some room. The bot could chime in without disrupting anything, but nobody is waiting for it.',
      'Wide open. Someone asked something nobody has answered, or the conversation has stalled and needs a nudge.',
    ],
  },
  about_bot: {
    type: 'noul',
    instructions:
      'Is the LAST message about, or directed at, the AI bot in this group? '
      + 'The bot is referred to as glitch, bot, or 机器人. '
      + 'Note: an explicit @-mention is detected separately, so focus on indirect references.',
    criteria: {
      true: 'The message talks about the bot or is aimed at it, e.g. "glitch即将长出system 1".',
      false: 'The message is about something else entirely.',
    },
  },
};

// ── state 构造 ──

/**
 * 把窗口拼成给 Jev 的 state。
 *
 * 用结构化对象而不是一大段字符串——文档明确说 object/array 适合 chat log。
 * 最后一条单独再列一次（message_to_label），消除"哪条是最后一条"的歧义。
 *
 * @param window  [{ sender, text, isSelf, time }]，按时间正序，最后一条就是要标的
 * @param botName bot 在群里的显示名
 */
export function buildMoodState(window, { botName = 'glitch' } = {}) {
  if (!Array.isArray(window) || window.length === 0) return null;
  const line = (m) => ({
    time: m.time || '',
    sender: m.isSelf ? `${botName} (the AI bot)` : (m.sender || 'unknown'),
    text: m.text || '',
  });
  const target = window[window.length - 1];
  if (target.isSelf) return null;   // bot 自己的消息不标
  return {
    note: 'Chinese tech group chat. Label ONLY the message in message_to_label.',
    conversation: window.map(line),
    message_to_label: line(target),
  };
}

// ── 响应解析 ──

/**
 * 把 Jev 的 answers 解析成一个标签。任何一项不合法就整条判失败——
 * 半个标签比没有标签更容易误导。
 *
 * @returns { act, tone, earnest, aboutBot, confidence } | null
 */
export function parseMoodAnswers(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const act = pickChoice(answers.act, ACT_LABELS);
  const tone = pickChoice(answers.tone, TONE_LABELS);
  if (!act || !tone) return null;

  const idx = bucketScore(answers.earnest, EARNEST_LABELS.length);
  if (idx === null) return null;

  const room = bucketScore(answers.room, ROOM_LABELS.length);
  if (room === null) return null;

  const noul = Number(answers.about_bot?.noul);
  return {
    act,
    tone,
    earnest: idx,
    room,
    aboutBot: Number.isFinite(noul) ? noul : 0,
    confidence: Math.min(
      Number(answers.act?.confidence) || 0,
      Number(answers.tone?.confidence) || 0,
    ),
  };
}

/**
 * 渲染成插进名字块的那一小段。
 * 三个维度恒定渲染（"平静"本身也是信息，满屏平静和满屏阴阳气压完全不同）；
 * about_bot 是 flag，只在为真时追加。
 */
export function renderMoodTag(tag) {
  if (!tag) return `【${MOOD_TAG_UNKNOWN}】`;
  const parts = [
    ACT_LABELS[tag.act] || MOOD_TAG_UNKNOWN,
    TONE_LABELS[tag.tone] || MOOD_TAG_UNKNOWN,
    EARNEST_LABELS[tag.earnest] ?? MOOD_TAG_UNKNOWN,
    ROOM_LABELS[tag.room] ?? MOOD_TAG_UNKNOWN,
  ];
  if (tag.aboutBot > ABOUT_BOT_THRESHOLD) parts.push('提到你');
  return `【${parts.join('·')}】`;
}

// ── 网络 ──

/**
 * 标一条。失败一律返回 null，由调用方渲染占位符——打标绝不能让发言失败。
 */
export async function tagOne(state, opts = {}) {
  if (!state) return null;
  const answers = await askJev(state, MOOD_QUESTIONS, {
    model: JEV_DEFAULT_MODEL, timeoutMs: MOOD_TAG_TIMEOUT_MS, ...opts,
  });
  return parseMoodAnswers(answers);
}

/**
 * 并发上限。
 *
 * 稳态下一个 turn 只新增 1–3 条，撞不到。但 session 冷启动要把窗口里的
 * 64 条一次性标完——64 个请求挤在一秒内相当于瞬时 3840 req/min，会撞
 * 官方的 1200 req/min。分批发，代价是冷启动那一次多花约 1 秒。
 */
export const MOOD_TAG_CONCURRENCY = 16;

/**
 * 并行标一批。
 *
 * 能并行正是因为"窗口里不带标签"——条与条之间没有顺序依赖。
 *
 * @param targets [{ id, window }]  window 是截止到该条为止的原文窗口
 * @returns Map<id, tag|null>
 */
export async function tagBatch(targets, opts = {}) {
  const out = new Map();
  if (!Array.isArray(targets) || targets.length === 0) return out;
  const limit = Math.max(1, opts.concurrency ?? MOOD_TAG_CONCURRENCY);

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const t = targets[i];
      let tag = null;
      try {
        tag = await tagOne(buildMoodState(t.window, opts), opts);
      } catch { /* 打标失败就不标，绝不影响发言 */ }
      out.set(t.id, tag);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
  return out;
}
