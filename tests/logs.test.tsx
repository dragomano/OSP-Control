import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

// Only the logs page reads are counted: they use maxLines = 300, whereas the
// "recent activity" tail on the overview reads the same file with maxLines = 60.
const logPageReads: string[] = [];
const logMocks = vi.hoisted(() => ({ clearLogs: vi.fn(), fetchLogTail: vi.fn() }));
vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return {
    ...actual,
    clearLogs: logMocks.clearLogs,
    fetchLogTail: (source: string, maxLines = 300) => {
      if (maxLines === 300) logPageReads.push(source);
      return logMocks.fetchLogTail(source, maxLines) ?? actual.fetchLogTail(source, maxLines);
    },
  };
});

describe('Log cleanup', () => {
  let contents: Map<string, string[]>;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('ospanel.lang', 'en');
    contents = new Map([
      ['general.log', ['[09:41:00] [error] CURRENT_ERROR', '[09:41:01] [info] CURRENT_INFO']],
      ['Apache.log', ['[09:42:00] [info] OTHER_LOG']],
      ['domains/dune.loc_error.log', ['[09:43:00] [error] DOMAIN_ERROR']],
    ]);
    logMocks.fetchLogTail
      .mockReset()
      .mockImplementation((source: string) => Promise.resolve(contents.get(source) ?? []));
    logMocks.clearLogs.mockReset().mockImplementation(async (source: string | null) => {
      if (source === null) {
        for (const key of contents.keys()) contents.set(key, []);
        return contents.size;
      }
      contents.set(source, []);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    logMocks.fetchLogTail.mockReset();
    logMocks.clearLogs.mockReset();
  });

  const openLogs = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }));
    await screen.findByText('[error] CURRENT_ERROR');
  };
  const confirmCleanup = () => {
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Clear (current log|all logs)$/ }));
  };

  it('requires confirmation and clears the whole current file even with an active filter', async () => {
    await openLogs();
    fireEvent.change(screen.getByPlaceholderText('Filter log...'), { target: { value: 'CURRENT_ERROR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear current log' }));
    expect(within(screen.getByRole('dialog')).getByText('logs/general.log')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(logMocks.clearLogs).not.toHaveBeenCalled();
    expect(screen.getByText('[error] CURRENT_ERROR')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear current log' }));
    confirmCleanup();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(logMocks.clearLogs).toHaveBeenCalledExactlyOnceWith('general.log');
    expect(contents.get('general.log')).toEqual([]);
    expect(contents.get('Apache.log')).toHaveLength(1);
    expect(
      screen.getByText('The log is empty. New events will appear as the module runs.'),
    ).toBeInTheDocument();
  });

  it('clears all logs including domain logs and refreshes their displayed contents', async () => {
    await openLogs();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all logs' }));
    expect(within(screen.getByRole('dialog')).getByText('Files: 3')).toBeInTheDocument();
    confirmCleanup();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(logMocks.clearLogs).toHaveBeenCalledExactlyOnceWith(null);
    expect(screen.getByText('Logs cleared (files: 3)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'general.log' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Domain: dune.loc error' }));
    await waitFor(() => expect(screen.queryByText('[error] DOMAIN_ERROR')).not.toBeInTheDocument());
    expect(contents.get('domains/dune.loc_error.log')).toEqual([]);
    expect(
      screen.getByText('The log is empty. New events will appear as the module runs.'),
    ).toBeInTheDocument();
  });

  it('retains the log on failure and keeps confirmation available for retry', async () => {
    logMocks.clearLogs.mockRejectedValue(
      Object.assign(new Error('err.logLocked'), { params: { source: 'general.log' } }),
    );
    await openLogs();
    fireEvent.click(screen.getByRole('button', { name: 'Clear current log' }));
    confirmCleanup();
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear current log' }),
      ).toBeEnabled(),
    );
    expect(screen.getByText('[error] CURRENT_ERROR')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(
      'Could not automatically release log general.log for clearing.',
    );
    expect(screen.queryByText('Log general.log cleared')).not.toBeInTheDocument();
  });

  it('refreshes files already cleared when a bulk operation reports partial failure', async () => {
    logMocks.clearLogs.mockImplementation(async () => {
      contents.set('general.log', []);
      throw Object.assign(new Error('err.logClearPartial'), {
        params: { count: '1', sources: 'Apache.log' },
      });
    });
    await openLogs();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all logs' }));
    confirmCleanup();
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'Files cleared: 1. Failed to clear: Apache.log',
    );
    await waitFor(() => expect(screen.queryByText('[error] CURRENT_ERROR')).not.toBeInTheDocument());
    expect(contents.get('Apache.log')).toHaveLength(1);
    expect(screen.queryByText('Logs cleared (files: 3)')).not.toBeInTheDocument();
  });

  it('blocks repeat cleanup and source changes while the operation is running', async () => {
    let finish: (count: number) => void = () => {};
    logMocks.clearLogs.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    await openLogs();
    fireEvent.click(screen.getByRole('button', { name: 'Clear current log' }));
    confirmCleanup();
    expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'general.log' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear all logs' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clearing…' }));
    expect(logMocks.clearLogs).toHaveBeenCalledTimes(1);
    await act(async () => {
      contents.set('general.log', []);
      finish(1);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('discards a poll started before cleanup instead of restoring stale events', async () => {
    await openLogs();
    let finishRead: (lines: string[]) => void = () => {};
    let deferNextRead = true;
    logMocks.fetchLogTail.mockImplementation((source: string, maxLines: number) => {
      if (maxLines === 300 && deferNextRead) {
        deferNextRead = false;
        return new Promise<string[]>((resolve) => {
          finishRead = resolve;
        });
      }
      return Promise.resolve(contents.get(source) ?? []);
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-refresh' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear current log' }));
    confirmCleanup();
    await act(async () => {});
    await act(async () => {
      finishRead(['[09:50:00] [error] STALE_EVENT']);
    });
    expect(screen.queryByText('[error] STALE_EVENT')).not.toBeInTheDocument();
    expect(
      screen.getByText('The log is empty. New events will appear as the module runs.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-refresh' })).toHaveClass('on');
  });

  it('blocks service commands until automatic cleanup and restart have completed', async () => {
    let finish: (count: number) => void = () => {};
    logMocks.clearLogs.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    await openLogs();
    fireEvent.click(screen.getByRole('button', { name: 'Clear current log' }));
    confirmCleanup();
    fireEvent.click(screen.getByRole('button', { name: 'Services' }));
    expect(
      screen.getByRole('button', { name: 'The panel is restarting — actions are temporarily paused' }),
    ).toBeDisabled();
    await act(async () => {
      contents.set('general.log', []);
      finish(1);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart all' })).toBeEnabled());
    expect(screen.getByText('Log general.log cleared')).toBeInTheDocument();
  });
});

describe('Logs page autorefresh toggle', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('ospanel.lang', 'ru');
    logPageReads.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  const openLogs = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Журналы' }));
    return screen.findByRole('button', { name: 'Автообновление' });
  };

  it('rereads the log tail every 5 seconds while enabled', async () => {
    const toggle = await openLogs();
    // The first read happens by itself when the tab opens: autorefresh is still off.
    expect(logPageReads.length).toBeGreaterThan(0);
    expect(toggle).not.toHaveClass('on');

    vi.useFakeTimers();
    fireEvent.click(toggle);
    expect(toggle).toHaveClass('on');

    const beforeTick = logPageReads.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(logPageReads.length).toBeGreaterThan(beforeTick);
  });

  it('stops polling when the toggle is switched back off', async () => {
    const toggle = await openLogs();

    vi.useFakeTimers();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle).not.toHaveClass('on');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const afterSwitchOff = logPageReads.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(logPageReads.length).toBe(afterSwitchOff);
  });
});
