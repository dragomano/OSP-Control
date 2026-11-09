import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDiagnostics } from '../src/components/pages/ProjectDiagnostics';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';
import type { OsPanelProject } from '../src/ospanel';
import { diagnosticCounts, type ProjectDiagnosticReport, taskDiagnostic } from '../src/projectDiagnostics';

const mocks = vi.hoisted(() => ({ diagnoseProject: vi.fn(), openFileExternally: vi.fn() }));
vi.mock('../src/ospanel', async (original) => ({
  ...(await original<typeof import('../src/ospanel')>()),
  ...mocks,
  isDesktopApp: () => true,
}));
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const project: OsPanelProject = {
  domain: 'shop.test',
  path: 'C:\\OSPanel\\home\\shop.test',
  php: '8.3',
  type: 'Nginx',
  ssl: true,
};
const report: ProjectDiagnosticReport = {
  domain: project.domain,
  checkedAt: 12345678,
  checks: [
    {
      id: 'api',
      group: 'runtime',
      status: 'ok',
      title: 'diag.title.api',
      message: 'diag.api.ok',
      hint: null,
      params: {},
      evidence: '',
      tab: null,
      filePath: null,
    },
    {
      id: 'webRoot',
      group: 'files',
      status: 'error',
      title: 'diag.title.webRoot',
      message: 'diag.webRoot.missing',
      hint: 'diag.hint.webRoot',
      params: {},
      evidence: 'C:\\OSPanel\\home\\shop.test\\missing',
      tab: 'web',
      filePath: null,
    },
    {
      id: 'http',
      group: 'network',
      status: 'skipped',
      title: 'diag.title.http',
      message: 'diag.connection.unknown',
      hint: null,
      params: {},
      evidence: '',
      tab: 'web',
      filePath: null,
    },
  ],
};
const defaults = {
  project,
  domain: project.domain,
  revision: 'saved',
  dirty: false,
  blocked: false,
  savedDomain: true,
  notify: vi.fn(),
  onNavigate: vi.fn(),
  onRestart: vi.fn(),
};
const view = (patch: Partial<Parameters<typeof ProjectDiagnostics>[0]> = {}) => (
  <I18nContext.Provider value={{ t, lang: 'en', plural: (key) => key }}>
    <ProjectDiagnostics {...defaults} {...patch} />
  </I18nContext.Provider>
);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.diagnoseProject.mockResolvedValue(report);
});
afterEach(cleanup);
describe('project diagnostics', () => {
  it('shows scoped results and repair guidance, filters issues and navigates without changing settings', async () => {
    render(view());
    fireEvent.click(screen.getByRole('button', { name: t('diag.run') }));
    expect(await screen.findByText(t('diag.summary.error'))).toBeInTheDocument();
    expect(mocks.diagnoseProject).toHaveBeenCalledWith(project, 'shop.test');
    expect(screen.getByText(t('diag.hint.webRoot'))).toBeInTheDocument();
    expect(screen.getByText(t('diag.connection.unknown'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('diag.issues') }));
    expect(screen.queryByText(t('diag.api.ok'))).not.toBeInTheDocument();
    expect(screen.queryByText(t('diag.connection.unknown'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open: Web server' }));
    expect(defaults.onNavigate).toHaveBeenCalledWith('web');
    expect(defaults.onRestart).not.toHaveBeenCalled();
    expect(mocks.openFileExternally).not.toHaveBeenCalled();
  });
  it('ignores a late response after the domain changes and marks previous results stale after a save', async () => {
    let finish: (report: ProjectDiagnosticReport) => void = () => {};
    mocks.diagnoseProject.mockImplementationOnce(
      () =>
        new Promise<ProjectDiagnosticReport>((resolve) => {
          finish = resolve;
        }),
    );
    const ui = render(view());
    fireEvent.click(screen.getByRole('button', { name: t('diag.run') }));
    ui.rerender(view({ domain: 'api.shop.test' }));
    await act(async () => finish(report));
    expect(screen.queryByText(t('diag.summary.error'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('diag.run') }));
    await screen.findByText(t('diag.summary.error'));
    ui.rerender(view({ domain: 'api.shop.test', revision: 'new saved settings' }));
    expect(screen.getByText(t('diag.stale'))).toBeInTheDocument();
    expect(mocks.diagnoseProject).toHaveBeenCalledTimes(2);
  });
  it('shows failed requests and keeps unknown checks distinct from successful checks', async () => {
    mocks.diagnoseProject.mockRejectedValueOnce(new Error('err.accessDenied'));
    render(view());
    fireEvent.click(screen.getByRole('button', { name: t('diag.run') }));
    await screen.findByRole('alert');
    expect(screen.queryByText(t('diag.summary.ok'))).not.toBeInTheDocument();
    mocks.diagnoseProject.mockResolvedValue({
      ...report,
      checks: report.checks.filter((check) => check.status !== 'error'),
    });
    fireEvent.click(screen.getByRole('button', { name: t('diag.run') }));
    await screen.findByText(t('diag.summary.skipped'));
  });
  it('explains saved-state checks and prevents probing a domain not yet saved', () => {
    const ui = render(view({ dirty: true }));
    expect(screen.getByText(t('diag.draft'))).toBeInTheDocument();
    ui.rerender(view({ savedDomain: false, dirty: true }));
    expect(screen.getByRole('button', { name: t('diag.run') })).toBeDisabled();
    expect(screen.getByText(t('diag.saveDomain'))).toBeInTheDocument();
  });
  it('validates only the selected domain’s task fields and preserves skipped counts', () => {
    const source =
      '[shop.test]\nValid = * * * * * * 0 echo {host}\n[api.shop.test]\nInvalid = 99 * * * * -1 1 echo api\n';
    expect(taskDiagnostic(source, 'shop.test').status).toBe('ok');
    expect(taskDiagnostic(source, 'api.shop.test').status).toBe('error');
    expect(taskDiagnostic(null, 'shop.test').status).toBe('skipped');
    expect(diagnosticCounts(report.checks)).toEqual({ error: 1, warning: 0, ok: 1, skipped: 1 });
  });
});
