import { ChevronDown, Plus, Tags, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { MAX_PROJECT_TAG_LENGTH, type TagMatch } from '../../projectTags';
import { useDismiss } from '../shared';

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
  selected,
  match,
  onSelect,
  onMatch,
}: {
  available: string[];
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
              <span>{tag ?? t('projects.tagsWithout')}</span>
            </label>
          ))}
          <label className="project-tags-match">
            {t('projects.tagsMatch')}
            <select value={match} onChange={(event) => onMatch(event.target.value as TagMatch)}>
              <option value="any">{t('projects.tagsAny')}</option>
              <option value="all">{t('projects.tagsAll')}</option>
            </select>
          </label>
        </fieldset>
      )}
    </div>
  );
}

export function ProjectTagEditor({
  domain,
  tags,
  available,
  onChange,
  onClose,
}: {
  domain: string;
  tags: string[];
  available: string[];
  onChange: (tag: string, action: 'add' | 'remove') => boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);
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
            <button
              type="button"
              className="project-tag-chip"
              key={tag}
              aria-label={t('projects.tagsRemove', { tag })}
              onClick={() => onChange(tag, 'remove')}
            >
              {tag}
              <X size={12} />
            </button>
          ))
        ) : (
          <span className="project-tags-empty">{t('projects.tagsWithout')}</span>
        )}
      </div>
      <form
        className="project-tag-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (onChange(value, 'add')) {
            setValue('');
            ref.current?.focus();
          }
        }}
      >
        <input
          ref={ref}
          className="project-tag-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          list={id}
          maxLength={MAX_PROJECT_TAG_LENGTH * 2}
          aria-label={t('projects.tagsName')}
          placeholder={t('projects.tagsPlaceholder')}
        />
        <datalist id={id}>
          {available.map((tag) => (
            <option value={tag} key={tag} />
          ))}
        </datalist>
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
