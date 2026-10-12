import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
});
