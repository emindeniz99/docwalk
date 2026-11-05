import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "docwalk.theme";

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Light/dark follows the system unless the viewer picks one; the choice is a per-browser convenience. */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(readStored);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // Storage can be unavailable (private mode); the theme still applies for this visit.
    }
  }, [theme]);
  return [theme, setTheme];
}
