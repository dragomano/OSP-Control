import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { errorText, useI18n } from './i18n';
import { checkPhpUpdates, installPhpUpdate, isDesktopApp, type PhpUpdate, recoverPhpUpdate } from './ospanel';

let events: Promise<typeof import('@tauri-apps/api/event')> | undefined;

type UpdateContext = {
  updates: PhpUpdate[];
  checking: boolean;
  busy: boolean;
  active: Record<string, string>;
  versions: Record<string, string>;
  results: Record<string, string>;
  message: string;
  check: () => Promise<void>;
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
export const usePhpUpdates = () => useContext(Context);

export function PhpUpdatesProvider({
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
  const [updates, setUpdates] = useState<PhpUpdate[]>([]);
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
  const check = useCallback(async () => {
    if (checkLock.current || locks.current.size > 0) return;
    checkLock.current = true;
    setChecking(true);
    setMessage('');
    setResults({});
    const request = ++generation.current;
    try {
      const result = await checkPhpUpdates();
      if (request === generation.current) {
        setUpdates(result);
        const failure = result.find((item) => item.error && item.error !== 'err.phpUnsupported');
        if (failure?.error) {
          const error = Object.assign(new Error(failure.error), { params: failure.errorParams });
          setMessage(errorText(t, error, 'updates.failed'));
        }
      }
    } catch (error) {
      if (request === generation.current) setMessage(errorText(t, error, 'updates.failed'));
    } finally {
      checkLock.current = false;
      setChecking(false);
    }
  }, [t]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: startup check runs once per mount
  useEffect(() => {
    if (localStorage.getItem('ospanel.checkServiceUpdates') !== '1' || !isDesktopApp()) return;
    void check();
  }, []);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const install = async (name: string, recover = false) => {
    if (locks.current.has(name) || blockedRef.current || checkLock.current) return;
    const update = updates.find((item) => item.name === name);
    if (!update || (recover ? !update.recovery : !update.available || update.recovery)) return;
    locks.current.add(name);
    if (locks.current.size === 1) onBusy(true);
    setActive((current) => ({ ...current, [name]: 'preparing' }));
    setResults((current) => ({ ...current, [name]: '' }));
    const path = localStorage.getItem('ospanel.path');
    let unlisten: (() => void) | undefined;
    try {
      if (isDesktopApp()) {
        events ??= import('@tauri-apps/api/event');
        const { listen } = await events;
        unlisten = await listen<{ name: string; phase: string }>('php-update-progress', ({ payload }) => {
          if (payload.name === name) {
            setActive((current) => ({ ...current, [name]: payload.phase }));
            if (['backup', 'verify', 'rollback'].includes(payload.phase)) void refresh().catch(() => {});
          }
        });
      }
      const version = recover
        ? await recoverPhpUpdate(name, path)
        : await installPhpUpdate(name, update.available ?? '', path);
      // The panel API can cache module.ini. Keep the verified version until the path changes.
      setVersions((current) => ({ ...current, [name]: version }));
      setUpdates((current) =>
        current.map((item) =>
          item.name === name
            ? {
                ...item,
                installed: version,
                available: recover && version !== item.available ? item.available : null,
                error: null,
                errorParams: undefined,
                recovery: false,
              }
            : item,
        ),
      );
      setResults((current) => ({
        ...current,
        [name]: t(recover ? 'updates.recovered' : 'updates.done', { name }),
      }));
    } catch (error) {
      setResults((current) => ({ ...current, [name]: errorText(t, error, 'updates.failed') }));
      if (error instanceof Error && ['err.phpRollback', 'err.phpRecovery'].includes(error.message)) {
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

export function PhpUpdateAction({ name, disabled = false }: { name: string; disabled?: boolean }) {
  const { t } = useI18n();
  const { updates, active, results, checking, install } = usePhpUpdates();
  const update = updates.find((item) => item.name === name);
  const phase = active[name];
  const result = results[name];
  if (!update || (!phase && !result && !update.recovery && (update.error || !update.available))) return null;
  return (
    <div className="php-update-action">
      {phase ? (
        <span role="status">{t(`updates.phase.${phase}`)}</span>
      ) : update.recovery ? (
        <>
          <span role={result ? 'status' : undefined}>{result || t('updates.interrupted')}</span>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || checking}
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
            disabled={disabled || checking}
            onClick={() => void install(name)}
          >
            {t('updates.install')}
          </button>
        </>
      ) : (
        <span role="status">{result}</span>
      )}
    </div>
  );
}

export function PhpUpdateToolbar() {
  const { t } = useI18n();
  const { check, checking, busy, message } = usePhpUpdates();
  return (
    <div className="notice php-update-toolbar">
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
