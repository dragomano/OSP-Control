import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  type GlobalProjectEngines,
  getGlobalProjectEngines,
  getProjectModuleOptions,
  getProjectSettings,
  type OsPanelProject,
  openFileExternally,
  type ProjectModuleOptions,
  type ProjectModuleOverride,
  type ProjectSettings,
  saveProjectSettings,
} from '../../ospanel';
import { type Notify, useDismiss } from '../shared';
import { ModuleSelect } from './ModuleSelect';

export function ProjectModulesDialog({
  project,
  notify,
  onClose,
}: {
  project: OsPanelProject;
  notify: Notify;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<ProjectModuleOptions | null>(null);
  const [saved, setSaved] = useState<ProjectSettings | null>(null);
  const [globalEngines, setGlobalEngines] = useState<GlobalProjectEngines | null>(null);
  const [draft, setDraft] = useState<ProjectModuleOverride | null>(null);
  const [busy, setBusy] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reruns only when the project changes — onClose/notify/t are unstable and would cause a refetch loop
  useEffect(() => {
    void (async () => {
      try {
        const [available, settings, globals] = await Promise.all([
          getProjectModuleOptions(),
          getProjectSettings(project.domain),
          // Global engines are only read from program.dat; a failure does not break
          // the dialog, the global-value hints just won't appear.
          getGlobalProjectEngines().catch(() => null),
        ]);
        setOptions(available);
        setSaved(settings);
        setGlobalEngines(globals);
        setDraft({
          httpEngine: settings.httpEngine,
          phpEngine: settings.phpEngine,
          nodeEngine: settings.nodeEngine,
          // Not edited here (the TLS toggle lives in the project row) — preserved on save.
          tlsEnabled: settings.tlsEnabled,
        });
      } catch (error) {
        notify(errorText(t, error, 'projects.toastModulesFailed'));
        onClose();
      }
    })();
  }, [project.domain]);

  useDismiss(windowRef, onClose);

  const dirty =
    saved !== null &&
    draft !== null &&
    (saved.httpEngine !== draft.httpEngine ||
      saved.phpEngine !== draft.phpEngine ||
      saved.nodeEngine !== draft.nodeEngine);

  const save = async () => {
    if (!draft) return;

    setBusy(true);

    try {
      const next = await saveProjectSettings(project.domain, draft);

      setSaved(next);
      setDraft({
        httpEngine: next.httpEngine,
        phpEngine: next.phpEngine,
        nodeEngine: next.nodeEngine,
        tlsEnabled: next.tlsEnabled,
      });

      notify(t('projects.toastModulesSaved', { domain: project.domain }));
    } catch (error) {
      notify(errorText(t, error, 'projects.toastModulesFailed'));
    } finally {
      setBusy(false);
    }
  };

  const hintFor = (global: string | undefined) => {
    if (!globalEngines) return null;

    return global ? t('projects.globalSet', { value: global }) : t('projects.globalUnset');
  };

  // The note marks the file name with {file} — it is rendered as a link opening project.ini.
  const [noteBefore, noteAfter] = t('projects.modulesFileNote').split('{file}');
  const openIni = async () => {
    try {
      await openFileExternally(`${project.path}\\.osp\\project.ini`);
    } catch (error) {
      notify(errorText(t, error, 'projects.toastFileOpenFailed'));
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-window"
        role="dialog"
        aria-modal="true"
        aria-label={t('projects.menuModules')}
        ref={windowRef}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">{t('projects.menuModules')}</span>
            <h3 className="modal-title">{project.domain}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-hint">{t('projects.modulesHint')}</p>
        {options && draft ? (
          <div className="modal-body">
            <ModuleSelect
              label={t('projects.modulesHttpEngine')}
              value={draft.httpEngine}
              options={options.httpEngines}
              autoLabel={t('projects.modulesAuto')}
              globalHint={hintFor(globalEngines?.httpEngine)}
              onChange={(value) => setDraft({ ...draft, httpEngine: value })}
            />
            <ModuleSelect
              label={t('projects.modulesPhpEngine')}
              value={draft.phpEngine}
              options={options.phpEngines}
              autoLabel={t('projects.modulesAuto')}
              globalHint={hintFor(globalEngines?.phpEngine)}
              onChange={(value) => setDraft({ ...draft, phpEngine: value })}
            />
            <ModuleSelect
              label={t('projects.modulesNodeEngine')}
              value={draft.nodeEngine}
              options={options.nodeEngines}
              autoLabel={t('projects.modulesAuto')}
              globalHint={hintFor(globalEngines?.nodeEngine)}
              onChange={(value) => setDraft({ ...draft, nodeEngine: value })}
            />
          </div>
        ) : (
          <div className="empty-note">{t('common.loading')}</div>
        )}
        <div className="modal-foot">
          <span className="modal-path">
            {saved?.fileExists ? (
              <>
                {noteBefore}
                <button type="button" className="path-link" onClick={() => void openIni()}>
                  {'.osp\\project.ini'}
                </button>
                {noteAfter}
              </>
            ) : (
              t('projects.modulesFileNew')
            )}
          </span>
          <div className="row-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              {t('common.close')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || busy || !draft}
              onClick={() => void save()}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
