import { paletteContent, paletteHex, paletteInk, parsePaletteColor } from './paletteColors';
import custom from './palettes/custom.json';
import daisy from './palettes/daisyui.json';
import type { ThemeMode } from './theme';

export type Colors = Record<string, string>;
type Palette = { name: string; light?: Colors; dark?: Colors };
type PaletteInput = Palette & { colors?: Colors };
const roles = ['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error'];
const accentRoles: Record<string, string> = {
  orange: 'primary',
  green: 'success',
  blue: 'info',
  purple: 'secondary',
  red: 'error',
  pink: 'accent',
};

// A companion changes lightness and surface chroma while retaining the source hues.
// Explicit light/dark entries in custom.json take precedence over generated colors.
export function companionColors(source: Colors, light: boolean): Colors {
  const result: Colors = { 'color-scheme': light ? 'light' : 'dark' };
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('--color-')) continue;
    const parsed = parsePaletteColor(value);
    if (!parsed) {
      result[key] = value;
      continue;
    }
    let { l, c } = parsed;
    const base = ['--color-base-100', '--color-base-200', '--color-base-300'].indexOf(key);
    if (base !== -1) {
      l = (light ? [0.98, 0.95, 0.9] : [0.24, 0.205, 0.17])[base];
      c = Math.min(c, light ? 0.025 : 0.04);
    } else if (key === '--color-base-content') {
      l = light ? 0.19 : 0.92;
      c = Math.min(c, 0.025);
    } else if (key === '--color-neutral') {
      l = light ? 0.28 : 0.18;
      c = Math.min(c, 0.04);
    } else if (!key.endsWith('-content'))
      l = light ? Math.min(0.62, Math.max(0.44, l)) : Math.min(0.82, Math.max(0.68, l));
    result[key] = paletteHex({ ...parsed, l, c });
  }
  return result;
}
function paired(palette: PaletteInput): Palette {
  const source = palette.colors ?? palette.light ?? palette.dark;
  if (!source) return palette;
  return {
    name: palette.name,
    light: palette.light ?? (source['color-scheme'] === 'light' ? source : companionColors(source, true)),
    dark: palette.dark ?? (source['color-scheme'] === 'dark' ? source : companionColors(source, false)),
  };
}
export const COLOR_THEMES: Record<string, Palette> = {
  default: { name: 'Default' },
  ...Object.fromEntries(Object.entries(custom).map(([id, palette]) => [id, paired(palette)])),
  daisy: { name: 'DaisyUI', light: daisy.light, dark: daisy.dark },
  ...Object.fromEntries(
    Object.entries(daisy)
      .filter(([id]) => id !== 'light' && id !== 'dark')
      .map(([id, colors]) => [id, paired({ name: id[0].toUpperCase() + id.slice(1), colors })]),
  ),
};
export function colorThemeId(id: string | null | undefined): string {
  if (id === 'light' || id === 'dark') return 'daisy';
  return id && Object.keys(COLOR_THEMES).includes(id) ? id : 'default';
}
export function colorThemeIsLight(_id: string, mode: ThemeMode, systemLight: boolean): boolean {
  return mode === 'light' || (mode === 'system' && systemLight);
}
export function colorThemeColors(id: string, light: boolean): Colors {
  return COLOR_THEMES[colorThemeId(id)][light ? 'light' : 'dark'] ?? daisy[light ? 'light' : 'dark'];
}
function readableColors(source: Colors, light: boolean): Colors {
  const result = Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      const parsed = key.startsWith('--color-') ? parsePaletteColor(value) : null;
      return [key, parsed ? paletteHex(parsed) : value];
    }),
  );
  const surfaces = ['100', '200', '300'].map((level) => result[`--color-base-${level}`]);
  result['--color-base-content'] = paletteInk(result['--color-base-content'], surfaces, light);
  for (const role of roles) {
    if (parsePaletteColor(result[`--color-${role}`] ?? ''))
      result[`--color-${role}-content`] = paletteContent(
        result[`--color-${role}`],
        result[`--color-${role}-content`],
      );
  }
  return result;
}
function usesAppAccent(id: string, colors: Colors): boolean {
  return id === 'default' || /var\(--(?:lt-|k-)/.test(colors['--color-primary']);
}
function paletteSwatches(colors: Colors, light: boolean): { id: string; fill: string }[] {
  const chosen: { id: string; fill: string }[] = [];
  const primary = parsePaletteColor(colors['--color-primary']);
  const distance = (first: string, second: string) => {
    const a = parsePaletteColor(first),
      b = parsePaletteColor(second);
    if (!a || !b) return 1;
    const x = (color: typeof a) => color.c * Math.cos((color.h * Math.PI) / 180);
    const y = (color: typeof a) => color.c * Math.sin((color.h * Math.PI) / 180);
    return Math.hypot(a.l - b.l, x(a) - x(b), y(a) - y(b));
  };
  for (const [id, role] of Object.entries(accentRoles)) {
    let fill = colors[`--color-${role}`];
    // Monochrome palettes often repeat one color for all semantic roles. Give
    // these swatches distinct accents while leaving the original first choice intact.
    if (primary && chosen.some((option) => distance(option.fill, fill) < 0.055)) {
      for (let attempt = 0; attempt < 18; attempt++) {
        fill = paletteHex({
          l: light ? 0.55 : 0.72,
          c: Math.max(0.12, Math.min(primary.c, 0.2)),
          h: (primary.h + chosen.length * 65 + attempt * 25) % 360,
        });
        if (chosen.every((option) => distance(option.fill, fill) >= 0.055)) break;
      }
    }
    chosen.push({ id, fill });
  }
  return chosen;
}
export function resolveColorThemeColors(
  id: string,
  light: boolean,
  accent = 'orange',
  resolve: (value: string) => string = (value) => value,
): Colors {
  const source = colorThemeColors(id, light);
  const colors = readableColors(
    Object.fromEntries(Object.entries(source).map(([key, value]) => [key, resolve(value)])),
    light,
  );
  if (!usesAppAccent(id, source)) {
    const choices = paletteSwatches(colors, light);
    const selected = choices.find((option) => option.id === accent) ?? choices[0];
    colors['--color-primary'] = selected.fill;
    colors['--color-primary-content'] = paletteContent(
      selected.fill,
      colors[`--color-${accentRoles[accent] ?? 'primary'}-content`],
    );
  }
  return colors;
}
export function colorThemeSwatches(id: string, light: boolean): { id: string; fill: string }[] | null {
  const colors = colorThemeColors(id, light);
  if (usesAppAccent(id, colors)) return null;
  const prepared = readableColors(colors, light);
  return paletteSwatches(prepared, light);
}

let applied: string[] = [];
export function applyColorTheme(id: string, light: boolean, accent = 'orange') {
  const root = document.documentElement;
  for (const key of applied) root.style.removeProperty(key);
  applied = [];
  id = colorThemeId(id);
  root.dataset.uiPalette = id;
  root.dataset.theme = `${id}-${light ? 'light' : 'dark'}`;
  root.style.colorScheme = light ? 'light' : 'dark';
  const colors = resolveColorThemeColors(id, light, accent, (value) => {
    const alias = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    return alias ? root.style.getPropertyValue(alias).trim() || value : value;
  });
  const set = (key: string, value: string) => {
    root.style.setProperty(key, value);
    applied.push(key);
  };
  // Default also provides DaisyUI tokens for primitives without a legacy skin.
  for (const [key, value] of Object.entries(colors)) {
    if (key.startsWith('--color-')) {
      set(key, value);
    }
  }
  if (id === 'default') {
    const accent = root.style.getPropertyValue(light ? '--lt-accent' : '--k-eda75f').trim();
    const content = root.style.getPropertyValue(light ? '--lt-on-accent' : '--k-2b1a08').trim();
    if (accent) set('--color-primary', accent);
    if (content) set('--color-primary-content', content);
    return;
  }
  for (const tone of ['neutral', 'primary', 'secondary', 'info', 'success', 'warning', 'error']) {
    const color = tone === 'neutral' ? 'var(--color-base-content)' : `var(--color-${tone})`;
    const surfaces = ['100', '200', '300'].map((level) => colors[`--color-base-${level}`]);
    const ink =
      tone === 'neutral'
        ? colors['--color-base-content']
        : paletteInk(colors[`--color-${tone}`], surfaces, light);
    set(`--ui-${tone}-ink`, ink);
    set(`--ui-${tone}-ink-muted`, `color-mix(in oklab, ${ink} 70%, var(--color-base-100))`);
    set(
      `--ui-${tone}-fill`,
      tone === 'neutral'
        ? 'var(--color-base-100)'
        : `color-mix(in oklab, ${color} 12%, var(--color-base-100))`,
    );
    set(
      `--ui-${tone}-line`,
      tone === 'neutral'
        ? 'var(--color-base-300)'
        : `color-mix(in oklab, ${color} 30%, var(--color-base-100))`,
    );
  }
  for (let alpha = 0; alpha <= 100; alpha++)
    set(`--ui-alpha-${alpha}`, `color-mix(in oklab, var(--color-base-content) ${alpha}%, transparent)`);
  for (let alpha = 0; alpha <= 100; alpha++)
    set(`--ui-shadow-alpha-${alpha}`, `color-mix(in oklab, black ${alpha}%, transparent)`);
}
