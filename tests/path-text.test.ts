import { describe, expect, it } from 'vitest';
import { isPathToken, splitPaths } from '../src/components/widgets/PathText';

const bold = (text: string) =>
  splitPaths(text)
    .filter((part) => part.path)
    .map((part) => part.text);

describe('path highlighting in prose', () => {
  it('marks the paths of a project hint', () => {
    expect(bold('Will create the home/<domain> folder with .osp\\project.ini.')).toEqual([
      'home/<domain>',
      '.osp\\project.ini',
    ]);
  });

  it('marks database metadata and the public directory without sentence punctuation', () => {
    const text = 'Settings: (.osp/database.json), files in public/. Also .osp\\database.json and public\\.';
    expect(bold(text)).toEqual(['.osp/database.json', 'public/', '.osp\\database.json', 'public\\']);
    expect(
      splitPaths(text)
        .map((part) => part.text)
        .join(''),
    ).toBe(text);
  });

  it('marks a path inside brackets without taking the brackets', () => {
    const parts = splitPaths(
      'On app start, modules pinned in project settings (home/<domain>/.osp/project.ini) will be started.',
    );

    expect(parts.filter((part) => part.path).map((part) => part.text)).toEqual([
      'home/<domain>/.osp/project.ini',
    ]);
    expect(parts.map((part) => part.text).join('')).toBe(
      'On app start, modules pinned in project settings (home/<domain>/.osp/project.ini) will be started.',
    );
  });

  it('marks several paths in one sentence', () => {
    expect(
      bold(
        'The home/<domain> folder and the domain will be renamed. A copy of project.ini will be saved first.',
      ),
    ).toEqual(['home/<domain>', 'project.ini']);
  });

  it('marks a known file name without a directory', () => {
    expect(bold('Restore project.ini from this copy: X:\\TestPanel\\home\\shop.test')).toEqual([
      'project.ini',
      'X:\\TestPanel\\home\\shop.test',
    ]);
  });

  it('leaves ordinary prose slashes alone', () => {
    for (const text of ['Input/output error', 'A module/add-on is missing', 'Sections/parameters']) {
      expect(bold(text), text).toEqual([]);
    }
  });

  it('keeps the trailing period out of the bold run', () => {
    const parts = splitPaths('Stored in .osp\\project.ini.');

    expect(parts.filter((part) => part.path).map((part) => part.text)).toEqual(['.osp\\project.ini']);
    expect(parts.map((part) => part.text).join('')).toBe('Stored in .osp\\project.ini.');
  });

  it('rejoins into the original text character for character', () => {
    const texts = [
      'Будет создана папка home/домен с файлом .osp\\project.ini.',
      'Значения хранятся в файле .osp\\project.ini внутри папки проекта и применяются после перезапуска OSPanel.',
      'Будут переименованы папка home/<домен> и домен в настройках проекта; метки и версии модулей сохранятся. Перед изменением будет сохранена копия project.ini.',
      '  leading and trailing  ',
      '',
    ];

    for (const text of texts) {
      expect(
        splitPaths(text)
          .map((part) => part.text)
          .join(''),
        text,
      ).toBe(text);
    }
  });

  it('recognizes path tokens by their shape', () => {
    expect(isPathToken('home/<domain>')).toBe(true);
    expect(isPathToken('.osp\\project.ini')).toBe(true);
    expect(isPathToken('project.ini')).toBe(true);
    expect(isPathToken('system/menu.dat')).toBe(true);
    expect(isPathToken('.osp-control-backups')).toBe(true);
    expect(isPathToken('module/add-on')).toBe(false);
    expect(isPathToken('/')).toBe(false);
    expect(isPathToken('OSPanel.')).toBe(false);
  });
});
