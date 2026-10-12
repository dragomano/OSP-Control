import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Activity } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Services } from '../src/components/pages/Services';
import type { Service } from '../src/components/shared';
import { embeddedDict, I18nContext, makeTranslator } from '../src/i18n';

const service: Service = {
  name: 'Apache',
  version: '2.4',
  port: ':80',
  status: 'running',
  detail: 'svc.detail.web',
  kind: 'web',
  icon: Activity,
};

const renderServices = (overrides: Partial<React.ComponentProps<typeof Services>> = {}) => {
  const props: React.ComponentProps<typeof Services> = {
    services: [service],
    onToggle: vi.fn(),
    onAction: vi.fn(),
    notify: vi.fn(),
    onSync: vi.fn().mockResolvedValue(true),
    onRestartAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    ...render(
      <I18nContext.Provider
        value={{
          lang: 'en',
          t: makeTranslator(embeddedDict('en'), embeddedDict('en')),
          plural: (key) => key,
        }}
      >
        <Services {...props} />
      </I18nContext.Provider>,
    ),
    props,
  };
};

afterEach(() => cleanup());

describe('Services async actions', () => {
  it('waits for sync before showing the success toast', async () => {
    let resolveSync!: (success: boolean) => void;
    const onSync = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSync = resolve;
        }),
    );
    const notify = vi.fn();
    renderServices({ onSync, notify });

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onSync).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();

    await act(async () => resolveSync(true));
    expect(notify).toHaveBeenCalledWith('Service list refreshed');
  });

  it('runs the bulk restart callback once and disables it while pending', async () => {
    let resolveRestart!: () => void;
    const onRestartAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRestart = resolve;
        }),
    );
    renderServices({ onRestartAll });

    const button = screen.getByRole('button', { name: 'Restart all' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRestartAll).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();

    await act(async () => resolveRestart());
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
