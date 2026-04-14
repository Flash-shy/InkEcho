export type ThemePreference = "light" | "dark" | "auto";

const STORAGE_KEY = "inkecho-theme";

export function getStoredThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    /* ignore */
  }
  return "auto";
}

export function setStoredThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
}

/** Hour0–23 in Asia/Shanghai. */
export function getShanghaiHour(d = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value;
  return parseInt(h ?? "12", 10);
}

/** Night 18:00–06:00 Shanghai → dark. */
export function resolveAutoTheme(d = new Date()): "light" | "dark" {
  const hour = getShanghaiHour(d);
  return hour >= 18 || hour < 6 ? "dark" : "light";
}

export function resolveTheme(pref: ThemePreference, d = new Date()): "light" | "dark" {
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return resolveAutoTheme(d);
}

export function applyThemeToDocument(resolved: "light" | "dark"): void {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}
