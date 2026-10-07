/**
 * session history → provider 消息数组。
 *
 * 设计取舍：跨 turn 的工具调用**不以原生 tool_call 格式回放**，而是降级成普通文本。
 *
 * 原因是原生格式在三家（Gemini / OpenAI / Anthropic）之间形状不同，而且
 * tool_call 和 tool_result 必须严格配对——一旦某轮被压缩掉一半，或者某个
 * 结果因为裁剪变成占位符，配对就断了，请求直接 400。降级成文本之后这些都
 * 不成问题：模型照样看得见自己上轮查了什么、拿到了什么，只是形式上变成
 * "叙述"而不是"协议"。
 *
 * 当前 turn 之内的工具循环仍然走原生格式——那是 callLLMWithTools 内部的事，
 * 它自己维护 currentMessages，配对天然正确。
 */

/**
 * Gemini 不允许连续同 role，所以相邻同 role 必须合并。
 *
 * 合并会抹掉"发了几条"这个信息——线上出过一次：一个 turn 连发两条，
 * 合并后模型下一轮只看到一条多行消息，分不清自己发过几次、哪条带了引用，
 * 于是在正文里手写「回 yesname：」来补偿。
 *
 * 解法不是不合并（Gemini 不答应），而是让每条自带前缀，合并后边界依然可见。
 * 见 formatSelfMessage。
 */
const JOIN = '\n\n';

/**
 * bot 自己的消息该长什么样。
 *
 * 两处会渲染自发消息：buildTurnsFromMessages 的 is_self 分支（buffer 回灌的），
 * 和 session 发送成功时的即时追加。两边必须同形，否则 prompt 里承诺的格式
 * 和实际给的对不上——这正是之前那个 bug 的温床之一。
 *
 * @param replyTo 引用的消息 ID。带上它，模型才看得见自己的引用生效了；
 *                看不见就会想办法在正文里补称呼。
 */
export function formatSelfMessage({ text = '', time = '', replyTo = null } = {}) {
  const head = [time, '我的回复', replyTo ? `→#${replyTo}` : null].filter(Boolean).join(' ');
  return `[${head}] ${text}`;
}

const asText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => typeof p?.text === 'string').map(p => p.text).join('\n');
  }
  return '';
};

/**
 * 系统替模型记的流水，统一用这个前缀、放在 **user** 角色里。
 *
 * 以前工具调用渲染成 assistant 角色的「（我调用了 send_message：{…}）」。模型翻看
 * 自己的历史，看到的是「我每次说话都是这么一句」，于是照着写——写出来的只是
 * 文字，群里看不见。线上抓到过原样的：
 *
 *   （我调用了 Telegram__send_message：{"content":"我这边没有收到新的图片消息耶…"}）
 *
 * 所以 assistant 角色里只留它在群里**真正说过**的话（[HH:MM:SS 我的回复] …），
 * 其余一律是 user 侧的系统记录，没有可以照抄的「说话模板」。
 */
export const SYSTEM_RECORD = '[系统记录]';

/** 工具调用渲染成一行系统记录。参数太长就截断——完整参数对后续判断没什么用。 */
export function renderToolCall(item, { maxArgChars = 200 } = {}) {
  const name = item.toolName || '工具';
  let args = asText(item.content);
  if (args.length > maxArgChars) args = args.slice(0, maxArgChars) + '…';
  return args ? `${SYSTEM_RECORD} 你调用了 ${name}：${args}` : `${SYSTEM_RECORD} 你调用了 ${name}`;
}

/** 模型写了、但没经过发送工具的文字。照实告诉它：群里看不到。 */
export function renderUnsentText(item) {
  return `${SYSTEM_RECORD} 你写了下面这段文字，但没有调用发送工具，群里看不到：\n${asText(item.content)}`;
}

/** 工具结果渲染成一块带标记的文本。 */
export function renderToolResult(item) {
  const name = item.toolName || '工具';
  return `[${name} 的结果]\n${asText(item.content)}`;
}

/** turn_note 渲染。这是跨 turn 的主要记忆载体。 */
export function renderTurnNote(note, seq) {
  if (!note) return '';
  const reg = note.register ? `[${note.register}]` : '';
  const tail = note.inferred ? '（未主动记录，系统据实补的）' : '';
  return `（第 ${seq} 轮小结 ${reg} ${note.summary || ''}${tail}）`.replace(/\s+/g, ' ').trim();
}

/**
 * 把 session history 条目转成 provider 消息。
 *
 * 角色归属：
 *   message      → 原 role（群聊消息；assistant 只有真正发进群里的话）
 *   tool_call    → user（系统记录：你调用了什么，见 SYSTEM_RECORD）
 *   tool_result  → user（外部世界返回的）
 *   unsent       → user（系统记录：写了但没发出去的文字）
 *   injection    → user（打断进来的新消息）
 *   note         → user（系统记录：每轮小结）
 *   summary      → user（压缩摘要，作为背景材料）
 *
 * @returns [{ role, content }]，已合并连续同 role
 */
