import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  version: string;
}
interface TauriConfig {
  version: string;
}

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
const tauriConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
) as TauriConfig;

// The [package] section only — dependency lines carry version numbers too.
const cargoManifest = readFileSync(resolve(process.cwd(), 'src-tauri/Cargo.toml'), 'utf8');
const packageSection = cargoManifest.slice(cargoManifest.indexOf('[package]'), cargoManifest.indexOf('\n['));
const cargoVersion = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

describe('app version', () => {
  it('package.json is the single source of truth: tauri.conf.json references it instead of pinning a copy', () => {
    expect(tauriConfig.version).toBe('../package.json');
  });

  it('package.json version is a valid semver string', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it('Cargo.toml crate version stays in lockstep with package.json', () => {
    expect(cargoVersion).toBe(pkg.version);
  });
});
