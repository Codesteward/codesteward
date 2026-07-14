/** Appearance preference stored in localStorage (`cs-theme`). */
export type ThemePreference = "dark" | "light" | "system";
/** Resolved theme applied to `document.documentElement[data-theme]`. */
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "cs-theme";

const LISTENERS = new Set<(pref: ThemePreference, resolved: ResolvedTheme) => void>();

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function normalizeThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  // Legacy: only light was stored as "light"; everything else was dark
  return "dark";
}

export function getThemePreference(): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function resolveTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/** Apply preference to DOM + persist. Safe to call before React mounts. */
export function applyTheme(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  try {
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.style.colorScheme = resolved;
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
  for (const fn of LISTENERS) fn(pref, resolved);
  return resolved;
}

export function setThemePreference(pref: ThemePreference): ResolvedTheme {
  return applyTheme(pref);
}

export function subscribeTheme(
  fn: (pref: ThemePreference, resolved: ResolvedTheme) => void,
): () => void {
  LISTENERS.add(fn);
  return () => LISTENERS.delete(fn);
}

/** Watch OS preference when user chose "system". */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
