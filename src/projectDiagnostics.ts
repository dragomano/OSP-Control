import { parseProjectTasks, taskErrors } from './projectTasks';

export type DiagnosticTab = 'overview' | 'domains' | 'environment' | 'web' | 'configs' | 'menu' | 'tasks';
export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'skipped';
export type DiagnosticCheck = {
  id: string;
  group: 'configuration' | 'runtime' | 'network' | 'files';
  status: DiagnosticStatus;
  title: string;
  message: string;
  hint: string | null;
  params: Record<string, string>;
  evidence: string;
  tab: DiagnosticTab | null;
  filePath: string | null;
};
export type ProjectDiagnosticReport = { domain: string; checkedAt: number; checks: DiagnosticCheck[] };

export function taskDiagnostic(content: string | null, domain: string): DiagnosticCheck {
  const doc = parseProjectTasks(content ?? '');
  const tasks = doc.tasks.filter((task) => task.domain === domain);
  const invalid = tasks.filter((task) => taskErrors(task, doc.tasks).length);
  const outcome = doc.errors.length || invalid.length ? 'invalid' : tasks.length ? 'ok' : 'missing';
  return {
    id: 'tasks',
    group: 'configuration',
    status: outcome === 'invalid' ? 'error' : outcome === 'ok' ? 'ok' : 'skipped',
    title: 'diag.title.tasks',
    message: `diag.tasks.${outcome}`,
    hint: outcome === 'invalid' ? 'diag.hint.tasks' : null,
    params: {},
    evidence: invalid.map((task) => task.name).join(', ') || doc.errors.join(', '),
    tab: 'tasks',
    filePath: null,
  };
}

export function diagnosticCounts(checks: DiagnosticCheck[]): Record<DiagnosticStatus, number> {
  return checks.reduce(
    (counts, check) => {
      counts[check.status]++;
      return counts;
    },
    { ok: 0, warning: 0, error: 0, skipped: 0 },
  );
}
