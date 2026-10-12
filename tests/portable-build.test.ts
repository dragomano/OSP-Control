import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface BundleConfig {
  active?: boolean;
  targets?: unknown;
  icon?: string[];
  resources?: unknown;
  windows?: { nsis?: unknown };
}

interface TauriConfig {
  bundle: BundleConfig;
}

const tauriConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
) as TauriConfig;

const { scripts } = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

// The project distributes a portable build only: no MSI, no NSIS. The bundler is the
// single switch that would bring installers back, so it is asserted here rather than
// trusted to stay off.
describe('portable-only distribution', () => {
  it('never lets the bundler run', () => {
    expect(tauriConfig.bundle.active).toBe(false);
  });

  it('keeps no installer targets or installer options configured', () => {
    expect(tauriConfig.bundle.targets).toBeUndefined();
    expect(tauriConfig.bundle.windows?.nsis).toBeUndefined();
  });

  it('keeps the icon: with bundling off the exe takes its icon from bundle.icon', () => {
    expect(tauriConfig.bundle.icon).toContain('icons/icon.ico');
  });

  it('keeps the locales mapping: the editable dictionaries ship next to the exe', () => {
    expect(tauriConfig.bundle.resources).toEqual({ 'resources/locales/': 'locales/' });
  });

  it('assembles the portable folder right after the build', () => {
    expect(scripts['tauri:build']).toBe('tauri build && node scripts/make-portable.mjs');
  });
});
