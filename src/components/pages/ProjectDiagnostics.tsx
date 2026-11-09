import {
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  FileText,
  Info,
  Play,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import { diagnoseProject, isDesktopApp, type OsPanelProject, openFileExternally } from '../../ospanel';
import {
  type DiagnosticStatus,
  type DiagnosticTab,
  diagnosticCounts,
  type ProjectDiagnosticReport,
} from '../../projectDiagnostics';
import type { Notify } from '../shared';
import { PathText } from '../widgets/PathText';
import './projectDiagnostics.css';

const ICONS = { ok: CheckCircle2, warning: TriangleAlert, error: XCircle, skipped: CircleHelp };
const GROUPS = ['configuration', 'runtime', 'network', 'files'] as const;
export function ProjectDiagnostics({
  project,
  domain,
  revision,
  dirty,
  blocked,
  savedDomain,
  notify,
  onNavigate,
  onRestart,
}: {
  project: OsPanelProject;
  domain: string;
  revision: string;
  dirty: boolean;
  blocked: boolean;
  savedDomain: boolean;
  notify: Notify;
  onNavigate: (tab: DiagnosticTab) => void;
  onRestart: () => void;
}) {
  const { t, lang } = useI18n();
  const [report, setReport] = useState<ProjectDiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'issues'>('all');
  const [checkedRevision, setCheckedRevision] = useState('');
  const request = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a domain or folder change invalidates pending requests and displayed results
  useEffect(() => {
    request.current++;
    setReport(null);
    setBusy(false);
    setError('');
    return () => {
      request.current++;
    };
  }, [project.path, domain]);
  const run = async () => {
    if (busy || blocked || !savedDomain) return;
    const current = ++request.current;
    setBusy(true);
    setError('');
    try {
      const result = await diagnoseProject(project, domain);
      if (current !== request.current) return;
      setReport(result);
      setCheckedRevision(revision);
    } catch (error) {
      if (current === request.current) setError(errorText(t, error, 'workspace.failed'));
    } finally {
      if (current === request.current) setBusy(false);
    }
  };
  const counts = diagnosticCounts(report?.checks ?? []);
  const status: DiagnosticStatus = counts.error
    ? 'error'
    : counts.warning
      ? 'warning'
      : counts.skipped
        ? 'skipped'
        : 'ok';
  const StatusIcon = ICONS[status];
  return (
    <div className="project-diagnostics">
      <div className="diagnostic-toolbar">
        <p className="workspace-hint">
          <ShieldAlert size={15} />
          <span className="diagnostic-scope-text">{t('diag.scope')}</span>
        </p>
        <button
          type="button"
          className="primary-button"
          disabled={busy || blocked || !savedDomain}
          onClick={() => void run()}
        >
          {report ? <RefreshCw size={15} /> : <Play size={15} />}
          {t(busy ? 'diag.running' : report ? 'diag.rerun' : 'diag.run')}
        </button>
      </div>
      {!isDesktopApp() && (
        <p className="workspace-hint">
          <Info size={15} />
          {t('diag.demo')}
        </p>
      )}
      {(!savedDomain || dirty || (report && checkedRevision !== revision)) && (
        <div className="diagnostic-notice" role="status">
          {t(!savedDomain ? 'diag.saveDomain' : dirty ? 'diag.draft' : 'diag.stale')}
        </div>
      )}
      {error && (
        <div className="workspace-error" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <div className="diagnostic-progress" role="status" aria-live="polite">
          {t('diag.progress')}
        </div>
      )}
      {report ? (
        <>
          <div className={`workspace-card diagnostic-summary ${status}`} role="status">
            <StatusIcon size={25} />
            <div>
              <strong>{t(`diag.summary.${status}`)}</strong>
              <span className="diagnostic-time">
                {t('diag.checkedAt', {
                  time: new Intl.DateTimeFormat(lang, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }).format(new Date(report.checkedAt)),
                })}
              </span>
            </div>
            <div className="diagnostic-counts">
              {(['error', 'warning', 'ok', 'skipped'] as const).map((status) => (
                <span key={status} className={status}>
                  <b>{counts[status]}</b>
                  {t(`diag.status.${status}`)}
                </span>
              ))}
            </div>
          </div>
          <fieldset className="diagnostic-filters" aria-label={t('diag.filter')}>
            <button
              type="button"
              className={`secondary-button${filter === 'all' ? ' active' : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              {t('diag.all')}
            </button>
            <button
              type="button"
              className={`secondary-button${filter === 'issues' ? ' active' : ''}`}
              aria-pressed={filter === 'issues'}
              onClick={() => setFilter('issues')}
            >
              {t('diag.issues')}
            </button>
          </fieldset>
          {GROUPS.map((group) => {
            const checks = report.checks.filter(
              (check) =>
                check.group === group &&
                (filter === 'all' || check.status === 'error' || check.status === 'warning'),
            );
            return (
              checks.length > 0 && (
                <section key={group} className="diagnostic-group">
                  <h3>{t(`diag.group.${group}`)}</h3>
                  <div className="workspace-card">
                    {checks.map((check) => {
                      const Icon = ICONS[check.status];
                      return (
                        <article className={`diagnostic-check ${check.status}`} key={check.id}>
                          <Icon size={19} aria-hidden="true" />
                          <div className="diagnostic-check-content">
                            <div className="diagnostic-check-title">
                              <h4>{t(check.title, check.params)}</h4>
                              <span>{t(`diag.status.${check.status}`)}</span>
                            </div>
                            <p>{t(check.message, check.params)}</p>
                            {check.hint && <p className="diagnostic-hint">{t(check.hint, check.params)}</p>}
                            {check.evidence && (
                              <details>
                                <summary>{t('diag.details')}</summary>
                                <pre>{check.evidence}</pre>
                              </details>
                            )}
                            <div className="diagnostic-actions">
                              {check.tab && (
                                <button
                                  type="button"
                                  className="text-button"
                                  disabled={blocked}
                                  onClick={() => onNavigate(check.tab as DiagnosticTab)}
                                >
                                  {t('diag.configure', { section: t(`workspace.tab.${check.tab}`) })}
                                  <ChevronRight size={13} />
                                </button>
                              )}
                              {check.filePath && (
                                <button
                                  type="button"
                                  className="text-button"
                                  disabled={blocked}
                                  onClick={() =>
                                    void openFileExternally(check.filePath as string).catch((error) =>
                                      notify(errorText(t, error, 'workspace.failed')),
                                    )
                                  }
                                >
                                  <FileText size={13} />
                                  {t('configs.open')}
                                </button>
                              )}
                              {check.id === 'applied' && check.status === 'warning' && (
                                <button
                                  type="button"
                                  className="text-button"
                                  disabled={blocked || dirty}
                                  onClick={onRestart}
                                >
                                  {t('projects.restartPanel')}
                                </button>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )
            );
          })}
          {filter === 'issues' && !counts.warning && !counts.error && (
            <div className="empty-note">{t('diag.noIssues')}</div>
          )}
        </>
      ) : (
        !busy && (
          <div className="workspace-card diagnostic-empty">
            <CheckCircle2 size={30} />
            <p>
              <PathText text={t('diag.empty')} />
            </p>
          </div>
        )
      )}
    </div>
  );
}
