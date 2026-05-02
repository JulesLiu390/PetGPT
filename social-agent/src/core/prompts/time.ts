/**
 * Time helpers for prompt injection.
 * Ported from src/utils/timeInjection.js (Tauri side).
 */

const TIME_INJECTION_INTERVAL_MS = 8 * 60 * 60 * 1000;

/** Formats current local time + timezone for system-prompt injection. */
export function formatCurrentTime(): string {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formattedDate = now.toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const formattedTime = now.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });
  return `${formattedDate}, ${formattedTime} (${timezone})`;
}

export function shouldInjectTime(lastInjectionTimestamp: number | null): boolean {
  if (!lastInjectionTimestamp) return true;
  return Date.now() - lastInjectionTimestamp > TIME_INJECTION_INTERVAL_MS;
}

export { TIME_INJECTION_INTERVAL_MS };
