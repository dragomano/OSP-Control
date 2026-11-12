import { type RefObject, useEffect, useRef, useState } from 'react';
import { useDismiss } from '../shared';

// A text input with an app-styled suggestion list in place of the native datalist:
// the list opens on focus and typing, narrows the candidates by substring, supports
// keyboard navigation, and a picked suggestion fills the input.
export function SuggestInput({
  value,
  onValueChange,
  suggestions,
  ariaLabel,
  placeholder,
  maxLength,
  autoFocus = false,
  inputRef,
}: {
  value: string;
  // Reports every keystroke; the value stays controlled by the caller.
  onValueChange: (value: string) => void;
  // Full candidate list; the widget itself narrows it by the typed text.
  suggestions: string[];
  ariaLabel: string;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  // Lets the caller focus the field (e.g. after a form submit).
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const anchorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ top: number; left: number; width: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  // Set right before the programmatic refocus in accept(): that focus event must not
  // immediately reopen the list the user has just picked from.
  const suppressOpenRef = useRef(false);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, ref]);
  useDismiss(anchorRef, () => setOpen(false), open);

  const query = value.trim().toLowerCase();
  const matches = query === '' ? suggestions : suggestions.filter((tag) => tag.toLowerCase().includes(query));
  const hasMatches = matches.length > 0;

  const openList = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPop({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setHighlight(-1);
    setOpen(true);
  };

  // When the list does not fit under the input, it opens upward from its actual size.
  useEffect(() => {
    if (!open || !pop) return;
    const list = listRef.current;
    if (!list) return;
    const { offsetHeight: height } = list;
    const nextTop =
      pop.top + height > window.innerHeight - 8
        ? Math.max(8, (anchorRef.current?.getBoundingClientRect().top ?? 8) - height - 4)
        : pop.top;
    if (nextTop !== pop.top) setPop({ ...pop, top: nextTop });
  }, [open, pop]);

  // Keep the keyboard-highlighted item visible in the scrollable list.
  useEffect(() => {
    if (highlight < 0) return;
    listRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  // Hide the list whenever nothing matches the current text.
  useEffect(() => {
    if (open && !hasMatches) setOpen(false);
  }, [open, hasMatches]);

  const accept = (tag: string) => {
    onValueChange(tag);
    setOpen(false);
    setHighlight(-1);
    suppressOpenRef.current = true;
    ref.current?.focus();
  };

  return (
    <div className="project-tag-suggest" ref={anchorRef}>
      <input
        ref={ref}
        className="project-tag-input"
        value={value}
        onChange={(event) => {
          setHighlight(-1);
          onValueChange(event.target.value);
        }}
        onFocus={() => {
          if (suppressOpenRef.current) {
            suppressOpenRef.current = false;
            return;
          }
          if (hasMatches) openList();
        }}
        onKeyDown={(event) => {
          if (!open || !hasMatches) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlight((current) => {
              const next =
                current < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : matches.length - 1
                  : current + (event.key === 'ArrowDown' ? 1 : -1);
              return Math.max(0, Math.min(matches.length - 1, next));
            });
          } else if (event.key === 'Enter' && highlight >= 0) {
            // Accept the highlighted suggestion instead of submitting the surrounding form.
            event.preventDefault();
            accept(matches[highlight]);
          } else if (event.key === 'Escape') {
            // Escape closes the list first; outer Escape handlers (e.g. a dialog) only
            // fire when the list is already hidden.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setHighlight(-1);
          }
        }}
        maxLength={maxLength}
        aria-label={ariaLabel}
        placeholder={placeholder}
      />
      {open && hasMatches && pop && (
        <div
          className="menu-popover project-tag-suggest-popover"
          role="menu"
          ref={listRef}
          style={{ top: pop.top, left: pop.left, width: pop.width }}
        >
          {matches.map((tag, index) => (
            <button
              type="button"
              className={`menu-item${index === highlight ? ' active' : ''}`}
              role="menuitem"
              key={tag}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => accept(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
