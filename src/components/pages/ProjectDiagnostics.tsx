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
import { Button, EmptyState, Notice, Panel, Toolbar } from '../ui';
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
      <Toolbar className="diagnostic-toolbar">
        <p className="workspace-hint">
          <ShieldAlert size={15} />
          <span className="diagnostic-scope-text">{t('diag.scope')}</span>
        </p>
        <Button
          variant="primary"
          type="button"
          className="primary-button"
          disabled={busy || blocked || !savedDomain}
          onClick={() => void run()}
        >
          {report ? <RefreshCw size={15} /> : <Play size={15} />}
          {t(busy ? 'diag.running' : report ? 'diag.rerun' : 'diag.run')}
        </Button>
      </Toolbar>
      {!isDesktopApp() && (
        <p className="workspace-hint">
          <Info size={15} />
          {t('diag.demo')}
        </p>
      )}
      {(!savedDomain || dirty || (report && checkedRevision !== revision)) && (
        <Notice className="diagnostic-notice" role="status">
          {t(!savedDomain ? 'diag.saveDomain' : dirty ? 'diag.draft' : 'diag.stale')}
        </Notice>
      )}
      {error && (
        <Notice className="workspace-error" role="alert">
          {error}
        </Notice>
      )}
      {busy && (
        <div className="diagnostic-progress" role="status" aria-live="polite">
          {t('diag.progress')}
        </div>
      )}
      {report ? (
        <>
          <Panel className={`workspace-card diagnostic-summary ${status}`} role="status">
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
          </Panel>
          <fieldset className="diagnostic-filters" aria-label={t('diag.filter')}>
            <Button
              selected={Boolean(filter === 'all')}
              type="button"
              className={`secondary-button${filter === 'all' ? ' active' : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              {t('diag.all')}
            </Button>
            <Button
              selected={Boolean(filter === 'issues')}
              type="button"
              className={`secondary-button${filter === 'issues' ? ' active' : ''}`}
              aria-pressed={filter === 'issues'}
              onClick={() => setFilter('issues')}
            >
              {t('diag.issues')}
            </Button>
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
                  <Panel className="workspace-card">
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
                                <Button
                                  variant="ghost"
                                  type="button"
                                  className="text-button"
                                  disabled={blocked}
                                  onClick={() => onNavigate(check.tab as DiagnosticTab)}
                                >
                                  {t('diag.configure', { section: t(`workspace.tab.${check.tab}`) })}
                                  <ChevronRight size={13} />
                                </Button>
                              )}
                              {check.filePath && (
                                <Button
                                  variant="ghost"
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
                                </Button>
                              )}
                              {check.id === 'applied' && check.status === 'warning' && (
                                <Button
                                  variant="ghost"
                                  type="button"
                                  className="text-button"
                                  disabled={blocked || dirty}
                                  onClick={onRestart}
                                >
                                  {t('projects.restartPanel')}
                                </Button>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </Panel>
                </section>
              )
            );
          })}
          {filter === 'issues' && !counts.warning && !counts.error && (
            <EmptyState className="empty-note">{t('diag.noIssues')}</EmptyState>
          )}
        </>
      ) : (
        !busy && (
          <Panel className="workspace-card diagnostic-empty">
            <CheckCircle2 size={30} />
            <p>
              <PathText text={t('diag.empty')} />
            </p>
          </Panel>
        )
      )}
    </div>
  );
}
