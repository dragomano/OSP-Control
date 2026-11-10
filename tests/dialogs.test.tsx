import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateProjectDialog } from '../src/components/dialogs/CreateProjectDialog';
import { ModuleSelect } from '../src/components/dialogs/ModuleSelect';
import { ProjectModulesDialog } from '../src/components/dialogs/ProjectModulesDialog';
import type { Notify } from '../src/components/shared';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { CreatedProject, OsPanelProject } from '../src/ospanel';

const mocks = vi.hoisted(() => ({
  getProjectModuleOptions: vi.fn(),
  createProject: vi.fn(),
  getProjectSettings: vi.fn(),
  getGlobalProjectEngines: vi.fn(),
  saveProjectSettings: vi.fn(),
  openFileExternally: vi.fn(),
}));

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return { ...actual, ...mocks };
});

const renderI18n = (ui: ReactElement, lang = 'en') => {
  const dictionary = embeddedDict(lang);
  const translator = makeTranslator(dictionary, embeddedDict('en'));
  return render(
    <I18nContext.Provider value={{ lang, t: translator, plural: makePlural(translator, lang, dictionary) }}>
      {ui}
    </I18nContext.Provider>,
  );
};

const moduleOptions = {
  httpEngines: ['Apache_2.4', 'Nginx_1.25'],
  phpEngines: ['PHP_8.2', 'PHP_8.3'],
  nodeEngines: [],
};

const createdProject: CreatedProject = {
  domain: 'shop.test',
  path: 'C:\\OSPanel\\home\\shop.test',
  http: 'auto',
  php: 'auto',
  ssl: false,
};

const project: OsPanelProject = {
  domain: 'shop.test',
  path: 'C:\\OSPanel\\domains\\shop.test',
  php: '8.3',
  type: 'Laravel',
  ssl: true,
};

const projectSettings = {
  domain: 'shop.test',
  httpEngine: 'Apache_2.4',
  phpEngine: 'PHP_8.2',
  nodeEngine: 'auto',
  tlsEnabled: 'on',
  fileExists: true,
};

const MODULES_FAILED = 'Failed to save module versions for the project';

beforeEach(() => {
  mocks.getProjectModuleOptions.mockReset();
  mocks.createProject.mockReset();
  mocks.getProjectSettings.mockReset();
  mocks.getGlobalProjectEngines.mockReset();
  mocks.saveProjectSettings.mockReset();
  mocks.openFileExternally.mockReset();
});

afterEach(() => cleanup());

describe('ModuleSelect', () => {
  const onChange = vi.fn();

  const renderSelect = (globalHint: string | null) =>
    render(
      <ModuleSelect
        label="HTTP engine"
        value="auto"
        options={['auto', 'Nginx', 'Apache']}
        autoLabel="Auto (module settings)"
        globalHint={globalHint}
        onChange={onChange}
      />,
    );

  afterEach(() => {
    cleanup();
    onChange.mockReset();
  });

  it('renders the auto option first, with its own label, and deduplicates options', () => {
    renderSelect(null);
    const select = screen.getByRole('combobox', { name: 'HTTP engine' });
    expect(select).toHaveValue('auto');
    const labels = [...select.querySelectorAll('option')].map((option) => option.textContent);
    expect(labels).toEqual(['Auto (module settings)', 'Nginx', 'Apache']);
  });

  it('reports the selected value to onChange', () => {
    renderSelect(null);
    fireEvent.change(screen.getByRole('combobox', { name: 'HTTP engine' }), { target: { value: 'Nginx' } });
    expect(onChange).toHaveBeenCalledWith('Nginx');
  });

  it('shows the global hint only when it is provided', () => {
    const view = renderSelect('Global setting: Apache');
    expect(screen.getByText('Global setting: Apache')).toBeInTheDocument();

    view.rerender(
      <ModuleSelect
        label="HTTP engine"
        value="auto"
        options={['auto', 'Nginx', 'Apache']}
        autoLabel="Auto (module settings)"
        globalHint={null}
        onChange={onChange}
      />,
    );
    expect(screen.queryByText('Global setting: Apache')).not.toBeInTheDocument();
  });
});

