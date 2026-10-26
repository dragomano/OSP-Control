import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { MenuIcon, menuIcons } from '../../menuIcons';
import { useDismiss } from '../shared';

const PAGE_SIZE = 60;

export function MenuIconPicker({
  value,
  onSelect,
  onClose,
}: {
  value: string;
  onSelect: (icon: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [style, setStyle] = useState('all');
  const [page, setPage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useDismiss(ref, onClose);
  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return menuIcons.filter(
      (icon) =>
        (style === 'all' || icon.style === style) &&
        `${icon.value} ${icon.aliases.join(' ')} ${icon.terms}`.toLowerCase().includes(needle),
    );
  }, [query, style]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  return (
    <div className="modal-overlay">
      <div
        ref={ref}
        className="modal-window menu-icon-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('menu.iconsTitle')}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input');
          if (!elements?.length) return;
          const first = elements[0];
          const last = elements[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-head">
          <h2 className="modal-title">{t('menu.iconsTitle')}</h2>
          <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="search-field menu-icon-search">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            aria-label={t('menu.iconSearch')}
            placeholder={t('menu.iconSearch')}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="menu-icon-filters">
          {['all', 'solid', 'regular', 'brands'].map((filter) => (
            <button
              key={filter}
              type="button"
              className={`filter-button ${style === filter ? 'active' : ''}`}
              aria-pressed={style === filter}
              onClick={() => {
                setStyle(filter);
                setPage(0);
              }}
            >
              {t(`menu.icons.${filter}`)}
            </button>
          ))}
        </div>
        <div className="menu-icon-grid">
          {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((icon) => (
            <button
              type="button"
              key={icon.value}
              className={`menu-icon-tile ${value === icon.value ? 'selected' : ''}`}
              aria-pressed={value === icon.value}
              title={icon.value}
              aria-label={icon.value}
              onClick={() => onSelect(icon.value)}
            >
              <MenuIcon name={icon.value} />
              <span>{icon.value.replace(/^regular-/, '')}</span>
            </button>
          ))}
        </div>
        {filtered.length === 0 && <p className="empty-note">{t('common.empty')}</p>}
        <div className="modal-foot">
          <button type="button" className="text-button" onClick={() => onSelect('')}>
            {t('menu.noIcon')}
          </button>
          <span className="menu-muted" aria-live="polite">
            {t('menu.iconCount', { n: filtered.length })}
          </span>
          <div className="menu-pager">
            <button
              type="button"
              className="icon-button"
              disabled={page === 0}
              aria-label={t('menu.previousIcons')}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {page + 1} / {pages}
            </span>
            <button
              type="button"
              className="icon-button"
              disabled={page >= pages - 1}
              aria-label={t('menu.nextIcons')}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
