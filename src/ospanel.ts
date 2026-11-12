import type { HostsDocument, HostsSaveResult } from './hosts';
import type { OsPanelMenuDocument, OsPanelMenuItem, OsPanelMenuSaveResult } from './menu';
import type { ModuleProfiles, ProfileDocument, ProfileSave } from './moduleProfiles';
import { normalizeProjectDomain } from './projectDomain';
import { matchesProjectSearch, type ProjectTags, tagsForProject } from './projectTags';
import type { ProjectFileSave, ProjectWorkspace } from './projectWorkspace';
import { settingsStorage } from './settingsStorage';

export type ServiceStatus = 'running' | 'stopped' | 'warning' | 'unknown';

export type OsPanelService = {
  name: string;
  version: string;
  port: string;
  profile?: string | null;
  moduleActions?: { browser: boolean; shell: boolean };
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
      moduleActions: { browser: false, shell: true },
      version: '8.3.14',
      port: ':9000',
      status: 'running',
      detail: 'svc.detail.runtime',
      kind: 'runtime',
    },
    {
      name: 'MySQL',
      moduleActions: { browser: false, shell: true },
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
      moduleActions: { browser: true, shell: false },
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
    { domain: 'api.test', path: 'C:\\OSPanel\\domains\\api', php: '8.3', type: 'Node + PHP', ssl: true },
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

let demoHosts: HostsDocument = {
  path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
  content: '# Windows hosts\n127.0.0.1 localhost\n::1 localhost\n',
  revision: 'browser-initial',
  encoding: 'UTF-8',
};

export async function readHosts(): Promise<HostsDocument> {
  return isTauri() ? invoke<HostsDocument>('read_hosts') : { ...demoHosts };
}

export async function writeHosts(content: string, expectedRevision: string): Promise<HostsSaveResult> {
  if (isTauri()) return invoke<HostsSaveResult>('write_hosts', { content, expectedRevision });
  if (expectedRevision !== demoHosts.revision) throw new Error('err.hostsConflict');
  demoHosts = { ...demoHosts, content, revision: crypto.randomUUID() };
  return { document: { ...demoHosts }, backupPath: null, dnsFlushed: true };
}

export async function flushHostsDns(): Promise<void> {
  if (isTauri()) await invoke('flush_hosts_dns');
}

export function persistOsPanelPath(path: string) {
  settingsStorage.setItem('ospanel.path', path);
}

// Custom installation path from the settings: passed to every command that resolves
// the OSPanel root (the Rust side validates it itself — resolve_installation).
const customPathArgs = () => ({ customPath: settingsStorage.getItem('ospanel.path') });

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
  const customPath = settingsStorage.getItem('ospanel.path');

  if (!isTauri()) {
    return {
      ...mockSnapshot,
      services: mockSnapshot.services.map((service) => ({
        ...service,
        profile: demoActiveProfiles.get(service.name) ?? 'default',
      })),
      path: customPath ?? mockSnapshot.path,
      checkedAt: new Date().toISOString(),
    };
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

    return {
      ...service,
      profile: demoActiveProfiles.get(name) ?? 'default',
      status: action === 'stop' ? 'stopped' : 'running',
      moduleActions: action === 'stop' ? { browser: false, shell: false } : service.moduleActions,
    };
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

export async function openProjectConsole(domain: string): Promise<void> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  await invoke('open_project_console', { domain, ...customPathArgs() });
}

export type ModuleOpenAction = 'console' | 'explorer' | 'browser' | 'shell';

export async function openModule(name: string, action: ModuleOpenAction): Promise<void> {
  if (isTauri()) {
    await invoke('open_module', { name, action, ...customPathArgs() });
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
    { name: 'domains/example.test_error.log', label: 'example.test error', domain: true },
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

// Browser previews use an isolated, synthetic profile store; desktop calls always use disk/API data.
const demoProfiles = new Map<string, Map<string, Record<string, string>>>();
const demoActiveProfiles = new Map<string, string>();
function browserProfiles(name: string) {
  let profiles = demoProfiles.get(name);
  if (!profiles) {
    profiles = new Map([
      [
        'default',
        {
          'settings.ini': '[main]\nip = 127.0.1.10\nlog_level = error\n',
          'templates/example.conf': '# Example module template\n',
        },
      ],
    ]);
    demoProfiles.set(name, profiles);
  }
  return profiles;
}
export async function listModuleProfiles(name: string): Promise<ModuleProfiles> {
  if (isTauri()) return invoke('list_module_profiles', { name, ...customPathArgs() });
  return {
    active: demoActiveProfiles.get(name) ?? 'default',
    online: true,
    factoryAvailable: true,
    factoryData: false,
    profiles: [...browserProfiles(name).keys()].map((name) => ({
      name,
      builtin: name === 'default',
      hasData: false,
    })),
  };
}
export async function readModuleProfile(name: string, profile: string): Promise<ProfileDocument> {
  if (isTauri()) return invoke('read_module_profile', { name, profile, ...customPathArgs() });
  const files = browserProfiles(name).get(profile);
  if (!files) throw new Error('err.profileMissing');
  return {
    path: `C:/OSPanel/config/${name}/${profile}`,
    files: Object.entries(files).map(([name, content]) => ({ name, sizeBytes: content.length })),
  };
}
export async function readProfileFile(name: string, profile: string, file: string): Promise<string> {
  if (isTauri()) return invoke('read_profile_file', { name, profile, file, ...customPathArgs() });
  const content = browserProfiles(name).get(profile)?.[file];
  if (content === undefined) throw new Error('err.profileMissing');
  return content;
}
export async function saveProfileFile(
  name: string,
  profile: string,
  file: string,
  original: string,
  content: string,
): Promise<ProfileSave> {
  if (isTauri())
    return invoke('save_profile_file', { name, profile, file, original, content, ...customPathArgs() });
  const files = browserProfiles(name).get(profile);
  if (!files || files[file] !== original) throw new Error('err.profileConflict');
  files[file] = content;
  return { content, backupPath: `C:/OSPanel/backups/module-profiles/${name}/${profile}-example` };
}
export async function createModuleProfile(
  name: string,
  profile: string,
  source: string,
  factorySource: boolean,
  copyData: boolean,
): Promise<void> {
  if (isTauri())
    return invoke('create_module_profile', {
      name,
      profile,
      source,
      factorySource,
      copyData,
      ...customPathArgs(),
    });
  const profiles = browserProfiles(name);
  if ([...profiles.keys()].some((p) => p.toLowerCase() === profile.toLowerCase()))
    throw new Error('err.profileExists');
  const files = profiles.get(factorySource ? 'default' : source);
  if (!files) throw new Error('err.profileMissing');
  profiles.set(profile, { ...files });
}
export async function renameModuleProfile(name: string, profile: string, next: string): Promise<void> {
  if (isTauri()) return invoke('rename_module_profile', { name, profile, next, ...customPathArgs() });
  const profiles = browserProfiles(name),
    files = profiles.get(profile);
  if (!files) throw new Error('err.profileMissing');
  if (profiles.has(next)) throw new Error('err.profileExists');
  profiles.set(next, files);
  profiles.delete(profile);
}
export async function deleteModuleProfile(name: string, profile: string): Promise<string> {
  if (isTauri()) return invoke('delete_module_profile', { name, profile, ...customPathArgs() });
  browserProfiles(name).delete(profile);
  return `C:/OSPanel/backups/module-profiles/${name}/${profile}-example`;
}
export async function activateModuleProfile(name: string, profile: string): Promise<void> {
  if (isTauri()) return invoke('activate_module_profile', { name, profile, ...customPathArgs() });
  if (!browserProfiles(name).has(profile)) throw new Error('err.profileMissing');
  demoActiveProfiles.set(name, profile);
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

  return { name: 'Demo User' };
}

// In-app confirmation requests: askConfirm hands the question to the ConfirmDialog
// host mounted once in App, and the host resolves it with the user's answer. This
// replaces the native message box, whose warning icon always plays a system sound
// that cannot be muted through the dialog plugin. Overlapping callers queue up.
export type ConfirmRequest = {
  message: string;
  title: string;
  resolve: (confirmed: boolean) => void;
};

let confirmHost: ((request: ConfirmRequest) => void) | null = null;

// The host registers on mount; its cleanup unregisters and declines everything
// still pending, so callers never wait on an unmounted dialog.
export function registerConfirmHost(handler: ((request: ConfirmRequest) => void) | null): void {
  confirmHost = handler;
}

export async function askConfirm(message: string, title?: string): Promise<boolean> {
  if (isTauri()) {
    const host = confirmHost;
    if (!host) return false;

    return new Promise<boolean>((resolve) => host({ message, title: title ?? '', resolve }));
  }

  return window.confirm(message);
}

export type ProjectModuleOptions = {
  httpEngines: string[];
  phpEngines: string[];
  nodeEngines: string[];
  nvmAvailable?: boolean;
  databaseEngines?: string[];
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
  nvmAvailable: true,
  databaseEngines: ['MySQL-8.4', 'MariaDB-11.8', 'PostgreSQL-17'],
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

const demoProjectFiles = new Map<string, string>();
const demoProjectMenus = new Map<string, OsPanelMenuDocument>();
const projectFileArgs = (project: OsPanelProject) => ({
  domain: project.domain,
  baseDir: project.path,
  ...customPathArgs(),
});

export async function diagnoseProject(
  project: OsPanelProject,
  selectedDomain: string,
): Promise<import('./projectDiagnostics').ProjectDiagnosticReport> {
  const { taskDiagnostic } = await import('./projectDiagnostics');
  const request = isTauri()
    ? invoke<import('./projectDiagnostics').ProjectDiagnosticReport>('diagnose_project', {
        ...projectFileArgs(project),
        selectedDomain,
      })
    : Promise.resolve<import('./projectDiagnostics').ProjectDiagnosticReport>({
        domain: selectedDomain,
        checkedAt: Date.now(),
        checks: [
          {
            id: 'config',
            group: 'configuration',
            status: 'ok',
            title: 'diag.title.config',
            message: 'diag.config.ok',
            hint: null,
            params: {},
            evidence: '',
            tab: 'overview',
            filePath: null,
          },
          {
            id: 'api',
            group: 'runtime',
            status: 'ok',
            title: 'diag.title.api',
            message: 'diag.api.ok',
            hint: null,
            params: {},
            evidence: '',
            tab: null,
            filePath: null,
          },
          {
            id: 'module:PHP',
            group: 'runtime',
            status: 'ok',
            title: 'diag.title.module',
            message: 'diag.module.ok',
            hint: null,
            params: { name: `PHP-${project.php}` },
            evidence: '',
            tab: 'environment',
            filePath: null,
          },
          {
            id: 'webRoot',
            group: 'files',
            status: 'error',
            title: 'diag.title.webRoot',
            message: 'diag.webRoot.missing',
            hint: 'diag.hint.webRoot',
            params: {},
            evidence: `${project.path}\\public`,
            tab: 'web',
            filePath: null,
          },
          {
            id: 'dns',
            group: 'network',
            status: 'warning',
            title: 'diag.title.dns',
            message: 'diag.dns.mismatch',
            hint: 'diag.hint.dns',
            params: { domain: selectedDomain },
            evidence: '127.0.0.1',
            tab: null,
            filePath: null,
          },
          {
            id: 'http',
            group: 'network',
            status: 'skipped',
            title: 'diag.title.http',
            message: 'diag.connection.unknown',
            hint: null,
            params: {},
            evidence: '',
            tab: 'web',
            filePath: null,
          },
        ],
      });
  const [result, tasks] = await Promise.allSettled([request, readProjectFile(project, 'tasks.ini')]);
  if (result.status === 'rejected') throw result.reason;
  const report = result.value;
  report.checks.push(
    tasks.status === 'fulfilled'
      ? taskDiagnostic(tasks.value, selectedDomain)
      : {
          id: 'tasks',
          group: 'configuration',
          status: 'skipped',
          title: 'diag.title.tasks',
          message: 'diag.tasks.unknown',
          hint: null,
          params: {},
          evidence: '',
          tab: 'tasks',
          filePath: null,
        },
  );
  return report;
}

export async function readProjectWorkspace(project: OsPanelProject): Promise<ProjectWorkspace> {
  if (isTauri()) return invoke<ProjectWorkspace>('read_project_workspace', projectFileArgs(project));
  const key = `${project.path}/project.ini`;
  if (!demoProjectFiles.has(key)) {
    const settings = await getProjectSettings(project.domain);
    demoProjectFiles.set(
      key,
      `[${project.domain}]\nhttp_engine = ${settings.httpEngine}\nphp_engine = ${settings.phpEngine}\nnode_engine = ${settings.nodeEngine}\ntls_enabled = ${settings.tlsEnabled}\nweb_root = {base_dir}\\public\n`,
    );
  }
  return {
    baseDir: project.path,
    content: demoProjectFiles.get(key) ?? null,
    laravel: demoProjectFiles.has(`${project.path}/laravel.json`) ? 'pending' : null,
    wordpress: demoProjectFiles.has(`${project.path}/wordpress.json`) ? 'pending' : null,
    files: [
      'project.ini',
      'env.ini',
      'menu.ini',
      'tasks.ini',
      ...['nginx', 'apache', 'caddy'].map((engine) => `${engine}/${project.domain}.conf`),
    ],
  };
}

export async function readProjectFile(project: OsPanelProject, file: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>('read_project_file', { ...projectFileArgs(project), file });
  return demoProjectFiles.get(`${project.path}/${file}`) ?? null;
}

export async function readProjectMenu(project: OsPanelProject): Promise<OsPanelMenuDocument> {
  if (isTauri()) return invoke<OsPanelMenuDocument>('read_project_menu', projectFileArgs(project));
  return structuredClone(
    demoProjectMenus.get(project.path.toLowerCase().replace(/\\/g, '/')) ?? {
      items: [],
      revision: 'project-menu-missing',
    },
  );
}

export async function writeProjectMenu(
  project: OsPanelProject,
  items: OsPanelMenuItem[],
  expectedRevision: string,
): Promise<OsPanelMenuSaveResult> {
  if (isTauri())
    return invoke<OsPanelMenuSaveResult>('write_project_menu', {
      ...projectFileArgs(project),
      items,
      expectedRevision,
    });
  if ((await readProjectMenu(project)).revision !== expectedRevision)
    throw new Error('err.projectWorkspaceConflict');
  const document = { items: structuredClone(items), revision: crypto.randomUUID() };
  demoProjectMenus.set(project.path.toLowerCase().replace(/\\/g, '/'), document);
  return { document: structuredClone(document), backupPath: null };
}

export async function saveProjectFile(
  project: OsPanelProject,
  file: string,
  original: string | null,
  content: string,
): Promise<ProjectFileSave> {
  if (isTauri())
    return invoke<ProjectFileSave>('save_project_file', {
      ...projectFileArgs(project),
      file,
      original,
      content,
    });
  const key = `${project.path}/${file}`;
  if ((demoProjectFiles.get(key) ?? null) !== original) throw new Error('err.projectWorkspaceConflict');
  demoProjectFiles.set(key, content);
  return {
    content,
    backupPath: original === null ? null : `C:/OSPanel/backups/project-settings/example/original.bak`,
  };
}

export type CreateProjectParams = {
  domain: string;
  language?: string;
  httpEngine?: string;
  phpEngine?: string;
  nodeEngine?: string;
  template?: import('./projectTemplates').ProjectTemplateId;
  backendPort?: number;
  database?: { engine: string; name: string; username: string; password: string };
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
  const domain = normalizeProjectDomain(params.domain);
  if (!domain) throw new Error('err.invalidDomain');
  if (isTauri())
    return invoke<CreatedProject>('create_project', { params: { ...params, domain }, ...customPathArgs() });

  if (params.template && params.template !== 'empty') {
    const { projectTemplate } = await import('./projectTemplates');
    const template = projectTemplate(params.template);
    if (template.id === 'laravel' || template.id === 'wordpress')
      demoProjectFiles.set(
        `C:\\OSPanel\\home\\${domain}/${template.id}.json`,
        JSON.stringify({ version: 2, status: 'pending', language: params.language ?? 'en' }),
      );
    const port = params.backendPort ?? 3000;
    if (template.node && (!Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error('err.invalidSettingValue');
    const settings = {
      http_engine: params.httpEngine ?? 'auto',
      php_engine: params.phpEngine ?? '',
      node_engine: params.nodeEngine ?? '',
      project_root: template.projectRoot,
      web_root: template.webRoot ?? '',
      ...template.settings,
    };
    demoProjectFiles.set(
      `C:\\OSPanel\\home\\${domain}/project.ini`,
      `[${domain}]\n${Object.entries(settings)
        .map(([key, value]) => `${key} = ${value.replace(/\{port\}/g, String(port))}`)
        .join('\n')}\n`,
    );
    if (template.id === 'node' || template.id === 'laravel')
      demoProjectFiles.set(
        `C:\\OSPanel\\home\\${domain}/tasks.ini`,
        `[${domain}]\n${template.id === 'node' ? 'Start application = * * * * * 1 0 cmd.exe /c "osp project {host} start"' : 'Laravel scheduler = * * * * * * 0 cmd.exe /c "osp project {host} & php artisan schedule:run"'}\n`,
      );
  }
  return {
    domain,
    path: `C:\\OSPanel\\home\\${domain}`,
    http: params.httpEngine ?? 'auto',
    php: (params.phpEngine ?? 'auto').replace(/^PHP-/, ''),
    ssl: false,
  };
}

export type RenamedProject = Pick<OsPanelProject, 'domain' | 'path'>;

export type LaravelInstallProgress = {
  phase:
    | 'preparing'
    | 'installing'
    | 'downloading'
    | 'extracting'
    | 'database'
    | 'configuring'
    | 'publishing';
  output: string;
  downloaded?: number | null;
  total?: number | null;
};
export type LaravelInstalled = { backupPath: string };
export async function installProjectLaravel(
  project: OsPanelProject,
  onProgress: (progress: LaravelInstallProgress) => void,
): Promise<LaravelInstalled> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<LaravelInstallProgress>();
  channel.onmessage = onProgress;
  return invoke('install_project_laravel', { ...projectFileArgs(project), onProgress: channel });
}

export async function installProjectWordPress(
  project: OsPanelProject,
  onProgress: (progress: LaravelInstallProgress) => void,
): Promise<LaravelInstalled> {
  if (!isTauri()) throw new Error('err.desktopOnly');
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<LaravelInstallProgress>();
  channel.onmessage = onProgress;
  return invoke('install_project_wordpress', { ...projectFileArgs(project), onProgress: channel });
}

export async function renameProject(project: OsPanelProject, newDomain: string): Promise<RenamedProject> {
  const domain = normalizeProjectDomain(newDomain);
  if (!domain) throw new Error('err.invalidDomain');
  if (isTauri())
    return invoke<RenamedProject>('rename_project', {
      domain: project.domain,
      newDomain: domain,
      path: project.path,
      ...customPathArgs(),
    });
  throw new Error('err.desktopOnly');
}

// Ensure the configured panel process exists, even while its HTTP API is still starting.
export async function startOsPanel(): Promise<void> {
  if (isTauri()) {
    await invoke('start_ospanel', { customPath: settingsStorage.getItem('ospanel.path') ?? '' });
    return;
  }
  throw new Error('err.desktopOnly');
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
export type EditorInfo = { id: string; name: string; exe?: string };

export async function listProjectEditors(project: OsPanelProject): Promise<EditorInfo[]> {
  if (isTauri()) return invoke<EditorInfo[]>('list_project_editors', projectFileArgs(project));
  const [global, local] = await Promise.all([readMenu(), readProjectMenu(project)]);
  return [
    ...global.items.map((item) => ({ ...item, id: `global:${item.id}` })),
    ...local.items.map((item) => ({ ...item, id: `project:${item.id}` })),
  ]
    .filter((item) => item.fields.command?.includes('{base_dir}') && item.fields.enabled !== 'off')
    .map((item) => ({ id: item.id, name: item.fields.caption ?? '' }));
}

export async function openProjectEditor(project: OsPanelProject, editorId: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_project_editor', { ...projectFileArgs(project), editorId });
    return;
  }
  throw new Error('err.desktopOnly');
}

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
