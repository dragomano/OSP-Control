import type { OsPanelMenuDocument, OsPanelMenuItem, OsPanelMenuSaveResult } from './menu';
import { matchesProjectSearch, type ProjectTags, tagsForProject } from './projectTags';

export type ServiceStatus = 'running' | 'stopped' | 'warning' | 'unknown';

export type OsPanelService = {
  name: string;
  version: string;
  port: string;
  status: ServiceStatus;
  detail: string;
  kind:
    | 'web'
    | 'runtime'
    | 'database'
    | 'cache'
    | 'dns'
    | 'profiler'
    | 'mail'
    | 'broker'
    | 'transfer'
    | 'security'
    | 'module';
};

export type OsPanelProject = {
  domain: string;
  path: string;
  php: string;
  type: string;
  ssl: boolean;
};

export type ProjectActivity = {
  domain: string;
  // Unix seconds, matching the other filesystem timestamps from Rust.
  modifiedAt: number | null;
  lastFile: string | null;
  status: 'ready' | 'partial' | 'empty' | 'unavailable';
};

export async function getProjectActivity(domains: string[]): Promise<ProjectActivity[]> {
  if (isTauri()) return invoke<ProjectActivity[]>('project_activity', { domains, ...customPathArgs() });
  const now = new Date();
  const times = [
    Math.floor(now.getTime() / 1000) - 12 * 60,
    Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 10).getTime() / 1000),
    Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 9, 24).getTime() / 1000),
  ];
  const files = ['resources/views/catalog.blade.php', 'index.html', 'src/routes.php'];
  return domains.map((domain) => {
    const index = mockSnapshot.projects?.findIndex((project) => project.domain === domain) ?? -1;
    return {
      domain,
      modifiedAt: index >= 0 ? times[index] : null,
      lastFile: index >= 0 ? files[index] : null,
      status: index >= 0 ? 'ready' : 'unavailable',
    };
  });
}

export function filterProjects(
  projects: OsPanelProject[],
  query: string,
  tags: ProjectTags = {},
): OsPanelProject[] {
  if (!query.trim()) return projects;
  return projects.filter((project) =>
    matchesProjectSearch(project, query, tagsForProject(tags, project.domain)),
  );
}

export function isEngineUnset(value: string): boolean {
  return /^[-—–\s]+$/.test(value);
}

export type OsPanelSnapshot = {
  detected: boolean;
  // The panel's HTTP API responds (the panel is running); detected is only the fact that an installation exists.
  panelRunning: boolean;
  version: string | null;
  path: string | null;
  checkedAt: string;
  services: OsPanelService[];
  projects?: OsPanelProject[];
  source: 'tauri' | 'mock';
};

// Overview page metrics; zeros mean "no data" (the panel is off).
export type OverviewMetrics = {
  servicesRunning: number;
  servicesTotal: number;
  projectsTotal: number;
  ramBytes: number;
  portsOpen: number;
  portsTotal: number;
  portProblems: number;
};

