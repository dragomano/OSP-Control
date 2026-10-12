import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Globe2 } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Overview } from '../src/components/pages/Overview';
import type { Notify, Page, Service, SettingsTab } from '../src/components/shared';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { OverviewMetrics } from '../src/ospanel';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

const metrics: OverviewMetrics = {
  servicesRunning: 2,
  servicesTotal: 3,
  projectsTotal: 3,
  ramBytes: 1_280_000_000,
  portsOpen: 4,
  portsTotal: 4,
  portProblems: 0,
};

const service = (name: string, status: Service['status'] = 'running'): Service => ({
  name,
  version: '1.0',
  port: ':80',
  status,
  detail: 'svc.detail.web',
  kind: 'web',
  icon: Globe2,
});

const activityLines = [
  '[2026-10-05 12:35:02] [info] Apache/2.4.62 started successfully',
  '[2026-10-05 12:39:14] [warn] Redis persistence is disabled',
  '[2026-10-05 12:41:57] [info] Redis connection established',
  '[2026-10-05 12:42:08] [error] Virtual host my-shop.test failed to load',
];

const renderOverview = (overrides: Parameters<typeof overviewProps>[0] = {}) => {
  const props = overviewProps(overrides);
  const view = render(
    <I18nContext.Provider value={{ lang: 'en', t, plural }}>
      <Overview {...props} />
    </I18nContext.Provider>,
  );
  return { props, view };
};

type OverviewProps = Parameters<typeof Overview>[0];

const overviewProps = (overrides: Partial<OverviewProps> = {}): OverviewProps => ({
  runningCount: 2,
  services: [service('Apache'), service('Nginx')],
  userName: 'Toster',
  metrics,
  activityLines,
  onNavigate: vi.fn<(page: Page, tab?: SettingsTab) => void>(),
  onToggle: vi.fn<(index: number) => void>(),
  onAction: vi.fn<(service: Service, action: 'start' | 'stop' | 'restart') => void>(),
  notify: vi.fn<Notify>(),
  onSync: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  panelRestarting: false,
  pendingServices: new Set<string>(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('Overview header', () => {
  it('greets the user and shows today as the eyebrow', () => {
    renderOverview();
    expect(screen.getByText('Good afternoon, Toster')).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(String(new Date().getFullYear())), { selector: '.eyebrow' }),
    ).toBeInTheDocument();
  });

  it('renders the greeting with the given name as is (App owns the fallback)', () => {
    renderOverview({ userName: '' });
    expect(screen.queryByText('Good afternoon, Toster')).not.toBeInTheDocument();
    expect(screen.getByText('Good afternoon,')).toBeInTheDocument();
  });

  it('syncs once at a time and notifies on success only', async () => {
    let resolveSync: ((value: boolean) => void) | undefined;
    const onSync = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSync = resolve;
        }),
    );
    const { props } = renderOverview({ onSync });
    const sync = screen.getByRole('button', { name: 'Sync' });

    expect(sync).toBeEnabled();
    fireEvent.click(sync);
    expect(sync).toBeDisabled();

    resolveSync?.(false);
    await waitFor(() => expect(sync).toBeEnabled());
    expect(props.notify).not.toHaveBeenCalled();

    fireEvent.click(sync);
    resolveSync?.(true);
    await waitFor(() => expect(props.notify).toHaveBeenCalledWith('OSPanel synchronization complete'));
  });
});

describe('Overview navigation', () => {
  it('routes the hero, quick-access and tip buttons', () => {
    const { props } = renderOverview();

    fireEvent.click(screen.getByRole('button', { name: /Manage services/ }));
    expect(props.onNavigate).toHaveBeenCalledWith('services');

    fireEvent.click(screen.getByRole('button', { name: /Open projects/ }));
    expect(props.onNavigate).toHaveBeenCalledWith('projects');

    fireEvent.click(screen.getByRole('button', { name: /All services/ }));
    expect(props.onNavigate).toHaveBeenCalledWith('services');

    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }));
    expect(props.onNavigate).toHaveBeenCalledWith('logs');

    fireEvent.click(screen.getByRole('button', { name: /Open settings/ }));
    expect(props.onNavigate).toHaveBeenCalledWith('settings', 'autostart');
  });
});

describe('Overview metrics', () => {
  it('shows dashes and the unavailable trend without metrics', () => {
    renderOverview({ metrics: null });
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('shows metric values, trends and port problems', () => {
    renderOverview({ metrics: { ...metrics, portProblems: 2 } });
    expect(screen.getByText('2/2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1.2 GB')).toBeInTheDocument();
    expect(screen.getByText('4/4')).toBeInTheDocument();
    expect(screen.getByText('All systems nominal')).toBeInTheDocument();
    expect(screen.getByText('Unreachable: 2')).toBeInTheDocument();
  });

  it('marks a partial services state', () => {
    renderOverview({ runningCount: 1, services: [service('Apache'), service('Nginx', 'stopped')] });
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('Not all modules are running')).toBeInTheDocument();
  });
});

describe('Overview activity feed', () => {
  it('renders nothing while the tail is loading', () => {
    renderOverview({ activityLines: null });
    expect(screen.queryByText('No entries yet')).not.toBeInTheDocument();
  });

  it('shows the empty note for an empty tail', () => {
    renderOverview({ activityLines: [] });
    expect(screen.getByText('No entries yet')).toBeInTheDocument();
  });

  it('shows the last three events with their levels, newest on top', () => {
    renderOverview();
    const titles = screen.getAllByText(/Redis|Virtual host/).map((node) => node.textContent);
    // The level marker stays in the text; the last three lines are shown, newest on top.
    expect(titles).toEqual([
      '[error] Virtual host my-shop.test failed to load',
      '[info] Redis connection established',
      '[warn] Redis persistence is disabled',
    ]);
    // The status label is an aria-label on the role="img" icon, not text content.
    expect(screen.getByRole('img', { name: 'Error' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Warning' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Info' })).toBeInTheDocument();
  });
});

describe('Overview service cards', () => {
  it('marks every card busy while the panel is restarting', () => {
    renderOverview({ panelRestarting: true });
    const cards = screen.getAllByText('The panel is restarting — actions are temporarily paused');
    expect(cards).toHaveLength(2);
    expect(cards[0].closest('.service-card')).toHaveAttribute('aria-busy', 'true');
  });

  it('marks only the pending service busy otherwise', () => {
    renderOverview({ pendingServices: new Set(['Apache']) });
    expect(screen.getAllByText('Action in progress')).toHaveLength(1);
  });

  it('propagates the toggle of a card', () => {
    const { props } = renderOverview();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Apache' }));
    expect(props.onToggle).toHaveBeenCalledWith(0);
  });
});
