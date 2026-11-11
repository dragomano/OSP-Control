import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../src/components/pages/Projects';
import type { Notify } from '../src/components/shared';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { OsPanelProject } from '../src/ospanel';
import {
  PROJECT_TAGS_KEY,
  readProjectTagColors,
  readProjectTags,
  writeProjectTags,
} from '../src/projectTags';

const mocks = vi.hoisted(() => ({
  getProjectActivity: vi.fn(),
  listEditors: vi.fn(),
  openInBrowser: vi.fn(),
  openProjectFolder: vi.fn(),
  openInEditor: vi.fn(),
  getProjectModuleOptions: vi.fn(),
  getProjectSettings: vi.fn(),
  getGlobalProjectEngines: vi.fn(),
  saveProjectSettings: vi.fn(),
  openFileExternally: vi.fn(),
  renameProject: vi.fn(),
  readProjectWorkspace: vi.fn(),
  saveProjectFile: vi.fn(),
}));

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return { ...actual, ...mocks };
});

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

const shopProject: OsPanelProject = {
  domain: 'my-shop.test',
  path: 'C:\\OSPanel\\domains\\my-shop',
  php: '8.3',
  type: 'Laravel',
  ssl: true,
};

const landingProject: OsPanelProject = {
  domain: 'landing.test',
  path: 'C:\\OSPanel\\domains\\landing',
  php: '8.2',
  type: 'Static',
  ssl: false,
};

const moduleOptions = {
  httpEngines: ['Apache_2.4', 'Nginx_1.25'],
  phpEngines: ['PHP_8.2', 'PHP_8.3'],
  nodeEngines: [],
};

const renderProjects = (
  notify: Notify,
  projects: OsPanelProject[] = [shopProject, landingProject],
  onProjectRenamed = vi.fn(),
  onRestartPanel = vi.fn(),
) =>
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <Projects
        projects={projects}
        allProjects={projects}
        query=""
        setQuery={vi.fn()}
        notify={notify}
        onProjectCreated={vi.fn()}
        onProjectRenamed={onProjectRenamed}
        onProjectDeleted={vi.fn()}
        onToggleSsl={vi.fn()}
        onRestartPanel={onRestartPanel}
      />
    </I18nContext.Provider>,
  );

const rowCallbacks = () => ({
  onProjectDeleted: vi.fn(),
  onToggleSsl: vi.fn(),
});

// Opens the row menu of the first project row and returns it.
const openRowMenu = () => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Actions' })[0]);
  return screen.getByRole('menu');
};

const stubClipboard = (impl: () => Promise<void>) => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(impl) },
    configurable: true,
  });
};

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listEditors.mockResolvedValue([{ id: 'vscode', name: 'VS Code' }]);
  mocks.getProjectActivity.mockResolvedValue([]);
  mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
  mocks.getProjectSettings.mockResolvedValue({
    domain: 'my-shop.test',
    httpEngine: 'Apache_2.4',
    phpEngine: 'PHP_8.2',
    nodeEngine: 'auto',
    tlsEnabled: 'on',
    fileExists: true,
  });
  mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
  mocks.readProjectWorkspace.mockResolvedValue({
    baseDir: shopProject.path,
    content: '[my-shop.test]\nhttp_engine = Apache_2.4\nphp_engine = PHP_8.2\n',
    files: ['project.ini'],
  });
  mocks.saveProjectFile.mockImplementation(async (_project, _file, _original, content) => ({
    content,
    backupPath: null,
  }));
});

afterEach(() => cleanup());

