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
const migratedKey = (key: string) =>
  keys.has(key) || key.startsWith('ospanel.projectTags.v1:') || key.startsWith('ospanel.menuTree.');
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
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && migratedKey(key)) {
      const value = localStorage.getItem(key);
      if (value !== null) result[key] = value;
    }
  }
  return result;
}
function clearLegacy(values: Record<string, string>) {
  // Never remove source data until the native migration has succeeded.
  try {
    for (const key of Object.keys(legacyValues()))
      if (Object.keys(values).includes(key)) localStorage.removeItem(key);
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
