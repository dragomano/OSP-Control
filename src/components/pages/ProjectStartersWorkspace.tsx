import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  FileCode2,
  FolderOpen,
  Lock,
  Package,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import { askConfirm } from '../../ospanel';
import {
  deleteProjectStarter,
  listProjectStarters,
  openProjectStartersFolder,
  restoreDefaultProjectStarters,
  saveProjectStarter,
} from '../../projectStarters';
import {
  DEFAULT_STARTERS,
  type ProjectStarterDocument,
  type StarterEntry,
  type StarterInstall,
  type StarterText,
  starterText,
} from '../../projectTemplates';
import type { Notify } from '../shared';
import { ConfigEditor } from '../widgets/ConfigEditor';
import { PageHeader } from '../widgets/PageHeader';
import { ToggleSwitch } from '../widgets/ToggleSwitch';
import './projectWorkspace.css';
import './projectStarters.css';

type Tab = 'general' | 'install' | 'web' | 'files' | 'database' | 'json';
const BUILT_IN = ['empty', 'static'] as const;
const ENGINES = ['nginx', 'apache', 'caddy'] as const;
const DB_ENGINES = ['sqlite', 'mysql', 'mariadb', 'postgresql'] as const;
// Placeholders the creation engine substitutes in starter files and configurations.
const TOKENS: [string, string][] = [
  ['__DOMAIN__', 'starter.token.domain'],
  ['__PHP_ENGINE__', 'starter.token.phpEngine'],
  ['__PHP_PORT__', 'starter.token.phpPort'],
  ['__PORT__', 'starter.token.port'],
  ['__LANGUAGE__', 'starter.token.language'],
];

