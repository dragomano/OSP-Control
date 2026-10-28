import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const desktop = () => Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
const browser = () => Reflect.deleteProperty(window, '__TAURI_INTERNALS__');

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  localStorage.clear();
  browser();
});
afterEach(browser);

describe('portable settings bridge', () => {
  it('keeps browser preferences in localStorage without calling native commands', async () => {
    const { initializeSettings, settingsStorage } = await import('../src/settingsStorage');
    await initializeSettings();
    settingsStorage.setItem('ospanel.theme', 'light');
    expect(settingsStorage.getItem('ospanel.theme')).toBe('light');
    expect(localStorage.getItem('ospanel.theme')).toBe('light');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('hydrates native values before UI reads and ignores stale localStorage', async () => {
    desktop();
    localStorage.setItem('ospanel.theme', 'light');
    localStorage.setItem('unrelated', 'keep');
    invoke.mockResolvedValue({ values: { 'ospanel.theme': 'dark' }, migrationNeeded: false });
    const { initializeSettings, settingsStorage } = await import('../src/settingsStorage');
    await initializeSettings();
    expect(settingsStorage.getItem('ospanel.theme')).toBe('dark');
    expect(localStorage.getItem('ospanel.theme')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep');
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['load_settings']);
  });

  it('migrates preferences, menu state and project tags together, leaving demo data alone', async () => {
    desktop();
    const tags = '{"version":1,"projects":{"api.test":["Client"]}}';
    localStorage.setItem('ospanel.lang', 'ru');
    localStorage.setItem('ospanel.projectTags.v1:d:/ospanel6', tags);
    localStorage.setItem('ospanel.menuTree.d:/ospanel6', '["Development"]');
    localStorage.setItem('ospanel.demoMenu', '{}');
    invoke
      .mockResolvedValueOnce({ values: {}, migrationNeeded: true })
      .mockImplementationOnce(async (_name, { legacy }) => ({ values: legacy, migrationNeeded: false }));
    const { initializeSettings, settingsStorage } = await import('../src/settingsStorage');
    await initializeSettings();
    expect(invoke).toHaveBeenLastCalledWith('migrate_settings', {
      legacy: {
        'ospanel.lang': 'ru',
        'ospanel.projectTags.v1:d:/ospanel6': tags,
        'ospanel.menuTree.d:/ospanel6': '["Development"]',
      },
    });
    expect(settingsStorage.getItem('ospanel.projectTags.v1:d:/ospanel6')).toBe(tags);
    expect(localStorage.getItem('ospanel.lang')).toBeNull();
    expect(localStorage.getItem('ospanel.demoMenu')).toBe('{}');
  });

  it('retains migration sources on a write failure and retries migration before pending changes', async () => {
    desktop();
    localStorage.setItem('ospanel.lang', 'ru');
    invoke
      .mockResolvedValueOnce({ values: {}, migrationNeeded: true })
      .mockRejectedValueOnce({ code: 'err.settingsSaveFailed', params: { path: 'settings.toml' } });
    const { initializeSettings, settingsStorage, settingsFailure, flushSettings } = await import(
      '../src/settingsStorage'
    );
    await initializeSettings();
    expect(localStorage.getItem('ospanel.lang')).toBe('ru');
    expect(settingsFailure()?.message).toBe('err.settingsSaveFailed');
    settingsStorage.setItem('ospanel.theme', 'light');
    invoke
      .mockResolvedValueOnce({ values: {}, migrationNeeded: true })
      .mockResolvedValueOnce({ values: { 'ospanel.lang': 'ru' }, migrationNeeded: false })
      .mockResolvedValueOnce({
        values: { 'ospanel.lang': 'ru', 'ospanel.theme': 'light' },
        migrationNeeded: false,
      });
    expect(await flushSettings()).toBe(true);
    expect(settingsFailure()).toBeNull();
    expect(settingsStorage.getItem('ospanel.lang')).toBe('ru');
    expect(settingsStorage.getItem('ospanel.theme')).toBe('light');
    expect(localStorage.getItem('ospanel.lang')).toBeNull();
  });

  it('serializes rapid edits and preserves a newer edit while an earlier write is in flight', async () => {
    desktop();
    invoke.mockResolvedValueOnce({ values: {}, migrationNeeded: false });
    const { initializeSettings, settingsStorage, flushSettings } = await import('../src/settingsStorage');
    await initializeSettings();
    let finish: ((snapshot: unknown) => void) | undefined;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    settingsStorage.setItem('ospanel.theme', 'dark');
    await vi.waitFor(() => expect(finish).toBeDefined());
    settingsStorage.setItem('ospanel.theme', 'light');
    settingsStorage.setItem('ospanel.lang', 'uk');
    invoke.mockResolvedValueOnce({
      values: { 'ospanel.theme': 'light', 'ospanel.lang': 'uk' },
      migrationNeeded: false,
    });
    finish?.({ values: { 'ospanel.theme': 'dark' }, migrationNeeded: false });
    expect(await flushSettings()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('save_settings', {
      updates: { 'ospanel.theme': 'light', 'ospanel.lang': 'uk' },
    });
    expect(settingsStorage.getItem('ospanel.theme')).toBe('light');
    expect(localStorage.getItem('ospanel.theme')).toBeNull();
  });

  it('reports malformed TOML and retries only after explicit action', async () => {
    desktop();
    invoke.mockRejectedValueOnce({ code: 'err.settingsInvalid', params: { path: 'settings.toml' } });
    const { initializeSettings, settingsStorage, settingsFailure, flushSettings } = await import(
      '../src/settingsStorage'
    );
    await initializeSettings();
    settingsStorage.setItem('ospanel.scale', '110');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(settingsFailure()?.params?.path).toBe('settings.toml');
    invoke.mockResolvedValue({ values: { 'ospanel.scale': '110' }, migrationNeeded: false });
    expect(await flushSettings()).toBe(true);
    expect(settingsFailure()).toBeNull();
  });

  it('keeps edits made while an explicit retry is reloading a repaired file', async () => {
    desktop();
    invoke.mockRejectedValueOnce({ code: 'err.settingsInvalid' });
    const { initializeSettings, settingsStorage, flushSettings } = await import('../src/settingsStorage');
    await initializeSettings();
    let finish: ((snapshot: unknown) => void) | undefined;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const retry = flushSettings();
    await vi.waitFor(() => expect(finish).toBeDefined());
    settingsStorage.setItem('ospanel.theme', 'light');
    invoke.mockResolvedValueOnce({
      values: { 'ospanel.lang': 'en', 'ospanel.theme': 'light' },
      migrationNeeded: false,
    });
    finish?.({ values: { 'ospanel.lang': 'en' }, migrationNeeded: false });
    expect(await retry).toBe(true);
    expect(settingsStorage.getItem('ospanel.theme')).toBe('light');
    expect(invoke).toHaveBeenLastCalledWith('save_settings', { updates: { 'ospanel.theme': 'light' } });
  });
});
