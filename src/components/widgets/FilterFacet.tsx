import { type Activity, Check, ChevronRight } from 'lucide-react';
import { isEngineUnset } from '../../ospanel';
import { RowMenu } from './RowMenu';

// A single-choice filter menu: the button shows the current selection,
// and a check mark marks the active item in the list.
export function FilterFacet<T extends string>({
  icon: Icon,
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  icon: typeof Activity;
  label: string;
  allLabel: string;
  value: T;
  options: { value: T; label: string }[];
  // The built-in "all" entry clears the filter, so the callback must accept it too.
  onChange: (value: T | 'all') => void;
}) {
  const active = value !== 'all';
  const current = options.find((option) => option.value === value);

  return (
    <RowMenu
      trigger={({ onToggle, open }) => (
        <button
          type="button"
          className={`filter-button ${active ? 'active' : ''}`}
          onClick={onToggle}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Icon size={15} />
          {active ? (current?.label ?? label) : label}
          <ChevronRight size={14} />
        </button>
      )}
      entries={[
        { label: allLabel, icon: active ? undefined : Check, onSelect: () => onChange('all') },
        ...options.map((option) => ({
          label: option.label,
          icon: option.value === value ? Check : undefined,
          onSelect: () => onChange(option.value),
        })),
      ]}
    />
  );
}

// Values for the filter menu: an unset engine (the panel reports "-") goes last.
export function facetValues(values: string[], compare: (a: string, b: string) => number): string[] {
  const unique = Array.from(new Set(values.filter(Boolean)));

  return [...unique.filter((value) => !isEngineUnset(value)).sort(compare), ...unique.filter(isEngineUnset)];
}
