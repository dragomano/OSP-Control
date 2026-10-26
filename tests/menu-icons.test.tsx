import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MenuIcon, menuIcons } from '../src/menuIcons';

type Metadata = Record<
  string,
  {
    unicode: string;
    familyStylesByLicense: { free: { family: string; style: string }[] };
  }
>;

afterEach(cleanup);

describe('native menu icon compatibility', () => {
  it('offers every native Free icon without introducing names from newer fonts', () => {
    const baseline = JSON.parse(
      readFileSync(
        resolve('node_modules/@fortawesome/fontawesome-free-ospanel/metadata/icon-families.json'),
        'utf8',
      ),
    ) as Metadata;
    const names = Object.entries(baseline).flatMap(([name, data]) =>
      data.familyStylesByLicense.free
        .filter(({ family }) => family === 'classic')
        .map(({ style }) => (style === 'regular' ? `regular-${name}` : name)),
    );
    expect(menuIcons.map((icon) => icon.value).sort()).toEqual([...new Set(names)].sort());
    expect(() =>
      execFileSync(process.execPath, ['scripts/generate-menu-icons.mjs', '--check'], { cwd: process.cwd() }),
    ).not.toThrow();
  });

  it('resolves native aliases and uses the currently installed font family', () => {
    const { container } = render(<MenuIcon name="redo" />);
    const icon = container.querySelector('.menu-fa-solid');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon?.textContent).toBe(String.fromCodePoint(0xf01e));
  });

  it('still renders a native icon removed from the newer Free fonts', () => {
    const { container } = render(<MenuIcon name="vector-square" />);
    const fallback = container.querySelector('.menu-fa-fallback');
    expect(fallback).toHaveAttribute('viewBox', '0 0 448 512');
    expect(fallback?.querySelector('path')?.getAttribute('d')).toBeTruthy();
    expect(container.querySelector('.lucide-circle-help')).toBeNull();
  });
});