const mockSnapshot: OsPanelSnapshot = {
  detected: true,
  panelRunning: true,
  version: '6.0.0',
  path: 'C:\\OSPanel',
  checkedAt: new Date().toISOString(),
  source: 'mock',
  services: [
    // detail — translation keys (svc.detail.*), localized in the frontend via t().
    {
      name: 'Apache',
      version: '2.4.62',
      port: ':80',
      status: 'running',
      detail: 'svc.detail.web',
      kind: 'web',
    },
    {
      name: 'PHP',
      version: '8.3.14',
      port: ':9000',
      status: 'running',
      detail: 'svc.detail.runtime',
      kind: 'runtime',
    },
    {
      name: 'MySQL',
      version: '8.0.40',
      port: ':3306',
      status: 'running',
      detail: 'svc.detail.database',
      kind: 'database',
    },
    {
      name: 'Redis',
      version: '7.2.6',
      port: ':6379',
      status: 'warning',
      detail: 'svc.detail.cache',
      kind: 'cache',
    },
    {
      name: 'Bind',
      version: '9.17.15',
      port: ':53',
      status: 'stopped',
      detail: 'svc.detail.dns',
      kind: 'dns',
    },
    {
      name: 'Blackfire',
      version: '2.30.1',
      port: ':8307',
      status: 'stopped',
      detail: 'svc.detail.profiler',
      kind: 'profiler',
    },
    {
      name: 'Mailpit',
      version: '1.28.4',
      port: ':25',
      status: 'running',
      detail: 'svc.detail.mail',
      kind: 'mail',
    },
  ],
  // Demo projects for the browser mode only (in the desktop app the list comes from the panel).
  projects: [
    { domain: 'my-shop.test', path: 'C:\\OSPanel\\domains\\my-shop', php: '8.3', type: 'Laravel', ssl: true },
    { domain: 'landing.test', path: 'C:\\OSPanel\\domains\\landing', php: '8.2', type: 'Static', ssl: false },
    { domain: 'api.local', path: 'C:\\OSPanel\\domains\\api', php: '8.3', type: 'Node + PHP', ssl: true },
  ],
};

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };
const isTauri = () => Boolean((window as TauriWindow).__TAURI_INTERNALS__);

// Rust returns errors as a { code, params } structure — we turn it into an Error
// whose message is an err.* key and whose params later go into t() (see errorText in i18n.ts).
type CommandRejection = { code: string; params?: Record<string, string> };

const isCommandRejection = (value: unknown): value is CommandRejection =>
  typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string';

function commandError(rejection: unknown): Error & { params?: Record<string, string> } {
  if (isCommandRejection(rejection)) {
    return Object.assign(new Error(rejection.code), { params: rejection.params });
  }

  return rejection instanceof Error ? rejection : new Error(String(rejection));
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const module = await import('@tauri-apps/api/core');

  try {
    return await module.invoke<T>(command, args);
  } catch (error) {
    throw commandError(error);
  }
}

export async function pickOsPanelDirectory(currentPath?: string, title?: string): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      title,
      defaultPath: currentPath || undefined,
    });

    return typeof selected === 'string' ? selected : null;
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = false;
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? file.webkitRelativePath.split('/')[0] : null);
    };
    input.click();
  });
}

export function isDesktopApp() {
  return isTauri();
}

export function persistOsPanelPath(path: string) {
  localStorage.setItem('ospanel.path', path);
}

// Custom installation path from the settings: passed to every command that resolves
// the OSPanel root (the Rust side validates it itself — resolve_installation).
const customPathArgs = () => ({ customPath: localStorage.getItem('ospanel.path') });

const browserMenu = (): OsPanelMenuItem[] => [
  {
    id: 'editor',
    fields: { caption: 'Visual Studio Code', category: 'Development', command: 'code.exe', icon: 'code' },
  },
  {
    id: 'terminal',
    fields: {
      caption: '{lang_open_in_console}',
      category: 'Development',
      command: 'wt.exe',
      icon: 'terminal',
    },
  },
  {
    id: 'database',
    fields: { caption: 'HeidiSQL', category: 'Database', command: 'heidisql.exe', icon: 'database' },
  },
  {
    id: 'project',
    fields: {
      caption: '{lang_open_in_explorer}',
      category: 'projects',
      command: 'explorer.exe "{project_root}"',
      icon: 'folder-closed',
      work_directory: '{project_root}',
    },
  },
  { id: 'options', fields: { caption: '{lang_options}', command: 'command_open_options', icon: 'tools' } },
];

function browserMenuDocument(): OsPanelMenuDocument {
  const content = localStorage.getItem('ospanel.demoMenu');
  try {
    const stored = content ? (JSON.parse(content) as OsPanelMenuDocument) : null;
    if (stored && Array.isArray(stored.items) && typeof stored.revision === 'string') return stored;
  } catch {
    /* Ignore a broken browser-only draft. */
  }
  return { items: browserMenu(), revision: 'browser-initial' };
}

export async function readMenu(installationPath?: string | null): Promise<OsPanelMenuDocument> {
  return isTauri()
    ? invoke<OsPanelMenuDocument>(
        'read_menu',
        installationPath ? { customPath: installationPath } : customPathArgs(),
      )
    : browserMenuDocument();
}

