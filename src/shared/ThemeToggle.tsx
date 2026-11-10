import { Moon, Sun } from "lucide-react";
import { useState } from "react";

const THEME_KEY = "cafe-color-mode";

function setTheme(isDark: boolean) {
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, isDark ? "dark" : "light"); } catch { /* Theme still applies for this page view. */ }
}

export function initializeTheme() {
  let isDark = false;
  try { isDark = localStorage.getItem(THEME_KEY) === "dark"; } catch { /* Use the light theme when storage is unavailable. */ }
  setTheme(isDark);
}

export function ThemeToggle({ floating = false }: { floating?: boolean }) {
  const [isDark, setIsDark] = useState(() => document.documentElement.dataset.theme === "dark");
  const nextTheme = isDark ? "light" : "dark";

  return <button
    className={`theme-toggle${floating ? " theme-toggle-floating" : ""}`}
    type="button"
    aria-label={`Switch to ${nextTheme} mode`}
    aria-pressed={isDark}
    title={`Switch to ${nextTheme} mode`}
    onClick={() => { setTheme(!isDark); setIsDark(!isDark); }}
  >
    {isDark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    <span>{isDark ? "Light" : "Dark"}</span>
  </button>;
}
