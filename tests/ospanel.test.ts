import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateModuleProfile,
  clearLogs,
  createDbBackup,
  createMenuBackup,
  createModuleProfile,
  createProject,
  createProjectBackup,
  deleteBackup,
  deleteModuleProfile,
  deleteProject,
  discoverOsPanel,
  fetchOverviewMetrics,
  filterProjects,
  getProjectSettings,
  getUserInfo,
  isEngineUnset,
  listLogSources,
  openBackupsFolder,
  openFileExternally,
  openInBrowser,
  openInEditor,
  openProjectFolder,
  panelOnline,
  persistOsPanelPath,
  refreshService,
  renameProject,
  restartOsPanel,
  restoreBackup,
  restoreDbBackup,
  restoreMenuBackup,
  restoreProjectBackup,
  setAutostart,
  setCloseToTray,
  waitForPanelReady,
} from '../src/ospanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const tauriFlag = () => window as { __TAURI_INTERNALS__?: unknown };

describe('adapter in browser mode (mocks, no Tauri)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'open').mockReturnValue({} as Window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a project in a new browser window', async () => {
    const open = vi.mocked(window.open);

    await expect(openInBrowser('https://my-shop.test')).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith('https://my-shop.test', '_blank', 'noopener');
  });

  it('reports when the browser blocks the project popup', async () => {
    vi.mocked(window.open).mockReturnValueOnce(null);

    await expect(openInBrowser('https://my-shop.test')).rejects.toThrow('err.popupBlocked');
  });

  it('discoverOsPanel returns the mock snapshot and applies the custom path', async () => {
    const snap = await discoverOsPanel();
    expect(snap.source).toBe('mock');
    expect(snap.path).toBe('C:\\OSPanel');
    expect(snap.services.length).toBeGreaterThan(0);

    persistOsPanelPath('X:\\TestPanel');
    const custom = await discoverOsPanel();
    expect(custom.path).toBe('X:\\TestPanel');
  });

  it('panelOnline reports the panel as running in the mock', async () => {
    expect(await panelOnline()).toBe(true);
  });

  it('does not pretend to clear real logs outside the desktop app', async () => {
    await expect(clearLogs('general.log')).rejects.toThrow('err.desktopOnly');
    await expect(clearLogs(null)).rejects.toThrow('err.desktopOnly');
  });

  it('refreshService toggles status; an unknown service rejects with err.serviceNotFound', async () => {
    expect((await refreshService('Apache', 'stop')).status).toBe('stopped');
    expect((await refreshService('Apache', 'start')).status).toBe('running');
    await expect(refreshService('Nope', 'restart')).rejects.toThrow('err.serviceNotFound');
  });
  it('returns the active profile after activation and preserves it through service actions', async () => {
    const name = 'Apache',
      profile = 'profile-label-test';
    await createModuleProfile(name, profile, 'default', false, false);
    try {
      expect((await discoverOsPanel()).services.find((service) => service.name === name)?.profile).toBe(
        'default',
      );
      await activateModuleProfile(name, profile);
      expect((await discoverOsPanel()).services.find((service) => service.name === name)?.profile).toBe(
        profile,
      );
      expect((await refreshService(name, 'stop')).profile).toBe(profile);
    } finally {
      await activateModuleProfile(name, 'default');
      await deleteModuleProfile(name, profile);
    }
  });

  it('fetchOverviewMetrics computes metrics from the mock snapshot', async () => {
    const metrics = await fetchOverviewMetrics();
    expect(metrics.servicesRunning).toBe(4);
    expect(metrics.servicesTotal).toBe(7);
  });

  it('createProject returns the created domain data', async () => {
    const created = await createProject({ domain: 'foo.test', phpEngine: 'PHP-8.1' });
    expect(created.domain).toBe('foo.test');
    expect(created.php).toBe('8.1');
    expect(created.http).toBe('auto');
    expect(created.path).toContain('foo.test');
  });

  it('getProjectSettings returns defaults outside Tauri', async () => {
    await expect(getProjectSettings('example.test')).resolves.toEqual({
      domain: 'example.test',
      httpEngine: 'Apache',
      phpEngine: 'PHP-8.3',
      nodeEngine: 'auto',
      tlsEnabled: 'off',
      fileExists: true,
    });
  });

  it('uses punycode for the created project and folder in browser mode', async () => {
    await expect(createProject({ domain: ' café.test ' })).resolves.toMatchObject({
      domain: 'xn--caf-dma.test',
      path: 'C:\\OSPanel\\home\\xn--caf-dma.test',
    });
    await expect(createProject({ domain: 'xn--.test' })).rejects.toThrow('err.invalidDomain');
  });

  it('uses a synthetic identity in the browser demo', async () => {
    await expect(getUserInfo()).resolves.toEqual({ name: 'Demo User' });
  });

  it('createBackup mocks return entries tagged with their kind', async () => {
    expect(await createDbBackup('MySQL-8.0')).toMatchObject({ kind: 'db', subject: 'MySQL-8.0' });
    expect(await createProjectBackup('example.test')).toMatchObject({
      kind: 'project',
      subject: 'example.test',
    });
  });

  it('desktop-only commands reject with err.desktopOnly outside Tauri', async () => {
    const { startOsPanel } = await import('../src/ospanel');
    await expect(startOsPanel()).rejects.toThrow('err.desktopOnly');
    await expect(openProjectFolder('C:\\x')).rejects.toThrow('err.desktopOnly');
    await expect(openFileExternally('C:\\x.log')).rejects.toThrow('err.desktopOnly');
    await expect(restoreBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(restoreDbBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(restoreProjectBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(deleteBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(setAutostart(true)).rejects.toThrow('err.desktopOnly');
    await expect(setCloseToTray(true, 'ru')).rejects.toThrow('err.desktopOnly');
    await expect(restartOsPanel()).rejects.toThrow('err.desktopOnly');
    await expect(deleteProject('example.test')).rejects.toThrow('err.desktopOnly');
    await expect(openInEditor('vscode', 'C:\\x')).rejects.toThrow('err.desktopOnly');
    await expect(openBackupsFolder()).rejects.toThrow('err.desktopOnly');
  });
});

describe('waitForPanelReady (probe and sleep injected)', () => {
  const noSleep = async () => {};

  it('resolves as soon as the probe answers true', async () => {
    let calls = 0;
    const ready = await waitForPanelReady({
      probe: () => {
        calls += 1;
        return Promise.resolve(calls >= 3);
      },
      sleep: noSleep,
      timeoutMs: 10_000,
      pollMs: 1,
    });
    expect(ready).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up with false after the timeout', async () => {
    const ready = await waitForPanelReady({
      probe: () => Promise.resolve(false),
      sleep: noSleep,
      timeoutMs: 5,
      pollMs: 1,
    });
    expect(ready).toBe(false);
  });

  it('a rejected probe counts as not ready, not as a crash', async () => {
    const ready = await waitForPanelReady({
      probe: () => Promise.reject(new Error('down')),
      sleep: noSleep,
      timeoutMs: 3,
      pollMs: 1,
    });
    expect(ready).toBe(false);
  });
});

describe('adapter in Tauri mode (invoke mocked)', () => {
  beforeEach(() => {
    localStorage.clear();
    tauriFlag().__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete tauriFlag().__TAURI_INTERNALS__;
    invokeMock.mockReset();
  });

  it.each(['Example User', 'Another User'])(
    'uses the desktop identity returned by the backend: %s',
    async (name) => {
      invokeMock.mockResolvedValueOnce({ name });
      await expect(getUserInfo()).resolves.toEqual({ name });
      expect(invokeMock).toHaveBeenLastCalledWith('get_user_info', undefined);
    },
  );

  it('a { code, params } command error becomes an Error with an err.* key and params', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'err.customPathMissing', params: { path: 'X' } });
    await expect(discoverOsPanel()).rejects.toMatchObject({
      message: 'err.customPathMissing',
      params: { path: 'X' },
    });
  });

  it('other rejections are wrapped into Error(String)', async () => {
    invokeMock.mockRejectedValueOnce('boom');
    await expect(discoverOsPanel()).rejects.toThrow('boom');
  });

  it('the custom path from localStorage is passed to commands', async () => {
    persistOsPanelPath('X:\\TestPanel');
    invokeMock.mockResolvedValueOnce(true);
    await panelOnline();
    expect(invokeMock).toHaveBeenCalledWith('panel_online', { customPath: 'X:\\TestPanel' });

    invokeMock.mockResolvedValueOnce([]);
    await listLogSources();
    expect(invokeMock).toHaveBeenLastCalledWith('list_log_sources', { customPath: 'X:\\TestPanel' });

    const project = {
      domain: 'old.test',
      path: 'X:\\TestPanel\\home\\old.test',
      php: '8.3',
      type: 'Apache',
      ssl: true,
    };
    const renamed = { domain: 'new.test', path: 'X:\\TestPanel\\home\\new.test' };
    invokeMock.mockResolvedValueOnce(renamed);
    await expect(renameProject(project, 'new.test')).resolves.toEqual(renamed);
    expect(invokeMock).toHaveBeenLastCalledWith('rename_project', {
      domain: 'old.test',
      newDomain: 'new.test',
      path: project.path,
      customPath: 'X:\\TestPanel',
    });

    invokeMock.mockResolvedValueOnce(1);
    await clearLogs('domains/example.test_error.log');
    expect(invokeMock).toHaveBeenLastCalledWith('clear_logs', {
      source: 'domains/example.test_error.log',
      customPath: 'X:\\TestPanel',
    });
    invokeMock.mockResolvedValueOnce(3);
    await clearLogs(null);
    expect(invokeMock).toHaveBeenLastCalledWith('clear_logs', {
      source: null,
      customPath: 'X:\\TestPanel',
    });

    invokeMock.mockResolvedValueOnce({ id: 'backup-1-db-MySQL-8.0' });
    await createDbBackup('MySQL-8.0');
    expect(invokeMock).toHaveBeenLastCalledWith('create_db_backup', {
      module: 'MySQL-8.0',
      customPath: 'X:\\TestPanel',
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await restoreProjectBackup('backup-1-proj-example.test');
    expect(invokeMock).toHaveBeenLastCalledWith('restore_project_backup', {
      id: 'backup-1-proj-example.test',
      customPath: 'X:\\TestPanel',
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await openBackupsFolder();
    expect(invokeMock).toHaveBeenLastCalledWith('open_backups_folder', {
      customPath: 'X:\\TestPanel',
    });

    invokeMock.mockResolvedValueOnce({ id: 'menu-1700000000000000000', kind: 'menu' });
    await createMenuBackup();
    expect(invokeMock).toHaveBeenLastCalledWith('create_menu_backup', { customPath: 'X:\\TestPanel' });
    await restoreMenuBackup('menu-1700000000000000000');
    expect(invokeMock).toHaveBeenLastCalledWith('restore_menu_backup', {
      id: 'menu-1700000000000000000',
      customPath: 'X:\\TestPanel',
    });
  });

  it('normalizes IDNs before invoking project creation and renaming', async () => {
    invokeMock.mockResolvedValue({});
    await createProject({ domain: 'CAFÉ.test', phpEngine: 'PHP-8.3' });
    expect(invokeMock).toHaveBeenLastCalledWith(
      'create_project',
      expect.objectContaining({
        params: { domain: 'xn--caf-dma.test', phpEngine: 'PHP-8.3' },
      }),
    );
    await renameProject(
      { domain: 'old.test', path: 'X:\\TestPanel\\home\\old.test', php: '-', type: '', ssl: false },
      'cafe\u0301.test',
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      'rename_project',
      expect.objectContaining({
        newDomain: 'xn--caf-dma.test',
      }),
    );
  });
});

describe('filterProjects', () => {
  const list = [
    {
      domain: 'api.test',
      path: 'C:\\OSPanel\\home\\api-backend',
      php: '8.3',
      type: 'Node + PHP',
      ssl: true,
    },
    { domain: 'landing.test', path: 'C:\\OSPanel\\home\\landing', php: '8.2', type: 'Static', ssl: false },
  ];

  it('an empty or blank query returns the list untouched', () => {
    expect(filterProjects(list, '')).toBe(list);
    expect(filterProjects(list, '   ')).toBe(list);
  });

  it('matches the domain case-insensitively', () => {
    expect(filterProjects(list, 'API')).toEqual([list[0]]);
  });

  it('matches a folder name that is absent from the domain', () => {
    expect(filterProjects(list, 'api-backend')).toEqual([list[0]]);
  });

  it('matches a path fragment such as the home directory', () => {
    expect(filterProjects(list, 'home\\land')).toEqual([list[1]]);
  });

  it('returns nothing when neither domain nor path matches', () => {
    expect(filterProjects(list, 'nginx')).toEqual([]);
  });
});

describe('isEngineUnset', () => {
  it('treats the panel placeholder and its typographic variants as unset', () => {
    expect(isEngineUnset('-')).toBe(true);
    expect(isEngineUnset('—')).toBe(true);
    expect(isEngineUnset('–')).toBe(true);
    expect(isEngineUnset('  ')).toBe(true);
  });

  it('keeps real engine names and versions', () => {
    expect(isEngineUnset('8.3')).toBe(false);
    expect(isEngineUnset('Apache')).toBe(false);
  });
});
