import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { paletteColors } from '../scripts/daisyui';
import {
  applyColorTheme,
  COLOR_THEMES,
  colorThemeColors,
  colorThemeId,
  colorThemeIsLight,
  colorThemeSwatches,
  resolveColorThemeColors,
} from '../src/colorThemes';
import {
  paletteContent,
  paletteContrast,
  paletteHex,
  paletteInk,
  parsePaletteColor,
} from '../src/paletteColors';
import { projectTagAppearance } from '../src/projectTags';
import { ACCENT_THEMES, accentSwatch, applyAccentTheme } from '../src/theme';

afterEach(() => {
  applyColorTheme('default', true);
  document.documentElement.style.cssText = '';
  document.documentElement.removeAttribute('data-ui-palette');
  document.documentElement.removeAttribute('data-theme');
});

describe('color themes', () => {
  it('keeps the selection mark readable against both ends of every original accent swatch', () => {
    for (const theme of ACCENT_THEMES) {
      const fill = accentSwatch(theme.delta, '#eda75f');
      const ink = paletteContent(fill);
      expect(paletteContrast(fill, ink)).toBeGreaterThanOrEqual(4.5);
      expect(paletteContrast(accentSwatch(theme.delta, '#f0b263'), ink)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('merges the factory light/dark pair and supplies two modes for every palette without geometry tokens', () => {
    const installed = JSON.parse(
      readFileSync('node_modules/daisyui/theme/object.js', 'utf8')
        .replace(/^export default /, '')
        .replace(/;\s*$/, ''),
    );
    const colorsOnly = (colors: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(colors).filter(([key]) => key === 'color-scheme' || key.startsWith('--color-')),
      );
    expect(Object.keys(COLOR_THEMES).slice(0, 3)).toEqual(['default', 'custom', 'daisy']);
    expect(Object.keys(COLOR_THEMES).slice(3).sort()).toEqual(
      Object.keys(installed)
        .filter((id) => id !== 'light' && id !== 'dark')
        .sort(),
    );
    expect(Object.keys(COLOR_THEMES)).toHaveLength(36);
    expect(COLOR_THEMES.daisy.light).toEqual(colorsOnly(installed.light));
    expect(COLOR_THEMES.daisy.dark).toEqual(colorsOnly(installed.dark));
    for (const [id, palette] of Object.entries(COLOR_THEMES).slice(3)) {
      const native = installed[id]['color-scheme'];
      expect(palette[native as 'light' | 'dark']).toEqual(colorsOnly(installed[id]));
      for (const light of [true, false]) {
        const colors = colorThemeColors(id, light);
        expect(colors['color-scheme']).toBe(light ? 'light' : 'dark');
        for (const key of Object.keys(colors))
          expect(key === 'color-scheme' || key.startsWith('--color-')).toBe(true);
      }
    }
  });

  it('honors light, dark and system mode for every theme and migrates old factory IDs', () => {
    for (const id of Object.keys(COLOR_THEMES)) {
      expect(colorThemeIsLight(id, 'system', true)).toBe(true);
      expect(colorThemeIsLight(id, 'system', false)).toBe(false);
      expect(colorThemeIsLight(id, 'light', false)).toBe(true);
      expect(colorThemeIsLight(id, 'dark', true)).toBe(false);
    }
    expect(colorThemeId('__proto__')).toBe('default');
    expect(colorThemeId('missing')).toBe('default');
    expect(colorThemeId('light')).toBe('daisy');
    expect(colorThemeId('dark')).toBe('daisy');
  });

  it('clears palette overrides when returning to Default and resolves Custom accent aliases', () => {
    applyAccentTheme('blue');
    applyColorTheme('custom', true);
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe(
      document.documentElement.style.getPropertyValue('--lt-accent'),
    );
    applyColorTheme('night', false);
    expect(document.documentElement.dataset.theme).toBe('night-dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--ui-neutral-ink')).not.toBe('');
    applyColorTheme('default', true);
    expect(document.documentElement.dataset.uiPalette).toBe('default');
    expect(document.documentElement.style.getPropertyValue('--ui-neutral-ink')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe(
      document.documentElement.style.getPropertyValue('--lt-accent'),
    );
    expect(document.documentElement.style.getPropertyValue('--k-eda75f')).not.toBe('');
  });

  it('provides theme-specific accent choices and readable colors for both modes of every DaisyUI theme', () => {
    for (const id of Object.keys(COLOR_THEMES).slice(2))
      for (const light of [true, false]) {
        const swatches = colorThemeSwatches(id, light);
        expect(swatches).toHaveLength(6);
        expect(new Set(swatches?.map((option) => option.fill)).size).toBe(6);
        for (const swatch of swatches ?? []) {
          const colors = resolveColorThemeColors(id, light, swatch.id);
          expect(colors['--color-primary']).toBe(swatch.fill);
          expect(
            paletteContrast(colors['--color-primary'], colors['--color-primary-content']),
          ).toBeGreaterThanOrEqual(4.5);
          const surfaces = ['100', '200', '300'].map((level) => colors[`--color-base-${level}`]);
          const ink = paletteInk(colors['--color-primary'], surfaces, light);
          for (const surface of surfaces) {
            expect(paletteContrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
            expect(paletteContrast(colors['--color-base-content'], surface)).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    expect(colorThemeSwatches('default', true)).toBeNull();
    expect(colorThemeSwatches('custom', false)).toBeNull();
  });

  it('round-trips sRGB primary colors and neutral colors through the OKLCH conversion', () => {
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#808080']) {
      const parsed = parsePaletteColor(hex);
      expect(parsed).not.toBeNull();
      if (parsed) expect(paletteHex(parsed)).toBe(hex);
    }
    expect(paletteContrast('#000000', '#ffffff')).toBe(21);
  });

  it('leaves responsive geometry and accent declarations intact and keeps literal color fallbacks', () => {
    const css =
      '@media (max-width: 760px) { .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; color: #ededed; border: 1px solid #363d46; --k-eda75f: #eda75f; } } @container (width < 500px) { .row { padding: 10px; } }';
    const result = paletteColors(css);
    expect(result).toContain('display: grid; grid-template-columns: 1fr 1fr; gap: 12px;');
    expect(result).toContain('@container (width < 500px) { .row { padding: 10px; } }');
    expect(result).toContain('--k-eda75f: #eda75f;');
    expect(result).toContain('color: var(--ui-neutral-ink, #ededed)');
    expect(result).toContain('border: 1px solid var(--ui-neutral-line, #363d46)');
  });
});

describe('tag readability', () => {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5]
      .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };

  it('keeps at least WCAG AA contrast across dark, light and mid-tone user colors', () => {
    for (let r = 0; r <= 255; r += 17)
      for (let g = 0; g <= 255; g += 17)
        for (let b = 0; b <= 255; b += 17) {
          const color = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}` as const;
          const ink = (projectTagAppearance({ tag: color }, 'tag').style as Record<string, string>)[
            '--tag-ink'
          ];
          const a = luminance(color),
            z = luminance(ink);
          expect((Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05)).toBeGreaterThanOrEqual(4.5);
        }
  });
});
