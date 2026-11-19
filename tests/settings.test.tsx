import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../src/components/pages/Settings';
import type { Notify, SettingsTab } from '../src/components/shared';
import { embeddedDict, I18nContext, makePlural, makeTranslator } from '../src/i18n';
import { FONT_OPTIONS, type ThemeMode } from '../src/theme';
import { selectOption } from './selectOption';

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
  tab: 'general' as SettingsTab,
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

function ScaleSettings({ props }: { props: Props }) {
  const [scale, setScale] = useState(100);
  return (
    <Settings
      {...props}
      tab="interface"
      scale={scale}
      onScaleChange={(value) => {
        props.onScaleChange(value);
        setScale(value);
      }}
    />
  );
}

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
    renderSettings({ installationPath: 'X:\\TestPanel' });
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });

    await waitFor(() => expect(input).toHaveValue(String.raw`X:\TestPanel`));
  });

  it('keeps a saved path over the detected installation path', () => {
    localStorage.setItem('ospanel.path', 'C:\\CustomPanel');
    renderSettings({ installationPath: 'X:\\TestPanel' });

    expect(screen.getByRole('textbox', { name: 'OSPanel path' })).toHaveValue('C:\\CustomPanel');
  });

  it('does not overwrite a path edited before snapshot loading', async () => {
    const { props, view } = renderSettings({ installationPath: 'X:\\TestPanel' });
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });
    fireEvent.change(input, { target: { value: 'E:\\LocalPanel' } });

    view.rerender(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Settings {...props} installationPath={'X:\\TestPanel'} />
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
    const { props } = renderSettings({ installationPath: 'X:\\TestPanel' });
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });
    await waitFor(() => expect(input).toHaveValue(String.raw`X:\TestPanel`));

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(props.notify).toHaveBeenCalledWith('Specify the OSPanel path');
    expect(input).toHaveValue(String.raw`X:\TestPanel`);
  });

  it('saves the folder chosen through the picker', async () => {
    mocks.pickOsPanelDirectory.mockResolvedValue('D:\\Chosen');
    const { props } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await vi.waitFor(() => expect(props.notify).toHaveBeenCalledWith('Folder selected: D:\\Chosen'));
    expect(localStorage.getItem('ospanel.path')).toBe('D:\\Chosen');
    expect(props.onPathSaved).toHaveBeenCalledWith('D:\\Chosen');
  });

  it('allows typing and choosing a path while startup checks are pending', async () => {
    mocks.autostartEnabled.mockReturnValue(new Promise(() => {}));
    mocks.closeToTrayEnabled.mockReturnValue(new Promise(() => {}));
    mocks.pickOsPanelDirectory.mockResolvedValue('D:\\Chosen');
    const { props } = renderSettings();
    const input = screen.getByRole('textbox', { name: 'OSPanel path' });
    const picker = screen.getByRole('button', { name: 'Choose folder' });

    expect(input).toBeEnabled();
    expect(picker).toBeEnabled();
    fireEvent.change(input, { target: { value: 'D:\\Typed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onPathSaved).toHaveBeenCalledWith('D:\\Typed');

    fireEvent.click(picker);
    await waitFor(() => expect(props.onPathSaved).toHaveBeenCalledWith('D:\\Chosen'));
    expect(input).toHaveValue('D:\\Chosen');
  });

  it('reports a failed folder picker', async () => {
    mocks.pickOsPanelDirectory.mockRejectedValue(new Error('boom'));
    const { props } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await vi.waitFor(() => expect(props.notify).toHaveBeenCalledWith('Failed to open the folder picker'));
  });
});

describe('Settings autostart tab', () => {
  const openTab = (overrides: Partial<Props> = {}) => renderSettings({ tab: 'general', ...overrides });

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

  it('persists the panel auto-launch locally', () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'Launch OSPanel on app start' }));

    expect(localStorage.getItem('ospanel.autostartPanel')).toBe('1');
    expect(props.notify).toHaveBeenCalledWith('OSPanel auto-launch enabled');
  });

  it('keeps update checks on their own tab', () => {
    const connection = renderSettings();
    expect(screen.queryByRole('button', { name: 'Check for module updates at startup' })).toBeNull();
    connection.view.unmount();

    renderSettings({ tab: 'updates' });
    const updateToggle = screen.getByRole('button', {
      name: 'Check for module updates at startup',
    });
    expect(screen.queryByRole('button', { name: 'Start modules per project' })).toBeNull();

    expect(updateToggle).toHaveClass('large-toggle');
    expect(updateToggle).not.toHaveClass('on');
    fireEvent.click(updateToggle);
    expect(updateToggle).toHaveClass('on');
    expect(localStorage.getItem('ospanel.checkServiceUpdates')).toBe('1');
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
  const openTab = () => renderSettings({ tab: 'interface' });

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

    selectOption(screen.getByRole('combobox', { name: 'Interface language' }), 'Русский');

    expect(props.onLangChange).toHaveBeenCalledWith('ru');
  });

  it('reloads the translations on demand', async () => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: 'Reload translations' }));

    expect(props.onReloadLocales).toHaveBeenCalled();
  });

  it('changes the interface font from the menu', () => {
    const { props } = openTab();

    selectOption(screen.getByRole('combobox', { name: 'Interface font' }), 'Consolas (monospace)');

    expect(props.onFontChange).toHaveBeenCalledWith('consolas');
  });

  it('previews every interface font in its own typeface', () => {
    openTab();
    const control = screen.getByRole('combobox', { name: 'Interface font' });
    const consolas = FONT_OPTIONS.find((item) => item.id === 'consolas');

    expect(control).toHaveAttribute('name', 'interface-font');
    expect(within(control).getByRole('option', { name: 'Consolas (monospace)' })).toHaveStyle({
      fontFamily: consolas?.stack,
    });
    expect(control.parentElement?.querySelector('.ui-select-label')).toHaveStyle({
      fontFamily: FONT_OPTIONS[0].stack,
    });
  });

  it('offers every UI scale from 80 to 130 in steps of ten', () => {
    openTab();
    const group = screen.getByRole('group', { name: 'Font size' });
    const buttons = Array.from(group.querySelectorAll('button'));

    expect(buttons.map((button) => button.textContent)).toEqual([
      '80%',
      '90%',
      '100%',
      '110%',
      '120%',
      '130%',
    ]);
    expect(screen.getByRole('button', { name: '100%' })).toHaveAttribute('aria-pressed', 'true');
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(screen.queryByRole('slider', { name: 'Font size' })).toBeNull();
  });

  it.each([80, 90, 100, 110, 120, 130])('reports a selected UI scale of %i', (value) => {
    const { props } = openTab();

    fireEvent.click(screen.getByRole('button', { name: `${value}%` }));

    expect(props.onScaleChange).toHaveBeenCalledExactlyOnceWith(value);
  });

  it('applies adjacent scales and moves focus after a mouse selection', () => {
    const props = baseProps();
    render(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <ScaleSettings props={props} />
      </I18nContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '110%' }));
    expect(screen.getByRole('button', { name: '110%' })).toHaveFocus();
    for (const [key, value] of [
      ['ArrowRight', 120],
      ['ArrowRight', 130],
      ['ArrowLeft', 120],
    ] as const) {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLButtonElement)) throw new Error('Expected a focused scale button');
      fireEvent.keyDown(focused, { key });
      const selected = screen.getByRole('button', { name: `${value}%` });
      expect(selected).toHaveFocus();
      expect(selected).toHaveAttribute('aria-pressed', 'true');
      expect(props.onScaleChange).toHaveBeenLastCalledWith(value);
    }
    expect(props.onScaleChange.mock.calls).toEqual([[110], [120], [130], [120]]);
  });

  it.each([
    [80, 'ArrowLeft'],
    [130, 'ArrowRight'],
  ] as const)('stops at %i without wrapping or reapplying the scale', (value, key) => {
    const { props } = renderSettings({ tab: 'interface', scale: value });
    const button = screen.getByRole('button', { name: `${value}%` });
    button.focus();

    expect(fireEvent.keyDown(button, { key })).toBe(false);

    expect(button).toHaveFocus();
    expect(props.onScaleChange).not.toHaveBeenCalled();
  });

  it('leaves other keys, modified arrows and controls unaffected', () => {
    const { props } = openTab();
    const button = screen.getByRole('button', { name: '100%' });
    button.focus();
    for (const key of ['ArrowUp', 'ArrowDown', 'Tab']) {
      expect(fireEvent.keyDown(button, { key })).toBe(true);
    }
    expect(fireEvent.keyDown(button, { key: 'ArrowRight', ctrlKey: true })).toBe(true);
    const otherControl = screen.getByRole('button', { name: 'Dark' });
    otherControl.focus();
    expect(fireEvent.keyDown(otherControl, { key: 'ArrowRight' })).toBe(true);

    expect(otherControl).toHaveFocus();
    expect(props.onScaleChange).not.toHaveBeenCalled();
  });

  it('reflects the applied UI scale when it changes', () => {
    const { props, view } = openTab();

    view.rerender(
      <I18nContext.Provider value={{ lang: 'en', t, plural }}>
        <Settings {...props} scale={130} />
      </I18nContext.Provider>,
    );

    expect(screen.getByRole('button', { name: '130%' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '130%' })).toHaveClass('btn-primary');
    expect(screen.getByRole('button', { name: '100%' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '100%' })).not.toHaveClass('btn-primary');
  });
});

