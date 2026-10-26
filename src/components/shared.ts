import {
  Activity,
  ArrowLeftRight,
  Box,
  CircleHelp,
  Code2,
  Copy,
  Database,
  FileCode2,
  FolderOpen,
  FolderSync,
  Gauge,
  Globe2,
  KeyRound,
  LayoutDashboard,
  ListTree,
  Mail,
  Network,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Terminal,
} from 'lucide-react';
import { type ReactNode, type RefObject, useEffect } from 'react';
import type { Translator } from '../i18n';
import type { OsPanelService, ServiceStatus } from '../ospanel';

export type Page =
  | 'overview'
  | 'services'
  | 'projects'
  | 'configs'
  | 'menu'
  | 'logs'
  | 'backups'
  | 'settings';

export type Service = OsPanelService & { icon: typeof Activity };

export const iconForService = (kind: OsPanelService['kind']) =>
  ({
    web: Globe2,
    runtime: Code2,
    database: Database,
    cache: Activity,
    dns: Network,
    profiler: Gauge,
    mail: Mail,
    broker: ArrowLeftRight,
    transfer: FolderSync,
    security: KeyRound,
    module: Box,
  })[kind] ?? Box;

export type ServiceGroupId = 'web' | 'runtime' | 'database' | 'cache' | 'dns' | 'mail' | 'tools' | 'other';

// A service group of the "Services" page as rendered: id, translated title and its rows.
export type ServiceGroupView = {
  id: ServiceGroupId;
  label: string;
  items: { service: Service; index: number }[];
};

// kind → a section of the "Services" page; unmatched kinds fall into "other"
// (shown only if at least one service lands in it).
export const SERVICE_GROUPS: { id: ServiceGroupId; kinds: OsPanelService['kind'][] }[] = [
  { id: 'web', kinds: ['web'] },
  { id: 'runtime', kinds: ['runtime'] },
  { id: 'database', kinds: ['database'] },
  { id: 'cache', kinds: ['cache', 'broker'] },
  { id: 'dns', kinds: ['dns', 'transfer'] },
  { id: 'mail', kinds: ['mail'] },
  { id: 'tools', kinds: ['profiler', 'security', 'module'] },
];

// Module process memory: gigabytes with one decimal, megabytes below the threshold.
export const formatRam = (bytes: number): string => {
  if (bytes <= 0) return '—';

  const gb = bytes / 2 ** 30;

  if (gb >= 1) return `${gb.toFixed(1)} GB`;

  return `${Math.round(bytes / 2 ** 20)} MB`;
};

// A file size for the tables: megabytes, then kilobytes, then bytes.
export const formatSize = (bytes: number) =>
  bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes > 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;

// The media query that switches the sidebar into the icon rail (see narrowWindow in App).
export const NARROW_WINDOW_QUERY = '(max-width: 1050px)';

// action → the toast key shown after the service action has finished.
export const SERVICE_TOAST_KEYS = {
  start: 'services.toastStarted',
  stop: 'services.toastStopped',
  restart: 'services.toastRestarted',
} as const;

export const navItems: { id: Page; icon: typeof Activity }[] = [
  { id: 'overview', icon: LayoutDashboard },
  { id: 'services', icon: SlidersHorizontal },
  { id: 'projects', icon: FolderOpen },
  { id: 'configs', icon: FileCode2 },
  { id: 'menu', icon: ListTree },
  { id: 'logs', icon: Terminal },
];

export type MenuEntry = {
  label: string;
  icon?: typeof Activity;
  onSelect?: () => void;
  danger?: boolean;
  // A blocked entry (e.g. a service command while the panel is restarting): it stays
  // visible for context, but selecting it does nothing.
  disabled?: boolean;
  // A nested section (e.g. "Open in" with the list of found editors).
  children?: { label: string; onSelect: () => void }[];
};

// An action button inside a toast (e.g. "Restart panel" after creating a project).
export type ToastAction = { label: string; run: () => void };

