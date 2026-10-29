// Desktop preferences live in settings.toml; localStorage is only a migration source or browser fallback.
type Snapshot = { values: Record<string, string>; migrationNeeded: boolean };
type SettingsError = Error & { params?: Record<string, string> };
const EVENT = 'ospanel:settings-error';
const keys = new Set([
  'ospanel.lang',
  'ospanel.theme',
  'ospanel.accent',
  'ospanel.font',
  'ospanel.scale',
  'ospanel.sidebar',
  'ospanel.notify',
  'ospanel.autostartProjects',
  'ospanel.path',
  'ospanel.checkAppUpdates',
  'ospanel.checkServiceUpdates',
  'ospanel.closeToTray',
]);
export const MENU_TREE_KEY = 'ospanel.menuTree';
export const PROJECT_TAGS_KEY = 'ospanel.projectTags';
// Earlier releases scoped both keys by the installation path (`ospanel.menuTree.<path>` and
// `ospanel.projectTags.v1:<path>`); the flat names replace them.
const scopedKey = (key: string) => {
  if (key === MENU_TREE_KEY || key.startsWith(`${MENU_TREE_KEY}.`)) return MENU_TREE_KEY;
  if (key === PROJECT_TAGS_KEY || key.startsWith(`${PROJECT_TAGS_KEY}.`)) return PROJECT_TAGS_KEY;
  return key;
};
const scopeSuffix = (path: string | undefined) =>
  path
    ?.trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase() || 'default';
const scopeName = (name: string) => name.replace(/^v1:/, '');
const migratedKey = (key: string) => keys.has(key) || scopedKey(key) !== key;
let desktopValues: Record<string, string> | null = null;
const pending: Record<string, string> = {};
let running: Promise<boolean> | null = null;
let failure: SettingsError | null = null;
let migrationPending = false;

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error)
      throw Object.assign(new Error(String(error.code)), {
        params: 'params' in error ? error.params : undefined,
      });
    throw error instanceof Error ? error : new Error(String(error));
  }
}
function report(error: SettingsError | null) {
  failure = error;
  window.dispatchEvent(new Event(EVENT));
}
function legacyValues(): Record<string, string> {
  const result: Record<string, string> = {};
  const scoped: Record<string, Record<string, string>> = { [MENU_TREE_KEY]: {}, [PROJECT_TAGS_KEY]: {} };
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !migratedKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value === null) continue;
    const flat = scopedKey(key);
    if (flat === key) result[key] = value;
    else scoped[flat][key.slice(flat.length + 1)] = value;
  }
  // The path-scoped sources may hold one entry per installation; the selected one wins.
  const selected = scopeSuffix(result['ospanel.path']);
  for (const [flat, entries] of Object.entries(scoped)) {
    const names = Object.keys(entries).sort();
    const name =
      names.find((item) => scopeName(item) === selected) ??
      names.find((item) => scopeName(item) === 'default') ??
      names[0];
    if (name !== undefined) result[flat] = entries[name];
  }
  return result;
}
function clearLegacy(values: Record<string, string>) {
  // Never remove source data until the native migration has succeeded.
  try {
    const known = Object.keys(values);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && migratedKey(key) && known.includes(scopedKey(key))) localStorage.removeItem(key);
    }
  } catch {
    /* A later launch can retry cleanup. */
  }
}

export async function initializeSettings(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return;
  desktopValues = {};
  try {
    const snapshot = await command<Snapshot>('load_settings');
    desktopValues = snapshot.values;
    if (snapshot.migrationNeeded) {
      migrationPending = true;
      const migrated = await command<Snapshot>('migrate_settings', { legacy: legacyValues() });
      desktopValues = migrated.values;
      migrationPending = false;
    }
    clearLegacy(desktopValues);
    report(null);
  } catch (error) {
    report(error as SettingsError);
  }
}

export const settingsStorage = {
  getItem(key: string): string | null {
    return desktopValues === null ? localStorage.getItem(key) : (desktopValues[key] ?? null);
  },
  setItem(key: string, value: string): void {
    if (desktopValues === null) {
      localStorage.setItem(key, value);
      return;
    }
    if (desktopValues[key] === value) return;
    desktopValues[key] = value;
    pending[key] = value;
    // Queue edits in order. A persistent error banner retains failed edits for an explicit retry.
    if (!failure) void flushSettings();
  },
};

export function settingsFailure(): SettingsError | null {
  return failure;
}
export function subscribeSettingsFailure(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

export function flushSettings(): Promise<boolean> {
  if (running) return running;
  running = Promise.resolve().then(async () => {
    try {
      if (failure) {
        const snapshot = await command<Snapshot>('load_settings');
        desktopValues = { ...snapshot.values, ...pending };
        migrationPending = snapshot.migrationNeeded;
      }
      if (migrationPending) {
        const migrated = await command<Snapshot>('migrate_settings', { legacy: legacyValues() });
        desktopValues = { ...migrated.values, ...pending };
        migrationPending = false;
        clearLegacy(migrated.values);
      }
      while (Object.keys(pending).length) {
        const updates = { ...pending };
        const snapshot = await command<Snapshot>('save_settings', { updates });
        for (const [key, value] of Object.entries(updates)) if (pending[key] === value) delete pending[key];
        desktopValues = { ...snapshot.values, ...pending };
      }
      report(null);
      return true;
    } catch (error) {
      report(error as SettingsError);
      return false;
    } finally {
      running = null;
    }
  });
  return running;
}
