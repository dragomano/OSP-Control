import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Activity } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Services } from '../src/components/pages/Services';
import { type Service, serviceMenuEntries } from '../src/components/shared';
import { ServiceCard } from '../src/components/widgets/ServiceCard';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';
import { openModule } from '../src/ospanel';

vi.mock('../src/ospanel', async (original) => ({
  ...(await original<typeof import('../src/ospanel')>()),
  openModule: vi.fn().mockResolvedValue(undefined),
}));

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const service: Service = {
  name: 'Example',
  version: '1.0',
  port: ':8080',
  status: 'running',
  kind: 'module',
  detail: 'svc.detail.module',
  icon: Activity,
};
const renderWithI18n = (element: React.ReactNode) =>
  render(
    <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>{element}</I18nContext.Provider>,
  );

afterEach(() => {
  cleanup();
  vi.mocked(openModule).mockReset().mockResolvedValue(undefined);
});

describe('stock module shortcuts', () => {
  it.each(['running', 'stopped', 'unknown'] as const)(
    'always offers console and Explorer for %s modules',
    (status) => {
      const entries = serviceMenuEntries({ ...service, status }, vi.fn(), t, vi.fn());
      expect(entries.map((entry) => entry.label)).toEqual(
        expect.arrayContaining(['Open in console', 'Open in Explorer']),
      );
      expect(entries.some((entry) => entry.label === 'Open in browser')).toBe(false);
      expect(entries.some((entry) => entry.label === 'Launch Shell')).toBe(false);
    },
  );

  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])('uses API capabilities for browser=%s and shell=%s', (browser, shell) => {
    const entries = serviceMenuEntries(
      { ...service, moduleActions: { browser, shell } },
      vi.fn(),
      t,
      vi.fn(),
    );
    expect(entries.some((entry) => entry.label === 'Open in browser')).toBe(browser);
    expect(entries.some((entry) => entry.label === 'Launch Shell')).toBe(shell);
  });

  it('blocks shortcuts during panel restarts and updates', () => {
    const entries = serviceMenuEntries(
      { ...service, moduleActions: { browser: true, shell: true } },
      vi.fn(),
      t,
      vi.fn(),
      true,
    );
    for (const entry of entries.filter((entry) =>
      ['Open in browser', 'Launch Shell', 'Open in console', 'Open in Explorer'].includes(entry.label),
    )) {
      expect(entry.disabled).toBe(true);
      entry.onSelect?.();
    }
    expect(openModule).not.toHaveBeenCalled();
  });

  it('translates command errors into a notification', async () => {
    vi.mocked(openModule).mockRejectedValueOnce(new Error('err.serviceNotFound'));
    const notify = vi.fn();
    serviceMenuEntries(service, vi.fn(), t, notify)
      .find((entry) => entry.label === 'Open in console')
      ?.onSelect?.();
    await waitFor(() => expect(notify).toHaveBeenCalledWith(t('err.serviceNotFound')));
  });

  it('opens the console from an overview card', async () => {
    renderWithI18n(<ServiceCard service={service} onToggle={vi.fn()} onAction={vi.fn()} notify={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: t('common.actions') }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in console' }));
    await waitFor(() => expect(openModule).toHaveBeenCalledWith('Example', 'console'));
  });

  it('opens browser, Shell and Explorer from the modules page', async () => {
    renderWithI18n(
      <Services
        services={[{ ...service, moduleActions: { browser: true, shell: true } }]}
        onToggle={vi.fn()}
        onAction={vi.fn()}
        notify={vi.fn()}
        onSync={vi.fn().mockResolvedValue(true)}
        onRestartAll={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    for (const [label, action] of [
      ['Open in browser', 'browser'],
      ['Launch Shell', 'shell'],
      ['Open in Explorer', 'explorer'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: t('common.actions') }));
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
      await waitFor(() => expect(openModule).toHaveBeenLastCalledWith('Example', action));
    }
  });
});
