import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDbBackup,
  createProject,
  createProjectBackup,
  deleteBackup,
  deleteProject,
  discoverOsPanel,
  fetchOverviewMetrics,
  filterProjects,
  getProjectSettings,
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
  restartOsPanel,
  restoreBackup,
  restoreDbBackup,
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

    persistOsPanelPath('D:\\OSPanel6');
    const custom = await discoverOsPanel();
    expect(custom.path).toBe('D:\\OSPanel6');
  });

  it('panelOnline reports the panel as running in the mock', async () => {
    expect(await panelOnline()).toBe(true);
  });

  it('refreshService toggles status; an unknown service rejects with err.serviceNotFound', async () => {
    expect((await refreshService('Apache', 'stop')).status).toBe('stopped');
    expect((await refreshService('Apache', 'start')).status).toBe('running');
    await expect(refreshService('Nope', 'restart')).rejects.toThrow('err.serviceNotFound');
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
    await expect(getProjectSettings('dune.loc')).resolves.toEqual({
      domain: 'dune.loc',
      httpEngine: 'Apache',
      phpEngine: 'PHP-8.3',
      nodeEngine: 'auto',
      tlsEnabled: 'off',
      fileExists: true,
    });
  });

  it('createBackup mocks return entries tagged with their kind', async () => {
    expect(await createDbBackup('MySQL-8.0')).toMatchObject({ kind: 'db', subject: 'MySQL-8.0' });
    expect(await createProjectBackup('dune.loc')).toMatchObject({
      kind: 'project',
      subject: 'dune.loc',
    });
  });

  it('desktop-only commands reject with err.desktopOnly outside Tauri', async () => {
    await expect(openProjectFolder('C:\\x')).rejects.toThrow('err.desktopOnly');
    await expect(openFileExternally('C:\\x.log')).rejects.toThrow('err.desktopOnly');
    await expect(restoreBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(restoreDbBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(restoreProjectBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(deleteBackup('id')).rejects.toThrow('err.desktopOnly');
    await expect(setAutostart(true)).rejects.toThrow('err.desktopOnly');
    await expect(setCloseToTray(true, 'ru')).rejects.toThrow('err.desktopOnly');
    await expect(restartOsPanel()).rejects.toThrow('err.desktopOnly');
    await expect(deleteProject('dune.loc')).rejects.toThrow('err.desktopOnly');
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
    persistOsPanelPath('D:\\OSPanel6');
    invokeMock.mockResolvedValueOnce(true);
    await panelOnline();
    expect(invokeMock).toHaveBeenCalledWith('panel_online', { customPath: 'D:\\OSPanel6' });

    invokeMock.mockResolvedValueOnce([]);
    await listLogSources();
    expect(invokeMock).toHaveBeenLastCalledWith('list_log_sources', { customPath: 'D:\\OSPanel6' });

    invokeMock.mockResolvedValueOnce({ id: 'backup-1-db-MySQL-8.0' });
    await createDbBackup('MySQL-8.0');
    expect(invokeMock).toHaveBeenLastCalledWith('create_db_backup', {
      module: 'MySQL-8.0',
      customPath: 'D:\\OSPanel6',
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await restoreProjectBackup('backup-1-proj-dune.loc');
    expect(invokeMock).toHaveBeenLastCalledWith('restore_project_backup', {
      id: 'backup-1-proj-dune.loc',
      customPath: 'D:\\OSPanel6',
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await openBackupsFolder();
    expect(invokeMock).toHaveBeenLastCalledWith('open_backups_folder', {
      customPath: 'D:\\OSPanel6',
    });
  });
});

describe('filterProjects', () => {
  const list = [
    {
      domain: 'api.local',
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
