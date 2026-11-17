import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { LOCALES_UPDATED_EVENT } from '../src/i18n';
import { selectOption } from './selectOption';

const pending = new Map<
  string,
  Array<(value: { dict: Record<string, string>; fileUsed: boolean }) => void>
>();

vi.mock('../src/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/i18n')>();
  return {
    ...actual,
    loadLocaleList: vi.fn().mockResolvedValue([
      { code: 'ru', name: 'Русский' },
      { code: 'en', name: 'English' },
    ]),
    loadLocaleDict: vi.fn(
      (lang: string) =>
        new Promise<{ dict: Record<string, string>; fileUsed: boolean }>((resolve) => {
          const queue = pending.get(lang) ?? [];
          queue.push(resolve);
          pending.set(lang, queue);
        }),
    ),
  };
});

const resolveLocale = async (lang: string, dict: Record<string, string>) => {
  const queue = pending.get(lang) ?? [];
  const resolve = queue.shift();
  if (!resolve) throw new Error(`no pending locale request for ${lang}`);
  await act(async () => resolve({ dict, fileUsed: true }));
};

describe('locale loading request ordering', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('ospanel.lang', 'ru');
    pending.clear();
  });

  afterEach(() => cleanup());

  it('refreshes a mounted translator when the same dictionary object changes', async () => {
    const dict = { 'nav.settings': 'Settings before update' };
    render(<App />);
    await resolveLocale('ru', dict);
    fireEvent.click(screen.getByRole('button', { name: 'Settings before update' }));
    dict['nav.settings'] = 'Settings after update';
    fireEvent(window, new Event(LOCALES_UPDATED_EVENT));
    await resolveLocale('ru', dict);
    expect(screen.getByRole('button', { name: 'Settings after update' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings before update' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
  });

  it.each(['startup', 'focus', 'dictionary update', 'manual reload'])(
    'ignores stale %s responses after a language switch',
    async (source) => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Интерфейс' }));
      await screen.findByRole('option', { name: 'English' });

      if (source === 'focus') fireEvent(window, new Event('focus'));
      if (source === 'dictionary update') fireEvent(window, new Event(LOCALES_UPDATED_EVENT));
      if (source === 'manual reload') {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Перечитать переводы' }));
        });
      }
      selectOption(screen.getByRole('combobox', { name: 'Язык интерфейса' }), 'English');

      await resolveLocale('en', {
        'nav.settings': 'Settings from latest response',
        'settings.languageTitle': 'Interface language',
        'lang.name': 'English',
      });
      while (pending.get('ru')?.length) {
        await resolveLocale('ru', {
          'nav.settings': 'Stale response',
          'settings.languageTitle': 'Stale language',
          'lang.name': 'Русский',
        });
      }

      expect(screen.getByRole('button', { name: 'Settings from latest response' })).toBeInTheDocument();
      expect(screen.queryByText('Stale language')).not.toBeInTheDocument();
    },
  );
});