// The toast sender shared by the components: the optional action adds a button to the toast.
export type Notify = (message: string, action?: ToastAction) => void;

// The tabs of the Settings page — shared by the router, the palette and the page itself.
export type SettingsTab = 'connection' | 'autostart' | 'appearance';

// The trigger is a render prop so the call site renders a real <button type="button"> without a wrapper,
// while RowMenu passes it the state and the open handler.
export type MenuTrigger = (controls: { onToggle: () => void; open: boolean }) => ReactNode;

export async function copyText(t: Translator, text: string, labelKey: string, notify: Notify) {
  try {
    await navigator.clipboard.writeText(text);
    notify(t('common.copied', { label: t(labelKey) }));
  } catch {
    notify(t('common.copyFailed'));
  }
}

// Closes an open overlay — a row menu, a dialog, the search palette — when the user clicks
// outside of its element or presses Escape. `enabled` lets a component wire it unconditionally.
export function useDismiss<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClose: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;

    const handleOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [ref, onClose, enabled]);
}

// The menu of a service. `blocked` marks the panel busy (a restart is running): the commands
// are shown greyed out, while harmless entries like "Copy name" stay available.
export const serviceMenuEntries = (
  service: Service,
  onAction: (service: Service, action: 'start' | 'stop' | 'restart') => void,
  t: Translator,
  notify: Notify,
  blocked = false,
): MenuEntry[] => {
  const toggle = stopStartAction(service, t);
  const actions: MenuEntry[] = [];

  if (toggle.action) {
    actions.push({
      label: toggle.label,
      icon: toggle.icon,
      disabled: blocked,
      onSelect: () => {
        if (!blocked) onAction(service, toggle.action as 'start' | 'stop');
      },
    });
    actions.push({
      label: t('common.restart'),
      icon: RefreshCw,
      disabled: blocked,
      onSelect: () => {
        if (!blocked) onAction(service, 'restart');
      },
    });
  }

  return [
    ...actions,
    {
      label: t('common.copyName'),
      icon: Copy,
      onSelect: () => void copyText(t, service.name, 'label.serviceName', notify),
    },
  ];
};

type ServiceActionDecision =
  | { label: string; icon: typeof Play | typeof Square; action: 'start' | 'stop'; disabled: false }
  | { label: string; icon: typeof CircleHelp; action: null; disabled: true };

// Unknown state is display-only: acting on it would guess whether the process is running.
export const stopStartAction = (service: Service, t: Translator): ServiceActionDecision => {
  if (service.status === 'unknown') {
    return { label: t('common.unknown'), icon: CircleHelp, action: null, disabled: true };
  }

  const running = service.status === 'running';

  return {
    label: running ? t('common.stop') : t('common.start'),
    icon: running ? Square : Play,
    action: running ? 'stop' : 'start',
    disabled: false,
  };
};

// Status text for a dot or a row — each state has its own wording.
export const statusLabel = (status: ServiceStatus, t: Translator): string =>
  status === 'running'
    ? t('common.working')
    : status === 'warning'
      ? t('common.warning')
      : status === 'unknown'
        ? t('common.unknown')
        : t('common.stopped');

export function serviceGroupSummary(
  items: { service: Service }[],
  t: Translator,
): { text: string; tone: 'ok' | 'warning' | 'idle' } {
  const running = items.filter(({ service }) => service.status === 'running').length;
  const hasUnknown = items.some(({ service }) => service.status === 'unknown');
  const hasWarning = items.some(({ service }) => service.status === 'warning');

  if (hasUnknown) return { text: t('services.groupUnknown'), tone: 'warning' };
  if (hasWarning) return { text: t('services.groupWarning'), tone: 'warning' };
  if (running === items.length) return { text: t('services.groupAllRunning'), tone: 'ok' };
  if (running === 0) return { text: t('services.groupAllStopped'), tone: 'idle' };

  return { text: t('services.groupPartial', { k: running, n: items.length }), tone: 'idle' };
}

export type ActivityEntry = { level: 'error' | 'warning' | 'info'; time: string; text: string };
