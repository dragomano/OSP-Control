export function ModuleSelect({
  label,
  value,
  options,
  autoLabel,
  globalHint,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  autoLabel: string;
  // Hint about the global engine value (built in the dialog; clearer —
  // "Currently global: …" or "Not set globally"). null — do not show.
  globalHint: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <label className="module-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {['auto', ...options.filter((option) => option !== 'auto')].map((option) => (
          <option key={option} value={option}>
            {option === 'auto' ? autoLabel : option}
          </option>
        ))}
      </select>
      {globalHint && <span className="select-hint">{globalHint}</span>}
    </label>
  );
}
