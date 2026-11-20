import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { Fragment, type KeyboardEvent, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { type MenuEntry, type MenuTrigger, useDismiss } from '../shared';
import { Button, MenuItem, MenuSurface } from '../ui';

export function RowMenu({
  entries,
  trigger,
  onOpen,
  align = 'end',
  topLayer = false,
}: {
  entries: MenuEntry[];
  trigger?: MenuTrigger;
  onOpen?: () => void;
  // Horizontal anchor of the popover: "end" right-aligns it to the button (toolbar
  // menus), "start" opens it from the left edge (full-width form field triggers).
  align?: 'start' | 'end';
  topLayer?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    minWidth: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const toggle = () => {
    if (open) {
      closeMenu();
      return;
    }

    setPos(null);
    // Sections in the fresh menu are always collapsed, even when it is reopened.
    setExpanded(null);
    setOpen(true);
    onOpen?.();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Entries and expansion change the measured popup size.
  useLayoutEffect(() => {
    if (!open) return;
    // Menus inside scrolling dialogs must escape their ancestors' clipping and positioning.
    if (topLayer) popRef.current?.showPopover?.();
    const place = () => {
      const anchor = ref.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const rect = anchor.getBoundingClientRect();
      // Browser previews use CSS zoom; fixed offsets must use the same coordinate space.
      const zoom = anchor.offsetWidth ? rect.width / anchor.offsetWidth : 1;
      const maxWidth = Math.max(0, Math.min(240, (window.innerWidth - 16) / zoom));
      const minWidth = Math.min(192, maxWidth);
      const maxHeight = Math.max(0, Math.min(440, (window.innerHeight - 16) / zoom));
      const width = Math.max(minWidth, Math.min(pop.offsetWidth, maxWidth)) * zoom;
      const height = Math.min(pop.scrollHeight + pop.offsetHeight - pop.clientHeight, maxHeight) * zoom;
      const below = rect.bottom + 6;
      const top = below + height <= window.innerHeight - 8 ? below : rect.top - height - 6;
      setPos({
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) / zoom,
        left:
          Math.max(
            8,
            Math.min(align === 'start' ? rect.left : rect.right - width, window.innerWidth - width - 8),
          ) / zoom,
        minWidth,
        maxWidth,
        maxHeight,
      });
    };
    place();
    window.addEventListener('resize', place);
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !popRef.current?.contains(event.target)) place();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, expanded, entries, align, topLayer]);

  useDismiss(ref, closeMenu, open);
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Escape') return;
    event.stopPropagation();
    ref.current?.querySelector('button')?.focus();
    closeMenu();
  };

  return (
    <div className="row-menu" ref={ref}>
      {trigger ? (
        trigger({ onToggle: toggle, open })
      ) : (
        <Button
          selected={Boolean(open)}
          variant="ghost"
          square
          type="button"
          className={`icon-button ${open ? 'active' : ''}`}
          onClick={toggle}
          onKeyDown={topLayer ? closeOnEscape : undefined}
          aria-label={t('common.actions')}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <MoreHorizontal size={17} />
        </Button>
      )}
      {open && (
        <MenuSurface
          className="menu-popover"
          role="menu"
          popover={topLayer ? 'manual' : undefined}
          ref={popRef}
          onKeyDown={topLayer ? closeOnEscape : undefined}
          style={{ ...pos, visibility: pos ? 'visible' : 'hidden' }}
        >
          {entries.map((entry) => {
            const Icon = entry.icon;
            // An entry with children is an expandable section with nested items.
            if (entry.children) {
              const isOpen = expanded === entry.label;

              return (
                <div key={entry.label} className="menu-group">
                  <MenuItem
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : entry.label)}
                  >
                    {Icon && <Icon size={14} />}
                    {entry.labelContent ?? entry.label}
                    <span className={`menu-chevron ${isOpen ? 'open' : ''}`}>
                      <ChevronRight size={13} />
                    </span>
                  </MenuItem>
                  {isOpen &&
                    entry.children.map((child) => (
                      <MenuItem
                        type="button"
                        key={child.label}
                        className="menu-item submenu-item"
                        role="menuitem"
                        onClick={() => {
                          setOpen(false);
                          setExpanded(null);
                          child.onSelect();
                        }}
                      >
                        {child.label}
                      </MenuItem>
                    ))}
                </div>
              );
            }

            return (
              <Fragment key={entry.label}>
                {entry.separatorBefore && <hr className="row-menu-separator" />}
                <MenuItem
                  type="button"
                  className={`menu-item ${entry.danger ? 'danger' : ''}`}
                  role="menuitem"
                  disabled={entry.disabled}
                  onClick={() => {
                    if (entry.disabled) return;
                    setOpen(false);
                    entry.onSelect?.();
                  }}
                >
                  {Icon && <Icon size={14} />}
                  {entry.labelContent ?? entry.label}
                </MenuItem>
              </Fragment>
            );
          })}
        </MenuSurface>
      )}
    </div>
  );
}
