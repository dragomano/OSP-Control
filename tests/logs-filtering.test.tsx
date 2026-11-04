import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logs } from '../src/components/tables/Logs';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));
const repeatedLines = [
  '[09:41:00] [error] REPEATED_ERROR',
  '[09:41:00] [error] REPEATED_ERROR',
  '[09:41:01] [warning] REPEATED_WARNING',
  '[09:41:01] [warning] REPEATED_WARNING',
  '[09:41:02] [info] READY',
];
const logs = (lines: string[], source = 'general.log') => (
  <I18nContext.Provider value={{ lang: 'en', t, plural }}>
    <Logs
      notify={vi.fn()}
      sources={[
        { name: 'general.log', label: 'general.log', domain: false },
        { name: 'Apache.log', label: 'Apache.log', domain: false },
      ]}
      source={source}
      onSourceChange={vi.fn()}
      lines={lines}
      auto={false}
      onAutoChange={vi.fn()}
      clearing={false}
      blocked={false}
      onClear={vi.fn()}
    />
  </I18nContext.Provider>
);
const displayedLines = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.log-line code'), (line) => line.textContent);
const selectLevel = (level: 'all' | 'error' | 'warning') =>
  fireEvent.click(
    screen.getByRole('button', {
      name: level === 'all' ? 'All events' : level === 'error' ? /^Errors / : /^Warnings /,
    }),
  );

afterEach(() => cleanup());

describe('Log filter rendering', () => {
  it('preserves genuine repetitions without accumulating rows across filter switches', () => {
    const { container } = render(logs(repeatedLines));
    for (let cycle = 0; cycle < 10; cycle += 1) {
      selectLevel('error');
      expect(displayedLines(container)).toEqual(['[error] REPEATED_ERROR', '[error] REPEATED_ERROR']);
      selectLevel('warning');
      expect(displayedLines(container)).toEqual(['[warning] REPEATED_WARNING', '[warning] REPEATED_WARNING']);
      selectLevel('all');
      expect(displayedLines(container)).toEqual(repeatedLines.map((line) => line.slice(11)));
    }
  });

  it('removes every row when a repeated filtered log is replaced by an empty source', () => {
    const { container, rerender } = render(logs(repeatedLines));
    selectLevel('error');
    selectLevel('warning');
    rerender(logs([], 'Apache.log'));
    for (const level of ['warning', 'error', 'all'] as const) {
      selectLevel(level);
      expect(displayedLines(container)).toEqual([]);
      expect(screen.getByText(t('logs.emptyLog'))).toBeInTheDocument();
    }
    rerender(logs(repeatedLines));
    selectLevel('error');
    expect(displayedLines(container)).toHaveLength(2);
  });

  it('keeps search results and row counts correct after tail updates', () => {
    const { container, rerender } = render(logs(repeatedLines));
    selectLevel('error');
    rerender(logs([...repeatedLines.slice(1), '[09:41:03] [error] NEW_ERROR']));
    expect(displayedLines(container)).toEqual(['[error] REPEATED_ERROR', '[error] NEW_ERROR']);
    fireEvent.change(screen.getByPlaceholderText('Filter log...'), { target: { value: 'NEW_ERROR' } });
    expect(displayedLines(container)).toEqual(['[error] NEW_ERROR']);
    selectLevel('warning');
    expect(displayedLines(container)).toEqual([]);
    fireEvent.change(screen.getByPlaceholderText('Filter log...'), { target: { value: '' } });
    expect(displayedLines(container)).toEqual(['[warning] REPEATED_WARNING', '[warning] REPEATED_WARNING']);
    rerender(logs([]));
    expect(displayedLines(container)).toEqual([]);
  });
});
