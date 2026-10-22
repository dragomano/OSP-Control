import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Code2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Services } from '../src/components/pages/Services';
import type { Service } from '../src/components/shared';
import { ServiceCard } from '../src/components/widgets/ServiceCard';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { PhpUpdate } from '../src/ospanel';
import { PhpUpdateAction, PhpUpdatesProvider, PhpUpdateToolbar, usePhpUpdates } from '../src/phpUpdates';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  recover: vi.fn(),
  desktop: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock('../src/ospanel', () => ({
  checkPhpUpdates: mocks.check,
  installPhpUpdate: mocks.install,
  recoverPhpUpdate: mocks.recover,
  isDesktopApp: mocks.desktop,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const update: PhpUpdate = {
  name: 'PHP-8.4',
  installed: '8.4.9',
  available: '8.4.10',
  error: null,
  recovery: false,
};
const otherUpdate: PhpUpdate = { ...update, name: 'PHP-8.3', installed: '8.3.20', available: '8.3.21' };
const services: Service[] = [update, otherUpdate].map(({ name, installed }) => ({
  name,
  version: installed,
  port: ':9000',
  status: 'stopped',
  detail: 'svc.detail.runtime',
  kind: 'runtime',
  icon: Code2,
}));
const refresh = vi.fn().mockResolvedValue(true);
const onBusy = vi.fn();
function serviceViews(layout: 'list' | 'cards') {
  return layout === 'list' ? (
    <Services
      services={services}
      onToggle={vi.fn()}
      onAction={vi.fn()}
      notify={vi.fn()}
      onSync={refresh}
      onRestartAll={vi.fn()}
    />
  ) : (
    <>
      <PhpUpdateToolbar />
      {services.map((service) => (
        <ServiceCard
          key={service.name}
          service={service}
          onToggle={vi.fn()}
          onAction={vi.fn()}
          notify={vi.fn()}
        />
      ))}
    </>
  );
}
function Reset() {
  const { reset } = usePhpUpdates();
  return (
    <button type="button" onClick={reset}>
      Reset path
    </button>
  );
}
function setup(
  blocked = false,
  content: ReactNode = (
    <>
      <PhpUpdateToolbar />
      <PhpUpdateAction name="PHP-8.4" />
    </>
  ),
) {
  return render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: makePlural(t, 'en', embeddedDict('en')) }}>
      <PhpUpdatesProvider refresh={refresh} blocked={blocked} onBusy={onBusy}>
        {content}
        <Reset />
      </PhpUpdatesProvider>
    </I18nContext.Provider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.check.mockReset().mockResolvedValue([update]);
  mocks.install.mockReset().mockResolvedValue('8.4.10');
  mocks.recover.mockReset().mockResolvedValue('8.4.9');
  refresh.mockReset().mockResolvedValue(true);
  mocks.desktop.mockReturnValue(false);
  mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
});
afterEach(cleanup);

