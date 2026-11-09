import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_TEMPLATES, preferredTemplateEngine } from '../src/projectTemplates';

describe('project template catalog', () => {
  it('prefers an installed global runtime, otherwise the latest numeric version', () => {
    const versions = ['PHP-8.9', 'PHP-8.10', 'PHP-8.3'];
    expect(preferredTemplateEngine(versions, 'PHP-8.3')).toBe('PHP-8.3');
    expect(preferredTemplateEngine(versions, 'PHP-9.0')).toBe('PHP-8.10');
    expect(preferredTemplateEngine([], 'Node-24')).toBe('');
    expect(versions).toEqual(['PHP-8.9', 'PHP-8.10', 'PHP-8.3']);
  });
  it('keeps template previews within the new project and lists no duplicate files', () => {
    expect(PROJECT_TEMPLATES.map((template) => template.id)).toEqual([
      'empty',
      'static',
      'php',
      'laravel',
      'wordpress',
      'node',
    ]);
    for (const template of PROJECT_TEMPLATES) {
      const paths = [...template.directories, ...template.files.map((file) => file.path)];
      for (const path of paths) {
        expect(path).not.toMatch(/^(?:\/|[a-z]:)|\\|(?:^|\/)\.\.(?:\/|$)/i);
      }
      expect(new Set(template.files.map((file) => file.path)).size).toBe(template.files.length);
    }
  });
  it('generates syntactically valid Node.js without installing dependencies', () => {
    const source = readFileSync('src-tauri/resources/project-starters/server.mjs', 'utf8').replace(
      /__PORT__/g,
      '4321',
    );
    expect(source).toContain("Number('4321')");
    expect(() =>
      execFileSync(process.execPath, ['--check', '--input-type=module'], { input: source }),
    ).not.toThrow();
  });
});
