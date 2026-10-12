import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const mocks = vi.hoisted(() => ({
  refreshService: vi.fn(),
  restartOsPanel: vi.fn(),
  waitForPanelReady: vi.fn(),
}));

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return {
    ...actual,
    refreshService: mocks.refreshService,
    restartOsPanel: mocks.restartOsPanel,
    waitForPanelReady: mocks.waitForPanelReady,
  };
});

const updatedService = (name: string, status: 'running' | 'stopped') => ({
  name,
  version: 'test',
  port: ':0',
  status,
  detail: 'svc.detail.web',
  kind: 'web' as const,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ospanel.lang', 'ru');
  mocks.refreshService.mockReset();
  mocks.restartOsPanel.mockReset().mockResolvedValue(undefined);
  mocks.waitForPanelReady.mockReset().mockResolvedValue(true);
});

afterEach(() => cleanup());

describe('App service actions', () => {
  const openServices = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Сервисы' }));
    expect(await screen.findByText('Apache')).toBeInTheDocument();
  };

  it('suppresses a duplicate action while the first command is pending', async () => {
    let resolveAction!: (value: ReturnType<typeof updatedService>) => void;
    mocks.refreshService.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    await openServices();

    const row = screen.getByText('Apache').closest('.service-row');
    expect(row).not.toBeNull();
    const toggle = within(row as HTMLElement).getByRole('button', { name: 'Остановить' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(mocks.refreshService).toHaveBeenCalledTimes(1);
    expect(mocks.refreshService).toHaveBeenCalledWith('Apache', 'stop');

    await act(async () => resolveAction(updatedService('Apache', 'stopped')));
  });

  it('uses the native panel restart once and reports one aggregate success', async () => {
    await openServices();

    fireEvent.click(screen.getByRole('button', { name: 'Перезапустить всё' }));

    expect(await screen.findByText('Все активные сервисы перезапущены')).toBeInTheDocument();
    expect(mocks.restartOsPanel).toHaveBeenCalledOnce();
    expect(mocks.refreshService).not.toHaveBeenCalled();
  });

  it('blocks service actions and marks them busy while the panel is restarting', async () => {
    let resolveRestart!: () => void;
    mocks.waitForPanelReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRestart = () => resolve(true);
      }),
    );

    await openServices();

    const restartAllBtn = screen.getByRole('button', { name: 'Перезапустить всё' });
    fireEvent.click(restartAllBtn);

    // Header restart button changes to busy state and gets disabled
    expect(
      await screen.findByRole('button', {
        name: 'Панель перезапускается — действия временно приостановлены',
      }),
    ).toBeDisabled();

    // The Apache row toggle is disabled and marked with busy aria
    const row = screen.getByText('Apache').closest('.service-row');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('aria-busy', 'true');
    const toggle = within(row as HTMLElement).getByRole('button', { name: 'Остановить' });
    expect(toggle).toBeDisabled();

    // Clicking the disabled toggle must NOT trigger refreshService
    fireEvent.click(toggle);
    expect(mocks.refreshService).not.toHaveBeenCalled();

    // Navigating to Overview preserves the busy state
    fireEvent.click(screen.getByRole('button', { name: 'Обзор' }));
    // Wait for Overview to render by checking that the nav button is active
    await waitFor(() => {
      const overviewNav = screen.getByRole('button', { name: 'Обзор' });
      expect(overviewNav).toHaveClass('active');
    });
    const apacheCard = screen.getByText('Apache').closest('.service-card');
    expect(apacheCard).not.toBeNull();
    expect(apacheCard).toHaveAttribute('aria-busy', 'true');
    const cardToggle = within(apacheCard as HTMLElement).getByRole('button', { name: 'Переключить Apache' });
    expect(cardToggle).toBeDisabled();
    fireEvent.click(cardToggle);
    expect(mocks.refreshService).not.toHaveBeenCalled();

    // Returning to Services still shows busy until panel readiness resolves
    fireEvent.click(screen.getByRole('button', { name: 'Сервисы' }));
    expect(
      await screen.findByRole('button', {
        name: 'Панель перезапускается — действия временно приостановлены',
      }),
    ).toBeDisabled();

    // Finishing the panel readiness wait unblocks the UI
    await act(async () => resolveRestart());

    expect(await screen.findByRole('button', { name: 'Перезапустить всё' })).not.toBeDisabled();
    const unblockedRow = screen.getByText('Apache').closest('.service-row');
    expect(unblockedRow).toHaveAttribute('aria-busy', 'false');
    const unblockedToggle = within(unblockedRow as HTMLElement).getByRole('button', { name: 'Остановить' });
    expect(unblockedToggle).not.toBeDisabled();
  });

  it('marks only the active service as busy during a single service command', async () => {
    let resolveAction!: (value: ReturnType<typeof updatedService>) => void;
    mocks.refreshService.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    await openServices();

    const apacheRow = screen.getByText('Apache').closest('.service-row') as HTMLElement;
    const apacheToggle = within(apacheRow).getByRole('button', { name: 'Остановить' });
    fireEvent.click(apacheToggle);

    // Apache is busy and disabled
    expect(apacheRow).toHaveAttribute('aria-busy', 'true');
    expect(within(apacheRow).getByRole('button', { name: 'Операция выполняется' })).toBeDisabled();

    // Another service (e.g. PHP) is NOT busy and remains enabled
    const phpRow = screen.getByText('PHP').closest('.service-row') as HTMLElement;
    expect(phpRow).toHaveAttribute('aria-busy', 'false');
    const phpToggle = within(phpRow).getByRole('button', { name: 'Остановить' });
    expect(phpToggle).not.toBeDisabled();

    await act(async () => resolveAction(updatedService('Apache', 'stopped')));
    expect(apacheRow).toHaveAttribute('aria-busy', 'false');
  });
});