describe('CreateProjectDialog', () => {
  const renderDialog = (lang = 'en') => {
    const notify = vi.fn<Notify>();
    const onCreated = vi.fn();
    const onRestartPanel = vi.fn();
    const onClose = vi.fn();
    renderI18n(
      <CreateProjectDialog
        notify={notify}
        onCreated={onCreated}
        onRestartPanel={onRestartPanel}
        onClose={onClose}
      />,
      lang,
    );
    return { notify, onCreated, onRestartPanel, onClose };
  };

  it.each(['en', 'ru', 'uk', 'be', 'es'])(
    'passes the current application language %s to scaffold creation',
    async (language) => {
      mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
      mocks.createProject.mockResolvedValue(createdProject);
      const translator = makeTranslator(embeddedDict(language), embeddedDict('en'));
      renderDialog(language);
      fireEvent.change(await screen.findByLabelText(translator('projects.createDomain')), {
        target: { value: 'site.test' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: translator('templates.label') }), {
        target: { value: 'static' },
      });
      fireEvent.click(screen.getByRole('button', { name: translator('projects.create') }));
      await vi.waitFor(() =>
        expect(mocks.createProject).toHaveBeenCalledWith(
          expect.objectContaining({ domain: 'site.test', template: 'static', language }),
        ),
      );
    },
  );

  it('shows the loading note, then the form with the domain field focused', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    renderDialog();

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    const domain = await screen.findByLabelText('Domain name');
    await waitFor(() => expect(domain).toHaveFocus());
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'HTTP engine' })).toHaveValue('auto');
    expect(screen.getByRole('combobox', { name: 'PHP version' })).toHaveValue('auto');
    expect(screen.getByRole('combobox', { name: 'Node.js version' })).toHaveValue('auto');
  });

  it('keeps Create disabled until a domain is typed and previews the config path', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    renderDialog();

    const create = await screen.findByRole('button', { name: 'Create project' });
    expect(create).toBeDisabled();

    const domain = screen.getByLabelText('Domain name');
    fireEvent.change(domain, { target: { value: '   ' } });
    expect(create).toBeDisabled();

    fireEvent.change(domain, { target: { value: 'shop.test' } });
    expect(create).toBeEnabled();
    expect(screen.getByText('home/shop.test/.osp/project.ini')).toBeInTheDocument();
  });

  it('creates the project with trimmed domain and omitted auto engines', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.createProject.mockResolvedValue(createdProject);
    const { notify, onCreated, onRestartPanel, onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: ' shop.test ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.createProject).toHaveBeenCalledWith({
      language: 'en',
      domain: 'shop.test',
      httpEngine: undefined,
      phpEngine: undefined,
      nodeEngine: undefined,
    });
    expect(onCreated).toHaveBeenCalledWith(createdProject);
    expect(notify).toHaveBeenCalledWith('Project shop.test created', {
      label: 'Restart panel',
      run: onRestartPanel,
    });
  });

  it.each([
    ['café.test', 'xn--caf-dma.test'],
    ['XN--CAF-DMA.TEST', 'xn--caf-dma.test'],
    ['\u0432\u0430\u043b\u044e\u0442\u0430.test', 'xn--80aae1b9a9d.test'],
  ])('previews and submits the normalized project domain for %s', async (input, domain) => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    const created = { ...createdProject, domain, path: `C:\\OSPanel\\home\\${domain}` };
    mocks.createProject.mockResolvedValue(created);
    const { onCreated } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: input } });
    expect(screen.getByText(`home/${domain}/.osp/project.ini`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ domain }));
  });

  it('rejects malformed punycode before creating a project', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'xn--.test' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid domain name');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('sends only the engines changed away from auto', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.createProject.mockResolvedValue(createdProject);
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'shop.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'HTTP engine' }), {
      target: { value: 'Nginx_1.25' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'PHP version' }), { target: { value: 'PHP_8.3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.createProject).toHaveBeenCalledWith({
      language: 'en',
      domain: 'shop.test',
      httpEngine: 'Nginx_1.25',
      phpEngine: 'PHP_8.3',
      nodeEngine: undefined,
    });
  });

  it('reports a failed creation and keeps the dialog open', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.createProject.mockRejectedValue(new Error('boom'));
    const { notify, onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'shop.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to create project'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes with a notification when the module options fail to load', async () => {
    mocks.getProjectModuleOptions.mockRejectedValue(new Error('boom'));
    const { notify, onClose } = renderDialog();

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(MODULES_FAILED));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('previews a Laravel scaffold and retains the domain when switching templates', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getGlobalProjectEngines.mockResolvedValue({
      httpEngine: 'Apache_2.4',
      phpEngine: 'PHP_8.2',
      nodeEngine: '',
    });
    renderDialog();
    const domain = await screen.findByLabelText('Domain name');
    fireEvent.change(domain, { target: { value: 'CAFÉ.test' } });
    const template = screen.getByRole('combobox', { name: 'Project template' });
    expect(template.querySelectorAll('option')).toHaveLength(6);
    fireEvent.change(template, { target: { value: 'laravel' } });
    expect(domain).toHaveValue('CAFÉ.test');
    expect(screen.getByText('{base_dir}\\public')).toBeInTheDocument();
    expect(screen.getByText(/click Install Laravel in the project overview/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Files to create: 10'));
    expect(screen.getByText('.osp/nginx/xn--caf-dma.test.conf')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'HTTP engine' })).toHaveValue('Apache_2.4');
    expect(screen.getByRole('combobox', { name: 'PHP version' })).toHaveValue('PHP_8.2');
    expect(screen.getByRole('combobox', { name: 'Node.js version' })).toHaveValue('');
    fireEvent.change(template, { target: { value: 'empty' } });
    expect(screen.getByRole('combobox', { name: 'PHP version' })).toHaveValue('auto');
    expect(domain).toHaveValue('CAFÉ.test');
  });

  it('defaults Laravel to a named SQLite database and submits the choice', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.createProject.mockResolvedValue(createdProject);
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'site.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project template' }), {
      target: { value: 'laravel' },
    });
    expect(screen.getByLabelText('Database engine')).toHaveValue('sqlite');
    expect(screen.getByLabelText('New database name')).toHaveValue('site_test');
    expect(screen.queryByLabelText('Database password')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New database name'), { target: { value: '../invalid' } });
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New database name'), { target: { value: 'site_app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await vi.waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'laravel',
          database: { engine: 'sqlite', name: 'site_app', username: '', password: '' },
        }),
      ),
    );
  });
  it('limits WordPress to MySQL/MariaDB and submits database credentials', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue({
      ...moduleOptions,
      databaseEngines: ['MySQL-8.4', 'PostgreSQL-17', 'MariaDB-11.8'],
    });
    mocks.createProject.mockResolvedValue(createdProject);
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'site.test' } });
    const template = screen.getByRole('combobox', { name: 'Project template' });
    fireEvent.change(template, { target: { value: 'wordpress' } });
    const db = screen.getByLabelText('Database engine');
    expect([...db.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'MySQL-8.4',
      'MariaDB-11.8',
      'none',
    ]);
    fireEvent.change(db, { target: { value: 'MySQL-8.4' } });
    fireEvent.change(screen.getByLabelText('New database name'), { target: { value: 'cms_data' } });
    fireEvent.change(screen.getByLabelText('Database user'), { target: { value: 'local_admin' } });
    fireEvent.change(screen.getByLabelText('Database password'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await vi.waitFor(() =>
      expect(mocks.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'wordpress',
          database: {
            engine: 'MySQL-8.4',
            name: 'cms_data',
            username: 'local_admin',
            password: 'synthetic-password',
          },
        }),
      ),
    );
  });
  it('allows WordPress preparation without installed database modules', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'site.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project template' }), {
      target: { value: 'wordpress' },
    });
    expect(screen.getByLabelText('Database engine')).toHaveValue('none');
    expect(screen.getByText(/Install a MySQL or MariaDB module/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
  });

  it('creates a static scaffold with unused runtimes and offers README instructions', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.createProject.mockResolvedValue(createdProject);
    const { notify, onClose } = renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'shop.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project template' }), {
      target: { value: 'static' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.createProject).toHaveBeenCalledWith({
      language: 'en',
      domain: 'shop.test',
      template: 'static',
      httpEngine: 'Apache_2.4',
      phpEngine: '',
      nodeEngine: '',
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('README.md'),
      expect.objectContaining({ label: 'Restart panel' }),
    );
  });

  it('blocks a Node scaffold with a missing runtime and requires an explicit installed version', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'shop.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project template' }), {
      target: { value: 'node' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('No Node.js versions are installed');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: 'Node.js version' })).not.toBeInTheDocument();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('validates the Node port and locks the creation form while publishing', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue({
      ...moduleOptions,
      nodeEngines: ['Node-22', 'Node-24'],
    });
    let resolveCreate!: (created: CreatedProject) => void;
    mocks.createProject.mockReturnValue(
      new Promise<CreatedProject>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { onClose } = renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'shop.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project template' }), {
      target: { value: 'node' },
    });
    const port = screen.getByRole('spinbutton', { name: 'Application port' });
    for (const value of ['0', '65536', '3.5', '']) {
      fireEvent.change(port, { target: { value } });
      expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    }
    fireEvent.change(port, { target: { value: '4321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'node', backendPort: 4321, nodeEngine: 'Node-24', phpEngine: '' }),
    );
    expect(screen.getByRole('combobox', { name: 'Project template' })).toBeDisabled();
    expect(screen.getByLabelText('Domain name')).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    resolveCreate(createdProject);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('copies the NVM command and refreshes installed versions without resetting the form', async () => {
    mocks.getProjectModuleOptions
      .mockResolvedValueOnce({ ...moduleOptions, nvmAvailable: true })
      .mockResolvedValueOnce({
        ...moduleOptions,
        nodeEngines: ['Node-22.0.0', 'Node-24.10.0'],
        nvmAvailable: true,
      });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderDialog();
    const domain = await screen.findByLabelText('Domain name');
    fireEvent.change(domain, { target: { value: 'shop.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project template' }), {
      target: { value: 'node' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'HTTP engine' }), {
      target: { value: 'Nginx_1.25' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'PHP version' }), { target: { value: 'PHP_8.2' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Application port' }), {
      target: { value: '4321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('osp node install lts'));
    screen.getByRole('button', { name: 'Refresh versions' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh versions' }));
    const node = await screen.findByRole('combobox', { name: 'Node.js version' });
    expect(node).toHaveValue('Node-24.10.0');
    expect(domain).toHaveValue('shop.test');
    expect(screen.getByRole('combobox', { name: 'Project template' })).toHaveValue('node');
    expect(screen.getByRole('combobox', { name: 'HTTP engine' })).toHaveValue('Nginx_1.25');
    expect(screen.getByRole('combobox', { name: 'PHP version' })).toHaveValue('PHP_8.2');
    expect(screen.getByRole('spinbutton', { name: 'Application port' })).toHaveValue(4321);
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
    expect(domain).not.toHaveFocus();
  });

  it('explains a missing NVM add-on and keeps the form after a refresh failure', async () => {
    mocks.getProjectModuleOptions
      .mockResolvedValueOnce({ ...moduleOptions, nvmAvailable: false })
      .mockRejectedValueOnce(new Error('failure'));
    const { notify } = renderDialog();
    fireEvent.change(await screen.findByLabelText('Domain name'), { target: { value: 'shop.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project template' }), {
      target: { value: 'node' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('The NVM add-on is not available');
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh versions' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(MODULES_FAILED));
    expect(screen.getByLabelText('Domain name')).toHaveValue('shop.test');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
  });

  it('closes on Escape and on an outside mousedown', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    const { onClose } = renderDialog();
    await screen.findByLabelText('Domain name');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ProjectModulesDialog', () => {
  const renderDialog = () => {
    const notify = vi.fn<Notify>();
    const onRestartPanel = vi.fn();
    const onClose = vi.fn();
    renderI18n(
      <ProjectModulesDialog
        project={project}
        notify={notify}
        onRestartPanel={onRestartPanel}
        onClose={onClose}
      />,
    );
    return { notify, onRestartPanel, onClose };
  };

  it('loads the saved values and shows the global engine hints', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockResolvedValue({ httpEngine: 'Apache', phpEngine: '', nodeEngine: '' });
    renderDialog();

    // The hint text is part of the wrapping label, so the accessible name is a superset.
    const http = await screen.findByRole('combobox', { name: /HTTP engine/ });
    expect(http).toHaveValue('Apache_2.4');
    expect(screen.getByRole('combobox', { name: /PHP version/ })).toHaveValue('PHP_8.2');
    expect(screen.getByText('Global setting: Apache')).toBeInTheDocument();
    expect(screen.getAllByText('Not set globally — the engine is not used')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('stays usable and hides the hints when the global engines cannot be read', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    renderDialog();

    expect(await screen.findByRole('combobox', { name: 'HTTP engine' })).toHaveValue('Apache_2.4');
    expect(screen.queryByText('Global setting: Apache')).not.toBeInTheDocument();
  });

  it('saves the draft, closes the dialog and offers a panel restart', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    mocks.saveProjectSettings.mockResolvedValue({ ...projectSettings, httpEngine: 'Nginx_1.25' });
    const { notify, onRestartPanel, onClose } = renderDialog();

    fireEvent.change(await screen.findByRole('combobox', { name: 'HTTP engine' }), {
      target: { value: 'Nginx_1.25' },
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Module versions for shop.test saved — restart the panel to apply',
        { label: 'Restart panel', run: onRestartPanel },
      ),
    );
    expect(mocks.saveProjectSettings).toHaveBeenCalledWith('shop.test', {
      httpEngine: 'Nginx_1.25',
      phpEngine: 'PHP_8.2',
      nodeEngine: 'auto',
      tlsEnabled: 'on',
    });
    expect(save).toBeDisabled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRestartPanel).not.toHaveBeenCalled();
    notify.mock.calls[0][1]?.run();
    expect(onRestartPanel).toHaveBeenCalledOnce();
  });

  it('reports a failed save without closing or offering a restart', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    mocks.saveProjectSettings.mockRejectedValue(new Error('boom'));
    const { notify, onRestartPanel, onClose } = renderDialog();

    fireEvent.change(await screen.findByRole('combobox', { name: 'HTTP engine' }), {
      target: { value: 'Nginx_1.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(MODULES_FAILED));
    expect(notify).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(onRestartPanel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('opens project.ini from the file link and reports a failure', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    mocks.openFileExternally.mockRejectedValue(new Error('boom'));
    const { notify } = renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: '.osp\\project.ini' }));

    expect(mocks.openFileExternally).toHaveBeenCalledWith(
      'C:\\OSPanel\\domains\\shop.test\\.osp\\project.ini',
    );
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to open the file'));
  });

  it('tells that the settings file does not exist yet', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue({ ...projectSettings, fileExists: false });
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    renderDialog();

    expect(await screen.findByText('The settings file will be created on save')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '.osp\\project.ini' })).not.toBeInTheDocument();
  });

  it('closes with a notification when the project settings fail to load', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockRejectedValue(new Error('boom'));
    const { notify, onClose } = renderDialog();

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(MODULES_FAILED));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on an outside mousedown', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    const { onClose } = renderDialog();

    await screen.findByRole('combobox', { name: 'HTTP engine' });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
