import type { Activity } from 'lucide-react';
import { Select } from '../ui';

// Toolbar callers use the same native choice control as form fields.
export function MenuSelect<T extends string>({
  icon: Icon,
  label,
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
}: {
  icon?: typeof Activity;
  // Display text; falls back to the label of the selected option.
  label?: string;
  // Accessible name of the control; the visible text is the selection itself.
  ariaLabel?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  // Retained for existing callers; the native picker chooses placement within the viewport.
  align?: 'start' | 'end';
  disabled?: boolean;
}) {
  const current = options.find((option) => option.value === value);

  return (
    <Select
      className="filter-button"
      disabled={disabled}
      aria-label={ariaLabel ?? label ?? current?.label ?? value}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      displayLabel={label ?? current?.label ?? value}
      leadingIcon={Icon && <Icon size={15} />}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
