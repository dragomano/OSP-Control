import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Database } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notify, Service } from '../src/components/shared';
import { Backups } from '../src/components/tables/Backups';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { BackupEntry, OsPanelProject } from '../src/ospanel';

const mocks = vi.hoisted(() => ({
  listBackups: vi.fn(),
  createBackup: vi.fn(),
  createDbBackup: vi.fn(),
  createProjectBackup: vi.fn(),
  restoreBackup: vi.fn(),
  restoreDbBackup: vi.fn(),
  restoreProjectBackup: vi.fn(),
  deleteBackup: vi.fn(),
  openBackupsFolder: vi.fn(),
  askConfirm: vi.fn(),
}));

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return { ...actual, ...mocks };
});

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

const configBackup: BackupEntry = {
  id: 'config-123',
  createdAt: 1_700_000_000,
  sizeBytes: 1024,
  files: 1,
  kind: 'config',
  subject: null,
};

const dbBackup: BackupEntry = {
  id: 'db-mysql',
  createdAt: 1_700_000_001,
  sizeBytes: 2048,
  files: 1,
  kind: 'db',
  subject: 'MySQL-8.0',
};

const projectBackup: BackupEntry = {
  id: 'proj-shop',
  createdAt: 1_700_000_002,
  sizeBytes: 4096,
  files: 3,
  kind: 'project',
  subject: 'my-shop.test',
};

const database = (name: string): Service => ({
  name,
  version: '',
  port: '',
  status: 'running',
  detail: '',
  kind: 'database',
  icon: Database,
});

const project: OsPanelProject = {
  domain: 'my-shop.test',
  path: 'C:\\OSPanel\\domains\\my-shop',
  php: '8.3',
  type: 'Laravel',
  ssl: true,
};

