import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSkillsToolbarRows,
  canToggleToolbarSkill,
  getSkillValidationErrors,
  isSkillsConfigUpdate,
} from '../skillsToolbarModel.js';

test('builds sorted toolbar rows and applies the per-assistant enabled set', () => {
  const rows = buildSkillsToolbarRows([
    { skillId: 'writer', name: 'Writer', source: 'global', valid: true },
    { skillId: 'analyst', name: 'Analyst', source: 'assistant', valid: true },
  ], { enabledSkillIds: ['writer'] });

  assert.deepEqual(rows.map(row => row.id), ['analyst', 'writer']);
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[1].enabled, true);
  assert.equal(rows[1].source, 'global');
});

test('invalid Skills cannot be treated as valid toolbar choices', () => {
  const rows = buildSkillsToolbarRows([
    { skillId: 'broken', valid: true, validationError: 'Missing description' },
  ], { enabledSkillIds: ['broken'] });

  assert.equal(rows[0].valid, false);
  assert.deepEqual(rows[0].validationErrors, ['Missing description']);
  assert.equal(canToggleToolbarSkill(rows[0]), true, 'an already-enabled invalid Skill can be disabled');
  assert.equal(canToggleToolbarSkill({ valid: false, enabled: false }), false);
});

test('normalizes validation errors without duplicates', () => {
  assert.deepEqual(getSkillValidationErrors({
    validationErrors: ['bad', { message: 'worse' }],
    validationError: 'bad',
  }), ['bad', 'worse']);
});

test('matches only the selected assistant Skills settings event', () => {
  assert.equal(isSkillsConfigUpdate({ key: 'skills_config_pet-a' }, 'pet-a'), true);
  assert.equal(isSkillsConfigUpdate({ key: 'skills_config_pet-b' }, 'pet-a'), false);
  assert.equal(isSkillsConfigUpdate({ key: 'memoryEnabledByDefault' }, 'pet-a'), false);
  assert.equal(isSkillsConfigUpdate({ key: 'skills_config_' }, ''), false);
});
