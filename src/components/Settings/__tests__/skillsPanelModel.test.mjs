import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSkillRows,
  getAssistantId,
  getSkillSourceLabel,
  getSkillValidationErrors,
  isAssistantSkillConfigUpdate,
  normalizeSkillNameInput,
  summarizeSkillRows,
  validateSkillName,
} from '../skillsPanelModel.js';

test('normalizes skill template names to portable slugs', () => {
  assert.equal(normalizeSkillNameInput('  PDF Helper  '), 'pdf-helper');
  assert.equal(normalizeSkillNameInput('GitHub___Review!!'), 'github-review');
  assert.equal(validateSkillName('github-review'), '');
  assert.match(validateSkillName('GitHub Review'), /lowercase/);
});

test('resolves assistant ids from current and legacy shapes', () => {
  assert.equal(getAssistantId({ _id: 'pet-a' }), 'pet-a');
  assert.equal(getAssistantId({ id: 'pet-b' }), 'pet-b');
  assert.equal(getAssistantId({ petId: 'pet-c' }), 'pet-c');
});

test('normalizes validation errors from backend variants', () => {
  assert.deepEqual(
    getSkillValidationErrors({ validation_errors: ['Missing description', { message: 'Bad name' }] }),
    ['Missing description', 'Bad name'],
  );
  assert.deepEqual(
    getSkillValidationErrors({ valid: false, error: 'SKILL.md is missing' }),
    ['SKILL.md is missing'],
  );
  assert.deepEqual(
    getSkillValidationErrors({ validationError: 'Frontmatter is invalid' }),
    ['Frontmatter is invalid'],
  );
});

test('builds sorted skill rows and merges enabled config', () => {
  const rows = buildSkillRows([
    { id: 'zeta', name: 'Zeta', valid: true },
    { skillId: 'alpha', name: 'Alpha', description: 'A skill', version: '1.0.0' },
  ], ['alpha']);

  assert.deepEqual(rows.map(row => row.id), ['alpha', 'zeta']);
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].version, '1.0.0');
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[1].description, 'No description provided.');
  assert.equal(rows[0].sourceLabel, 'Global');
});

test('labels global skills and assistant overrides consistently', () => {
  assert.equal(getSkillSourceLabel({ source: 'global' }), 'Global');
  assert.equal(getSkillSourceLabel({ source: 'assistant' }), 'Assistant override');
  assert.equal(getSkillSourceLabel({ source: 'workspace' }), 'Assistant override');

  const [row] = buildSkillRows([{ id: 'private-skill' }], [], { defaultSource: 'assistant' });
  assert.equal(row.sourceLabel, 'Assistant override');
});

test('summarizes Assistant skill selection state', () => {
  assert.deepEqual(summarizeSkillRows([
    { id: 'enabled', enabled: true, isValid: true },
    { id: 'disabled', enabled: false, isValid: true },
    { id: 'invalid', enabled: false, isValid: false },
  ]), {
    total: 3,
    enabled: 1,
    valid: 2,
    invalid: 1,
  });
});

test('matches only the selected Assistant skill config event', () => {
  assert.equal(isAssistantSkillConfigUpdate({ key: 'skills_config_pet-a' }, 'pet-a'), true);
  assert.equal(isAssistantSkillConfigUpdate({ key: 'skills_config_pet-b' }, 'pet-a'), false);
  assert.equal(isAssistantSkillConfigUpdate({ key: 'skills_config_' }, ''), false);
});
