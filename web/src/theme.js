import { iconButton, icon } from './ui.js';

const KEY = 'wd-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export function currentTheme() {
  return document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(theme));
}

export const onThemeChange = (fn) => listeners.add(fn);
media.addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) listeners.forEach((fn) => fn(currentTheme()));
});

export function themeButton() {
  const btn = iconButton(currentTheme() === 'dark' ? 'sun' : 'moon', 'Toggle light / dark', () => {
    apply(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  onThemeChange((t) => btn.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon')));
  return btn;
}
