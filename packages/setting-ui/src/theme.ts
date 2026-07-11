"use client";

import { useEffect, useLayoutEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const storageKey = "silverretort-theme";
const systemThemeQuery = "(prefers-color-scheme: dark)";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function applyTheme(preference: ThemePreference) {
  const dark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia(systemThemeQuery).matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function useThemePreference() {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "system";
    const stored = window.localStorage.getItem(storageKey);
    return isThemePreference(stored) ? stored : "system";
  });

  useLayoutEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia(systemThemeQuery);
    const handleChange = () => applyTheme("system");
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const setTheme = (value: ThemePreference) => {
    setThemeState(value);
    window.localStorage.setItem(storageKey, value);
    applyTheme(value);
  };

  return { theme, setTheme };
}
