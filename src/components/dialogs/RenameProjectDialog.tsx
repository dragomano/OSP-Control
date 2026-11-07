import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import { type OsPanelProject, renameProject } from '../../ospanel';
import { displayProjectDomain, normalizeProjectDomain } from '../../projectDomain';
import { useDismiss } from '../shared';

export function RenameProjectDialog({
  project,
  projects,
  onRenamed,
  onClose,
}: {
  project: OsPanelProject;
  projects: OsPanelProject[];
  onRenamed: (project: OsPanelProject) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [domain, setDomain] = useState(() => displayProjectDomain(project.domain));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const newDomain = normalizeProjectDomain(domain);
  const unchanged = newDomain === normalizeProjectDomain(project.domain);
  const valid = newDomain !== null;
  const exists =
    valid && !unchanged && projects.some((item) => normalizeProjectDomain(item.domain) === newDomain);
  const dismiss = () => {
    if (!pending.current) onClose();
  };
  useDismiss(windowRef, dismiss);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const rename = async () => {
    if (pending.current || unchanged || !newDomain || exists) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const renamed = await renameProject(project, newDomain);
      onRenamed({ ...project, ...renamed });
      onClose();
    } catch (error) {
      setError(errorText(t, error, 'projects.toastRenameFailed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-window"
        role="dialog"
        aria-modal="true"
        aria-label={t('projects.renameDomain')}
        aria-describedby={hintId}
        ref={windowRef}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <div className="modal-head">
            <h3 className="modal-title">{t('projects.renameDomain')}</h3>
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              onClick={dismiss}
              aria-label={t('common.close')}
            >
              <X size={16} />
            </button>
          </div>
          <p className="modal-hint" id={hintId}>
            {t('projects.renameHint')}
          </p>
          <div className="modal-body">
            <label className="module-select">
              <span>{t('projects.renameNewDomain')}</span>
              <input
                ref={inputRef}
                type="text"
                value={domain}
                disabled={busy}
                aria-invalid={!valid || exists}
                onChange={(event) => {
                  setDomain(event.target.value);
                  setError('');
                }}
              />
            </label>
            {(error || exists || !valid) && (
              <p className="modal-hint" role="alert">
                {error ||
                  (exists
                    ? t('err.projectExists', { domain: displayProjectDomain(newDomain ?? '') })
                    : t('err.invalidDomain'))}
              </p>
            )}
          </div>
          <div className="modal-foot">
            <span className="modal-path">
              {project.domain} → {newDomain ?? domain.trim()}
            </span>
            <div className="row-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={dismiss}>
                {t('common.close')}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || unchanged || !valid || exists}
              >
                {t('projects.renameDomain')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
