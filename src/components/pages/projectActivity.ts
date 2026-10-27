import { useEffect, useState } from 'react';
import { getProjectActivity, type OsPanelProject, type ProjectActivity } from '../../ospanel';

export type ActivityGroup = {
  key: string;
  kind: 'today' | 'yesterday' | 'earlier' | 'other' | 'unknown';
  date: Date | null;
  projects: OsPanelProject[];
};

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function activityDate(activity?: ProjectActivity): Date | null {
  if (activity?.modifiedAt == null || !Number.isFinite(activity.modifiedAt) || activity.modifiedAt < 0)
    return null;
  const date = new Date(activity.modifiedAt * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function groupProjectActivity(
  projects: OsPanelProject[],
  activity: Record<string, ProjectActivity>,
  now: number,
): ActivityGroup[] {
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const sorted = [...projects].sort((a, b) => {
    const aTime = activityDate(activity[a.domain])?.getTime() ?? -Infinity;
    const bTime = activityDate(activity[b.domain])?.getTime() ?? -Infinity;
    return aTime === bTime ? 0 : aTime > bTime ? -1 : 1;
  });
  const groups = new Map<string, ActivityGroup>();
  for (const project of sorted) {
    const date = activityDate(activity[project.domain]);
    const key = date ? dayKey(date) : 'unknown';
    const kind = !date
      ? 'unknown'
      : key === dayKey(today)
        ? 'today'
        : key === dayKey(yesterday)
          ? 'yesterday'
          : date.getTime() > now
            ? 'other'
            : 'earlier';
    const group: ActivityGroup = groups.get(key) ?? { key, kind, date, projects: [] };
    group.projects.push(project);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function useProjectActivity(projects: OsPanelProject[]) {
  // Snapshot refreshes replace the project objects; only a changed domain/path
  // list or installation should restart the scan, never a search or SSL toggle.
  const requestKey = JSON.stringify({
    installation: localStorage.getItem('ospanel.path'),
    projects: projects
      .map(({ domain, path }) => ({ domain, path }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
  });
  const [state, setState] = useState<{
    key: string;
    entries: Record<string, ProjectActivity>;
    loading: boolean;
    error: unknown;
  }>({ key: '', entries: {}, loading: true, error: null });
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const domains = (JSON.parse(requestKey).projects as Pick<OsPanelProject, 'domain' | 'path'>[]).map(
      ({ domain }) => domain,
    );
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout>;
    const scan = async () => {
      if (disposed || running) return;
      clearTimeout(timer);
      if (domains.length === 0) {
        setState({ key: requestKey, entries: {}, loading: false, error: null });
        return;
      }
      running = true;
      setState((current) => ({
        key: requestKey,
        entries: current.key === requestKey ? current.entries : {},
        loading: true,
        error: null,
      }));
      try {
        const result = await getProjectActivity(domains);
        if (!disposed) {
          setState({
            key: requestKey,
            entries: Object.fromEntries(result.map((entry) => [entry.domain, entry])),
            loading: false,
            error: null,
          });
        }
      } catch (error) {
        if (!disposed) setState((current) => ({ ...current, loading: false, error }));
      } finally {
        running = false;
        if (!disposed) {
          setNow(Date.now());
          timer = setTimeout(() => void scan(), 30_000);
        }
      }
    };
    const focus = () => {
      setNow(Date.now());
      void scan();
    };
    void scan();
    window.addEventListener('focus', focus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('focus', focus);
    };
  }, [requestKey]);

  return {
    activity: state.key === requestKey ? state.entries : {},
    loading: state.key !== requestKey || state.loading,
    error: state.key === requestKey ? state.error : null,
    now,
  };
}
