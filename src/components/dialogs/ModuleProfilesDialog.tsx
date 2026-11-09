import {
  Check,
  Copy,
  FileCode2,
  FolderOpen,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightConfig } from '../../highlight';
import { errorText, useI18n } from '../../i18n';
import {
  type ModuleProfiles,
  type ProfileDocument,
  profileNameExists,
  validProfileName,
} from '../../moduleProfiles';
import {
  askConfirm,
  createModuleProfile,
  deleteModuleProfile,
  listModuleProfiles,
  openProjectFolder,
  readModuleProfile,
  readProfileFile,
  renameModuleProfile,
  saveProfileFile,
} from '../../ospanel';
import { type Notify, type Service, useDismiss } from '../shared';
import { RowMenu } from '../widgets/RowMenu';
import './moduleProfiles.css';

export function ModuleProfilesDialog({
  service,
  blocked,
  notify,
  onClose,
  onActivate,
  onBusyChange,
}: {
  service: Service;
  blocked: boolean;
  notify: Notify;
  onClose: () => void;
  onActivate: (profile: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [list, setList] = useState<ModuleProfiles | null>(null);
  const [selected, setSelected] = useState('');
  const [document, setDocument] = useState<ProfileDocument | null>(null);
  const [file, setFile] = useState('settings.ini');
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'edit' | 'create' | 'rename'>('edit');
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [copyData, setCopyData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [backup, setBackup] = useState('');
  const pending = useRef(false);
  const request = useRef(0);
  const windowRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLPreElement>(null);
  const dirty = original !== null && draft !== original;
  const locked = busy || blocked || loading;
  const profile = list?.profiles.find((item) => item.name === selected);
  const selectedBase = list?.profiles.find((item) => item.name === base);
  const exists = list ? profileNameExists(list.profiles, name.trim()) : false;
  const nameValid = validProfileName(name.trim()) && !exists;
  const highlighted = useMemo(() => highlightConfig(file, draft, service.name), [file, draft, service.name]);

  const discard = async () => !dirty || askConfirm(t('profiles.discard'), t('common.confirmTitle'));
  const dismiss = async () => {
    if (!pending.current && !blocked && (await discard())) onClose();
  };
  useDismiss(windowRef, () => void dismiss());

  useEffect(() => {
    const previous = window.document.activeElement;
    windowRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (mode !== 'edit') nameRef.current?.focus();
  }, [mode]);

  const open = async (next: string, nextFile = 'settings.ini') => {
    const id = ++request.current;
    setSelected(next);
    setFile(nextFile);
    setOriginal(null);
    setDraft('');
    setDocument(null);
    setLoading(true);
    setError('');
    setMode('edit');
    try {
      const doc = await readModuleProfile(service.name, next);
      if (id !== request.current) return;
      setDocument(doc);
      const text = await readProfileFile(service.name, next, nextFile);
      if (id !== request.current) return;
      setOriginal(text);
      setDraft(text);
    } catch (error) {
      if (id === request.current) setError(errorText(t, error, 'err.profileFailed'));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  const reload = async (preferred?: string) => {
    const next = await listModuleProfiles(service.name);
    setList(next);
    const choice =
      next.profiles.find((p) => p.name === preferred)?.name ??
      next.profiles.find((p) => p.name === next.active)?.name ??
      next.profiles[0]?.name;
    if (choice) await open(choice);
    else {
      setLoading(false);
      setSelected('');
      setDocument(null);
      setOriginal(null);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load on module changes; changing translator/callback identities must not discard edits
  useEffect(() => {
    void reload().catch((error) => {
      setError(errorText(t, error, 'err.profileFailed'));
      setLoading(false);
    });
    return () => {
      request.current += 1;
    };
  }, [service.name]);

  const run = async (operation: () => Promise<void>, mutation = true) => {
    if (pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    if (mutation) onBusyChange(true);
    try {
      await operation();
    } catch (error) {
      setError(errorText(t, error, 'err.profileFailed'));
    } finally {
      if (mutation) onBusyChange(false);
      pending.current = false;
      setBusy(false);
    }
  };
  const startCreate = async () => {
    if (locked || !(await discard())) return;
    setDraft(original ?? '');
    setMode('create');
    setName('');
    setBase(selected || list?.profiles[0]?.name || '$factory');
    setCopyData(Boolean(profile?.hasData && !list?.factoryData));
    setError('');
    setMessage('');
  };
  const save = () => {
    if (locked || !dirty || original === null) return;
    void run(async () => {
      const saved = await saveProfileFile(service.name, selected, file, original, draft);
      setOriginal(saved.content);
      setDraft(saved.content);
      setBackup(saved.backupPath);
      setMessage(t('profiles.saved'));
    });
  };
  const createOrRename = () => {
    if (locked || !nameValid || !list) return;
    void (async () => {
      if (
        mode === 'create' &&
        copyData &&
        selectedBase?.hasData &&
        !(await askConfirm(t('profiles.copyDataConfirm', { name: service.name }), t('common.confirmTitle')))
      )
        return;
      await run(async () => {
        if (mode === 'rename') await renameModuleProfile(service.name, selected, name.trim());
        else await createModuleProfile(service.name, name.trim(), base, base === '$factory', copyData);
        await reload(name.trim());
        setMessage(t(mode === 'rename' ? 'profiles.renamed' : 'profiles.created'));
      });
    })();
  };
  const remove = async () => {
    if (locked || !profile || profile.builtin || selected === list?.active || !(await discard())) return;
    if (!(await askConfirm(t('profiles.deleteConfirm', { profile: selected }), t('common.confirmTitle'))))
      return;
    await run(async () => {
      const path = await deleteModuleProfile(service.name, selected);
      await reload();
      setBackup(path);
      setMessage(t('profiles.deleted'));
    });
  };
  const activate = async () => {
    if (locked || dirty || !list?.online) return;
    if (
      !(await askConfirm(
        t('profiles.activateConfirm', { profile: selected, name: service.name }),
        t('common.confirmTitle'),
      ))
    )
      return;
    await run(async () => {
      await onActivate(selected);
      await reload(selected);
      setMessage(t('profiles.activated', { profile: selected }));
    }, false);
  };
  const select = async (next: string, nextFile?: string) => {
    if (!locked && (await discard())) {
      setMessage('');
      await open(next, nextFile);
    }
  };
  const rename = async () => {
    if (locked || !(await discard())) return;
    setDraft(original ?? '');
    setMode('rename');
    setName(selected);
    setError('');
    setMessage('');
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-window profiles-window"
        role="dialog"
        aria-modal="true"
        aria-label={t('profiles.title', { name: service.name })}
        ref={windowRef}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = windowRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
          );
          if (!controls?.length) return;
          const first = controls[0],
            last = controls[controls.length - 1];
          if (event.shiftKey && event.target === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && event.target === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="modal-head profiles-head">
          <div>
            <h3 className="modal-title">{t('profiles.title', { name: service.name })}</h3>
            <p className="modal-hint">{t('profiles.subtitle')}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={busy || blocked}
            onClick={() => void dismiss()}
            aria-label={t('common.close')}
          >
            <X size={17} />
          </button>
        </header>
        <div className="profiles-layout">
          <aside className="profiles-sidebar" aria-label={t('profiles.list')}>
            <span className="profiles-list-label">{t('profiles.list')}</span>
            {list?.profiles.map((item) => (
              <button
                type="button"
                className={`profiles-item ${selected === item.name && mode === 'edit' ? 'selected' : ''}`}
                disabled={locked}
                key={item.name}
                onClick={() => void select(item.name)}
                aria-pressed={selected === item.name && mode === 'edit'}
              >
                <b>{item.name}</b>
                <span>
                  {t(
                    item.name === list.active
                      ? 'profiles.active'
                      : item.builtin
                        ? 'profiles.builtin'
                        : 'profiles.custom',
                  )}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="secondary-button profiles-create"
              disabled={locked || !list || (!list.profiles.length && !list.factoryAvailable)}
              onClick={() => void startCreate()}
            >
              <Plus size={14} />
              {t('profiles.create')}
            </button>
            <button
              type="button"
              className="text-button profiles-reload"
              disabled={locked}
              onClick={() => {
                void (async () => {
                  if (await discard()) await run(() => reload(selected), false);
                })();
              }}
            >
              <RefreshCw size={13} />
              {t('profiles.reload')}
            </button>
          </aside>
          <section className="profiles-content" aria-busy={busy || loading}>
            {!list?.online && list && <p className="profiles-note">{t('profiles.offline')}</p>}
            {mode === 'edit' ? (
              <>
                {selected && (
                  <div className="profiles-editor-heading">
                    <h4>{selected}</h4>
                    {profile?.builtin && <span className="profiles-badge">{t('profiles.builtin')}</span>}
                    {selected === list?.active && (
                      <span className="profiles-badge active">{t('profiles.active')}</span>
                    )}
                    {dirty && <span className="profiles-badge changed">{t('profiles.changed')}</span>}
                    <RowMenu
                      entries={[
                        {
                          label: t('profiles.copy'),
                          icon: Copy,
                          disabled: locked,
                          onSelect: () => void startCreate(),
                        },
                        {
                          label: t('profiles.rename'),
                          icon: Pencil,
                          disabled: locked || profile?.builtin || selected === list?.active || !list?.online,
                          onSelect: () => void rename(),
                        },
                        {
                          label: t('profiles.delete'),
                          icon: Trash2,
                          danger: true,
                          disabled: locked || profile?.builtin || selected === list?.active || !list?.online,
                          onSelect: () => void remove(),
                        },
                      ]}
                    />
                  </div>
                )}
                {document && (
                  <>
                    <div className="profiles-path">{document.path}</div>
                    <fieldset className="profiles-files" aria-label={t('profiles.files')}>
                      {document.files.map((item) => (
                        <button
                          type="button"
                          disabled={locked}
                          className={`profiles-file ${item.name === file ? 'selected' : ''}`}
                          aria-pressed={item.name === file}
                          key={item.name}
                          onClick={() => void select(selected, item.name)}
                        >
                          <FileCode2 size={13} />
                          {item.name}
                        </button>
                      ))}
                    </fieldset>
                  </>
                )}
                {loading ? (
                  <div className="empty-note">{t('common.loading')}</div>
                ) : (
                  original !== null && (
                    <div className="profiles-code editor-preview">
                      <pre aria-hidden="true" ref={codeRef}>
                        <code
                          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightConfig escapes all source text
                          dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }}
                        />
                      </pre>
                      <textarea
                        aria-label={t('profiles.fileContent', { file })}
                        value={draft}
                        disabled={busy || blocked}
                        spellCheck={false}
                        wrap="off"
                        onChange={(event) => setDraft(event.target.value)}
                        onScroll={(event) => {
                          if (codeRef.current) {
                            codeRef.current.scrollTop = event.currentTarget.scrollTop;
                            codeRef.current.scrollLeft = event.currentTarget.scrollLeft;
                          }
                        }}
                      />
                    </div>
                  )
                )}
                {original !== null && (
                  <div className="profiles-safety">
                    <ShieldCheck size={14} />
                    {t('profiles.backupHint')}
                  </div>
                )}
              </>
            ) : (
              <form
                className="profiles-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  createOrRename();
                }}
              >
                <h4>{t(mode === 'rename' ? 'profiles.rename' : 'profiles.new')}</h4>
                <label className="module-select">
                  {t('profiles.name')}
                  <input
                    ref={nameRef}
                    value={name}
                    disabled={locked}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={100}
                    autoComplete="off"
                  />
                  <span className="select-hint">{t('profiles.nameHint')}</span>
                </label>
                {name && (!validProfileName(name.trim()) || exists) && (
                  <span className="profiles-error" role="alert">
                    {t(exists ? 'err.profileExists' : 'err.profileName')}
                  </span>
                )}
                {mode === 'create' && (
                  <>
                    <label className="module-select">
                      {t('profiles.base')}
                      <select
                        value={base}
                        disabled={locked}
                        onChange={(event) => {
                          const value = event.target.value;
                          setBase(value);
                          setCopyData(
                            Boolean(
                              value !== '$factory' &&
                                list?.profiles.find((p) => p.name === value)?.hasData &&
                                !list?.factoryData,
                            ),
                          );
                        }}
                      >
                        {list?.profiles.map((p) => (
                          <option value={p.name} key={p.name}>
                            {p.name}
                          </option>
                        ))}
                        {list?.factoryAvailable && <option value="$factory">{t('profiles.factory')}</option>}
                      </select>
                    </label>
                    {(selectedBase?.hasData || list?.factoryData) && (
                      <label className="module-select">
                        {t('profiles.data')}
                        <select
                          value={String(copyData)}
                          disabled={locked || base === '$factory'}
                          onChange={(event) => setCopyData(event.target.value === 'true')}
                        >
                          <option value="false" disabled={!list?.factoryData && selectedBase?.hasData}>
                            {t('profiles.cleanData')}
                          </option>
                          <option value="true" disabled={!selectedBase?.hasData || base === '$factory'}>
                            {t('profiles.copyData')}
                          </option>
                        </select>
                        <span className="select-hint">{t('profiles.dataHint')}</span>
                      </label>
                    )}
                    <p className="profiles-note">{t('profiles.createHint')}</p>
                  </>
                )}
                {mode === 'rename' && <p className="profiles-note">{t('profiles.renameHint')}</p>}
                <div className="row-actions">
                  <button type="submit" className="primary-button" disabled={locked || !nameValid}>
                    <Plus size={14} />
                    {t(mode === 'rename' ? 'profiles.rename' : 'profiles.create')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || blocked}
                    onClick={() => setMode('edit')}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </form>
            )}
            {error && (
              <p className="profiles-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="profiles-note" role="status">
                {message}
              </p>
            )}
            {backup && (
              <button
                type="button"
                className="text-button profiles-backup"
                title={backup}
                onClick={() =>
                  void openProjectFolder(backup).catch((error) =>
                    notify(errorText(t, error, 'err.profileFailed')),
                  )
                }
              >
                <FolderOpen size={14} />
                {t('profiles.openBackup')}
              </button>
            )}
          </section>
        </div>
        {mode === 'edit' && (
          <footer className="modal-foot profiles-foot">
            <span className="modal-path">{t('profiles.saveHint')}</span>
            <div className="row-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={locked || dirty || !selected || !list?.online}
                onClick={() => void activate()}
              >
                <Layers size={14} />
                {t(selected === list?.active ? 'profiles.apply' : 'profiles.activate')}
              </button>
              <button type="button" className="primary-button" disabled={locked || !dirty} onClick={save}>
                <Check size={14} />
                {t('common.save')}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
