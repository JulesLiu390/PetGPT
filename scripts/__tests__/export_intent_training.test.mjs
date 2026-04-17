import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, loadRecords, applyFilters, redactString, redactRecord, createRedactionMapping } from '../export_intent_training.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures');

test('parseArgs reads flags', () => {
  const a = parseArgs(['--input', 'in', '--output', 'out', '--redact', '--status', 'success']);
  assert.equal(a.input, 'in');
  assert.equal(a.output, 'out');
  assert.equal(a.redact, true);
  assert.equal(a.status, 'success');
});

test('parseArgs errors on missing required', () => {
  assert.throws(() => parseArgs(['--input', 'x']), /--output required/);
});

test('loadRecords reads all JSONL in dir', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  assert.equal(records.length, 3);
  assert.ok(records.find(r => r.id === 'itr_a'));
});

test('applyFilters by status', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const out = applyFilters(records, { status: 'success' });
  assert.equal(out.length, 2);
  assert.ok(out.every(r => r.status === 'success'));
});

test('applyFilters by termination', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const out = applyFilters(records, { termination: 'write_intent_plan' });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'itr_a');
});

test('applyFilters by target include/exclude', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  assert.equal(applyFilters(records, { includeTargets: ['11111'] }).length, 2);
  assert.equal(applyFilters(records, { excludeTargets: ['11111'] }).length, 1);
});

test('applyFilters by date window', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  assert.equal(applyFilters(records, { from: '2026-04-18' }).length, 1);
  assert.equal(applyFilters(records, { to: '2026-04-17' }).length, 2);
});

test('redactString replaces QQ numbers with stable placeholders', () => {
  const m = createRedactionMapping();
  const out1 = redactString('Hello 123456789 and 987654321', m);
  const out2 = redactString('Again 123456789', m);
  assert.match(out1, /^Hello U_[a-f0-9]{8} and U_[a-f0-9]{8}$/);
  // Same QQ → same placeholder
  const first = out1.match(/U_[a-f0-9]{8}/)[0];
  assert.ok(out2.includes(first));
});

test('redactRecord removes raw QQ from all fields', async () => {
  const records = await loadRecords(FIXTURE_DIR);
  const mapping = createRedactionMapping();
  const r = records.find(r => r.id === 'itr_a');
  r.system = 'system mentions 123456789';
  r.messages[0].content = 'user 123456789 says hi';
  const redacted = redactRecord(r, mapping);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('123456789'), false);
});
