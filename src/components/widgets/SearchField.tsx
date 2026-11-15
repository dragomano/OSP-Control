import { Search, X } from 'lucide-react';
import type { Ref } from 'react';
import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { useI18n } from '../../i18n';

type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  iconSize?: number;
  className?: string;
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  children?: ReactNode;
};

export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  title,
  iconSize = 15,
  className = 'search-field',
  inputClassName,
  inputRef,
  onKeyDown,
  children,
}: SearchFieldProps) {
  const { t } = useI18n();
  const fallbackRef = useRef<HTMLInputElement | null>(null);
  const resolveInput = () => {
    if (typeof inputRef === 'function') {
      return null;
    }
    return inputRef?.current ?? fallbackRef.current;
  };

  return (
    <div className={className}>
      <Search size={iconSize} aria-hidden="true" />
      <input
        ref={(node) => {
          fallbackRef.current = node;
          if (typeof inputRef === 'function') {
            inputRef(node);
          } else if (inputRef) {
            inputRef.current = node;
          }
        }}
        className={inputClassName}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        title={title}
        spellCheck={false}
        autoComplete="off"
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label={t('common.clearSearch')}
          onClick={() => {
            onChange('');
            resolveInput()?.focus();
          }}
        >
          <X size={Math.max(12, iconSize - 2)} />
        </button>
      ) : null}
      {children}
    </div>
  );
}
