"use client";

import { useEffect, useState } from "react";
import { applyTheme, getStoredTheme, setTheme, type Theme } from "../lib/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const TITLE: Record<Theme, string> = {
  system: "Theme: system (click to switch to light)",
  light: "Theme: light (click to switch to dark)",
  dark: "Theme: dark (click to switch to auto)",
};

export function ThemeToggle() {
  const [theme, setLocal] = useState<Theme>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  const Icon = theme === "system" ? MonitorIcon : theme === "light" ? SunIcon : MoonIcon;

  return (
    <button
      onClick={() => {
        const next = NEXT[theme];
        setTheme(next);
        setLocal(next);
      }}
      className="flex h-8 w-8 items-center justify-center rounded-full text-current/70 hover:bg-current/10 hover:text-current"
      title={TITLE[theme]}
      aria-label={TITLE[theme]}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}
