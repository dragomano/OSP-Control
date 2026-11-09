import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkspace } from '../src/components/pages/ProjectWorkspace';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';
import type { OsPanelProject } from '../src/ospanel';

const mocks = vi.hoisted(() => ({
  readProjectWorkspace: vi.fn(),
  readProjectFile: vi.fn(),
  saveProjectFile: vi.fn(),
  getProjectModuleOptions: vi.fn(),
  getGlobalProjectEngines: vi.fn(),
  askConfirm: vi.fn(),
  readProjectMenu: vi.fn(),
  writeProjectMenu: vi.fn(),
  readMenu: vi.fn(),
  writeMenu: vi.fn(),
}));
vi.mock('../src/ospanel', async (original) => ({
  ...(await original<typeof import('../src/ospanel')>()),
  ...mocks,
}));
const project: OsPanelProject = {
  domain: 'shop.test',
  path: 'C:\\OSPanel\\home\\shared',
  php: '8.3',
  type: 'Nginx',
  ssl: true,
};
const content =
  '\uFEFF[shop.test]\r\nphp_engine = PHP-8.3\r\n\r\n[api.shop.test]\r\nweb_root = {base_dir}\\api\r\n';
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const setup = () => {
  const onClose = vi.fn();
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>
      <ProjectWorkspace project={project} notify={vi.fn()} onClose={onClose} onRestartPanel={vi.fn()} />
    </I18nContext.Provider>,
  );
  return { onClose };
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.readProjectWorkspace.mockResolvedValue({ baseDir: project.path, content, files: [] });
  mocks.getProjectModuleOptions.mockResolvedValue({
    httpEngines: ['Nginx', 'Apache'],
    phpEngines: ['PHP-8.3', 'PHP-8.4'],
    nodeEngines: [],
  });
  mocks.getGlobalProjectEngines.mockResolvedValue({
    httpEngine: 'Nginx',
    phpEngine: 'PHP-8.3',
    nodeEngine: '',
  });
  mocks.readProjectFile.mockResolvedValue(null);
  mocks.saveProjectFile.mockImplementation(async (_project, _file, _old, draft) => ({
    content: draft,
    backupPath: null,
  }));
  mocks.askConfirm.mockResolvedValue(false);
  mocks.readProjectMenu.mockResolvedValue({ items: [], revision: 'project-initial' });
  mocks.writeProjectMenu.mockImplementation(async (_project, items) => ({
    document: { items, revision: 'project-saved' },
    backupPath: null,
  }));
});
afterEach(cleanup);

