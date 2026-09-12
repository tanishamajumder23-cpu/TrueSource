import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'truthsource:theme';

/**
 * Dark/light theme, persisted to localStorage.
 *
 * Dark is the product default (the app is read-heavy and often used at night),
 * but we honour an explicit saved choice above everything else. The theme is
 * applied as a data-attribute on <html>, which is what the token stylesheet
 * keys off — so a single attribute swap re-themes the entire app with no
 * re-render cost.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    // localStorage throws in some privacy modes; never let that break boot.
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* ignore */
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}
