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
  return (
    <label className="module-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {[
          ...(includeAuto ? ['auto'] : []),
          ...(noneLabel ? [''] : []),
          ...options.filter((option) => option !== 'auto' && option !== ''),
        ].map((option) => (
          <option key={option} value={option}>
            {option === 'auto' ? autoLabel : option === '' ? noneLabel : option}
          </option>
        ))}
      </select>
      {globalHint && <span className="select-hint">{globalHint}</span>}
    </label>
  );
}
