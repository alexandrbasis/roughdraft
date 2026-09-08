export type ThemePreference = "system" | "light" | "dark";

const storageKey = "roughdraft:theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // A blocked storage area must not prevent system theme detection.
  }
  return "system";
}

let preference = readPreference();

function applyTheme() {
  const dark =
    preference === "dark" || (preference === "system" && systemTheme.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
}

export function getThemePreference() {
  return preference;
}

export function subscribeToTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    window.localStorage.setItem(storageKey, next);
  } catch {
    // Still allow a session-only choice when persistence is unavailable.
  }
  applyTheme();
  for (const listener of listeners) listener();
}

export function initializeTheme() {
  applyTheme();
  systemTheme.addEventListener("change", applyTheme);
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== storageKey) return;
    preference = readPreference();
    applyTheme();
    for (const listener of listeners) listener();
  });
}
