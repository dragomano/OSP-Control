import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const mocks = vi.hoisted(() => ({
  startOsPanel: vi.fn(),
  waitForPanelReady: vi.fn(),
  discoverOsPanel: vi.fn(),
  autostartFromProjects: vi.fn(),
  checkModuleUpdates: vi.fn(),
}));

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return { ...actual, ...mocks, isDesktopApp: () => true };
});

const snapshot = {
  detected: true,
  panelRunning: true,
  version: '6.0.0',
  path: 'C:\\OSPanel',
  checkedAt: '',
  source: 'tauri' as const,
  services: [],
  projects: [],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ospanel.lang', 'en');
  mocks.startOsPanel.mockReset().mockResolvedValue(undefined);
  mocks.waitForPanelReady.mockReset().mockResolvedValue(true);
  mocks.discoverOsPanel.mockReset().mockResolvedValue(snapshot);
  mocks.autostartFromProjects.mockReset().mockResolvedValue({ started: [], unmatched: [] });
  mocks.checkModuleUpdates.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OSPanel startup', () => {
  it.each([null, '', '   '])('offers settings when the saved path is %j', async (path) => {
    if (path !== null) localStorage.setItem('ospanel.path', path);
    render(<App />);

    expect(await screen.findByText(/The OSPanel path is not set/)).toBeVisible();
    expect(mocks.startOsPanel).not.toHaveBeenCalled();
    expect(mocks.waitForPanelReady).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Set the OSPanel path' }));
    expect(await screen.findByRole('textbox', { name: 'OSPanel path' })).toBeVisible();
    expect(screen.queryByText(/The OSPanel path is not set/)).not.toBeInTheDocument();
  });

  it('keeps setup guidance visible even with routine notifications disabled', async () => {
    localStorage.setItem('ospanel.notify', '0');
    render(<App />);
    expect(await screen.findByText(/The OSPanel path is not set/)).toBeVisible();
    vi.useFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(screen.getByText(/The OSPanel path is not set/)).toBeVisible();
  });

  it('starts once under StrictMode and waits for readiness before the initial snapshot', async () => {
    localStorage.setItem('ospanel.path', 'C:\\OSPanel');
    let ready!: (value: boolean) => void;
    mocks.waitForPanelReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        ready = resolve;
      }),
    );
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await waitFor(() => expect(mocks.waitForPanelReady).toHaveBeenCalledOnce());
    expect(mocks.startOsPanel).toHaveBeenCalledOnce();
    expect(mocks.discoverOsPanel).not.toHaveBeenCalled();
    await act(async () => ready(true));
    expect(mocks.discoverOsPanel).toHaveBeenCalledOnce();
    expect(await screen.findByText('6.0.0')).toBeVisible();
    expect(screen.queryByText(/The OSPanel path is not set/)).not.toBeInTheDocument();
  });

  it('translates launch errors and still loads the snapshot', async () => {
    localStorage.setItem('ospanel.path', 'C:\\MissingPanel');
    mocks.startOsPanel.mockRejectedValue({ code: 'err.panelStartFailed' });
    render(<App />);
    expect(await screen.findByText('Failed to start OSPanel')).toBeVisible();
    expect(mocks.waitForPanelReady).not.toHaveBeenCalled();
    expect(mocks.discoverOsPanel).toHaveBeenCalledOnce();
  });

  it('reports a readiness timeout without retrying the executable launch', async () => {
    localStorage.setItem('ospanel.path', 'C:\\OSPanel');
    mocks.waitForPanelReady.mockResolvedValue(false);
    render(<App />);
    expect(await screen.findByText(/OSPanel has not responded yet/)).toBeVisible();
    expect(mocks.startOsPanel).toHaveBeenCalledOnce();
    expect(mocks.discoverOsPanel).toHaveBeenCalledOnce();
  });

  it('defers project module autostart until the panel is ready', async () => {
    vi.useFakeTimers();
    localStorage.setItem('ospanel.path', 'C:\\OSPanel');
    localStorage.setItem('ospanel.autostartProjects', '1');
    let ready!: (value: boolean) => void;
    mocks.waitForPanelReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        ready = resolve;
      }),
    );
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(1600));
    expect(mocks.autostartFromProjects).not.toHaveBeenCalled();
    await act(async () => ready(true));
    expect(mocks.autostartFromProjects).toHaveBeenCalledOnce();
  });

  it('defers module update checks until panel and project module startup finish', async () => {
    localStorage.setItem('ospanel.path', 'C:\\OSPanel');
    localStorage.setItem('ospanel.autostartProjects', '1');
    localStorage.setItem('ospanel.checkServiceUpdates', '1');
    let ready!: (value: boolean) => void;
    let modulesReady!: (value: { started: string[]; unmatched: string[] }) => void;
    mocks.waitForPanelReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        ready = resolve;
      }),
    );
    mocks.autostartFromProjects.mockReturnValue(
      new Promise((resolve) => {
        modulesReady = resolve;
      }),
    );
    render(<App />);
    await waitFor(() => expect(mocks.waitForPanelReady).toHaveBeenCalledOnce());
    expect(mocks.checkModuleUpdates).not.toHaveBeenCalled();
    await act(async () => ready(true));
    expect(mocks.autostartFromProjects).toHaveBeenCalledOnce();
    expect(mocks.checkModuleUpdates).not.toHaveBeenCalled();
    await act(async () => modulesReady({ started: [], unmatched: [] }));
    expect(mocks.checkModuleUpdates).toHaveBeenCalledOnce();
  });

  it.each(['missing path', 'launch failure', 'timeout'])(
    'skips project module autostart after %s',
    async (failure) => {
      vi.useFakeTimers();
      localStorage.setItem('ospanel.autostartProjects', '1');
      if (failure !== 'missing path') localStorage.setItem('ospanel.path', 'C:\\OSPanel');
      if (failure === 'launch failure') mocks.startOsPanel.mockRejectedValue(new Error('failed'));
      if (failure === 'timeout') mocks.waitForPanelReady.mockResolvedValue(false);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(1600));
      expect(mocks.autostartFromProjects).not.toHaveBeenCalled();
    },
  );

  it('does not start project modules after the app unmounts during startup', async () => {
    vi.useFakeTimers();
    localStorage.setItem('ospanel.path', 'C:\\OSPanel');
    localStorage.setItem('ospanel.autostartProjects', '1');
    let ready!: (value: boolean) => void;
    mocks.waitForPanelReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        ready = resolve;
      }),
    );
    const { unmount } = render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(1600));
    unmount();
    await act(async () => ready(true));
    expect(mocks.autostartFromProjects).not.toHaveBeenCalled();
    expect(mocks.discoverOsPanel).not.toHaveBeenCalled();
  });
});