export async function writeMenu(
  items: OsPanelMenuItem[],
  expectedRevision: string,
  installationPath?: string | null,
): Promise<OsPanelMenuSaveResult> {
  if (isTauri())
    return invoke<OsPanelMenuSaveResult>('write_menu', {
      items,
      expectedRevision,
      ...(installationPath ? { customPath: installationPath } : customPathArgs()),
    });
  if (browserMenuDocument().revision !== expectedRevision) throw new Error('err.menuConflict');
  const document = { items, revision: crypto.randomUUID() };
  localStorage.setItem('ospanel.demoMenu', JSON.stringify(document));
  return { document, backupPath: null };
}

export async function discoverOsPanel(): Promise<OsPanelSnapshot> {
  const customPath = localStorage.getItem('ospanel.path');

  if (!isTauri()) {
    return { ...mockSnapshot, path: customPath ?? mockSnapshot.path, checkedAt: new Date().toISOString() };
  }

  return invoke<OsPanelSnapshot>('discover_ospanel', { customPath });
}

// Live panel status for the sidebar card: whether its HTTP API responds.
// A lightweight request without a full snapshot — suitable for periodic polling.
export async function panelOnline(): Promise<boolean> {
  if (!isTauri()) return mockSnapshot.panelRunning;

  return invoke<boolean>('panel_online', customPathArgs());
}

export async function refreshService(
  name: string,
  action: 'start' | 'stop' | 'restart',
): Promise<OsPanelService> {
  if (!isTauri()) {
    const service = mockSnapshot.services.find((item) => item.name === name);

    if (!service) throw new Error('err.serviceNotFound');

    return { ...service, status: action === 'stop' ? 'stopped' : 'running' };
  }

  return invoke<OsPanelService>('service_action', { name, action, ...customPathArgs() });
}

export type ModuleUpdate = {
  name: string;
  installed: string;
  available: string | null;
  expected: string | null;
  error: string | null;
  errorParams?: Record<string, string>;
  recovery: boolean;
};
export type AppUpdate = {
  version: string;
  notes: string;
  publishedAt: string;
  size: number;
  url: string;
  sha256: string;
};
export type AppUpdateProgress = {
  phase: 'prepare' | 'download' | 'verify' | 'restart';
  received: number;
  total: number;
};
export async function checkAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  return invoke('check_app_update');
}
export async function appUpdateStartup(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke('app_update_startup');
}
export async function installAppUpdate(
  expected: string,
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<void> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<AppUpdateProgress>();
  channel.onmessage = onProgress;
  return invoke('install_app_update', { expected, onProgress: channel });
}

export async function checkModuleUpdates(force = true): Promise<ModuleUpdate[]> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  return invoke('check_module_updates', { ...customPathArgs(), force });
}
export async function installModuleUpdate(
  name: string,
  expected: string,
  customPath: string | null,
): Promise<string> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  return invoke('install_module_update', { name, expected, customPath });
}
export async function recoverModuleUpdate(name: string, customPath: string | null): Promise<string> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  return invoke('recover_module_update', { name, customPath });
}

export async function fetchOverviewMetrics(): Promise<OverviewMetrics> {
  if (!isTauri()) {
    const running = mockSnapshot.services.filter((item) => item.status === 'running').length;

    return {
      servicesRunning: running,
      servicesTotal: mockSnapshot.services.length,
      projectsTotal: 3,
      ramBytes: 1_280_000_000,
      portsOpen: 4,
      portsTotal: 4,
      portProblems: 0,
    };
  }

  return invoke<OverviewMetrics>('overview_metrics', customPathArgs());
}

export async function openInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_in_browser', { url });
    return;
  }

  const popup = window.open(url, '_blank', 'noopener');

  if (popup === null) throw new Error('err.popupBlocked');
}