describe('Projects browser opening', () => {
  it('displays a decoded IDN while activity, opening and renaming keep canonical identifiers', async () => {
    const notify = vi.fn<Notify>();
    const onRenamed = vi.fn();
    const canonical = 'xn--80aae1b9a9d.test';
    const readable = '\u0432\u0430\u043b\u044e\u0442\u0430.test';
    const idn = Object.freeze({ ...shopProject, domain: canonical, path: `C:\\OSPanel\\home\\${canonical}` });
    mocks.openInBrowser.mockResolvedValue(undefined);
    mocks.getProjectActivity.mockResolvedValue([
      {
        domain: canonical,
        modifiedAt: 1_700_000_000,
        lastFile: 'index.php',
        status: 'ready',
      },
    ]);
    const renamed = { domain: 'xn--caf-dma.test', path: 'C:\\OSPanel\\home\\xn--caf-dma.test' };
    mocks.renameProject.mockResolvedValue(renamed);
    renderProjects(notify, [idn], onRenamed);

    expect(screen.getByRole('button', { name: readable }).closest('b')).toHaveAttribute('title', canonical);
    expect(screen.getByText(idn.path)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: `Show the last modified file in ${readable}` }),
    ).toBeInTheDocument();
    expect(mocks.getProjectActivity).toHaveBeenCalledWith([canonical]);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(`${readable} opened in browser`));
    expect(mocks.openInBrowser).toHaveBeenCalledWith(`https://${canonical}`);

    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Rename domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename domain' });
    const input = within(dialog).getByLabelText('New domain');
    const submit = within(dialog).getByRole('button', { name: 'Rename domain' });
    expect(input).toHaveValue(readable);
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: 'café.test' } });
    fireEvent.click(submit);
    await vi.waitFor(() => expect(onRenamed).toHaveBeenCalledWith(canonical, { ...idn, ...renamed }));
    expect(mocks.renameProject).toHaveBeenCalledWith(idn, renamed.domain);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(`${readable} renamed to café.test`),
      expect.any(Object),
    );
    expect(idn.domain).toBe(canonical);
  });

  it('opens hosts from the existing header without replacing the project table', async () => {
    renderProjects(vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'Hosts' }));
    expect(await screen.findByRole('dialog', { name: 'Hosts editor' })).toBeVisible();
    expect(screen.getByText('my-shop.test')).toBeInTheDocument();
    expect(screen.getByText('New project')).toBeInTheDocument();
  });

  it('reports a blocked popup instead of showing the success notification', async () => {
    const notify = vi.fn<Notify>();
    mocks.openInBrowser.mockRejectedValue(new Error('err.popupBlocked'));

    renderProjects(notify, [shopProject]);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith('The browser blocked the new window. Allow popups and try again'),
    );
    expect(notify).not.toHaveBeenCalledWith('my-shop.test opened in browser');
  });

  it('passes the project URL to the browser opener', async () => {
    const notify = vi.fn<Notify>();
    mocks.openInBrowser.mockResolvedValue(undefined);

    renderProjects(notify, [shopProject]);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await vi.waitFor(() => expect(mocks.openInBrowser).toHaveBeenCalledWith('https://my-shop.test'));
    expect(notify).toHaveBeenCalledWith('my-shop.test opened in browser');
  });
});

