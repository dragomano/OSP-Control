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
  it.each(['static', 'php', 'node', 'laravel', 'wordpress'])(
    'keeps commands and substitutions consistent in every %s document translation',
    (kind) => {
      const directory = 'src-tauri/resources/project-starters/docs';
      const source = readFileSync(`${directory}/en/${kind}.md`, 'utf8');
      const tokens = (text: string, pattern: RegExp) =>
        [...text.matchAll(pattern)].map((match) => match[0]).sort();
      for (const language of ['ru', 'uk', 'be', 'es']) {
        const translated = readFileSync(`${directory}/${language}/${kind}.md`, 'utf8');
        expect(tokens(translated, /__[A-Z_]+__/g)).toEqual(tokens(source, /__[A-Z_]+__/g));
        expect(tokens(translated, /`[^`]+`/g)).toEqual(tokens(source, /`[^`]+`/g));
        expect(translated).not.toBe(source);
      }
    },
  );

  it.each(['en', 'ru', 'uk', 'be', 'es'])(
    'generates syntactically valid Node.js in %s without installing dependencies',
    (language) => {
      const dictionary = JSON.parse(readFileSync(`src-tauri/resources/locales/${language}.json`, 'utf8'));
      const source = readFileSync('src-tauri/resources/project-starters/server.mjs', 'utf8').replace(
        /__PORT__/g,
        '4321',
      );
      const localized = source
        .replace('__NODE_READY_JSON__', JSON.stringify(dictionary['starters.node.ready']))
        .replace('__NODE_LISTENING_JSON__', JSON.stringify(dictionary['starters.node.listening']));
      expect(localized).not.toMatch(/__[A-Z_]+__/);
      expect(localized).toContain("Number('4321')");
      expect(() =>
        execFileSync(process.execPath, ['--check', '--input-type=module'], { input: localized }),
      ).not.toThrow();
    },
  );
});
