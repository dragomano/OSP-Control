import { ChevronDown, Palette, Plus, RotateCcw, Tags, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import {
  colorForTag,
  MAX_PROJECT_TAGS,
  type ProjectTagColor,
  type ProjectTagColorEdits,
  type ProjectTagColors,
  projectTagAppearance,
  setProjectTagColor,
  type TagMatch,
} from '../../projectTags';
import { useDismiss } from '../shared';
import { Actions, Badge, BadgeButton, Button, cx, Field, Input, SectionPanel } from '../ui';
import { MenuSelect } from './MenuSelect';
import { ProjectTagSelect } from './ProjectTagSelect';
import { RowMenu } from './RowMenu';

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
    <Field className="project-selection">
      <Input
        ref={ref}
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      {all && <span className="project-select-all-text">{label}</span>}
    </Field>
  );
}

export function ProjectTagList({
  domain,
  tags,
  colors,
  selected,
  editing,
  onEdit,
  onFilter,
}: {
  domain: string;
  tags: string[];
  colors: ProjectTagColors;
  selected: (string | null)[];
  editing: boolean;
  onEdit: () => void;
  onFilter: (tag: string) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [hiddenTags, setHiddenTags] = useState<string[]>([]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const add = addRef.current;
    const more = moreRef.current;
    if (!list || !add || !more) return;
    const chips = [...list.querySelectorAll<HTMLElement>(':scope > .project-tag-chip')];
    const width = (element: HTMLElement) => Number.parseFloat(getComputedStyle(element).width);
    const measure = () => {
      const available = width(list);
      if (!available) return;
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const budget = available - width(add);
      const widths = chips.map((chip) => width(chip) + gap);
      const hidden: string[] = [];
      if (widths.reduce((sum, chipWidth) => sum + chipWidth, 0) > budget) {
        let remaining = budget - width(more) - gap;
        for (const [index, chipWidth] of widths.entries()) {
          if (chipWidth <= remaining) remaining -= chipWidth;
          else hidden.push(tags[index]);
        }
      }
      setHiddenTags((current) =>
        current.length === hidden.length && current.every((tag, index) => tag === hidden[index])
          ? current
          : hidden,
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    // Font changes can resize individual chips without changing the column width.
    for (const element of [list, add, more, ...chips]) observer.observe(element);
    return () => observer.disconnect();
  }, [tags]);

  const overflow = tags.filter((tag) => hiddenTags.includes(tag));
  const chipAppearance = (tag: string) => {
    const { className, style } = projectTagAppearance(colors, tag);
    return { className: cx('project-tag-chip', className, selected.includes(tag) && 'active'), style };
  };
  return (
    <div className="project-tags-cell">
      <div className="project-tags-list" ref={listRef}>
        {tags.map((tag) => {
          const hidden = hiddenTags.includes(tag);
          return (
            <BadgeButton
              key={tag}
              type="button"
              {...chipAppearance(tag)}
              aria-hidden={hidden || undefined}
              tabIndex={hidden ? -1 : undefined}
              aria-label={t('projects.tagsFilterBy', { tag })}
              onClick={() => onFilter(tag)}
            >
              {tag}
            </BadgeButton>
          );
        })}
        {overflow.length > 0 && (
          <RowMenu
            entries={overflow.map((tag) => ({
              label: tag,
              labelContent: <Badge {...chipAppearance(tag)}>{tag}</Badge>,
              onSelect: () => onFilter(tag),
            }))}
            trigger={({ onToggle, open }) => (
              <Button
                type="button"
                variant="ghost"
                className="project-tag-more"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('projects.tagsMore', { domain, count: overflow.length })}
                onClick={onToggle}
              >
                +{overflow.length}
              </Button>
            )}
          />
        )}
        <Button
          ref={addRef}
          variant="ghost"
          type="button"
          className="project-tag-add"
          aria-label={t('projects.tagsEditFor', { domain })}
          aria-expanded={editing}
          onClick={onEdit}
        >
          <Plus size={12} />
          {t('projects.tagsTag')}
        </Button>
        {tags.length > 0 && (
          <Button
            ref={moreRef}
            type="button"
            variant="ghost"
            className="project-tag-more"
            aria-hidden="true"
            tabIndex={-1}
          >
            +{MAX_PROJECT_TAGS}
          </Button>
        )}
      </div>
    </div>
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
      <Button
        selected={Boolean(selected.length)}
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
        <ChevronDown size={14} className="ui-choice-indicator" />
      </Button>
      {open && (
        <fieldset className="project-tags-filter-popup" id={id} aria-label={t('projects.tagsFilter')}>
          {[...options, null].map((tag) => (
            <Field className="project-tags-filter-option" key={tag ?? '\u0000'}>
              <Input
                type="checkbox"
                checked={selected.includes(tag)}
                onChange={(event) =>
                  onSelect(
                    event.target.checked ? [...selected, tag] : selected.filter((item) => item !== tag),
                  )
                }
              />
              <Badge
                className={
                  tag ? `project-tag-chip ${projectTagAppearance(colors, tag).className}` : undefined
                }
                style={tag ? projectTagAppearance(colors, tag).style : undefined}
              >
                {tag ?? t('projects.tagsWithout')}
              </Badge>
            </Field>
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
  onSave,
  onClose,
}: {
  domain: string;
  tags: string[];
  available: string[];
  colors: ProjectTagColors;
  onSave: (tags: string[], colorEdits: ProjectTagColorEdits) => boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [draftTags, setDraftTags] = useState(() => [...tags]);
  const [colorEdits, setColorEdits] = useState<ProjectTagColorEdits>({});
  const draftColors = Object.entries(colorEdits).reduce(
    (current, [tag, color]) => setProjectTagColor(current, tag, color),
    colors,
  );
  const changeColor = (tag: string, color: ProjectTagColor | null) =>
    setColorEdits((current) => ({ ...current, [tag]: color }));
  const [colorFor, setColorFor] = useState<string | null>(null);
  const colorInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Escape closes the select's menu first: the capture listener sees the input still expanded.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target instanceof Element ? event.target : null;
      const combobox = target?.closest('.project-tag-select')?.querySelector('[role="combobox"]');
      if (combobox?.getAttribute('aria-expanded') === 'true') return;
      onClose();
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [onClose]);

  return (
    <SectionPanel className="project-tag-editor" aria-label={t('projects.tagsEditFor', { domain })}>
      <div className="project-tag-editor-head">
        <b className="project-tag-editor-title">{t('projects.tagsEditFor', { domain })}</b>
        <Actions className="project-tag-editor-actions">
          <Button
            variant="primary"
            type="button"
            className="primary-button"
            onClick={() => {
              if (onSave(draftTags, colorEdits)) onClose();
            }}
          >
            {t('projects.tagsDone')}
          </Button>
          <Button
            variant="ghost"
            square
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('common.cancel')}
          >
            <X size={16} />
          </Button>
        </Actions>
      </div>
      <ProjectTagSelect
        value={draftTags}
        available={available}
        colors={draftColors}
        ariaLabel={t('projects.tagsName')}
        autoFocus
        inlineMenu
        onChange={(next) => {
          setDraftTags(next);
          return true;
        }}
        onColorSelect={(tag) => setColorFor(colorFor === tag ? null : tag)}
      />
      {colorFor && draftTags.includes(colorFor) && (
        <fieldset className="project-tag-palette" aria-label={t('projects.tagsColorFor', { tag: colorFor })}>
          <legend>{t('projects.tagsColorFor', { tag: colorFor })}</legend>
          <div className="project-tag-picker-anchor">
            <Button
              variant="ghost"
              type="button"
              className={`project-tag-swatch ${projectTagAppearance(draftColors, colorFor).className}`}
              style={projectTagAppearance(draftColors, colorFor).style}
              aria-label={t('projects.tagsColorFor', { tag: colorFor })}
              title={t('projects.tagsColorFor', { tag: colorFor })}
              onClick={(event) => {
                const input = colorInput.current;
                if (!input) return;
                // Use the selected HEX directly; resolve the displayed app accent only for the default.
                const color = colorForTag(draftColors, colorFor);
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
            </Button>
            <Input
              ref={colorInput}
              type="color"
              className="project-tag-native-picker"
              tabIndex={-1}
              aria-hidden="true"
              key={colorFor}
              defaultValue={colorForTag(draftColors, colorFor)}
              aria-label={t('projects.tagsColorFor', { tag: colorFor })}
              onChange={(event) => changeColor(colorFor, event.currentTarget.value as ProjectTagColor)}
            />
          </div>
          <Button
            variant="ghost"
            type="button"
            className="project-tag-color-reset"
            aria-label={t('projects.tagsColorDefault')}
            aria-pressed={!colorForTag(draftColors, colorFor)}
            onClick={() => changeColor(colorFor, null)}
          >
            <RotateCcw size={16} aria-hidden="true" />
          </Button>
        </fieldset>
      )}
      <p className="project-tags-hint">{t('projects.tagsHint')}</p>
    </SectionPanel>
  );
}
