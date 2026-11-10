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
  diagnoseProject: vi.fn(),
  installProjectLaravel: vi.fn(),
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
  const notify = vi.fn();
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>
      <ProjectWorkspace project={project} notify={notify} onClose={onClose} onRestartPanel={vi.fn()} />
    </I18nContext.Provider>,
  );
  return { onClose, notify };
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
  mocks.diagnoseProject.mockResolvedValue({
    domain: 'shop.test',
    checkedAt: 1234,
    checks: [
      {
        id: 'config',
        group: 'configuration',
        status: 'error',
        title: 'diag.title.config',
        message: 'diag.config.invalid',
        hint: 'diag.hint.config',
        params: {},
        evidence: '',
        tab: null,
        filePath: null,
      },
    ],
  });
  mocks.writeProjectMenu.mockImplementation(async (_project, items) => ({
    document: { items, revision: 'project-saved' },
    backupPath: null,
  }));
});
afterEach(cleanup);

describe('project workspace drafts', () => {
  it.each([
    ['Configurations', 'nginx/shop.test.conf'],
    ['Application files', '.env'],
  ])('does not add footer actions after saving an existing file on %s', async (tab, file) => {
    mocks.readProjectWorkspace.mockResolvedValue({ baseDir: project.path, content, files: ['.env'] });
    mocks.readProjectFile.mockResolvedValue('original content\n');
    mocks.saveProjectFile.mockResolvedValue({
      content: 'updated content\n',
      backupPath: 'C:/OSPanel/backups/project-settings/example/original.bak',
    });
    const { notify } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: tab }));
    fireEvent.change(await screen.findByRole('textbox', { name: `Contents of ${file}` }), {
      target: { value: 'updated content\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(mocks.saveProjectFile).toHaveBeenCalledWith(
      project,
      file,
      'original content\n',
      'updated content\n',
    );
    expect(screen.getByText(t('workspace.backupHint'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('workspace.openBackup') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('projects.restartPanel') })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    if (tab === 'Configurations') {
      expect(screen.getByText(t('workspace.restartNeeded'))).toBeInTheDocument();
      expect(notify).toHaveBeenCalledWith(t('workspace.saved'), {
        label: t('projects.restartPanel'),
        run: expect.any(Function),
      });
    } else {
      expect(notify).toHaveBeenCalledWith(t('workspace.saved'), undefined);
    }
  });

  it('edits existing application configuration and retains drafts across files without a panel restart', async () => {
    mocks.readProjectWorkspace.mockResolvedValue({
      baseDir: project.path,
      content,
      files: ['.env', 'public/wp-config.php'],
    });
    mocks.readProjectFile.mockImplementation(async (_project, file) =>
      file === '.env' ? 'APP_ENV=local\n' : '<?php\n',
    );
    const { notify } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Application files' }));
    const env = await screen.findByRole('textbox', { name: 'Contents of .env' });
    fireEvent.change(env, { target: { value: 'APP_ENV=testing\n' } });
    expect(
      screen.queryByRole('combobox', { name: 'Application configuration file' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '.env' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'public/wp-config.php' }));
    expect(screen.getByRole('button', { name: 'public/wp-config.php' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.change(await screen.findByRole('textbox', { name: 'Contents of public/wp-config.php' }), {
      target: { value: '<?php\n// Project configuration\n' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Web server' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Application files' }));
    fireEvent.click(screen.getByRole('button', { name: '.env' }));
    expect(await screen.findByRole('textbox', { name: 'Contents of .env' })).toHaveValue('APP_ENV=testing\n');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveProjectFile).toHaveBeenCalledTimes(2));
    expect(mocks.saveProjectFile).toHaveBeenCalledWith(
      project,
      '.env',
      'APP_ENV=local\n',
      'APP_ENV=testing\n',
    );
    expect(mocks.saveProjectFile).toHaveBeenCalledWith(
      project,
      'public/wp-config.php',
      '<?php\n',
      '<?php\n// Project configuration\n',
    );
    await waitFor(() => expect(notify).toHaveBeenCalledWith(t('workspace.saved'), undefined));
    expect(screen.queryByText(t('workspace.restartNeeded'))).not.toBeInTheDocument();
  });

  it('keeps Laravel installation visible, blocks navigation while running and reloads its successful state', async () => {
    mocks.readProjectWorkspace
      .mockResolvedValueOnce({ baseDir: project.path, content, files: [], laravel: 'pending' })
      .mockResolvedValue({ baseDir: project.path, content, files: [], laravel: 'installed' });
    let finish!: (result: { backupPath: string }) => void;
    mocks.installProjectLaravel.mockImplementation((_project, progress) => {
      progress({ phase: 'installing', output: 'Installing dependencies\n' });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const { onClose } = setup();
    const install = await screen.findByRole('button', { name: 'Install Laravel' });
    fireEvent.click(install);
    expect(await screen.findByText('Installing Laravel with Composer…')).toHaveAttribute('role', 'status');
    expect(screen.getByText('Installing dependencies')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tasks' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(onClose).not.toHaveBeenCalled();
    finish({ backupPath: 'C:/OSPanel/backups/project-starters/laravel-site.test' });
    await screen.findByText('Laravel installed in the project root. Restart OSPanel to apply the changes.');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Install Laravel' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('tab', { name: 'Tasks' })).toBeEnabled();
    expect(mocks.readProjectWorkspace).toHaveBeenCalledTimes(2);
  });

  it('allows diagnostics even when project settings cannot be loaded', async () => {
    mocks.readProjectWorkspace.mockRejectedValue(new Error('err.projectWorkspaceInvalid'));
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: t('workspace.tab.diagnostics') }));
    fireEvent.click(await screen.findByRole('button', { name: t('diag.run') }));
    expect(await screen.findByText(t('diag.config.invalid'))).toBeInTheDocument();
    expect(mocks.diagnoseProject).toHaveBeenCalledWith(project, 'shop.test');
    expect(mocks.saveProjectFile).not.toHaveBeenCalled();
  });

  it('marks diagnostics stale after saving settings but not after reading another tab', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: t('workspace.tab.diagnostics') }));
    fireEvent.click(await screen.findByRole('button', { name: t('diag.run') }));
    await screen.findByText(t('diag.config.invalid'));
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    await screen.findByRole('button', { name: 'Add task' });
    fireEvent.click(screen.getByRole('tab', { name: t('workspace.tab.diagnostics') }));
    expect(screen.queryByText(t('diag.stale'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Web server' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Public directory' }), {
      target: { value: '{base_dir}\\new-public' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All projects' })).toBeEnabled());
    fireEvent.click(screen.getByRole('tab', { name: t('workspace.tab.diagnostics') }));
    expect(await screen.findByText(t('diag.stale'))).toBeInTheDocument();
  });

  it('edits tasks visually, keeps incomplete drafts across tabs and domains and saves only tasks.ini', async () => {
    const original =
      '; Automation\r\n[shop.test]\r\nBuild = */5 * * * * * 0 echo {host}\r\n\r\n[api.shop.test]\r\nCheck = 0 9 * * 1-5 0 * echo api\r\n';
    mocks.readProjectFile.mockResolvedValue(original);
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Tasks' }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Build');
    fireEvent.change(name, { target: { value: 'Compile assets' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Minute' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(await screen.findByRole('textbox', { name: 'Minute' })).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: 'Domain' }), {
      target: { value: 'api.shop.test' },
    });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Check');
    fireEvent.change(screen.getByRole('combobox', { name: 'Domain' }), {
      target: { value: 'shop.test' },
    });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Compile assets');
    expect(screen.getByRole('textbox', { name: 'Minute' })).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: 'Schedule' }), {
      target: { value: 'daily' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Task enabled' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution limit' }), {
      target: { value: 'limited' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Number of launches' }), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), {
      target: { value: 'cmd.exe /c "osp project {host} & pnpm build"' },
    });
    expect(screen.queryByRole('textbox', { name: 'Contents of tasks.ini' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(mocks.saveProjectFile).toHaveBeenCalledWith(
        project,
        'tasks.ini',
        original,
        '; Automation\r\n[shop.test]\r\nCompile assets = 0 0 * * * 3 1 cmd.exe /c "osp project {host} & pnpm build"\r\n\r\n[api.shop.test]\r\nCheck = 0 9 * * 1-5 0 * echo api\r\n',
      ),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'All projects' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.askConfirm).not.toHaveBeenCalled();
    expect(mocks.saveProjectFile).toHaveBeenCalledTimes(1);
  });

  it('creates, duplicates and deletes tasks, blocks invalid schedules and retains drafts after conflicts', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Tasks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Run job' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), {
      target: { value: 'echo {host} & echo x=y' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Weekday' }), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('tasks.fixErrors'));
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
    expect(mocks.saveProjectFile).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Weekday' }), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate task' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Run job (copy)');
    expect(screen.getByRole('checkbox', { name: 'Task enabled' })).not.toBeChecked();
    mocks.askConfirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Run job'));
    mocks.saveProjectFile.mockRejectedValueOnce(new Error('err.projectWorkspaceConflict'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed by another program');
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveValue('echo {host} & echo x=y');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveProjectFile).toHaveBeenCalledTimes(2));
    expect(mocks.saveProjectFile.mock.calls[1]).toEqual([
      project,
      'tasks.ini',
      null,
      '[shop.test]\nRun job = * * * * 7 * 0 echo {host} & echo x=y\n',
    ]);
  });

  it('keeps the selected new task open after saving the file', async () => {
    mocks.readProjectFile.mockResolvedValue('[shop.test]\nFirst = * * * * * * 0 echo first\n');
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Tasks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Second action' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), {
      target: { value: 'echo second' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All projects' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Second action');
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveValue('echo second');
  });

  it('creates a project-scoped visual menu item and retains it across tabs before the shared save', async () => {
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Menu' }));
    fireEvent.click(await screen.findByRole('button', { name: t('menu.addItem') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('menu.name') }), {
      target: { value: 'Project tools' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: t('menu.command') }), {
      target: { value: 'echo {project_root}' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Web server' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Domain' }), {
      target: { value: 'api.shop.test' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Public directory' }), {
      target: { value: '{base_dir}\\api\\public' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Menu' }));
    expect(await screen.findByRole('textbox', { name: t('menu.name') })).toHaveValue('Project tools');
    expect(screen.getByRole('combobox', { name: t('menu.category') })).toHaveValue('projects\\shop.test');
    expect(screen.getByRole('combobox', { name: t('menu.category') })).toHaveTextContent('api.shop.test');
    expect(screen.queryByRole('textbox', { name: 'Contents of menu.ini' })).not.toBeInTheDocument();
    expect(localStorage.getItem('ospanel.menuTree')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
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
    fireEvent.click(screen.getByRole('tab', { name: 'Menu' }));
    fireEvent.click(await screen.findByRole('button', { name: t('menu.addItem') }));
    fireEvent.change(screen.getByRole('textbox', { name: t('menu.name') }), {
      target: { value: 'Local action' },
    });
    mocks.writeProjectMenu.mockRejectedValueOnce(new Error('err.projectWorkspaceConflict'));
    fireEvent.click(screen.getByRole('tab', { name: 'Web server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed by another program');
    expect(screen.getByRole('tab', { name: 'Menu' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: t('menu.name') })).toHaveValue('Local action');
    expect(mocks.saveProjectFile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await waitFor(() => expect(mocks.askConfirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveProjectFile).toHaveBeenCalled());
  });

  it('keeps file drafts across web-server tabs and preserves them after an external conflict', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Configurations' }));
    const code = await screen.findByRole('textbox', { name: 'Contents of nginx/shop.test.conf' });
    fireEvent.change(code, { target: { value: 'location / { try_files $uri /index.php; }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Caddy' }));
    await screen.findByRole('textbox', { name: 'Contents of caddy/shop.test.conf' });
    fireEvent.click(screen.getByRole('button', { name: 'Nginx' }));
    expect(await screen.findByRole('textbox', { name: 'Contents of nginx/shop.test.conf' })).toHaveValue(
      'location / { try_files $uri /index.php; }',
    );
    mocks.saveProjectFile.mockRejectedValue(new Error('err.projectWorkspaceConflict'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed by another program');
    expect(screen.getByRole('textbox', { name: 'Contents of nginx/shop.test.conf' })).toHaveValue(
      'location / { try_files $uri /index.php; }',
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('edits the selected domain in a shared folder and retains other sections', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Web server' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Domain' }), {
      target: { value: 'api.shop.test' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Public directory' }), {
      target: { value: '{base_dir}\\api\\public' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.saveProjectFile.mock.calls.map((call) => call[1])).toEqual([
        'project.ini',
        'nginx/shop.test.conf',
        'nginx/shop.test.conf',
      ]),
    );
  });
});
