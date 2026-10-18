import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCENT_LITERALS,
  ACCENT_THEMES,
  accentSwatch,
  applyAccentTheme,
  applyFont,
  applyUiScale,
  FONT_OPTIONS,
} from '../src/theme';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8').toLowerCase();

describe('accentSwatch (hue rotation)', () => {
  it('returns every palette literal unchanged at delta 0', () => {
    for (const literal of ACCENT_LITERALS) {
      expect(accentSwatch(0, literal)).toBe(literal);
    }
  });

  it('rotates hue deterministically: #ff0000 at 90 gives #80ff00', () => {
    expect(accentSwatch(90, '#ff0000')).toBe('#80ff00');
  });

  it('keeps achromatic colors unchanged at any rotation', () => {
    for (const delta of [0, 90, 180, -125]) {
      expect(accentSwatch(delta, '#000000')).toBe('#000000');
      expect(accentSwatch(delta, '#ffffff')).toBe('#ffffff');
    }
  });

  it('preserves the alpha channel of 9-character literals', () => {
    for (const literal of ACCENT_LITERALS.filter((item) => item.length === 9)) {
      const rotated = accentSwatch(-125, literal);
      expect(rotated.length).toBe(9);
      expect(rotated.startsWith('#')).toBe(true);
      expect(rotated.slice(7)).toBe(literal.slice(7));
    }
  });

  it('gives each accent theme its own color', () => {
    const values = ACCENT_THEMES.map((theme) => accentSwatch(theme.delta, '#eda75f'));
    expect(new Set(values).size).toBe(ACCENT_THEMES.length);
  });
});

describe('applyAccentTheme / applyFont / applyUiScale', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
  });

  it('applyAccentTheme sets all --k-* variables on the document root', () => {
    applyAccentTheme('blue');
    for (const literal of ACCENT_LITERALS) {
      const name = `--k-${literal.slice(1).toLowerCase()}`;
      expect(document.documentElement.style.getPropertyValue(name)).toBe(accentSwatch(180, literal));
    }
  });

  it('an unknown theme id falls back to orange', () => {
    applyAccentTheme('nope');
    expect(document.documentElement.style.getPropertyValue('--k-eda75f')).toBe(accentSwatch(0, '#eda75f'));
  });

  it('applyAccentTheme retunes the light theme accent, hue included', () => {
    applyAccentTheme('orange');
    const orange = document.documentElement.style.getPropertyValue('--lt-accent');
    applyAccentTheme('blue');
    const blue = document.documentElement.style.getPropertyValue('--lt-accent');

    expect(orange).toMatch(/^#[0-9a-f]{6}$/);
    expect(blue).toMatch(/^#[0-9a-f]{6}$/);
    expect(blue).not.toBe(orange);

    for (const token of ['--lt-accent', '--lt-accent-text', '--lt-accent-strong', '--lt-on-accent']) {
      expect(document.documentElement.style.getPropertyValue(token)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('applyFont sets --font-ui; an unknown id falls back to the first font', () => {
    applyFont('segoe');
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(FONT_OPTIONS[1].stack);
    applyFont('nope');
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(FONT_OPTIONS[0].stack);
  });

  it('applyUiScale zooms the body clamped to 80-130%', () => {
    applyUiScale(100);
    expect(document.body.style.zoom).toBe('1');
    applyUiScale(150);
    expect(document.body.style.zoom).toBe('1.3');
    applyUiScale(50);
    expect(document.body.style.zoom).toBe('0.8');
  });
});

describe('parity: --k-* between theme.ts and styles.css', () => {
  const literalNames = ACCENT_LITERALS.map((literal) => literal.slice(1).toLowerCase());
  // The lookahead prevents capturing the 6-char prefix of 8-char names (--k-4d3a2428).
  const defs = new Set([...css.matchAll(/--k-([0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-f])\s*:/g)].map((m) => m[1]));
  const uses = new Set([...css.matchAll(/var\(--k-([0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-f])/g)].map((m) => m[1]));

  it('every literal has a --k-* definition in styles.css', () => {
    const missing = literalNames.filter((name) => !defs.has(name));
    expect(missing).toEqual([]);
  });

  it('the default variable value matches the literal', () => {
    const wrong: string[] = [];
    for (const name of literalNames) {
      const match = css.match(new RegExp(`--k-${name}\\s*:\\s*(#[0-9a-f]{6}|#[0-9a-f]{8})\\s*;`));
      if (!match || match[1] !== `#${name}`) wrong.push(name);
    }
    expect(wrong).toEqual([]);
  });

  it('every used var(--k-*) is rotated by the theme', () => {
    const unrotated = [...uses].filter((name) => !literalNames.includes(name));
    expect(unrotated).toEqual([]);
  });
});

describe('parity: light theme tokens between theme.ts and styles.css', () => {
  const accentTokens = ['--lt-accent', '--lt-accent-text', '--lt-accent-strong', '--lt-on-accent'];
  const paletteTokens = ['--lt-bg', '--lt-panel', '--lt-panel-2', '--lt-text', '--lt-muted', '--lt-dim'];

  it('the :root block declares defaults for every accent token', () => {
    for (const token of accentTokens) {
      const match = css.match(new RegExp(`${token}\\s*:\\s*#[0-9a-f]{6}\\s*;`));
      expect(match, token).not.toBeNull();
    }
  });

  it('the light shell declares the palette primitives', () => {
    const shell = css.match(/\.app-shell\.light\s*\{([\s\S]*?)\n\}/);
    expect(shell).not.toBeNull();

    for (const token of paletteTokens) {
      expect(shell?.[1], token).toContain(`${token}: #`);
    }
  });

  it('every var(--lt-*) used in styles.css is declared somewhere', () => {
    const declared = new Set([...css.matchAll(/(--lt-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--lt-[a-z0-9-]+)/g)].map((m) => m[1]));
    const missing = [...used].filter((token) => !declared.has(token));
    expect(missing).toEqual([]);
  });
});
