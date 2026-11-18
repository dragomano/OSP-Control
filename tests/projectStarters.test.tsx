import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStartersWorkspace } from '../src/components/pages/ProjectStartersWorkspace';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';
import { DEFAULT_STARTERS } from '../src/projectTemplates';

const mocks = vi.hoisted(() => ({
  listProjectStarters: vi.fn(),
  saveProjectStarter: vi.fn(),
  deleteProjectStarter: vi.fn(),
  restoreDefaultProjectStarters: vi.fn(),
  openProjectStartersFolder: vi.fn(),
  askConfirm: vi.fn(),
}));

vi.mock('../src/projectStarters', async (original) => ({
  ...(await original<typeof import('../src/projectStarters')>()),
  ...mocks,
}));
vi.mock('../src/ospanel', async (original) => ({
  ...(await original<typeof import('../src/ospanel')>()),
  askConfirm: mocks.askConfirm,
}));

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveProjectStarter.mockImplementation(async (starter) => ({ ...starter, revision: 'new-revision' }));
  mocks.listProjectStarters.mockResolvedValue(
    DEFAULT_STARTERS.map((document) => ({
      id: document.manifest.id,
      document: structuredClone(document),
      error: null,
    })),
  );
});

afterEach(() => cleanup());

const renderWorkspace = () => {
  const notify = vi.fn();
  const onClose = vi.fn();
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>
      <ProjectStartersWorkspace notify={notify} onClose={onClose} />
    </I18nContext.Provider>,
  );
  return { notify, onClose };
};

