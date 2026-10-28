import { settingsStorage } from './settingsStorage';
import './appUpdates.css';
import { Download, RefreshCw, X } from 'lucide-react';
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { version } from '../package.json';
import { formatSize, useDismiss } from './components/shared';
import { errorText, useI18n } from './i18n';
import {
  type AppUpdate,
  type AppUpdateProgress,
  appUpdateStartup,
  checkAppUpdate,
  installAppUpdate,
  isDesktopApp,
} from './ospanel';

// Load the Markdown and GFM parsers only when a release description is displayed.
const ReleaseNotes = lazy(() =>
  import('./components/widgets/ReleaseNotes').then((module) => ({ default: module.ReleaseNotes })),
);

const Context = createContext({ open: () => {} });
export const useAppUpdates = () => useContext(Context);

export function AppUpdatesProvider({
  children,
  blocked,
  onBusy,
}: {
  children: ReactNode;
  blocked: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const lock = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const check = useCallback(
    async (manual = true) => {
      if (lock.current) return;
      lock.current = true;
      setChecking(true);
      setMessage('');
      try {
        const next = await checkAppUpdate();
        setUpdate(next);
        setChecked(true);
        setNotice(Boolean(next));
      } catch (error) {
        if (manual) setMessage(errorText(t, error, 'appUpdates.failed'));
      } finally {
        lock.current = false;
        setChecking(false);
      }
    },
    [t],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: startup work runs once, not on language changes
  useEffect(() => {
    if (!isDesktopApp()) return;
    let mounted = true;
    void appUpdateStartup()
      .then(async (result) => {
        if (!result && settingsStorage.getItem('ospanel.checkAppUpdates') === '1') void check(false);
        if (mounted && result) {
          setMessage(t(`appUpdates.${result}`));
          setVisible(true);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  const install = async () => {
    if (!update || lock.current || blockedRef.current) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setMessage('');
    setProgress({ phase: 'prepare', received: 0, total: update.size });
    try {
      await installAppUpdate(update.version, setProgress);
      // The native command exits the application after a confirmed handoff, never a simulated success.
    } catch (error) {
      setMessage(errorText(t, error, 'appUpdates.failed'));
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
      setProgress(null);
    }
  };
  const open = () => {
    setVisible(true);
    setNotice(false);
    if (!checked && !message) void check();
  };
  return (
    <Context.Provider value={{ open }}>
      {children}
      {notice && update && !visible && (
        <div className="app-update-notice" role="status">
          <Download size={20} />
          <div>
            <b>{t('appUpdates.available', { version: update.version })}</b>
            <span>{t('appUpdates.notice')}</span>
          </div>
          <button type="button" className="secondary-button" onClick={open}>
            {t('appUpdates.details')}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('common.close')}
            onClick={() => setNotice(false)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {visible && (
        <UpdateDialog
          update={update}
          busy={busy}
          checking={checking}
          checked={checked}
          blocked={blocked}
          message={message}
          progress={progress}
          onClose={() => setVisible(false)}
          onCheck={() => void check()}
          onInstall={() => void install()}
          onLinkError={(error) => setMessage(errorText(t, error, 'projects.toastOpenFailed'))}
        />
      )}
    </Context.Provider>
  );
}

function UpdateDialog({
  update,
  busy,
  checking,
  checked,
  blocked,
  message,
  progress,
  onClose,
  onCheck,
  onInstall,
  onLinkError,
}: {
  update: AppUpdate | null;
  busy: boolean;
  checking: boolean;
  checked: boolean;
  blocked: boolean;
  message: string;
  progress: AppUpdateProgress | null;
  onClose: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onLinkError: (error: unknown) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, !busy);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const percent = progress?.total ? Math.min(100, Math.floor((progress.received / progress.total) * 100)) : 0;
  return (
    <div className="modal-overlay">
      <div
        className="modal-window app-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('appUpdates.title')}
        ref={ref}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
          if (!nodes?.length) {
            event.preventDefault();
            return;
          }
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === ref.current)
          ) {
            event.preventDefault();
            last.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === ref.current)
          ) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">OSP Control</span>
            <h3 className="modal-title">{t('appUpdates.title')}</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>
        <div className="app-update-versions">
          <span>
            {t('appUpdates.installed')}
            <b>v{version}</b>
          </span>
          <span>
            {t('appUpdates.newVersion')}
            <b>{update ? `v${update.version}` : '—'}</b>
          </span>
        </div>
        {update ? (
          <>
            <p className="modal-hint">{t('appUpdates.archive', { size: formatSize(update.size) })}</p>
            <h4>{t('appUpdates.notes')}</h4>
            <div className="app-update-notes">
              {update.notes.trim() ? (
                <Suspense fallback={<span role="status">{t('common.loading')}</span>}>
                  <ReleaseNotes notes={update.notes} onLinkError={onLinkError} />
                </Suspense>
              ) : (
                t('appUpdates.noNotes')
              )}
            </div>
          </>
        ) : (
          <p className="modal-hint">{t(checked ? 'appUpdates.current' : 'appUpdates.checkHint')}</p>
        )}
        <p className="modal-hint">{t('appUpdates.preserve')}</p>
        {busy && progress && (
          <div role="status">
            <b>{t(`appUpdates.phase.${progress.phase}`)}</b>
            <progress max={100} value={percent} aria-label={t('appUpdates.progress')} />
            <span>
              {formatSize(progress.received)} / {formatSize(progress.total)}
            </span>
          </div>
        )}
        {message && (
          <p className="notice" role="alert">
            {message}
          </p>
        )}
        {blocked && !busy && (
          <p className="modal-hint" role="status">
            {t('appUpdates.blocked')}
          </p>
        )}
        <div className="modal-foot">
          <button type="button" className="secondary-button" disabled={checking || busy} onClick={onCheck}>
            <RefreshCw size={14} />
            {t(checking ? 'appUpdates.checking' : 'appUpdates.check')}
          </button>
          {update && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || checking || blocked}
              onClick={onInstall}
            >
              <Download size={14} />
              {t('appUpdates.install')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AppUpdateButton() {
  const { t } = useI18n();
  const { open } = useAppUpdates();
  return (
    <button
      type="button"
      className="icon-button brand-update"
      aria-label={t('appUpdates.check')}
      title={t('appUpdates.check')}
      onClick={open}
    >
      <RefreshCw size={16} />
    </button>
  );
}

export function AppUpdateSettings() {
  const { t } = useI18n();
  const [automatic, setAutomatic] = useState(
    () => settingsStorage.getItem('ospanel.checkAppUpdates') === '1',
  );
  return (
    <div className="setting-block">
      <div>
        <h3>{t('appUpdates.startup')}</h3>
        <p>{t('appUpdates.startupHint')}</p>
      </div>
      <button
        type="button"
        className={`large-toggle ${automatic ? 'on' : ''}`}
        aria-label={t('appUpdates.startup')}
        aria-pressed={automatic}
        onClick={() => {
          const next = !automatic;
          setAutomatic(next);
          settingsStorage.setItem('ospanel.checkAppUpdates', next ? '1' : '0');
        }}
      >
        <span />
      </button>
    </div>
  );
}
