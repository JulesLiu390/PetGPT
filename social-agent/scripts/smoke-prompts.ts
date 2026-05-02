/**
 * Smoke test for socialPromptBuilder.
 *   - readers return null on missing files (no throw)
 *   - Reply mode prompt has expected sections
 *   - Intent mode prompt has expected sections
 *   - intentHistory formatter handles empty + populated
 *
 * Run: bun run scripts/smoke-prompts.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from '../src/platform/index.ts';
import {
  createSocialPromptBuilders,
  formatIntentHistoryForPrompt,
  buildSubagentStatusSection,
  DEFAULT_REPLY_STRATEGY,
} from '../src/core/prompts/social.ts';
import { truncateContent } from '../src/core/prompts/petFiles.ts';
import { formatCurrentTime } from '../src/core/prompts/time.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const home = mkdtempSync(join(tmpdir(), 'social-agent-prompt-test-'));
const platform = createNodePlatform(home);
const petId = 'pet-test';
const builders = createSocialPromptBuilders(platform);

// ── helpers ──
console.log('\n── helpers ──');
{
  check('truncateContent passthrough', truncateContent('short') === 'short');
  const long = 'a'.repeat(30000);
  const truncated = truncateContent(long, 1000);
  check('truncateContent truncates over limit', truncated.length < long.length);
  check('truncateContent has marker', truncated.includes('内容被截断'));

  check('formatCurrentTime returns string', typeof formatCurrentTime() === 'string');

  check('DEFAULT_REPLY_STRATEGY has tier tags', DEFAULT_REPLY_STRATEGY.includes('回复时机'));

  check('formatIntentHistory empty', formatIntentHistoryForPrompt([]) === '');
  const filled = formatIntentHistoryForPrompt([
    { ts: Date.now(), actions: [{ type: 'reply', atTarget: 'Bob' }], briefDigest: 'said hi' },
  ]);
  check('formatIntentHistory populated', filled.includes('reply') && filled.includes('@Bob'));

  const reg = new Map();
  reg.set('sa_1', { target: 'g1', status: 'running', task: 'check x', createdAt: Date.now() - 10000 });
  reg.set('sa_2', { target: 'g1', status: 'done', task: 'check y', outputPath: 'cc_xyz.md', createdAt: Date.now() - 1000 });
  reg.set('sa_3', { target: 'g2', status: 'running', task: 'other group', createdAt: Date.now() });   // filtered
  const sub = buildSubagentStatusSection(reg, 'g1');
  check('subagent section includes running', sub.includes('⏳'));
  check('subagent section includes done',    sub.includes('✅'));
  check('subagent section excludes other group', !sub.includes('other group'));
}

// ── readers (missing files → null) ──
console.log('\n── readers (no files yet) ──');
{
  check('readSocialMemoryFile null',  (await builders.readSocialMemoryFile(petId)) === null);
  check('readGroupRuleFile null',     (await builders.readGroupRuleFile(petId, '111')) === null);
  check('readContactsFile null',      (await builders.readContactsFile(petId)) === null);
  check('readIntentStateFile null',   (await builders.readIntentStateFile(petId, '111')) === null);
  check('readReplyStrategyFile null', (await builders.readReplyStrategyFile(petId)) === null);
  const history = await builders.readIntentHistoryFile(petId, '111');
  check('readIntentHistoryFile empty array', Array.isArray(history) && history.length === 0);
}

// ── readers after writes ──
console.log('\n── readers (after writes) ──');
{
  await platform.workspace.write(petId, 'SOUL.md', '# Soul\nI am a cat.');
  await platform.workspace.write(petId, 'social/SOCIAL_MEMORY.md', 'memory content');
  await platform.workspace.write(petId, 'social/CONTACTS.md', 'Alice 12345');
  await platform.workspace.write(petId, 'social/group/RULE_111.md', 'group 111 rule');
  await platform.workspace.write(petId, 'social/group/INTENT_111.md', 'intent state');
  await platform.workspace.write(petId, 'social/group/scratch_111/notes.md', 'note');
  await platform.workspace.write(petId, 'social/group/scratch_111/reply_brief.md', '[闲扯] hi');
  await platform.workspace.write(petId, 'social/stickers/index.yaml', '- id: 1\n  meaning: laughing\n- id: 2\n  meaning: shocked\n');

  check('readSocialMemoryFile content', (await builders.readSocialMemoryFile(petId)) === 'memory content');
  check('readGroupRuleFile content',    (await builders.readGroupRuleFile(petId, '111')) === 'group 111 rule');
  check('readReplyBriefFile content',   (await builders.readReplyBriefFile(petId, '111')) === '[闲扯] hi');
  const sticker = await builders.readStickerIndexForPrompt(petId);
  check('readStickerIndexForPrompt parsed', sticker !== null && sticker.includes('#1 laughing'));
}

// ── buildSocialPrompt: Reply mode ──
console.log('\n── buildSocialPrompt (reply) ──');
{
  const prompt = await builders.buildSocialPrompt({
    petId,
    socialPersonaPrompt: '猫娘 高知识',
    targetName: '测试群',
    targetId: '111',
    targetType: 'group',
    botQQ: '99999',
    role: 'reply',
    lurkMode: 'normal',
  });
  check('reply prompt non-empty',         prompt.length > 1000);
  check('contains soul section',          prompt.includes('# 人格'));
  check('contains group rule section',    prompt.includes('# 「测试群」(111) 群规则'));
  check('contains social mode section',   prompt.includes('# 社交模式'));
  check('contains 当前时间',              prompt.includes('当前时间：'));
  check('contains tool instruction',      prompt.includes('# 可用操作'));
  check('contains markdown ban',          prompt.includes('严禁') && prompt.includes('Markdown'));
  check('contains intent handoff (brief)', prompt.includes('# Intent 交接') && prompt.includes('[闲扯] hi'));
  check('reply mode hides observer guidance', !prompt.includes('# 联系人索引'));   // observer-only
}

// ── buildSocialPrompt: Observer mode ──
console.log('\n── buildSocialPrompt (observer) ──');
{
  const prompt = await builders.buildSocialPrompt({
    petId,
    targetName: '测试群',
    targetId: '111',
    targetType: 'group',
    botQQ: '99999',
    role: 'observer',
    lurkMode: 'full-lurk',
  });
  check('observer prompt non-empty',           prompt.length > 1000);
  check('contains observer mode',              prompt.includes('# 观察模式'));
  check('contains 联系人索引 (observer-only)', prompt.includes('# 联系人索引'));
  check('contains 社交记忆 (observer-only)',   prompt.includes('# 社交记忆（全局）'));
  check('contains lurk tool instructions',     prompt.includes('social_tree') || prompt.includes('观察完毕后'));
}

// ── buildIntentSystemPrompt ──
console.log('\n── buildIntentSystemPrompt ──');
{
  const prompt = await builders.buildIntentSystemPrompt({
    petId,
    targetName: '测试群',
    targetId: '111',
    targetType: 'group',
    botQQ: '99999',
    lurkMode: 'normal',
    voiceEnabled: true,
    imageGenEnabled: true,
  });
  check('intent prompt non-empty',           prompt.length > 5000);
  check('contains 角色人格',                 prompt.includes('# 角色人格'));
  check('contains 群信息',                   prompt.includes('# 「测试群」(111) 群信息'));
  check('contains 当前状态感知',             prompt.includes('# 当前状态感知'));
  check('contains state file path',          prompt.includes('social/group/INTENT_111.md'));
  check('contains scratch dir path',         prompt.includes('social/group/scratch_111'));
  check('contains 评估要求 / get_situation', prompt.includes('# 评估要求') && prompt.includes('get_situation'));
  check('contains write_intent_plan',        prompt.includes('write_intent_plan'));
  check('voice enabled → voice_send block',  prompt.includes('voice_send'));
  check('imageGen enabled → AI 生图 block',  prompt.includes('AI 生图工具'));
  check('contains 表情包 (collected list)',  prompt.includes('#1 laughing'));
  check('contains free-mode prelude',        prompt.includes('自由模式'));
}

// ── full-lurk mode disables certain blocks ──
console.log('\n── buildIntentSystemPrompt (full-lurk) ──');
{
  const prompt = await builders.buildIntentSystemPrompt({
    petId,
    targetName: '测试群',
    targetId: '111',
    targetType: 'group',
    lurkMode: 'full-lurk',
  });
  check('full-lurk prelude',         prompt.includes('纯观察模式'));
  check('full-lurk hides 表情包',    !prompt.includes('#1 laughing'));   // sticker block gated
  check('full-lurk constraint warning', prompt.includes('actions 必须为空数组'));
}

// ── customGroupRules block ──
console.log('\n── buildIntentSystemPrompt with customGroupRules ──');
{
  const prompt = await builders.buildIntentSystemPrompt({
    petId,
    targetName: '测试群',
    targetId: '111',
    targetType: 'group',
    customGroupRules: '不要回复主人之外的人',
  });
  check('custom rule visible',         prompt.includes('不要回复主人之外的人'));
  check('custom rule marked priority', prompt.includes('最高优先级'));
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