describe('Projects filtering', () => {
  it('filters by SSL state and PHP version, then resets everything', () => {
    renderProjects(vi.fn());
    expect(screen.getByText('my-shop.test')).toBeInTheDocument();
    expect(screen.getByText('landing.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'SSL' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Without certificate' }));
    expect(screen.queryByText('my-shop.test')).not.toBeInTheDocument();
    expect(screen.getByText('landing.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /PHP version/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'PHP 8.2' }));
    expect(screen.getByText('landing.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByText('my-shop.test')).toBeInTheDocument();
    expect(screen.getByText('landing.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('shows the filtered-empty note when no project matches', () => {
    renderProjects(vi.fn(), [shopProject]);

    fireEvent.click(screen.getByRole('button', { name: 'SSL' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Without certificate' }));

    expect(screen.getByText('No projects match the selected filters')).toBeInTheDocument();
  });

  it('propagates the search query upward', () => {
    const setQuery = vi.fn();
    render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Projects
          projects={[shopProject]}
          allProjects={[shopProject]}
          query=""
          setQuery={setQuery}
          notify={vi.fn()}
          onProjectCreated={vi.fn()}
          onProjectRenamed={vi.fn()}
          onProjectDeleted={vi.fn()}
          onToggleSsl={vi.fn()}
          onRestartPanel={vi.fn()}
        />
      </I18nContext.Provider>,
    );

    fireEvent.change(screen.getByPlaceholderText('Search projects...'), { target: { value: 'shop' } });
    expect(setQuery).toHaveBeenCalledWith('shop');
  });

  it('toggles SSL from the row button', () => {
    const { onToggleSsl } = rowCallbacks();
    render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Projects
          projects={[shopProject]}
          allProjects={[shopProject]}
          query=""
          setQuery={vi.fn()}
          notify={vi.fn()}
          onProjectCreated={vi.fn()}
          onProjectRenamed={vi.fn()}
          onProjectDeleted={vi.fn()}
          onToggleSsl={onToggleSsl}
          onRestartPanel={vi.fn()}
        />
      </I18nContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    expect(onToggleSsl).toHaveBeenCalledWith('my-shop.test', false);
  });
});

describe('Projects tag cleanup', () => {
  it('removes orphaned colors when the projects page loads', () => {
    localStorage.setItem(
      PROJECT_TAGS_KEY,
      JSON.stringify({
        version: 1,
        projects: { 'my-shop.test': ['Client'] },
        colors: { client: '#12a4ce', 'новая метка': '#19e11c' },
      }),
    );

    renderProjects(vi.fn());

    expect(readProjectTags(PROJECT_TAGS_KEY)).toEqual({ 'my-shop.test': ['Client'] });
    expect(readProjectTagColors(PROJECT_TAGS_KEY)).toEqual({ client: '#12a4ce' });
  });
});

describe('Projects row menu', () => {
  it('separates domain renaming, copying and deletion into action groups', () => {
    renderProjects(vi.fn());
    const menu = openRowMenu();
    expect(within(menu).getAllByRole('separator')).toHaveLength(4);
    for (const name of ['Open in browser', 'Rename domain', 'Copy domain', 'Delete project']) {
      expect(within(menu).getByRole('menuitem', { name }).previousElementSibling).toHaveProperty(
        'tagName',
        'HR',
      );
    }
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels.indexOf('Rename domain')).toBe(labels.indexOf('Copy domain') - 1);
  });

  it('opens the project settings page from the existing row menu and returns to the full list', async () => {
    renderProjects(vi.fn());

    fireEvent.click(within(openRowMenu()).getAllByRole('menuitem')[0]);
    expect(await screen.findByRole('region', { name: 'Project settings' })).toHaveTextContent('my-shop.test');
    expect(await screen.findByRole('tab', { name: 'Domains' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Search projects...')).toBeInTheDocument());
    expect(screen.getByText('landing.test')).toBeInTheDocument();
  });

  it('saves module versions from the environment tab and offers the shared panel restart', async () => {
    const notify = vi.fn<Notify>();
    const onRestartPanel = vi.fn();
    mocks.saveProjectSettings.mockImplementation(async (domain, settings) => ({
      domain,
      ...settings,
      fileExists: true,
    }));
    renderProjects(notify, [shopProject], vi.fn(), onRestartPanel);

    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Project settings' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Environment' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'PHP version' }), {
      target: { value: 'PHP_8.3' },
    });
    expect(notify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.saveProjectFile).toHaveBeenCalledWith(
        shopProject,
        'project.ini',
        expect.any(String),
        expect.stringContaining('PHP_8.3'),
      ),
    );
    expect(notify).toHaveBeenCalledExactlyOnceWith('Project settings saved — restart OSPanel to apply', {
      label: 'Restart panel',
      run: onRestartPanel,
    });
    expect(onRestartPanel).not.toHaveBeenCalled();
    notify.mock.calls[0][1]?.run();
    expect(onRestartPanel).toHaveBeenCalledOnce();
  });

  it('opens the project folder and reports a failure', async () => {
    const notify = vi.fn<Notify>();
    mocks.openProjectFolder.mockRejectedValue(new Error('boom'));
    renderProjects(notify);

    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Open folder' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to open folder'));
    expect(mocks.openProjectFolder).toHaveBeenCalledWith(shopProject.path);
  });

  it('opens the project in the chosen editor', async () => {
    const notify = vi.fn<Notify>();
    mocks.openInEditor.mockResolvedValue(undefined);
    renderProjects(notify);

    const menu = openRowMenu();
    // Editors load asynchronously; the section appears in the open menu once they arrive.
    const openIn = await within(menu).findByRole('menuitem', { name: 'Open in' });
    fireEvent.click(openIn);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'VS Code' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('my-shop.test opened in VS Code'));
    expect(mocks.openInEditor).toHaveBeenCalledWith('vscode', 'C:\\OSPanel\\domains\\my-shop');
  });

  it('copies the domain to the clipboard and reports a failure', async () => {
    const notify = vi.fn<Notify>();
    stubClipboard(() => Promise.reject(new Error('denied')));
    renderProjects(notify);

    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Copy domain' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to copy'));
  });

  it('copies the path to the clipboard', async () => {
    const notify = vi.fn<Notify>();
    stubClipboard(() => Promise.resolve());
    renderProjects(notify);

    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Copy path' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Path copied to clipboard'));
  });

  it('delegates deletion to the parent component', () => {
    const { onProjectDeleted } = rowCallbacks();
    render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Projects
          projects={[shopProject]}
          allProjects={[shopProject]}
          query=""
          setQuery={vi.fn()}
          notify={vi.fn()}
          onProjectCreated={vi.fn()}
          onProjectRenamed={vi.fn()}
          onProjectDeleted={onProjectDeleted}
          onToggleSsl={vi.fn()}
          onRestartPanel={vi.fn()}
        />
      </I18nContext.Provider>,
    );

    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Delete project' }));
    expect(onProjectDeleted).toHaveBeenCalledWith('my-shop.test');
  });
});

