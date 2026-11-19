import {
  Activity,
  Code2,
  Copy,
  Gauge,
  Globe2,
  Inbox,
  Moon,
  Power,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppUpdates } from '../../appUpdates';
import { useI18n } from '../../i18n';
import { useModuleUpdates } from '../../moduleUpdates';
import { navItems, type Page, type SettingsTab, useDismiss } from '../shared';
import { Button, DialogOverlay, DialogPanel, EmptyState, Input } from '../ui';

type SearchLabel = {
  id: string;
  titleKey: string;
  sectionKey: string;
  icon: typeof Activity;
  keywordsKey?: string;
};

export type SearchAction = SearchLabel & { run: () => void };
type SearchEntry = SearchLabel & { page: Page; settingsTab?: SettingsTab; focusId?: string };

const pageEntries: SearchEntry[] = [
  ...navItems.map(({ id, icon }) => ({
    id: `page.${id}`,
    page: id,
    titleKey: `nav.${id}`,
    sectionKey: 'nav.workspace',
    icon,
  })),
  {
    id: 'page.settings',
    page: 'settings',
    titleKey: 'nav.settings',
    sectionKey: 'nav.system',
    icon: Settings2,
  },
  {
    id: 'page.backups',
    page: 'backups',
    titleKey: 'nav.backups',
    sectionKey: 'nav.system',
    icon: Copy,
  },
];

const settingsTabs: SearchEntry[] = [
  {
    id: 'settings.general',
    page: 'settings',
    settingsTab: 'general',
    focusId: 'settings-tab-general',
    titleKey: 'settings.navGeneral',
    sectionKey: 'nav.settings',
    icon: SlidersHorizontal,
  },
  {
    id: 'settings.updates',
    page: 'settings',
    settingsTab: 'updates',
    focusId: 'settings-tab-updates',
    titleKey: 'settings.navUpdates',
    sectionKey: 'nav.settings',
    icon: RefreshCw,
  },
  {
    id: 'settings.interface',
    page: 'settings',
    settingsTab: 'interface',
    focusId: 'settings-tab-interface',
    titleKey: 'settings.navInterface',
    sectionKey: 'nav.settings',
    icon: Settings2,
  },
];

const settingOptions: (SearchLabel & { settingsTab: SettingsTab })[] = [
  {
    id: 'settings.connection',
    settingsTab: 'general',
    titleKey: 'settings.connectionTitle',
    keywordsKey: 'nav.openSettings',
    sectionKey: 'nav.settings',
    icon: Globe2,
  },
  {
    id: 'settings.autostart',
    settingsTab: 'general',
    titleKey: 'settings.autostartTitle',
    sectionKey: 'nav.settings',
    icon: Power,
  },
  {
    id: 'settings.panelAutostart',
    settingsTab: 'general',
    titleKey: 'settings.panelAutostartTitle',
    sectionKey: 'nav.settings',
    icon: Power,
  },
  {
    id: 'settings.projectAutostart',
    settingsTab: 'general',
    titleKey: 'settings.projectAutostartTitle',
    sectionKey: 'nav.settings',
    icon: Power,
  },
  {
    id: 'settings.closeToTray',
    settingsTab: 'general',
    titleKey: 'settings.closeToTrayTitle',
    sectionKey: 'nav.settings',
    icon: Inbox,
  },
  {
    id: 'settings.notifications',
    settingsTab: 'general',
    titleKey: 'settings.notificationsTitle',
    sectionKey: 'nav.settings',
    icon: Activity,
  },
  {
    id: 'settings.appUpdatesStartup',
    settingsTab: 'updates',
    titleKey: 'appUpdates.startup',
    sectionKey: 'nav.settings',
    icon: RefreshCw,
  },
  {
    id: 'settings.moduleUpdatesStartup',
    settingsTab: 'updates',
    titleKey: 'settings.checkModuleUpdates',
    sectionKey: 'nav.settings',
    icon: RefreshCw,
  },
  {
    id: 'settings.updateSources',
    settingsTab: 'updates',
    titleKey: 'settings.sourcesTitle',
    sectionKey: 'nav.settings',
    icon: RefreshCw,
  },
  {
    id: 'settings.theme',
    settingsTab: 'interface',
    titleKey: 'settings.themeTitle',
    sectionKey: 'nav.settings',
    icon: Moon,
  },
  {
    id: 'settings.palette',
    settingsTab: 'interface',
    titleKey: 'settings.paletteTitle',
    sectionKey: 'nav.settings',
    icon: Sun,
  },
  {
    id: 'settings.accent',
    settingsTab: 'interface',
    titleKey: 'settings.accentTitle',
    sectionKey: 'nav.settings',
    icon: Sun,
  },
  {
    id: 'settings.language',
    settingsTab: 'interface',
    titleKey: 'settings.languageTitle',
    sectionKey: 'nav.settings',
    icon: Globe2,
  },
  {
    id: 'settings.font',
    settingsTab: 'interface',
    titleKey: 'settings.fontTitle',
    sectionKey: 'nav.settings',
    icon: Code2,
  },
  {
    id: 'settings.scale',
    settingsTab: 'interface',
    titleKey: 'settings.sizeTitle',
    sectionKey: 'nav.settings',
    icon: Gauge,
  },
];

