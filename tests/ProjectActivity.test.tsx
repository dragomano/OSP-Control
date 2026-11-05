import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../src/components/pages/Projects';
import {
  activityDate,
  groupProjectActivity,
  useProjectActivity,
} from '../src/components/pages/projectActivity';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { OsPanelProject, ProjectActivity } from '../src/ospanel';

const mocks = vi.hoisted(() => ({ getProjectActivity: vi.fn(), listEditors: vi.fn() }));
vi.mock('../src/ospanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ospanel')>()),
  ...mocks,
}));

const now = new Date(2026, 9, 27, 12).getTime();
const project = (domain: string): OsPanelProject => ({
  domain,
  path: `X:/TestPanel/home/${domain}`,
  php: '8.3',
  type: 'Apache',
  ssl: true,
});
const entry = (domain: string, date: Date, status: ProjectActivity['status'] = 'ready'): ProjectActivity => ({
  domain,
  modifiedAt: date.getTime() / 1000,
  lastFile: `${domain}/index.php`,
  status,
});
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

beforeEach(() => {
  localStorage.clear();
  mocks.getProjectActivity.mockReset().mockResolvedValue([]);
  mocks.listEditors.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('project activity grouping', () => {
  it('sorts dates newest first, groups local calendar days and keeps unknown dates last', () => {
    const domains = ['old.test', 'unknown.test', 'today.test', 'yesterday.test', 'newest.test'];
    const projects = domains.map(project);
    const activities = [
      entry('old.test', new Date(2026, 9, 21, 9)),
      entry('today.test', new Date(2026, 9, 27, 9)),
      entry('yesterday.test', new Date(2026, 9, 26, 23, 59)),
      entry('newest.test', new Date(2026, 9, 27, 11)),
    ];
    const groups = groupProjectActivity(
      projects,
      Object.fromEntries(activities.map((value) => [value.domain, value])),
      now,
    );
    expect(groups.map((group) => group.kind)).toEqual(['today', 'yesterday', 'earlier', 'unknown']);
    expect(groups[0].key).toBe('2026-10-27');
    expect(groups[0].projects.map((value) => value.domain)).toEqual(['newest.test', 'today.test']);
    expect(projects.map((value) => value.domain)).toEqual(domains);
  });

  it('handles month boundaries, separate older days and future timestamps', () => {
    const dates = [
      new Date(2026, 10, 2),
      new Date(2026, 9, 31, 23, 59),
      new Date(2026, 9, 30),
      new Date(2026, 9, 29),
    ];
    const projects = dates.map((_, index) => project(`${index}.test`));
    const values = projects.map((value, index) => entry(value.domain, dates[index]));
    const groups = groupProjectActivity(
      projects,
      Object.fromEntries(values.map((value) => [value.domain, value])),
      new Date(2026, 10, 1, 0, 1).getTime(),
    );
    expect(groups.map((group) => group.kind)).toEqual(['other', 'yesterday', 'earlier', 'earlier']);
    expect(new Set(groups.map((group) => group.key)).size).toBe(4);
    for (const modifiedAt of [null, NaN, Infinity, -1, 1e20]) {
      expect(activityDate({ ...values[0], modifiedAt })).toBeNull();
    }
  });
});

describe('project activity refresh', () => {
  it('does not overlap scans and cleans up polling and focus listeners on unmount', async () => {
    vi.useFakeTimers();
    let finish!: (value: ProjectActivity[]) => void;
    mocks.getProjectActivity.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, unmount, rerender } = renderHook(({ projects }) => useProjectActivity(projects), {
      initialProps: { projects: [project('fixture.test')] },
    });
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(1);
    const value = entry('fixture.test', new Date(now));
    await act(async () => {
      finish([value]);
    });
    expect(result.current.activity['fixture.test']).toEqual(value);
    rerender({ projects: [project('fixture.test')] });
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(2);
  });

  it('ignores an obsolete scan after the installation or project list changes', async () => {
    let finish!: (value: ProjectActivity[]) => void;
    mocks.getProjectActivity.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ projects }) => useProjectActivity(projects), {
      initialProps: { projects: [project('old.test')] },
    });
    const current = entry('new.test', new Date(now));
    mocks.getProjectActivity.mockResolvedValueOnce([current]);
    await act(async () => {
      rerender({ projects: [project('new.test')] });
    });
    await act(async () => {
      finish([entry('old.test', new Date(now))]);
    });
    expect(result.current.activity).toEqual({ 'new.test': current });
    expect(mocks.getProjectActivity).toHaveBeenLastCalledWith(['new.test']);
  });

  it('preserves the last result and reports a refresh failure, then retries on focus', async () => {
    const current = entry('fixture.test', new Date(now));
    mocks.getProjectActivity.mockResolvedValueOnce([current]);
    const { result } = renderHook(() => useProjectActivity([project('fixture.test')]));
    await act(async () => {});
    const error = new Error('err.ioFailed');
    mocks.getProjectActivity.mockRejectedValueOnce(error);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(result.current.activity['fixture.test']).toEqual(current);
    expect(result.current.error).toBe(error);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(result.current.error).toBeNull();
  });
});

describe('project activity UI', () => {
  it('shows grouped activity, expands one file at a time, and filters without rescanning', async () => {
    const items = [project('older.test'), project('recent.test')];
    const older = entry('older.test', new Date(now - 86_400_000), 'partial');
    const recent = entry('recent.test', new Date(now));
    mocks.getProjectActivity.mockResolvedValue([older, recent]);
    render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Projects
          projects={items}
          allProjects={items}
          query=""
          setQuery={vi.fn()}
          notify={vi.fn()}
          onProjectCreated={vi.fn()}
          onProjectRenamed={vi.fn()}
          onProjectDeleted={vi.fn()}
          onToggleSsl={vi.fn()}
          onRestartPanel={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    const recentButton = await screen.findByRole('button', {
      name: 'Show the last modified file in recent.test',
    });
    const rows = [...document.querySelectorAll('.project-row')];
    expect(rows[0]).toHaveTextContent('recent.test');
    fireEvent.click(recentButton);
    expect(screen.getByText('recent.test/index.php')).toBeVisible();
    const olderButton = screen.getByRole('button', { name: 'Show the last modified file in older.test' });
    fireEvent.click(olderButton);
    expect(screen.getByText('recent.test/index.php')).not.toBeVisible();
    expect(screen.getByText('older.test/index.php')).toBeVisible();
    expect(screen.getByText('Scan incomplete; the modification date may be inaccurate')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'SSL' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Without certificate' }));
    expect(screen.getByText('No projects match the selected filters')).toBeVisible();
    expect(mocks.getProjectActivity).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty project from an unavailable directory', async () => {
    const items = [project('empty.test'), project('missing.test')];
    mocks.getProjectActivity.mockResolvedValue(
      items.map((value, index) => ({
        domain: value.domain,
        modifiedAt: null,
        lastFile: null,
        status: index === 0 ? 'empty' : 'unavailable',
      })),
    );
    render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Projects
          projects={items}
          allProjects={items}
          query=""
          setQuery={vi.fn()}
          notify={vi.fn()}
          onProjectCreated={vi.fn()}
          onProjectRenamed={vi.fn()}
          onProjectDeleted={vi.fn()}
          onToggleSsl={vi.fn()}
          onRestartPanel={vi.fn()}
        />
      </I18nContext.Provider>,
    );
    expect(await screen.findByText('No files to check')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Date unknown' })).toBeVisible();
    expect(screen.getByText('Could not check files')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Show the last modified/ })).not.toBeInTheDocument();
  });
});
