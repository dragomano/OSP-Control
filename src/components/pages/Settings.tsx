import {
  CircleCheck,
  FolderOpen,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { AppUpdateSettings } from '../../appUpdates';
import { COLOR_THEMES, colorThemeIsLight, colorThemeSwatches } from '../../colorThemes';
import { errorText, type LocaleInfo, useI18n } from '../../i18n';
import { useModuleUpdates } from '../../moduleUpdates';
import {
  autostartEnabled,
  closeToTrayEnabled,
  persistOsPanelPath,
  pickOsPanelDirectory,
  setAutostart,
  setCloseToTray,
} from '../../ospanel';
import { paletteContent } from '../../paletteColors';
import { settingsStorage } from '../../settingsStorage';
import {
  ACCENT_THEMES,
  accentSwatch,
  FONT_OPTIONS,
  type ThemeMode,
  useSystemPrefersLight,
} from '../../theme';
import type { Notify, SettingsTab } from '../shared';
import { Actions, Button, FormRow, Input, Panel, SectionHeader, Select, Tab, Tabs, Toggle } from '../ui';
import { MenuSelect } from '../widgets/MenuSelect';
import { ModuleUpdateSources } from '../widgets/ModuleUpdateSources';
import { PageHeader } from '../widgets/PageHeader';
import { PathText } from '../widgets/PathText';
import './settings.css';

const settingsTabs = [
  { id: 'general', key: 'settings.navGeneral', icon: SlidersHorizontal, description: 'settings.generalText' },
  { id: 'updates', key: 'settings.navUpdates', icon: RefreshCw, description: 'settings.updatesText' },
  { id: 'interface', key: 'settings.navInterface', icon: Palette, description: 'settings.interfaceText' },
] as const;

export function Settings({
  notify,
  onPathSaved,
  installationPath,
  tab,
  onTabChange,
  onProjectAutostartChange,
  themeMode,
  setTheme,
  colorTheme = 'default',
  onColorThemeChange,
  accent,
  onAccentChange,
  font,
  onFontChange,
  scale,
  onScaleChange,
  lang,
  onLangChange,
  locales,
  onReloadLocales,
}: {
  notify: Notify;
  onPathSaved: (path: string) => void;
  installationPath: string | null;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onProjectAutostartChange: (enabled: boolean) => void;
  themeMode: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  colorTheme?: string;
  onColorThemeChange?: (id: string) => void;
  accent: string;
  onAccentChange: (id: string) => void;
  font: string;
  onFontChange: (id: string) => void;
  scale: number;
  onScaleChange: (value: number) => void;
  lang: string;
  onLangChange: (code: string) => void;
  locales: LocaleInfo[];
  onReloadLocales: () => Promise<void>;
}) {
  const { t } = useI18n();
  const activeMode = themeMode;
  const systemLight = useSystemPrefersLight();
  const swatches = colorThemeSwatches(colorTheme, colorThemeIsLight(colorTheme, themeMode, systemLight));
  const updates = useModuleUpdates();
  const busyRef = useRef(updates.busy);
  busyRef.current = updates.busy;
  const [checkUpdates, setCheckUpdates] = useState(
    () => settingsStorage.getItem('ospanel.checkServiceUpdates') === '1',
  );
  const [osPath, setOsPath] = useState(
    () => settingsStorage.getItem('ospanel.path') ?? installationPath ?? '',
  );
  const [autostart, setAutostartState] = useState(false);
  const [closeToTray, setCloseToTrayState] = useState(false);
  const [notifications, setNotifications] = useState(() => settingsStorage.getItem('ospanel.notify') !== '0');
  const [projectAutostart, setProjectAutostartState] = useState(
    () => settingsStorage.getItem('ospanel.autostartProjects') === '1',
  );
  const [panelAutostart, setPanelAutostartState] = useState(
    () => settingsStorage.getItem('ospanel.autostartPanel') === '1',
  );
  // The language the tray icon was last built with — a change of language rebuilds it below.
  const trayLangRef = useRef('');

  useEffect(() => {
    void autostartEnabled()
      .then(setAutostartState)
      .catch(() => setAutostartState(false));
    void closeToTrayEnabled()
      .then(setCloseToTrayState)
      .catch(() => setCloseToTrayState(false));
  }, []);

  // The path is saved automatically, like the other settings: committed on blur or Enter,
  // Esc reverts the input. Saving triggers a re-resolve of the installation (loadSnapshot),
  // so only a meaningful changed value is committed, not every keystroke.
  const savedPathRef = useRef(osPath);
  const pathEditedRef = useRef(false);

  useEffect(() => {
    if (settingsStorage.getItem('ospanel.path') || !installationPath || pathEditedRef.current || osPath)
      return;
    savedPathRef.current = installationPath;
    setOsPath(installationPath);
  }, [installationPath, osPath]);

  // One place for the four steps every accepted path goes through.
  const applyPath = (path: string, toastKey: string) => {
    if (busyRef.current) return;
    updates.reset();
    pathEditedRef.current = true;
    savedPathRef.current = path;
    setOsPath(path);
    persistOsPanelPath(path);
    onPathSaved(path);
    notify(t(toastKey, { path }));
  };
  const commitPath = () => {
    const trimmed = osPath.trim();

    if (trimmed === savedPathRef.current.trim()) return;
    if (!trimmed) {
      setOsPath(savedPathRef.current);
      notify(t('settings.toastPathRequired'));
      return;
    }

    applyPath(trimmed, 'settings.toastPathSaved');
  };

  const choosePath = async () => {
    try {
      const selected = await pickOsPanelDirectory(osPath, t('settings.folderDialogTitle'));

      if (selected) applyPath(selected, 'settings.toastFolderChosen');
    } catch {
      notify(t('settings.toastDialogFailed'));
    }
  };
  const toggleAutostart = async () => {
    const next = !autostart;
    try {
      await setAutostart(next);
      setAutostartState(next);
      notify(t(next ? 'settings.autostartOn' : 'settings.autostartOff'));
    } catch (error) {
      notify(errorText(t, error, 'settings.autostartFailed'));
    }
  };
  const toggleCloseToTray = async () => {
    const next = !closeToTray;
    try {
      await setCloseToTray(next, lang);
      // Tray labels were already applied with the current language — no resync needed below.
      trayLangRef.current = lang;
      setCloseToTrayState(next);
      notify(t(next ? 'settings.closeToTrayOn' : 'settings.closeToTrayOff'));
    } catch (error) {
      notify(errorText(t, error, 'settings.closeToTrayFailed'));
    }
  };

  // On language change, recreate the tray icon with labels from the new dictionary.
  useEffect(() => {
    if (!closeToTray || trayLangRef.current === lang) return;

    trayLangRef.current = lang;
    void setCloseToTray(true, lang).catch(() => {
      trayLangRef.current = '';
      setCloseToTrayState(false);
    });
  }, [closeToTray, lang]);

  const toggleProjectAutostart = () => {
    const next = !projectAutostart;
    setProjectAutostartState(next);
    settingsStorage.setItem('ospanel.autostartProjects', next ? '1' : '0');
    notify(t(next ? 'settings.projectAutostartOn' : 'settings.projectAutostartOff'));
    onProjectAutostartChange(next);
  };
  const togglePanelAutostart = () => {
    const next = !panelAutostart;
    setPanelAutostartState(next);
    settingsStorage.setItem('ospanel.autostartPanel', next ? '1' : '0');
    notify(t(next ? 'settings.panelAutostartOn' : 'settings.panelAutostartOff'));
  };
  const toggleNotifications = () => {
    const next = !notifications;
    setNotifications(next);
    settingsStorage.setItem('ospanel.notify', next ? '1' : '0');
    notify(t(next ? 'settings.notificationsOn' : 'settings.notificationsOff'));
  };

  const currentTab = settingsTabs.find((item) => item.id === tab) ?? settingsTabs[0];
  return (
    <>
      <PageHeader
        eyebrow={t('nav.system')}
        heading={t('nav.settings')}
        description={t('settings.subtitle')}
      />
      <div className="settings-layout">
        <Tabs className="settings-nav" role="tablist" aria-label={t('nav.settings')}>
          {settingsTabs.map((item) => (
            <Tab
              type="button"
              key={item.id}
              id={`settings-tab-${item.id}`}
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="settings-tab-panel"
              className={tab === item.id ? 'selected' : ''}
              onClick={() => onTabChange(item.id)}
            >
              <item.icon size={14} />
              {t(item.key)}
            </Tab>
          ))}
        </Tabs>
        <div role="tabpanel" id="settings-tab-panel" aria-labelledby={`settings-tab-${currentTab.id}`}>
          <SectionHeader className="settings-section-head">
            <h2>{t(currentTab.key)}</h2>
            <p>{t(currentTab.description)}</p>
          </SectionHeader>
          {tab === 'general' && (
            <>
              <Panel className="settings-card">
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.autostartTitle')}</h3>
                    <p>{t('settings.autostartText')}</p>
                  </div>
                  <Toggle
                    checked={autostart}
                    type="button"
                    className={`large-toggle ${autostart ? 'on' : ''}`}
                    onClick={() => void toggleAutostart()}
                    aria-label={t('settings.autostartTitle')}
                  >
                    <span />
                  </Toggle>
                </FormRow>
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.closeToTrayTitle')}</h3>
                    <p>{t('settings.closeToTrayText')}</p>
                  </div>
                  <Toggle
                    checked={closeToTray}
                    type="button"
                    className={`large-toggle ${closeToTray ? 'on' : ''}`}
                    onClick={() => void toggleCloseToTray()}
                    aria-label={t('settings.closeToTrayTitle')}
                  >
                    <span />
                  </Toggle>
                </FormRow>
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.notificationsTitle')}</h3>
                    <p>{t('settings.notificationsText')}</p>
                  </div>
                  <Toggle
                    checked={notifications}
                    type="button"
                    className={`large-toggle ${notifications ? 'on' : ''}`}
                    onClick={toggleNotifications}
                    aria-label={t('settings.notificationsTitle')}
                  >
                    <span />
                  </Toggle>
                </FormRow>
              </Panel>
              <Panel className="settings-card">
                <FormRow className="setting-block settings-path">
                  <div>
                    <h3>{t('settings.connectionTitle')}</h3>
                    <p>{t('settings.connectionText')}</p>
                  </div>
                  <div className="path-field">
                    <Input
                      value={osPath}
                      disabled={updates.busy}
                      onChange={(event) => {
                        pathEditedRef.current = true;
                        setOsPath(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitPath();
                        } else if (event.key === 'Escape') {
                          setOsPath(savedPathRef.current);
                        }
                      }}
                      onBlur={commitPath}
                      placeholder={t('settings.pathPlaceholder')}
                      aria-label={t('settings.connectionTitle')}
                    />
                    <Button
                      type="button"
                      className="secondary-button"
                      disabled={updates.busy}
                      onClick={choosePath}
                    >
                      <FolderOpen size={14} />
                      {t('settings.chooseFolder')}
                    </Button>
                  </div>
                </FormRow>
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.panelAutostartTitle')}</h3>
                    <p>{t('settings.panelAutostartText')}</p>
                  </div>
                  <Toggle
                    checked={panelAutostart}
                    type="button"
                    className={`large-toggle ${panelAutostart ? 'on' : ''}`}
                    onClick={togglePanelAutostart}
                    aria-label={t('settings.panelAutostartTitle')}
                  >
                    <span />
                  </Toggle>
                </FormRow>
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.projectAutostartTitle')}</h3>
                    <p>
                      <PathText text={t('settings.projectAutostartText')} />
                    </p>
                  </div>
                  <Toggle
                    checked={projectAutostart}
                    type="button"
                    className={`large-toggle ${projectAutostart ? 'on' : ''}`}
                    onClick={toggleProjectAutostart}
                    aria-label={t('settings.projectAutostartTitle')}
                  >
                    <span />
                  </Toggle>
                </FormRow>
              </Panel>
            </>
          )}
          {tab === 'updates' && (
            <>
              <Panel className="settings-card">
                <AppUpdateSettings />
              </Panel>
              <Panel className="settings-card">
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.checkModuleUpdates')}</h3>
                    <p>{t('settings.moduleUpdatesText')}</p>
                  </div>
                  <Toggle
                    checked={checkUpdates}
                    type="button"
                    className={`large-toggle ${checkUpdates ? 'on' : ''}`}
                    onClick={() => {
                      const next = !checkUpdates;
                      setCheckUpdates(next);
                      settingsStorage.setItem('ospanel.checkServiceUpdates', next ? '1' : '0');
                    }}
                    aria-label={t('settings.checkModuleUpdates')}
                  >
                    <span />
                  </Toggle>
                </FormRow>
                <ModuleUpdateSources notify={notify} />
              </Panel>
            </>
          )}
          {tab === 'interface' && (
            <>
              <Panel className="settings-card">
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.themeTitle')}</h3>
                    <p>{t('settings.themeText')}</p>
                  </div>
                  <div className="theme-grid">
                    <Button
                      layout="column"
                      selected={Boolean(activeMode === 'system')}
                      aria-pressed={activeMode === 'system'}
                      variant="ghost"
                      type="button"
                      className={`theme-card ${activeMode === 'system' ? 'selected' : ''}`}
                      onClick={() => setTheme('system')}
                    >
                      <Monitor size={18} />
                      <b>{t('settings.themeSystem')}</b>
                    </Button>
                    <Button
                      layout="column"
                      selected={Boolean(activeMode === 'dark')}
                      aria-pressed={activeMode === 'dark'}
                      variant="ghost"
                      type="button"
                      className={`theme-card ${activeMode === 'dark' ? 'selected' : ''}`}
                      onClick={() => setTheme('dark')}
                    >
                      <Moon size={18} />
                      <b>{t('settings.themeDark')}</b>
                    </Button>
                    <Button
                      layout="column"
                      selected={Boolean(activeMode === 'light')}
                      aria-pressed={activeMode === 'light'}
                      variant="ghost"
                      type="button"
                      className={`theme-card ${activeMode === 'light' ? 'selected' : ''}`}
                      onClick={() => setTheme('light')}
                    >
                      <Sun size={18} />
                      <b>{t('settings.themeLight')}</b>
                    </Button>
                  </div>
                </FormRow>
                <FormRow className="setting-block">
                  <div>
                    <label htmlFor="color-theme">{t('settings.paletteTitle')}</label>
                    <p>{t('settings.paletteText')}</p>
                  </div>
                  <Select
                    id="color-theme"
                    className="settings-palette-select"
                    value={colorTheme}
                    onChange={(event) => onColorThemeChange?.(event.target.value)}
                  >
                    {Object.entries(COLOR_THEMES).map(([id, palette]) => (
                      <option key={id} value={id}>
                        {palette.name}
                      </option>
                    ))}
                  </Select>
                </FormRow>
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.accentTitle')}</h3>
                    <p>{t('settings.accentText')}</p>
                  </div>
                  <div className="theme-grid">
                    {ACCENT_THEMES.map((theme, index) => (
                      <Button
                        layout="swatch"
                        selected={Boolean(accent === theme.id)}
                        aria-pressed={accent === theme.id}
                        variant="ghost"
                        type="button"
                        key={theme.id}
                        className={`theme-card accent-card ${accent === theme.id ? 'selected' : ''}`}
                        onClick={() => onAccentChange(theme.id)}
                        aria-label={
                          swatches
                            ? t(index === 0 ? 'settings.accentOriginal' : 'settings.accentVariant', {
                                number: index + 1,
                              })
                            : t(`accent.${theme.id}`)
                        }
                        title={
                          swatches
                            ? t(index === 0 ? 'settings.accentOriginal' : 'settings.accentVariant', {
                                number: index + 1,
                              })
                            : t(`accent.${theme.id}`)
                        }
                      >
                        <span
                          className="theme-swatch"
                          style={
                            {
                              background:
                                swatches?.[index].fill ??
                                `linear-gradient(135deg, ${accentSwatch(theme.delta, '#f0b263')}, ${accentSwatch(theme.delta, '#eda75f')})`,
                              '--ui-swatch-ink': paletteContent(
                                swatches?.[index].fill ?? accentSwatch(theme.delta, '#eda75f'),
                              ),
                            } as CSSProperties
                          }
                        >
                          {accent === theme.id && (
                            <CircleCheck size={18} className="ui-swatch-check" aria-hidden="true" />
                          )}
                        </span>
                      </Button>
                    ))}
                  </div>
                </FormRow>
              </Panel>
              <Panel className="settings-card">
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.languageTitle')}</h3>
                    <p>{t('settings.languageText')}</p>
                  </div>
                  <Actions className="row-actions">
                    <MenuSelect
                      ariaLabel={t('settings.languageTitle')}
                      value={lang}
                      options={locales.map((item) => ({ value: item.code, label: item.name }))}
                      onChange={onLangChange}
                    />
                    <Button type="button" className="secondary-button" onClick={() => void onReloadLocales()}>
                      <RefreshCw size={14} />
                      {t('settings.reloadLocales')}
                    </Button>
                  </Actions>
                </FormRow>
                <FormRow className="setting-block">
                  <div>
                    <h3>{t('settings.fontTitle')}</h3>
                    <p>{t('settings.fontText')}</p>
                  </div>
                  <MenuSelect
                    ariaLabel={t('settings.fontTitle')}
                    value={font}
                    options={FONT_OPTIONS.map((item) => ({ value: item.id, label: t(`font.${item.id}`) }))}
                    onChange={onFontChange}
                  />
                </FormRow>
                <FormRow className="setting-block settings-scale">
                  <div>
                    <h3>{t('settings.sizeTitle')}</h3>
                    <p>{t('settings.sizeText')}</p>
                  </div>
                  <fieldset className="join settings-scale-options" aria-label={t('settings.sizeTitle')}>
                    {[80, 90, 100, 110, 120, 130].map((value) => (
                      <Button
                        key={value}
                        type="button"
                        className="join-item"
                        variant={scale === value ? 'primary' : 'secondary'}
                        selected={scale === value}
                        aria-pressed={scale === value}
                        onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          onScaleChange(value);
                        }}
                        onKeyDown={(event) => {
                          if (
                            (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
                            event.altKey ||
                            event.ctrlKey ||
                            event.metaKey
                          )
                            return;

                          event.preventDefault();
                          const next =
                            event.key === 'ArrowLeft'
                              ? event.currentTarget.previousElementSibling
                              : event.currentTarget.nextElementSibling;
                          if (next instanceof HTMLButtonElement) next.click();
                        }}
                      >
                        {value}%
                      </Button>
                    ))}
                  </fieldset>
                </FormRow>
              </Panel>
            </>
          )}
        </div>
      </div>
    </>
  );
}
