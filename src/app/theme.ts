/**
 * Theme preference plumbing for the token-based colour layer.
 *
 * The stylesheet resolves every colour through a semantic token (see
 * src/styles/tokens.css), so switching theme is a `data-theme` attribute swap on
 * <html> — components never need to know which theme is active.
 *
 * Preference is either an explicit choice ("light" / "dark") or "system", which
 * follows the OS and keeps following it while the tab stays open.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'colipas.theme';

const THEME_QUERY = '(prefers-color-scheme: dark)';
const THEME_CHANGE_EVENT = 'colipas:theme-change';

export const themePreferences: readonly ThemePreference[] = ['light', 'dark', 'system'];

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (themePreferences as readonly string[]).includes(value);
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Private mode / disabled storage: fall back to the system preference.
    return null;
  }
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia(THEME_QUERY).matches ? 'dark' : 'light';
}

export function readThemePreference(): ThemePreference {
  const stored = safeStorage()?.getItem(THEME_STORAGE_KEY) ?? null;
  return isThemePreference(stored) ? stored : 'system';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? readSystemTheme() : preference;
}

/** Apply the preference to <html> and return the theme that is now in effect. */
export function applyTheme(preference: ThemePreference = readThemePreference()): ResolvedTheme {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  return resolved;
}

/** Persist an explicit preference (or "system"), apply it, and notify subscribers. */
export function setThemePreference(preference: ThemePreference): ResolvedTheme {
  const safePreference = isThemePreference(preference) ? preference : 'system';
  safeStorage()?.setItem(THEME_STORAGE_KEY, safePreference);
  const resolved = applyTheme(safePreference);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { preference: safePreference, resolved } }));
  return resolved;
}

/** One-click toggle: explicit light <-> dark, leaving "system" for the settings group. */
export function toggleTheme(preference: ThemePreference = readThemePreference()): ResolvedTheme {
  return setThemePreference(resolveTheme(preference) === 'dark' ? 'light' : 'dark');
}

/**
 * Follow OS changes while the preference is "system", and mirror explicit
 * changes made in other tabs. Returns an unsubscribe function.
 */
export function subscribeToTheme(
  listener: (resolved: ResolvedTheme, preference: ThemePreference) => void,
): () => void {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(THEME_QUERY) : null;
  const emit = () => {
    const preference = readThemePreference();
    // Another tab (or the OS) changed the preference: re-apply the attribute
    // before notifying, otherwise this tab updates its state but keeps the old
    // colours on screen.
    listener(applyTheme(preference), preference);
  };
  const onMediaChange = () => {
    if (readThemePreference() !== 'system') {
      return;
    }
    emit();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      emit();
    }
  };
  media?.addEventListener('change', onMediaChange);
  window.addEventListener('storage', onStorage);
  return () => {
    media?.removeEventListener('change', onMediaChange);
    window.removeEventListener('storage', onStorage);
  };
}
