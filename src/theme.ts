import { useEffect, useState } from 'react';
import { isDesktopApp } from './ospanel';

// Accent themes are built by rotating the hue of the original orange palette.
// The literal list matches the --k-* CSS variables in styles.css.
export const ACCENT_LITERALS = [
  '#231b1220',
  '#4d3a2428',
  '#d89a5a1b',
  '#d89a5a31',
  '#d9973f1a',
  '#d9973f1f',
  '#d9973f33',
  '#d9973f4b',
  '#eda75f1f',
  '#f7e3c433',
  '#ffe2c24f',
  '#eda75f',
  '#f0b263',
  '#f4bc78',
  '#f6c184',
  '#e8a95f',
  '#c07a2e',
  '#b0762a',
  '#8a5a1a',
  '#f0c08c',
  '#f5c084',
  '#e8b57e',
  '#eeb26a',
  '#e8b877',
  '#edb377',
  '#f0cd96',
  '#e5b877',
  '#e0a558',
  '#a38a5f',
  '#a06a24',
  '#b8895a',
  '#d9973f',
  '#f7d9ae',
  '#3d2a14',
  '#ffe9d0',
  '#fff3e0',
  '#2b1a08',
  '#241608',
  '#3a2a17',
  '#332a1e',
  '#332a1c',
  '#362a1c',
  '#322b20',
  '#2a2118',
  '#241d13',
  '#241d14',
  '#3a2f1f',
  '#4a3a22',
  '#3a2f22',
  '#1b1712',
  '#1a1712',
  '#f7ecdb',
  '#faf3e6',
  '#faf3e4',
  '#eadfc8',
  '#4d3b26',
];

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;

  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));

    return Math.round(255 * v)
      .toString(16)
      .padStart(2, '0');
  };

  return `${f(0)}${f(8)}${f(4)}`;
}

function rotateHex(literal: string, delta: number): string {
  const alpha = literal.length === 9 ? literal.slice(7) : null;
  const [h, s, l] = hexToHsl(literal.slice(1, 7));
  const rotated = hslToHex((h + delta + 360) % 360, s, l);

  return alpha ? `#${rotated}${alpha}` : `#${rotated}`;
}

export type AccentTheme = { id: string; delta: number };
export const ACCENT_THEMES: AccentTheme[] = [
  { id: 'orange', delta: 0 },
  { id: 'green', delta: 110 },
  { id: 'blue', delta: 180 },
  { id: 'purple', delta: -125 },
  // The magenta-red sector is empty in the default set: red and pink sit far from
  // every existing hue and from each other, so all six stay tellable apart.
  { id: 'red', delta: -40 },
  { id: 'pink', delta: -85 },
];

export type FontOption = { id: string; stack: string };
export const FONT_OPTIONS: FontOption[] = [
  { id: 'dm-sans', stack: "'DM Sans',system-ui,sans-serif" },
  { id: 'segoe', stack: "'Segoe UI',system-ui,sans-serif" },
  { id: 'arial', stack: 'Arial,sans-serif' },
  { id: 'tahoma', stack: 'Tahoma,sans-serif' },
  { id: 'verdana', stack: 'Verdana,sans-serif' },
  { id: 'consolas', stack: "'Cascadia Code',Consolas,monospace" },
];

export function applyAccentTheme(id: string) {
  const theme = ACCENT_THEMES.find((item) => item.id === id) ?? ACCENT_THEMES[0];
  const root = document.documentElement;

  for (const literal of ACCENT_LITERALS) {
    root.style.setProperty(`--k-${literal.slice(1).toLowerCase()}`, rotateHex(literal, theme.delta));
  }
}

export function applyFont(id: string) {
  const font = FONT_OPTIONS.find((item) => item.id === id) ?? FONT_OPTIONS[0];

  document.documentElement.style.setProperty('--font-ui', font.stack);
}

export function accentSwatch(delta: number, base: string): string {
  return rotateHex(base, delta);
}

// UI scale: native webview zoom in the desktop app, CSS zoom in the browser.
export function applyUiScale(percent: number) {
  const zoom = Math.min(1.3, Math.max(0.8, percent / 100));

  if (isDesktopApp()) {
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_ui_zoom', { zoom })).catch(() => {});
    return;
  }

  document.body.style.zoom = String(zoom);
}

// Light/dark theme: 'system' follows the OS setting via prefers-color-scheme.
export type ThemeMode = 'system' | 'dark' | 'light';

// Subscribes to system theme changes so the 'system' mode switches on the fly.
export function useSystemPrefersLight(): boolean {
  const [light, setLight] = useState(() => window.matchMedia('(prefers-color-scheme: light)').matches);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent) => setLight(event.matches);
    query.addEventListener('change', onChange);

    return () => query.removeEventListener('change', onChange);
  }, []);

  return light;
}
