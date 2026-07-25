/**
 * Normalize the externally used conversation type to the workspace directory
 * used by Social Agent state files.
 *
 * The runtime historically used both "private" and "friend" for direct
 * conversations. Treat both as the same storage namespace.
 */
export function socialTargetDir(targetType = 'group') {
  return targetType === 'friend' || targetType === 'private' ? 'friend' : 'group';
}

export function isPrivateSocialTarget(targetType = 'group') {
  return socialTargetDir(targetType) === 'friend';
}

export default socialTargetDir;
