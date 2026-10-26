import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickSearch } from '../src/components/dialogs/QuickSearch';
import type { Page, SettingsTab } from '../src/components/shared';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

// The results list calls scrollIntoView on the active item; jsdom does not implement it.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());

describe('QuickSearch', () => {
  const setup = (open: boolean) => {
    const onClose = vi.fn();
    const onNavigate = vi.fn<(page: Page, tab?: SettingsTab) => void>();
    const view = render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <QuickSearch open={open} onClose={onClose} onNavigate={onNavigate} />
      </I18nContext.Provider>,
    );
    const rerender = (next: boolean) =>
      view.rerender(
        <I18nContext.Provider value={{ lang: 'en', t, plural }}>
          <QuickSearch open={next} onClose={onClose} onNavigate={onNavigate} />
        </I18nContext.Provider>,
      );
    return { onClose, onNavigate, rerender };
  };

  it('renders nothing while closed and the palette when opened', () => {
    const { rerender } = setup(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(true);
    expect(screen.getByRole('dialog', { name: 'Quick search' })).toBeInTheDocument();
  });

  it('shows the catalog of pages and settings entries', () => {
    setup(true);
    const list = screen.getByRole('dialog');
    // Pages plus per-section settings options and the backups shortcut.
    expect(list.querySelectorAll('.quick-search-item')).toHaveLength(16);
    expect(within(list).getByRole('button', { name: 'OverviewWorkspace' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Interface themeSettings/ })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'BackupsSystem' })).toBeInTheDocument();
  });

  it('filters by the query across title and section', () => {
    setup(true);
    const input = screen.getByRole('textbox', { name: 'Quick search' });

    fireEvent.change(input, { target: { value: 'logs' } });
    expect(screen.getAllByRole('button', { name: /Logs/ })).toHaveLength(1);

    fireEvent.change(input, { target: { value: 'zzz-no-match' } });
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Logs/ })).not.toBeInTheDocument();
  });

  it('moves the active item with the arrow keys and clamps at the edges', () => {
    setup(true);
    const items = () =>
      screen
        .getAllByRole('button', { name: /.+/ })
        .filter((item) => item.className.includes('quick-search-item'));

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(items()[1]).toHaveClass('active');

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(items()[0]).toHaveClass('active');

    const last = items().length - 1;
    for (let i = 0; i <= last + 1; i += 1) fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(items()[last]).toHaveClass('active');
  });

  it('navigates on Enter to the active entry, including its settings tab', () => {
    const { onNavigate } = setup(true);

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('overview', undefined);

    fireEvent.change(screen.getByRole('textbox', { name: 'Quick search' }), {
      target: { value: 'theme' },
    });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('settings', 'appearance');
  });

  it('navigates on click and follows the hovered item', () => {
    const { onNavigate } = setup(true);
    const items = screen
      .getAllByRole('button', { name: /.+/ })
      .filter((item) => item.className.includes('quick-search-item'));

    fireEvent.mouseEnter(items[2]);
    expect(items[2]).toHaveClass('active');

    fireEvent.click(items[2]);
    expect(onNavigate).toHaveBeenCalledWith('projects', undefined);
  });

  it('keeps the palette intact when arrowing through an empty result list', () => {
    setup(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Quick search' }), {
      target: { value: 'zzz-no-match' },
    });
    // The clamp must not crash with zero results (results.length - 1 is -1 here).
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
    expect(document.querySelector('.quick-search-item.active')).not.toBeInTheDocument();
  });

  it('closes via the button and via Escape', () => {
    const { onClose, rerender } = setup(true);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('resets the query and selection when reopened', async () => {
    const { rerender } = setup(true);
    const input = screen.getByRole('textbox', { name: 'Quick search' });

    fireEvent.change(input, { target: { value: 'logs' } });
    expect(screen.getAllByRole('button', { name: /.+/ }).length).toBeLessThan(15);

    rerender(false);
    rerender(true);
    const reopened = screen.getByRole('textbox', { name: 'Quick search' });
    await waitFor(() => expect(reopened).toHaveValue(''));
    expect(screen.getByRole('dialog').querySelectorAll('.quick-search-item')).toHaveLength(16);
  });
});
