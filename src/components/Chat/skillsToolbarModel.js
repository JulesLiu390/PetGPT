export function getToolbarSkillId(skill, index = 0) {
  return String(skill?.id || skill?.skillId || skill?.skill_id || skill?.name || `skill-${index}`);
}

export function getSkillValidationErrors(skill) {
  const values = [
    skill?.validationErrors,
    skill?.validationError,
    skill?.validation_error,
    skill?.errors,
  ];
  return [...new Set(values
    .flatMap(value => Array.isArray(value) ? value : (value ? [value] : []))
    .map(value => typeof value === 'string' ? value : (value?.message || value?.error || ''))
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

export function buildSkillsToolbarRows(skills, config) {
  const enabledIds = new Set(config?.enabledSkillIds || []);
  return (Array.isArray(skills) ? skills : [])
    .map((skill, index) => {
      const id = getToolbarSkillId(skill, index);
      const validationErrors = getSkillValidationErrors(skill);
      return {
        ...skill,
        id,
        name: String(skill?.name || id),
        description: String(skill?.description || ''),
        scopes: Array.isArray(skill?.scopes) ? skill.scopes : [],
        source: skill?.source === 'global' ? 'global' : 'assistant',
        enabled: enabledIds.has(id),
        validationErrors,
        valid: skill?.valid !== false && validationErrors.length === 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isSkillsConfigUpdate(payload, petId) {
  const id = String(petId || '').trim();
  return !!id && payload?.key === `skills_config_${id}`;
}

// Invalid Skills cannot be enabled, but an already-enabled Skill must remain
// switchable so the user can remove it from the allowlist.
export function canToggleToolbarSkill(skill) {
  return skill?.valid === true || skill?.enabled === true;
}