export async function openProjectFolder(path: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_folder', { path, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function openFileExternally(path: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_file', { path, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

// Opens the backups/ folder with dumps; the command validates the path itself (within_installation).
export async function openBackupsFolder(): Promise<void> {
  if (isTauri()) {
    await invoke('open_backups_folder', customPathArgs());
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function openPanelFolder(): Promise<void> {
  if (isTauri()) {
    await invoke('open_panel_folder', customPathArgs());
    return;
  }

  throw new Error('err.desktopOnly');
}

export type LogSource = { name: string; label: string; domain: boolean };
// Menu backups preserve system/menu.dat; DB and project backups also name their subject.
export type BackupKind = 'config' | 'db' | 'project' | 'menu';
export type BackupEntry = {
  id: string;
  createdAt: number;
  sizeBytes: number;
  files: number;
  kind: BackupKind;
  subject: string | null;
};

export async function listLogSources(): Promise<LogSource[]> {
  if (isTauri()) return invoke<LogSource[]>('list_log_sources', customPathArgs());

  return [
    { name: 'general.log', label: 'general.log', domain: false },
    { name: 'Apache.log', label: 'Apache.log', domain: false },
    { name: 'domains/dune.loc_error.log', label: 'dune.loc error', domain: true },
  ];
}

export async function fetchLogTail(source: string, maxLines = 300): Promise<string[]> {
  if (isTauri()) return invoke<string[]>('read_log_tail', { source, maxLines, ...customPathArgs() });

  return [
    '[2026-10-05 12:42:08] [info] Apache/2.4.62 started successfully',
    '[2026-10-05 12:42:08] [info] PHP 8.3.14 FPM pool ready',
    '[2026-10-05 12:41:57] [notice] Redis connection established',
    '[2026-10-05 12:39:14] [warn] Redis persistence is disabled',
    '[2026-10-05 12:35:02] [error] Virtual host my-shop.test failed to load',
  ];
}

// A null source clears every log exposed by listLogSources, including domain logs.
export async function clearLogs(source: string | null): Promise<number> {
  if (isTauri()) return invoke<number>('clear_logs', { source, ...customPathArgs() });

  throw new Error('err.desktopOnly');
}

export async function listBackups(): Promise<BackupEntry[]> {
  if (isTauri()) return invoke<BackupEntry[]>('list_backups', customPathArgs());

  return [];
}

export async function createBackup(): Promise<BackupEntry> {
  if (isTauri()) return invoke<BackupEntry>('create_backup', customPathArgs());

  return {
    id: 'backup-mock',
    createdAt: Math.floor(Date.now() / 1000),
    sizeBytes: 0,
    files: 0,
    kind: 'config',
    subject: null,
  };
}

export async function restoreBackup(id: string): Promise<void> {
  if (isTauri()) {
    await invoke('restore_backup', { id, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function createMenuBackup(): Promise<BackupEntry> {
  if (isTauri()) return invoke<BackupEntry>('create_menu_backup', customPathArgs());

  throw new Error('err.desktopOnly');
}

export async function restoreMenuBackup(id: string): Promise<void> {
  if (isTauri()) {
    await invoke('restore_menu_backup', { id, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function createDbBackup(module: string): Promise<BackupEntry> {
  if (isTauri()) return invoke<BackupEntry>('create_db_backup', { module, ...customPathArgs() });

  return {
    id: `backup-mock-db-${module}`,
    createdAt: Math.floor(Date.now() / 1000),
    sizeBytes: 0,
    files: 1,
    kind: 'db',
    subject: module,
  };
}

export async function restoreDbBackup(id: string): Promise<void> {
  if (isTauri()) {
    await invoke('restore_db_backup', { id, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function createProjectBackup(domain: string): Promise<BackupEntry> {
  if (isTauri()) return invoke<BackupEntry>('create_project_backup', { domain, ...customPathArgs() });

  return {
    id: `backup-mock-proj-${domain}`,
    createdAt: Math.floor(Date.now() / 1000),
    sizeBytes: 0,
    files: 1,
    kind: 'project',
    subject: domain,
  };
}

export async function restoreProjectBackup(id: string): Promise<void> {
  if (isTauri()) {
    await invoke('restore_project_backup', { id, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function deleteBackup(id: string): Promise<void> {
  if (isTauri()) {
    await invoke('delete_backup', { id, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

export type ConfigFile = {
  name: string;
  service: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
};

export async function listConfigs(): Promise<ConfigFile[]> {
  if (isTauri()) return invoke<ConfigFile[]>('list_configs', customPathArgs());

  return [
    {
      name: 'httpd-vhosts.conf',
      service: 'Apache',
      path: 'C:/OSPanel/config/Apache/httpd-vhosts.conf',
      sizeBytes: 4300,
      modifiedAt: Math.floor(Date.now() / 1000) - 700,
    },
    {
      name: 'php.ini',
      service: 'PHP-8.3',
      path: 'C:/OSPanel/config/PHP-8.3/php.ini',
      sizeBytes: 72704,
      modifiedAt: Math.floor(Date.now() / 1000) - 90000,
    },
    {
      name: 'my.ini',
      service: 'MySQL-8.0',
      path: 'C:/OSPanel/config/MySQL-8.0/my.ini',
      sizeBytes: 12300,
      modifiedAt: Math.floor(Date.now() / 1000) - 170000,
    },
  ];
}

export async function readConfigFile(path: string): Promise<string> {
  if (isTauri()) return invoke<string>('read_config', { path, ...customPathArgs() });

  return '# Demo config content (browser preview mode)';
}

export interface AutostartReport {
  required: string[];
  started: string[];
  alreadyRunning: string[];
  unmatched: string[];
}

// Starts modules pinned in the projects' project.ini (start only, never stops).
export async function autostartFromProjects(): Promise<AutostartReport> {
  if (!isTauri()) return { required: [], started: [], alreadyRunning: [], unmatched: [] };

  return invoke<AutostartReport>('autostart_from_projects');
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (isTauri()) {
    await invoke('set_autostart', { enabled });
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function autostartEnabled(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>('autostart_enabled');

  return false;
}

// Minimize to tray instead of closing (the tray icon is created by Rust).
export async function setCloseToTray(enabled: boolean, lang: string): Promise<void> {
  if (isTauri()) {
    await invoke('set_close_to_tray', { enabled, lang });
    return;
  }

  throw new Error('err.desktopOnly');
}

export async function closeToTrayEnabled(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>('close_to_tray_enabled');

  return false;
}

export type UserInfo = { name: string };

// Windows user name (sidebar card); in the browser — a static example.
export async function getUserInfo(): Promise<UserInfo> {
  if (isTauri()) return invoke<UserInfo>('get_user_info');

  return { name: 'Toster' };
}

export async function askConfirm(message: string, title?: string): Promise<boolean> {
  if (isTauri()) {
    const { confirm } = await import('@tauri-apps/plugin-dialog');

    return confirm(message, { title, kind: 'warning' });
  }

  return window.confirm(message);
}

export type ProjectModuleOptions = {
  httpEngines: string[];
  phpEngines: string[];
  nodeEngines: string[];
};

// Per-project module version override; 'auto' — as in the global OSPanel settings.
export type ProjectModuleOverride = {
  httpEngine: string;
  phpEngine: string;
  nodeEngine: string;
  // 'on' | 'off' | 'auto' — per-project TLS toggle (tls_enabled in .osp/project.ini).
  tlsEnabled: string;
};

export type ProjectSettings = ProjectModuleOverride & {
  domain: string;
  fileExists: boolean;
};

const mockModuleOptions: ProjectModuleOptions = {
  httpEngines: ['Apache', 'Nginx', 'Caddy'],
  phpEngines: ['PHP-7.4', 'PHP-8.0', 'PHP-8.1', 'PHP-8.2', 'PHP-8.3', 'PHP-8.4'],
  nodeEngines: [],
};

export async function getProjectModuleOptions(): Promise<ProjectModuleOptions> {
  if (isTauri()) return invoke<ProjectModuleOptions>('project_module_options', customPathArgs());

  return mockModuleOptions;
}

export async function getProjectSettings(domain: string): Promise<ProjectSettings> {
  if (isTauri()) return invoke<ProjectSettings>('read_project_settings', { domain, ...customPathArgs() });

  const project = mockSnapshot.projects?.find((item) => item.domain === domain);

  return {
    domain,
    httpEngine: 'Apache',
    phpEngine: `PHP-${project?.php ?? '8.3'}`,
    nodeEngine: 'auto',
    tlsEnabled: project?.ssl ? 'on' : 'off',
    fileExists: true,
  };
}

// Global project engine values ("Settings → Projects" of the panel itself);
// an empty string means not set globally (no engine override for projects).
export type GlobalProjectEngines = {
  httpEngine: string;
  phpEngine: string;
  nodeEngine: string;
};

export async function getGlobalProjectEngines(): Promise<GlobalProjectEngines> {
  if (isTauri()) return invoke<GlobalProjectEngines>('global_project_engines', customPathArgs());

  return { httpEngine: 'Apache', phpEngine: 'PHP-8.3', nodeEngine: '' };
}

export async function saveProjectSettings(
  domain: string,
  override: ProjectModuleOverride,
): Promise<ProjectSettings> {
  if (isTauri()) {
    return invoke<ProjectSettings>('write_project_settings', {
      domain,
      settings: override,
      ...customPathArgs(),
    });
  }

  return { domain, ...override, fileExists: true };
}

export type CreateProjectParams = {
  domain: string;
  httpEngine?: string;
  phpEngine?: string;
  nodeEngine?: string;
};

// Data of the created project: the path and engines are needed to show the project
// in the list right away — the panel API does not see new domains after startup.
export type CreatedProject = {
  domain: string;
  path: string;
  http: string;
  php: string;
  ssl: boolean;
};

export async function createProject(params: CreateProjectParams): Promise<CreatedProject> {
  if (isTauri()) return invoke<CreatedProject>('create_project', { params, ...customPathArgs() });

  return {
    domain: params.domain,
    path: `C:\\OSPanel\\home\\${params.domain}`,
    http: params.httpEngine ?? 'auto',
    php: (params.phpEngine ?? 'auto').replace(/^PHP-/, ''),
    ssl: false,
  };
}

// Panel restart: osp.bat exit, then ospanel.exe. At startup the panel
// rescans home/ — the created domains make it into its project list.
export async function restartOsPanel(): Promise<void> {
  if (isTauri()) {
    await invoke('restart_ospanel', customPathArgs());
    return;
  }

  throw new Error('err.desktopOnly');
}

const PANEL_READY_TIMEOUT_MS = 30_000;
const PANEL_READY_POLL_MS = 500;

// The native restart returns as soon as ospanel.exe has been spawned, but its HTTP API answers
// a few seconds later. A service command sent inside that window would be lost, so callers keep
// the panel locked until the API is back. The wait is bounded: a panel that never returns must
// not leave the actions blocked forever.
export async function waitForPanelReady(
  options: {
    timeoutMs?: number;
    pollMs?: number;
    probe?: () => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const probe = options.probe ?? panelOnline;
  const pollMs = options.pollMs ?? PANEL_READY_POLL_MS;
  const timeoutMs = options.timeoutMs ?? PANEL_READY_TIMEOUT_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;

  do {
    await sleep(pollMs);
    try {
      if (await probe()) return true;
    } catch {
      // A rejected probe means the API is not up yet — keep waiting until the timeout.
    }
  } while (Date.now() < deadline);

  return false;
}

// Deletes the home/<domain> directory entirely (the frontend must ask for confirmation first).
export async function deleteProject(domain: string): Promise<void> {
  if (isTauri()) {
    await invoke('delete_project', { domain, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}

// Editors found in standard installation locations — for the "Open in" menu item.
export type EditorInfo = { id: string; name: string };

export async function listEditors(): Promise<EditorInfo[]> {
  if (isTauri()) return invoke<EditorInfo[]>('list_editors');

  return [{ id: 'vscode', name: 'VS Code' }];
}

export async function openInEditor(editorId: string, path: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_in_editor', { editorId, path, ...customPathArgs() });
    return;
  }

  throw new Error('err.desktopOnly');
}
