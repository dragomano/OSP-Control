import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TsConfig {
  compilerOptions?: { noEmit?: boolean };
  include?: string[];
}

const readJson = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), name), 'utf8')) as TsConfig;

const rootTsconfig = readJson('tsconfig.json');
const nodeTsconfig = readJson('tsconfig.node.json');
const { scripts } = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const collectTypeScriptFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe('TypeScript build graph', () => {
  it('tsconfig.node.json covers both tool configs', () => {
    expect(nodeTsconfig.include).toEqual(expect.arrayContaining(['vite.config.ts', 'vitest.config.ts']));
  });

  it('the build typechecks the tool configs via tsc -b (build mode)', () => {
    expect(scripts.build).toMatch(/tsc -b .*tsconfig\.node\.json/);
  });

  it('the tool-config project never emits files into the repository', () => {
    expect(nodeTsconfig.compilerOptions?.noEmit).toBe(true);
  });

  it('the root project keeps app sources and tests', () => {
    expect(rootTsconfig.include).toEqual(expect.arrayContaining(['src', 'tests']));
  });

  it('keeps every TypeScript file in the program on case-insensitive filesystems', () => {
    // TypeScript drops one file when two files in the same directory share a base name
    // ignoring case (projectWorkspace.test.ts vs ProjectWorkspace.test.tsx), so the file
    // stays unchecked on Windows while CI typechecks it.
    const groups = new Map<string, string[]>();
    for (const dir of ['src', 'tests']) {
      for (const path of collectTypeScriptFiles(resolve(process.cwd(), dir))) {
        const key = `${dirname(path)}::${basename(path, extname(path)).toLowerCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), path]);
      }
    }
    const collisions = [...groups.values()]
      .filter((files) => files.length > 1)
      .map((files) => files.map((file) => file.slice(process.cwd().length + 1)).join(' vs '));
    expect(collisions).toEqual([]);
  });
});