describe('Settings navigation', () => {
  it('propagates the tab selection', () => {
    const { props } = renderSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(props.onTabChange).toHaveBeenCalledWith('general');

    fireEvent.click(screen.getByRole('tab', { name: 'Interface' }));
    expect(props.onTabChange).toHaveBeenCalledWith('interface');
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }));
    expect(props.onTabChange).toHaveBeenCalledWith('updates');
  });
});

describe('module update source editor', () => {
  it('keeps drafts per module, saves all lists in order and permits an empty list', async () => {
    renderSettings({ tab: 'updates' });
    fireEvent.click(screen.getByRole('button', { name: 'Configure PHP sources' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'PHP' }), {
      target: { value: 'https://mirror.example/php/\nhttps://github.com/team/php/releases' },
    });
    fireEvent.click(screen.getByRole('tab', { name: /Apache/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Apache' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: /PHP/ }));
    expect(screen.getByRole('textbox', { name: 'PHP' })).toHaveValue(
      'https://mirror.example/php/\nhttps://github.com/team/php/releases',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const saved = JSON.parse(localStorage.getItem('ospanel.moduleUpdateSources') ?? '{}');
    expect(saved.php).toEqual(['https://mirror.example/php/', 'https://github.com/team/php/releases']);
    expect(saved.apache).toEqual([]);
  });

  it('validates every list and preserves persisted values when cancelled', () => {
    renderSettings({ tab: 'updates' });
    fireEvent.click(screen.getByRole('button', { name: 'Configure PHP sources' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'PHP' }), { target: { value: 'file:///secret' } });
    fireEvent.click(screen.getByRole('tab', { name: /Caddy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Line 1');
    expect(screen.getByRole('textbox', { name: 'PHP' })).toHaveValue('file:///secret');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(localStorage.getItem('ospanel.moduleUpdateSources')).toBeNull();
  });
});
