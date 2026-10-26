import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppUpdateButton, AppUpdateSettings, AppUpdatesProvider } from '../src/appUpdates';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
  appUpdateStartup: vi.fn(),
  isDesktopApp: vi.fn(),
}));
vi.mock('../src/ospanel', async (original) => ({
  ...(await original<typeof import('../src/ospanel')>()),
  ...mocks,
}));
const dict = embeddedDict('en');
const t = makeTranslator(dict, dict);
const release = {
  version: '0.3.0',
  notes: '<script>unsafe</script>',
  size: 1024,
  publishedAt: '',
  url: '',
  sha256: '',
};

function setup(blocked = false) {
  return render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: makePlural(t, 'en', dict) }}>
      <AppUpdatesProvider blocked={blocked} onBusy={vi.fn()}>
        <AppUpdateButton />
        <AppUpdateSettings />
      </AppUpdatesProvider>
    </I18nContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  mocks.isDesktopApp.mockReturnValue(true);
  mocks.appUpdateStartup.mockResolvedValue(null);
  mocks.checkAppUpdate.mockResolvedValue(release);
});

afterEach(cleanup);

it('shows local recovery immediately without waiting for the release server', async () => {
  localStorage.setItem('ospanel.checkAppUpdates', '1');
  mocks.appUpdateStartup.mockResolvedValue('rollback');
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The previous executable and locales directory were restored together.',
  );
  expect(mocks.checkAppUpdate).not.toHaveBeenCalled();
});

it('shows real channel progress and prevents closing during installation', async () => {
  mocks.installAppUpdate.mockImplementation((_version, progress) => {
    progress({ phase: 'download', received: 512, total: 1024 });
    return new Promise(() => {});
  });
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check application updates' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update and restart' }));
  expect(await screen.findByRole('progressbar')).toHaveValue(50);
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
});

it('keeps application startup checks separate from service checks', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check application updates at startup' }));
  expect(localStorage.getItem('ospanel.checkAppUpdates')).toBe('1');
  expect(localStorage.getItem('ospanel.checkServiceUpdates')).toBeNull();
});

it('automatically announces a release and opens its details without interpreting HTML', async () => {
  localStorage.setItem('ospanel.checkAppUpdates', '1');
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByText('<script>unsafe</script>')).toBeVisible();
  expect(document.querySelector('script')).toBeNull();
});

it('checks manually, retries installation errors and prevents duplicate installs', async () => {
  mocks.installAppUpdate.mockRejectedValue(new Error('failure'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check application updates' }));
  const button = await screen.findByRole('button', { name: 'Update and restart' });
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByRole('alert');
  expect(mocks.installAppUpdate).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  await waitFor(() => expect(mocks.installAppUpdate).toHaveBeenCalledTimes(2));
});

it('does not install while a service operation is active', async () => {
  setup(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check application updates' }));
  expect(await screen.findByRole('button', { name: 'Update and restart' })).toBeDisabled();
  expect(mocks.installAppUpdate).not.toHaveBeenCalled();
});

it('reports the current version and manual network failures', async () => {
  mocks.checkAppUpdate.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('network'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Check application updates' }));
  await screen.findByText('You are using the latest version.');
  const buttons = screen.getAllByRole('button', { name: 'Check application updates' });
  fireEvent.click(buttons[buttons.length - 1]);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to update the application');
});
