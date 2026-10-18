import {
  ChevronRight,
  Copy,
  FolderOpen,
  Leaf,
  Moon,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { version as appVersion } from '../package.json';
import { APP_NAME } from './brand';
import { QuickSearch } from './components/dialogs/QuickSearch';
import { Overview } from './components/pages/Overview';
import { Projects } from './components/pages/Projects';
import { Services } from './components/pages/Services';
import { Settings } from './components/pages/Settings';
import {
  iconForService,
  NARROW_WINDOW_QUERY,
  navItems,
  type Page,
  SERVICE_TOAST_KEYS,
  type Service,
  type SettingsTab,
  type ToastAction,
} from './components/shared';
import { Backups } from './components/tables/Backups';
import { Configs } from './components/tables/Configs';
import { buildActivityRows, Logs, logAliasesFromTranslator } from './components/tables/Logs';
import {
  BASE_LANG,
  type Dict,
  EMBEDDED_LANGS,
  embeddedDict,
  errorText,
  I18nContext,
  type LocaleInfo,
  loadLocaleDict,
  loadLocaleList,
  localeIssues,
  localeTag,
  makePlural,
  makeTranslator,
  preferredLang,
} from './i18n';
import {
  askConfirm,
  autostartFromProjects,
  type CreatedProject,
  deleteProject,
  discoverOsPanel,
  fetchLogTail,
  fetchOverviewMetrics,
  filterProjects,
  getProjectSettings,
  getUserInfo,
  isDesktopApp,
  type LogSource,
  listLogSources,
  type OsPanelProject,
  type OsPanelSnapshot,
  type OverviewMetrics,
  openPanelFolder,
  panelOnline,
  refreshService,
  restartOsPanel,
  saveProjectSettings,
  waitForPanelReady,
} from './ospanel';
import { applyAccentTheme, applyFont, applyUiScale, type ThemeMode, useSystemPrefersLight } from './theme';

export { buildActivityRows } from './components/tables/Logs';

const initialLang = (): string =>
  localStorage.getItem('ospanel.lang') ?? preferredLang(EMBEDDED_LANGS) ?? BASE_LANG;

// Hotkeys like "/" must not fire while the user is typing into a text field.
const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

function App() {
  const [page, setPage] = useState<Page>('overview');
  const [services, setServices] = useState<Service[]>([]);
  // Demo list for the browser comes from mockSnapshot (ospanel.ts); on desktop
  // the list is filled only from the panel's data — no hardcoded projects.
  const [projects, setProjects] = useState<OsPanelProject[]>([]);
  const [snapshot, setSnapshot] = useState<OsPanelSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<{ message: string; action?: ToastAction } | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem('ospanel.theme');
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  });
  const systemLight = useSystemPrefersLight();
  // Effective theme: the explicit choice, or the system setting for the 'system' mode.
  const isLight = themeMode === 'light' || (themeMode === 'system' && systemLight);
  const [accent, setAccent] = useState(() => localStorage.getItem('ospanel.accent') ?? 'green');
  const [font, setFont] = useState(() => localStorage.getItem('ospanel.font') ?? 'dm-sans');
  const [scale, setScale] = useState(() => Number(localStorage.getItem('ospanel.scale') ?? 100));
  const [lang, setLang] = useState(() => initialLang());
  // The current language code for async checks (refreshLocales) that need the
  // current selection without crossing callback dependencies.
  const langRef = useRef(lang);

  langRef.current = lang;

  // The first dictionary is the settings language, not the base: otherwise English text
  // flashes in a Russian UI until the locale file is loaded.
  const [dict, setDict] = useState<Dict>(() => embeddedDict(initialLang()));
  const [locales, setLocales] = useState<LocaleInfo[]>([]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('ospanel.sidebar') === '1',
  );
  // A narrow window (in the desktop app also at an increased scale) forces the sidebar
  // into the icon rail so the main area does not shrink into horizontal scrolling.
  const [narrowWindow, setNarrowWindow] = useState(() => window.matchMedia(NARROW_WINDOW_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(NARROW_WINDOW_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrowWindow(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const sidebarNarrow = sidebarCollapsed || narrowWindow;
  const [userName, setUserName] = useState('');
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [activityLines, setActivityLines] = useState<string[] | null>(null);
  const [logSources, setLogSources] = useState<LogSource[]>([]);
  const [logSource, setLogSource] = useState('general.log');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logAuto, setLogAuto] = useState(false);
  // Local edits to the project list: the panel rescans home/ only at its own startup,
  // so created and deleted domains diverge from the API data until a restart.
  const localAddedRef = useRef(new Map<string, OsPanelProject>());
  const localDeletedRef = useRef(new Set<string>());
  // Local TLS toggles: project.ini is written immediately, but the panel API keeps the old
  // tls_enabled until a restart, so the chosen state is kept here until the API catches up.
  const localSslRef = useRef(new Map<string, boolean>());
  const snapshotRequestRef = useRef(0);
  const activityRequestRef = useRef(0);
  const logRequestRef = useRef(0);
  const inFlightServicesRef = useRef(new Set<string>());
  const panelRestartRef = useRef(false);
  // Busy state for the UI: the names of services with an unfinished command, and the panel
  // restart. Both are mirrors of the refs above — the refs guard against a synchronous repeat
  // (two clicks before the next render), the state drives the disabled controls.
  const [pendingServices, setPendingServices] = useState<ReadonlySet<string>>(() => new Set());
  const [panelRestarting, setPanelRestarting] = useState(false);
  // Handle of the active toast timeout: a new toast cancels the previous timer,
  // otherwise the old one hides the fresh toast before its own 2600 ms elapse.
  const toastTimerRef = useRef<number | null>(null);
  // Locale loads share one ordering per kind of resource: the request that started
  // last wins, so a slow response for a previous language (a rapid switch) or an
  // extra focus reload cannot overwrite the dictionary/list of the current choice.
  const localeDictRequestRef = useRef(0);
  const localeListRequestRef = useRef(0);
  const runningCount = services.filter((service) => service.status === 'running').length;
  const t = useMemo(() => makeTranslator(dict, embeddedDict(BASE_LANG)), [dict]);
  const logAliases = useMemo(() => logAliasesFromTranslator(t), [t]);
  // Counter for the "Logs" badge: errors in the tail of the active log, counted over
  // merged events — matches the number on the "Errors" tab.
  const logErrors = useMemo(
    () => buildActivityRows(logLines, logAliases).filter((event) => event.level === 'error').length,
    [logAliases, logLines],
  );
  const notify = useCallback((message: string, action?: ToastAction) => {
    if (localStorage.getItem('ospanel.notify') === '0') return;
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ message, action });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 2600);
  }, []);

  // No timer survives the app unmount (matters in tests with fake timers).
  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // Pluralization: picks the <key>.one/.few/.many/.other form by language and count.
  // The dictionary is passed as the third argument — forms come from it, not from the base language.
  const plural = useMemo(() => makePlural(t, lang, dict), [t, lang, dict]);
  // Name from the system; while it is not loaded or empty — a localized fallback.
  const userNameDisplay = userName || t('nav.userFallback');
  // Tail of the panel log for "Recent activity" on the overview page.
  const loadActivity = useCallback(async () => {
    const request = ++activityRequestRef.current;
    try {
      // 60 lines: error blocks get merged, so 3 events need a longer tail than the line count.
      const lines = await fetchLogTail('general.log', 60);
      if (request === activityRequestRef.current) setActivityLines(lines);
    } catch {
      if (request === activityRequestRef.current) setActivityLines([]);
    }
  }, []);

  const loadSnapshot = useCallback(async (): Promise<boolean> => {
    const request = ++snapshotRequestRef.current;
    try {
      const next = await discoverOsPanel();
      const nextMetrics = await fetchOverviewMetrics().catch(() => null);
      if (request !== snapshotRequestRef.current) return false;
      const nextServices = next.services.map((service) => ({
        ...service,
        icon: iconForService(service.kind),
      }));
      let mergedProjects: OsPanelProject[] | undefined;
      if (next.projects) {
        // The panel has restarted and learned the created domains — drop them from local
        // bookkeeping; domains no longer in the panel stop being hidden. An empty panel list
        // (panel stopped or no projects) is applied too — in place of the demo data.
        const known = new Set(next.projects.map((project) => project.domain.toLowerCase()));
        for (const domain of localAddedRef.current.keys()) {
          if (known.has(domain)) localAddedRef.current.delete(domain);
        }
        for (const domain of [...localDeletedRef.current]) {
          if (!known.has(domain)) localDeletedRef.current.delete(domain);
        }
        mergedProjects = [
          ...next.projects.filter((project) => !localDeletedRef.current.has(project.domain.toLowerCase())),
          ...[...localAddedRef.current.values()].filter(
            (project) => !known.has(project.domain.toLowerCase()),
          ),
        ];
        // Apply pending TLS toggles; once the panel API reports the chosen state, stop overriding.
        for (const project of mergedProjects) {
          const key = project.domain.toLowerCase();
          const pending = localSslRef.current.get(key);
          if (pending === undefined) continue;
          if (project.ssl === pending) localSslRef.current.delete(key);
          else project.ssl = pending;
        }
        mergedProjects.sort((a, b) => a.domain.toLowerCase().localeCompare(b.domain.toLowerCase()));
      }
      setSnapshot(next);
      setServices(nextServices);
      if (mergedProjects) setProjects(mergedProjects);
      setMetrics(nextMetrics);
      void loadActivity();
      return true;
    } catch {
      if (request === snapshotRequestRef.current) notify(t('common.snapshotFailed'));
      return false;
    }
  }, [loadActivity, notify, t]);

  // The single owner of the panel restart: "Restart all" and the project toast action both
  // go through it, so one lock covers every entry point. The panel is blocked until its API
  // answers again — the native command returns as soon as the new process is spawned, and a
  // service command sent in that window would be lost.
  const restartPanelNow = async (toastKey: string, errorKey: string): Promise<boolean> => {
    if (panelRestartRef.current) return false;
    panelRestartRef.current = true;
    setPanelRestarting(true);
    try {
      await restartOsPanel();
      notify(t(toastKey));
      await waitForPanelReady();
      // The panel rescans home/ while starting, so the projects it has learned are picked up
      // here; a later pass covers a scan that finishes after the API came up.
      void loadSnapshot();
      window.setTimeout(() => void loadSnapshot(), 5000);
      return true;
    } catch (error) {
      notify(errorText(t, error, errorKey));
      return false;
    } finally {
      panelRestartRef.current = false;
      setPanelRestarting(false);
    }
  };

  // A created project is shown in the list right away: the live panel API scans
  // home/ only at its own startup and does not see new domains on disk.
  const addProject = (created: CreatedProject) => {
    const project: OsPanelProject = {
      domain: created.domain,
      path: created.path,
      php: created.php,
      type: created.http,
      ssl: created.ssl,
    };
    localAddedRef.current.set(created.domain.toLowerCase(), project);
    setProjects((current) => [
      ...current.filter((item) => item.domain.toLowerCase() !== created.domain.toLowerCase()),
      project,
    ]);
  };

  // Project deletion: the home/<domain> directory is wiped entirely, and the panel
  // learns about it after a restart — until then the domain is kept out of the list locally.
  const removeProject = async (domain: string) => {
    if (!(await askConfirm(t('projects.deleteConfirm', { domain }), t('common.confirmTitle')))) return;
    try {
      await deleteProject(domain);
      localDeletedRef.current.add(domain.toLowerCase());
      localAddedRef.current.delete(domain.toLowerCase());
      setProjects((current) => current.filter((item) => item.domain.toLowerCase() !== domain.toLowerCase()));
      notify(t('projects.toastDeleted', { domain }), {
        label: t('projects.restartPanel'),
        run: () => void restartPanel(),
      });
    } catch (error) {
      notify(errorText(t, error, 'projects.toastDeleteFailed'));
    }
  };

  // Quick TLS toggle from the project row: write tls_enabled to .osp/project.ini, show the
  // new state optimistically, and offer a panel restart so the vhost is regenerated.
  const toggleProjectSsl = async (domain: string, next: boolean) => {
    const key = domain.toLowerCase();
    try {
      const current = await getProjectSettings(domain);
      await saveProjectSettings(domain, {
        httpEngine: current.httpEngine,
        phpEngine: current.phpEngine,
        nodeEngine: current.nodeEngine,
        tlsEnabled: next ? 'on' : 'off',
      });
      localSslRef.current.set(key, next);
      const local = localAddedRef.current.get(key);
      if (local) localAddedRef.current.set(key, { ...local, ssl: next });
      setProjects((list) =>
        list.map((item) => (item.domain.toLowerCase() === key ? { ...item, ssl: next } : item)),
      );
      notify(t(next ? 'projects.toastSslOn' : 'projects.toastSslOff', { domain }), {
        label: t('projects.restartPanel'),
        run: () => void restartPanel(),
      });
    } catch (error) {
      notify(errorText(t, error, 'projects.toastSslFailed'));
    }
  };

  // Panel restart via the toast button: at startup the panel rescans home/
  // and adds the created domain to its project list.
  const restartPanel = async () => {
    if (panelRestartRef.current) return;
    if (!(await askConfirm(t('projects.restartPanelConfirm'), t('common.confirmTitle')))) return;
    await restartPanelNow('projects.toastPanelRestarting', 'projects.toastPanelRestartFailed');
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the snapshot is needed once at startup — loadSnapshot is recreated on language change, a full refetch is not needed
  useEffect(() => {
    void loadSnapshot();
  }, []);

  // Live panel status: a lightweight HTTP API poll every 5 seconds and on returning
  // to the window. A status change rereads the whole snapshot — services, projects
  // and metrics sync with the panel's real state.
  const panelOnlineRef = useRef<boolean | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: polling starts once on mount — restarting the interval on language change is not needed
  useEffect(() => {
    if (!isDesktopApp()) return;

    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const online = await panelOnline();
        if (cancelled) return;
        const previous = panelOnlineRef.current;
        panelOnlineRef.current = online;
        setSnapshot((current) => (current ? { ...current, panelRunning: online } : current));
        if (previous !== null && previous !== online) void loadSnapshot();
      } catch {
        // A failed status poll is not announced with a toast — the next successful one refreshes the snapshot.
      }
    };

    const onVisibility = () => void poll();
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // Once at startup; loadSnapshot in the closure is current at call time.
  }, []);

  // The log tail loading lives in App so the "Logs" badge and the page show the same data.
  const loadLogTail = useCallback(async () => {
    const request = ++logRequestRef.current;
    const source = logSource;

    try {
      const lines = await fetchLogTail(source, 300);
      if (request === logRequestRef.current && source === logSource) setLogLines(lines);
    } catch (error) {
      if (request === logRequestRef.current && source === logSource) {
        notify(errorText(t, error, 'logs.toastReadFailed'));
      }
    }
  }, [logSource, notify, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the source list is read once at startup — no need to refetch on every log switch
  useEffect(() => {
    void (async () => {
      try {
        const list = await listLogSources();
        setLogSources(list);
        if (list.length > 0 && !list.some((item) => item.name === logSource)) setLogSource(list[0].name);
      } catch (error) {
        notify(errorText(t, error, 'logs.toastSourcesFailed'));
      }
    })();
  }, []);

  useEffect(() => {
    void loadLogTail();
  }, [loadLogTail]);

  useEffect(() => {
    if (!logAuto) return;
    const id = window.setInterval(() => void loadLogTail(), 5000);
    return () => window.clearInterval(id);
  }, [logAuto, loadLogTail]);

  useEffect(() => {
    void (async () => {
      try {
        setUserName((await getUserInfo()).name);
      } catch {
        /* staying on the localized fallback */
      }
    })();
  }, []);

  useEffect(() => {
    applyAccentTheme(accent);
  }, [accent]);

  useEffect(() => {
    applyFont(font);
  }, [font]);

  useEffect(() => {
    applyUiScale(scale);
  }, [scale]);

  const refreshLocales = useCallback(async () => {
    const request = ++localeListRequestRef.current;

    try {
      const list = await loadLocaleList();

      if (request !== localeListRequestRef.current) return; // a newer list load (focus/reload) supersedes this one

      setLocales(list);
      // If the saved language is no longer in the list of available ones (the user deleted the file),
      // reset to the system language, and if that is missing too — to English, and save the choice.

      const current = langRef.current;

      if (list.length > 0 && !list.some((item) => item.code === current)) {
        const fallback = preferredLang(list.map((item) => item.code)) ?? BASE_LANG;
        setLang(fallback);
        localStorage.setItem('ospanel.lang', fallback);
      }
    } catch {
      /* keeping the embedded ru/en */
    }
  }, []);

  // The locale file is added and edited by the user: report every structural defect
  // against the base dictionary — missing or unknown keys, renamed {var} placeholders,
  // incomplete plural families. Each of them degrades the UI silently, so a single
  // toast lists the non-empty categories with a few key names as examples.
  const reportLocaleIssues = useCallback(
    (lang: string, loaded: Record<string, string>) => {
      if (!isDesktopApp()) return;

      const issues = localeIssues(loaded, embeddedDict(BASE_LANG), lang);
      const issueT = makeTranslator(loaded, embeddedDict(BASE_LANG));
      const sample = (keys: string[]) =>
        keys.slice(0, 3).join(', ') + (keys.length > 3 ? `, +${keys.length - 3}` : '');
      const parts: string[] = [];

      if (issues.missingKeys.length > 0)
        parts.push(issueT('settings.localeIssueMissingKeys', { keys: sample(issues.missingKeys) }));
      if (issues.unknownKeys.length > 0)
        parts.push(issueT('settings.localeIssueUnknownKeys', { keys: sample(issues.unknownKeys) }));
      if (issues.placeholderMismatches.length > 0)
        parts.push(
          issueT('settings.localeIssuePlaceholders', { keys: sample(issues.placeholderMismatches) }),
        );
      if (issues.incompletePlurals.length > 0)
        parts.push(issueT('settings.localeIssuePlurals', { keys: sample(issues.incompletePlurals) }));
      if (parts.length > 0) notify(issueT('settings.toastLocaleIssues', { issues: parts.join('; ') }));
    },
    [notify],
  );

  useEffect(() => {
    void (async () => {
      const request = ++localeDictRequestRef.current;

      try {
        const { dict: next, fileUsed } = await loadLocaleDict(lang);

        // A rapid switch, a focus reload or a manual reload has started a newer load.
        if (request !== localeDictRequestRef.current) return;
        setDict(next);
        // In the browser the embedded dictionary is the normal source; the file warning is desktop-only.
        if (!fileUsed && isDesktopApp()) {
          notify(makeTranslator(next, embeddedDict(BASE_LANG))('settings.toastLocaleBroken'));
        } else if (fileUsed) {
          reportLocaleIssues(lang, next);
        }
      } catch {
        /* staying on the current dictionary */
      }
    })();
  }, [lang, notify, reportLocaleIssues]);

  useEffect(() => {
    void refreshLocales();
  }, [refreshLocales]);

  useEffect(() => {
    const onFocus = () => {
      void (async () => {
        const request = ++localeDictRequestRef.current;

        try {
          const { dict: next } = await loadLocaleDict(lang);
          if (request !== localeDictRequestRef.current) return;
          setDict(next);
        } catch {
          /* the dictionary stays as is */
        }
      })();

      void refreshLocales();
    };

    window.addEventListener('focus', onFocus);

    return () => window.removeEventListener('focus', onFocus);
  }, [lang, refreshLocales]);

  // The UI language drives <html lang> (screen readers, spellcheck, CSS :lang()).
  // index.html ships a static placeholder, so the tag is applied on mount and on every
  // language change, in BCP-47 form — including user locales whose codes use "_".
  useEffect(() => {
    document.documentElement.lang = localeTag(lang);
  }, [lang]);

  const changeLang = useCallback((code: string) => {
    setLang(code);
    localStorage.setItem('ospanel.lang', code);
  }, []);
  const changeTheme = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
    localStorage.setItem('ospanel.theme', mode);
  }, []);

  const reloadLocales = useCallback(async () => {
    await refreshLocales();
    // After refreshLocales the language may have switched to a fallback (if the file was deleted)
    const activeLang = langRef.current;
    const request = ++localeDictRequestRef.current;

    try {
      const { dict: next, fileUsed } = await loadLocaleDict(activeLang);

      // The user switched the language while the reload was in flight.
      if (request !== localeDictRequestRef.current) return;

      setDict(next);
      // fileUsed: false in the browser is not a broken file but the normal embedded dictionary.
      const localeBroken = !fileUsed && isDesktopApp();

      notify(
        makeTranslator(
          next,
          embeddedDict(BASE_LANG),
        )(localeBroken ? 'settings.toastLocaleBroken' : 'settings.toastLocalesReloaded'),
      );

      if (fileUsed) reportLocaleIssues(activeLang, next);
    } catch {
      // A stale reload must not report a failure: a newer load is in charge of the dictionary.
      if (request === localeDictRequestRef.current) notify(t('settings.toastLocalesFailed'));
    }
  }, [refreshLocales, notify, t, reportLocaleIssues]);

  const filteredProjects = useMemo(() => filterProjects(projects, query), [projects, query]);
  // Mirrors one service into the pending set that drives the busy state in the UI.
  const setServicePending = (name: string, pending: boolean) => {
    setPendingServices((current) => {
      if (current.has(name) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  const runServiceAction = async (
    service: Service,
    action: 'start' | 'stop' | 'restart',
    announce = true,
  ): Promise<boolean> => {
    // The panel is restarting: its API is unreachable, so the command would fail — and the
    // busy state already tells the user why the controls are disabled.
    if (panelRestartRef.current) return false;
    if (inFlightServicesRef.current.has(service.name)) return false;

    inFlightServicesRef.current.add(service.name);
    setServicePending(service.name, true);

    try {
      const updated = await refreshService(service.name, action);

      setServices((current) =>
        current.map((item) => (item.name === updated.name ? { ...updated, icon: item.icon } : item)),
      );

      if (announce) notify(t(SERVICE_TOAST_KEYS[action], { name: service.name }));

      return true;
    } catch (error) {
      if (announce) notify(errorText(t, error, 'services.toastFailed'));

      return false;
    } finally {
      inFlightServicesRef.current.delete(service.name);
      setServicePending(service.name, false);
    }
  };

  const restartAllServices = async (): Promise<void> => {
    await restartPanelNow('services.toastRestartedAll', 'services.toastFailed');
  };
  const toggleService = (index: number) => {
    const service = services[index];
    if (!service || service.status === 'unknown') return;
    void runServiceAction(service, service.status === 'running' ? 'stop' : 'start');
  };

  // Autostart of modules per project settings (project.ini), like the native panel.
  const runProjectAutostart = useCallback(async () => {
    // A running panel restart is the same kind of operation: starting modules through osp.bat
    // in parallel would race it.
    if (panelRestartRef.current) return;
    try {
      const report = await autostartFromProjects();
      if (report.started.length > 0) {
        notify(t('settings.projectAutostartStarted', { list: report.started.join(', ') }));
        void loadSnapshot();
      } else if (report.unmatched.length > 0) {
        notify(t('settings.projectAutostartUnmatched', { list: report.unmatched.join(', ') }));
      }
    } catch (error) {
      notify(errorText(t, error, 'settings.projectAutostartFailed'));
    }
  }, [notify, t, loadSnapshot]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: project autostart runs once at app startup
  useEffect(() => {
    if (!isDesktopApp() || localStorage.getItem('ospanel.autostartProjects') !== '1') return;

    // Let the initial snapshot load pass without competing for osp.bat.
    const timer = window.setTimeout(() => void runProjectAutostart(), 1500);
    return () => window.clearTimeout(timer);
    // Once at app startup; t/loadSnapshot in the closure are current at call time.
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }
      // Slash opens the palette too, but must not steal keystrokes typed into text fields.
      if (
        event.key === '/' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigateTo = useCallback((nextPage: Page, tab?: SettingsTab) => {
    if (tab) setSettingsTab(tab);
    setPage(nextPage);
    setSearchOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem('ospanel.sidebar', next ? '1' : '0');
      return next;
    });
  }, []);

  const title = t(`nav.${page}`);
  const panelLabel = !snapshot?.detected ? t('nav.offline') : (snapshot.version ?? t('nav.versionUnknown'));
  const openPanelDir = async () => {
    try {
      await openPanelFolder();
    } catch (error) {
      notify(errorText(t, error, 'nav.openFolderFailed'));
    }
  };

  // Hoisted out of the JSX so the narrowing survives inside the onClick closure.
  const toastAction = toast?.action;

  return (
    <I18nContext.Provider value={{ lang, t, plural }}>
      <div className={`app-shell ${isLight ? 'light' : ''}`}>
        <aside className={`sidebar ${sidebarNarrow ? 'collapsed' : ''}`}>
          <div className="brand">
            <button
              type="button"
              className="brand-mark"
              onClick={toggleSidebar}
              aria-label={sidebarNarrow ? t('nav.expand') : t('nav.collapse')}
              title={sidebarNarrow ? t('nav.expand') : t('nav.collapse')}
            >
              <Leaf size={18} strokeWidth={2.5} />
            </button>
            <div>
              <strong>{APP_NAME}</strong>
              <span className="brand-version">v{appVersion}</span>
            </div>
          </div>
          <div
            className="workspace-switcher"
            title={sidebarNarrow ? `${t('nav.machine')} · ${panelLabel}` : undefined}
          >
            <div className="workspace-icon">O</div>
            <div>
              <b>{t('nav.machine')}</b>
              <span>{panelLabel}</span>
            </div>
            {snapshot?.detected ? (
              <button
                type="button"
                className="icon-button workspace-open"
                aria-label={t('nav.openFolder')}
                title={t('nav.openFolder')}
                onClick={() => void openPanelDir()}
              >
                <FolderOpen size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-button workspace-open"
                aria-label={t('nav.openSettings')}
                title={t('nav.openSettings')}
                onClick={() => navigateTo('settings', 'connection')}
              >
                <Settings2 size={16} />
              </button>
            )}
          </div>
          <nav className="navigation">
            <div className="nav-label">{t('nav.workspace')}</div>
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => setPage(item.id)}
                  aria-label={t(`nav.${item.id}`)}
                  title={sidebarNarrow ? t(`nav.${item.id}`) : undefined}
                >
                  <Icon size={17} />
                  <span>{t(`nav.${item.id}`)}</span>
                  {item.id === 'logs' && logErrors > 0 && (
                    <span className="nav-badge" title={t('nav.logsErrors', { n: logErrors })}>
                      {logErrors}
                    </span>
                  )}
                  {item.id === 'projects' && (
                    <span className="nav-badge" title={t('nav.projectsActive', { n: projects.length })}>
                      {projects.length}
                    </span>
                  )}
                  {item.id === 'services' && (
                    <span className="nav-badge" title={t('nav.servicesRunning', { n: runningCount })}>
                      {runningCount}
                    </span>
                  )}
                </button>
              );
            })}
            <div className="nav-label second">{t('nav.system')}</div>
            <button
              type="button"
              className={`nav-item nav-settings ${page === 'settings' ? 'active' : ''}`}
              onClick={() => setPage('settings')}
              aria-label={t('nav.settings')}
              title={sidebarNarrow ? t('nav.settings') : undefined}
            >
              <Settings2 size={17} />
              <span>{t('nav.settings')}</span>
            </button>
            <button
              type="button"
              className={`nav-item nav-backups ${page === 'backups' ? 'active' : ''}`}
              onClick={() => setPage('backups')}
              aria-label={t('nav.backups')}
              title={sidebarNarrow ? t('nav.backups') : undefined}
            >
              <Copy size={17} />
              <span>{t('nav.backups')}</span>
            </button>
          </nav>
        </aside>
        <main className="main-content">
          <header className="topbar">
            <div className="breadcrumbs">
              <span>{APP_NAME}</span>
              <ChevronRight size={14} />
              <b>{title}</b>
            </div>
            <div className="top-actions">
              <button
                type="button"
                className="icon-button"
                onClick={() => setSearchOpen(true)}
                aria-label={t('search.open')}
                title={t('search.open')}
              >
                <Search size={17} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => changeTheme(isLight ? 'dark' : 'light')}
                aria-label={t('common.toggleTheme')}
              >
                {isLight ? <Sun size={17} /> : <Moon size={17} />}
              </button>
            </div>
          </header>
          <div className="content-wrap">
            {page === 'overview' && (
              <Overview
                runningCount={runningCount}
                services={services}
                userName={userNameDisplay}
                metrics={metrics}
                activityLines={activityLines}
                onNavigate={navigateTo}
                onToggle={toggleService}
                onAction={runServiceAction}
                notify={notify}
                onSync={loadSnapshot}
                panelRestarting={panelRestarting}
                pendingServices={pendingServices}
              />
            )}
            {page === 'services' && (
              <Services
                services={services}
                onToggle={toggleService}
                onAction={runServiceAction}
                notify={notify}
                onSync={loadSnapshot}
                onRestartAll={restartAllServices}
                panelRestarting={panelRestarting}
                pendingServices={pendingServices}
              />
            )}
            {page === 'projects' && (
              <Projects
                projects={filteredProjects}
                allProjects={projects}
                query={query}
                setQuery={setQuery}
                notify={notify}
                onProjectCreated={addProject}
                onProjectDeleted={(domain) => void removeProject(domain)}
                onToggleSsl={(domain, next) => void toggleProjectSsl(domain, next)}
                onRestartPanel={() => void restartPanel()}
              />
            )}
            {page === 'configs' && <Configs notify={notify} />}
            {page === 'logs' && (
              <Logs
                notify={notify}
                sources={logSources}
                source={logSource}
                onSourceChange={setLogSource}
                lines={logLines}
                auto={logAuto}
                onAutoChange={setLogAuto}
              />
            )}
            {page === 'settings' && (
              <Settings
                notify={notify}
                installationPath={snapshot?.source === 'tauri' ? snapshot.path : null}
                onPathSaved={(path) => {
                  localStorage.setItem('ospanel.path', path);
                  void loadSnapshot();
                }}
                tab={settingsTab}
                onTabChange={setSettingsTab}
                onProjectAutostartChange={(enabled) => {
                  if (enabled && isDesktopApp()) void runProjectAutostart();
                }}
                themeMode={themeMode}
                setTheme={changeTheme}
                accent={accent}
                font={font}
                onAccentChange={(id: string) => {
                  setAccent(id);
                  localStorage.setItem('ospanel.accent', id);
                }}
                onFontChange={(id: string) => {
                  setFont(id);
                  localStorage.setItem('ospanel.font', id);
                }}
                scale={scale}
                onScaleChange={(value: number) => {
                  setScale(value);
                  localStorage.setItem('ospanel.scale', String(value));
                }}
                lang={lang}
                onLangChange={changeLang}
                locales={locales}
                onReloadLocales={reloadLocales}
              />
            )}
            {page === 'backups' && <Backups notify={notify} services={services} projects={projects} />}
          </div>
        </main>
        {toast && (
          <div className="toast">
            <ShieldCheck size={17} />
            <span>{toast.message}</span>
            {toastAction && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  setToast(null);
                  toastAction.run();
                }}
              >
                {toastAction.label}
              </button>
            )}
            <button type="button" onClick={() => setToast(null)} aria-label={t('common.close')}>
              <X size={14} />
            </button>
          </div>
        )}
        <QuickSearch open={searchOpen} onClose={() => setSearchOpen(false)} onNavigate={navigateTo} />
      </div>
    </I18nContext.Provider>
  );
}

export default App;
