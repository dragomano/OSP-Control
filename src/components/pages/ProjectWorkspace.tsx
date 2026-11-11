import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock3,
  FileCode2,
  FolderOpen,
  Globe2,
  Info,
  LayoutGrid,
  ListTree,
  Network,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  askConfirm,
  type GlobalProjectEngines,
  getGlobalProjectEngines,
  getProjectModuleOptions,
  type OsPanelProject,
  openFileExternally,
  openInBrowser,
  openProjectFolder,
  type ProjectModuleOptions,
  readProjectFile,
  readProjectWorkspace,
  saveProjectFile,
} from '../../ospanel';
import { displayProjectDomain, normalizeProjectDomain } from '../../projectDomain';
import { type ProjectTask, parseProjectTasks, renderProjectTasks, taskErrors } from '../../projectTasks';
import {
  appendProjectDomain,
  isApplicationFile,
  patchProjectIni,
  projectDomains,
  projectFileLanguage,
  projectOpeningUrl,
  type ProjectWorkspace as WorkspaceDocument,
} from '../../projectWorkspace';
import type { Notify } from '../shared';
import { ConfigEditor } from '../widgets/ConfigEditor';
import { PageHeader } from '../widgets/PageHeader';
import '../widgets/formControls.css';
import './projectWorkspace.css';
import { ApplicationSetup } from './ApplicationSetup';
import type { MenuEditorHandle } from './MenuEditor';

const ProjectMenuEditor = lazy(() =>
  import('./MenuEditor').then((module) => ({ default: module.MenuEditor })),
);
const ProjectTasksEditor = lazy(() =>
  import('./ProjectTasksEditor').then((module) => ({ default: module.ProjectTasksEditor })),
);
const ProjectDiagnostics = lazy(() =>
  import('./ProjectDiagnostics').then((module) => ({ default: module.ProjectDiagnostics })),
);

const TABS = [
  ['overview', LayoutGrid],
  ['domains', Globe2],
  ['environment', SlidersHorizontal],
  ['web', Network],
  ['configs', FileCode2],
  ['application', FileCode2],
  ['menu', ListTree],
  ['tasks', Clock3],
  ['diagnostics', Stethoscope],
] as const;
type Tab = (typeof TABS)[number][0];
type FileDraft = { original: string | null; draft: string };
const emptyIni = (domain: string) => `\uFEFF[${domain}]\r\n`;

