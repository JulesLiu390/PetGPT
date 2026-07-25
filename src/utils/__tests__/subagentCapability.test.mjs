import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureSubagentPermission,
  isSubagentEnabledForConversation,
  isSubagentPermissionCurrent,
  isSubagentRuntimeEnabled,
  matchesSubagentScope,
  setSubagentEnabledForConversation,
} from '../subagentCapability.js';

test('subagents default off and conversation overrides stay isolated', () => {
  const initial = {};
  const enabledA = setSubagentEnabledForConversation(initial, 'chat-a', true);

  assert.equal(isSubagentEnabledForConversation(initial, 'chat-a'), false);
  assert.equal(isSubagentEnabledForConversation(enabledA, 'chat-a'), true);
  assert.equal(isSubagentEnabledForConversation(enabledA, 'chat-b'), false);
});

test('runtime guard is fail-closed and supports live predicates', () => {
  let enabled = true;
  let revision = 0;
  const requestRevision = revision;
  const config = { isEnabled: () => enabled && revision === requestRevision };

  assert.equal(isSubagentRuntimeEnabled(config), true);
  enabled = false;
  revision += 1;
  assert.equal(isSubagentRuntimeEnabled(config), false);
  enabled = true;
  revision += 1;
  assert.equal(isSubagentRuntimeEnabled(config), false, 'an old request cannot revive after off → on');
  assert.equal(isSubagentRuntimeEnabled({ isEnabled: () => { throw new Error('stale'); } }), false);
  assert.equal(isSubagentRuntimeEnabled(null), false);
});

test('off → on invalidates the permission captured by an older request', () => {
  const token = captureSubagentPermission({ 'chat-a': true }, {}, 'chat-a');
  const reEnabledOverrides = { 'chat-a': true };
  const revisions = { 'chat-a': 2 };

  assert.equal(token.enabled, true);
  assert.equal(isSubagentPermissionCurrent(token, reEnabledOverrides, revisions), false);
  assert.equal(isSubagentPermissionCurrent(
    captureSubagentPermission(reEnabledOverrides, revisions, 'chat-a'),
    reEnabledOverrides,
    revisions,
  ), true);
});

test('task scope separates chat tabs, social tasks, and pets', () => {
  const chatA = { source: 'chat', conversationId: 'chat-a' };
  const chatB = { source: 'chat', conversationId: 'chat-b' };
  const socialA = { source: 'social', conversationId: 'chat-a', petId: 'pet-a' };

  assert.equal(matchesSubagentScope(chatA, { source: 'chat', conversationId: 'chat-a' }), true);
  assert.equal(matchesSubagentScope(chatB, { source: 'chat', conversationId: 'chat-a' }), false);
  assert.equal(matchesSubagentScope(socialA, { source: 'chat', conversationId: 'chat-a' }), false);
  assert.equal(matchesSubagentScope(socialA, { source: 'social', petId: 'pet-a' }), true);
  assert.equal(matchesSubagentScope(socialA, { source: 'social', petId: 'pet-b' }), false);
});
