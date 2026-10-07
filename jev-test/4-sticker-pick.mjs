/**
 * 让 Jev 从表情库里挑一张。
 *
 *   node 4-sticker-pick.mjs
 *
 * 这是目前看到的最适合 Jev 的用法，理由是输出空间闭合：
 * 30 个已知 id，主模型读的也是同一批文字描述，它并不比 Jev 有信息优势；
 * 而挑错的代价只是"表情略微不贴切"，不像情绪打标那样会把判断带偏。
 *
 * 现状的代价：session prompt 里**没有**表情索引（readStickerIndexForPrompt
 * 只在已废弃的 buildIntentSystemPrompt 里用），所以模型想发表情必须先调一次
 * sticker_list —— 一次完整的 LLM 往返，实测单次 4–21.6s、约 50k 上下文，
 * 只为从 30 个里挑一个。
 *
 * state 按线上实际形状构造：从当前往前 16 条聊天记录，标出哪条是 bot 自己。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask } from './jev.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = join(process.env.HOME,
  'Library/Application Support/com.petgpt.app/workspace/9cb05bf1-3366-4cdc-89e6-cbff4b16cb2e');

// ── 表情库（真实 index.yaml）──
const loadStickers = () => {
  const raw = readFileSync(join(WS, 'social/stickers/index.yaml'), 'utf8');
  const out = [];
  for (const block of raw.split(/^- /m).filter(Boolean)) {
    const id = block.match(/id:\s*(\d+)/);
    const meaning = block.match(/meaning:\s*(.+)/);
    const lastUsed = block.match(/last_used:\s*(.+)/);
    if (id && meaning) {
      out.push({ id: id[1], meaning: meaning[1].trim(), lastUsed: lastUsed?.[1]?.trim() || null });
    }
  }
  return out;
};

// ── 真实聊天窗口（由 /tmp/windows.json 提供，从 chat_history 随机抽的）──
const windows = JSON.parse(readFileSync('/tmp/windows.json', 'utf8'));

const BOT = 'GLITCH(我自己)';

/** state：16 条记录，标出哪条是自己。 */
const buildState = (msgs) => ({
  note: 'Chinese tech group chat. The last line is the current moment.',
  you_are: BOT,
  conversation: msgs.map(m => ({
    speaker: m.bot ? BOT : `群友${m.sender.slice(-4)}`,
    text: m.text,
  })),
});

const buildQuestion = (stickers) => ({
  type: 'choice',
  instructions:
    'You are picking one sticker for the bot to post right now, as a reaction to the '
    + 'conversation above. Pick the one whose described content best fits the mood and '
    + 'the last few lines. Each option is a sticker described in Chinese.',
  criteria: Object.fromEntries(stickers.map(s => [s.id, s.meaning])),
});

const main = async () => {
  const stickers = loadStickers();
  const q = { sticker: buildQuestion(stickers) };
  const criteriaBytes = Buffer.byteLength(JSON.stringify(q), 'utf8');
  console.log(`表情库 ${stickers.length} 个，questions 体积 ${criteriaBytes} B\n`);

  const byId = Object.fromEntries(stickers.map(s => [s.id, s.meaning]));
  let lat = [];

  for (const w of windows) {
    const msgs = w.msgs;
    console.log('─'.repeat(74));
    console.log(`▸ 窗口 #${w.anchor}  （最后 4 条）`);
    for (const m of msgs.slice(-4)) {
      console.log(`    ${m.bot ? '【我】' : '      '}${m.text.slice(0, 58)}`);
    }
    let r;
    try {
      r = await ask(buildState(msgs), q);
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      if (String(e.message).includes('401')) process.exit(1);
      continue;
    }
    lat.push(r.latencyMs);
    const a = r.answers?.sticker;
    const top = Object.entries(a?.probabilities || {})
      .sort((x, y) => y[1] - x[1]).slice(0, 3);
    console.log(`  → #${a?.choice}  ${byId[a?.choice] || '(未知 id)'}`);
    console.log(`     置信 ${a?.confidence?.toFixed(2)}  |  前三: ${top.map(([k, v]) => `#${k} ${(v * 100).toFixed(0)}%`).join('  ')}`);
    console.log(`     ${r.latencyMs}ms, in=${r.usage?.input_tokens} out=${r.usage?.output_tokens}`);
  }

  console.log('─'.repeat(74));
  if (lat.length) {
    const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
    console.log(`\n平均 ${avg}ms  （对比：现在要多跑一整轮主模型，实测 4–21.6s）`);
  }
  console.log(`\n人工判断要点：
  · 选中的表情和最后几条的语气搭不搭
  · 置信度高低是否和"这里确实适合发表情"一致——低置信本身就是有用信号
  · 前三分布是否合理（第一和第二差很多 = 判断明确）`);
};

main();