export function toProviderTurns(items, { maxArgChars = 200 } = {}) {
  const raw = [];
  for (const item of items || []) {
    let role;
    let text;
    switch (item.kind) {
      case 'tool_call':
        role = 'user';
        text = renderToolCall(item, { maxArgChars });
        break;
      case 'unsent':
        role = 'user';
        text = renderUnsentText(item);
        break;
      case 'tool_result':
        role = 'user';
        text = renderToolResult(item);
        break;
      case 'note':
        role = 'user';
        text = `${SYSTEM_RECORD} ${typeof item.content === 'string' ? item.content : renderTurnNote(item.note, item.seq)}`;
        break;
      case 'summary':
        role = 'user';
        text = `[历史摘要]\n${asText(item.content)}`;
        break;
      case 'injection':
        role = 'user';
        text = asText(item.content);
        break;
      default:
        role = item.role === 'assistant' ? 'assistant' : 'user';
        // 多模态原样透传——图片必须保留成 part 数组，不能拍扁成文本
        if (Array.isArray(item.content)) {
          raw.push({ role, content: item.content, multimodal: true });
          continue;
        }
        text = asText(item.content);
        break;
    }
    if (!text) continue;
    raw.push({ role, content: text, multimodal: false });
  }

  // 合并连续同 role。带多模态的条目不参与文本合并——把文本 part 并进去即可。
  const out = [];
  for (const entry of raw) {
    const prev = out[out.length - 1];
    if (!prev || prev.role !== entry.role) {
      out.push(entry.multimodal
        ? { role: entry.role, content: [...entry.content] }
        : { role: entry.role, content: entry.content });
      continue;
    }
    const prevIsArray = Array.isArray(prev.content);
    if (!prevIsArray && !entry.multimodal) {
      prev.content = prev.content + JOIN + entry.content;
    } else if (prevIsArray && !entry.multimodal) {
      prev.content.push({ type: 'text', text: entry.content });
    } else if (!prevIsArray && entry.multimodal) {
      prev.content = [{ type: 'text', text: prev.content }, ...entry.content];
    } else {
      prev.content.push(...entry.content);
    }
  }
  return out;
}

/**
 * 保证消息数组能被所有 provider 接受：
 *   · 不能以 assistant 结尾（模型会以为要它续写自己的话）
 *   · 不能为空
 */
export function ensureUserLast(turns, filler = '（以上是当前情况。）') {
  const out = [...turns];
  if (out.length === 0) return [{ role: 'user', content: filler }];
  if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: filler });
  return out;
}

/**
 * 把一段每轮现算的背景块（比如气压计）并进最后一条 user 消息的**开头**。
 *
 * 不能单独挂成最后一条 user 消息。之前就是这么挂的，模型最后读到的是一块
 * 场面读数而不是群友的话。flash-lite 上用生产同款 prompt 和工具集整轮实测：
 * 有实际内容的 @ 问句前后都是 8/8 回答，但「@bot 啵啵」这种短 @ 从 1/8 回到
 * 6/8——挂在最后时它 7/8 都 turn_note 收尾不说话了。（只有两三个工具的简化
 * 环境里差得更狠：8/8 → 0/8。）ensureUserLast 保证的就是"新消息在最后"，
 * 这里不能把它顶掉。
 *
 * 代价是前缀缓存少一截：上一轮的最后一条 user 消息带着块，这一轮它已经不在
 * 末尾、不带块了，缓存从它开始对不上。丢的只是一批新消息的量，可以接受。
 *
 * 最后一条不是 user 时（只有没调 ensureUserLast 才会这样）说明没有待回应的
 * 消息可以被顶掉，那就单独追加一条。不修改传入的数组和对象。
 */
export function prependToLastUser(turns, block) {
  const out = [...(turns || [])];
  if (!block) return out;
  const last = out[out.length - 1];
  if (!last || last.role !== 'user') {
    out.push({ role: 'user', content: block });
    return out;
  }
  out[out.length - 1] = {
    ...last,
    content: Array.isArray(last.content)
      ? [{ type: 'text', text: block }, ...last.content]
      : [block, asText(last.content)].filter(Boolean).join(JOIN),
  };
  return out;
}

/**
 * 一轮 LLM 调用结束时，模型的话去了哪。
 *
 * 只有发送类工具能把话送进群里；模型直接输出的文字只进 history。以前这件事
 * 不留痕：「答进肚子里」和「主动沉默」在 usage 日志里都是 迭代=1 工具=0，
 * flash-lite 一天丢掉上百次回复，一个星期没人发现。
 *
 *   sent        调了发送工具（文字只是旁白）
 *   noted       调了 turn_note，明确收尾
 *   text_only   有文字，但没发送也没收尾——这段话群里看不见
 *   tools_only  只调了查询类工具，没文字、没收尾
 *   empty       什么都没有
 *
 * @param toolNames  本轮调用过的工具名（可能带 MCP server 前缀）
 * @param text       本轮最终的文字输出
 * @param isSendTool (name) => boolean
 */
export function classifyRoundOutput({ toolNames = [], text = '', isSendTool = () => false } = {}) {
  const names = (toolNames || []).map(n => String(n || ''));
  if (names.some(n => isSendTool(n))) return 'sent';
  if (names.some(n => n === 'turn_note' || n.endsWith('__turn_note'))) return 'noted';
  if (String(text || '').trim()) return 'text_only';
  return names.length > 0 ? 'tools_only' : 'empty';
}
