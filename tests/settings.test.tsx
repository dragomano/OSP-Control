import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../src/components/pages/Settings';
import type { Notify, SettingsTab } from '../src/components/shared';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import type { ThemeMode } from '../src/theme';

const mocks = vi.hoisted(() => ({
  autostartEnabled: vi.fn(),
  closeToTrayEnabled: vi.fn(),
  setAutostart: vi.fn(),
  setCloseToTray: vi.fn(),
  pickOsPanelDirectory: vi.fn(),
}));

vi.mock('../src/ospanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ospanel')>();
  return { ...actual, ...mocks };
});

const t = makeTranslator(embeddedDict('en'), embeddedDict('en'));
const plural = makePlural(t, 'en', embeddedDict('en'));

const baseProps = () => ({
  notify: vi.fn<Notify>(),
  onPathSaved: vi.fn(),
  installationPath: null as string | null,
  tab: 'connection' as SettingsTab,
  onTabChange: vi.fn(),
  onProjectAutostartChange: vi.fn(),
  themeMode: 'system' as ThemeMode,
  setTheme: vi.fn(),
  accent: 'green',
  onAccentChange: vi.fn(),
  font: 'dm-sans',
  onFontChange: vi.fn(),
  scale: 100,
  onScaleChange: vi.fn(),
  lang: 'en',
  onLangChange: vi.fn(),
  locales: [
    { code: 'en', name: 'English' },
    { code: 'ru', name: 'Русский' },
  ],
  onReloadLocales: vi.fn().mockResolvedValue(undefined),
});

type Props = ReturnType<typeof baseProps>;

const renderSettings = (overrides: Partial<Props> = {}) => {
  const props = { ...baseProps(), ...overrides };
  const view = render(
    <I18nContext.Provider value={{ lang: props.lang, t, plural }}>
      <Settings {...props} />
    </I18nContext.Provider>,
  );
  return { props, view };
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.autostartEnabled.mockResolvedValue(false);
  mocks.closeToTrayEnabled.mockResolvedValue(false);
  mocks.setAutostart.mockResolvedValue(undefined);
  mocks.setCloseToTray.mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(() => cleanup());

describe('Settings installation path', () => {
  it('uses a neutral placeholder when no path is saved or detected', () => {
    renderSettings();
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });

    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', 'Detected automatically');
  });

  it('shows the detected installation path after snapshot loading', async () => {
    renderSettings({ installationPath: 'D:\\OSPanel6' });
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });

    await waitFor(() => expect(input).toHaveValue(String.raw`D:\OSPanel6`));
  });

  it('keeps a saved path over the detected installation path', () => {
    localStorage.setItem('ospanel.path', 'C:\\CustomPanel');
    renderSettings({ installationPath: 'D:\\OSPanel6' });

    expect(screen.getByRole('textbox', { name: 'OSPanel path' })).toHaveValue('C:\\CustomPanel');
  });

  it('does not overwrite a path edited before snapshot loading', async () => {
    const { props, view } = renderSettings({ installationPath: 'D:\\OSPanel6' });
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });
    fireEvent.change(input, { target: { value: 'E:\\LocalPanel' } });

    view.rerender(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Settings {...props} installationPath={'D:\\OSPanel6'} />
      </I18nContext.Provider>,
    );

    expect(input).toHaveValue('E:\\LocalPanel');
  });

  it('commits the typed path on Enter and reverts it on Escape', () => {
    const { props } = renderSettings();
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });

    fireEvent.change(input, { target: { value: 'D:\\Typed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(localStorage.getItem('ospanel.path')).toBe('D:\\Typed');
    expect(props.onPathSaved).toHaveBeenCalledWith('D:\\Typed');
    expect(props.notify).toHaveBeenCalledWith('Path saved: D:\\Typed');

    fireEvent.change(input, { target: { value: 'E:\\Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('D:\\Typed');
  });

  it('requires a non-empty path on commit', async () => {
    const { props } = renderSettings({ installationPath: 'D:\\OSPanel6' });
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });
    await waitFor(() => expect(input).toHaveValue(String.raw`D:\OSPanel6`));

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(props.notify).toHaveBeenCalledWith('Specify the OSPanel path');
    expect(input).toHaveValue(String.raw`D:\OSPanel6`);
  });

  it('saves the folder chosen through the picker', async () => {
    mocks.pickOsPanelDirectory.mockResolvedValue('D:\\Chosen');
    const { props } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await vi.waitFor(() => expect(props.notify).toHaveBeenCalledWith('Folder selected: D:\\Chosen'));
    expect(localStorage.getItem('ospanel.path')).toBe('D:\\Chosen');
    expect(props.onPathSaved).toHaveBeenCalledWith('D:\\Chosen');
  });

  it('reports a failed folder picker', async () => {
    mocks.pickOsPanelDirectory.mockRejectedValue(new Error('boom'));
    const { props } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await vi.waitFor(() => expect(props.notify).toHaveBeenCalledWith('Failed to open the folder picker'));
  });
});

