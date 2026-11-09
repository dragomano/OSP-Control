import { useMemo, useRef } from 'react';
import { highlightConfig } from '../../highlight';
import './configEditor.css';

export function ConfigEditor({
  file,
  value,
  label,
  disabled,
  onChange,
}: {
  file: string;
  value: string;
  label: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const code = useRef<HTMLPreElement>(null);
  const highlighted = useMemo(() => highlightConfig(file, value), [file, value]);
  return (
    <div className="project-code-editor">
      <pre ref={code} aria-hidden="true">
        <code
          className="hljs"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightConfig escapes all source text before inserting token spans
          dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }}
        />
      </pre>
      <textarea
        aria-label={label}
        value={value}
        disabled={disabled}
        spellCheck={false}
        wrap="off"
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (code.current) {
            code.current.scrollTop = event.currentTarget.scrollTop;
            code.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
      />
    </div>
  );
}
