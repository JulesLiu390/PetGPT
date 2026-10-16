import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanSpeech, createSentenceSplitter, createSpeechQueue, type SplitOptions } from '../social/speechStream.ts';

const split = (chunks: string[], opts?: SplitOptions) => {
  const out: string[] = [];
  const splitter = createSentenceSplitter(s => out.push(s), opts);
  for (const chunk of chunks) splitter.push(chunk);
  splitter.end();
  return out;
};

test('sentences come out as soon as they are complete, however the text is chunked', () => {
  const out: string[] = [];
  const splitter = createSentenceSplitter(s => out.push(s));
  splitter.push('哈哈你终于回来');
  assert.deepEqual(out, []);
  splitter.push('啦！我等你好');
  assert.deepEqual(out, ['哈哈你终于回来啦！'], 'the first sentence goes before the rest is written');
  splitter.push('久了。');
  splitter.push('今天吃什么');
  splitter.end();
  assert.deepEqual(out, ['哈哈你终于回来啦！', '我等你好久了。', '今天吃什么']);
  assert.deepEqual(split(['好', '的', '，', '我', '查', '一', '下', '哦', '～', '稍', '等', '。']), ['好的，我查一下哦～稍等。']);
});

test('runs of punctuation stay together and short bits join the next sentence', () => {
  assert.deepEqual(split(['真的假的？！太离谱了……', '我不信。']), ['真的假的？！', '太离谱了……', '我不信。']);
  assert.deepEqual(split(['嗯。好。那我们明天见吧。']), ['嗯。好。那我们明天见吧。']);
});

test('brackets are never split, and long sentences without a full stop are cut at a comma', () => {
  assert.deepEqual(split(['哈哈[laugh]。你看（这个！）挺好的。']), ['哈哈[laugh]。', '你看（这个！）挺好的。']);
  const long = '我跟你说啊，' + '这件事情其实很复杂'.repeat(10);
  const out = split([long], { maxChars: 30 });
  assert.equal(out[0], '我跟你说啊', 'cut at the comma rather than mid-word; the trailing comma is a pause anyway');
  assert.ok(out.slice(1).every(piece => piece.length <= 30));
  assert.equal(out.join(''), long.replace('，', ''));
  assert.deepEqual(split(['<soft>真的很开心。谢谢你。</soft>', '下次见！']), ['<soft>真的很开心。谢谢你。</soft>下次见！'],
    'a paired tag keeps its sentences together');
});

test('ending twice says nothing twice, and the splitter can start a new passage', () => {
  const out: string[] = [];
  const splitter = createSentenceSplitter(s => out.push(s));
  splitter.push('说完了');
  splitter.end();
  splitter.end();
  assert.deepEqual(out, ['说完了']);
  splitter.push('又一段');
  splitter.end();
  assert.deepEqual(out, ['说完了', '又一段']);
  splitter.push('');
  splitter.push(null);
  splitter.end();
  assert.deepEqual(out, ['说完了', '又一段'], 'nothing pushed, nothing said');
});

test('what never gets read aloud', () => {
  assert.equal(cleanSpeech('**好的**，看这里 https://x.com/a 😂'), '好的，看这里');
  assert.equal(cleanSpeech('[沉默]：没什么可说的\n嗯嗯'), '嗯嗯');
  assert.equal(cleanSpeech('（不需要回应）'), '');
  assert.equal(cleanSpeech('[19:01:02 我在通话里说] 在的在的'), '在的在的');
  assert.equal(cleanSpeech('- 第一点\n- 第二点'), '第一点 第二点');
  assert.equal(cleanSpeech('真的假的</分段>离谱了'), '真的假的，离谱了');
  assert.equal(cleanSpeech('[laugh] 哈哈'), '[laugh] 哈哈', 'sound cues stay for the voice');
  assert.equal(cleanSpeech(null), '');
  assert.deepEqual(split(['[laugh]。', '……']), [], 'only cues and punctuation: nothing to say');
});

test('cleaning text that is already clean changes nothing', () => {
  const samples = [
    '**好的**，看这里 https://x.com/a 😂', '[沉默]：没什么\n嗯嗯', '- 第一点\n- 第二点',
    '真的假的</分段>离谱了', '[laugh] 哈哈 <soft>嗯</soft>', '  多余   的空格  ',
  ];
  for (const sample of samples) {
    const once = cleanSpeech(sample);
    assert.equal(cleanSpeech(once), once, sample);
  }
});

const defer = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = () => new Promise(r => setTimeout(r, 0));

test('speech plays in order even when later sentences finish synthesising first', async () => {
  const pending = new Map<string, ReturnType<typeof defer<string>>>();
  const played: string[] = [];
  const queue = createSpeechQueue<string>({
    synthesize: (text) => { const d = defer<string>(); pending.set(text, d); return d.promise; },
    deliver: async (audio) => { played.push(audio); },
    concurrency: 2,
  });
  const first = queue.push('一');
  const second = queue.push('二');
  void queue.push('三');
  await tick();
  assert.deepEqual([...pending.keys()], ['一', '二'], 'at most two at once');
  pending.get('二')?.resolve('audio-2');
  await tick();
  assert.deepEqual(played, [], 'the second waits for the first');
  pending.get('一')?.resolve('audio-1');
  assert.equal(await first, true);
  assert.equal(await second, true);
  await tick();
  pending.get('三')?.resolve('audio-3');
  await queue.idle();
  assert.deepEqual(played, ['audio-1', 'audio-2', 'audio-3']);
});

test('a failed sentence is skipped and cancel drops what has not played yet', async () => {
  const errors: string[] = [];
  const played: string[] = [];
  const queue = createSpeechQueue<string>({
    synthesize: async (text) => { if (text === 'bad') throw new Error('tts down'); return `a:${text}`; },
    deliver: async (audio) => { played.push(audio); },
    onError: (error, text) => errors.push(`${text}:${(error as Error).message}`),
  });
  void queue.push('ok1');
  assert.equal(await queue.push('bad'), false);
  void queue.push('ok2');
  await queue.idle();
  assert.deepEqual(played, ['a:ok1', 'a:ok2']);
  assert.deepEqual(errors, ['bad:tts down']);

  const gate = defer();
  const slow = createSpeechQueue<string>({
    synthesize: async (text) => { await gate.promise; return text; },
    deliver: async (audio) => { played.push(audio); },
  });
  const dropped = slow.push('late');
  slow.cancel();
  slow.cancel();
  gate.resolve();
  assert.equal(await dropped, false);
  assert.ok(!played.includes('late'));
  assert.equal(await slow.push('after'), true, 'the queue keeps working after cancelling, however many times');
});

test('a sentence with nothing to say is not delivered', async () => {
  const played: string[] = [];
  const queue = createSpeechQueue<string>({
    synthesize: async () => null,
    deliver: async (audio) => { played.push(audio); },
  });
  assert.equal(await queue.push('[laugh]'), false);
  assert.deepEqual(played, []);
});
