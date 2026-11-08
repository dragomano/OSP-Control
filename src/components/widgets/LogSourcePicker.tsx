import { Check, ChevronDown, Globe2, Search, Terminal } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { LogSource } from '../../ospanel';
import { useDismiss } from '../shared';
import './logSourcePicker.css';

export function LogSourcePicker({
  sources,
  value,
  disabled = false,
  onChange,
}: {
  sources: LogSource[];
  value: string;
  disabled?: boolean;
  onChange: (source: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
    width: number;
  } | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      sources
        .filter((source) => source.label.toLowerCase().startsWith(needle))
        .sort(
          (a, b) =>
            Number(b.domain) - Number(a.domain) ||
            a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
        ),
    [sources, needle],
  );
  const activeIndex = filtered.length
    ? Math.max(
        0,
        filtered.findIndex((source) => source.name === active),
      )
    : -1;
  const selected = sources.find((source) => source.name === value);
  const SourceIcon = selected?.domain ? Globe2 : Terminal;
  const positioned = position !== null;

  useDismiss(ref, close, open);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  useEffect(() => {
    // The popup is hidden until placement; WebView2 cannot focus a hidden input.
    if (open && positioned) inputRef.current?.focus();
  }, [open, positioned]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Filtering changes the measured popup height and its anchor position.
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const place = () => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;
      const rect = trigger.getBoundingClientRect();
      // Fixed coordinates need the same CSS zoom as the rest of the application.
      const zoom = trigger.offsetWidth ? rect.width / trigger.offsetWidth : 1;
      const width = Math.min(340, (window.innerWidth - 16) / zoom);
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const upwards = below < Math.min(popup.scrollHeight * zoom, 240) && above > below;
      const maxHeight = Math.max(0, Math.min(440, (upwards ? above : below) / zoom));
      const height = Math.min(popup.scrollHeight, maxHeight) * zoom;
      setPosition({
        top: (upwards ? rect.top - 6 - height : rect.bottom + 6) / zoom,
        left: Math.max(8, Math.min(rect.right - width * zoom, window.innerWidth - width * zoom - 8)) / zoom,
        maxHeight,
        width,
      });
    };
    place();
    window.addEventListener('resize', place);
    // Capture scrolls in the page as well as in the window; result scrolling keeps the anchor unchanged.
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !popupRef.current?.contains(event.target)) place();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, disabled, filtered]);
  useEffect(() => {
    if (open && positioned && filtered[activeIndex]) {
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, positioned, id, activeIndex, filtered]);

  const choose = (source: LogSource) => {
    if (disabled) return;
    onChange(source.name);
    close();
    triggerRef.current?.focus();
  };
  const show = () => {
    setQuery('');
    setActive(value);
    setPosition(null);
    setOpen(true);
  };

  return (
    <div className="log-source-picker" ref={ref}>
      <button
        type="button"
        className="filter-button log-source-trigger"
        ref={triggerRef}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show();
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        aria-controls={open && !disabled ? `${id}-popup` : undefined}
        title={selected?.label ?? value}
        disabled={disabled}
      >
        <SourceIcon size={15} />
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={14} />
      </button>
      {open && !disabled && (
        <div
          className="log-source-popover"
          role="dialog"
          aria-label={t('logs.chooseSource')}
          id={`${id}-popup`}
          ref={popupRef}
          style={position ?? { visibility: 'hidden' }}
          onBlur={(event) => {
            if (!ref.current?.contains(event.relatedTarget as Node | null)) close();
          }}
        >
          <div className="log-source-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-label={t('logs.sourceSearchPlaceholder')}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
              placeholder={t('logs.sourceSearchPlaceholder')}
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(event.target.value.trim() ? null : value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (filtered.length) {
                    const nextIndex =
                      (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) %
                      filtered.length;
                    setActive(filtered[nextIndex].name);
                  }
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (filtered[activeIndex]) choose(filtered[activeIndex]);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                  triggerRef.current?.focus();
                } else if (event.key === 'Tab') close();
              }}
            />
          </div>
          <div
            className="log-source-list"
            role="listbox"
            aria-label={t('logs.chooseSource')}
            id={`${id}-list`}
          >
            {[true, false].map((domain) => {
              const group = filtered.filter((source) => source.domain === domain);
              if (!group.length) return null;
              const groupId = `${id}-${domain ? 'domains' : 'system'}`;
              const Icon = domain ? Globe2 : Terminal;
              return (
                <fieldset className="log-source-section" aria-labelledby={groupId} key={groupId}>
                  <legend className="log-source-group">
                    <span id={groupId}>{t(domain ? 'logs.sourceDomains' : 'logs.sourceSystem')}</span>
                    <span>{group.length}</span>
                  </legend>
                  {group.map((source) => {
                    const index = filtered.indexOf(source);
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={source.name === value}
                        id={`${id}-option-${index}`}
                        key={source.name}
                        className={`log-source-option ${index === activeIndex ? 'active' : ''}`}
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(source)}
                      >
                        <Icon size={14} aria-hidden="true" />
                        <span className="log-source-name">
                          {needle ? <mark>{source.label.slice(0, needle.length)}</mark> : null}
                          {source.label.slice(needle.length)}
                        </span>
                        {source.name === value && <Check size={14} aria-hidden="true" />}
                      </button>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
          {filtered.length === 0 && <div className="log-source-empty">{t('logs.sourceEmpty')}</div>}
          <div className="log-source-count" role="status">
            {t('logs.sourceCount', { count: filtered.length })}
          </div>
        </div>
      )}
    </div>
  );
}
