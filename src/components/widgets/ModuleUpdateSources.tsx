import { ArrowDown, ChevronRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  MODULE_FAMILIES,
  MODULE_LABELS,
  MODULE_SOURCES_KEY,
  type ModuleFamily,
  type ModuleSources,
  readModuleSources,
  sourceError,
  sourceLines,
  sourceSummary,
} from '../../moduleUpdateSources';
import { useModuleUpdates } from '../../moduleUpdates';
import { flushSettings, settingsFailure, settingsStorage } from '../../settingsStorage';
import { type Notify, useDismiss } from '../shared';

export function ModuleUpdateSources({ notify }: { notify: Notify }) {
  const { t, plural } = useI18n();
  const updates = useModuleUpdates();
  const [sources, setSources] = useState(readModuleSources);
  const [editing, setEditing] = useState<ModuleFamily | null>(null);
  const disabled = updates.busy || updates.checking;
  const save = async (next: ModuleSources) => {
    settingsStorage.setItem(MODULE_SOURCES_KEY, JSON.stringify(next));
    if (!(await flushSettings())) {
      notify(errorText(t, settingsFailure(), 'err.settingsSaveFailed'));
      return false;
    }
    setSources(next);
    updates.reset();
    notify(t('settings.sourcesSaved'));
    setEditing(null);
    return true;
  };
  return (
    <section className="module-sources">
      <h3>{t('settings.sourcesTitle')}</h3>
      <p>{t('settings.sourcesOrder')}</p>
      {MODULE_FAMILIES.map((family) => (
        <div className="module-source-row" key={family}>
          <b>{MODULE_LABELS[family]}</b>
          <div className="module-source-summary">
            <span>{sourceSummary(sources[family]) || t('settings.sourcesEmpty')}</span>
            <small>{plural('settings.sourcesCount', sources[family].length)}</small>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            aria-label={t('settings.sourcesConfigureModule', { module: MODULE_LABELS[family] })}
            onClick={() => setEditing(family)}
          >
            {t('settings.sourcesConfigure')}
            <ChevronRight size={14} />
          </button>
        </div>
      ))}
      {editing && (
        <SourcesDialog
          initialFamily={editing}
          sources={sources}
          disabled={disabled}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </section>
  );
}

function SourcesDialog({
  initialFamily,
  sources,
  disabled,
  onClose,
  onSave,
}: {
  initialFamily: ModuleFamily;
  sources: ModuleSources;
  disabled: boolean;
  onClose: () => void;
  onSave: (sources: ModuleSources) => Promise<boolean>;
}) {
  const { t, plural } = useI18n();
  const [family, setFamily] = useState(initialFamily);
  const [draft, setDraft] = useState(
    () =>
      Object.fromEntries(MODULE_FAMILIES.map((key) => [key, sources[key].join('\n')])) as Record<
        ModuleFamily,
        string
      >,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useDismiss(ref, onClose, !busy);
  useEffect(() => {
    const previous = document.activeElement;
    textarea.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const save = async () => {
    for (const key of MODULE_FAMILIES) {
      const issue = sourceError(draft[key]);
      if (issue) {
        setFamily(key);
        setError(t(issue.key, { line: issue.line }));
        return;
      }
    }
    setBusy(true);
    try {
      const next = Object.fromEntries(
        MODULE_FAMILIES.map((key) => [key, sourceLines(draft[key])]),
      ) as ModuleSources;
      if (!(await onSave(next))) setError(t('settings.sourcesSaveFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay">
      <div
        className="modal-window module-sources-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="module-sources-title"
        ref={ref}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const nodes = ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled)',
          );
          if (!nodes?.length) return;
          const first = nodes[0],
            last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-head">
          <div>
            <h3 className="modal-title" id="module-sources-title">
              {t('settings.sourcesTitle')}
            </h3>
            <p className="modal-hint">{t('settings.sourcesHint')}</p>
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
        <div
          className="settings-nav module-source-tabs"
          role="tablist"
          aria-label={t('settings.sourcesModule')}
        >
          {MODULE_FAMILIES.map((key) => (
            <button
              type="button"
              key={key}
              role="tab"
              id={`source-tab-${key}`}
              aria-controls="module-source-panel"
              aria-selected={family === key}
              className={family === key ? 'selected' : ''}
              disabled={busy}
              onClick={() => {
                setFamily(key);
                setError('');
              }}
            >
              {MODULE_LABELS[key]}
              <span>{sourceLines(draft[key]).length}</span>
            </button>
          ))}
        </div>
        <div id="module-source-panel" role="tabpanel" aria-labelledby={`source-tab-${family}`}>
          <div className="module-source-label">
            <label htmlFor="module-source-urls">{MODULE_LABELS[family]}</label>
            <small>{plural('settings.sourcesCount', sourceLines(draft[family]).length)}</small>
          </div>
          <textarea
            id="module-source-urls"
            ref={textarea}
            value={draft[family]}
            disabled={busy}
            spellCheck={false}
            rows={6}
            maxLength={65568}
            aria-invalid={!!error}
            aria-describedby="module-source-hint module-source-error"
            onChange={(event) => {
              setDraft({ ...draft, [family]: event.target.value });
              setError('');
            }}
          />
          <p className="module-source-hint" id="module-source-hint">
            <ArrowDown size={14} />
            {t('settings.sourcesLines')}
          </p>
          <p className="modal-hint">{t('settings.sourcesFormats')}</p>
          <p className="modal-hint">{t('settings.sourcesEmptyHint')}</p>
        </div>
        <p className="module-source-error" id="module-source-error" role={error ? 'alert' : 'status'}>
          {error || t('settings.sourcesSaveHint')}
        </p>
        <div className="modal-foot">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || disabled}
            onClick={() => void save()}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
