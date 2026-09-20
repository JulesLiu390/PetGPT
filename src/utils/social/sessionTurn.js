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

/** 工具调用渲染成一行自述。参数太长就截断——完整参数对后续判断没什么用。 */
export function renderToolCall(item, { maxArgChars = 200 } = {}) {
  const name = item.toolName || '工具';
  let args = asText(item.content);
  if (args.length > maxArgChars) args = args.slice(0, maxArgChars) + '…';
  return args ? `（我调用了 ${name}：${args}）` : `（我调用了 ${name}）`;
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
 *   message      → 原 role（群聊消息本来就是 user / assistant 交替）
 *   tool_call    → assistant（是"我"做的）
 *   tool_result  → user（外部世界返回给"我"的）
 *   injection    → user（打断进来的新消息）
 *   note         → assistant（我给自己记的）
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
        role = 'assistant';
        text = renderToolCall(item, { maxArgChars });
        break;
      case 'tool_result':
        role = 'user';
        text = renderToolResult(item);
        break;
      case 'note':
        role = 'assistant';
        text = typeof item.content === 'string' ? item.content : renderTurnNote(item.note, item.seq);
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
