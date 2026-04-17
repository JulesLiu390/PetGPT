import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, loadRecords, applyFilters } from '../export_intent_training.mjs';
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