describe('project workspace drafts', () => {
  it('creates a project-scoped visual menu item and retains it across tabs before the shared save', async () => {
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Menu', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: t('menu.addItem'), exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: t('menu.name'), exact: true }), {
      target: { value: 'Project tools' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: t('menu.command'), exact: true }), {
      target: { value: 'echo {project_root}' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Web server' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Domain', exact: true }), {
      target: { value: 'api.shop.test' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Public directory' }), {
      target: { value: '{base_dir}\\api\\public' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Menu', exact: true }));
    expect(await screen.findByRole('textbox', { name: t('menu.name'), exact: true })).toHaveValue(
      'Project tools',
    );
    expect(screen.getByRole('combobox', { name: t('menu.category'), exact: true })).toHaveValue(
      'projects\\shop.test',
    );
    expect(screen.getByRole('combobox', { name: t('menu.category'), exact: true })).toHaveTextContent(
      'api.shop.test',
    );
    expect(screen.queryByRole('textbox', { name: 'Contents of menu.ini' })).not.toBeInTheDocument();
    expect(localStorage.getItem('ospanel.menuTree')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() =>
      expect(mocks.writeProjectMenu).toHaveBeenCalledWith(
        project,
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(/^project_shop\.test_/),
            fields: expect.objectContaining({
              caption: 'Project tools',
              category: 'projects\\shop.test',
              command: 'echo {project_root}',
            }),
          }),
        ]),
        'project-initial',
      ),
    );
    await waitFor(() =>
      expect(mocks.saveProjectFile).toHaveBeenCalledWith(
        project,
        'project.ini',
        content,
        expect.stringContaining('{base_dir}\\api\\public'),
      ),
    );
    expect(mocks.readMenu).not.toHaveBeenCalled();
    expect(mocks.writeMenu).not.toHaveBeenCalled();
    expect(mocks.readProjectFile).not.toHaveBeenCalledWith(project, 'menu.ini');
    await waitFor(() => expect(screen.getByRole('button', { name: 'All projects' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.askConfirm).not.toHaveBeenCalled();
  });
  it('retains a menu draft and other settings if the menu was changed by an external editor', async () => {
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Domains' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Domain aliases' }), {
      target: { value: 'www.shop.test' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Menu', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: t('menu.addItem'), exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: t('menu.name'), exact: true }), {
      target: { value: 'Local action' },
    });
    mocks.writeProjectMenu.mockRejectedValueOnce(new Error('err.projectWorkspaceConflict'));
    fireEvent.click(screen.getByRole('tab', { name: 'Web server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed by another program');
    expect(screen.getByRole('tab', { name: 'Menu', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: t('menu.name'), exact: true })).toHaveValue('Local action');
    expect(mocks.saveProjectFile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await waitFor(() => expect(mocks.askConfirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(mocks.saveProjectFile).toHaveBeenCalled());
  });
  it('keeps file drafts across web-server tabs and preserves them after an external conflict', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Configurations' }));
    const code = await screen.findByRole('textbox', { name: 'Contents of nginx/shop.test.conf' });
    fireEvent.change(code, { target: { value: 'location / { try_files $uri /index.php; }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Caddy', exact: true }));
    await screen.findByRole('textbox', { name: 'Contents of caddy/shop.test.conf' });
    fireEvent.click(screen.getByRole('button', { name: 'Nginx', exact: true }));
    expect(await screen.findByRole('textbox', { name: 'Contents of nginx/shop.test.conf' })).toHaveValue(
      'location / { try_files $uri /index.php; }',
    );
    mocks.saveProjectFile.mockRejectedValue(new Error('err.projectWorkspaceConflict'));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed by another program');
    expect(screen.getByRole('textbox', { name: 'Contents of nginx/shop.test.conf' })).toHaveValue(
      'location / { try_files $uri /index.php; }',
    );
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });
  it('edits the selected domain in a shared folder and retains other sections', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Web server' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Domain', exact: true }), {
      target: { value: 'api.shop.test' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Public directory' }), {
      target: { value: '{base_dir}\\api\\public' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() =>
      expect(mocks.saveProjectFile).toHaveBeenCalledWith(
        project,
        'project.ini',
        content,
        expect.stringContaining('web_root = {base_dir}\\api\\public'),
      ),
    );
    expect(mocks.saveProjectFile.mock.calls[0][3]).toContain('php_engine = PHP-8.3');
  });
  it('asks before discarding changes and leaves the editor open when declined', async () => {
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Domains' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Domain aliases' }), {
      target: { value: 'www.shop.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await waitFor(() => expect(mocks.askConfirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Domain aliases' })).toHaveValue('www.shop.test');
  });
  it('retains remaining drafts when a later file fails and retries only unsaved files', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Environment' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'PHP version' }), {
      target: { value: 'PHP-8.4' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Configurations' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Contents of nginx/shop.test.conf' }), {
      target: { value: 'location / {}' },
    });
    mocks.saveProjectFile
      .mockResolvedValueOnce({ content: content.replace('PHP-8.3', 'PHP-8.4'), backupPath: null })
      .mockRejectedValueOnce(new Error('err.projectWorkspaceConflict'));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() =>
      expect(mocks.saveProjectFile.mock.calls.map((call) => call[1])).toEqual([
        'project.ini',
        'nginx/shop.test.conf',
        'nginx/shop.test.conf',
      ]),
    );
  });
});
