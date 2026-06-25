// packages/ui/src/components/ThemeToggle.tsx
// T7.10 — Light/dark theme toggle (placed early so the T7.4 layout
// compiles; full behavior arrives in T7.10).

import React, { useEffect, useState } from "react";

type Theme = "light" | "dark";

function getInitial(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem("cw-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(getInitial);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("cw-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  return (
    <button
      className="cw-theme-toggle"
      aria-label="Toggle theme"
      onClick={() => setTheme(theme === "light" ? "dark" : "light")}
    >
      {theme === "dark" ? "☾" : "☀"}
    </button>
  );
}