import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { errorText, useI18n } from './i18n';
import {
  checkModuleUpdates,
  installModuleUpdate,
  isDesktopApp,
  type ModuleUpdate,
  recoverModuleUpdate,
} from './ospanel';
import { settingsStorage } from './settingsStorage';

let events: Promise<typeof import('@tauri-apps/api/event')> | undefined;

type UpdateContext = {
  updates: ModuleUpdate[];
  checking: boolean;
  busy: boolean;
  active: Record<string, string>;
  versions: Record<string, string>;
  results: Record<string, string>;
  message: string;
  check: (force?: boolean) => Promise<void>;
  install: (name: string, recover?: boolean) => Promise<void>;
  reset: () => void;
};
const Context = createContext<UpdateContext>({
  updates: [],
  checking: false,
  busy: false,
  active: {},
  versions: {},
  results: {},
  message: '',
  check: async () => {},
  install: async () => {},
  reset: () => {},
});
export const useModuleUpdates = () => useContext(Context);

export function ModuleUpdatesProvider({
  children,
  refresh,
  blocked,
  onBusy,
}: {
  children: ReactNode;
  refresh: () => Promise<boolean>;
  blocked: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [updates, setUpdates] = useState<ModuleUpdate[]>([]);
  const [checking, setChecking] = useState(false);
  const [active, setActive] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const locks = useRef(new Set<string>());
  const checkLock = useRef(false);
  const generation = useRef(0);
  const reset = useCallback(() => {
    if (locks.current.size > 0) return;
    generation.current++;
    setUpdates([]);
    setVersions({});
    setResults({});
    setMessage('');
  }, []);
  const check = useCallback(
    async (force = true) => {
      if (checkLock.current || locks.current.size > 0) return;
      checkLock.current = true;
      setChecking(true);
      setMessage('');
      setResults({});
      const request = ++generation.current;
      try {
        const result = await checkModuleUpdates(force);
        if (request === generation.current) {
          setUpdates(result);
        }
      } catch (error) {
        if (request === generation.current) setMessage(errorText(t, error, 'updates.failed'));
      } finally {
        checkLock.current = false;
        setChecking(false);
      }
    },
    [t],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: startup check runs once per mount
  useEffect(() => {
    if (settingsStorage.getItem('ospanel.checkServiceUpdates') !== '1' || !isDesktopApp()) return;
    void check(false);
  }, []);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const install = async (name: string, recover = false) => {
    if (locks.current.has(name) || blockedRef.current || checkLock.current) return;
    const update = updates.find((item) => item.name === name);
    const web = ['Apache', 'Nginx', 'Caddy'];
    if (web.includes(name) && [...locks.current].some((name) => web.includes(name))) return;
    if (
      !update ||
      (recover ? !update.recovery : !update.available || !update.expected || update.error || update.recovery)
    )
      return;
    locks.current.add(name);
    if (locks.current.size === 1) onBusy(true);
    setActive((current) => ({ ...current, [name]: 'preparing' }));
    setResults((current) => ({ ...current, [name]: '' }));
    const path = settingsStorage.getItem('ospanel.path');
    let unlisten: (() => void) | undefined;
    try {
      if (isDesktopApp()) {
        events ??= import('@tauri-apps/api/event');
        const { listen } = await events;
        unlisten = await listen<{
          name: string;
          phase: string;
          actualVersion?: string;
          declaredVersion?: string;
        }>('module-update-progress', ({ payload }) => {
          if (payload.name === name) {
            setActive((current) => ({ ...current, [name]: payload.phase }));
            if (payload.actualVersion && payload.declaredVersion) {
              const version = payload.actualVersion;
              setUpdates((current) =>
                current.map((item) => (item.name === name ? { ...item, available: version } : item)),
              );
              setResults((current) => ({
                ...current,
                [name]: t('updates.versionAdjusted', {
                  declared: payload.declaredVersion ?? '',
                  actual: version,
                }),
              }));
            }
            if (['backup', 'verify', 'rollback'].includes(payload.phase)) void refresh().catch(() => {});
          }
        });
      }
      const version = recover
        ? await recoverModuleUpdate(name, path)
        : await installModuleUpdate(name, update.expected ?? '', path);
      // The panel API can cache module.ini. Keep the verified version until the path changes.
      setVersions((current) => ({ ...current, [name]: version }));
      setUpdates((current) =>
        current.map((item) =>
          item.name === name
            ? {
                ...item,
                installed: version,
                available: recover && version !== item.available ? item.available : null,
                expected: recover && version !== item.available ? item.expected : null,
                error: null,
                errorParams: undefined,
                recovery: false,
              }
            : item,
        ),
      );
      setResults((current) => ({
        ...current,
        [name]: t(recover ? 'updates.recovered' : name === 'Caddy' ? 'updates.doneVersion' : 'updates.done', {
          name,
          version,
        }),
      }));
    } catch (error) {
      setResults((current) => ({ ...current, [name]: errorText(t, error, 'updates.failed') }));
      if (error instanceof Error && ['err.updateRollback', 'err.updateRecovery'].includes(error.message)) {
        setUpdates((current) =>
          current.map((item) => (item.name === name ? { ...item, recovery: true } : item)),
        );
      }
    } finally {
      unlisten?.();
      locks.current.delete(name);
      setActive((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      if (locks.current.size === 0) onBusy(false);
      await refresh().catch(() => false);
    }
  };
  return (
    <Context.Provider
      value={{
        updates,
        checking,
        busy: Object.keys(active).length > 0,
        active,
        versions,
        results,
        message,
        check,
        install,
        reset,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function ModuleUpdateAction({ name, disabled = false }: { name: string; disabled?: boolean }) {
  const { t } = useI18n();
  const { updates, active, results, checking, install } = useModuleUpdates();
  const update = updates.find((item) => item.name === name);
  const phase = active[name];
  const result = results[name];
  const failure =
    update?.error && update.error !== 'err.phpUnsupported'
      ? errorText(t, Object.assign(new Error(update.error), { params: update.errorParams }), 'updates.failed')
      : '';
  const web = ['Apache', 'Nginx', 'Caddy'];
  const webBusy = web.includes(name) && Object.keys(active).some((name) => web.includes(name));
  if (!update || (!phase && !result && !update.recovery && !failure && !update.available)) return null;
  return (
    <div className="module-update-action">
      {phase ? (
        <span role="status">
          {t(`updates.phase.${phase}`)}
          {result ? ` ${result}` : ''}
        </span>
      ) : update.recovery ? (
        <>
          <span role={result ? 'status' : undefined}>{result || t('updates.interrupted')}</span>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || checking || webBusy}
            onClick={() => void install(name, true)}
          >
            {t('updates.recover')}
          </button>
        </>
      ) : update.available && !update.error ? (
        <>
          <span role={result ? 'status' : undefined}>
            {result || t('updates.available', { version: update.available })}
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || checking || webBusy || !update.expected}
            onClick={() => void install(name)}
          >
            {t('updates.install')}
          </button>
        </>
      ) : (
        <span role="status">{result || failure}</span>
      )}
    </div>
  );
}

export function ModuleUpdateToolbar() {
  const { t } = useI18n();
  const { check, checking, busy, message } = useModuleUpdates();
  return (
    <div className="notice module-update-toolbar">
      <div>
        <b>{t('updates.title')}</b>
        <span>{t('updates.description')}</span>
        {message && <span role="status">{message}</span>}
      </div>
      <button
        type="button"
        className="secondary-button"
        disabled={checking || busy}
        onClick={() => void check()}
      >
        {t(checking ? 'updates.checking' : 'updates.check')}
      </button>
    </div>
  );
}
