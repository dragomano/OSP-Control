import { Copy, FileCode2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  type CreatedProject,
  createProject,
  type GlobalProjectEngines,
  getGlobalProjectEngines,
  getProjectModuleOptions,
  type ProjectModuleOptions,
} from '../../ospanel';
import { projectDatabaseEngines, suggestedDatabaseName, validDatabaseName } from '../../projectDatabase';
import { displayProjectDomain, normalizeProjectDomain } from '../../projectDomain';
import { listProjectStarters } from '../../projectStarters';
import {
  BUILTIN_TEMPLATES,
  PROJECT_TEMPLATES,
  type ProjectTemplateId,
  preferredTemplateEngine,
  preferredTemplateHttpEngine,
  projectTemplate,
  starterTemplate,
  starterText,
} from '../../projectTemplates';
import { copyText, type Notify, useDismiss } from '../shared';
import { MenuSelect } from '../widgets/MenuSelect';
import { PathText } from '../widgets/PathText';
import { defaultEngineLabel, ModuleSelect } from './ModuleSelect';
import './createProject.css';

function DatabaseEngineSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (engine: string) => void;
}) {
  // Not a <label>: the trigger button carries its own accessible name via aria-label.
  return (
    <div className="module-select">
      <span>{label}</span>
      <MenuSelect align="start" ariaLabel={label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

export function CreateProjectDialog({
  notify,
  onCreated,
  onConfigure,
  onRestartPanel,
  onClose,
  onManageTemplates,
}: {
  notify: Notify;
  onCreated: (created: CreatedProject) => void;
  onConfigure?: (created: CreatedProject) => void;
  onRestartPanel: () => void;
  onClose: () => void;
  onManageTemplates?: () => void;
}) {
  const { t, lang } = useI18n();
  const [options, setOptions] = useState<ProjectModuleOptions | null>(null);
  const [domain, setDomain] = useState('');
  const [templateId, setTemplateId] = useState<ProjectTemplateId>('empty');
  const [globalEngines, setGlobalEngines] = useState<GlobalProjectEngines | null>(null);
  const [backendPort, setBackendPort] = useState('3000');
  const [databaseEngine, setDatabaseEngine] = useState('none');
  const [databaseName, setDatabaseName] = useState<string | null>(null);
  const [databaseUser, setDatabaseUser] = useState('root');
  const [databasePassword, setDatabasePassword] = useState('');
  const [templates, setTemplates] = useState(PROJECT_TEMPLATES);
  const template = templates.find((item) => item.id === templateId) ?? projectTemplate('empty');
  useEffect(() => {
    void listProjectStarters()
      .then((entries) =>
        setTemplates([
          ...BUILTIN_TEMPLATES,
          ...entries.flatMap((entry) => (entry.document ? [starterTemplate(entry.document)] : [])),
        ]),
      )
      .catch(() => {});
  }, []);
  const [httpEngine, setHttpEngine] = useState('auto');
  const [phpEngine, setPhpEngine] = useState('auto');
  const [nodeEngine, setNodeEngine] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const domainRef = useRef<HTMLInputElement>(null);
  const normalizedDomain = normalizeProjectDomain(domain);
  const hasDatabase = template.starter?.manifest.database.enabled ?? false;
  const dbName = databaseName ?? suggestedDatabaseName(normalizedDomain ?? '');
  const dbEngines = projectDatabaseEngines(template, options?.databaseEngines ?? []);
  const supportsSqlite = template.starter?.manifest.database.engines.includes('sqlite') ?? false;
  const databaseOptions = useMemo(
    () => [
      ...(supportsSqlite ? [{ value: 'sqlite', label: t('projectDb.sqlite') }] : []),
      ...dbEngines.map((engine) => ({
        value: engine,
        label: engine,
      })),
      { value: 'none', label: t('projectDb.later') },
    ],
    [supportsSqlite, dbEngines, t],
  );
  const changeDatabaseEngine = useCallback((engine: string) => {
    setDatabaseEngine(engine);
    setDatabaseUser(engine.startsWith('PostgreSQL-') ? 'postgres' : 'root');
  }, []);
  // "Default (Nginx)" — the global value from the panel's own Settings → Projects.
  const defaultLabel = (global: string) =>
    defaultEngineLabel(
      t('projects.modulesAuto'),
      t('projects.defaultNotSet'),
      globalEngines === null ? null : global,
    );
  const databaseValid =
    !hasDatabase ||
    databaseEngine === 'none' ||
    (validDatabaseName(dbName) &&
      (databaseEngine === 'sqlite' || (dbEngines.includes(databaseEngine) && !!databaseUser.trim())));
  const unavailable = (engine: string, available: string[]) =>
    !engine || (engine === 'auto' ? available.length === 0 : !available.includes(engine));
  const missingModule =
    templateId !== 'empty' && options
      ? unavailable(httpEngine, options.httpEngines) ||
        (template.php && unavailable(phpEngine, options.phpEngines)) ||
        (template.node && unavailable(nodeEngine, options.nodeEngines))
      : false;
  const validPort =
    !template.node || (/^\d+$/.test(backendPort) && +backendPort >= 1 && +backendPort <= 65535);

  // Focus after mounting — otherwise the browser returns it to the previous element.
  const loaded = options !== null;
  useEffect(() => {
    if (loaded) domainRef.current?.focus();
  }, [loaded]);

  const refreshVersions = async () => {
    if (refreshing || busy) return;
    setRefreshing(true);
    try {
      const available = await getProjectModuleOptions();
      setOptions(available);
      setNodeEngine((current) =>
        available.nodeEngines.includes(current) || current === 'auto'
          ? current
          : template.node
            ? preferredTemplateEngine(available.nodeEngines, globalEngines?.nodeEngine)
            : '',
      );
    } catch (error) {
      notify(errorText(t, error, 'projects.toastModulesFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: engine options are read once when the dialog opens — onClose/notify/t are unstable and would cause a refetch loop
  useEffect(() => {
    void (async () => {
      try {
        const [available, globals] = await Promise.all([
          getProjectModuleOptions(),
          Promise.resolve(getGlobalProjectEngines()).catch(() => null),
        ]);
        setOptions(available);
        setGlobalEngines(globals ?? null);
      } catch (error) {
        notify(errorText(t, error, 'projects.toastModulesFailed'));
        onClose();
      }
    })();
  }, []);

  useDismiss(windowRef, onClose, !busy);
  const selectTemplate = (id: ProjectTemplateId) => {
    setTemplateId(id);
    const next = templates.find((item) => item.id === id) ?? projectTemplate(id);
    const engines = projectDatabaseEngines(next, options?.databaseEngines ?? []);
    const engine =
      id === 'empty'
        ? 'none'
        : next.starter?.manifest.database.defaultEngine === 'sqlite'
          ? 'sqlite'
          : preferredTemplateEngine(engines, '') || 'none';
    setDatabaseEngine(engine);
    setDatabaseUser(engine.startsWith('PostgreSQL-') ? 'postgres' : 'root');
    if (!options) return;
    setHttpEngine(
      id === 'empty'
        ? 'auto'
        : preferredTemplateHttpEngine(next, options.httpEngines, globalEngines?.httpEngine),
    );
    setPhpEngine(
      id === 'empty'
        ? 'auto'
        : next.php
          ? preferredTemplateEngine(options.phpEngines, globalEngines?.phpEngine)
          : '',
    );
    setNodeEngine(
      id === 'empty'
        ? 'auto'
        : next.node
          ? preferredTemplateEngine(options.nodeEngines, globalEngines?.nodeEngine)
          : '',
    );
  };

  const create = async () => {
    if (busy || refreshing || missingModule || !validPort || !databaseValid) return;
    if (!normalizedDomain) {
      notify(t('err.invalidDomain'));
      return;
    }

    setBusy(true);

    try {
      const created = await createProject({
        language: lang,
        domain: normalizedDomain,
        httpEngine: httpEngine === 'auto' ? undefined : httpEngine,
        phpEngine: phpEngine === 'auto' ? undefined : phpEngine,
        ...(hasDatabase
          ? {
              database: {
                engine: databaseEngine,
                name: databaseEngine === 'none' ? '' : dbName,
                username: databaseEngine === 'sqlite' || databaseEngine === 'none' ? '' : databaseUser.trim(),
                password: databaseEngine === 'sqlite' || databaseEngine === 'none' ? '' : databasePassword,
              },
            }
          : {}),
        nodeEngine: nodeEngine === 'auto' ? undefined : nodeEngine,
        ...(templateId === 'empty'
          ? {}
          : { template: templateId, ...(template.node ? { backendPort: +backendPort } : {}) }),
      });

      onCreated(created);
      if (hasDatabase) onConfigure?.(created);
      const domain = displayProjectDomain(created.domain);
      // Starter packages carry their own created message; the generic fallback stays in the dictionary.
      const message = template.starter
        ? starterText(template.starter.manifest.createdMessage, lang).replace('{domain}', domain) ||
          t('templates.created', { domain })
        : t(templateId === 'empty' ? 'projects.toastCreated' : 'templates.created', { domain });
      notify(message, {
        label: t('projects.restartPanel'),
        run: onRestartPanel,
      });
      onClose();
    } catch (error) {
      notify(errorText(t, error, 'projects.toastCreateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-window create-project-window"
        role="dialog"
        aria-modal="true"
        aria-label={t('projects.createTitle')}
        ref={windowRef}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">{t('nav.projects')}</span>
            <h3 className="modal-title">{t('projects.createTitle')}</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <p className="modal-hint">
          <PathText text={t('projects.createHint')} />
        </p>
        {options ? (
          <div className="modal-body create-project-body">
            <fieldset className="create-project-fields" disabled={busy}>
              <label className="module-select">
                <span>{t('projects.createDomain')}</span>
                <input
                  ref={domainRef}
                  type="text"
                  value={domain}
                  aria-invalid={!!domain.trim() && !normalizedDomain}
                  onChange={(event) => setDomain(event.target.value)}
                  placeholder={t('projects.createDomainPlaceholder')}
                />
              </label>
              {domain.trim() && !normalizedDomain && (
                <p className="modal-hint" role="alert">
                  {t('err.invalidDomain')}
                </p>
              )}
              {normalizedDomain && !normalizedDomain.includes('.') && (
                <div className="modal-hint">
                  <p>{t('projects.domainZoneHint')}</p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setDomain(`${normalizedDomain}.test`)}
                  >
                    {t('projects.useTestDomain', {
                      domain: displayProjectDomain(`${normalizedDomain}.test`),
                    })}
                  </button>
                </div>
              )}
              <div className="module-select">
                <span>{t('templates.label')}</span>
                <MenuSelect<ProjectTemplateId>
                  align="start"
                  ariaLabel={t('templates.label')}
                  value={templateId}
                  disabled={refreshing}
                  options={templates.map((template) => ({
                    value: template.id,
                    label: template.starter
                      ? starterText(template.starter.manifest.name, lang)
                      : t(`templates.${template.id}.name`),
                  }))}
                  onChange={selectTemplate}
                />
              </div>
              <section className="project-template-preview" aria-label={t('templates.preview')}>
                <p>
                  <PathText
                    text={
                      template.starter
                        ? starterText(template.starter.manifest.description, lang)
                        : t(`templates.${templateId}.description`)
                    }
                  />
                </p>
                {templateId !== 'empty' && (
                  <>
                    <dl>
                      <div>
                        <dt>{t('templates.projectRoot')}</dt>
                        <dd>{template.projectRoot}</dd>
                      </div>
                      <div>
                        <dt>{t('templates.webRoot')}</dt>
                        <dd>{template.webRoot}</dd>
                      </div>
                    </dl>
                    <p className="template-next-step">
                      {template.starter
                        ? starterText(template.starter.manifest.nextStep, lang)
                        : t(`templates.${templateId}.next`)}
                    </p>
                  </>
                )}
                <details>
                  <summary>
                    <FileCode2 size={14} />
                    {t('templates.files', { n: template.files.length + (hasDatabase ? 2 : 0) })}
                  </summary>
                  <ul>
                    {[
                      ...template.directories.map((path) => `${path}/`),
                      ...(hasDatabase ? ['.osp/database.json', '.osp/.gitignore'] : []),
                      ...template.files.map((file) =>
                        file.path.replace(/\{domain\}/g, normalizedDomain ?? '<domain>'),
                      ),
                    ]
                      .sort((a, b) => a.localeCompare(b, lang))
                      .map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                  </ul>
                </details>
              </section>
              <div
                className={`create-project-engines ${template.node && !options.nodeEngines.length ? 'without-node' : ''}`}
              >
                <ModuleSelect
                  label={t('projects.createHttpEngine')}
                  value={httpEngine}
                  options={options.httpEngines}
                  autoLabel={defaultLabel(globalEngines?.httpEngine ?? '')}
                  includeAuto={templateId === 'empty'}
                  globalHint={null}
                  onChange={setHttpEngine}
                />
                <ModuleSelect
                  label={t('projects.createPhpEngine')}
                  value={phpEngine}
                  options={options.phpEngines}
                  autoLabel={defaultLabel(globalEngines?.phpEngine ?? '')}
                  includeAuto={templateId === 'empty'}
                  globalHint={null}
                  noneLabel={templateId === 'empty' || template.php ? undefined : t('templates.unused')}
                  onChange={setPhpEngine}
                />
                {(!template.node || options.nodeEngines.length > 0) && (
                  <ModuleSelect
                    label={t('projects.createNodeEngine')}
                    value={nodeEngine}
                    options={options.nodeEngines}
                    autoLabel={defaultLabel(globalEngines?.nodeEngine ?? '')}
                    includeAuto={templateId === 'empty'}
                    globalHint={null}
                    noneLabel={templateId === 'empty' || template.node ? undefined : t('templates.unused')}
                    onChange={setNodeEngine}
                  />
                )}
              </div>
              {template.node && !options.nodeEngines.length && (
                <section
                  className="project-template-preview create-project-node-missing"
                  aria-label={t('projects.createNodeEngine')}
                >
                  <p role="alert">
                    {t(
                      options.nvmAvailable === false ? 'templates.node.nvmMissing' : 'templates.node.missing',
                    )}
                  </p>
                  {options.nvmAvailable !== false && <code>osp node install lts</code>}
                  <div className="row-actions">
                    {options.nvmAvailable !== false && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          void copyText(t, 'osp node install lts', 'templates.node.command', notify)
                        }
                      >
                        <Copy size={13} />
                        {t('templates.node.copy')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={refreshing}
                      onClick={() => void refreshVersions()}
                    >
                      <RefreshCw size={13} />
                      {t(refreshing ? 'common.loading' : 'templates.node.refresh')}
                    </button>
                  </div>
                </section>
              )}
              {hasDatabase && (
                <section className="create-project-database" aria-label={t('projectDb.title')}>
                  <h4>{t('projectDb.title')}</h4>
                  <DatabaseEngineSelect
                    label={t('projectDb.engine')}
                    value={databaseEngine}
                    options={databaseOptions}
                    onChange={changeDatabaseEngine}
                  />
                  {databaseEngine !== 'none' && (
                    <>
                      <label className="module-select">
                        <span>{t('projectDb.name')}</span>
                        <input
                          value={dbName}
                          maxLength={63}
                          autoComplete="off"
                          aria-invalid={!validDatabaseName(dbName)}
                          onChange={(event) => setDatabaseName(event.target.value)}
                        />
                      </label>
                      {!validDatabaseName(dbName) && (
                        <p className="modal-hint" role="alert">
                          {t('projectDb.invalidName')}
                        </p>
                      )}
                      {databaseEngine === 'sqlite' ? (
                        <p className="modal-hint">
                          <PathText
                            text={
                              starterText(template.starter?.manifest.database.sqliteHint, lang) ||
                              t('projectDb.sqliteHint', { path: `database/${dbName}.sqlite` })
                            }
                          />
                        </p>
                      ) : (
                        <>
                          <div className="create-project-db-credentials">
                            <label className="module-select">
                              <span>{t('projectDb.user')}</span>
                              <input
                                value={databaseUser}
                                maxLength={128}
                                autoComplete="off"
                                onChange={(event) => setDatabaseUser(event.target.value)}
                              />
                            </label>
                            <label className="module-select">
                              <span>{t('projectDb.password')}</span>
                              <input
                                type="password"
                                value={databasePassword}
                                maxLength={1024}
                                autoComplete="new-password"
                                onChange={(event) => setDatabasePassword(event.target.value)}
                              />
                            </label>
                          </div>
                          <p className="modal-hint">
                            <PathText text={t('projectDb.hint')} />
                          </p>
                        </>
                      )}
                    </>
                  )}
                  {hasDatabase && dbEngines.length === 0 && (
                    <p className="modal-hint">
                      {starterText(template.starter?.manifest.database.missing, lang) ||
                        t('projectDb.missing')}
                    </p>
                  )}
                </section>
              )}
              {template.node && (
                <label className="module-select">
                  <span>{t('templates.backendPort')}</span>
                  <input
                    aria-label={t('templates.backendPort')}
                    type="number"
                    min={1}
                    max={65535}
                    value={backendPort}
                    aria-invalid={!validPort}
                    onChange={(event) => setBackendPort(event.target.value)}
                  />
                </label>
              )}
              {missingModule && (!template.node || options.nodeEngines.length > 0 || !httpEngine) && (
                <p className="modal-hint" role="alert">
                  {t('templates.missingModules')}
                </p>
              )}
              {!validPort && (
                <p className="modal-hint" role="alert">
                  {t('templates.invalidPort')}
                </p>
              )}
            </fieldset>
          </div>
        ) : (
          <div className="empty-note">{t('common.loading')}</div>
        )}
        <div className="modal-foot">
          {onManageTemplates && (
            <button type="button" className="text-button" disabled={busy} onClick={onManageTemplates}>
              {t('starter.manage')}
            </button>
          )}
          <span className="modal-path">
            {normalizedDomain ? `home/${normalizedDomain}/.osp/project.ini` : '\u00A0'}
          </span>
          <div className="row-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
              {t('common.close')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                !normalizedDomain ||
                busy ||
                refreshing ||
                !options ||
                missingModule ||
                !validPort ||
                !databaseValid
              }
              onClick={() => void create()}
            >
              {t('projects.create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