export function ProjectStartersWorkspace({
  notify,
  onClose,
  onStateChange,
}: {
  notify: Notify;
  onClose: () => void;
  onStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<StarterEntry[]>([]);
  const [draft, setDraft] = useState<ProjectStarterDocument | null>(null);
  const [original, setOriginal] = useState('');
  const [tab, setTab] = useState<Tab>('general');
  const [engine, setEngine] = useState<(typeof ENGINES)[number]>('nginx');
  const [file, setFile] = useState('');
  const [newFile, setNewFile] = useState('files/public/index.php');
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState('');
  const dirty = draft !== null && JSON.stringify(draft) !== original;
  useEffect(() => {
    onStateChange?.({ dirty, busy });
  }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange?.({ dirty: false, busy: false }), [onStateChange]);
  // Until the catalog loads, shipped starters are not "missing" — they are still being read.
  const [loaded, setLoaded] = useState(false);
  const refresh = async () => {
    try {
      setEntries(await listProjectStarters());
    } finally {
      setLoaded(true);
    }
  };
  // The catalog is loaded once; explicit refresh never replaces a dirty draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only catalog load
  useEffect(() => {
    void refresh().catch((e) => notify(errorText(t, e, 'err.projectTemplateInvalid')));
  }, []);
  const discard = async () => !dirty || (await askConfirm(t('starter.discard'), t('starter.title')));
  const select = async (doc: ProjectStarterDocument) => {
    if (busy || !(await discard())) return;
    const next = structuredClone(doc);
    setDraft(next);
    setOriginal(JSON.stringify(next));
    setJson(JSON.stringify(next.manifest, null, 2));
    setTab('general');
    setFile(Object.keys(next.assets).find((p) => p.startsWith('files/')) ?? '');
  };
  const change = (patch: Partial<ProjectStarterDocument['manifest']>) => {
    if (!draft) return;
    const next = { ...draft, manifest: { ...draft.manifest, ...patch } };
    setDraft(next);
    setJson(JSON.stringify(next.manifest, null, 2));
  };
  const asset = (path: string, value: string | null) => {
    if (!draft) return;
    const assets = { ...draft.assets };
    if (value === null) delete assets[path];
    else assets[path] = value;
    setDraft({ ...draft, assets });
  };
  const create = async (copy = false) => {
    if (busy || !(await discard())) return;
    const next = structuredClone(copy && draft ? draft : DEFAULT_STARTERS[0]);
    next.manifest.id = '';
    next.manifest.name = '';
    next.revision = null;
    next.builtin = false;
    setDraft(next);
    setOriginal('');
    setJson(JSON.stringify(next.manifest, null, 2));
    setTab('general');
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      notify(errorText(t, e, 'err.projectTemplateInvalid'));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (!draft) return;
      const saved = await saveProjectStarter(draft);
      setDraft(saved);
      setOriginal(JSON.stringify(saved));
      await refresh();
      notify(t('starter.saved'));
    });
  // Returns a shipped starter to its bundled state, overwriting local edits.
  const restoreShipped = (id: string) =>
    run(async () => {
      if (await askConfirm(t('starter.restoreConfirm', { id }), t('starter.title'))) {
        await restoreDefaultProjectStarters(id);
        setDraft(null);
        await refresh();
      }
    });
  const m = draft?.manifest;
  const shipped = draft !== null && DEFAULT_STARTERS.some((doc) => doc.manifest.id === m?.id);
  const missing = loaded
    ? DEFAULT_STARTERS.filter(
        (doc) => doc.manifest.install && !entries.some((entry) => entry.id === doc.manifest.id),
      )
    : [];
  const idValid = m === undefined || /^[a-z0-9][a-z0-9_-]{0,47}$/.test(m.id);
  // Editors of shipped packages offer "restore the bundled version" instead of a
  // vague global action; deleted shipped packages are restored from the catalog.
  const restoreInEditor = () =>
    run(async () => {
      if (!draft) return;
      if (await askConfirm(t('starter.restoreConfirm', { id: m?.id ?? '' }), t('starter.title'))) {
        await restoreDefaultProjectStarters(draft.manifest.id);
        setDraft(null);
        await refresh();
      }
    });
  const catalog = (
    <div className="starter-catalog">
      <h3>{t('starter.builtin')}</h3>
      <div className="starter-grid">
        {BUILT_IN.map((id) => (
          <div key={id} className="starter-card starter-card-builtin">
            <span className="starter-card-head">
              <Lock size={14} />
              <b>{t(`templates.${id}.name`)}</b>
            </span>
            <small>{t('starter.readonly')}</small>
          </div>
        ))}
      </div>
      <h3>{t('starter.customizable')}</h3>
      <div className="starter-grid">
        {entries.map((entry) => (
          <button
            type="button"
            className="starter-card"
            key={entry.id}
            disabled={busy || !entry.document}
            onClick={() => {
              if (entry.document) void select(entry.document);
            }}
          >
            <span className="starter-card-head">
              {entry.error ? <AlertTriangle size={14} /> : <Package size={14} />}
              <b>{entry.document ? starterText(entry.document.manifest.name, lang) : entry.id}</b>
            </span>
            <small>{entry.error ? t('err.projectTemplateInvalid') : `starters/${entry.id}/`}</small>
            {entry.document && (
              <span className="starter-badges">
                {entry.document.manifest.php && <code className="starter-badge">PHP</code>}
                {entry.document.manifest.node && <code className="starter-badge">Node.js</code>}
                {entry.document.manifest.install && (
                  <code className="starter-badge">{t('starter.installer')}</code>
                )}
              </span>
            )}
          </button>
        ))}
        {missing.map((doc) => (
          <button
            type="button"
            className="starter-card starter-card-missing"
            key={doc.manifest.id}
            disabled={busy}
            onClick={() => void restoreShipped(doc.manifest.id)}
          >
            <span className="starter-card-head">
              <RotateCcw size={14} />
              <b>{starterText(doc.manifest.name, lang)}</b>
            </span>
            <small>{t('starter.missing')}</small>
            <span className="starter-badges">
              <code className="starter-badge">{t('starter.restoreShipped')}</code>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
  const field = (key: string, value: string, onChange: (value: string) => void, disabled = false) => (
    <div className="workspace-setting" key={key}>
      <b>{t(`starter.${key}`)}</b>
      <input
        className="starter-input"
        aria-label={t(`starter.${key}`)}
        disabled={busy || disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
  const area = (key: string, value: string, onChange: (value: string) => void) => (
    <div className="workspace-setting" key={key}>
      <b>{t(`starter.${key}`)}</b>
      <textarea
        className="starter-textarea"
        aria-label={t(`starter.${key}`)}
        rows={3}
        disabled={busy}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
  // Older documents may carry an explicit null section; the editor works with the optional shape.
  const install = m?.install ?? undefined;
  const engineKind = install?.archive ? 'archive' : 'composer';
  const changeInstall = (patch: Partial<StarterInstall>) => {
    if (!draft?.manifest.install) return;
    change({ install: { ...draft.manifest.install, ...patch } });
  };
  const toggleInstall = () => {
    if (!draft || !m) return;
    if (install) {
      change({ install: undefined });
      return;
    }
    change({
      install: {
        title: m.name,
        pending: m.name,
        button: m.name,
        hint: '',
        unsaved: '',
        done: '',
        log: '',
        backup: '',
        phases: {},
        createProject: '',
        archive: undefined,
        scripts: false,
        // biome-ignore lint/suspicious/noThenProperty: the Composer step list is named "then" by the starter manifest
        then: [],
        payload: { composerName: undefined, files: [] },
        env: {},
        envSqlite: {},
        envServer: {},
        sqliteDir: undefined,
        sqliteFallback: false,
        envSource: undefined,
        keep: [],
        console: [],
        consoleWithDb: [],
        randomHex: {},
        configFiles: [],
      },
    });
    setTab('install');
  };
  const switchEngine = (kind: 'composer' | 'archive') => {
    if (!install) return;
    if (kind === 'archive' && !install.archive) {
      changeInstall({
        archive: {
          url: 'https://example.org/package-{version}.zip',
          checksumUrl: undefined,
          maxArchiveBytes: 314572800,
          extract: { fromDir: 'package', to: 'public', requiredFiles: ['index.php'] },
        },
        createProject: '',
      });
    } else if (kind === 'composer' && install.archive) {
      changeInstall({ archive: undefined });
    }
  };
  type InstallTextKey = 'title' | 'pending' | 'button' | 'hint' | 'unsaved' | 'done' | 'log' | 'backup';
  const installText = (key: InstallTextKey) => starterText(install?.[key], lang);
  const changeInstallText = (key: InstallTextKey, value: string) => {
    const current: StarterText | undefined = install?.[key];
    const next: StarterText =
      typeof current === 'string' || current === undefined ? value : { ...current, [lang]: value };
    changeInstall({ [key]: next });
  };
  const phaseValue = (key: string) => starterText(install?.phases[key] ?? '', lang);
  const changePhase = (key: string, value: string) => {
    const current = install?.phases[key];
    const next: StarterText =
      typeof current === 'string' || current === undefined ? value : { ...current, [lang]: value };
    changeInstall({ phases: { ...install?.phases, [key]: next } });
  };
  const mapText = (map: Record<string, string>) =>
    Object.entries(map)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  const parseMap = (value: string): Record<string, string> =>
    Object.fromEntries(
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const split = line.indexOf('=');
          return split > 0 ? [line.slice(0, split).trim(), line.slice(split + 1).trim()] : ['__', '__'];
        })
        .filter(([key]) => key !== '__'),
    );
  const listText = (items: string[]) => items.join('\n');
  const parseList = (value: string): string[] =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const commandText = (steps: string[][]) => steps.map((args) => args.join(' ')).join('\n');
  const parseCommands = (value: string): string[][] => parseList(value).map((line) => line.split(/\s+/));
  const installField = (labelKey: string, value: string, onChange: (value: string) => void) => (
    <div className="workspace-setting" key={labelKey}>
      <b>{t(labelKey)}</b>
      <input
        className="starter-input"
        aria-label={t(labelKey)}
        disabled={busy}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
  const installArea = (labelKey: string, value: string, onChange: (value: string) => void, rows = 3) => (
    <div className="workspace-setting" key={labelKey}>
      <b>{t(labelKey)}</b>
      <textarea
        className="starter-textarea"
        aria-label={t(labelKey)}
        rows={rows}
        disabled={busy}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
  const installSwitch = (key: 'scripts' | 'sqliteFallback', labelKey: string) => (
    <div className="workspace-setting">
      <b>{t(labelKey)}</b>
      <ToggleSwitch
        checked={Boolean(install?.[key])}
        label={t(labelKey)}
        disabled={busy}
        onChange={(value) => changeInstall({ [key]: value } as Partial<StarterInstall>)}
      />
    </div>
  );
  const installTab =
    install !== undefined && m ? (
      <>
        <div className="workspace-setting">
          <b>{t('starter.oneClick')}</b>
          <ToggleSwitch
            checked
            label={t('starter.oneClick')}
            disabled={busy}
            onChange={() => change({ install: undefined })}
          />
        </div>
        <div className="workspace-section-head">
          <h2>{t('starter.texts')}</h2>
          <p>{t('starter.textsHint')}</p>
        </div>
        {installField('starter.installTitle', installText('title'), (value) =>
          changeInstallText('title', value),
        )}
        {installField('starter.installButton', installText('button'), (value) =>
          changeInstallText('button', value),
        )}
        {installField('starter.installPending', installText('pending'), (value) =>
          changeInstallText('pending', value),
        )}
        {installField('starter.installDone', installText('done'), (value) =>
          changeInstallText('done', value),
        )}
        {installField('starter.installLog', installText('log'), (value) => changeInstallText('log', value))}
        {installField('starter.installBackup', installText('backup'), (value) =>
          changeInstallText('backup', value),
        )}
        {installArea(
          'starter.installHint',
          installText('hint'),
          (value) => changeInstallText('hint', value),
          2,
        )}
        {installArea('starter.installUnsaved', installText('unsaved'), (value) =>
          changeInstallText('unsaved', value),
        )}
        <div className="workspace-section-head">
          <h2>{t('starter.phases')}</h2>
          <p>{t('starter.phasesHint')}</p>
        </div>
        {(
          [
            'preparing',
            'installing',
            'publishing',
            'database',
            'configuring',
            'downloading',
            'extracting',
          ] as const
        ).map((key) =>
          installField(`starter.phase.${key}`, phaseValue(key), (value) => changePhase(key, value)),
        )}
        <div className="workspace-setting">
          <b>{t('starter.engine')}</b>
          <div className="starter-chips">
            <button
              type="button"
              className={`starter-chip ${engineKind === 'composer' ? 'selected' : ''}`}
              disabled={busy}
              onClick={() => switchEngine('composer')}
            >
              {t('starter.engineComposer')}
            </button>
            <button
              type="button"
              className={`starter-chip ${engineKind === 'archive' ? 'selected' : ''}`}
              disabled={busy}
              onClick={() => switchEngine('archive')}
            >
              {t('starter.engineArchive')}
            </button>
          </div>
        </div>
        <p className="workspace-hint">{t('starter.engineHint')}</p>
        {engineKind === 'composer' ? (
          <>
            {installField('starter.createProject', install.createProject, (value) =>
              changeInstall({ createProject: value }),
            )}
            {installSwitch('scripts', 'starter.scripts')}
            {installField('starter.payloadName', install.payload.composerName ?? '', (value) =>
              changeInstall({ payload: { ...install.payload, composerName: value || undefined } }),
            )}
            {installArea('starter.payloadFiles', listText(install.payload.files), (value) =>
              changeInstall({ payload: { ...install.payload, files: parseList(value) } }),
            )}
            {installArea('starter.then', commandText(install.then), (value) => {
              const patch: Partial<StarterInstall> = {};
              // biome-ignore lint/suspicious/noThenProperty: the Composer step list is named "then" by the starter manifest
              (patch as { then?: string[][] }).then = parseCommands(value);
              changeInstall(patch);
            })}
            {installArea('starter.console', commandText(install.console), (value) =>
              changeInstall({ console: parseCommands(value) }),
            )}
            {installArea('starter.consoleWithDb', commandText(install.consoleWithDb), (value) =>
              changeInstall({ consoleWithDb: parseCommands(value) }),
            )}
          </>
        ) : (
          install.archive &&
          (() => {
            const archive = install.archive;
            return (
              <>
                {installField('starter.releaseUrl', archive.release?.url ?? '', (value) =>
                  changeInstall({
                    archive: {
                      ...archive,
                      release: value.trim()
                        ? { url: value.trim(), path: archive.release?.path ?? [] }
                        : undefined,
                    },
                  }),
                )}
                {installField('starter.releasePath', archive.release?.path.join('.') ?? '', (value) =>
                  changeInstall({
                    archive: {
                      ...archive,
                      release: {
                        url: archive.release?.url ?? '',
                        path: parseList(value).map((part) => part.replace(/^\.+|\.$/g, '')),
                      },
                    },
                  }),
                )}
                {installField('starter.archiveUrl', archive.url, (value) =>
                  changeInstall({ archive: { ...archive, url: value } }),
                )}
                {installField('starter.checksumUrl', archive.checksumUrl ?? '', (value) =>
                  changeInstall({ archive: { ...archive, checksumUrl: value || undefined } }),
                )}
                {installField('starter.maxArchiveBytes', String(archive.maxArchiveBytes), (value) =>
                  changeInstall({ archive: { ...archive, maxArchiveBytes: Number(value) || 0 } }),
                )}
                {installField('starter.extractFromDir', archive.extract.fromDir, (value) =>
                  changeInstall({ archive: { ...archive, extract: { ...archive.extract, fromDir: value } } }),
                )}
                {installField('starter.extractTo', archive.extract.to, (value) =>
                  changeInstall({ archive: { ...archive, extract: { ...archive.extract, to: value } } }),
                )}
                {installArea('starter.requiredFiles', listText(archive.extract.requiredFiles), (value) =>
                  changeInstall({
                    archive: { ...archive, extract: { ...archive.extract, requiredFiles: parseList(value) } },
                  }),
                )}
              </>
            );
          })()
        )}
        <div className="workspace-section-head">
          <h2>{t('starter.envTitle')}</h2>
          <p>{t('starter.envHint')}</p>
        </div>
        {installField('starter.envSource', install.envSource ?? '', (value) =>
          changeInstall({ envSource: value || undefined }),
        )}
        {installArea('starter.env', mapText(install.env), (value) => changeInstall({ env: parseMap(value) }))}
        {installArea('starter.envSqlite', mapText(install.envSqlite), (value) =>
          changeInstall({ envSqlite: parseMap(value) }),
        )}
        {installArea('starter.envServer', mapText(install.envServer), (value) =>
          changeInstall({ envServer: parseMap(value) }),
        )}
        {installField('starter.sqliteDir', install.sqliteDir ?? '', (value) =>
          changeInstall({ sqliteDir: value || undefined }),
        )}
        {installSwitch('sqliteFallback', 'starter.sqliteFallback')}
        <div className="workspace-section-head">
          <h2>{t('starter.keepTitle')}</h2>
          <p>{t('starter.keepHint')}</p>
        </div>
        {installArea('starter.keep', listText(install.keep ?? []), (value) =>
          changeInstall({ keep: parseList(value) }),
        )}
        <div className="workspace-section-head">
          <h2>{t('starter.randomTitle')}</h2>
          <p>{t('starter.randomHint')}</p>
        </div>
        {installArea(
          'starter.randomHex',
          Object.entries(install.randomHex)
            .map(([name, bytes]) => `${name}=${bytes}`)
            .join('\n'),
          (value) =>
            changeInstall({
              randomHex: Object.fromEntries(
                Object.entries(parseMap(value)).map(([name, bytes]) => [name, Number(bytes) || 0] as const),
              ),
            }),
        )}
        <div className="workspace-section-head">
          <h2>{t('starter.configTitle')}</h2>
          <p>{t('starter.configHint')}</p>
        </div>
        {installArea(
          'starter.configFiles',
          install.configFiles.map((file) => `${file.template}=${file.to}`).join('\n'),
          (value) =>
            changeInstall({
              configFiles: Object.entries(parseMap(value)).map(
                ([template, to]) => ({ template, to }) as const,
              ),
            }),
        )}
      </>
    ) : (
      <div className="workspace-card starter-empty-config">
        <p>{t('starter.oneClickOff')}</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => toggleInstall()}>
          <Plus size={14} />
          {t('starter.oneClickOn')}
        </button>
      </div>
    );
  const editor = draft && m && (
    <>
      <div className="workspace-tabs" role="tablist">
        {(['general', 'install', 'web', 'files', 'database', 'json'] as Tab[]).map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'selected' : ''}
            key={item}
            onClick={() => setTab(item)}
          >
            {t(`starter.tab.${item}`)}
          </button>
        ))}
      </div>
      <div className="workspace-card starter-panel">
        {tab === 'general' && (
          <>
            <div className="workspace-section-head">
              <h2>{t('starter.tab.general')}</h2>
              <p>{t('starter.generalHint')}</p>
            </div>
            {!idValid && (
              <p className="workspace-error" role="alert">
                {t('err.projectTemplateInvalid')}
              </p>
            )}
            {field('id', m.id, (id) => change({ id }), !!draft.revision)}
            {field('name', starterText(m.name, lang), (name) =>
              change({ name: typeof m.name === 'string' ? name : { ...m.name, [lang]: name } }),
            )}
            {field('projectRoot', m.projectRoot, (projectRoot) => change({ projectRoot }))}
            {field('webRoot', m.webRoot ?? '', (webRoot) => change({ webRoot: webRoot || null }))}
            {area('description', starterText(m.description, lang), (description) =>
              change({
                description:
                  typeof m.description === 'string' ? description : { ...m.description, [lang]: description },
              }),
            )}
            {area('nextStep', starterText(m.nextStep, lang), (nextStep) =>
              change({
                nextStep: typeof m.nextStep === 'string' ? nextStep : { ...m.nextStep, [lang]: nextStep },
              }),
            )}
            <div className="workspace-setting">
              <b>{t('starter.httpPreference')}</b>
              <div className="starter-chips">
                {(['any', 'apache', 'nginx', 'caddy'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`starter-chip ${m.httpPreference === value ? 'selected' : ''}`}
                    disabled={busy}
                    onClick={() => change({ httpPreference: value })}
                  >
                    {value === 'any' ? t('starter.any') : value}
                  </button>
                ))}
              </div>
            </div>
            <div className="workspace-setting">
              <b>{t('starter.runtimes')}</b>
              <div className="starter-chips">
                {(['php', 'node'] as const).map((runtime) => (
                  <button
                    type="button"
                    key={runtime}
                    className={`starter-chip ${m[runtime] ? 'selected' : ''}`}
                    disabled={busy}
                    onClick={() => change({ [runtime]: !m[runtime] })}
                  >
                    {runtime === 'php' ? 'PHP' : 'Node.js'}
                  </button>
                ))}
              </div>
            </div>
            {/* Not a <label>: ConfigEditor's textarea is named through its own aria-label. */}
            <div className="workspace-file-section">
              <div className="workspace-file-head">
                <div>
                  <FileCode2 size={13} />
                  <b>{t('starter.settings')}</b>
                </div>
              </div>
              <ConfigEditor
                file="settings.json"
                label={t('starter.settings')}
                value={JSON.stringify(m.settings, null, 2)}
                disabled={busy}
                onChange={(value) => {
                  try {
                    change({ settings: JSON.parse(value) });
                  } catch {
                    /* Keep the last valid settings; advanced JSON supports incomplete drafts. */
                  }
                }}
              />
            </div>
          </>
        )}
        {tab === 'install' && installTab}
        {tab === 'web' && (
          <>
            <div className="workspace-section-head">
              <h2>{t('starter.tab.web')}</h2>
              <p>{t('starter.webHint')}</p>
            </div>
            <div className="workspace-file-tabs">
              {ENGINES.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={`${engine === item ? 'selected' : ''} ${
                    `${item}.conf` in draft.assets ? 'starter-has-file' : ''
                  }`}
                  onClick={() => setEngine(item)}
                >
                  <FileCode2 size={13} />
                  {item}
                </button>
              ))}
            </div>
            <p className="workspace-hint">
              <AlertTriangle size={13} />
              {t(engine === 'apache' ? 'starter.apacheHint' : 'starter.replaceHint')}
            </p>
            {`${engine}.conf` in draft.assets ? (
              <div className="workspace-file-section">
                <div className="workspace-file-head">
                  <div>
                    <FileCode2 size={13} />
                    <b>{`.osp/${engine}/${m.id || '<id>'}.conf`}</b>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => asset(`${engine}.conf`, null)}
                  >
                    {t('starter.deleteFile')}
                  </button>
                </div>
                <ConfigEditor
                  file={`${engine}.conf`}
                  label={t('starter.config')}
                  value={draft.assets[`${engine}.conf`]}
                  disabled={busy}
                  onChange={(value) => asset(`${engine}.conf`, value)}
                />
              </div>
            ) : (
              <div className="workspace-card starter-empty-config">
                <p>{t('starter.webNone')}</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    asset(
                      `${engine}.conf`,
                      DEFAULT_STARTERS.find((doc) => doc.manifest.id === 'symfony')?.assets[
                        `${engine}.conf`
                      ] ?? '',
                    )
                  }
                >
                  <Plus size={14} />
                  {t('starter.createConf')}
                </button>
              </div>
            )}
            <div className="workspace-section-head">
              <h2>{t('starter.tokens')}</h2>
            </div>
            <table className="starter-token-table">
              <thead>
                <tr>
                  <th>{t('starter.tokenVariable')}</th>
                  <th>{t('starter.tokenDescription')}</th>
                </tr>
              </thead>
              <tbody>
                {TOKENS.map(([token, key]) => (
                  <tr key={token}>
                    <td>
                      <code>{token}</code>
                    </td>
                    <td>{t(key)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === 'files' && (
          <>
            <div className="workspace-section-head">
              <h2>{t('starter.tab.files')}</h2>
              <p>{t('starter.filesHint')}</p>
            </div>
            <div className="workspace-setting">
              <b>{t('starter.directories')}</b>
              <textarea
                className="starter-textarea"
                aria-label={t('starter.directories')}
                rows={2}
                value={m.directories.join('\n')}
                disabled={busy}
                onChange={(e) => change({ directories: e.target.value.split('\n') })}
              />
            </div>
            <div className="starter-file-row">
              <input
                aria-label={t('starter.path')}
                value={newFile}
                disabled={busy}
                placeholder="files/public/index.php"
                onChange={(e) => setNewFile(e.target.value)}
              />
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !newFile || newFile in draft.assets}
                onClick={() => {
                  asset(newFile, '');
                  setFile(newFile);
                }}
              >
                <Plus size={14} />
                {t('starter.addFile')}
              </button>
            </div>
            <div className="workspace-file-tabs">
              {Object.keys(draft.assets)
                .filter((p) => p.startsWith('files/') || p.startsWith('docs/'))
                .map((path) => (
                  <button
                    type="button"
                    key={path}
                    className={file === path ? 'selected' : ''}
                    onClick={() => setFile(path)}
                  >
                    {path}
                  </button>
                ))}
            </div>
            {file in draft.assets ? (
              <div className="workspace-file-section">
                <div className="workspace-file-head">
                  <div>
                    <FileCode2 size={13} />
                    <b>{file}</b>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => asset(file, null)}
                  >
                    {t('starter.deleteFile')}
                  </button>
                </div>
                <ConfigEditor
                  file={file}
                  label={file}
                  value={draft.assets[file]}
                  disabled={busy}
                  onChange={(value) => asset(file, value)}
                />
              </div>
            ) : (
              <p className="empty-note">{t('starter.selectFile')}</p>
            )}
          </>
        )}
        {tab === 'database' && (
          <>
            <div className="workspace-section-head">
              <h2>{t('starter.tab.database')}</h2>
              <p>{t('starter.databaseHint')}</p>
            </div>
            <div className="workspace-setting">
              <b>{t('starter.databaseEnabled')}</b>
              <ToggleSwitch
                checked={m.database.enabled}
                label={t('starter.databaseEnabled')}
                disabled={busy}
                onChange={(value) => change({ database: { ...m.database, enabled: value } })}
              />
            </div>
            <div className="workspace-setting">
              <b>{t('starter.databaseEngines')}</b>
              <div className="starter-chips">
                {DB_ENGINES.map((name) => (
                  <button
                    type="button"
                    key={name}
                    className={`starter-chip ${m.database.engines.includes(name) ? 'selected' : ''}`}
                    disabled={busy || !m.database.enabled}
                    onClick={() =>
                      change({
                        database: {
                          ...m.database,
                          engines: m.database.engines.includes(name)
                            ? m.database.engines.filter((item) => item !== name)
                            : [...m.database.engines, name],
                        },
                      })
                    }
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <div className="workspace-setting">
              <b>{t('starter.databaseDefault')}</b>
              <div className="starter-chips">
                {['none', ...m.database.engines].map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`starter-chip ${m.database.defaultEngine === value ? 'selected' : ''}`}
                    disabled={busy || !m.database.enabled}
                    onClick={() => change({ database: { ...m.database, defaultEngine: value } })}
                  >
                    {value === 'none' ? t('projectDb.later') : value}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {tab === 'json' && (
          <>
            <div className="workspace-section-head">
              <h2>starter.json</h2>
              <p>{t('starter.jsonHint')}</p>
            </div>
            <ConfigEditor
              file="starter.json"
              label="starter.json"
              value={json}
              disabled={busy}
              onChange={(value) => {
                setJson(value);
                try {
                  setDraft({ ...draft, manifest: JSON.parse(value) });
                } catch {
                  /* Incomplete JSON stays in the editor until corrected. */
                }
              }}
            />
          </>
        )}
      </div>
    </>
  );
  return (
    <section className="project-workspace starter-workspace">
      <button
        type="button"
        className="text-button workspace-back"
        disabled={busy}
        onClick={() =>
          void (draft
            ? discard().then((ok) => {
                if (ok) {
                  setDraft(null);
                  setTab('general');
                }
              })
            : discard().then((ok) => {
                if (ok) onClose();
              }))
        }
      >
        <ArrowLeft size={15} />
        {draft ? t('starter.allTemplates') : t('workspace.allProjects')}
      </button>
      <PageHeader
        eyebrow={t('nav.projects')}
        heading={draft ? starterText(m?.name, lang) || t('starter.new') : t('starter.title')}
        description={draft ? `starters/${m?.id}/` : t('starter.hint')}
        action={
          <div className="row-actions">
            {draft ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void create(true)}
                >
                  <Copy size={15} />
                  {t('starter.duplicate')}
                </button>
                {shipped && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void restoreInEditor()}
                  >
                    <RotateCcw size={15} />
                    {t('starter.restore')}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !draft.revision}
                  onClick={() =>
                    void run(async () => {
                      if (await askConfirm(t('starter.deleteConfirm'), t('starter.title'))) {
                        await deleteProjectStarter(draft);
                        setDraft(null);
                        await refresh();
                      }
                    })
                  }
                >
                  <Trash2 size={15} />
                  {t('starter.delete')}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || !dirty || !idValid}
                  onClick={() => void save()}
                >
                  <Save size={15} />
                  {t('common.save')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void run(openProjectStartersFolder)}
                >
                  <FolderOpen size={15} />
                  {t('starter.folder')}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void create()}
                >
                  <Plus size={15} />
                  {t('starter.new')}
                </button>
              </>
            )}
          </div>
        }
      />
      {draft ? editor : catalog}
    </section>
  );
}
