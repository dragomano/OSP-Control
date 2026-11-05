import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const textExtensions = new Set(['.ts', '.tsx', '.rs', '.json', '.md', '.toml', '.mjs', '.yml', '.yaml']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && textExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

const files = [
  ...[
    'src',
    'tests',
    'src-tauri/src',
    'src-tauri/tests',
    'src-tauri/resources',
    'scripts',
    '.github',
  ].flatMap((directory) => sourceFiles(join(root, directory))),
  ...readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && textExtensions.has(extname(entry.name)))
    .map((entry) => join(root, entry.name)),
  join(root, 'src-tauri/Cargo.toml'),
  join(root, 'src-tauri/tauri.conf.json'),
  join(root, 'src-tauri/build.rs'),
];

function locations(pattern: RegExp): string[] {
  return files.flatMap((path) => {
    const content = readFileSync(path, 'utf8');
    // Report locations without repeating potentially personal values in CI output.
    return [...content.matchAll(pattern)].map(
      (match) => `${relative(root, path)}:${content.slice(0, match.index).split('\n').length}`,
    );
  });
}

describe('sample data privacy', () => {
  it('uses reserved namespaces for development domains in source, fixtures and documentation', () => {
    // Match hostnames and domain log names, while excluding identifiers such as local_addr.
    const developmentDomain = /\b(?:[a-z0-9_-]+\.)+(?:local|loc)\.?(?=$|[^a-z0-9_.-]|_[a-z0-9-]+\.log)/gi;
    expect(locations(developmentDomain)).toEqual([]);
  });

  it('does not embed concrete Windows user-profile directories', () => {
    expect(locations(/\b[a-z]:[\\/]+Users[\\/]+[^\\/\s'"]+/gi)).toEqual([]);
  });
});
