import type { Activity } from 'lucide-react';
import { isEngineUnset } from '../../ospanel';
import { MenuSelect } from './MenuSelect';

// A single-choice filter menu: the button shows the facet name while the filter is
// inactive and the current selection otherwise, with a check mark on the active item.
export function FilterFacet<T extends string>({
  icon,
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
    <MenuSelect<T | 'all'>
      icon={icon}
      label={active ? (current?.label ?? label) : label}
      ariaLabel={label}
      value={value}
      options={[{ value: 'all', label: allLabel }, ...options]}
      onChange={onChange}
    />
  );
}

// Values for the filter menu: an unset engine (the panel reports "-") goes last.
export function facetValues(values: string[], compare: (a: string, b: string) => number): string[] {
  const unique = Array.from(new Set(values.filter(Boolean)));

  return [...unique.filter((value) => !isEngineUnset(value)).sort(compare), ...unique.filter(isEngineUnset)];
}
