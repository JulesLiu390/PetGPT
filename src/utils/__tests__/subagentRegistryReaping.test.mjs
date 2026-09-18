import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

// subagentManager pulls in ./tauri (extensionless), so it is loaded through
// Vite's SSR pipeline the same way the other social-agent contract tests do.
let vite;
let MAX_INTENT_SURFACES;
let REGISTRY_HARD_CAP;
let TERMINAL_ENTRY_TTL_MS;
let isSubagentEntryReapable;
let markSubagentTerminal;
let reapSubagentRegistry;
let buildSubagentStatusSection;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  const [manager, promptBuilder] = await Promise.all([
    vite.ssrLoadModule('/src/utils/subagentManager.js'),
    vite.ssrLoadModule('/src/utils/socialPromptBuilder.js'),
  ]);
  ({
    MAX_INTENT_SURFACES,
    REGISTRY_HARD_CAP,
    TERMINAL_ENTRY_TTL_MS,
    isSubagentEntryReapable,
    markSubagentTerminal,
    reapSubagentRegistry,
  } = manager);
  ({ buildSubagentStatusSection } = promptBuilder);
});

after(async () => {
  await vite?.close();
});

const NOW = 1_700_000_000_000;

const entry = (overrides = {}) => ({
  status: 'done',
  task: 'do a thing',
  target: '12345',
  source: 'social',
  createdAt: NOW - 1000,
  terminalAt: NOW - 1000,
  ...overrides,
});

const registryOf = (entries) => new Map(entries.map((e, i) => [`sa_${i}`, e]));

test('running entries are never reaped', () => {
  assert.equal(isSubagentEntryReapable(entry({ status: 'running', terminalAt: 0 }), NOW), false);
  // Even a long-lived running task stays: it is still producing.
  assert.equal(
    isSubagentEntryReapable(entry({ status: 'running', createdAt: 0, terminalAt: 0 }), NOW),
    false,
  );
});

test('reflect (lessons) entries are reaped as soon as they reach a terminal state', () => {
  assert.equal(isSubagentEntryReapable(entry({ source: 'lessons' }), NOW), true);
  assert.equal(isSubagentEntryReapable(entry({ source: 'lessons', status: 'failed' }), NOW), true);
  assert.equal(
    isSubagentEntryReapable(entry({ source: 'lessons', status: 'running' }), NOW),
    false,
  );
});

test('an entry whose output Intent already read is reaped', () => {
  assert.equal(isSubagentEntryReapable(entry({ readByIntent: true }), NOW), true);
});

test('failed entries survive until they have been reported to Intent', () => {
  const failed = entry({ status: 'failed', surfacedToIntent: MAX_INTENT_SURFACES - 1 });
  assert.equal(isSubagentEntryReapable(failed, NOW), false);

  failed.surfacedToIntent = MAX_INTENT_SURFACES;
  assert.equal(isSubagentEntryReapable(failed, NOW), true);
});

test('unclaimed terminal entries expire on the TTL backstop', () => {
  const stale = entry({ status: 'timeout', terminalAt: NOW - TERMINAL_ENTRY_TTL_MS - 1 });
  assert.equal(isSubagentEntryReapable(stale, NOW), true);

  const fresh = entry({ status: 'timeout', terminalAt: NOW - 1000 });
  assert.equal(isSubagentEntryReapable(fresh, NOW), false);
});

test('TTL falls back to createdAt when terminalAt was never stamped', () => {
  const noStamp = entry({ status: 'failed', terminalAt: undefined, createdAt: NOW - TERMINAL_ENTRY_TTL_MS - 1 });
  assert.equal(isSubagentEntryReapable(noStamp, NOW), true);
});

test('markSubagentTerminal stamps once and only for terminal states', () => {
  const running = entry({ status: 'running', terminalAt: undefined });
  markSubagentTerminal(running, NOW);
  assert.equal(running.terminalAt, undefined);

  const done = entry({ terminalAt: undefined });
  markSubagentTerminal(done, NOW);
  assert.equal(done.terminalAt, NOW);

  // A second terminal event must not push the expiry deadline out.
  markSubagentTerminal(done, NOW + 5000);
  assert.equal(done.terminalAt, NOW);
});

test('reap removes only what is reapable and reports the ids', () => {
  const registry = registryOf([
    entry({ status: 'running', terminalAt: 0 }),
    entry({ source: 'lessons' }),
    entry({ readByIntent: true }),
    entry({ status: 'failed', surfacedToIntent: 0 }),
  ]);

  const reaped = reapSubagentRegistry({ now: NOW, registry });

  assert.deepEqual(reaped.sort(), ['sa_1', 'sa_2']);
  assert.deepEqual([...registry.keys()], ['sa_0', 'sa_3']);
});

test('the hard cap evicts the oldest terminal entries and never touches running ones', () => {
  const entries = [];
  // Fresh, unsurfaced terminal entries: none are reapable by the normal rules.
  for (let i = 0; i < REGISTRY_HARD_CAP + 20; i += 1) {
    entries.push(entry({ status: 'failed', terminalAt: NOW - (REGISTRY_HARD_CAP + 20 - i) }));
  }
  // Plus running tasks, which must survive regardless of the cap.
  for (let i = 0; i < 5; i += 1) {
    entries.push(entry({ status: 'running', terminalAt: 0, createdAt: 0 }));
  }
  const registry = registryOf(entries);

  reapSubagentRegistry({ now: NOW, registry });

  assert.equal(registry.size, REGISTRY_HARD_CAP);
  const running = [...registry.values()].filter(e => e.status === 'running');
  assert.equal(running.length, 5);
  // The survivors are the newest terminal entries.
  const oldestSurviving = Math.min(
    ...[...registry.values()].filter(e => e.status === 'failed').map(e => e.terminalAt),
  );
  assert.ok(oldestSurviving > NOW - (REGISTRY_HARD_CAP + 20));
});

test('reaping an empty registry is a no-op', () => {
  const registry = new Map();
  assert.deepEqual(reapSubagentRegistry({ now: NOW, registry }), []);
  assert.equal(registry.size, 0);
});

test('reporting a terminal task to Intent counts it toward reaping', () => {
  const failed = entry({ status: 'failed', error: 'boom', surfacedToIntent: 0 });
  const registry = registryOf([failed]);

  const section = buildSubagentStatusSection(registry, '12345');
  assert.match(section, /失败/);
  assert.equal(failed.surfacedToIntent, 1);

  // Reporting repeatedly eventually retires the entry instead of nagging forever.
  for (let i = 1; i < MAX_INTENT_SURFACES; i += 1) buildSubagentStatusSection(registry, '12345');
  assert.equal(isSubagentEntryReapable(failed, NOW), true);
});

test('running tasks are reported without ever becoming reapable', () => {
  const running = entry({ status: 'running', terminalAt: 0 });
  const registry = registryOf([running]);

  assert.match(buildSubagentStatusSection(registry, '12345'), /执行中/);
  assert.equal(running.surfacedToIntent, undefined);
  assert.equal(isSubagentEntryReapable(running, NOW), false);
});

test('reflect tasks are never reported to Intent', () => {
  const registry = registryOf([entry({ source: 'lessons', status: 'failed', error: 'boom' })]);
  assert.equal(buildSubagentStatusSection(registry, '12345'), '');
});

test('tasks belonging to another target are not reported or counted', () => {
  const other = entry({ status: 'failed', target: '99999' });
  const registry = registryOf([other]);

  assert.equal(buildSubagentStatusSection(registry, '12345'), '');
  assert.equal(other.surfacedToIntent, undefined);
});
