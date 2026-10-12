import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  type CreatedProject,
  createProject,
  getProjectModuleOptions,
  type ProjectModuleOptions,
} from '../../ospanel';
import { type Notify, useDismiss } from '../shared';
import { ModuleSelect } from './ModuleSelect';

export function CreateProjectDialog({
  notify,
  onCreated,
  onRestartPanel,
  onClose,
}: {
  notify: Notify;
  onCreated: (created: CreatedProject) => void;
  onRestartPanel: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<ProjectModuleOptions | null>(null);
  const [domain, setDomain] = useState('');
  const [httpEngine, setHttpEngine] = useState('auto');
  const [phpEngine, setPhpEngine] = useState('auto');
  const [nodeEngine, setNodeEngine] = useState('auto');
  const [busy, setBusy] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const domainRef = useRef<HTMLInputElement>(null);

  // Focus after mounting — otherwise the browser returns it to the previous element.
  useEffect(() => {
    window.setTimeout(() => domainRef.current?.focus(), 0);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: engine options are read once when the dialog opens — onClose/notify/t are unstable and would cause a refetch loop
  useEffect(() => {
    void (async () => {
      try {
        setOptions(await getProjectModuleOptions());
      } catch (error) {
        notify(errorText(t, error, 'projects.toastModulesFailed'));
        onClose();
      }
    })();
  }, []);

  useDismiss(windowRef, onClose);

  const create = async () => {
    if (!domain.trim()) {
      notify(t('err.invalidDomain'));
      return;
    }

    setBusy(true);

    try {
      const created = await createProject({
        domain: domain.trim(),
        httpEngine: httpEngine === 'auto' ? undefined : httpEngine,
        phpEngine: phpEngine === 'auto' ? undefined : phpEngine,
        nodeEngine: nodeEngine === 'auto' ? undefined : nodeEngine,
      });

      onCreated(created);
      notify(t('projects.toastCreated', { domain: created.domain }), {
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
        className="modal-window"
        role="dialog"
        aria-modal="true"
        aria-label={t('projects.createTitle')}
        ref={windowRef}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">{t('projects.new')}</span>
            <h3 className="modal-title">{t('projects.createTitle')}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-hint">{t('projects.createHint')}</p>
        {options ? (
          <div className="modal-body">
            <label className="module-select">
              <span>{t('projects.createDomain')}</span>
              <input
                ref={domainRef}
                type="text"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder={t('projects.createDomainPlaceholder')}
              />
            </label>
            <ModuleSelect
              label={t('projects.createHttpEngine')}
              value={httpEngine}
              options={options.httpEngines}
              autoLabel={t('projects.modulesAuto')}
              globalHint={null}
              onChange={setHttpEngine}
            />
            <ModuleSelect
              label={t('projects.createPhpEngine')}
              value={phpEngine}
              options={options.phpEngines}
              autoLabel={t('projects.modulesAuto')}
              globalHint={null}
              onChange={setPhpEngine}
            />
            <ModuleSelect
              label={t('projects.createNodeEngine')}
              value={nodeEngine}
              options={options.nodeEngines}
              autoLabel={t('projects.modulesAuto')}
              globalHint={null}
              onChange={setNodeEngine}
            />
          </div>
        ) : (
          <div className="empty-note">{t('common.loading')}</div>
        )}
        <div className="modal-foot">
          <span className="modal-path">{domain ? `home/${domain}/.osp/project.ini` : '\u00A0'}</span>
          <div className="row-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              {t('common.close')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!domain.trim() || busy || !options}
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
