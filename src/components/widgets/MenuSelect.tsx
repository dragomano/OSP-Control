import type { Activity } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Select } from '../ui';

// Toolbar callers use the same native choice control as form fields.
export function MenuSelect<T extends string>({
  icon: Icon,
  label,
  ariaLabel,
  name,
  id,
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
  // Stable form attributes: aria-label alone does not satisfy Chromium's autofill hint.
  name?: string;
  id?: string;
  value: T;
  // Per-option style lets a choice render its own preview, e.g. an interface font.
  options: { value: T; label: string; style?: CSSProperties }[];
  onChange: (value: T) => void;
  // Retained for existing callers; the native picker chooses placement within the viewport.
  align?: 'start' | 'end';
  disabled?: boolean;
}) {
  const current = options.find((option) => option.value === value);

  return (
    <Select
      className="filter-button"
      name={name}
      id={id}
      disabled={disabled}
      aria-label={ariaLabel ?? label ?? current?.label ?? value}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      displayLabel={label ?? current?.label ?? value}
      displayLabelStyle={label ? undefined : current?.style}
      leadingIcon={Icon && <Icon size={15} />}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} style={option.style}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
