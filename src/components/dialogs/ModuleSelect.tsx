import { MenuSelect } from '../widgets/MenuSelect';

// Text of the built-in "default" option: the global engine from the panel's own
// Settings → Projects is appended in parentheses. global === null means the value
// could not be read — the parentheses are omitted; '' means not set globally.
export function defaultEngineLabel(autoLabel: string, notSetLabel: string, global: string | null): string {
  return global === null ? autoLabel : `${autoLabel} (${global || notSetLabel})`;
}

export function ModuleSelect({
  label,
  value,
  options,
  autoLabel,
  globalHint,
  noneLabel,
  includeAuto = true,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  autoLabel: string;
  // Hint about the global engine value (built in the dialog; clearer —
  // "Currently global: …" or "Not set globally"). null — do not show.
  globalHint: string | null;
  noneLabel?: string;
  includeAuto?: boolean;
  onChange: (value: string) => void;
}) {
  // Not a <label>: the trigger button carries its own accessible name via aria-label.
  return (
    <div className="module-select">
      <span>{label}</span>
      <MenuSelect
        align="start"
        ariaLabel={label}
        value={value}
        options={[
          ...(includeAuto ? [{ value: 'auto', label: autoLabel }] : []),
          ...(noneLabel ? [{ value: '', label: noneLabel }] : []),
          ...options
            .filter((option) => option !== 'auto' && option !== '')
            .map((option) => ({ value: option, label: option })),
        ]}
        onChange={onChange}
      />
      {globalHint && <span className="select-hint">{globalHint}</span>}
    </div>
  );
}
