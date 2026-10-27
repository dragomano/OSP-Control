import { Box, Copy, Database, ListTree, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText, localeTag, useI18n } from '../../i18n';
import {
  askConfirm,
  type BackupEntry,
  type BackupKind,
  createBackup,
  createDbBackup,
  createMenuBackup,
  createProjectBackup,
  deleteBackup,
  listBackups,
  type OsPanelProject,
  openBackupsFolder,
  restoreBackup,
  restoreDbBackup,
  restoreMenuBackup,
  restoreProjectBackup,
} from '../../ospanel';
import { formatSize, type Notify, type Service } from '../shared';
import { PageHeader } from '../widgets/PageHeader';

// "All" sentinel for the backup subject selects: '*' can never collide with a module or domain name.
const ALL_TARGETS = '*';
export type BackupFilter = BackupKind | 'all';
const FILTER_KEYS = {
  all: 'settings.backupsAll',
  config: 'backups.filterConfig',
  db: 'backups.filterDb',
  project: 'backups.filterProject',
  menu: 'settings.backupsKindMenu',
} satisfies Record<BackupFilter, string>;

// Per-kind wording and action of a restore: db and project name the subject, config does not.
type RestorePlan = {
  confirmKey: string;
  confirmVars: Record<string, string>;
  doneKey: string;
  restore: () => Promise<void>;
};

