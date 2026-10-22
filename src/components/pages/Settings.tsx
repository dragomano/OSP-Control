import { ChevronRight, FolderOpen, Monitor, Moon, RefreshCw, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, type LocaleInfo, useI18n } from '../../i18n';
import {
  autostartEnabled,
  closeToTrayEnabled,
  persistOsPanelPath,
  pickOsPanelDirectory,
  setAutostart,
  setCloseToTray,
} from '../../ospanel';
import { usePhpUpdates } from '../../phpUpdates';
import { ACCENT_THEMES, accentSwatch, FONT_OPTIONS, type ThemeMode } from '../../theme';
import type { Notify, SettingsTab } from '../shared';
import { PageHeader } from '../widgets/PageHeader';
import { RowMenu } from '../widgets/RowMenu';

const settingsTabs: { id: SettingsTab; key: string }[] = [
  { id: 'connection', key: 'settings.navConnection' },
  { id: 'autostart', key: 'settings.navAutostart' },
  { id: 'appearance', key: 'settings.navAppearance' },
];

export function Settings({
  notify,
  onPathSaved,
  installationPath,
  tab,
  onTabChange,
  onProjectAutostartChange,
  themeMode,
  setTheme,
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
  const updates = usePhpUpdates();
  const busyRef = useRef(updates.busy);
  busyRef.current = updates.busy;
  const [checkUpdates, setCheckUpdates] = useState(
    () => localStorage.getItem('ospanel.checkServiceUpdates') === '1',
  );
  const [osPath, setOsPath] = useState(() => localStorage.getItem('ospanel.path') ?? installationPath ?? '');
  const [autostart, setAutostartState] = useState(false);
  const [closeToTray, setCloseToTrayState] = useState(false);
  const [notifications, setNotifications] = useState(() => localStorage.getItem('ospanel.notify') !== '0');
  const [projectAutostart, setProjectAutostartState] = useState(
    () => localStorage.getItem('ospanel.autostartProjects') === '1',
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
    if (localStorage.getItem('ospanel.path') || !installationPath || pathEditedRef.current || osPath) return;
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
    localStorage.setItem('ospanel.autostartProjects', next ? '1' : '0');
    notify(t(next ? 'settings.projectAutostartOn' : 'settings.projectAutostartOff'));
    onProjectAutostartChange(next);
  };
  const toggleNotifications = () => {
    const next = !notifications;
    setNotifications(next);
    localStorage.setItem('ospanel.notify', next ? '1' : '0');
    notify(t(next ? 'settings.notificationsOn' : 'settings.notificationsOff'));
  };

  return (
    <>
      <PageHeader
        eyebrow={t('nav.system')}
        heading={t('nav.settings')}
        description={t('settings.subtitle')}
      />
      <div className="settings-layout">
        <div className="settings-nav">
          {settingsTabs.map((item) => (
            <button
              type="button"
              key={item.id}
              className={tab === item.id ? 'selected' : ''}
              onClick={() => onTabChange(item.id)}
            >
              {t(item.key)}
            </button>
          ))}
        </div>
        <div className="settings-card">
          {tab === 'connection' && (
            <div className="setting-block">
              <div>
                <h3>{t('settings.connectionTitle')}</h3>
                <p>{t('settings.connectionText')}</p>
              </div>
              <div className="path-field">
                <input
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
                <button
                  type="button"
                  className="secondary-button"
                  disabled={updates.busy}
                  onClick={choosePath}
                >
                  <FolderOpen size={14} />
                  {t('settings.chooseFolder')}
                </button>
              </div>
            </div>
          )}
          {tab === 'autostart' && (
            <>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.autostartTitle')}</h3>
                  <p>{t('settings.autostartText')}</p>
                </div>
                <button
                  type="button"
                  className={`large-toggle ${autostart ? 'on' : ''}`}
                  onClick={() => void toggleAutostart()}
                  aria-label={t('settings.autostartTitle')}
                >
                  <span />
                </button>
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.projectAutostartTitle')}</h3>
                  <p>{t('settings.projectAutostartText')}</p>
                </div>
                <button
                  type="button"
                  className={`large-toggle ${projectAutostart ? 'on' : ''}`}
                  onClick={toggleProjectAutostart}
                  aria-label={t('settings.projectAutostartTitle')}
                >
                  <span />
                </button>
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('updates.startup')}</h3>
                  <p>{t('updates.description')}</p>
                </div>
                <button
                  type="button"
                  className={`large-toggle ${checkUpdates ? 'on' : ''}`}
                  onClick={() => {
                    const next = !checkUpdates;
                    setCheckUpdates(next);
                    localStorage.setItem('ospanel.checkServiceUpdates', next ? '1' : '0');
                  }}
                  aria-label={t('updates.startup')}
                >
                  <span />
                </button>
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.closeToTrayTitle')}</h3>
                  <p>{t('settings.closeToTrayText')}</p>
                </div>
                <button
                  type="button"
                  className={`large-toggle ${closeToTray ? 'on' : ''}`}
                  onClick={() => void toggleCloseToTray()}
                  aria-label={t('settings.closeToTrayTitle')}
                >
                  <span />
                </button>
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.notificationsTitle')}</h3>
                  <p>{t('settings.notificationsText')}</p>
                </div>
                <button
                  type="button"
                  className={`large-toggle ${notifications ? 'on' : ''}`}
                  onClick={toggleNotifications}
                  aria-label={t('settings.notificationsTitle')}
                >
                  <span />
                </button>
              </div>
            </>
          )}
          {tab === 'appearance' && (
            <>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.themeTitle')}</h3>
                  <p>{t('settings.themeText')}</p>
                </div>
                <div className="theme-grid">
                  <button
                    type="button"
                    className={`theme-card ${themeMode === 'system' ? 'selected' : ''}`}
                    onClick={() => setTheme('system')}
                  >
                    <Monitor size={18} />
                    <b>{t('settings.themeSystem')}</b>
                  </button>
                  <button
                    type="button"
                    className={`theme-card ${themeMode === 'dark' ? 'selected' : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    <Moon size={18} />
                    <b>{t('settings.themeDark')}</b>
                  </button>
                  <button
                    type="button"
                    className={`theme-card ${themeMode === 'light' ? 'selected' : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    <Sun size={18} />
                    <b>{t('settings.themeLight')}</b>
                  </button>
                </div>
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.accentTitle')}</h3>
                  <p>{t('settings.accentText')}</p>
                </div>
                <div className="theme-grid">
                  {ACCENT_THEMES.map((theme) => (
                    <button
                      type="button"
                      key={theme.id}
                      className={`theme-card accent-card ${accent === theme.id ? 'selected' : ''}`}
                      onClick={() => onAccentChange(theme.id)}
                      aria-label={t(`accent.${theme.id}`)}
                      title={t(`accent.${theme.id}`)}
                    >
                      <span
                        className="theme-swatch"
                        style={{
                          background: `linear-gradient(135deg, ${accentSwatch(theme.delta, '#f0b263')}, ${accentSwatch(theme.delta, '#eda75f')})`,
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.languageTitle')}</h3>
                  <p>{t('settings.languageText')}</p>
                </div>
                <div className="row-actions">
                  <RowMenu
                    trigger={({ onToggle, open }) => (
                      <button
                        type="button"
                        className="filter-button"
                        onClick={onToggle}
                        aria-haspopup="menu"
                        aria-expanded={open}
                      >
                        {locales.find((item) => item.code === lang)?.name ?? lang}
                        <ChevronRight size={14} />
                      </button>
                    )}
                    entries={locales.map((item) => ({
                      label: item.name,
                      onSelect: () => onLangChange(item.code),
                    }))}
                  />
                  <button type="button" className="secondary-button" onClick={() => void onReloadLocales()}>
                    <RefreshCw size={14} />
                    {t('settings.reloadLocales')}
                  </button>
                </div>
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.fontTitle')}</h3>
                  <p>{t('settings.fontText')}</p>
                </div>
                <RowMenu
                  trigger={({ onToggle, open }) => (
                    <button
                      type="button"
                      className="filter-button"
                      onClick={onToggle}
                      aria-haspopup="menu"
                      aria-expanded={open}
                    >
                      {t(`font.${font}`)}
                      <ChevronRight size={14} />
                    </button>
                  )}
                  entries={FONT_OPTIONS.map((item) => ({
                    label: t(`font.${item.id}`),
                    onSelect: () => onFontChange(item.id),
                  }))}
                />
              </div>
              <div className="setting-block">
                <div>
                  <h3>{t('settings.sizeTitle')}</h3>
                  <p>{t('settings.sizeText')}</p>
                </div>
                <div className="range-field">
                  <input
                    type="range"
                    min={80}
                    max={130}
                    step={5}
                    value={scale}
                    onChange={(event) => onScaleChange(Number(event.target.value))}
                    aria-label={t('settings.sizeTitle')}
                  />
                  <b>{scale}%</b>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
