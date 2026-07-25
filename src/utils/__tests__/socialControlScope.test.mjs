import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultSocialConfig,
  isSameSocialPet,
  scopeSocialStatus,
  shouldApplySocialCommand,
  withSocialTrainingConfig,
} from '../socialControlScope.js';

test('default social configs are complete fresh objects per pet', () => {
  const first = createDefaultSocialConfig('pet-a');
  first.customGroupRules.group = 'only A';
  first.enabledMcpServers.push('server-a');
  const second = createDefaultSocialConfig('pet-b');

  assert.equal(second.petId, 'pet-b');
  assert.deepEqual(second.customGroupRules, {});
  assert.deepEqual(second.enabledMcpServers, []);
  assert.deepEqual(second.targetsByServer, {});
  assert.equal(second.atMustReply, true);
});

test('social pet scoping requires two matching non-empty ids', () => {
  assert.equal(isSameSocialPet('pet-a', 'pet-a'), true);
  assert.equal(isSameSocialPet(' pet-a ', 'pet-a'), true);
  assert.equal(isSameSocialPet('pet-a', 'pet-b'), false);
  assert.equal(isSameSocialPet('', ''), false);
  assert.equal(shouldApplySocialCommand('pet-a', 'pet-b'), false);
});

test('status queries for another pet return an explicit inactive snapshot', () => {
  const scoped = scopeSocialStatus({
    active: true,
    petId: 'pet-a',
    lurkModes: { 123: 'full-lurk' },
    pausedTargets: { 123: true },
  }, 'pet-b');

  assert.deepEqual(scoped, {
    active: false,
    starting: false,
    petId: 'pet-b',
    activePetId: 'pet-a',
    startingPetId: null,
  });
});

test('status for the active pet preserves runtime state', () => {
  const source = {
    active: true,
    petId: 'pet-a',
    lurkModes: { 123: 'semi-lurk' },
    pausedTargets: {},
  };
  assert.deepEqual(scopeSocialStatus(source, 'pet-a'), {
    ...source,
    activePetId: 'pet-a',
  });
});

test('starting status is scoped to the pet being initialized', () => {
  assert.deepEqual(scopeSocialStatus({
    active: false,
    starting: true,
    petId: 'pet-a',
    lurkModes: {},
    pausedTargets: {},
  }, 'pet-b'), {
    active: false,
    starting: false,
    petId: 'pet-b',
    activePetId: null,
    startingPetId: 'pet-a',
  });

  assert.equal(scopeSocialStatus({
    active: false,
    starting: true,
    petId: 'pet-a',
  }, 'pet-a').starting, true);
});

test('inactive snapshots never report an active pet and preserve saved runtime maps', () => {
  assert.deepEqual(scopeSocialStatus({
    active: false,
    petId: 'pet-a',
    lurkModes: { 123: 'semi-lurk' },
    pausedTargets: { 123: true },
  }, 'pet-a'), {
    active: false,
    petId: 'pet-a',
    activePetId: null,
    lurkModes: { 123: 'semi-lurk' },
    pausedTargets: { 123: true },
  });
});

test('training config is carried across full runtime restarts', () => {
  assert.deepEqual(
    withSocialTrainingConfig(
      { petId: 'pet-a', modelName: 'model' },
      { trainingCollectionEnabled: true, trainingTargets: { 123: true } },
    ),
    {
      petId: 'pet-a',
      modelName: 'model',
      trainingCollectionEnabled: true,
      trainingTargets: { 123: true },
    },
  );

  assert.deepEqual(
    withSocialTrainingConfig(
      { petId: 'pet-a' },
      { trainingCollectionEnabled: true, trainingTargets: { stale: true } },
      { current: true },
    ).trainingTargets,
    { stale: true, current: true },
  );
});