// A dedicated "Backups" page (moved out of the settings — it lives in the sidebar
// under the "Settings" button): config/menu copies, DB dumps and project archives.
export function Backups({
  notify,
  services,
  projects,
  filter,
  onFilterChange,
  menuDirty = false,
  blocked = false,
  onMenuRestored,
  onMenuRestoreBusyChange,
  onRestart,
}: {
  notify: Notify;
  services: Service[];
  projects: OsPanelProject[];
  filter: BackupFilter;
  onFilterChange: (filter: BackupFilter) => void;
  menuDirty?: boolean;
  blocked?: boolean;
  onMenuRestored?: () => void;
  onMenuRestoreBusyChange?: (busy: boolean) => void;
  onRestart?: () => void;
}) {
  const { t, plural, lang } = useI18n();
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const restoringRef = useRef(false);
  const disabled = busy || blocked;
  const visibleBackups = backups.filter((item) => filter === 'all' || item.kind === filter);
  // Subjects for new backups: running DBMS with a supported engine
  // (MySQL/MariaDB/PostgreSQL — prefixes as in db_engine in main.rs) and projects.
  const dbModules = useMemo(
    () =>
      services
        .filter((service) => service.kind === 'database' && service.status === 'running')
        .map((service) => service.name)
        .filter((name) => /^(MySQL|MariaDB|Postgre)/.test(name)),
    [services],
  );
  const projectDomains = useMemo(() => projects.map((project) => project.domain), [projects]);
  const [dbModule, setDbModule] = useState('');
  const [projectDomain, setProjectDomain] = useState('');
  const dbChoices = dbModules.length > 0 ? [ALL_TARGETS, ...dbModules] : [];
  const projectChoices = projectDomains.length > 0 ? [ALL_TARGETS, ...projectDomains] : [];
  const selectedDbModule = dbChoices.includes(dbModule) ? dbModule : (dbChoices[0] ?? '');
  const selectedProjectDomain = projectChoices.includes(projectDomain)
    ? projectDomain
    : (projectChoices[0] ?? '');
  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await listBackups());
      setLoadError(false);
      return true;
    } catch {
      setLoadError(true);
      return false;
    }
  }, []);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups]);

  const createNewBackup = async () => {
    setBusy(true);
    try {
      const entry = await createBackup();
      notify(plural('configs.toastBackupDone', entry.files));
      await refreshBackups();
    } catch (error) {
      notify(errorText(t, error, 'configs.toastBackupFailed'));
    } finally {
      setBusy(false);
    }
  };
  const createNewMenuBackup = async () => {
    setBusy(true);
    try {
      await createMenuBackup();
      notify(t('settings.backupsMenuCreated'));
      await refreshBackups();
    } catch (error) {
      notify(errorText(t, error, 'configs.toastBackupFailed'));
    } finally {
      setBusy(false);
    }
  };
  // Bulk creation over the chosen targets: the loop, the notifications and the busy handling
  // are the same for DB dumps and project archives — only the call and the message keys differ.
  const createBackupsFor = async (
    targets: string[],
    runOne: (target: string) => Promise<unknown>,
    keys: { one: string; many: string },
    subjectVar: 'module' | 'domain',
  ) => {
    if (targets.length === 0) return;

    setBusy(true);

    let created = 0;
    let failure: unknown = null;

    try {
      for (const target of targets) {
        await runOne(target);
        created += 1;
      }
      notify(targets.length > 1 ? plural(keys.many, created) : t(keys.one, { [subjectVar]: targets[0] }));
    } catch (error) {
      failure = error;
    } finally {
      await refreshBackups();
      setBusy(false);
    }

    if (failure !== null) notify(errorText(t, failure, 'configs.toastBackupFailed'));
  };
  const createNewDbBackup = () =>
    createBackupsFor(
      selectedDbModule === ALL_TARGETS ? dbModules : [selectedDbModule],
      createDbBackup,
      { one: 'settings.backupsDbCreated', many: 'settings.backupsDbCreatedCount' },
      'module',
    );
  const createNewProjectBackup = () =>
    createBackupsFor(
      selectedProjectDomain === ALL_TARGETS ? projectDomains : [selectedProjectDomain],
      createProjectBackup,
      { one: 'settings.backupsProjectCreated', many: 'settings.backupsProjectCreatedCount' },
      'domain',
    );
  // Backup kind label for the list row, including the subject when applicable.
  const backupKindLabel = (item: BackupEntry) =>
    item.kind === 'db'
      ? t('settings.backupsKindDb', { module: item.subject ?? '' })
      : item.kind === 'project'
        ? t('settings.backupsKindProject', { domain: item.subject ?? '' })
        : item.kind === 'menu'
          ? t('settings.backupsKindMenu')
          : t('settings.backupsKindConfig');
  // The timestamp shown in the list and in the restore/delete confirmations.
  const formatWhen = (item: BackupEntry) => new Date(item.createdAt * 1000).toLocaleString(localeTag(lang));
  const restoreFromBackup = async (item: BackupEntry) => {
    if (disabled || restoringRef.current) return;
    const date = formatWhen(item);
    const subject = item.subject ?? '';
    // One table instead of four checks against item.kind.
    const plans: Record<BackupKind, RestorePlan> = {
      db: {
        confirmKey: 'settings.backupsConfirmDb',
        confirmVars: { date, module: subject },
        doneKey: 'settings.backupsDoneDb',
        restore: () => restoreDbBackup(item.id),
      },
      project: {
        confirmKey: 'settings.backupsConfirmProject',
        confirmVars: { date, domain: subject },
        doneKey: 'settings.backupsDoneProject',
        restore: () => restoreProjectBackup(item.id),
      },
      config: {
        confirmKey: 'settings.backupsConfirm',
        confirmVars: { date },
        doneKey: 'settings.backupsDone',
        restore: () => restoreBackup(item.id),
      },
      menu: {
        confirmKey: 'settings.backupsConfirmMenu',
        confirmVars: { date },
        doneKey: 'settings.backupsDoneMenu',
        restore: () => restoreMenuBackup(item.id),
      },
    };
    const plan = plans[item.kind];

    restoringRef.current = true;
    setBusy(true);
    if (item.kind === 'menu') onMenuRestoreBusyChange?.(true);
    try {
      const confirmed = await askConfirm(t(plan.confirmKey, plan.confirmVars), t('common.confirmTitle'));
      if (!confirmed) return;
      if (
        item.kind === 'menu' &&
        menuDirty &&
        !(await askConfirm(t('menu.restoreDiscardConfirm'), t('common.confirmTitle')))
      ) {
        return;
      }
      await plan.restore();
      if (item.kind === 'menu') {
        onMenuRestored?.();
        notify(
          t(plan.doneKey),
          onRestart ? { label: t('projects.restartPanel'), run: onRestart } : undefined,
        );
      } else {
        notify(t(plan.doneKey));
      }
      await refreshBackups();
    } catch (error) {
      notify(errorText(t, error, 'settings.backupsFailed'));
      if (item.kind === 'menu') await refreshBackups();
    } finally {
      restoringRef.current = false;
      setBusy(false);
      if (item.kind === 'menu') onMenuRestoreBusyChange?.(false);
    }
  };
  const deleteFromBackup = async (item: BackupEntry) => {
    const date = formatWhen(item);

    const confirmed = await askConfirm(
      t('settings.backupsDeleteConfirm', { date }),
      t('common.confirmTitle'),
    ).catch(() => false);
    if (!confirmed) return;

    setBusy(true);
    try {
      await deleteBackup(item.id);
      notify(t('settings.backupsDeleteDone'));
      await refreshBackups();
    } catch (error) {
      notify(errorText(t, error, 'settings.backupsDeleteFailed'));
    } finally {
      setBusy(false);
    }
  };
  // All dumps live in the same backups/ folder — open it; the command validates the path itself.
  const openBackupFolder = async () => {
    try {
      await openBackupsFolder();
    } catch (error) {
      notify(errorText(t, error, 'settings.backupsOpenFolderFailed'));
    }
  };

  return (
    <>
      <PageHeader eyebrow={t('nav.system')} heading={t('nav.backups')} description={t('backups.subtitle')} />
      <div className="settings-card">
        <div className="setting-block">
          <div>
            <h3>{t('settings.backupsTitle')}</h3>
            <p>{t('settings.backupsText')}</p>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={disabled}
            onClick={() => void createNewBackup()}
          >
            <Copy size={15} />
            {t('settings.backupsCreate')}
          </button>
        </div>
        <div className="setting-block">
          <div>
            <h3>{t('settings.backupsMenuTitle')}</h3>
            <p>{t('settings.backupsMenuText')}</p>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={disabled}
            onClick={() => void createNewMenuBackup()}
          >
            <ListTree size={15} />
            {t('settings.backupsMenuCreate')}
          </button>
        </div>
        <div className="setting-block">
          <div>
            <h3>{t('settings.backupsDbTitle')}</h3>
            <p>{t('settings.backupsDbText')}</p>
          </div>
          <div className="backup-actions">
            {dbModules.length > 0 ? (
              <label className="module-select">
                <select
                  aria-label={t('settings.backupsDbTitle')}
                  value={selectedDbModule}
                  onChange={(event) => setDbModule(event.target.value)}
                >
                  <option value={ALL_TARGETS}>{t('settings.backupsAll')}</option>
                  {dbModules.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="select-hint">{t('settings.backupsDbNone')}</span>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={disabled || !selectedDbModule}
              onClick={() => void createNewDbBackup()}
            >
              <Database size={15} />
              {t('settings.backupsDbCreate')}
            </button>
          </div>
        </div>
        <div className="setting-block">
          <div>
            <h3>{t('settings.backupsProjectTitle')}</h3>
            <p>{t('settings.backupsProjectText')}</p>
          </div>
          <div className="backup-actions">
            {projectDomains.length > 0 ? (
              <label className="module-select">
                <select
                  aria-label={t('settings.backupsProjectTitle')}
                  value={selectedProjectDomain}
                  onChange={(event) => setProjectDomain(event.target.value)}
                >
                  <option value={ALL_TARGETS}>{t('settings.backupsAll')}</option>
                  {projectDomains.map((domain) => (
                    <option key={domain} value={domain}>
                      {domain}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="select-hint">{t('settings.backupsProjectNone')}</span>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={disabled || !selectedProjectDomain}
              onClick={() => void createNewProjectBackup()}
            >
              <Box size={15} />
              {t('settings.backupsProjectCreate')}
            </button>
          </div>
        </div>
        <div className="backup-filter">
          <span>{t('backups.filter')}</span>
          <label className="module-select">
            <select
              aria-label={t('backups.filter')}
              value={filter}
              onChange={(event) => onFilterChange(event.target.value as BackupFilter)}
            >
              {Object.entries(FILTER_KEYS).map(([kind, key]) => (
                <option key={kind} value={kind}>
                  {t(key)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loadError && (
          <div className="backup-load-error" role="alert">
            <span>{t('settings.backupsLoadFailed')}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => void refreshBackups()}
              disabled={disabled}
            >
              <RefreshCw size={14} />
              {t('settings.backupsRetry')}
            </button>
          </div>
        )}
        {visibleBackups.length === 0 && !loadError && (
          <div className="empty-note">
            {t(filter === 'all' ? 'settings.backupsNone' : 'backups.filteredNone')}
          </div>
        )}
        {visibleBackups.length > 0 && (
          <div className="backup-list">
            {visibleBackups.map((item) => (
              <div className="backup-row" key={item.id}>
                <div>
                  <b>{formatWhen(item)}</b>
                  <span className="backup-kind">{backupKindLabel(item)}</span>
                  <span>
                    {plural('settings.backupsFiles', item.files, {
                      size: formatSize(item.sizeBytes),
                    })}
                  </span>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() => void restoreFromBackup(item)}
                  >
                    {t('settings.backupsRestore')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() => void openBackupFolder()}
                  >
                    {t('settings.backupsOpenFolder')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() => void deleteFromBackup(item)}
                  >
                    {t('settings.backupsDelete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