const settingsEntries: SearchEntry[] = [
  ...settingsTabs,
  ...settingOptions.map((option) => ({ ...option, page: 'settings' as const, focusId: option.titleKey })),
];

const noActions: SearchAction[] = [];
const normalize = (value: string) => value.trim().toLowerCase().replace(/ё/g, 'е');

export function QuickSearch({
  open,
  onClose,
  onNavigate,
  actions = noActions,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: Page, tab?: SettingsTab, focusId?: string) => void;
  actions?: SearchAction[];
}) {
  const { t } = useI18n();
  const { open: openAppUpdates } = useAppUpdates();
  const { check: checkModuleUpdates } = useModuleUpdates();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const updateActions: SearchAction[] = [
      {
        id: 'action.appUpdates',
        titleKey: 'appUpdates.check',
        sectionKey: 'nav.system',
        icon: RefreshCw,
        run: openAppUpdates,
      },
      {
        id: 'action.moduleUpdates',
        titleKey: 'updates.title',
        keywordsKey: 'updates.check',
        sectionKey: 'nav.services',
        icon: RefreshCw,
        run: () => {
          onNavigate('services', undefined, 'updates.title');
          void checkModuleUpdates();
        },
      },
    ];
    const normalized = normalize(query);
    const allActions = [...actions, ...updateActions];
    const catalog = [
      ...pageEntries.flatMap((page) => [
        page,
        ...allActions.filter((action) => action.sectionKey === page.titleKey),
      ]),
      ...settingsEntries,
      ...allActions.filter((action) => !pageEntries.some((page) => page.titleKey === action.sectionKey)),
    ];
    const all = catalog.map((entry) => ({
      entry,
      title: t(entry.titleKey),
      section: t(entry.sectionKey),
    }));

    if (!normalized) return all;

    const terms = normalized.split(/\s+/);
    return all
      .flatMap((result) => {
        const title = normalize(result.title);
        const keywords = result.entry.keywordsKey ? normalize(t(result.entry.keywordsKey)) : '';
        const names = `${title} ${keywords}`;
        const searchable = `${names} ${normalize(result.section)}`;
        if (!terms.every((term) => searchable.includes(term))) return [];
        const rank = title === normalized ? 0 : terms.every((term) => names.includes(term)) ? 1 : 2;
        return [{ ...result, rank }];
      })
      .sort((a, b) => a.rank - b.rank);
  }, [actions, checkModuleUpdates, onNavigate, openAppUpdates, query, t]);

  const select = useCallback(
    (entry: SearchAction | SearchEntry) => {
      onClose();
      if ('run' in entry) entry.run();
      else onNavigate(entry.page, entry.settingsTab, entry.focusId);
    },
    [onClose, onNavigate],
  );

  useEffect(() => {
    if (!open) return;

    setQuery('');
    setActive(0);

    // Focus after mounting — otherwise the browser returns it to the previous element.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
      }

      const otherButton =
        event.target instanceof HTMLButtonElement && !listRef.current?.contains(event.target);
      if (event.key === 'Enter' && !otherButton && !event.isComposing) {
        event.preventDefault();
        const hit = results[active];

        if (hit) select(hit.entry);
      }
    };

    document.addEventListener('keydown', handleKey);

    return () => document.removeEventListener('keydown', handleKey);
  }, [open, results, active, select]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useDismiss(dialogRef, onClose, open);

  if (!open) return null;

  return (
    <DialogOverlay className="modal-overlay quick-search-overlay">
      <DialogPanel
        className="quick-search"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.open')}
        ref={dialogRef}
      >
        <div className="quick-search-field">
          <Search size={17} />
          <Input
            embedded
            ref={inputRef}
            className="quick-search-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              if (listRef.current) listRef.current.scrollTop = 0;
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.open')}
          />
          <Button
            variant="ghost"
            square
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={15} />
          </Button>
        </div>
        <div className="quick-search-list" ref={listRef}>
          {results.map(({ entry, title, section }, index) => {
            const Icon = entry.icon;
            return (
              <Button
                layout="row"
                selected={Boolean(index === active)}
                variant="ghost"
                type="button"
                key={entry.id}
                className={`quick-search-item ${index === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => select(entry)}
              >
                <span className="quick-search-icon">
                  <Icon size={15} />
                </span>
                <span className="quick-search-title">{title}</span>
                <span className="quick-search-section">{section}</span>
              </Button>
            );
          })}
          {results.length === 0 && <EmptyState className="empty-note">{t('search.empty')}</EmptyState>}
        </div>
        <div className="quick-search-hint">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> {t('search.navigate')}
          </span>
          <span>
            <kbd>Enter</kbd> {t('search.go')}
          </span>
          <span>
            <kbd>Esc</kbd> {t('common.close')}
          </span>
        </div>
      </DialogPanel>
    </DialogOverlay>
  );
}
