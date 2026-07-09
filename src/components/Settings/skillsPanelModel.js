const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function getAssistantId(assistant) {
  return assistant?._id || assistant?.id || assistant?.petId || '';
}

export function normalizeSkillNameInput(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function validateSkillName(value) {
  const name = String(value || '').trim();
  if (!name) return 'Enter a skill name.';
  if (name.length > 64) return 'Skill names must be 64 characters or fewer.';
  if (!SKILL_NAME_PATTERN.test(name)) {
    return 'Use lowercase letters, numbers, and single hyphens only.';
  }
  return '';
}

function errorMessage(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    return String(value.message || value.error || value.detail || '').trim();
  }
  return '';
}

export function getSkillValidationErrors(skill) {
  const candidates = [
    skill?.validationErrors,
    skill?.validation_errors,
    skill?.validationError,
    skill?.validation_error,
    skill?.validation?.errors,
    skill?.errors,
  ];
  const messages = candidates
    .flatMap(value => Array.isArray(value) ? value : (value ? [value] : []))
    .map(errorMessage)
    .filter(Boolean);

  if (messages.length === 0 && skill?.valid === false) {
    const fallback = errorMessage(skill?.error) || 'This skill did not pass validation.';
    messages.push(fallback);
  }

  return [...new Set(messages)];
}

export function getSkillSourceLabel(skill, defaultSource = 'global') {
  const source = String(skill?.source || skill?.storage || defaultSource || 'global').toLowerCase();
  if (
    source.includes('assistant')
    || source.includes('override')
    || source.includes('workspace')
    || source === 'pet'
    || source === 'local'
  ) {
    return 'Assistant override';
  }
  return 'Global';
}

export function buildSkillRows(skills, enabledSkillIds = [], options = {}) {
  const enabled = new Set(enabledSkillIds || []);
  const defaultSource = options.defaultSource || 'global';
  return (Array.isArray(skills) ? skills : [])
    .map((skill, index) => {
      const id = String(skill?.id || skill?.skillId || skill?.skill_id || skill?.name || skill?.path || `skill-${index}`);
      const validationErrors = getSkillValidationErrors(skill);
      return {
        ...skill,
        id,
        name: skill?.name || id,
        description: skill?.description || 'No description provided.',
        version: skill?.version || skill?.metadata?.version || '',
        scopes: Array.isArray(skill?.scopes) ? skill.scopes : [],
        enabled: typeof skill?.enabled === 'boolean' ? skill.enabled : enabled.has(id),
        sourceLabel: getSkillSourceLabel(skill, defaultSource),
        validationErrors,
        isValid: validationErrors.length === 0 && skill?.valid !== false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeSkillRows(skills) {
  const rows = Array.isArray(skills) ? skills : [];
  return {
    total: rows.length,
    enabled: rows.filter(skill => skill?.enabled).length,
    valid: rows.filter(skill => skill?.isValid !== false).length,
    invalid: rows.filter(skill => skill?.isValid === false).length,
  };
}

export function isAssistantSkillConfigUpdate(payload, petId) {
  const id = String(petId || '').trim();
  return !!id && payload?.key === `skills_config_${id}`;
}

export function toErrorMessage(error, fallback = 'Something went wrong.') {
  if (typeof error === 'string' && error.trim()) return error;
  if (error?.message) return error.message;
  return fallback;
}
