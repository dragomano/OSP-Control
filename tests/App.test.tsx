import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { APP_NAME } from '../src/brand';
import type { OsPanelSnapshot } from '../src/ospanel';

// discoverOsPanel is mocked file-wide but delegates to the real adapter: the browser
// branch serves demo data on its own, and only the failure test overrides the result.
const ospanelMocks = vi.hoisted(() => {
  const state: { real?: () => Promise<OsPanelSnapshot> } = {};
  return {
    state,
    discoverOsPanel: vi.fn((): Promise<OsPanelSnapshot> => {
      const real = state.real;
      if (!real) return Promise.reject(new Error('ospanel adapter is not loaded yet'));
      return real();
    }),
  };
});

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  ospanelMocks.state.real = actual.discoverOsPanel;
  return { ...actual, discoverOsPanel: ospanelMocks.discoverOsPanel };
});

const confirmYes = () => {
  if (!window.confirm) {
    Object.defineProperty(window, 'confirm', { value: () => false, configurable: true, writable: true });
  }
  return vi.spyOn(window, 'confirm').mockReturnValue(true);
};

const projectRow = async (domain: string) => {
  const cell = await screen.findByText(domain);
  const row = cell.closest<HTMLElement>('.project-row');
  if (!row) throw new Error(`project row not found: ${domain}`);
  return row;
};

