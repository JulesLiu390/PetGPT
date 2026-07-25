function normalizePetId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function createDefaultSocialConfig(petId = '') {
  return {
    petId: normalizePetId(petId),
    mcpServerName: '',
    apiProviderId: '',
    modelName: '',
    replyInterval: 0,
    observerInterval: 180,
    watchedGroups: [],
    watchedFriends: [],
    targetsByServer: {},
    configByServer: {},
    socialPersonaPrompt: '',
    replyStrategyPrompt: '',
    customGroupRules: {},
    agentCanEditStrategy: false,
    atMustReply: true,
    enableImages: true,
    imageDescMode: 'off',
    imageDescProviderId: '',
    imageDescModelName: '',
    botQQ: '',
    ownerQQ: '',
    ownerName: '',
    enabledMcpServers: [],
    observerApiProviderId: '',
    observerModelName: '',
    intentApiProviderId: '',
    intentModelName: '',
    compressApiProviderId: '',
    compressModelName: '',
    subagentEnabled: true,
    subagentMaxConcurrent: 5,
    subagentTimeoutSecs: 300,
    subagentModel: 'sonnet',
    explicitPromptCache: true,
    ttsConfig: null,
    imageGenConfig: null,
  };
}

export function isSameSocialPet(left, right) {
  const a = normalizePetId(left);
  const b = normalizePetId(right);
  return Boolean(a && b && a === b);
}

export function scopeSocialStatus(status = {}, requestedPetId = '') {
  const requested = normalizePetId(requestedPetId);
  const statusPetId = normalizePetId(status.petId);
  const activePetId = status.active ? statusPetId : '';
  const startingPetId = status.starting ? statusPetId : '';

  if (!requested || requested === statusPetId) {
    return {
      ...status,
      petId: requested || statusPetId || null,
      activePetId: activePetId || null,
    };
  }

  return {
    active: false,
    starting: false,
    petId: requested,
    activePetId: activePetId || null,
    startingPetId: startingPetId || null,
  };
}

export function shouldApplySocialCommand(activePetId, requestedPetId) {
  return isSameSocialPet(activePetId, requestedPetId);
}

export function withSocialTrainingConfig(config, settings = {}, trainingTargetsOverride) {
  const persistedTargets = (
    settings.trainingTargets
    && typeof settings.trainingTargets === 'object'
    && !Array.isArray(settings.trainingTargets)
  ) ? settings.trainingTargets : {};
  const localTargets = (
    trainingTargetsOverride
    && typeof trainingTargetsOverride === 'object'
    && !Array.isArray(trainingTargetsOverride)
  ) ? trainingTargetsOverride : {};
  const trainingTargets = {
    ...persistedTargets,
    ...localTargets,
  };

  return {
    ...config,
    trainingCollectionEnabled: Boolean(settings.trainingCollectionEnabled),
    trainingTargets,
  };
}
