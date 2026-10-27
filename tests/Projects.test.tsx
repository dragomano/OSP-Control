import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../src/components/pages/Projects';
import type { Notify } from '../src/components/shared';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { OsPanelProject } from '../src/ospanel';

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

const renderProjects = (notify: Notify, projects: OsPanelProject[] = [shopProject, landingProject]) =>
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <Projects
        projects={projects}
        allProjects={projects}
        query=""
        setQuery={vi.fn()}
        notify={notify}
        onProjectCreated={vi.fn()}
        onProjectDeleted={vi.fn()}
        onToggleSsl={vi.fn()}
        onRestartPanel={vi.fn()}
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
});

afterEach(() => cleanup());

describe('Projects browser opening', () => {
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

describe('Projects row menu', () => {
  it('opens the module versions dialog and closes it on Escape', async () => {
    renderProjects(vi.fn());

    fireEvent.click(within(openRowMenu()).getAllByRole('menuitem')[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Module versions' });
    expect(dialog).toHaveTextContent('my-shop.test');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens the project folder and reports a failure', async () => {
    const notify = vi.fn<Notify>();
    mocks.openProjectFolder.mockRejectedValue(new Error('boom'));
    renderProjects(notify);

    fireEvent.click(within(openRowMenu()).getByRole('menuitem', { name: 'Open folder' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to open folder'));
    expect(mocks.openProjectFolder).toHaveBeenCalledWith('C:\\OSPanel\\domains\\my-shop');
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
