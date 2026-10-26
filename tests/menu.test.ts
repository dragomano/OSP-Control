import { describe, expect, it } from 'vitest';
import { embeddedDict, makeTranslator } from '../src/i18n';
import {
  categoryOf,
  menuCaption,
  menuCategories,
  menuDraft,
  moveMenuItem,
  newMenuId,
  type OsPanelMenuItem,
  renameMenuCategory,
  validCategory,
} from '../src/menu';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const items: OsPanelMenuItem[] = [
  {
    id: 'one',
    fields: {
      caption: '{lang_cli}',
      category: 'Tools',
      command: 'cmd.exe /k "echo x=y & echo ;"',
      future_option: 'keep',
    },
  },
  { id: 'other', fields: { caption: 'Database', category: 'Database', command: 'db.exe' } },
  { id: 'two', fields: { caption: 'Editor', category: 'Tools', command: 'editor.exe', need_use_wt: 'off' } },
];

describe('native menu model', () => {
  it('moves between categories without changing other commands or unknown fields', () => {
    const next = moveMenuItem(menuDraft(items), 'one', 'Database', 'other');
    expect(next.items.map((item) => item.id)).toEqual(['one', 'other', 'two']);
    expect(next.items[0].fields).toEqual({ ...items[0].fields, category: 'Database' });
    expect(next.items[1]).toBe(items[1]);
    expect(items[0].fields.category).toBe('Tools');
  });

  it('reorders within a group and appends after the last item of the destination', () => {
    const next = moveMenuItem(menuDraft(items), 'two', 'Tools', 'one');
    expect(next.items.map((item) => item.id)).toEqual(['two', 'one', 'other']);
    const appended = moveMenuItem(menuDraft(items), 'one', 'Database');
    expect(appended.items.map((item) => item.id)).toEqual(['other', 'one', 'two']);
    expect(moveMenuItem(menuDraft(items), 'one', 'Tools', 'one').items).toBe(items);
  });

  it('renames a group and its nested groups while preserving all item properties', () => {
    const draft = {
      items: [...items, { id: 'nested', fields: { category: 'Tools\\Editors', command: 'code.exe' } }],
      categories: ['Tools', 'Tools\\Editors'],
    };
    const next = renameMenuCategory(draft, 'Tools', 'Development');
    expect(next.items.map(categoryOf)).toEqual([
      'Development',
      'Database',
      'Development',
      'Development\\Editors',
    ]);
    expect(next.items[0].fields.command).toBe(items[0].fields.command);
    expect(menuCategories(next)).toContain('Development\\Editors');
    expect(renameMenuCategory(draft, 'Tools', 'Nested\\Too\\Deep')).toBe(draft);
  });

  it('includes native context groups and parents inferred from category paths', () => {
    const draft = menuDraft([{ id: 'a', fields: { category: 'Custom\\Nested', command: 'app.exe' } }]);
    expect(menuCategories(draft)).toEqual(['', 'projects', 'modules', 'addons', 'Custom\\Nested', 'Custom']);
    for (const path of ['', 'Tools', 'Tools\\Editors', 'projects\\example.test'])
      expect(validCategory(path)).toBe(true);
    for (const path of ['Tools\\Editors\\Extra', 'Tools\\', '\\Tools', ' Tools', 'a\nb', '[x]'])
      expect(validCategory(path)).toBe(false);
  });

  it('resolves native captions for display while preserving the template value', () => {
    expect(menuCaption(items[0], t)).toBe('Command line');
    expect(items[0].fields.caption).toBe('{lang_cli}');
    expect(menuCaption({ id: 'alias', fields: { need_alias: 'on' } }, t)).toBe('Domain alias name');
    expect(menuCaption({ id: 'future', fields: { caption: '{lang_future}' } }, t)).toBe('{lang_future}');
    expect(
      newMenuId([
        { id: 'CUSTOM_1', fields: {} },
        { id: 'custom_2', fields: {} },
      ]),
    ).toBe('custom_3');
  });
});
