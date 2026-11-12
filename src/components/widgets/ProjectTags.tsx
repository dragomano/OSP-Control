import { ChevronDown, Palette, Plus, RotateCcw, Tags, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import {
  colorForTag,
  MAX_PROJECT_TAG_LENGTH,
  type ProjectTagColor,
  type ProjectTagColors,
  projectTagAppearance,
  type TagMatch,
} from '../../projectTags';
import { useDismiss } from '../shared';
import { MenuSelect } from './MenuSelect';
import { SuggestInput } from './SuggestInput';

export function ProjectSelection({
  checked,
  mixed = false,
  label,
  onChange,
  all = false,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  all?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="project-selection">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      {all && <span className="project-select-all-text">{label}</span>}
    </label>
  );
}

export function ProjectTagFilter({
  available,
  colors,
  selected,
  match,
  onSelect,
  onMatch,
}: {
  available: string[];
  colors: ProjectTagColors;
  selected: (string | null)[];
  match: TagMatch;
  onSelect: (selected: (string | null)[]) => void;
  onMatch: (match: TagMatch) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useDismiss(ref, () => setOpen(false), open);
  const options = [...new Set([...available, ...selected.filter((tag): tag is string => tag !== null)])];
  return (
    <div className="project-tags-filter" ref={ref}>
      <button
        type="button"
        className={`filter-button ${selected.length ? 'active' : ''}`}
        aria-label={t('projects.tagsFilter')}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Tags size={15} />
        {t('projects.tagsFilter')}
        {selected.length > 0 && <span>{selected.length}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <fieldset className="project-tags-filter-popup" id={id} aria-label={t('projects.tagsFilter')}>
          {[...options, null].map((tag) => (
            <label className="project-tags-filter-option" key={tag ?? '\u0000'}>
              <input
                type="checkbox"
                checked={selected.includes(tag)}
                onChange={(event) =>
                  onSelect(
                    event.target.checked ? [...selected, tag] : selected.filter((item) => item !== tag),
                  )
                }
              />
              <span
                className={
                  tag ? `project-tag-chip ${projectTagAppearance(colors, tag).className}` : undefined
                }
                style={tag ? projectTagAppearance(colors, tag).style : undefined}
              >
                {tag ?? t('projects.tagsWithout')}
              </span>
            </label>
          ))}
          <div className="project-tags-match">
            <span>{t('projects.tagsMatch')}</span>
            <MenuSelect<TagMatch>
              ariaLabel={t('projects.tagsMatch')}
              value={match}
              options={[
                { value: 'any', label: t('projects.tagsAny') },
                { value: 'all', label: t('projects.tagsAll') },
              ]}
              onChange={onMatch}
            />
          </div>
        </fieldset>
      )}
    </div>
  );
}

export function ProjectTagEditor({
  domain,
  tags,
  available,
  colors,
  onColorChange,
  onChange,
  onClose,
}: {
  domain: string;
  tags: string[];
  available: string[];
  colors: ProjectTagColors;
  onColorChange: (tag: string, color: ProjectTagColor | null) => void;
  onChange: (tag: string, action: 'add' | 'remove') => boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [colorFor, setColorFor] = useState<string | null>(null);
  const colorInput = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);

  // Catalog tags that are not on the project yet; SuggestInput narrows them by the typed text.
  const suggestions = available.filter((tag) => !tags.includes(tag));
  return (
    <section className="project-tag-editor" aria-label={t('projects.tagsEditFor', { domain })}>
      <div className="project-tag-editor-head">
        <b>{t('projects.tagsEditFor', { domain })}</b>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
          <X size={16} />
        </button>
      </div>
      <div className="project-tags-list">
        {tags.length ? (
          tags.map((tag) => (
            <div className="project-tag-edit-item" key={tag}>
              <button
                type="button"
                className={`project-tag-chip ${projectTagAppearance(colors, tag).className}`}
                style={projectTagAppearance(colors, tag).style}
                aria-label={t('projects.tagsColorFor', { tag })}
                aria-expanded={colorFor === tag}
                onClick={() => setColorFor(colorFor === tag ? null : tag)}
              >
                {tag}
              </button>
              <button
                type="button"
                className="project-tag-remove"
                aria-label={t('projects.tagsRemove', { tag })}
                onClick={() => {
                  onChange(tag, 'remove');
                  setColorFor(null);
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))
        ) : (
          <span className="project-tags-empty">{t('projects.tagsWithout')}</span>
        )}
      </div>
      {colorFor && tags.includes(colorFor) && (
        <fieldset className="project-tag-palette" aria-label={t('projects.tagsColorFor', { tag: colorFor })}>
          <div className="project-tag-picker-anchor">
            <button
              type="button"
              className={`project-tag-swatch ${projectTagAppearance(colors, colorFor).className}`}
              style={projectTagAppearance(colors, colorFor).style}
              aria-label={t('projects.tagsColorFor', { tag: colorFor })}
              title={t('projects.tagsColorFor', { tag: colorFor })}
              onClick={(event) => {
                const input = colorInput.current;
                if (!input) return;
                // Use the selected HEX directly; resolve the displayed app accent only for the default.
                const color = colorForTag(colors, colorFor);
                const probe = color ? null : document.createElement('canvas').getContext('2d');
                if (color) input.value = color;
                else if (probe) {
                  probe.fillStyle = getComputedStyle(event.currentTarget).color;
                  if (/^#[0-9a-f]{6}$/i.test(probe.fillStyle)) input.value = probe.fillStyle;
                }
                input.click();
              }}
            >
              <Palette size={18} aria-hidden="true" />
            </button>
            <input
              ref={colorInput}
              type="color"
              className="project-tag-native-picker"
              tabIndex={-1}
              aria-hidden="true"
              key={colorFor}
              defaultValue={colorForTag(colors, colorFor)}
              aria-label={t('projects.tagsColorFor', { tag: colorFor })}
              onChange={(event) => onColorChange(colorFor, event.currentTarget.value as ProjectTagColor)}
            />
          </div>
          <button
            type="button"
            className="project-tag-color-reset"
            aria-label={t('projects.tagsColorDefault')}
            aria-pressed={!colorForTag(colors, colorFor)}
            onClick={() => onColorChange(colorFor, null)}
          >
            <RotateCcw size={16} aria-hidden="true" />
          </button>
        </fieldset>
      )}
      <form
        className="project-tag-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (onChange(value, 'add')) {
            setValue('');
            inputRef.current?.focus();
          }
        }}
      >
        <SuggestInput
          value={value}
          onValueChange={setValue}
          suggestions={suggestions}
          ariaLabel={t('projects.tagsName')}
          placeholder={t('projects.tagsPlaceholder')}
          maxLength={MAX_PROJECT_TAG_LENGTH * 2}
          autoFocus
          inputRef={inputRef}
        />
        <button type="submit" className="primary-button" disabled={!value.trim()}>
          <Plus size={14} />
          {t('projects.tagsAdd')}
        </button>
        <button type="button" className="secondary-button" onClick={onClose}>
          {t('projects.tagsDone')}
        </button>
      </form>
      <p className="project-tags-hint">{t('projects.tagsHint')}</p>
    </section>
  );
}
