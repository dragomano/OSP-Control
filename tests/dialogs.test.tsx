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

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

const renderI18n = (ui: ReactElement) =>
  render(<I18nContext.Provider value={{ lang: 'en', t, plural }}>{ui}</I18nContext.Provider>);

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
  const renderDialog = () => {
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
    );
    return { notify, onCreated, onRestartPanel, onClose };
  };

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
    const onClose = vi.fn();
    renderI18n(<ProjectModulesDialog project={project} notify={notify} onClose={onClose} />);
    return { notify, onClose };
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

  it('saves the draft and clears the dirty state', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    mocks.saveProjectSettings.mockResolvedValue({ ...projectSettings, httpEngine: 'Nginx_1.25' });
    const { notify } = renderDialog();

    fireEvent.change(await screen.findByRole('combobox', { name: 'HTTP engine' }), {
      target: { value: 'Nginx_1.25' },
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Module versions for shop.test saved'));
    expect(mocks.saveProjectSettings).toHaveBeenCalledWith('shop.test', {
      httpEngine: 'Nginx_1.25',
      phpEngine: 'PHP_8.2',
      nodeEngine: 'auto',
      tlsEnabled: 'on',
    });
    expect(save).toBeDisabled();
  });

  it('reports a failed save', async () => {
    mocks.getProjectModuleOptions.mockResolvedValue(moduleOptions);
    mocks.getProjectSettings.mockResolvedValue(projectSettings);
    mocks.getGlobalProjectEngines.mockRejectedValue(new Error('boom'));
    mocks.saveProjectSettings.mockRejectedValue(new Error('boom'));
    const { notify } = renderDialog();

    fireEvent.change(await screen.findByRole('combobox', { name: 'HTTP engine' }), {
      target: { value: 'Nginx_1.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(MODULES_FAILED));
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
