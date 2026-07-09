const modelToId = (model) => {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object') return null;
  const id = model.id || model.name || model.modelName;
  return id === undefined || id === null ? null : String(id);
};

const parseArrayField = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeModelList = (value) => (
  parseArrayField(value)
    .map(modelToId)
    .filter(Boolean)
);

export const normalizeApiProvider = (provider) => {
  if (!provider || typeof provider !== 'object') return provider;
  const id = provider._id || provider.id;
  return {
    ...provider,
    id,
    _id: id,
    cachedModels: normalizeModelList(provider.cachedModels),
    hiddenModels: normalizeModelList(provider.hiddenModels),
  };
};

export const normalizeApiProviders = (providers) => {
  if (!Array.isArray(providers)) return [];
  return providers.map(normalizeApiProvider).filter(Boolean);
};
