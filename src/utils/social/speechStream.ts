/**
 * 通话里宠物边想边说：模型的文字一边流进来，一边切成句子送去合成，按顺序播出去。
 * 第一句写完就能开口，不用等整段生成完。
 */
import { stripSplitTagsForSpeech } from './outgoingText.js';
import { DRAMA_PAIRED_TAGS } from './voiceScript.ts';

// 句末标点。逗号、波浪号不切，切得太碎每句合成的开销就显出来了。
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n']);
const OPEN_BRACKETS: Record<string, string> = { '[': ']', '【': '】', '（': '）', '(': ')' };
const CLOSE_BRACKETS = new Set(Object.values(OPEN_BRACKETS));
// 一句太长又迟迟没有句号时，在这些地方先切一刀
const SOFT_BREAK = /[，,、：:\s]/;
const PAIRED_TAG_AT = /^<\s*(\/?)\s*([a-zA-Z_-]+)\s*>/;

/** 念出来之前的清理：Markdown、网址、表情、模型照着历史格式写的前缀、整行的旁白。清理过的再清理一遍不变。 */
export function cleanSpeech(text: unknown): string {
  return String(stripSplitTagsForSpeech(String(text || '')) || '')
    .split('\n')
    .map(line => line
      // 模型偶尔照着 history 的样子给自己的话加时间前缀
      .replace(/^\s*\[[^\]]*(我的回复|通话里说)[^\]]*\]\s*/, '')
      .replace(/^\s*(#{1,6}|>|[-*•]|\d+[.)、])\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\p{Extended_Pictographic}️?/gu, ''))
    // 「[沉默]：……」和整行括起来的旁白不是要说的话
    .filter(line => !/^\s*\[沉默\]/.test(line) && !/^\s*[（(【][^）)】]*[）)】]\s*$/.test(line))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 去掉标点和音效标记后还有没有字可念。 */
const hasWords = (text: string): boolean => /[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]/g, ''));

export interface SentenceSplitter {
  /** 接一段流式片段，凑出完整的句子就交出去。 */
  push(delta: string | null | undefined): void;
  /** 一段话写完了：剩下的不管多短都念出来。可以重复调，没剩下的就什么都不做。 */
  end(): void;
}

export interface SplitOptions {
  minChars?: number;
  maxChars?: number;
}

/**
 * 增量切句。push 进流式片段，每凑出一句就回调 onSentence（已清理）。太短的句子并到下一句，
 * 方括号和括号里面不切（[laugh] 这类音效、括号里的补充说明），<soft>…</soft> 这类成对标签
 * 中间也不切，拆到两句里标签就失效了。
 */
export function createSentenceSplitter(
  onSentence: (sentence: string) => void,
  { minChars = 6, maxChars = 80 }: SplitOptions = {},
): SentenceSplitter {
  let pending = '';

  const emit = (raw: string) => {
    const sentence = cleanSpeech(raw);
    if (hasWords(sentence)) onSentence(sentence);
  };

  const cut = (final: boolean) => {
    for (;;) {
      let depth = 0;
      let tagDepth = 0;
      let end = -1;
      let awaitingMore = false;
      for (let i = 0; i < pending.length; i += 1) {
        const ch = pending.charAt(i);
        const tag = ch === '<' ? PAIRED_TAG_AT.exec(pending.slice(i)) : null;
        if (tag && DRAMA_PAIRED_TAGS.includes(String(tag[2]).toLowerCase())) {
          tagDepth = tag[1] ? Math.max(0, tagDepth - 1) : tagDepth + 1;
          i += tag[0].length - 1;
        } else if (OPEN_BRACKETS[ch]) depth += 1;
        else if (CLOSE_BRACKETS.has(ch)) depth = Math.max(0, depth - 1);
        else if (depth === 0 && tagDepth === 0 && SENTENCE_END.has(ch)) {
          // 连着的标点（「！？」「……」）算同一个句末
          let j = i;
          while (j + 1 < pending.length && SENTENCE_END.has(pending.charAt(j + 1))) j += 1;
          // 句末在片段最后、后面可能还有标点没到：等下一片
          if (j === pending.length - 1 && !final) { awaitingMore = true; break; }
          if (cleanSpeech(pending.slice(0, j + 1)).length >= minChars) {
            end = j + 1;
            break;
          }
          i = j;
        }
      }
      if (end < 0 && !awaitingMore && pending.length > maxChars) {
        const head = pending.slice(0, maxChars);
        let soft = -1;
        for (let i = head.length - 1; i >= minChars - 1; i -= 1) {
          if (SOFT_BREAK.test(head.charAt(i))) { soft = i + 1; break; }
        }
        end = soft > 0 ? soft : maxChars;
      }
      if (end < 0) break;
      emit(pending.slice(0, end));
      pending = pending.slice(end);
    }
  };

  return {
    push(delta) {
      if (!delta) return;
      pending += delta;
      cut(false);
    },
    end() {
      cut(true);
      if (pending) emit(pending);
      pending = '';
    },
  };
}

export interface SpeechQueue {
  /** 排进一句，返回它是否真的交给了播放端。 */
  push(text: string): Promise<boolean>;
  /** 还没播的都丢掉。之后照常能 push；可以重复调。 */
  cancel(): void;
  /** 已经排进来的都处理完。 */
  idle(): Promise<boolean>;
}

export interface SpeechQueueOptions<A> {
  /** 合成一句；返回 null（或空）表示这句不用念 */
  synthesize: (text: string) => Promise<A | null>;
  /** 交给播放端 */
  deliver: (audio: A, text: string) => Promise<void>;
  onError?: (error: unknown, text: string) => void;
  /** 最多同时合成几句 */
  concurrency?: number;
}

/**
 * 按顺序播放的合成队列。合成可以提前并发（最多 concurrency 句），播放严格按 push 的顺序；
 * 某句失败只跳过它。cancel 之后还没播的都丢掉。
 */
export function createSpeechQueue<A>({
  synthesize, deliver, onError = () => {}, concurrency = 2,
}: SpeechQueueOptions<A>): SpeechQueue {
  let tail: Promise<boolean> = Promise.resolve(true);
  let active = 0;
  const waiting: Array<() => void> = [];
  let generation = 0;

  const acquire = () => new Promise<void>((resolve) => {
    if (active < concurrency) {
      active += 1;
      resolve();
    } else {
      waiting.push(resolve);
    }
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    push(text) {
      const gen = generation;
      const audio = acquire()
        .then(() => (gen === generation ? synthesize(text) : null))
        .finally(release);
      // 先挂上，失败在下面按顺序处理，免得成为未处理的 rejection
      audio.catch(() => {});
      const delivered = tail.then(async () => {
        let result: A | null;
        try {
          result = await audio;
        } catch (error) {
          if (gen === generation) onError(error, text);
          return false;
        }
        if (gen !== generation || !result) return false;
        try {
          await deliver(result, text);
          return true;
        } catch (error) {
          onError(error, text);
          return false;
        }
      });
      tail = delivered;
      return delivered;
    },
    cancel() {
      generation += 1;
    },
    idle() {
      return tail;
    },
  };
}
