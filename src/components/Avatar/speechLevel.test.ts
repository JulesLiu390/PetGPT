import test from 'node:test';
import assert from 'node:assert/strict';
import { easeMouth, speechLevelAt, startSpeech, stopSpeech } from './speechLevel.ts';

test('the level follows the envelope while it plays and is silent before and after', () => {
  startSpeech({ envelope: [0.2, 1, 0.5], frameMs: 20 }, 1000);
  assert.equal(speechLevelAt(999), 0);
  assert.equal(speechLevelAt(1000), 0.2);
  assert.equal(speechLevelAt(1025), 1);
  assert.equal(speechLevelAt(1059), 0.5);
  assert.equal(speechLevelAt(1060), 0, 'finished');
  stopSpeech();
  assert.equal(speechLevelAt(1025), 0, 'stopped early');
  startSpeech({ envelope: [], frameMs: 20 }, 0);
  assert.equal(speechLevelAt(5), 0, 'nothing to play');
  startSpeech({ envelope: [7, -1], frameMs: 10 }, 0);
  assert.deepEqual([speechLevelAt(0), speechLevelAt(10)], [1, 0], 'clamped to 0…1');
  startSpeech({ envelope: [0.5], frameMs: 0 }, 0);
  assert.equal(speechLevelAt(0), 0, 'no frame length, nothing to play');
  stopSpeech();
});

test('starting the same utterance again restarts it, and stopping twice is stopping once', () => {
  const utterance = { envelope: [0.4, 0.8], frameMs: 20 };
  startSpeech(utterance, 0);
  startSpeech(utterance, 100);
  assert.equal(speechLevelAt(100), 0.4, 'restarted, not stacked');
  assert.equal(speechLevelAt(120), 0.8);
  stopSpeech();
  stopSpeech();
  assert.equal(speechLevelAt(100), 0);
});

test('the mouth opens faster than it closes and never overshoots', () => {
  const opened = easeMouth(0, 1, 1 / 60);
  const closed = 1 - easeMouth(1, 0, 1 / 60);
  assert.ok(opened > closed, `${opened} vs ${closed}`);
  assert.ok(easeMouth(0, 1, 10) <= 1 && easeMouth(0, 1, 10) > 0.999);
  assert.equal(easeMouth(0.3, 0.3, 1 / 60), 0.3);
});
