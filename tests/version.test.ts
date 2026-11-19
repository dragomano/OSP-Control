import { describe, expect, it } from 'vitest';
import packageManifest from '../package.json';
import { readCargoPackage } from '../scripts/cargo-package.mjs';
import { APP_VERSION } from '../src/brand';
import tauriConfig from '../src-tauri/tauri.conf.json';

describe('app version', () => {
  it('allows Tauri to use the Cargo package version', () => {
    expect(packageManifest).not.toHaveProperty('version');
    expect(tauriConfig).not.toHaveProperty('version');
  });

  it('uses the Cargo package version in the frontend', () => {
    expect(APP_VERSION).toBe(readCargoPackage().version);
  });
});
