// Workbench/src/hooks/useTheme.js
import { useCallback, useEffect, useState } from "react";
import { readThemePref, resolveTheme, writeThemePref } from "../lib/theme.js";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function useTheme() {
  const [pref, setPrefState] = useState(readThemePref);
  const [theme, setTheme] = useState(() => resolveTheme(readThemePref(), media.matches));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onChange = (event) => setTheme(resolveTheme(pref, event.matches));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((next) => {
    setPrefState(next);
    writeThemePref(next);
    setTheme(resolveTheme(next, media.matches));
  }, []);

  return { pref, theme, setPref };
}
