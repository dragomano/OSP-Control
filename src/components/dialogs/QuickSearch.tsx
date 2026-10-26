import {
  Activity,
  Code2,
  Copy,
  FileCode2,
  FolderOpen,
  Gauge,
  Globe2,
  LayoutDashboard,
  ListTree,
  Moon,
  Power,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { type Page, type SettingsTab, useDismiss } from '../shared';

// Catalog of the global search: pages and settings options from different sections.
// Dictionary keys are known up front — titles are taken via t() at render time, so the locale applies on the fly.
type SearchEntry = {
  id: string;
  page: Page;
  settingsTab?: SettingsTab;
  titleKey: string;
  sectionKey: string;
  icon: typeof Activity;
};

const searchEntries: SearchEntry[] = [
  {
    id: 'page.overview',
    page: 'overview',
    titleKey: 'nav.overview',
    sectionKey: 'nav.workspace',
    icon: LayoutDashboard,
  },
  {
    id: 'page.services',
    page: 'services',
    titleKey: 'nav.services',
    sectionKey: 'nav.workspace',
    icon: SlidersHorizontal,
  },
  {
    id: 'page.projects',
    page: 'projects',
    titleKey: 'nav.projects',
    sectionKey: 'nav.workspace',
    icon: FolderOpen,
  },
  {
    id: 'page.configs',
    page: 'configs',
    titleKey: 'nav.configs',
    sectionKey: 'nav.workspace',
    icon: FileCode2,
  },
  { id: 'page.logs', page: 'logs', titleKey: 'nav.logs', sectionKey: 'nav.workspace', icon: Terminal },
  { id: 'page.menu', page: 'menu', titleKey: 'nav.menu', sectionKey: 'nav.workspace', icon: ListTree },
  {
    id: 'page.settings',
    page: 'settings',
    titleKey: 'nav.settings',
    sectionKey: 'nav.system',
    icon: Settings2,
  },
  {
    id: 'settings.connection',
    page: 'settings',
    settingsTab: 'connection',
    titleKey: 'settings.connectionTitle',
    sectionKey: 'nav.settings',
    icon: Globe2,
  },
  {
    id: 'settings.autostart',
    page: 'settings',
    settingsTab: 'autostart',
    titleKey: 'settings.autostartTitle',
    sectionKey: 'nav.settings',
    icon: Power,
  },
  {
    id: 'settings.notifications',
    page: 'settings',
    settingsTab: 'autostart',
    titleKey: 'settings.notificationsTitle',
    sectionKey: 'nav.settings',
    icon: Activity,
  },
  {
    id: 'settings.theme',
    page: 'settings',
    settingsTab: 'appearance',
    titleKey: 'settings.themeTitle',
    sectionKey: 'nav.settings',
    icon: Moon,
  },
  {
    id: 'settings.accent',
    page: 'settings',
    settingsTab: 'appearance',
    titleKey: 'settings.accentTitle',
    sectionKey: 'nav.settings',
    icon: Sun,
  },
  {
    id: 'settings.language',
    page: 'settings',
    settingsTab: 'appearance',
    titleKey: 'settings.languageTitle',
    sectionKey: 'nav.settings',
    icon: Globe2,
  },
  {
    id: 'settings.font',
    page: 'settings',
    settingsTab: 'appearance',
    titleKey: 'settings.fontTitle',
    sectionKey: 'nav.settings',
    icon: Code2,
  },
  {
    id: 'settings.scale',
    page: 'settings',
    settingsTab: 'appearance',
    titleKey: 'settings.sizeTitle',
    sectionKey: 'nav.settings',
    icon: Gauge,
  },
  {
    id: 'page.backups',
    page: 'backups',
    titleKey: 'nav.backups',
    sectionKey: 'nav.system',
    icon: Copy,
  },
];

export function QuickSearch({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: Page, tab?: SettingsTab) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase().replace(/ё/g, 'е');
    const all = searchEntries.map((entry) => ({
      entry,
      title: t(entry.titleKey),
      section: t(entry.sectionKey),
    }));

    if (!normalized) return all;

    return all.filter(({ title, section }) =>
      `${title} ${section}`.toLowerCase().replace(/ё/g, 'е').includes(normalized),
    );
  }, [query, t]);

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
        setActive((index) => Math.min(index + 1, results.length - 1));
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const hit = results[active];

        if (hit) onNavigate(hit.entry.page, hit.entry.settingsTab);
      }
    };

    document.addEventListener('keydown', handleKey);

    return () => document.removeEventListener('keydown', handleKey);
  }, [open, results, active, onNavigate]);

  // Scroll to the active item on arrow-key navigation.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useDismiss(dialogRef, onClose, open);

  if (!open) return null;

  return (
    <div className="modal-overlay quick-search-overlay">
      <div
        className="quick-search"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.open')}
        ref={dialogRef}
      >
        <div className="quick-search-field">
          <Search size={17} />
          <input
            ref={inputRef}
            className="quick-search-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.open')}
          />
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
            <X size={15} />
          </button>
        </div>
        <div className="quick-search-list" ref={listRef}>
          {results.map(({ entry, title, section }, index) => {
            const Icon = entry.icon;
            return (
              <button
                type="button"
                key={entry.id}
                className={`quick-search-item ${index === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => onNavigate(entry.page, entry.settingsTab)}
              >
                <span className="quick-search-icon">
                  <Icon size={15} />
                </span>
                <span className="quick-search-title">{title}</span>
                <span className="quick-search-section">{section}</span>
              </button>
            );
          })}
          {results.length === 0 && <div className="empty-note">{t('search.empty')}</div>}
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
      </div>
    </div>
  );
}
