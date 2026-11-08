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
const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const servicesView = (props: React.ComponentProps<typeof Services>) => (
  <I18nContext.Provider value={{ lang: 'en', t, plural: (key) => key }}>
    <Services {...props} />
  </I18nContext.Provider>
);

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
    ...render(servicesView(props)),
    props,
  };
};

afterEach(() => cleanup());

describe('Services async actions', () => {
  it('opens profiles from the active name and refreshes the label with the module snapshot', () => {
    const onProfiles = vi.fn();
    const current = { ...service, profile: 'default' };
    const { props, rerender } = renderServices({ services: [current], onProfiles });
    const button = screen.getByRole('button', {
      name: t('profiles.open', { name: current.name, profile: current.profile }),
    });
    expect(button).toHaveTextContent('default');
    fireEvent.click(button);
    expect(onProfiles).toHaveBeenCalledWith(current);
    const updated = { ...current, profile: 'development+debug' };
    rerender(servicesView({ ...props, services: [updated] }));
    const next = screen.getByRole('button', {
      name: t('profiles.open', { name: updated.name, profile: updated.profile }),
    });
    expect(next).toHaveTextContent(updated.profile);
    expect(next).toHaveAttribute(
      'title',
      t('profiles.open', { name: updated.name, profile: updated.profile }),
    );
  });

  it('does not invent a default profile when the snapshot has no profile data', () => {
    renderServices({ onProfiles: vi.fn() });
    const button = screen.getByRole('button', {
      name: t('profiles.open', { name: service.name, profile: t('common.unknown') }),
    });
    expect(button).toHaveTextContent(t('common.unknown'));
    expect(button).not.toHaveTextContent('default');
  });

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
    expect(notify).toHaveBeenCalledWith('Module list refreshed');
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