export function ProjectWorkspace({
  project,
  notify,
  blocked = false,
  onClose,
  onRestartPanel,
  onStateChange,
}: {
  project: OsPanelProject;
  notify: Notify;
  blocked?: boolean;
  onClose: () => void;
  onRestartPanel: () => void;
  onStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [tab, setTab] = useState<Tab>('overview');
  const [doc, setDoc] = useState<WorkspaceDocument | null>(null);
  const [ini, setIni] = useState('');
  const [domain, setDomain] = useState(project.domain);
  const [options, setOptions] = useState<ProjectModuleOptions | null>(null);
  const [globals, setGlobals] = useState<GlobalProjectEngines | null>(null);
  const [files, setFiles] = useState<Record<string, FileDraft>>({});
  const [tasks, setTasks] = useState<ProjectTask[] | null>(null);
  const [engine, setEngine] = useState('nginx');
  const [applicationFile, setApplicationFile] = useState('.env');
  const [fileBusy, setFileBusy] = useState(false);
  const [fileRetry, setFileRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [installingApplication, setInstallingApplication] = useState(false);
  const [error, setError] = useState('');
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [menuVisited, setMenuVisited] = useState(false);
  const [diagnosticsVisited, setDiagnosticsVisited] = useState(false);
  const [diagnosticsRevision, setDiagnosticsRevision] = useState(0);
  const [menuState, setMenuState] = useState({ dirty: false, busy: false });
  const [menuReloadVersion, setMenuReloadVersion] = useState(0);
  const menuEditor = useRef<MenuEditorHandle>(null);
  const pending = useRef(false);
  const request = useRef(0);
  const tabsRef = useRef<HTMLDivElement>(null);
  const domains = useMemo(() => projectDomains(ini, project.domain), [ini, project.domain]);
  const values = domains.find((item) => item.domain === domain)?.values ?? {};
  const iniDirty = doc !== null && ini !== (doc.content ?? emptyIni(project.domain));
  const tasksDocument = useMemo(
    () => parseProjectTasks(files['tasks.ini']?.draft ?? ''),
    [files['tasks.ini']?.draft],
  );
  const tasksDirty = tasks !== null && JSON.stringify(tasks) !== JSON.stringify(tasksDocument.tasks);
  const dirty =
    iniDirty ||
    menuState.dirty ||
    tasksDirty ||
    Object.values(files).some((file) => file.draft !== (file.original ?? ''));
  const locked = busy || installingApplication || blocked || menuState.busy;
  const applicationFiles = doc?.files.filter(isApplicationFile) ?? [];
  const tabs = TABS.filter(([key]) => key !== 'application' || applicationFiles.length > 0);
  const selectedApplicationFile = applicationFiles.includes(applicationFile)
    ? applicationFile
    : applicationFiles[0];
  const file = advanced
    ? 'project.ini'
    : tab === 'tasks'
      ? 'tasks.ini'
      : tab === 'environment'
        ? 'env.ini'
        : tab === 'application'
          ? (selectedApplicationFile ?? '.env')
          : `${engine}/${domain}.conf`;
  const fileState = file === 'project.ini' ? { original: doc?.content ?? null, draft: ini } : files[file];
  const editingFile = advanced || ['configs', 'tasks', 'environment', 'application'].includes(tab);
  const selectedDomain = displayProjectDomain(domain);
  const inherited = (key: string, global?: string) =>
    values[key] && values[key] !== 'auto' ? values[key] : global || t('projects.engineUnset');
  useEffect(() => {
    if (tab === 'menu') setMenuVisited(true);
    if (tab === 'diagnostics') setDiagnosticsVisited(true);
  }, [tab]);

  const load = async () => {
    const current = ++request.current;
    setBusy(true);
    setError('');
    try {
      const [next, available, global] = await Promise.all([
        readProjectWorkspace(project),
        getProjectModuleOptions(),
        getGlobalProjectEngines().catch(() => null),
      ]);
      if (current !== request.current) return;
      setDoc(next);
      setIni(next.content ?? emptyIni(project.domain));
      setOptions(available);
      setGlobals(global);
      setFiles({});
      setTasks(null);
      setDiagnosticsRevision((value) => value + 1);
    } catch (error) {
      if (current === request.current) setError(errorText(t, error, 'workspace.failed'));
    } finally {
      if (current === request.current) setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: callback/translator changes must not discard a draft
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [project.domain, project.path]);

  useEffect(() => {
    onStateChange?.({ dirty, busy: busy || installingApplication || fileBusy || menuState.busy });
  }, [dirty, busy, installingApplication, fileBusy, menuState.busy, onStateChange]);
  useEffect(() => () => onStateChange?.({ dirty: false, busy: false }), [onStateChange]);
  useEffect(() => {
    if (!dirty && !installingApplication) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, installingApplication]);

  // Drafts are cached per file, so switching tabs or domains never throws edits away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch only when the selected file or workspace changes
  useEffect(() => {
    if (!doc || !editingFile || file === 'project.ini' || files[file]) return;
    let cancelled = false;
    setFileBusy(true);
    setError('');
    void readProjectFile(project, file)
      .then((content) => {
        if (!cancelled) {
          setFiles((current) => ({ ...current, [file]: { original: content, draft: content ?? '' } }));
          if (file === 'tasks.ini') setTasks(parseProjectTasks(content ?? '').tasks);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(t, error, 'workspace.failed'));
      })
      .finally(() => {
        if (!cancelled) setFileBusy(false);
      });
    return () => {
      cancelled = true;
      setFileBusy(false);
    };
  }, [doc, file, editingFile, fileRetry]);

  const confirmDiscard = () => !dirty || askConfirm(t('workspace.discard'), t('common.confirmTitle'));
  const close = async () => {
    if (!pending.current && !locked && (await confirmDiscard())) onClose();
  };
  const change = (key: string, value: string | null) => {
    setIni((current) => {
      let next = patchProjectIni(current, domain, { [key]: value });
      if (key === 'primary_domain' && value === 'on')
        for (const item of domains)
          if (item.domain !== domain) next = patchProjectIni(next, item.domain, { primary_domain: 'off' });
      return next;
    });
  };
  const save = async () => {
    if (!doc || !dirty || pending.current || locked) return;
    if (tasksDirty && tasks) {
      const invalidTask = tasks.find((task) => taskErrors(task, tasks).length);
      if (invalidTask || tasksDocument.errors.length) {
        setError(t('tasks.fixErrors'));
        setAdvanced(false);
        setTab('tasks');
        if (invalidTask && domains.some((item) => item.domain === invalidTask.domain))
          setDomain(invalidTask.domain);
        return;
      }
    }
    pending.current = true;
    // Start the child save before the parent locks its controls; its own save lock prevents reentry.
    const menuSave = menuState.dirty ? menuEditor.current?.save() : null;
    setBusy(true);
    setError('');
    try {
      if (menuState.dirty && (!menuSave || !(await menuSave))) {
        setAdvanced(false);
        setTab('menu');
        return;
      }
      if (iniDirty) {
        const result = await saveProjectFile(project, 'project.ini', doc.content, ini);
        setDoc((current) => current && { ...current, content: result.content });
        setIni(result.content);
        setDiagnosticsRevision((value) => value + 1);
        setRestartNeeded(true);
      }
      for (const [name, draft] of Object.entries(files)) {
        const content =
          name === 'tasks.ini' && tasksDirty && tasks ? renderProjectTasks(draft.draft, tasks) : draft.draft;
        if (content === (draft.original ?? '')) continue;
        const result = await saveProjectFile(project, name, draft.original, content);
        setFiles((current) => ({ ...current, [name]: { original: result.content, draft: result.content } }));
        if (name === 'tasks.ini') setTasks(parseProjectTasks(result.content).tasks);
        setDiagnosticsRevision((value) => value + 1);
        if (!isApplicationFile(name)) setRestartNeeded(true);
      }
      const panelChanged =
        iniDirty ||
        menuState.dirty ||
        tasksDirty ||
        Object.entries(files).some(
          ([name, draft]) => !isApplicationFile(name) && draft.draft !== (draft.original ?? ''),
        );
      notify(
        t('workspace.saved'),
        panelChanged ? { label: t('projects.restartPanel'), run: onRestartPanel } : undefined,
      );
    } catch (error) {
      setError(errorText(t, error, 'workspace.failed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (tab !== 'tasks' || advanced) return;
    const key = (event: KeyboardEvent) => {
      if (tabsRef.current?.closest('[hidden]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      notify(errorText(t, error, 'workspace.failed'));
    }
  };
  const field = (key: string, control: ReactNode) => (
    <div className="workspace-setting" key={key}>
      <div>
        <b>{t(`workspace.${key}`)}</b>
      </div>
      {control}
    </div>
  );
  const text = (key: string, placeholder = '', type = 'text') =>
    field(
      key,
      <input
        type={type}
        min={type === 'number' ? 1 : undefined}
        max={type === 'number' ? 65535 : undefined}
        aria-label={t(`workspace.${key}`)}
        value={values[key] ?? ''}
        disabled={locked}
        placeholder={placeholder}
        onChange={(event) => change(key, event.target.value)}
      />,
    );
  const choice = (key: string, items: string[], global?: string) => {
    const current = values[key] ?? '';
    return field(
      key,
      <select
        aria-label={t(`workspace.${key}`)}
        value={current}
        disabled={locked || !options}
        onChange={(event) => change(key, event.target.value || null)}
      >
        <option value="">{t('workspace.inherit', { value: global || t('projects.engineUnset') })}</option>
        {current === 'auto' && (
          <option value="auto">
            {t('workspace.inherit', { value: global || t('projects.engineUnset') })}
          </option>
        )}
        {current && current !== 'auto' && !items.includes(current) && (
          <option value={current}>{current}</option>
        )}
        {items.map((item) => (
          <option key={item} value={item}>
            {item === 'on' ? t('workspace.on') : item === 'off' ? t('workspace.off') : item}
          </option>
        ))}
      </select>,
    );
  };
  const codeEditor = (
    <section className="workspace-file-section">
      <div className="workspace-file-head">
        <div>
          <FileCode2 size={15} />
          <b>{isApplicationFile(file) ? file : `.osp/${file}`}</b>
        </div>
        <span>{projectFileLanguage(file)}</span>
      </div>
      {fileBusy ? (
        <div className="empty-note" role="status">
          {t('common.loading')}
        </div>
      ) : fileState ? (
        <ConfigEditor
          file={file}
          value={fileState.draft}
          disabled={locked}
          label={t('workspace.fileContent', { file })}
          onChange={(draft) => {
            if (file === 'project.ini') setIni(draft);
            else setFiles((current) => ({ ...current, [file]: { ...current[file], draft } }));
          }}
        />
      ) : (
        <button
          type="button"
          className="secondary-button"
          disabled={locked}
          onClick={() => setFileRetry((value) => value + 1)}
        >
          {t('workspace.reload')}
        </button>
      )}
      {fileState?.original === null && <p className="workspace-hint">{t('workspace.createFile')}</p>}
    </section>
  );

  return (
    <section className="project-workspace" aria-label={t('workspace.settings')}>
      <button
        type="button"
        className="text-button workspace-back"
        disabled={locked}
        onClick={() => void close()}
      >
        <ArrowLeft size={15} />
        {t('workspace.allProjects')}
      </button>
      <PageHeader
        eyebrow={t('workspace.settings')}
        heading={displayProjectDomain(project.domain)}
        description={doc?.baseDir ?? project.path}
        action={
          <div className="workspace-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void run(() => openInBrowser(projectOpeningUrl(domain, values, project.ssl)))}
            >
              <ArrowUpRight size={15} />
              {t('projects.open')}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void run(() => openProjectFolder(project.path))}
            >
              <FolderOpen size={15} />
              {t('projects.menuOpenFolder')}
            </button>
          </div>
        }
      />
      <div className="workspace-tabs" role="tablist" aria-label={t('workspace.sections')} ref={tabsRef}>
        {tabs.map(([key, Icon], index) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-${key}`}
            aria-controls={`${id}-panel`}
            aria-selected={tab === key && !advanced}
            tabIndex={tab === key ? 0 : -1}
            className={tab === key && !advanced ? 'selected' : ''}
            disabled={installingApplication}
            onClick={() => {
              setTab(key);
              setAdvanced(false);
            }}
            onKeyDown={(event) => {
              if (installingApplication) return;
              const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              const target =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : offset
                      ? (index + offset + tabs.length) % tabs.length
                      : -1;
              if (target >= 0) {
                event.preventDefault();
                setTab(tabs[target][0]);
                setAdvanced(false);
                tabsRef.current?.querySelectorAll<HTMLButtonElement>('button')[target]?.focus();
              }
            }}
          >
            <Icon size={15} />
            {t(`workspace.tab.${key}`)}
          </button>
        ))}
      </div>
      {error && (
        <div className="workspace-error" role="alert">
          {error}
        </div>
      )}
      <div
        id={tab === 'diagnostics' && !advanced ? `${id}-panel` : undefined}
        role="tabpanel"
        aria-labelledby={`${id}-diagnostics`}
        hidden={tab !== 'diagnostics' || advanced}
      >
        {diagnosticsVisited && (
          <Suspense
            fallback={
              <div className="empty-note" role="status">
                {t('common.loading')}
              </div>
            }
          >
            <div className="workspace-section-head">
              <div>
                <h2>{t('workspace.tab.diagnostics')}</h2>
                <p>{t('workspace.hint.diagnostics')}</p>
              </div>
              <label className="workspace-domain-select">
                {t('workspace.domain')}
                <select
                  aria-label={t('workspace.domain')}
                  value={domain}
                  disabled={locked}
                  onChange={(event) => setDomain(event.target.value)}
                >
                  {domains.map((item) => (
                    <option value={item.domain} key={item.domain}>
                      {displayProjectDomain(item.domain)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ProjectDiagnostics
              project={project}
              domain={domain}
              revision={String(diagnosticsRevision)}
              dirty={dirty}
              blocked={locked}
              savedDomain={projectDomains(doc?.content ?? null, project.domain).some(
                (item) => item.domain === domain,
              )}
              notify={notify}
              onNavigate={(target) => {
                setAdvanced(false);
                setTab(target);
              }}
              onRestart={onRestartPanel}
            />
          </Suspense>
        )}
      </div>
      <div hidden={tab === 'diagnostics' && !advanced}>
        {!doc ? (
          <div className="empty-note" role="status">
            {busy ? t('common.loading') : t('workspace.failed')}
            {!busy && (
              <button type="button" className="secondary-button" onClick={() => void load()}>
                {t('workspace.reload')}
              </button>
            )}
          </div>
        ) : (
          <>
            <div
              id={tab !== 'diagnostics' || advanced ? `${id}-panel` : undefined}
              role="tabpanel"
              aria-labelledby={`${id}-${tab}`}
              className="workspace-tab-panel"
            >
              {advanced ? (
                codeEditor
              ) : (
                <>
                  <div className="workspace-section-head">
                    <div>
                      <h2>{t(`workspace.tab.${tab}`)}</h2>
                      <p>{t(`workspace.hint.${tab}`)}</p>
                    </div>
                    {!['overview', 'domains', 'menu'].includes(tab) && (
                      <label className="workspace-domain-select">
                        {t('workspace.domain')}
                        <select
                          aria-label={t('workspace.domain')}
                          value={domain}
                          disabled={locked}
                          onChange={(event) => setDomain(event.target.value)}
                        >
                          {domains.map((item) => (
                            <option key={item.domain} value={item.domain}>
                              {displayProjectDomain(item.domain)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  {tab === 'overview' && (
                    <>
                      {(['laravel', 'wordpress'] as const).map((kind) => (
                        <ApplicationSetup
                          key={kind}
                          kind={kind}
                          project={project}
                          state={doc?.[kind]}
                          disabled={locked || dirty || fileBusy}
                          dirty={dirty}
                          onBusyChange={setInstallingApplication}
                          onInstalled={async () => {
                            await load();
                            setRestartNeeded(true);
                            notify(t(`${kind}.done`), {
                              label: t('projects.restartPanel'),
                              run: onRestartPanel,
                            });
                          }}
                        />
                      ))}
                      <div className="workspace-overview-grid">
                        <div className="workspace-card">
                          <h3>
                            <SlidersHorizontal size={15} />
                            {t('workspace.tab.environment')}
                          </h3>
                          <dl>
                            <div>
                              <dt>{t('workspace.http_engine')}</dt>
                              <dd>{inherited('http_engine', globals?.httpEngine)}</dd>
                            </div>
                            <div>
                              <dt>{t('workspace.php_engine')}</dt>
                              <dd>{inherited('php_engine', globals?.phpEngine)}</dd>
                            </div>
                            <div>
                              <dt>{t('workspace.node_engine')}</dt>
                              <dd>{inherited('node_engine', globals?.nodeEngine)}</dd>
                            </div>
                          </dl>
                          <button
                            className="text-button"
                            type="button"
                            disabled={installingApplication}
                            onClick={() => setTab('environment')}
                          >
                            {t('workspace.configure')}
                          </button>
                        </div>
                        <div className="workspace-card">
                          <h3>
                            <FolderOpen size={15} />
                            {t('workspace.paths')}
                          </h3>
                          <dl>
                            <div>
                              <dt>{t('workspace.project_root')}</dt>
                              <dd>{values.project_root || '{base_dir}'}</dd>
                            </div>
                            <div>
                              <dt>{t('workspace.web_root')}</dt>
                              <dd>{values.web_root || '{base_dir}'}</dd>
                            </div>
                            <div>
                              <dt>{t('workspace.settings')}</dt>
                              <dd>.osp/project.ini</dd>
                            </div>
                            {doc.readme && (
                              <div>
                                <dt>{t('workspace.readme')}</dt>
                                <dd>
                                  <button
                                    type="button"
                                    className="text-button"
                                    title={t('workspace.openReadme')}
                                    disabled={locked}
                                    onClick={() =>
                                      void run(() =>
                                        openFileExternally(
                                          `${doc.baseDir}\\${doc.readme?.replace(/\//g, '\\')}`,
                                        ),
                                      )
                                    }
                                  >
                                    {doc.readme}
                                    <ArrowUpRight size={13} />
                                  </button>
                                </dd>
                              </div>
                            )}
                          </dl>
                        </div>
                      </div>
                      <div className="workspace-section-head workspace-spaced">
                        <h2>{t('workspace.tab.domains')}</h2>
                        <button
                          className="text-button"
                          type="button"
                          disabled={installingApplication}
                          onClick={() => setTab('domains')}
                        >
                          {t('workspace.configure')}
                        </button>
                      </div>
                      <div className="workspace-card workspace-domain-list">
                        {domains.map((item) => (
                          <button
                            type="button"
                            className="workspace-domain-row"
                            disabled={installingApplication}
                            key={item.domain}
                            onClick={() => {
                              setDomain(item.domain);
                              setTab('web');
                            }}
                          >
                            <div>
                              <b>{displayProjectDomain(item.domain)}</b>
                              <span>{item.values.web_root || '{base_dir}'}</span>
                            </div>
                            {item.values.primary_domain === 'on' && (
                              <span className="workspace-badge">{t('workspace.primary')}</span>
                            )}
                            <span>
                              {item.values.php_engine || inherited('php_engine', globals?.phpEngine)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {tab === 'domains' && (
                    <>
                      <div className="workspace-card workspace-domain-list">
                        {domains.map((item) => (
                          <button
                            type="button"
                            className={`workspace-domain-row ${domain === item.domain ? 'selected' : ''}`}
                            key={item.domain}
                            onClick={() => setDomain(item.domain)}
                          >
                            <div>
                              <b>{displayProjectDomain(item.domain)}</b>
                              <span>{item.values.web_root || '{base_dir}'}</span>
                            </div>
                            {item.values.primary_domain === 'on' && (
                              <span className="workspace-badge">{t('workspace.primary')}</span>
                            )}
                            {domain === item.domain && <Check size={15} />}
                          </button>
                        ))}
                      </div>
                      <form
                        className="workspace-add-domain"
                        onSubmit={(event) => {
                          event.preventDefault();
                          try {
                            setIni(appendProjectDomain(ini, project.domain, newDomain));
                            setDomain(normalizeProjectDomain(newDomain) ?? domain);
                            setNewDomain('');
                          } catch (error) {
                            setError(errorText(t, error, 'workspace.failed'));
                          }
                        }}
                      >
                        <input
                          aria-label={t('workspace.newDomain')}
                          placeholder="admin.project.test"
                          value={newDomain}
                          disabled={locked}
                          onChange={(event) => setNewDomain(event.target.value)}
                        />
                        <button
                          type="submit"
                          className="secondary-button"
                          disabled={locked || !normalizeProjectDomain(newDomain)}
                        >
                          <Plus size={15} />
                          {t('workspace.addDomain')}
                        </button>
                      </form>
                      <h3 className="workspace-selected-domain">{selectedDomain}</h3>
                      <div className="workspace-card workspace-settings">
                        {text('server_aliases', 'www.{host}')}
                        {choice('primary_domain', ['on', 'off'])}
                        {choice('project_enabled', ['on', 'off'])}
                        {text('project_category')}
                      </div>
                    </>
                  )}
                  {tab === 'environment' && (
                    <>
                      <div className="workspace-card workspace-settings">
                        {choice('http_engine', options?.httpEngines ?? [], globals?.httpEngine)}
                        {choice('php_engine', options?.phpEngines ?? [], globals?.phpEngine)}
                        {choice('node_engine', options?.nodeEngines ?? [], globals?.nodeEngine)}
                        {text('environment', 'System')}
                        {text('app_start_command')}
                        {text('terminal_codepage', '65001')}
                      </div>
                      <h3 className="workspace-selected-domain">{t('workspace.variables')}</h3>
                      {codeEditor}
                    </>
                  )}
                  {tab === 'web' && (
                    <div className="workspace-card workspace-settings">
                      {text('project_root', '{base_dir}')}
                      {text('web_root', '{base_dir}\\public')}
                      {text('base_url', '{host_scheme}://{host_decoded}{scheme_port}')}
                      {text('bind_ip')}
                      {text('http_port', '80', 'number')}
                      {text('https_port', '443', 'number')}
                      {choice('tls_enabled', ['on', 'off'])}
                      {text('tls_cert_file', 'auto')}
                      {text('tls_key_file', 'auto')}
                      {choice('backend_enabled', ['on', 'off'])}
                      {text('backend_ip', '127.0.0.1')}
                      {text('backend_port', '3000', 'number')}
                    </div>
                  )}
                  {tab === 'application' && (
                    <>
                      <div className="workspace-file-tabs">
                        {applicationFiles.map((path) => (
                          <button
                            type="button"
                            className={selectedApplicationFile === path ? 'selected' : ''}
                            aria-pressed={selectedApplicationFile === path}
                            key={path}
                            disabled={locked}
                            onClick={() => setApplicationFile(path)}
                          >
                            {path}
                          </button>
                        ))}
                      </div>
                      {codeEditor}
                    </>
                  )}
                  {tab === 'configs' && (
                    <>
                      <div className="workspace-file-tabs">
                        {['nginx', 'apache', 'caddy'].map((name) => (
                          <button
                            type="button"
                            className={engine === name ? 'selected' : ''}
                            key={name}
                            onClick={() => setEngine(name)}
                          >
                            {name === 'nginx' ? 'Nginx' : name === 'apache' ? 'Apache' : 'Caddy'}
                          </button>
                        ))}
                      </div>
                      {codeEditor}
                      <p className="workspace-hint">
                        <Info size={14} />
                        {t('workspace.localConfigs')}
                      </p>
                    </>
                  )}
                  {tab === 'tasks' &&
                    (fileBusy ? (
                      <div className="empty-note" role="status">
                        {t('common.loading')}
                      </div>
                    ) : files['tasks.ini'] && tasks ? (
                      <Suspense
                        fallback={
                          <div className="empty-note" role="status">
                            {t('common.loading')}
                          </div>
                        }
                      >
                        <div className="workspace-file-head">
                          <div>
                            <FileCode2 size={15} />
                            <b>.osp/tasks.ini</b>
                          </div>
                          <button
                            type="button"
                            className="text-button"
                            disabled={locked || files['tasks.ini'].original === null}
                            onClick={() =>
                              void run(() => openFileExternally(`${project.path}\\.osp\\tasks.ini`))
                            }
                          >
                            {t('configs.open')}
                          </button>
                        </div>
                        <ProjectTasksEditor
                          document={tasksDocument}
                          tasks={tasks}
                          domain={domain}
                          disabled={locked}
                          onChange={setTasks}
                        />
                        {files['tasks.ini'].original === null && (
                          <p className="workspace-hint">{t('workspace.createFile')}</p>
                        )}
                      </Suspense>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={locked}
                        onClick={() => setFileRetry((value) => value + 1)}
                      >
                        {t('workspace.reload')}
                      </button>
                    ))}
                </>
              )}
              {menuVisited && (
                <div hidden={advanced || tab !== 'menu'}>
                  <Suspense
                    fallback={
                      <div className="empty-note" role="status">
                        {t('common.loading')}
                      </div>
                    }
                  >
                    <ProjectMenuEditor
                      project={project}
                      domains={domains.map((item) => item.domain)}
                      installationPath={null}
                      active={tab === 'menu' && !advanced}
                      blocked={busy || installingApplication || blocked}
                      notify={notify}
                      onRestart={onRestartPanel}
                      onStateChange={setMenuState}
                      editorRef={menuEditor}
                      reloadVersion={menuReloadVersion}
                      onSaveRequest={() => void save()}
                      onSaved={() => {
                        setDiagnosticsRevision((value) => value + 1);
                        setRestartNeeded(true);
                      }}
                    />
                  </Suspense>
                </div>
              )}
            </div>
            <footer className="workspace-footer">
              <div>
                <span className={dirty ? 'unsaved' : ''} role="status">
                  {dirty
                    ? t('workspace.unsaved')
                    : restartNeeded
                      ? t('workspace.restartNeeded')
                      : t('workspace.unchanged')}
                </span>
                <div className="workspace-footer-links">
                  <button type="button" className="text-button" onClick={() => setAdvanced(!advanced)}>
                    {t(advanced ? 'workspace.form' : 'workspace.advanced')}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void run(() => openFileExternally(`${project.path}\\.osp\\project.ini`))}
                  >
                    {t('configs.open')}
                  </button>
                </div>
              </div>
              <div className="workspace-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void (async () => {
                      if (await confirmDiscard()) {
                        setAdvanced(false);
                        setMenuReloadVersion((value) => value + 1);
                        await load();
                      }
                    })()
                  }
                >
                  <RefreshCw size={14} />
                  {t('workspace.reload')}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={locked || !dirty || fileBusy}
                  onClick={() => void save()}
                >
                  <Save size={15} />
                  {t('common.save')}
                </button>
              </div>
            </footer>
            <div className="workspace-safety">
              <ShieldCheck size={14} />
              {t('workspace.backupHint')}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
