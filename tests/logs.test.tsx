import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

// Only the logs page reads are counted: they use maxLines = 300, whereas the
// "recent activity" tail on the overview reads the same file with maxLines = 60.
const logPageReads: string[] = [];
vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return {
    ...actual,
    fetchLogTail: (source: string, maxLines = 300) => {
      if (maxLines === 300) logPageReads.push(source);
      return actual.fetchLogTail(source, maxLines);
    },
  };
});

describe('Кнопка «Автообновление» на странице журналов', () => {
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

  it('перечитывает хвост журнала раз в 5 секунд, пока включён', async () => {
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

  it('останавливает опрос, когда кнопка выключена обратно', async () => {
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
