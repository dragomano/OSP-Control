import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { type MenuEntry, type MenuTrigger, useDismiss } from '../shared';

export function RowMenu({ entries, trigger }: { entries: MenuEntry[]; trigger?: MenuTrigger }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const toggle = () => {
    if (open) {
      closeMenu();
      return;
    }

    const rect = ref.current?.getBoundingClientRect();

    if (rect) setPos({ top: rect.bottom + 6, left: Math.max(8, rect.right - 192) });

    // Sections in the fresh menu are always collapsed, even when it is reopened.
    setExpanded(null);
    setOpen(true);
  };

  // The menu opens downward from the button; when it does not fit the window (a row at the
  // bottom edge) or sticks out to the right, the position is corrected from the popup's actual size.
  useEffect(() => {
    if (!open || !pos) return;
    const pop = popRef.current;
    if (!pop) return;
    const { offsetHeight: height, offsetWidth: width } = pop;
    const nextTop =
      pos.top + height > window.innerHeight - 8
        ? Math.max(8, (ref.current?.getBoundingClientRect().top ?? 8) - height - 6)
        : pos.top;
    const nextLeft = Math.max(8, Math.min(pos.left, window.innerWidth - width - 8));
    if (nextTop !== pos.top || nextLeft !== pos.left) setPos({ top: nextTop, left: nextLeft });
  }, [open, pos]);

  useDismiss(ref, closeMenu, open);

  return (
    <div className="row-menu" ref={ref}>
      {trigger ? (
        trigger({ onToggle: toggle, open })
      ) : (
        <button
          type="button"
          className={`icon-button ${open ? 'active' : ''}`}
          onClick={toggle}
          aria-label={t('common.actions')}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <MoreHorizontal size={17} />
        </button>
      )}
      {open && pos && (
        <div className="menu-popover" role="menu" ref={popRef} style={{ top: pos.top, left: pos.left }}>
          {entries.map((entry) => {
            const Icon = entry.icon;
            // An entry with children is an expandable section with nested items.
            if (entry.children) {
              const isOpen = expanded === entry.label;

              return (
                <div key={entry.label} className="menu-group">
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : entry.label)}
                  >
                    {Icon && <Icon size={14} />}
                    {entry.label}
                    <span className={`menu-chevron ${isOpen ? 'open' : ''}`}>
                      <ChevronRight size={13} />
                    </span>
                  </button>
                  {isOpen &&
                    entry.children.map((child) => (
                      <button
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
                      </button>
                    ))}
                </div>
              );
            }

            return (
              <button
                type="button"
                key={entry.label}
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
                {entry.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