const renderBackups = (
  notify: Notify,
  { services = [], projects = [] }: { services?: Service[]; projects?: OsPanelProject[] } = {},
) =>
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <Backups notify={notify} services={services} projects={projects} />
    </I18nContext.Provider>,
  );

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listBackups.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('Backups loading', () => {
  it('shows a load error and clears it after a successful retry', async () => {
    mocks.listBackups
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce([configBackup]);
    renderBackups(vi.fn());

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load backups');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Configurations')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Backups list', () => {
  it('renders all three kinds with their subjects, date and size', async () => {
    mocks.listBackups.mockResolvedValue([configBackup, dbBackup, projectBackup]);
    renderBackups(vi.fn());

    expect(await screen.findByText('Configurations')).toBeInTheDocument();
    expect(screen.getByText('Database: MySQL-8.0')).toBeInTheDocument();
    expect(screen.getByText('Project: my-shop.test')).toBeInTheDocument();
    // 1_700_000_000 is 2023-11-14 in any timezone.
    expect(screen.getAllByText(/2023/)).toHaveLength(3);
    expect(screen.getByText('1 file · 1024 B')).toBeInTheDocument();
    expect(screen.getByText('3 files · 4.0 KB')).toBeInTheDocument();
  });

  it('shows the empty note when nothing is saved yet', async () => {
    renderBackups(vi.fn());
    expect(await screen.findByText('No saved backups yet')).toBeInTheDocument();
  });
});

describe('Backups creation', () => {
  it('creates a config copy and refreshes the list', async () => {
    mocks.createBackup.mockResolvedValue(configBackup);
    const notify = vi.fn();
    renderBackups(notify);
    await screen.findByText('No saved backups yet');

    fireEvent.click(screen.getByRole('button', { name: 'Create copy' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Backup created: 1 file'));
    expect(mocks.listBackups).toHaveBeenCalledTimes(2);
  });

  it('reports a failed config copy', async () => {
    mocks.createBackup.mockRejectedValue(new Error('boom'));
    const notify = vi.fn();
    renderBackups(notify);
    await screen.findByText('No saved backups yet');

    fireEvent.click(screen.getByRole('button', { name: 'Create copy' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to create backup'));
  });

  it('creates a dump per module for "All" and a single dump for the chosen module', async () => {
    mocks.createDbBackup.mockImplementation(async (module: string) => ({ ...dbBackup, subject: module }));
    const notify = vi.fn();
    renderBackups(notify, { services: [database('MySQL-8.0'), database('MariaDB-11.4')] });
    await screen.findByRole('combobox', { name: 'Database dumps' });

    // The select defaults to the "All" sentinel: one dump per running module.
    fireEvent.click(screen.getByRole('button', { name: 'Create dump' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Created 2 dumps'));
    expect(mocks.createDbBackup).toHaveBeenNthCalledWith(1, 'MySQL-8.0');
    expect(mocks.createDbBackup).toHaveBeenNthCalledWith(2, 'MariaDB-11.4');

    fireEvent.change(screen.getByRole('combobox', { name: 'Database dumps' }), {
      target: { value: 'MySQL-8.0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create dump' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Database dump saved: MySQL-8.0'));
    expect(mocks.createDbBackup).toHaveBeenCalledTimes(3);
  });

  it('creates a project archive for the chosen domain', async () => {
    mocks.createProjectBackup.mockResolvedValue(projectBackup);
    const notify = vi.fn();
    renderBackups(notify, { projects: [project] });
    await screen.findByRole('combobox', { name: 'Project backups' });

    fireEvent.click(screen.getByRole('button', { name: 'Create archive' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Project archive saved: my-shop.test'));
    expect(mocks.createProjectBackup).toHaveBeenCalledWith('my-shop.test');
  });

  it('disables dumping and archiving without targets', async () => {
    renderBackups(vi.fn());

    expect(await screen.findByText('No running database modules')).toBeInTheDocument();
    expect(screen.getByText('No projects')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create dump' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create archive' })).toBeDisabled();
  });
});

describe('Backups restore', () => {
  it('restores a config copy after confirmation', async () => {
    mocks.listBackups.mockResolvedValue([configBackup]);
    mocks.askConfirm.mockResolvedValue(true);
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Configurations restored'));
    expect(mocks.restoreBackup).toHaveBeenCalledWith('config-123');
    expect(mocks.askConfirm).toHaveBeenCalledWith(expect.stringContaining('2023'), 'Confirmation');
    expect(mocks.listBackups).toHaveBeenCalledTimes(2);
  });

  it('restores a database dump, naming the module in the confirmation', async () => {
    mocks.listBackups.mockResolvedValue([dbBackup]);
    mocks.askConfirm.mockResolvedValue(true);
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Database restored'));
    expect(mocks.restoreDbBackup).toHaveBeenCalledWith('db-mysql');
    expect(mocks.askConfirm).toHaveBeenCalledWith(expect.stringContaining('MySQL-8.0'), 'Confirmation');
  });

  it('restores a project archive', async () => {
    mocks.listBackups.mockResolvedValue([projectBackup]);
    mocks.askConfirm.mockResolvedValue(true);
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Project restored'));
    expect(mocks.restoreProjectBackup).toHaveBeenCalledWith('proj-shop');
  });

  it('keeps the backup when the confirmation is declined', async () => {
    mocks.listBackups.mockResolvedValue([configBackup]);
    mocks.askConfirm.mockResolvedValue(false);
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await vi.waitFor(() => expect(mocks.askConfirm).toHaveBeenCalled());
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('reports a failed restore', async () => {
    mocks.listBackups.mockResolvedValue([configBackup]);
    mocks.askConfirm.mockResolvedValue(true);
    mocks.restoreBackup.mockRejectedValue(new Error('boom'));
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to restore backup'));
  });
});

describe('Backups delete and folder', () => {
  it('deletes a backup after confirmation and refreshes', async () => {
    mocks.listBackups.mockResolvedValue([configBackup]);
    mocks.askConfirm.mockResolvedValue(true);
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Backup deleted'));
    expect(mocks.deleteBackup).toHaveBeenCalledWith('config-123');
    expect(mocks.askConfirm).toHaveBeenCalledWith(
      expect.stringContaining('cannot be undone'),
      'Confirmation',
    );
    expect(mocks.listBackups).toHaveBeenCalledTimes(2);
  });

  it('reports a failed delete', async () => {
    mocks.listBackups.mockResolvedValue([configBackup]);
    mocks.askConfirm.mockResolvedValue(true);
    mocks.deleteBackup.mockRejectedValue(new Error('boom'));
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Failed to delete backup'));
  });

  it('opens the backups folder silently on success', async () => {
    mocks.listBackups.mockResolvedValue([configBackup]);
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder' }));

    await vi.waitFor(() => expect(mocks.openBackupsFolder).toHaveBeenCalled());
    expect(notify).not.toHaveBeenCalled();
  });

  it('reports a failed folder open with a localized error', async () => {
    mocks.listBackups.mockResolvedValue([configBackup]);
    mocks.openBackupsFolder.mockRejectedValue(new Error('err.desktopOnly'));
    const notify = vi.fn();
    renderBackups(notify);

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder' }));

    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith('This action is available in the desktop app only'),
    );
  });
});
