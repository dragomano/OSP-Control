import { type Activity, Check, ChevronRight } from 'lucide-react';
import { RowMenu } from './RowMenu';

// A single-choice dropdown in the toolbar style: the trigger shows the current
// selection, and a check mark marks the active item in the list.
export function MenuSelect<T extends string>({
  icon: Icon,
  label,
  ariaLabel,
  value,
  options,
  onChange,
  align = 'end',
  disabled = false,
}: {
  icon?: typeof Activity;
  // Button text; falls back to the label of the selected option.
  label?: string;
  // Accessible name of the control; the visible text is the selection itself.
  ariaLabel?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  // "start" opens the menu from the left edge — for full-width form field triggers.
  align?: 'start' | 'end';
  disabled?: boolean;
}) {
  const current = options.find((option) => option.value === value);

  return (
    <RowMenu
      align={align}
      trigger={({ onToggle, open }) => (
        <button
          type="button"
          className="filter-button"
          disabled={disabled}
          onClick={onToggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
        >
          {Icon && <Icon size={15} />}
          {/* The span can shrink with an ellipsis when the option text is long. */}
          <span className="menu-select-label">{label ?? current?.label ?? value}</span>
          <ChevronRight size={14} />
        </button>
      )}
      entries={options.map((option) => ({
        label: option.label,
        icon: option.value === value ? Check : undefined,
        onSelect: () => onChange(option.value),
      }))}
    />
  );
}
