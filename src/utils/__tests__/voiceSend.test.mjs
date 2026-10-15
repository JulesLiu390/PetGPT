import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * voice_send 的两次调用：Fish 的写法说明不进 system prompt，模型还看不见说明时
 * 第一次调用只返回说明、不发送；看得见之后直接走合成。测试环境没有 Tauri，
 * 合成必然失败，所以「走到了合成」体现为「TTS 生成失败」。
 */

let vite;
let socialTools;
let voiceScript;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  socialTools = await vite.ssrLoadModule('/src/utils/workspace/socialToolExecutor.js');
  voiceScript = await vite.ssrLoadModule('/src/utils/social/voiceScript.js');
});

after(async () => {
  await vite?.close();
});

const fishConfig = { enabled: true, provider: 'fish', fish: { apiKey: 'sk-fish', referenceId: 'ref' } };
const context = (extra) => ({
  petId: 'pet', targetId: 'g1', targetType: 'group', mcpServerName: 'qq',
  ttsConfig: fishConfig, ...extra,
});
const resultText = (result) => result?.content?.[0]?.text || '';

test('Fish：还没看过说明时只返回说明，不发送', async () => {
  const result = await socialTools.executeSubagentTool('voice_send',
    { direction: '开心', script: '你好呀' }, context({ voiceGuideVisible: () => false }));
  const text = resultText(result);
  assert.ok(!result.error, result.error);
  assert.ok(voiceScript.isVoiceGuideResult(text));
  assert.match(text, /还没有发出/);
  assert.match(text, /script="你好呀"/, '草稿带回去，模型不用重想');
  assert.match(text, /<whisper>/, '说明内容在里面');
});

test('Fish：看过说明之后直接合成', async () => {
  const result = await socialTools.executeSubagentTool('voice_send',
    { direction: '开心', script: '你好呀 [laugh]' }, context({ voiceGuideVisible: () => true }));
  assert.match(result.error || '', /TTS 生成失败/);
});

test('Fish：只有标签没有字，或 direction 写成长文，直接拒绝', async () => {
  const visible = context({ voiceGuideVisible: () => true });
  const empty = await socialTools.executeSubagentTool('voice_send', { script: '[sigh] <soft></soft>' }, visible);
  assert.match(empty.error, /没有要念的字/);
  const long = await socialTools.executeSubagentTool('voice_send', { direction: '慢'.repeat(101), script: '你好' }, visible);
  assert.match(long.error, /direction 超过/);
});

test('ElevenLabs 不需要说明，第一次就合成', async () => {
  const result = await socialTools.executeSubagentTool('voice_send', { text: '你好' }, context({
    ttsConfig: { enabled: true, provider: 'elevenlabs', apiKey: 'sk', voiceId: 'v' },
    voiceGuideVisible: () => false,
  }));
  assert.match(result.error || '', /TTS 生成失败/);
});

test('工具参数随服务商变', () => {
  const fish = socialTools.getVoiceSendToolDefinition('fish').function;
  assert.deepEqual(fish.parameters.required, ['script']);
  assert.ok(fish.parameters.properties.direction);
  assert.match(fish.description, /第一次调用不会发出/);
  const eleven = socialTools.getVoiceSendToolDefinition('elevenlabs').function;
  assert.deepEqual(Object.keys(eleven.parameters.properties), ['text']);
  assert.equal(fish.name, eleven.name);
});
