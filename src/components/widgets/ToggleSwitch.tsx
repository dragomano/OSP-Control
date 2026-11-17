import { Toggle } from '../ui';
// Settings switch behavior is shared by both visual themes through the UI primitive.
export function ToggleSwitch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Toggle
      checked={checked}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`large-toggle ${checked ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </Toggle>
  );
}