it('does not automatically check or install without the startup preference', () => {
  setup();
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
});
it.each([null, 'err.phpUnsupported', 'err.phpCatalog'])(
  'does not render an update strip without an available version (error: %s)',
  async (error) => {
    mocks.check.mockResolvedValue([{ ...update, available: null, error }]);
    const { container } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(container.querySelector('.php-update-action')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  },
);
it.each(['list', 'cards'] as const)(
  'shows the update strip below only the matching service in %s',
  async (layout) => {
    let finish!: (version: string) => void;
    mocks.install.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    mocks.check.mockResolvedValue([update, { ...otherUpdate, available: null }]);
    const { container } = setup(false, serviceViews(layout));
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    const message = await screen.findByText('Update available: 8.4.10');
    const strip = message.closest('.php-update-action');
    const service = screen.getByText('PHP-8.4').closest(layout === 'list' ? '.service-row' : '.service-card');
    expect(strip?.parentElement).toBe(service);
    expect(service?.lastElementChild).toBe(strip);
    expect(container.querySelectorAll('.php-update-action')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(screen.getByText('Preparing update…')).toBeInTheDocument();
    expect(service).toHaveAttribute('aria-busy', 'true');
    const other = screen.getByText('PHP-8.3').closest(layout === 'list' ? '.service-row' : '.service-card');
    expect(other).toHaveAttribute('aria-busy', 'false');
    expect(other).not.toHaveClass('busy');
    expect(other?.querySelector('.spin')).toBeNull();
    expect(within(other as HTMLElement).queryByText('Action in progress')).not.toBeInTheDocument();
    expect(
      other?.querySelector(layout === 'list' ? '.row-actions .secondary-button' : '.mini-toggle'),
    ).toBeDisabled();
    await act(async () => finish('8.4.10'));
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
  },
);
it('replaces the update offer with the result without another catalog request', async () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
  expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  expect(screen.queryByText('Update available: 8.4.10')).not.toBeInTheDocument();
  expect(screen.getByText('PHP-8.4 updated and verified')).toBeInTheDocument();
  expect(mocks.check).toHaveBeenCalledOnce();
  expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
});
it('prevents duplicate installation of the same module', async () => {
  let finish!: (version: string) => void;
  mocks.install.mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  const button = await screen.findByRole('button', { name: 'Update' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith('PHP-8.4', '8.4.10', null);
  expect(onBusy).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await act(async () => finish('8.4.10'));
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
  expect(refresh).toHaveBeenCalledOnce();
  expect(await screen.findByText('PHP-8.4 updated and verified')).toBeInTheDocument();
});
it('discards an old check result after the installation path is reset', async () => {
  let finish!: (value: PhpUpdate[]) => void;
  mocks.check.mockReturnValue(
    new Promise<PhpUpdate[]>((resolve) => {
      finish = resolve;
    }),
  );
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reset path' }));
  await act(async () => finish([update]));
  expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
});
it('offers recovery even if catalog lookup failed', async () => {
  mocks.check.mockResolvedValue([{ ...update, available: null, error: 'err.phpCatalog', recovery: true }]);
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Recover module' }));
  await waitFor(() => expect(mocks.recover).toHaveBeenCalledExactlyOnceWith('PHP-8.4', null));
  expect(mocks.install).not.toHaveBeenCalled();
});
it('blocks installation during another service operation', async () => {
  setup(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
  expect(mocks.install).not.toHaveBeenCalled();
});
it('reports check failures without claiming the module is current', async () => {
  mocks.check.mockRejectedValue(new Error('err.phpCatalog'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  expect(await screen.findByText('The official PHP catalog is invalid')).toBeInTheDocument();
  expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
});
it('reports module lookup failures once in the toolbar with the original error details', async () => {
  mocks.check.mockResolvedValue(
    ['PHP-8.4', 'PHP-8.3'].map((name) => ({
      ...update,
      name,
      available: null,
      error: 'err.phpNetwork',
      errorParams: { detail: 'Connection timed out' },
    })),
  );
  const { container } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  const message = await screen.findByText(t('err.phpNetwork', { detail: 'Connection timed out' }));
  expect(message.closest('.php-update-toolbar')).not.toBeNull();
  expect(screen.getAllByText(t('err.phpNetwork', { detail: 'Connection timed out' }))).toHaveLength(1);
  expect(container.querySelector('.php-update-action')).toBeNull();
});

it('refreshes the stopped module status and refreshes again after a failed installation', async () => {
  let rejectInstall!: (error: Error) => void;
  let progress!: (event: { payload: { name: string; phase: string } }) => void;
  mocks.desktop.mockReturnValue(true);
  mocks.listen.mockImplementation(async (_event, callback) => {
    progress = callback;
    return mocks.unlisten;
  });
  mocks.install.mockReturnValue(
    new Promise<void>((_resolve, reject) => {
      rejectInstall = reject;
    }),
  );
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
  await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
  act(() => progress({ payload: { name: 'PHP-8.4', phase: 'backup' } }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  const params = { cause: 'err.ioFailed', detail: 'File is locked' };
  await act(async () => rejectInstall(Object.assign(new Error('err.phpFailed'), { params })));
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(mocks.unlisten).toHaveBeenCalledOnce();
  expect(screen.getByText(t('err.phpFailed', { cause: t('err.ioFailed', params) }))).toBeInTheDocument();
});

it.each(['list', 'cards'] as const)(
  'updates modules concurrently with independent progress and immediate versions in %s',
  async (layout) => {
    const finish = new Map<string, (version: string) => void>();
    const listeners: ((event: { payload: { name: string; phase: string } }) => void)[] = [];
    mocks.desktop.mockReturnValue(true);
    mocks.listen.mockImplementation(async (_event, callback) => {
      listeners.push(callback);
      return mocks.unlisten;
    });
    mocks.install.mockImplementation(
      (name: string) => new Promise<string>((resolve) => finish.set(name, resolve)),
    );
    mocks.check.mockResolvedValue([update, otherUpdate]);
    let finishRefresh!: (value: boolean) => void;
    refresh.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    setup(false, serviceViews(layout));
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await screen.findAllByRole('button', { name: 'Update' });
    const rows = [update, otherUpdate].map(
      ({ name }) =>
        screen.getByText(name).closest(layout === 'list' ? '.service-row' : '.service-card') as HTMLElement,
    );
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Update' }));
    expect(within(rows[1]).getByRole('button', { name: 'Update' })).toBeEnabled();
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(2));
    const progress = (name: string, phase: string) =>
      act(() => {
        for (const listener of listeners) listener({ payload: { name, phase } });
      });
    progress('PHP-8.4', 'download');
    progress('PHP-8.3', 'stopping');
    expect(within(rows[0]).getByText('Downloading and validating archive…')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Stopping module…')).toBeInTheDocument();
    expect(rows.every((row) => row.getAttribute('aria-busy') === 'true')).toBe(true);
    await act(async () => finish.get('PHP-8.3')?.('8.3.21'));
    expect(within(rows[1]).getByText(/8\.3\.21/)).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/8\.3\.20/)).not.toBeInTheDocument();
    expect(within(rows[1]).getByText('PHP-8.3 updated and verified')).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute('aria-busy', 'false');
    expect(within(rows[0]).getByText('Downloading and validating archive…')).toBeInTheDocument();
    expect(onBusy.mock.calls).toEqual([[true]]);
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
    await act(async () => finish.get('PHP-8.4')?.('8.4.10'));
    expect(within(rows[0]).getByText(/8\.4\.10/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/8\.3\.21/)).toBeInTheDocument();
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
    expect(screen.getAllByText(/updated and verified/)).toHaveLength(2);
    expect(mocks.check).toHaveBeenCalledOnce();
    // Service props still contain the panel API's cached versions.
    mocks.check.mockResolvedValue([
      { ...update, installed: '8.4.10', available: null },
      { ...otherUpdate, installed: '8.3.21', available: null },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));
    expect(within(rows[0]).getByText(/8\.4\.10/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/8\.3\.21/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    await act(async () => finishRefresh(true));
    fireEvent.click(screen.getByRole('button', { name: 'Reset path' }));
    expect(within(rows[0]).getByText(/8\.4\.9/)).toBeInTheDocument();
  },
);

it('keeps a failed module recoverable without disturbing another update', async () => {
  let rejectFirst!: (error: Error) => void;
  let finishSecond!: (version: string) => void;
  mocks.install.mockImplementation(
    (name: string) =>
      new Promise<string>((resolve, reject) => {
        if (name === update.name) rejectFirst = reject;
        else finishSecond = resolve;
      }),
  );
  mocks.check.mockResolvedValue([update, otherUpdate]);
  setup(false, serviceViews('list'));
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  for (const button of await screen.findAllByRole('button', { name: 'Update' })) fireEvent.click(button);
  await act(async () => rejectFirst(new Error('err.phpRollback')));
  expect(screen.getByRole('button', { name: 'Recover module' })).toBeEnabled();
  expect(screen.getByText('Preparing update…')).toBeInTheDocument();
  expect(onBusy).toHaveBeenCalledExactlyOnceWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Recover module' }));
  await waitFor(() => expect(mocks.recover).toHaveBeenCalledExactlyOnceWith('PHP-8.4', null));
  expect(await screen.findByText('PHP-8.4 recovered')).toBeInTheDocument();
  expect(screen.getByText('Preparing update…')).toBeInTheDocument();
  expect(onBusy).toHaveBeenCalledExactlyOnceWith(true);
  await act(async () => finishSecond('8.3.21'));
  expect(screen.getByText('PHP-8.3 updated and verified')).toBeInTheDocument();
  expect(screen.getByText('PHP-8.4 recovered')).toBeInTheDocument();
  expect(onBusy.mock.calls).toEqual([[true], [false]]);
});