describe('ProjectStartersWorkspace', () => {
  it('lists built-in templates as read-only and shipped starters as editable', async () => {
    renderWorkspace();
    expect(await screen.findByText('PHP application')).toBeVisible();
    expect(screen.getByText('Built-in templates')).toBeVisible();
    expect(screen.getByText('Empty project')).toBeVisible();
    // Empty and static are shown, but never as selectable editable rows.
    expect(screen.queryByRole('button', { name: 'Empty project' })).toBeNull();
  });

  it('reports a broken user folder without dropping the rest of the catalog', async () => {
    mocks.listProjectStarters.mockResolvedValue([
      { id: 'broken', document: null, error: { code: 'err.projectTemplateInvalid' } },
      { id: 'php', document: DEFAULT_STARTERS.find((doc) => doc.manifest.id === 'php'), error: null },
    ]);
    renderWorkspace();
    await screen.findByText('PHP application');
    expect(screen.getByText('broken')).toBeVisible();
  });

  it('opens a starter whose install section arrived as an explicit null', async () => {
    const base = DEFAULT_STARTERS.find((doc) => doc.manifest.id === 'php');
    if (!base) throw new Error('the php starter is missing from the shipped defaults');
    const php = structuredClone(base);
    // Rust serializes an absent optional section as null in older documents.
    php.manifest.install = null as unknown as undefined;
    mocks.listProjectStarters.mockResolvedValue([{ id: 'php', document: php, error: null }]);
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /PHP application/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'PHP application' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Install' })).toBeVisible();
  });

  it('opens starters whose manifest leaves optional install collections out', async () => {
    // Shipped starter.json files omit empty collections; Rust fills defaults on read,
    // while documents built straight from JSON must get the same shape.
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /WordPress/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Install' }));
    expect(screen.getByRole('tabpanel', { name: 'Install texts' })).toBeVisible();
  });

  it('edits the manifest fields and saves through the adapter', async () => {
    const { notify } = renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /PHP application/ }));
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'My PHP starter' } });
    await waitFor(() => expect(name.value).toBe('My PHP starter'));
    // A new template has no revision until the first save; the id becomes editable too.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveProjectStarter).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith('Template saved');
  });

  it('switches to the web server tab and keeps per-engine configs separate', async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /PHP application/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Web server' }));
    // The shipped php starter defines no web server configs: an empty state offers
    // to create one, and after creation the engine file editor appears.
    expect(screen.getByText(/No configuration for this web server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create configuration' }));
    expect(screen.getByText(/\.osp\/nginx\/php\.conf/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'starter.json' }));
    expect(screen.getByLabelText('starter.json')).toBeVisible();
  });

  it('edits the install section: enable, texts and the composer command', async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /PHP application/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Install' }));
    // The shipped php starter has no install section: the tab starts switched off.
    fireEvent.click(screen.getByRole('button', { name: 'Add install section' }));
    const buttonField = await screen.findByLabelText('Install button');
    expect(buttonField).toHaveValue('PHP application');
    expect(screen.queryByLabelText('Composer package (create-project)')).toBeNull();
    fireEvent.change(buttonField, { target: { value: 'Install application' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Engine' }));
    expect(screen.queryByLabelText('Install button')).toBeNull();
    fireEvent.change(screen.getByLabelText('Composer package (create-project)'), {
      target: { value: 'vendor/package' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveProjectStarter).toHaveBeenCalled());
    const saved = mocks.saveProjectStarter.mock.calls[0][0];
    expect(saved.manifest.install.createProject).toBe('vendor/package');
    expect(saved.manifest.install.button).toMatchObject({ en: 'Install application' });
    fireEvent.click(screen.getByRole('tab', { name: 'Install texts' }));
    expect(screen.getByLabelText('Install button')).toHaveValue('Install application');
    fireEvent.click(screen.getByRole('tab', { name: 'Engine' }));

    // The archive engine replaces the composer fields and parses the line-based maps.
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.change(screen.getByLabelText('Archive URL ({version} is resolved from the catalog)'), {
      target: { value: 'https://example.org/app-{version}.zip' },
    });
    fireEvent.change(screen.getByLabelText('Required archive files'), {
      target: { value: 'index.php\nwp-load.php' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Environment and SQLite' }));
    expect(screen.queryByLabelText('Required archive files')).toBeNull();
    fireEvent.change(screen.getByLabelText('Environment variables'), {
      target: { value: 'APP_ENV=local' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration templates' }));
    fireEvent.change(screen.getByLabelText('Random keys (name=bytes)'), {
      target: { value: 'appSalt=32' },
    });
    fireEvent.change(screen.getByLabelText('Config files (template=destination)'), {
      target: { value: 'config.php=public/config.php' },
    });
    fireEvent.change(screen.getByLabelText('Files kept from the scaffold'), {
      target: { value: '.gitignore' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Install phases' }));
    fireEvent.change(await screen.findByLabelText('Checking the scaffold…'), {
      target: { value: 'Checking…' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveProjectStarter).toHaveBeenCalledTimes(2));
    const archived = mocks.saveProjectStarter.mock.calls[1][0];
    expect(archived.manifest.install.archive.url).toBe('https://example.org/app-{version}.zip');
    expect(archived.manifest.install.archive.extract.requiredFiles).toEqual(['index.php', 'wp-load.php']);
    expect(archived.manifest.install.env).toEqual({ APP_ENV: 'local' });
    expect(archived.manifest.install.randomHex).toEqual({ appSalt: 32 });
    expect(archived.manifest.install.configFiles).toEqual([
      { template: 'config.php', to: 'public/config.php' },
    ]);
    expect(archived.manifest.install.keep).toEqual(['.gitignore']);
    expect(archived.manifest.install.phases.preparing).toBe('Checking…');

    // Back to Composer: the archive section is dropped, the command field returns.
    fireEvent.click(screen.getByRole('tab', { name: 'Engine' }));
    expect(screen.getByLabelText('Required archive files')).toHaveValue('index.php\nwp-load.php');
    fireEvent.click(screen.getByRole('button', { name: 'Composer' }));
    expect(screen.getByLabelText('Composer package (create-project)')).toBeInTheDocument();

    // Toggling the section off removes the install button from the starter.
    fireEvent.click(screen.getByRole('switch', { name: 'One-click install' }));
    expect(screen.queryByLabelText('Composer package (create-project)')).toBeNull();
  });

  it('keeps boolean settings on switches and saves their state', async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /Laravel/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Install' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Engine' }));
    const scripts = screen.getByRole('switch', { name: 'Run package scripts' });
    expect(scripts).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(scripts);
    expect(scripts).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Database' }));
    const database = screen.getByRole('switch', { name: 'Ask for a database when creating a project' });
    expect(database).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(database);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveProjectStarter).toHaveBeenCalled());
    const saved = mocks.saveProjectStarter.mock.calls[0][0];
    expect(saved.manifest.install.scripts).toBe(true);
    expect(saved.manifest.database.enabled).toBe(false);
  });
});