// App renders without mocks: jsdom has no __TAURI_INTERNALS__, and the
// ospanel.ts adapter takes the browser branch with demo data on its own.
describe('App (browser mode: adapter serves mocks)', () => {
  beforeEach(() => {
    localStorage.clear();
    ospanelMocks.discoverOsPanel.mockClear();
    // The language is pinned explicitly: otherwise the Russian UI depends on the locale of
    // the machine running the tests (with empty localStorage the app takes it from navigator).
    localStorage.setItem('ospanel.lang', 'ru');
  });

  afterEach(() => cleanup());

  it('renders brand, navigation and status from the mock snapshot', async () => {
    render(<App />);
    // The brand also appears in the breadcrumbs — take the sidebar element specifically (<strong>).
    expect(screen.getByText(APP_NAME, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сервисы' })).toBeInTheDocument();
    // The snapshot loads asynchronously: the version in the sidebar appears after discoverOsPanel.
    expect(screen.getByText('OSPanel', { selector: 'b' })).toBeInTheDocument();
    expect(await screen.findByText('6.0.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Открыть папку OSPanel' })).toBeInTheDocument();
  });

  it('opens updates from the brand icon and keeps only the startup toggle in settings', async () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'Проверить обновления приложения' });
    expect(button.closest('.brand')).not.toBeNull();
    expect(button).toHaveClass('icon-button');
    expect(button).toHaveAttribute('title', 'Проверить обновления приложения');
    expect(button).toHaveTextContent('');
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Обновление приложения' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Автозапуск и уведомления' }));
    const card = document.querySelector<HTMLElement>('.settings-card');
    expect(card).not.toBeNull();
    if (!card) throw new Error('Settings card not found');
    expect(within(card).queryByText('Обновление приложения')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Проверить обновления приложения' })).toBeNull();
    const toggle = within(card).getByRole('button', {
      name: 'Проверять обновления приложения при запуске',
    });
    expect(toggle).toHaveClass('large-toggle');
    fireEvent.click(toggle);
    expect(localStorage.getItem('ospanel.checkAppUpdates')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть панель' }));
    expect(button).toBeVisible();
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Обновление приложения' })).toBeVisible();
  });

  it('switches pages via navigation', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
    expect(await screen.findByText('Параметры приложения и подключения к OSPanel.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Журналы' }));
    expect(
      await screen.findByText(
        'Следите за состоянием модулей и находите проблемы до того, как они помешают работе.',
      ),
    ).toBeInTheDocument();
  });

  // <html lang> drives screen readers, spellcheck and CSS :lang(): it must track the
  // chosen language instead of the static placeholder from index.html.
  describe('html lang follows the UI language', () => {
    it('is applied on mount from the saved language', async () => {
      render(<App />);
      await screen.findByRole('button', { name: 'Сервисы' });
      expect(document.documentElement.lang).toBe('ru');
    });

    it('updates after a switch in the settings menu', async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Внешний вид' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Русский' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'English' }));
      await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    });
  });

  // First launch without a saved setting: the language comes from the OS, and only if
  // the app does not have it — the English base.
  describe('first launch picks the system language', () => {
    const withSystemLang = (languages: string[]) => {
      Object.defineProperty(globalThis, 'navigator', {
        value: { languages, language: languages[0] },
        configurable: true,
        writable: true,
      });
    };

    afterEach(() => {
      delete (globalThis as { navigator?: unknown }).navigator;
      localStorage.clear();
    });

    it('uses Russian on a Russian system', async () => {
      localStorage.clear();
      withSystemLang(['ru-RU', 'en-US']);
      render(<App />);
      expect(await screen.findByRole('button', { name: 'Сервисы' })).toBeInTheDocument();
    });

    it('falls back to English when the system language is unavailable', async () => {
      localStorage.clear();
      withSystemLang(['de-DE', 'ja-JP']);
      render(<App />);
      expect(await screen.findByRole('button', { name: 'Services' })).toBeInTheDocument();
    });

    it('keeps the stored choice over the system language', async () => {
      localStorage.setItem('ospanel.lang', 'es');
      withSystemLang(['ru-RU']);
      render(<App />);
      expect(await screen.findByRole('button', { name: 'Servicios' })).toBeInTheDocument();
    });

    it('resets to system language when the stored language is missing', async () => {
      localStorage.setItem('ospanel.lang', 'deleted_lang');
      withSystemLang(['ru-RU']);
      render(<App />);
      expect(await screen.findByRole('button', { name: 'Сервисы' })).toBeInTheDocument();
      expect(localStorage.getItem('ospanel.lang')).toBe('ru');
    });

    it('falls back to English when stored language is missing and system language is unavailable', async () => {
      localStorage.setItem('ospanel.lang', 'deleted_lang');
      withSystemLang(['de-DE']);
      render(<App />);
      expect(await screen.findByRole('button', { name: 'Services' })).toBeInTheDocument();
      expect(localStorage.getItem('ospanel.lang')).toBe('en');
    });
  });

  // Regression: each notify() used to start its own timeout, so the previous toast's
  // timer hid the next toast before its own 2600 ms had elapsed.
  describe('toast timer race', () => {
    afterEach(() => {
      vi.useRealTimers();
      cleanup();
    });

    const toggleService = async (name: string) => {
      const row = screen.getByText(name).closest<HTMLElement>('.service-row');
      if (!row) throw new Error(`service row not found: ${name}`);
      fireEvent.click(within(row).getByRole('button', { name: 'Остановить' }));
      // The toast appears after the (mock) action promise resolves.
      await act(async () => {});
    };

    it('gives the second toast its full duration when toasts follow quickly', async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Сервисы' }));
      await screen.findByText('Apache');

      vi.useFakeTimers();
      await toggleService('Apache');
      expect(screen.getByText('Apache: остановлен')).toBeInTheDocument();

      // 2000 ms into the first toast's lifetime, 600 ms are still left on its timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await toggleService('PHP');
      expect(screen.getByText('PHP: остановлен')).toBeInTheDocument();

      // The stale first timer would hide the second toast right here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(screen.getByText('PHP: остановлен')).toBeInTheDocument();

      // The second toast lives its own full 2600 ms from the moment it appeared.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.queryByText('PHP: остановлен')).not.toBeInTheDocument();
    });
  });

  describe('App flows (browser mode)', () => {
    it('reports a failed panel discovery with a toast', async () => {
      ospanelMocks.discoverOsPanel.mockRejectedValueOnce(new Error('down'));
      render(<App />);
      expect(await screen.findByText('Не удалось проверить OSPanel')).toBeInTheDocument();
    });

    it('restarts the panel from Services and reports the desktop-only failure', async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Сервисы' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Перезапустить всё' }));

      expect(await screen.findByText('Действие доступно только в десктопном приложении')).toBeInTheDocument();
    });

    it('reports a failed panel folder open', async () => {
      render(<App />);
      // The button appears once the snapshot with detected=true has loaded.
      fireEvent.click(await screen.findByRole('button', { name: 'Открыть папку OSPanel' }));
      expect(await screen.findByText('Действие доступно только в десктопном приложении')).toBeInTheDocument();
    });

    it('deletes a project after confirmation and reports the failure', async () => {
      const confirm = confirmYes();
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Проекты' }));

      const row = await projectRow('my-shop.test');
      fireEvent.click(within(row).getByRole('button', { name: 'Действия' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить проект' }));

      expect(await screen.findByText('Действие доступно только в десктопном приложении')).toBeInTheDocument();
      // The browser confirm() receives the message only — the title is desktop-only.
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Удалить проект my-shop.test'));
    });

    it('toggles project TLS optimistically and offers the restart', async () => {
      confirmYes();
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Проекты' }));

      const row = await projectRow('my-shop.test');
      fireEvent.click(within(row).getByRole('button', { name: 'Активен' }));

      expect(
        await screen.findByText('TLS отключён для my-shop.test — перезапустите панель, чтобы применить'),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(within(row).getByRole('button', { name: 'Не настроен' })).toBeInTheDocument(),
      );
    });

    it('adds a created project to the list and restarts the panel from the toast', async () => {
      const confirm = confirmYes();
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Проекты' }));
      fireEvent.click(await screen.findByRole('button', { name: /Новый проект/ }));

      fireEvent.change(await screen.findByLabelText('Имя домена'), { target: { value: 'new-site.test' } });
      fireEvent.click(screen.getByRole('button', { name: 'Создать проект' }));

      expect(await screen.findByText('Проект new-site.test создан')).toBeInTheDocument();
      expect(await screen.findByText('new-site.test')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Перезапустить панель' }));
      expect(await screen.findByText('Действие доступно только в десктопном приложении')).toBeInTheDocument();
      expect(confirm).toHaveBeenCalledWith('Перезапустить OSPanel? Все запущенные модули будут остановлены.');
    });

    it('opens quick search with Ctrl+K and navigates to a settings tab', async () => {
      render(<App />);

      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      const input = await screen.findByRole('textbox', { name: 'Быстрый поиск' });
      fireEvent.change(input, { target: { value: 'уведомления' } });
      fireEvent.keyDown(document, { key: 'Enter' });

      expect(await screen.findByRole('button', { name: 'Показывать уведомления' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Быстрый поиск' })).not.toBeInTheDocument();
    });

    describe('theme selection', () => {
      const labels = { system: 'Системная', dark: 'Тёмная', light: 'Светлая' } as const;
      let systemChange: ((event: MediaQueryListEvent) => void) | undefined;

      beforeEach(() => {
        systemChange = undefined;
        const original = window.matchMedia.bind(window);
        vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
          const media = original(query);
          if (query !== '(prefers-color-scheme: light)') return media;
          return {
            ...media,
            matches: true,
            addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
              systemChange = listener as (event: MediaQueryListEvent) => void;
            },
          };
        });
      });

      afterEach(() => vi.restoreAllMocks());

      const shell = () => document.querySelector('.app-shell');
      const chooseTheme = (mode: keyof typeof labels) => {
        fireEvent.click(screen.getByRole('button', { name: 'Переключить тему' }));
        for (const label of Object.values(labels)) {
          expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
        }
        fireEvent.click(screen.getByRole('menuitem', { name: labels[mode] }));
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(localStorage.getItem('ospanel.theme')).toBe(mode);
      };
      const changeSystem = (matches: boolean) => {
        expect(systemChange).toBeDefined();
        act(() => systemChange?.({ matches } as MediaQueryListEvent));
      };

      it('defaults to the system theme on first launch and follows OS changes', () => {
        render(<App />);
        expect(screen.getByRole('button', { name: 'Переключить тему' })).toHaveAttribute(
          'title',
          labels.system,
        );
        expect(shell()).toHaveClass('light');
        changeSystem(false);
        expect(shell()).not.toHaveClass('light');
        changeSystem(true);
        expect(shell()).toHaveClass('light');
      });

      it.each(['system', 'dark', 'light'] as const)('restores the saved %s mode', (mode) => {
        localStorage.setItem('ospanel.theme', mode);
        render(<App />);
        expect(screen.getByRole('button', { name: 'Переключить тему' })).toHaveAttribute(
          'title',
          labels[mode],
        );
        expect(shell()?.classList.contains('light')).toBe(mode !== 'dark');
      });

      it('selects and persists all three modes from the topbar', () => {
        render(<App />);
        chooseTheme('dark');
        expect(shell()).not.toHaveClass('light');
        changeSystem(false);
        changeSystem(true);
        expect(shell()).not.toHaveClass('light');
        chooseTheme('light');
        changeSystem(false);
        expect(shell()).toHaveClass('light');
        chooseTheme('system');
        expect(shell()).not.toHaveClass('light');
        changeSystem(true);
        expect(shell()).toHaveClass('light');
      });

      it('keeps the topbar and appearance settings synchronized', async () => {
        render(<App />);
        fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Внешний вид' }));
        expect(screen.getByRole('button', { name: labels.system })).toHaveClass('selected');
        chooseTheme('dark');
        expect(screen.getByRole('button', { name: labels.dark })).toHaveClass('selected');
        fireEvent.click(screen.getByRole('button', { name: labels.system }));
        expect(localStorage.getItem('ospanel.theme')).toBe('system');
        expect(screen.getByRole('button', { name: 'Переключить тему' })).toHaveAttribute(
          'title',
          labels.system,
        );
      });
    });

    it('collapses the sidebar and persists it', () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Свернуть панель' }));
      expect(localStorage.getItem('ospanel.sidebar')).toBe('1');
      expect(screen.getByRole('button', { name: 'Развернуть панель' })).toBeInTheDocument();
    });

    it('counts errors from the active log tail in the Logs badge', async () => {
      render(<App />);
      expect(await screen.findByTitle('Ошибок в журнале: 1')).toBeInTheDocument();
    });

    it('persists the appearance settings chosen on the Settings page', async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Внешний вид' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Синяя' }));
      await waitFor(() => expect(localStorage.getItem('ospanel.accent')).toBe('blue'));

      fireEvent.click(screen.getByRole('button', { name: 'DM Sans (по умолчанию)' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Consolas (моноширинный)' }));
      await waitFor(() => expect(localStorage.getItem('ospanel.font')).toBe('consolas'));

      fireEvent.change(screen.getByRole('slider', { name: 'Размер шрифта' }), { target: { value: '120' } });
      await waitFor(() => expect(localStorage.getItem('ospanel.scale')).toBe('120'));
    });

    it('re-resolves the installation after the connection path is saved', async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
      const input = await screen.findByRole('textbox', { name: 'Путь к OSPanel' });
      fireEvent.change(input, { target: { value: 'D:\\Custom' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => expect(localStorage.getItem('ospanel.path')).toBe('D:\\Custom'));
      expect(await screen.findByText('Путь сохранён: D:\\Custom')).toBeInTheDocument();
      // The saved path triggers a fresh snapshot resolution.
      expect(ospanelMocks.discoverOsPanel.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('reloads translations and reports success', async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Внешний вид' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Перечитать переводы' }));

      expect(await screen.findByText('Переводы перечитаны')).toBeInTheDocument();
    });

    it('switches the interface language from the Settings page', async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Настройки' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Внешний вид' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Русский' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'English' }));

      expect(await screen.findByRole('button', { name: 'Services' })).toBeInTheDocument();
      expect(localStorage.getItem('ospanel.lang')).toBe('en');
    });

    it('closes the toast with its close button', async () => {
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Открыть папку OSPanel' }));
      expect(await screen.findByText('Действие доступно только в десктопном приложении')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
      await waitFor(() =>
        expect(
          screen.queryByText('Действие доступно только в десктопном приложении'),
        ).not.toBeInTheDocument(),
      );
    });
  });
});