describe('Projects domain renaming', () => {
  it('detects equivalent IDNs and previews and submits a punycode name', async () => {
    const onRenamed = vi.fn();
    const existing = { ...landingProject, domain: 'xn--caf-dma.test' };
    const renamed = { domain: 'xn--bcher-kva.test', path: 'C:\\OSPanel\\home\\xn--bcher-kva.test' };
    mocks.renameProject.mockResolvedValue(renamed);
    renderProjects(vi.fn(), [shopProject, existing], onRenamed);
    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Rename domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename domain' });
    const input = within(dialog).getByLabelText('New domain');
    const submit = within(dialog).getByRole('button', { name: 'Rename domain' });

    fireEvent.change(input, { target: { value: 'café.test' } });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('already exists');

    fireEvent.change(input, { target: { value: 'BÜCHER.test' } });
    expect(submit).toBeEnabled();
    expect(within(dialog).getByText('my-shop.test → xn--bcher-kva.test')).toBeInTheDocument();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(onRenamed).toHaveBeenCalledWith(shopProject.domain, { ...shopProject, ...renamed }),
    );
    expect(mocks.renameProject).toHaveBeenCalledExactlyOnceWith(shopProject, renamed.domain);
  });

  it('validates names, prevents duplicate submits and keeps tags, engines and TLS', async () => {
    const notify = vi.fn<Notify>();
    const onRenamed = vi.fn();
    writeProjectTags(PROJECT_TAGS_KEY, { 'my-shop.test': ['Client'], 'new.test': ['Stale'] });
    let finish: (result: { domain: string; path: string }) => void = () => {};
    mocks.renameProject.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderProjects(notify, [shopProject, landingProject], onRenamed);
    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Rename domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename domain' });
    const input = within(dialog).getByLabelText('New domain');
    const submit = within(dialog).getByRole('button', { name: 'Rename domain' });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: '../escape' } });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: 'LANDING.TEST' } });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('already exists');
    fireEvent.change(input, { target: { value: ' New.test ' } });
    fireEvent.submit(submit.closest('form') as HTMLFormElement);
    fireEvent.submit(submit.closest('form') as HTMLFormElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(submit).toBeDisabled();
    expect(mocks.renameProject).toHaveBeenCalledExactlyOnceWith(shopProject, 'new.test');
    const renamed = { domain: 'new.test', path: 'C:\\OSPanel\\home\\new.test' };
    finish(renamed);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onRenamed).toHaveBeenCalledWith('my-shop.test', { ...shopProject, ...renamed });
    expect(readProjectTags(PROJECT_TAGS_KEY)).toEqual({ 'new.test': ['Client'] });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('my-shop.test renamed to new.test'), {
      label: 'Restart panel',
      run: expect.any(Function),
    });
  });

  it('keeps the dialog and metadata unchanged on a command error and allows retry', async () => {
    const onRenamed = vi.fn();
    writeProjectTags(PROJECT_TAGS_KEY, { 'my-shop.test': ['Client'] });
    mocks.renameProject.mockRejectedValue(
      Object.assign(new Error('err.projectExists'), { params: { domain: 'taken.test' } }),
    );
    renderProjects(vi.fn(), [shopProject], onRenamed);
    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Rename domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename domain' });
    fireEvent.change(within(dialog).getByLabelText('New domain'), { target: { value: 'taken.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename domain' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Project taken.test already exists');
    expect(onRenamed).not.toHaveBeenCalled();
    expect(readProjectTags(PROJECT_TAGS_KEY)).toEqual({ 'my-shop.test': ['Client'] });
    expect(within(dialog).getByRole('button', { name: 'Rename domain' })).toBeEnabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Projects create dialog', () => {
  it('opens the create dialog and closes it on Escape', async () => {
    const onProjectCreated = vi.fn();
    render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Projects
          projects={[shopProject]}
          allProjects={[shopProject]}
          query=""
          setQuery={vi.fn()}
          notify={vi.fn()}
          onProjectCreated={onProjectCreated}
          onProjectRenamed={vi.fn()}
          onProjectDeleted={vi.fn()}
          onToggleSsl={vi.fn()}
          onRestartPanel={vi.fn()}
        />
      </I18nContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /New project/ }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Domain name')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