describe('Settings autostart tab', () => {
  const openTab = (overrides: Partial<Props> = {}) => renderSettings({ tab: 'autostart', ...overrides });

  it('switches Windows autostart on and reports a failure', async () => {
    const { props } = openTab();
    const toggle = screen.getByRole('button', { name: 'Start with Windows' });

    fireEvent.click(toggle);
    await vi.waitFor(() => expect(mocks.setAutostart).toHaveBeenCalledWith(true));
    await waitFor(() => expect(toggle).toHaveClass('on'));
    expect(props.notify).toHaveBeenCalledWith('Autostart enabled');
  });

  it('keeps the toggle off when the autostart command fails', async () => {
    mocks.setAutostart.mockRejectedValue(new Error('boom'));
    const { props } = openTab();
    const toggle = screen.getByRole('button', { name: 'Start with Windows' });

    fireEvent.click(toggle);

    await vi.waitFor(() => expect(props.notify).toHaveBeenCalledWith('Failed to change autostart'));
    expect(toggle).not.toHaveClass('on');
  });

  it('persists the project module autostart locally', () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'Start modules per project' }));

    expect(localStorage.getItem('ospanel.autostartProjects')).toBe('1');
    expect(props.onProjectAutostartChange).toHaveBeenCalledWith(true);
    expect(props.notify).toHaveBeenCalledWith('Project module autostart enabled');
  });

  it('toggles close-to-tray and resyncs the tray after a language change', async () => {
    const { props, view } = openTab();
    const toggle = screen.getByRole('button', { name: 'Close to system tray' });

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveClass('on'));
    expect(mocks.setCloseToTray).toHaveBeenCalledWith(true, 'en');
    expect(props.notify).toHaveBeenCalledWith('The window will be hidden to the tray');

    view.rerender(
      <I18nContext.Provider value={{ lang: 'ru', t, plural }}>
        <Settings {...props} lang="ru" />
      </I18nContext.Provider>,
    );
    await vi.waitFor(() => expect(mocks.setCloseToTray).toHaveBeenCalledWith(true, 'ru'));
  });

  it('disables notifications and remembers it', () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'Show notifications' }));

    expect(localStorage.getItem('ospanel.notify')).toBe('0');
    expect(props.notify).toHaveBeenCalledWith('Notifications disabled');
  });
});

describe('Settings appearance tab', () => {
  const openTab = () => renderSettings({ tab: 'appearance' });

  it('switches the interface theme', () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    expect(props.setTheme).toHaveBeenCalledWith('dark');
  });

  it('changes the accent color scheme', () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));

    expect(props.onAccentChange).toHaveBeenCalledWith('blue');
  });

  it('changes the interface language from the menu', () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Русский' }));

    expect(props.onLangChange).toHaveBeenCalledWith('ru');
  });

  it('reloads the translations on demand', async () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'Reload translations' }));

    expect(props.onReloadLocales).toHaveBeenCalled();
  });

  it('changes the interface font from the menu', () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'DM Sans (default)' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Consolas (monospace)' }));

    expect(props.onFontChange).toHaveBeenCalledWith('consolas');
  });

  it('reports the changed UI scale', () => {
    const { props } = openTab();

    fireEvent.change(screen.getByRole('slider', { name: 'Font size' }), { target: { value: '120' } });

    expect(props.onScaleChange).toHaveBeenCalledWith(120);
  });
});

describe('Settings navigation', () => {
  it('propagates the tab selection', () => {
    const { props } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Autostart & notifications' }));
    expect(props.onTabChange).toHaveBeenCalledWith('autostart');

    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(props.onTabChange).toHaveBeenCalledWith('appearance');
  });
});
