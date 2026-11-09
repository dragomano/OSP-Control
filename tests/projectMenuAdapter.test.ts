import { invoke } from '@tauri-apps/api/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { menuCategories, menuDraft, newMenuId, projectMenuIdPrefix } from '../src/menu';
import { type OsPanelProject, readMenu, readProjectMenu, writeProjectMenu } from '../src/ospanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const project: OsPanelProject = {
  domain: 'menu.test',
  path: 'C:\\OSPanel\\home\\menu.test',
  php: '8.3',
  type: 'Nginx',
  ssl: true,
};
const flag = () => window as { __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  delete flag().__TAURI_INTERNALS__;
  vi.clearAllMocks();
});
describe('project menu persistence', () => {
  it('keeps browser project menus separate from the global menu and checks stale revisions', async () => {
    const global = await readMenu();
    const first = await readProjectMenu(project);
    const item = {
      id: 'menu_test_action',
      fields: { caption: 'Tools', category: 'projects\\menu.test', command: 'echo {host}' },
    };
    const saved = await writeProjectMenu(project, [item], first.revision);
    expect((await readProjectMenu(project)).items).toEqual([item]);
    expect(await readMenu()).toEqual(global);
    expect(
      (await readProjectMenu({ ...project, domain: 'other.test', path: 'C:\\OSPanel\\home\\other.test' }))
        .items,
    ).toEqual([]);
    await expect(writeProjectMenu(project, [], first.revision)).rejects.toThrow(
      'err.projectWorkspaceConflict',
    );
    expect((await readProjectMenu({ ...project, domain: 'api.menu.test' })).revision).toBe(
      saved.document.revision,
    );
    item.fields.caption = 'Changed reference';
    expect((await readProjectMenu(project)).items[0].fields.caption).toBe('Tools');
  });
  it('routes native requests to project commands with the owning folder and expected revision', async () => {
    flag().__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue({ items: [], revision: 'version' });
    await readProjectMenu(project);
    expect(invoke).toHaveBeenLastCalledWith(
      'read_project_menu',
      expect.objectContaining({ domain: project.domain, baseDir: project.path }),
    );
    await writeProjectMenu(project, [], 'version');
    expect(invoke).toHaveBeenLastCalledWith(
      'write_project_menu',
      expect.objectContaining({
        domain: project.domain,
        baseDir: project.path,
        items: [],
        expectedRevision: 'version',
      }),
    );
  });
  it('provides project domain categories and bounded project-specific item IDs', () => {
    expect(menuCategories(menuDraft([]), ['projects\\menu.test', 'projects\\api.menu.test'])).toEqual([
      '',
      'projects\\menu.test',
      'projects\\api.menu.test',
      'projects',
    ]);
    const prefix = projectMenuIdPrefix('menu.test');
    const id = newMenuId([], prefix);
    expect(newMenuId([{ id, fields: {} }], prefix)).not.toBe(id);
    expect(projectMenuIdPrefix('other.test')).not.toBe(prefix);
    expect(newMenuId([], projectMenuIdPrefix(`${'a'.repeat(240)}.test`)).length).toBeLessThan(128);
  });
});
